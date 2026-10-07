/**
 * YAYA-TOOLS1-R4 验收：manage_teacher 目标账号资格守门先于业务锁。
 *
 * 分层（输出 JSON 中逐项标注）：
 * - real route handler：真实 `/api/yaya/proposals`、`/api/yaya/proposals/{id}/approval`、
 *   `/api/yaya/operations` POST handler（进程内 NextRequest，不含 Next server）；
 * - real executor：真实 `createYayaToolkit().executeOperations` + 真实 AUTH 会话/CSRF + 隔离 PG；
 * - model double：`invoke` 注入的进程内替身（真实 provider 出口 0）；R4 用例期望零模型调用；
 * - provider guard：LLM_* 指向自有回环守门，证明全程真实 provider 出口 0。
 *
 * 用例分组（`TOOLS1_R4_CASE=g|all`）：
 * G 目标资格：set_status / assign_class / remove_assignment 指向管理员（自己/其他管理员）或
 *   不存在账号时，必须在共享绑定边界（取业务锁之前）按既有 AUTH 语义拒绝
 *   （forbidden_role / not_found）；公开准备路径与旧库执行路径都覆盖；持锁竞争不得延迟拒绝；
 *   双请求并发无 40P01；正常教师 set_status 与既有单班任教对照保留。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-tools-write-r4-db.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { buildPrincipal } from '../../src/lib/accounts/repository';
import { computeCsrfToken, createSessionToken } from '../../src/lib/accounts/session';
import type { invokeLlm } from '../../src/lib/llm';
import { POST as operationsPost } from '../../src/app/api/yaya/operations/route';
import { POST as proposalsPost } from '../../src/app/api/yaya/proposals/route';
import { POST as approvalPost } from '../../src/app/api/yaya/proposals/[id]/approval/route';
import { withPrivateWrite, yayaDataRepository } from '../../src/lib/yaya/data';
import type { YayaPrepareItemInput } from '../../src/lib/yaya/storage-types';
import type { YayaDomainPayload } from '../../src/lib/yaya/types';
import { createYayaToolkit } from '../../src/lib/yaya/tools/write';
import { modelGuardEnv, startModelRequestGuard } from '../harness-safety';
import { createAcceptanceSeed, type AcceptanceSeedHandle } from './acceptance/seed';

const REQUESTED_CASE = (process.env.TOOLS1_R4_CASE ?? 'all').toLowerCase();

let passed = 0;
const failures: string[] = [];
function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
  }
}

interface SessionHandle {
  token: string;
  csrf: string;
}

interface PublicPlan {
  proposal_id: string;
  operation_ids: string[];
  approval_id: string | null;
  prepare_status: number;
  prepare_error: string | null;
  approval_status: number;
  approval_error: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runChecks(): Promise<void> {
  assert.equal(globalThis.__pgPool, undefined, 'r4 check must run in a fresh process');
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  process.env.AUTH_TRUSTED_ORIGINS = 'http://127.0.0.1:3200';

  let seed: AcceptanceSeedHandle | null = null;
  let db: Client | null = null;
  let racer: Client | null = null;
  let racerInTransaction = false;
  let pending: Promise<unknown> | null = null;
  const cleanupIssues: string[] = [];
  let fatal: unknown = null;
  let modelCalls = 0;

  try {
    seed = await createAcceptanceSeed();
    const manifest = seed.manifest;
    db = new Client({ connectionString: seed.database_url });
    racer = new Client({ connectionString: seed.database_url });
    await db.connect();
    await racer.connect();
    const database = db;
    const racerClient = racer;
    const seedTag = manifest.seed_id;

    const sessionFor = async (accountId: string): Promise<SessionHandle> => {
      const token = createSessionToken();
      await database.query(
        "INSERT INTO app_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [accountId, token.tokenHash],
      );
      return { token: token.token, csrf: computeCsrfToken(token.token) };
    };
    const carrier = (session: SessionHandle, requestId = 'tools1-r4'): { headers: Headers } => ({
      headers: new Headers({
        cookie: `cga_session=${session.token}`,
        origin: 'http://127.0.0.1:3200',
        'x-csrf-token': session.csrf,
        'x-request-id': requestId,
      }),
    });
    const nextRequest = (session: SessionHandle, path: string, body: unknown): NextRequest => {
      const headers = new Headers(carrier(session).headers);
      headers.set('content-type', 'application/json');
      return new NextRequest(`http://127.0.0.1:3200${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    };

    const admin = manifest.accounts.admin;
    const teacherC = manifest.accounts.teacher_c;
    const sessionAdmin = await sessionFor(admin.account_id);
    const classA = manifest.classes.class_a;

    // 第二管理员：覆盖“其他管理员目标”（种子只有一名管理员）
    const otherAdminId = randomUUID();
    await database.query(
      `INSERT INTO app_accounts (id, username, display_name, password_hash, role, status)
       VALUES ($1, $2, 'R4 第二管理员', 'scrypt$r4-unused', 'admin', 'active')`,
      [otherAdminId, `r4_other_admin_${seedTag}`],
    );
    const missingAccountId = randomUUID();

    const principalAdmin = buildPrincipal(
      {
        id: admin.account_id,
        username: admin.username,
        display_name: admin.display_name,
        role: 'admin',
        status: 'active',
        class_ids: [],
      },
      manifest.school_id,
    );

    const adminConversation = await withPrivateWrite(carrier(sessionAdmin), ({ client, principal }) =>
      yayaDataRepository.createConversation(client, { owner_account_id: principal.account_id, title: null }),
    );
    const adminConversationId = adminConversation.conversation_id;

    const invoke: typeof invokeLlm = async () => {
      modelCalls += 1;
      throw new Error('R4 cases must not reach the model substitute');
    };
    const runtimeAdmin = createYayaToolkit({
      request: carrier(sessionAdmin),
      resolveConversationId: async () => adminConversationId,
      verifyRun: async () => undefined,
      invoke,
    });

    const errorOf = (error: unknown): { code: string; reasons: string[] } => {
      const record = error as { code?: string; details?: { reasons?: string[] } };
      return {
        code: String(record.code ?? error),
        reasons: Array.isArray(record.details?.reasons) ? record.details.reasons : [],
      };
    };

    const publicPlan = async (item: Record<string, unknown>): Promise<PublicPlan> => {
      const prepared = await proposalsPost(
        nextRequest(sessionAdmin, '/api/yaya/proposals', {
          conversation_id: adminConversationId,
          proposal_origin: 'teacher_card',
          auth: { kind: 'action', action: 'teacher.manage', resource: 'school' },
          items: [item],
        }),
      );
      const preparedBody = (await prepared.json()) as {
        proposal?: { proposal_id: string; items: { operation_id: string }[] };
        error?: string;
      };
      if (prepared.status !== 201 || !preparedBody.proposal) {
        return {
          proposal_id: '',
          operation_ids: [],
          approval_id: null,
          prepare_status: prepared.status,
          prepare_error: preparedBody.error ?? null,
          approval_status: 0,
          approval_error: null,
        };
      }
      const operationIds = preparedBody.proposal.items.map((entry) => entry.operation_id);
      const approved = await approvalPost(
        nextRequest(sessionAdmin, `/api/yaya/proposals/${preparedBody.proposal.proposal_id}/approval`, {
          action: 'approve',
          operation_ids: operationIds,
        }),
        { params: Promise.resolve({ id: preparedBody.proposal.proposal_id }) },
      );
      const approvedBody = (await approved.json()) as { approval?: { approval_id: string }; error?: string };
      return {
        proposal_id: preparedBody.proposal.proposal_id,
        operation_ids: operationIds,
        approval_id: approvedBody.approval?.approval_id ?? null,
        prepare_status: prepared.status,
        prepare_error: null,
        approval_status: approved.status,
        approval_error: approvedBody.error ?? null,
      };
    };

    const publicClassPlan = async (item: Record<string, unknown>): Promise<PublicPlan> => {
      const prepared = await proposalsPost(
        nextRequest(sessionAdmin, '/api/yaya/proposals', {
          conversation_id: adminConversationId,
          proposal_origin: 'teacher_card',
          auth: { kind: 'action', action: 'teacher.assign', resource: 'class' },
          items: [item],
        }),
      );
      const preparedBody = (await prepared.json()) as {
        proposal?: { proposal_id: string; items: { operation_id: string }[] };
        error?: string;
      };
      if (prepared.status !== 201 || !preparedBody.proposal) {
        return {
          proposal_id: '',
          operation_ids: [],
          approval_id: null,
          prepare_status: prepared.status,
          prepare_error: preparedBody.error ?? null,
          approval_status: 0,
          approval_error: null,
        };
      }
      const operationIds = preparedBody.proposal.items.map((entry) => entry.operation_id);
      const approved = await approvalPost(
        nextRequest(sessionAdmin, `/api/yaya/proposals/${preparedBody.proposal.proposal_id}/approval`, {
          action: 'approve',
          operation_ids: operationIds,
        }),
        { params: Promise.resolve({ id: preparedBody.proposal.proposal_id }) },
      );
      const approvedBody = (await approved.json()) as { approval?: { approval_id: string }; error?: string };
      return {
        proposal_id: preparedBody.proposal.proposal_id,
        operation_ids: operationIds,
        approval_id: approvedBody.approval?.approval_id ?? null,
        prepare_status: prepared.status,
        prepare_error: null,
        approval_status: approved.status,
        approval_error: approvedBody.error ?? null,
      };
    };

    const executeViaRoute = async (
      session: SessionHandle,
      plan: PublicPlan,
    ): Promise<{ status: number; error: string | null; reasons: string[]; receiptStatus: string | null }> => {
      if (plan.approval_id === null) {
        return { status: 0, error: 'no_approval', reasons: [], receiptStatus: null };
      }
      const response = await operationsPost(
        nextRequest(session, '/api/yaya/operations', {
          approval_id: plan.approval_id,
          operation_ids: plan.operation_ids,
        }),
      );
      const body = (await response.json()) as {
        receipts?: { status?: string }[];
        error?: string;
        details?: { reasons?: string[] };
      };
      return {
        status: response.status,
        error: body.error ?? null,
        reasons: Array.isArray(body.details?.reasons) ? body.details.reasons : [],
        receiptStatus: body.receipts?.[0]?.status ?? null,
      };
    };

    const executeViaExecutor = async (
      session: SessionHandle,
      plan: PublicPlan,
    ): Promise<{ ok: true; kind: string; receipt: string | null } | { ok: false; code: string; reasons: string[] }> => {
      if (plan.approval_id === null) return { ok: false, code: 'no_approval', reasons: [] };
      return runtimeAdmin
        .executeOperations(carrier(session), {
          approval_id: plan.approval_id,
          operation_ids: plan.operation_ids,
        })
        .then(
          (value) => ({
            ok: true as const,
            kind: value.kind,
            receipt: value.kind === 'receipts' ? (value.receipts[0]?.status ?? null) : null,
          }),
          (error: unknown) => {
            const mapped = errorOf(error);
            return { ok: false as const, code: mapped.code, reasons: mapped.reasons };
          },
        );
    };

    const prepareAndApprove = async (tool: string, params: unknown): Promise<PublicPlan> => {
      const runId = randomUUID();
      const proposed = await runtimeAdmin.toolkit.proposeWrite({
        run_id: runId,
        tool,
        params,
        identity: { run_id: runId, identity_state: 'authenticated', principal: principalAdmin, session_valid: true },
        proposal_origin: 'model_suggestion',
      });
      assert.ok(proposed.ok, proposed.ok ? '' : `propose ${tool}: ${proposed.code}`);
      const proposal = proposed.proposals[0]!;
      const rows = await database.query<{ operation_id: string }>(
        'SELECT operation_id FROM yaya_proposal_items WHERE proposal_id = $1',
        [proposal.proposal_id],
      );
      const operationIds = rows.rows.map((row) => row.operation_id);
      const approval = await withPrivateWrite(
        carrier(sessionAdmin),
        ({ client, principal: freshPrincipal, sessionId, schoolId }) =>
          yayaDataRepository.recordApproval(client, {
            proposal_id: proposal.proposal_id,
            operation_ids: operationIds,
            principal: freshPrincipal,
            session_id: sessionId,
            school_id: schoolId,
            execution_at: new Date().toISOString(),
          }),
      );
      return {
        proposal_id: proposal.proposal_id,
        operation_ids: operationIds,
        approval_id: approval.approval.approval_id,
        prepare_status: 201,
        prepare_error: null,
        approval_status: 201,
        approval_error: null,
      };
    };

    const approvalConsumed = async (approvalId: string | null): Promise<boolean> => {
      if (approvalId === null) return false;
      const row = await database.query<{ consumed_at: Date | null }>(
        'SELECT consumed_at FROM yaya_approvals WHERE id = $1',
        [approvalId],
      );
      return row.rows[0]?.consumed_at !== null && row.rows[0]?.consumed_at !== undefined;
    };
    const receiptRowsFor = async (operationIds: readonly string[]): Promise<number> => {
      if (operationIds.length === 0) return 0;
      const row = await database.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM yaya_operations WHERE operation_id = ANY($1::varchar[]) AND status IS NOT NULL',
        [[...operationIds]],
      );
      return Number(row.rows[0]?.n ?? 0);
    };
    const accountStatusOf = async (accountId: string): Promise<string | null> => {
      const row = await database.query<{ status: string }>(
        'SELECT status FROM app_accounts WHERE id = $1',
        [accountId],
      );
      return row.rows[0]?.status ?? null;
    };

    const setStatusPayload = (teacherAccountId: string): YayaDomainPayload => ({
      kind: 'manage_teacher',
      operation: 'set_status',
      teacher_account_id: teacherAccountId,
      username: null,
      display_name: null,
      class_ids: [],
      status: 'disabled',
      secret_via_secure_control: true,
    });
    const assignPayload = (teacherAccountId: string, operation: 'assign_class' | 'remove_assignment'): YayaDomainPayload => ({
      kind: 'manage_teacher',
      operation,
      teacher_account_id: teacherAccountId,
      username: null,
      display_name: null,
      class_ids: [classA.id],
      status: null,
      secret_via_secure_control: true,
    });

    const schoolItem = (payload: YayaDomainPayload): Record<string, unknown> => ({
      item_key: `r4-${randomUUID().slice(0, 8)}`,
      target_id: manifest.school_id,
      action: 'teacher.manage',
      resource: 'school',
      resource_ref: { kind: 'school' },
      payload: payload as unknown as Record<string, unknown>,
      attachment_associations: [],
      business_revision: null,
    });
    const classItem = (payload: YayaDomainPayload): Record<string, unknown> => ({
      item_key: `r4-${randomUUID().slice(0, 8)}`,
      target_id: classA.id,
      action: 'teacher.assign',
      resource: 'class',
      resource_ref: { kind: 'class', class_id: classA.id },
      payload: payload as unknown as Record<string, unknown>,
      attachment_associations: [],
      business_revision: null,
    });

    /* ================================ G ================================ */
    const runG = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'g') return;

      // G1a 管理员目标（自己）：公开准备/批准 201，执行必须按既有 AUTH 语义拒绝
      const planSelf = await publicPlan(schoolItem(setStatusPayload(admin.account_id)));
      check(planSelf.prepare_status === 201 && planSelf.approval_status === 201, 'G1a admin-self plan is prepared and approved (shape/claim pass, target must fail)');
      const selfResult = await executeViaExecutor(sessionAdmin, planSelf);
      check(!selfResult.ok && selfResult.code === 'forbidden_role', `G1a admin-self target is rejected with forbidden_role (got ${selfResult.ok ? 'ok' : selfResult.code})`);
      check((await accountStatusOf(admin.account_id)) === 'active', 'G1a admin account stays active');
      check((await receiptRowsFor(planSelf.operation_ids)) === 0, 'G1a zero operation receipts');
      check(!(await approvalConsumed(planSelf.approval_id)), 'G1a approval is not consumed');

      // G1b 不存在目标
      const planMissing = await publicPlan(schoolItem(setStatusPayload(missingAccountId)));
      check(planMissing.prepare_status === 201 && planMissing.approval_status === 201, 'G1b missing-target plan is prepared and approved');
      const missingResult = await executeViaExecutor(sessionAdmin, planMissing);
      check(!missingResult.ok && missingResult.code === 'not_found', `G1b missing target is rejected with not_found (got ${missingResult.ok ? 'ok' : missingResult.code})`);
      check((await receiptRowsFor(planMissing.operation_ids)) === 0, 'G1b zero operation receipts');
      check(!(await approvalConsumed(planMissing.approval_id)), 'G1b approval is not consumed');

      // G1c/G1d 其他管理员目标：assign / remove
      const planAssign = await publicClassPlan(classItem(assignPayload(otherAdminId, 'assign_class')));
      check(planAssign.prepare_status === 201 && planAssign.approval_status === 201, 'G1c other-admin assign plan is prepared and approved');
      const assignResult = await executeViaExecutor(sessionAdmin, planAssign);
      check(!assignResult.ok && assignResult.code === 'forbidden_role', `G1c other-admin assign target is rejected with forbidden_role (got ${assignResult.ok ? 'ok' : assignResult.code})`);
      check((await receiptRowsFor(planAssign.operation_ids)) === 0, 'G1c zero operation receipts');
      check(!(await approvalConsumed(planAssign.approval_id)), 'G1c approval is not consumed');
      const planRemove = await publicClassPlan(classItem(assignPayload(otherAdminId, 'remove_assignment')));
      check(planRemove.prepare_status === 201 && planRemove.approval_status === 201, 'G1d other-admin remove plan is prepared and approved');
      const removeResult = await executeViaExecutor(sessionAdmin, planRemove);
      check(!removeResult.ok && removeResult.code === 'forbidden_role', `G1d other-admin remove target is rejected with forbidden_role (got ${removeResult.ok ? 'ok' : removeResult.code})`);
      check(!(await approvalConsumed(planRemove.approval_id)), 'G1d approval is not consumed');

      // G2 旧库执行路径（绕过公开准备直接落库）：route handler 同样拒绝
      const legacyProposal = await withPrivateWrite(carrier(sessionAdmin), ({ client, principal }) =>
        yayaDataRepository.prepareProposal(client, {
          conversation_id: adminConversationId,
          proposal_origin: 'model_suggestion',
          auth: { kind: 'action', action: 'teacher.manage', resource: 'school' },
          owner_account_id: principal.account_id,
          items: [schoolItem(setStatusPayload(otherAdminId)) as unknown as YayaPrepareItemInput],
        }),
      );
      const legacyOperationIds = legacyProposal.items.map((item) => item.operation_id);
      const legacyApproval = await withPrivateWrite(
        carrier(sessionAdmin),
        ({ client, principal, sessionId, schoolId }) =>
          yayaDataRepository.recordApproval(client, {
            proposal_id: legacyProposal.proposal_id,
            operation_ids: legacyOperationIds,
            principal,
            session_id: sessionId,
            school_id: schoolId,
            execution_at: new Date().toISOString(),
          }),
      );
      const legacyPlan: PublicPlan = {
        proposal_id: legacyProposal.proposal_id,
        operation_ids: [...legacyOperationIds],
        approval_id: legacyApproval.approval.approval_id,
        prepare_status: 201,
        prepare_error: null,
        approval_status: 201,
        approval_error: null,
      };
      const legacyResult = await executeViaRoute(sessionAdmin, legacyPlan);
      check(legacyResult.status === 403 && legacyResult.error === 'forbidden_role', `G2 legacy admin-target plan is rejected with 403 forbidden_role (got ${legacyResult.status}/${legacyResult.error})`);
      check((await accountStatusOf(otherAdminId)) === 'active', 'G2 other admin account stays active');
      check((await receiptRowsFor(legacyOperationIds)) === 0, 'G2 zero operation receipts');
      check(!(await approvalConsumed(legacyPlan.approval_id)), 'G2 approval is not consumed');

      // G3a 持锁竞争者：资格拒绝不得排队等待目标业务锁
      const planLocked = await publicPlan(schoolItem(setStatusPayload(otherAdminId)));
      check(planLocked.prepare_status === 201 && planLocked.approval_status === 201, 'G3a held-lock admin-target plan is prepared and approved');
      const waitBudgetMs = 4000;
      await racerClient.query('BEGIN');
      racerInTransaction = true;
      await racerClient.query('SELECT id FROM app_accounts WHERE id = $1 FOR UPDATE', [otherAdminId]);
      const startedAt = Date.now();
      const pendingExec = runtimeAdmin
        .executeOperations(carrier(sessionAdmin), {
          approval_id: planLocked.approval_id ?? '',
          operation_ids: planLocked.operation_ids,
        })
        .then(
          (value) => ({ ok: true as const, kind: value.kind }),
          (error: unknown) => {
            const mapped = errorOf(error);
            return { ok: false as const, code: mapped.code, reasons: mapped.reasons };
          },
        );
      pending = pendingExec;
      const raced = await Promise.race([pendingExec, sleep(waitBudgetMs).then(() => 'timeout' as const)]);
      const elapsedMs = Date.now() - startedAt;
      check(
        raced !== 'timeout' && raced.ok === false && raced.code === 'forbidden_role',
        `G3a admin target is rejected with forbidden_role without acquiring the target lock (got ${raced === 'timeout' ? 'timeout' : raced.ok ? 'ok' : raced.code})`,
      );
      check(
        raced !== 'timeout' && elapsedMs < waitBudgetMs,
        `G3a rejection does not queue behind the held target lock (elapsed=${elapsedMs}ms)`,
      );
      await racerClient.query('ROLLBACK');
      racerInTransaction = false;
      const settled = await Promise.race([pendingExec, sleep(5000).then(() => 'timeout' as const)]);
      pending = null;
      check(settled !== 'timeout', 'G3a execution settles after the competing lock is released');
      check((await receiptRowsFor(planLocked.operation_ids)) === 0, 'G3a zero operation receipts');
      check(!(await approvalConsumed(planLocked.approval_id)), 'G3a approval is not consumed');

      // G3b 双请求并发（管理员目标自己）：两个明确拒绝、无 40P01
      const planConcurrentA = await publicPlan(schoolItem(setStatusPayload(admin.account_id)));
      const planConcurrentB = await publicPlan(schoolItem(setStatusPayload(admin.account_id)));
      const [conA, conB] = await Promise.all([
        executeViaExecutor(sessionAdmin, planConcurrentA),
        executeViaExecutor(sessionAdmin, planConcurrentB),
      ]);
      check(!conA.ok && conA.code === 'forbidden_role', `G3b first concurrent admin-target request is forbidden_role (got ${conA.ok ? 'ok' : conA.code})`);
      check(!conB.ok && conB.code === 'forbidden_role', `G3b second concurrent admin-target request is forbidden_role (got ${conB.ok ? 'ok' : conB.code})`);
      check((conA.ok ? '' : conA.code) !== '40P01' && (conB.ok ? '' : conB.code) !== '40P01', 'G3b concurrent requests produce no PostgreSQL deadlock (40P01)');
      check((await accountStatusOf(admin.account_id)) === 'active', 'G3b admin account stays active');
      check((await receiptRowsFor(planConcurrentA.operation_ids)) === 0, 'G3b zero receipts for the first request');
      check((await receiptRowsFor(planConcurrentB.operation_ids)) === 0, 'G3b zero receipts for the second request');

      // G4 正常教师管理对照：停用 → 启用
      const disablePlan = await prepareAndApprove('manage_teacher', {
        operation: 'set_status',
        teacher_account_id: teacherC.account_id,
        status: 'disabled',
      });
      const disabled = await executeViaExecutor(sessionAdmin, disablePlan);
      check(disabled.ok && disabled.receipt === 'saved', 'G4 normal teacher disable still saves');
      check((await accountStatusOf(teacherC.account_id)) === 'disabled', 'G4 teacher account is disabled');
      const enablePlan = await prepareAndApprove('manage_teacher', {
        operation: 'set_status',
        teacher_account_id: teacherC.account_id,
        status: 'active',
      });
      const enabled = await executeViaExecutor(sessionAdmin, enablePlan);
      check(enabled.ok && enabled.receipt === 'saved', 'G4 normal teacher enable still saves');
      check((await accountStatusOf(teacherC.account_id)) === 'active', 'G4 teacher account is active again');
    };

    await runG();

    check(guard.hits === 0, 'R4 check made zero real provider requests through the guard');
  } catch (error) {
    fatal = error;
  } finally {
    if (racerInTransaction && racer) {
      await racer.query('ROLLBACK').catch((error: unknown) => cleanupIssues.push(`racer-rollback: ${String(error)}`));
    }
    if (pending) {
      await (pending as Promise<unknown>).catch((error: unknown) => cleanupIssues.push(`pending: ${String(error)}`));
    }
    if (racer) {
      await racer.end().catch((error: unknown) => cleanupIssues.push(`racer: ${String(error)}`));
    }
    if (db) {
      await db.end().catch((error: unknown) => cleanupIssues.push(`db: ${String(error)}`));
    }
    if (seed) {
      await seed.teardown().catch((error: unknown) => cleanupIssues.push(`seed: ${String(error)}`));
    }
    await guard.close().catch((error: unknown) => cleanupIssues.push(`guard: ${String(error)}`));
  }

  if (fatal) {
    console.error(fatal);
  }
  const report = {
    ok: failures.length === 0 && fatal === null && cleanupIssues.length === 0,
    case: REQUESTED_CASE,
    passed,
    failed: failures.length,
    failures,
    fatal: fatal instanceof Error ? fatal.message : fatal ? String(fatal) : null,
    cleanup: cleanupIssues.length === 0 ? 'verified' : 'incomplete',
    cleanup_issues: cleanupIssues,
    layers: {
      route_handler: 'real proposals/approval/operations POST handlers in-process (no Next server)',
      executor: 'real createYayaToolkit().executeOperations + real AUTH sessions/CSRF + isolated PG',
      model: 'in-process invokeLlm substitute (real provider egress 0); R4 cases expect zero model calls',
      provider_guard: 'LLM_* pointed at owned loopback guard; hits counted',
    },
    real_model_requests: guard.hits,
    model_calls: modelCalls,
    not_run: ['Next HTTP server', 'real provider model quality', 'browser', 'hosted DB', 'deployment'],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

runChecks().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
