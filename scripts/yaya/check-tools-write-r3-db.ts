/**
 * YAYA-TOOLS1-R3 验收：多班 payload 收口、语义绑定先于业务锁、未注册 kind 原型属性。
 *
 * 分层（输出 JSON 中逐项标注）：
 * - real route handler：真实 `/api/yaya/proposals`、`/api/yaya/proposals/{id}/approval`、
 *   `/api/yaya/operations` POST handler（进程内 NextRequest，不含 Next server）；
 * - real executor：真实 `createYayaToolkit().executeOperations` + 真实 AUTH 会话/CSRF + 隔离 PG；
 * - model double：`invoke` 注入的进程内替身（真实 provider 出口 0）；
 * - provider guard：LLM_* 指向自有回环守门，证明全程真实 provider 出口 0。
 *
 * 用例分组（`TOOLS1_R3_CASE=k|m|l|all` 可单跑）：
 * K 未注册 kind：`__proto__`/`constructor`/`toString` 与普通未知 kind 在纯解析与公开
 *   handler 都必须是明确 invalid_request（400），不得命中 Object 原型或 500。
 * M 多班 payload：单操作 assign/remove 的持久化 payload 恰好一个班级；公开准备拒绝多班；
 *   旧库多班提案在执行入口（绑定边界）拒绝；正常单班 assign/remove 保持。
 * L 绑定先于锁：非法（声明与 payload 不一致）提案在被拒绝前不得进入业务目标锁流程；
 *   持锁竞争者不得延迟拒绝；双请求并发均为明确 400，无 40P01，零业务写。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-tools-write-r3-db.ts
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
import { YayaDataError } from '../../src/lib/yaya/storage-types';
import type { YayaDomainPayload } from '../../src/lib/yaya/types';
import { createYayaToolkit } from '../../src/lib/yaya/tools/write';
import { parseWritePayload } from '../../src/lib/yaya/tools/write/schemas';
import { modelGuardEnv, startModelRequestGuard } from '../harness-safety';
import { createAcceptanceSeed, type AcceptanceSeedHandle } from './acceptance/seed';

const REQUESTED_CASE = (process.env.TOOLS1_R3_CASE ?? 'all').toLowerCase();

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
  assert.equal(globalThis.__pgPool, undefined, 'r3 check must run in a fresh process');
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
    const carrier = (session: SessionHandle, requestId = 'tools1-r3'): { headers: Headers } => ({
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

    const accountA = manifest.accounts.teacher_a;
    const admin = manifest.accounts.admin;
    const targetTeacher = manifest.accounts.teacher_c.account_id;
    const sessionA = await sessionFor(accountA.account_id);
    const sessionAdmin = await sessionFor(admin.account_id);
    const classA = manifest.classes.class_a;
    const classB = manifest.classes.class_b;

    const classIdsOf = (keys: readonly string[]): string[] =>
      keys.map((key) => manifest.classes[key as 'class_a' | 'class_b' | 'class_c' | 'class_fault'].id);
    const principalA = buildPrincipal(
      {
        id: accountA.account_id,
        username: accountA.username,
        display_name: accountA.display_name,
        role: 'teacher',
        status: 'active',
        class_ids: classIdsOf(accountA.current_class_keys),
      },
      manifest.school_id,
    );
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
    const teacherConversationId = manifest.conversations.teacher_a_scenario.conversation_id;
    const adminConversationId = adminConversation.conversation_id;

    const invoke: typeof invokeLlm = async () => {
      modelCalls += 1;
      throw new Error('R3 cases must not reach the model substitute');
    };
    const toolkitFor = (session: SessionHandle, conversationId: string) =>
      createYayaToolkit({
        request: carrier(session),
        resolveConversationId: async () => conversationId,
        verifyRun: async () => undefined,
        invoke,
      });
    const runtimeA = toolkitFor(sessionA, teacherConversationId);
    const runtimeAdmin = toolkitFor(sessionAdmin, adminConversationId);

    const errorOf = (error: unknown): { code: string; reasons: string[] } => {
      const record = error as { code?: string; details?: { reasons?: string[] } };
      return {
        code: String(record.code ?? error),
        reasons: Array.isArray(record.details?.reasons) ? record.details.reasons : [],
      };
    };

    const publicPlan = async (
      session: SessionHandle,
      conversationId: string,
      auth: Record<string, string>,
      item: Record<string, unknown>,
    ): Promise<PublicPlan> => {
      const prepared = await proposalsPost(
        nextRequest(session, '/api/yaya/proposals', {
          conversation_id: conversationId,
          proposal_origin: 'teacher_card',
          auth,
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
        nextRequest(session, `/api/yaya/proposals/${preparedBody.proposal.proposal_id}/approval`, {
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
      runtime: ReturnType<typeof toolkitFor>,
      session: SessionHandle,
      plan: PublicPlan,
    ): Promise<{ ok: true; kind: string; receipt: string | null } | { ok: false; code: string; reasons: string[] }> => {
      if (plan.approval_id === null) return { ok: false, code: 'no_approval', reasons: [] };
      return runtime
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

    const prepareAndApprove = async (
      runtime: ReturnType<typeof toolkitFor>,
      session: SessionHandle,
      principal: typeof principalAdmin,
      tool: string,
      params: unknown,
    ): Promise<PublicPlan> => {
      const runId = randomUUID();
      const proposed = await runtime.toolkit.proposeWrite({
        run_id: runId,
        tool,
        params,
        identity: { run_id: runId, identity_state: 'authenticated', principal, session_valid: true },
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
        carrier(session),
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
    const activeAssignmentsOf = async (classId: string): Promise<number> => {
      const row = await database.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM teacher_class_assignments WHERE account_id = $1 AND class_id = $2 AND removed_at IS NULL',
        [targetTeacher, classId],
      );
      return Number(row.rows[0]?.n ?? 0);
    };

    const declaredItem = (overrides: Partial<{
      item_key: string;
      target_id: string;
      action: string;
      resource: string;
      resource_ref: Record<string, unknown>;
      payload: Record<string, unknown>;
      business_revision: string | null;
    }> = {}): Record<string, unknown> => ({
      item_key: overrides.item_key ?? `r3-${randomUUID().slice(0, 8)}`,
      target_id: overrides.target_id ?? classA.id,
      action: overrides.action ?? 'class.manage',
      resource: overrides.resource ?? 'class',
      resource_ref: overrides.resource_ref ?? { kind: 'class', class_id: classA.id },
      payload: overrides.payload ?? { kind: 'manage_class', operation: 'create', class_id: null, name: 'x', stage: 'small', school_year: classA.school_year, is_active: true },
      attachment_associations: [],
      ...(overrides.business_revision !== undefined ? { business_revision: overrides.business_revision } : {}),
    });

    /* ================================ K ================================ */
    const runK = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'k') return;

      const pureOutcome = (kind: string): { code: string | null; name: string } => {
        try {
          parseWritePayload({ kind });
          return { code: null, name: 'none' };
        } catch (error) {
          return {
            code: error instanceof YayaDataError ? error.code : null,
            name: error instanceof Error ? error.name : typeof error,
          };
        }
      };
      for (const kind of ['__proto__', 'constructor', 'toString', 'r3_unknown_kind']) {
        const outcome = pureOutcome(kind);
        check(
          outcome.code === 'invalid_request',
          `K parseWritePayload(${kind}) is invalid_request (got code=${outcome.code} name=${outcome.name})`,
        );
      }

      for (const kind of ['__proto__', 'constructor', 'toString', 'r3_unknown_kind']) {
        const plan = await publicPlan(
          sessionA,
          teacherConversationId,
          { kind: 'action', action: 'class.manage', resource: 'class' },
          declaredItem({ payload: { kind } }),
        );
        check(
          plan.prepare_status === 400 && plan.prepare_error === 'invalid_request',
          `K public prepare rejects inherited/unknown kind ${kind} with 400 invalid_request (got ${plan.prepare_status}/${plan.prepare_error})`,
        );
      }
    };

    /* ================================ M ================================ */
    const runM = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'm') return;

      const manageTeacherPayload = (
        operation: 'set_status' | 'assign_class' | 'remove_assignment',
        classIds: string[],
      ): Record<string, unknown> => ({
        kind: 'manage_teacher',
        operation,
        teacher_account_id: targetTeacher,
        username: null,
        display_name: null,
        class_ids: classIds,
        status: operation === 'set_status' ? 'disabled' : null,
        secret_via_secure_control: true,
      });

      // M1 公开准备拒绝多班 assign/remove payload
      const multiAssign = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'teacher.assign', resource: 'class' },
        declaredItem({
          action: 'teacher.assign',
          resource: 'class',
          resource_ref: { kind: 'class', class_id: classA.id },
          payload: manageTeacherPayload('assign_class', [classA.id, classB.id]),
        }),
      );
      check(
        multiAssign.prepare_status === 400 && multiAssign.prepare_error === 'invalid_request',
        `M1 public prepare rejects two-class assign payload (got ${multiAssign.prepare_status}/${multiAssign.prepare_error})`,
      );
      const multiRemove = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'teacher.assign', resource: 'class' },
        declaredItem({
          action: 'teacher.assign',
          resource: 'class',
          resource_ref: { kind: 'class', class_id: classA.id },
          payload: manageTeacherPayload('remove_assignment', [classA.id, classB.id]),
        }),
      );
      check(
        multiRemove.prepare_status === 400 && multiRemove.prepare_error === 'invalid_request',
        `M1 public prepare rejects two-class remove payload (got ${multiRemove.prepare_status}/${multiRemove.prepare_error})`,
      );
      const statusWithClasses = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'teacher.manage', resource: 'school' },
        declaredItem({
          target_id: manifest.school_id,
          action: 'teacher.manage',
          resource: 'school',
          resource_ref: { kind: 'school' },
          payload: manageTeacherPayload('set_status', [classA.id]),
        }),
      );
      check(
        statusWithClasses.prepare_status === 400 && statusWithClasses.prepare_error === 'invalid_request',
        `M1 public prepare rejects set_status with class ids (got ${statusWithClasses.prepare_status}/${statusWithClasses.prepare_error})`,
      );

      // M2 旧库多班提案（绕过公开准备、直接落库）：执行入口绑定边界必须拒绝
      const legacyProposal = await withPrivateWrite(carrier(sessionAdmin), ({ client, principal }) =>
        yayaDataRepository.prepareProposal(client, {
          conversation_id: adminConversationId,
          proposal_origin: 'model_suggestion',
          auth: { kind: 'action', action: 'teacher.assign', resource: 'class' },
          owner_account_id: principal.account_id,
          items: [
            {
              item_key: `r3-legacy-multi-${randomUUID().slice(0, 8)}`,
              target_id: classA.id,
              action: 'teacher.assign',
              resource: 'class',
              resource_ref: { kind: 'class', class_id: classA.id },
              payload: manageTeacherPayload('assign_class', [classA.id, classB.id]) as unknown as YayaDomainPayload,
              attachment_associations: [],
              business_revision: null,
            },
          ],
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
      check(legacyResult.status === 400 && legacyResult.error === 'invalid_request', `M2 legacy multi-class plan is rejected at execution entry with invalid_request (got ${legacyResult.status}/${legacyResult.error})`);
      check((await activeAssignmentsOf(classA.id)) === 0, 'M2 legacy multi-class plan assigns no class');
      check((await activeAssignmentsOf(classB.id)) === 0, 'M2 legacy multi-class plan assigns neither class');
      check((await receiptRowsFor(legacyOperationIds)) === 0, 'M2 legacy multi-class plan records zero receipts');
      check(!(await approvalConsumed(legacyPlan.approval_id)), 'M2 legacy multi-class approval is not consumed');

      // M3 正常单班 assign/remove 保持
      const singleAssign = await prepareAndApprove(runtimeAdmin, sessionAdmin, principalAdmin, 'manage_teacher', {
        operation: 'assign_class',
        teacher_account_id: targetTeacher,
        class_id: classB.id,
      });
      const assigned = await executeViaExecutor(runtimeAdmin, sessionAdmin, singleAssign);
      check(assigned.ok && assigned.receipt === 'saved', 'M3 single-class assign still saves');
      check((await activeAssignmentsOf(classB.id)) === 1, 'M3 single-class assign writes exactly one assignment');
      const singleRemove = await prepareAndApprove(runtimeAdmin, sessionAdmin, principalAdmin, 'manage_teacher', {
        operation: 'remove_assignment',
        teacher_account_id: targetTeacher,
        class_id: classB.id,
      });
      const removed = await executeViaExecutor(runtimeAdmin, sessionAdmin, singleRemove);
      check(removed.ok && removed.receipt === 'saved', 'M3 single-class remove still saves');
      check((await activeAssignmentsOf(classB.id)) === 0, 'M3 single-class remove clears the assignment');
    };

    /* ================================ L ================================ */
    const runL = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'l') return;

      const illegalItem = (): Record<string, unknown> =>
        declaredItem({
          action: 'child.create_profile',
          resource: 'class',
          resource_ref: { kind: 'class', class_id: classA.id },
          payload: {
            kind: 'manage_teacher',
            operation: 'set_status',
            teacher_account_id: targetTeacher,
            username: null,
            display_name: null,
            class_ids: [],
            status: 'disabled',
            secret_via_secure_control: true,
          },
        });

      const teacherStatus = async (): Promise<string | null> => {
        const row = await database.query<{ status: string }>(
          'SELECT status FROM app_accounts WHERE id = $1',
          [targetTeacher],
        );
        return row.rows[0]?.status ?? null;
      };

      // L1 持锁竞争者：非法提案必须在取得业务锁之前被拒绝，不排队等待
      const planL1 = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'child.create_profile', resource: 'class' },
        illegalItem(),
      );
      check(planL1.prepare_status === 201 && planL1.approval_status === 201, 'L1 illegal plan is prepared and approved (shape passes, semantics must fail)');
      const waitBudgetMs = 4000;
      await racerClient.query('BEGIN');
      racerInTransaction = true;
      await racerClient.query('SELECT id FROM classes WHERE id = $1 FOR UPDATE', [classA.id]);
      const startedAt = Date.now();
      const pendingExec = runtimeA
        .executeOperations(carrier(sessionA), {
          approval_id: planL1.approval_id ?? '',
          operation_ids: planL1.operation_ids,
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
        raced !== 'timeout' && raced.ok === false && raced.code === 'invalid_request',
        `L1 illegal plan is rejected with invalid_request without acquiring business locks (got ${raced === 'timeout' ? 'timeout' : raced.ok ? 'ok' : raced.code})`,
      );
      check(
        raced !== 'timeout' && elapsedMs < waitBudgetMs,
        `L1 rejection does not queue behind the held class lock (elapsed=${elapsedMs}ms)`,
      );
      await racerClient.query('ROLLBACK');
      racerInTransaction = false;
      const settled = await Promise.race([pendingExec, sleep(5000).then(() => 'timeout' as const)]);
      pending = null;
      check(settled !== 'timeout', 'L1 execution settles after the competing lock is released');
      check((await receiptRowsFor(planL1.operation_ids)) === 0, 'L1 zero operation receipts are recorded');
      check(!(await approvalConsumed(planL1.approval_id)), 'L1 approval is not consumed');

      // L2 双请求并发：两条非法提案都必须是明确 400，且无 PostgreSQL 死锁
      const planL2a = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'child.create_profile', resource: 'class' },
        illegalItem(),
      );
      const planL2b = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'child.create_profile', resource: 'class' },
        illegalItem(),
      );
      const runIllegal = async (plan: PublicPlan): Promise<{ ok: boolean; code: string; deadlock: boolean }> => {
        const result = await executeViaExecutor(runtimeA, sessionA, plan);
        return { ok: result.ok, code: result.ok ? 'ok' : result.code, deadlock: result.ok ? false : result.code === '40P01' };
      };
      const [l2a, l2b] = await Promise.all([runIllegal(planL2a), runIllegal(planL2b)]);
      check(!l2a.ok && l2a.code === 'invalid_request', `L2 first concurrent illegal request is invalid_request (got ${l2a.code})`);
      check(!l2b.ok && l2b.code === 'invalid_request', `L2 second concurrent illegal request is invalid_request (got ${l2b.code})`);
      check(!l2a.deadlock && !l2b.deadlock, 'L2 concurrent illegal requests produce no PostgreSQL deadlock (40P01)');
      check((await teacherStatus()) === 'active', 'L2 illegal plans make zero business writes (teacher stays active)');
      check((await receiptRowsFor(planL2a.operation_ids)) === 0, 'L2 zero operation receipts for the first illegal plan');
      check((await receiptRowsFor(planL2b.operation_ids)) === 0, 'L2 zero operation receipts for the second illegal plan');
    };

    await runK();
    await runM();
    await runL();

    check(guard.hits === 0, 'R3 check made zero real provider requests through the guard');
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
      model: 'in-process invokeLlm substitute (real provider egress 0); R3 cases expect zero model calls',
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
