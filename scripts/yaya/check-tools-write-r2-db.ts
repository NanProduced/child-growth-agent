/**
 * YAYA-TOOLS1-R2 验收：工具与批准元数据绑定、null 业务版本保守拒绝、调用链锁序。
 *
 * 分层（输出 JSON 中逐项标注）：
 * - real route handler：真实 `/api/yaya/proposals`、`/api/yaya/proposals/{id}/approval`、
 *   `/api/yaya/operations`、`/api/classes` POST handler（进程内 NextRequest，不含 Next server）；
 * - real executor：真实 `createYayaToolkit().executeOperations` + 真实 AUTH 会话/CSRF + 隔离 PG；
 * - model double：`invoke` 注入的进程内替身（真实 provider 出口 0）；
 * - provider guard：LLM_* 指向自有回环守门，证明全程真实 provider 出口 0。
 *
 * 用例分组（`TOOLS1_R2_CASE=a|b|c|all` 可单跑）：
 * A 绑定：公开准备/批准/执行链路按 payload.kind+operation 推导真实动作、资源与目标并与批准条目
 *   绑定；错动作、错目标、跨班 payload 越权全部在模型前拒绝；合法教师、管理员动作保持。
 * B null 版本：版本必需动作的空版本前提保守拒绝，不覆盖并发变化；非空一致与真正无版本动作保持。
 * C 锁序：既有任教服务与工具执行受控交错无 40P01，等待/串行化可观测且数据与回执一致。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-tools-write-r2-db.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { buildPrincipal, assignTeacherClassWithClient } from '../../src/lib/accounts/repository';
import { computeCsrfToken, createSessionToken, hashSessionToken } from '../../src/lib/accounts/session';
import { isoDateInShanghai } from '../../src/lib/format';
import type { invokeLlm, LlmResult } from '../../src/lib/llm';
import { POST as classesPost } from '../../src/app/api/classes/route';
import { POST as operationsPost } from '../../src/app/api/yaya/operations/route';
import { POST as proposalsPost } from '../../src/app/api/yaya/proposals/route';
import { POST as approvalPost } from '../../src/app/api/yaya/proposals/[id]/approval/route';
import { withPrivateWrite, yayaDataRepository } from '../../src/lib/yaya/data';
import { createYayaToolkit } from '../../src/lib/yaya/tools/write';
import type { YayaOperationProposal } from '../../src/lib/yaya/types';
import type { TransactionClient } from '../../src/storage/database/pg-client';
import { modelGuardEnv, startModelRequestGuard } from '../harness-safety';
import { createAcceptanceSeed, type AcceptanceSeedHandle } from './acceptance/seed';

const REQUESTED_CASE = (process.env.TOOLS1_R2_CASE ?? 'all').toLowerCase();

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

interface ExecuteRouteResult {
  status: number;
  error: string | null;
  reasons: string[];
  receiptStatus: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function draftFor(quote: string): Record<string, unknown> {
  return {
    domain: '健康',
    sub_domain: '动作发展',
    objective_description: '能按自己的节奏完成活动并保持稳定情绪。',
    highlights: [quote],
    support_suggestions: ['提供更多自由选择与鼓励'],
    highlight_quote: quote,
  };
}

async function runChecks(): Promise<void> {
  assert.equal(globalThis.__pgPool, undefined, 'r2 check must run in a fresh process');
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  process.env.AUTH_TRUSTED_ORIGINS = 'http://127.0.0.1:3200';

  let seed: AcceptanceSeedHandle | null = null;
  let db: Client | null = null;
  let racer: Client | null = null;
  let racerInTransaction = false;
  let pending: Promise<unknown> | null = null;
  let releaseGate: (() => void) | null = null;
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
    const today = isoDateInShanghai();
    const seedTag = manifest.seed_id;

    const sessionFor = async (accountId: string): Promise<SessionHandle> => {
      const token = createSessionToken();
      await database.query(
        "INSERT INTO app_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [accountId, token.tokenHash],
      );
      return { token: token.token, csrf: computeCsrfToken(token.token) };
    };
    const carrier = (session: SessionHandle, requestId = 'tools1-r2'): { headers: Headers } => ({
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
    const sessionA = await sessionFor(accountA.account_id);
    const sessionAdmin = await sessionFor(admin.account_id);
    const classA = manifest.classes.class_a;
    const classB = manifest.classes.class_b;
    const classC = manifest.classes.class_c;

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

    const modelState = { quote: '' };
    const invoke: typeof invokeLlm = async (_messages, options) => {
      modelCalls += 1;
      let payload: unknown;
      if (options?.responseType === 'growth_profile') {
        payload = {
          summary: '合成 R2 小结',
          recent_change: '合成 R2 变化',
          development_clues: ['具体行为'],
          next_support: '合成 R2 支持',
          next_focus: '合成 R2 观察',
        };
      } else if (options?.responseType === 'teacher_edit_review') {
        payload = {
          decision: 'accept',
          summary: '修改有原文依据。',
          change_summary: ['描述调整'],
          fact_check: 'supported',
          question: '',
        };
      } else if (options?.responseType === 'observation_draft') {
        payload = draftFor(modelState.quote);
      } else if (options?.responseType === 'follow_up_decision') {
        payload = { decision: 'proceed', question: '', reason: '信息足够。' };
      } else {
        throw new Error(`unexpected substitute model call: ${String(options?.responseType)}`);
      }
      return {
        content: JSON.stringify(payload),
        provider: 'stepfun',
        model: 'tools1-r2-double',
        usage: undefined,
      } satisfies LlmResult;
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

    const errorOf = (error: unknown): { code: string; reasons: string[]; message: string } => {
      const record = error as { code?: string; details?: { reasons?: string[] }; message?: string };
      return {
        code: String(record.code ?? error),
        reasons: Array.isArray(record.details?.reasons) ? record.details.reasons : [],
        message: String(record.message ?? ''),
      };
    };

    const prepareAndApprove = async (
      runtime: ReturnType<typeof toolkitFor>,
      session: SessionHandle,
      principal: typeof principalA,
      tool: string,
      params: unknown,
    ): Promise<{ proposal_id: string; operation_ids: string[]; approval_id: string }> => {
      const runId = randomUUID();
      const proposed = await runtime.toolkit.proposeWrite({
        run_id: runId,
        tool,
        params,
        identity: {
          run_id: runId,
          identity_state: 'authenticated',
          principal,
          session_valid: true,
        },
        proposal_origin: 'model_suggestion',
      });
      assert.ok(proposed.ok, proposed.ok ? '' : `propose ${tool}: ${proposed.code}`);
      const proposal = proposed.proposals[0] as YayaOperationProposal;
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
      };
    };

    /** 公开准备 + 可信批准（真实 route handler），不 assert 状态码，交由用例判定。 */
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

    const executeViaRoute = async (session: SessionHandle, plan: PublicPlan): Promise<ExecuteRouteResult> => {
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
    const countClassesNamed = async (name: string): Promise<number> => {
      const row = await database.query<{ n: string }>('SELECT count(*)::text AS n FROM classes WHERE name = $1', [
        name,
      ]);
      return Number(row.rows[0]?.n ?? 0);
    };
    const classNameOf = async (classId: string): Promise<string | null> => {
      const row = await database.query<{ name: string }>('SELECT name FROM classes WHERE id = $1', [classId]);
      return row.rows[0]?.name ?? null;
    };
    const observationDraftSnapshot = async (observationId: string): Promise<string> => {
      const row = await database.query<{ ai_draft: unknown; agent_context: unknown }>(
        'SELECT ai_draft, agent_context FROM observations WHERE id = $1',
        [observationId],
      );
      return JSON.stringify([row.rows[0]?.ai_draft ?? null, row.rows[0]?.agent_context ?? null]);
    };
    const countObservationsForChild = async (childId: string, rawText: string): Promise<number> => {
      const row = await database.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM observations WHERE child_id = $1 AND raw_text = $2',
        [childId, rawText],
      );
      return Number(row.rows[0]?.n ?? 0);
    };
    const currentClassRevision = async (classId: string): Promise<string | null> => {
      const row = await database.query<{ revision: string | null }>(
        'SELECT COALESCE(updated_at, created_at)::text AS revision FROM classes WHERE id = $1',
        [classId],
      );
      return row.rows[0]?.revision ?? null;
    };

    const declaredItem = (
      overrides: Partial<{
        item_key: string;
        target_id: string;
        action: string;
        resource: string;
        resource_ref: Record<string, unknown>;
        payload: Record<string, unknown>;
        business_revision: string | null;
      }> = {},
    ): Record<string, unknown> => ({
      item_key: overrides.item_key ?? `r2-${randomUUID().slice(0, 8)}`,
      target_id: overrides.target_id ?? classA.id,
      action: overrides.action ?? 'class.manage',
      resource: overrides.resource ?? 'class',
      resource_ref: overrides.resource_ref ?? { kind: 'class', class_id: classA.id },
      payload: overrides.payload ?? { kind: 'manage_class', operation: 'create', class_id: null, name: 'x', stage: 'small', school_year: classA.school_year, is_active: true },
      attachment_associations: [],
      ...(overrides.business_revision !== undefined ? { business_revision: overrides.business_revision } : {}),
    });

    /* ================================ A ================================ */
    const runA = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'a') return;

      // A0 基线：普通教师走正常建班 handler 本就是 403（管理员专属）
      const normalClass = await classesPost(
        nextRequest(sessionA, '/api/classes', {
          name: `R2_NORMAL_DENIED_${seedTag}`,
          stage: 'small',
          school_year: classA.school_year,
          is_active: true,
        }),
      );
      check(normalClass.status === 403, 'A0 normal class create by teacher stays 403');

      // A1 越权建班：声明 child.create_profile/class（本人任教班），payload 却是 manage_class/create
      const escalateName = `R2_ESCALATED_${seedTag}`;
      const planA1 = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'child.create_profile', resource: 'class' },
        declaredItem({
          target_id: classA.id,
          action: 'child.create_profile',
          resource: 'class',
          resource_ref: { kind: 'class', class_id: classA.id },
          payload: {
            kind: 'manage_class',
            operation: 'create',
            class_id: null,
            name: escalateName,
            stage: 'small',
            school_year: classA.school_year,
            is_active: true,
          },
        }),
      );
      check(planA1.prepare_status === 201, 'A1 public prepare accepts the stored item (201)');
      check(planA1.approval_status === 201, 'A1 trusted approval of declared action succeeds (201)');
      const modelBeforeA1 = modelCalls;
      const a1 = await executeViaRoute(sessionA, planA1);
      check(a1.status >= 400 && a1.status < 500, 'A1 execution is rejected before any business write');
      check(a1.receiptStatus === null, 'A1 rejected execution returns no receipt');
      check((await countClassesNamed(escalateName)) === 0, 'A1 no admin-only class row is created');
      check((await receiptRowsFor(planA1.operation_ids)) === 0, 'A1 zero operation receipts are recorded');
      check(!(await approvalConsumed(planA1.approval_id)), 'A1 approval is not consumed');
      check(modelCalls === modelBeforeA1, 'A1 makes zero model calls');

      // A2 同 kind 错目标：声明目标是 b1，payload 指向 b5（直接 executor 入口）
      const b1 = manifest.observations.b1_plain;
      const b5 = manifest.observations.b5_ai_organized;
      const draftBeforeA2 = await observationDraftSnapshot(b5.id);
      const planA2 = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'observation.organize', resource: 'observation' },
        declaredItem({
          target_id: b1.id,
          action: 'observation.organize',
          resource: 'observation',
          resource_ref: { kind: 'observation', observation_id: b1.id },
          payload: { kind: 'organize_observation', observation_id: b5.id },
        }),
      );
      check(planA2.prepare_status === 201 && planA2.approval_status === 201, 'A2 public chain prepared and approved');
      const modelBeforeA2 = modelCalls;
      const a2 = await executeViaExecutor(runtimeA, sessionA, planA2);
      check(a2.ok === false, 'A2 wrong payload target is rejected instead of executing');
      check(modelCalls === modelBeforeA2, 'A2 rejected wrong-target request makes zero model calls');
      check((await observationDraftSnapshot(b5.id)) === draftBeforeA2, 'A2 wrong-target payload never writes the other observation');
      check((await receiptRowsFor(planA2.operation_ids)) === 0, 'A2 zero operation receipts are recorded');
      check(!(await approvalConsumed(planA2.approval_id)), 'A2 approval is not consumed');

      // A3 错误 action：声明 observation.confirm，payload 却是 organize（公开链路）
      const draftBeforeA3 = await observationDraftSnapshot(b5.id);
      const planA3 = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'observation.confirm', resource: 'observation' },
        declaredItem({
          target_id: b5.id,
          action: 'observation.confirm',
          resource: 'observation',
          resource_ref: { kind: 'observation', observation_id: b5.id },
          payload: { kind: 'organize_observation', observation_id: b5.id },
        }),
      );
      check(planA3.prepare_status === 201 && planA3.approval_status === 201, 'A3 public chain prepared and approved');
      const modelBeforeA3 = modelCalls;
      const a3 = await executeViaRoute(sessionA, planA3);
      check(a3.status >= 400 && a3.status < 500, 'A3 wrong declared action is rejected before the model');
      check(modelCalls === modelBeforeA3, 'A3 makes zero model calls');
      check((await observationDraftSnapshot(b5.id)) === draftBeforeA3, 'A3 wrong-action payload never writes the observation');
      check((await receiptRowsFor(planA3.operation_ids)) === 0, 'A3 zero operation receipts are recorded');
      check(!(await approvalConsumed(planA3.approval_id)), 'A3 approval is not consumed');

      // A4a 跨班目标（声明即越权）：批准入口的真实 AUTH 直接拒绝
      const crossChild = manifest.children.class_c_transfer;
      const planA4a = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'observation.write', resource: 'child' },
        declaredItem({
          target_id: crossChild.id,
          action: 'observation.write',
          resource: 'child',
          resource_ref: { kind: 'child', child_id: crossChild.id },
          payload: {
            kind: 'create_observation',
            child_id: crossChild.id,
            observed_at: today,
            raw_text: `[合成] R2 跨班声明越权观察：孩子在走廊跑动。${seedTag}`,
            context: null,
            confirmed_class_id: null,
            image_ids: [],
            source_input: null,
          },
        }),
      );
      check(planA4a.approval_status !== 201, 'A4a out-of-scope declared target is denied at approval');
      check((await receiptRowsFor(planA4a.operation_ids)) === 0, 'A4a zero operation receipts are recorded');

      // A4b 跨班 payload：声明目标在本人班内，payload 指向他班幼儿
      const crossRaw = `[合成] R2 跨班 payload 观察：孩子在走廊跑动。${seedTag}`;
      const planA4b = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'observation.write', resource: 'child' },
        declaredItem({
          target_id: manifest.children.class_b_same_name.id,
          action: 'observation.write',
          resource: 'child',
          resource_ref: { kind: 'child', child_id: manifest.children.class_b_same_name.id },
          payload: {
            kind: 'create_observation',
            child_id: crossChild.id,
            observed_at: today,
            raw_text: crossRaw,
            context: null,
            confirmed_class_id: null,
            image_ids: [],
            source_input: null,
          },
        }),
      );
      check(planA4b.prepare_status === 201 && planA4b.approval_status === 201, 'A4b public chain prepared and approved');
      const a4b = await executeViaRoute(sessionA, planA4b);
      check(a4b.status >= 400 && a4b.status < 500, 'A4b cross-class payload target is rejected');
      check((await countObservationsForChild(crossChild.id, crossRaw)) === 0, 'A4b no cross-class observation row is created');
      check((await receiptRowsFor(planA4b.operation_ids)) === 0, 'A4b zero operation receipts are recorded');
      check(!(await approvalConsumed(planA4b.approval_id)), 'A4b approval is not consumed');

      // A5 管理员同样不能错目标：声明 class_a，payload 更新 class_b
      const classNameBBefore = await classNameOf(classB.id);
      const wrongTargetName = `R2_ADMIN_WRONG_TARGET_${seedTag}`;
      const planA5 = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'class.manage', resource: 'class' },
        declaredItem({
          target_id: classA.id,
          action: 'class.manage',
          resource: 'class',
          resource_ref: { kind: 'class', class_id: classA.id },
          payload: {
            kind: 'manage_class',
            operation: 'update',
            class_id: classB.id,
            name: wrongTargetName,
            stage: classB.stage,
            school_year: classB.school_year,
            is_active: true,
          },
        }),
      );
      check(planA5.prepare_status === 201 && planA5.approval_status === 201, 'A5 admin public chain prepared and approved');
      const a5 = await executeViaRoute(sessionAdmin, planA5);
      check(a5.status >= 400 && a5.status < 500, 'A5 admin wrong payload target is rejected');
      check((await classNameOf(classB.id)) === classNameBBefore, 'A5 out-of-bound class keeps its name');
      check((await receiptRowsFor(planA5.operation_ids)) === 0, 'A5 zero operation receipts are recorded');
      check(!(await approvalConsumed(planA5.approval_id)), 'A5 approval is not consumed');

      // A6 合法教师对照：本人班内观察整理仍执行
      const draftBeforeA6 = await observationDraftSnapshot(b5.id);
      const planA6 = await prepareAndApprove(runtimeA, sessionA, principalA, 'organize_observation', {
        observation_id: b5.id,
      });
      modelState.quote = b5.raw_text.split('。')[0];
      const modelBeforeA6 = modelCalls;
      const a6 = await runtimeA.executeOperations(carrier(sessionA), {
        approval_id: planA6.approval_id,
        operation_ids: planA6.operation_ids,
      });
      check(a6.kind === 'receipts' && a6.receipts[0]?.status === 'saved', 'A6 legal teacher organize still executes');
      // 追问判断 + 整理可能各调一次模型（依 agent_context 而定），故只要求真正触达替身
      check(
        modelCalls > modelBeforeA6,
        `A6 legal organize reaches the injected model (before=${modelBeforeA6} after=${modelCalls})`,
      );
      check((await observationDraftSnapshot(b5.id)) !== draftBeforeA6, 'A6 legal organize writes its own observation');
      check(await approvalConsumed(planA6.approval_id), 'A6 legal execution consumes the approval');

      // A7 合法管理员对照：管理员建班仍执行
      const adminCreateName = `R2_ADMIN_CREATE_${seedTag}`;
      const planA7 = await prepareAndApprove(runtimeAdmin, sessionAdmin, principalAdmin, 'manage_class', {
        operation: 'create',
        name: adminCreateName,
        stage: 'small',
        school_year: classA.school_year,
      });
      const a7 = await runtimeAdmin.executeOperations(carrier(sessionAdmin), {
        approval_id: planA7.approval_id,
        operation_ids: planA7.operation_ids,
      });
      check(a7.kind === 'receipts' && a7.receipts[0]?.status === 'saved', 'A7 legal admin class create still executes');
      check((await countClassesNamed(adminCreateName)) === 1, 'A7 legal admin create writes exactly one class');

      // A8 公开准备入口的 payload schema：未注册 kind / 形状不合法 / 密码类操作一律拒绝
      const unknownKind = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'child.create_profile', resource: 'class' },
        declaredItem({ payload: { kind: 'r2_unknown_kind' } }),
      );
      check(
        unknownKind.prepare_status === 400 && unknownKind.prepare_error === 'invalid_request',
        'A8 public prepare rejects an unregistered payload kind with invalid_request',
      );
      const malformed = await publicPlan(
        sessionA,
        teacherConversationId,
        { kind: 'action', action: 'class.manage', resource: 'class' },
        declaredItem({ payload: { kind: 'manage_class', operation: 'update', class_id: classA.id } }),
      );
      check(
        malformed.prepare_status === 400 && malformed.prepare_error === 'invalid_request',
        'A8 public prepare rejects a malformed payload with invalid_request',
      );
      const passwordOperation = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'teacher.manage', resource: 'school' },
        declaredItem({
          target_id: manifest.school_id,
          action: 'teacher.manage',
          resource: 'school',
          resource_ref: { kind: 'school' },
          payload: {
            kind: 'manage_teacher',
            operation: 'reset_password',
            teacher_account_id: manifest.accounts.teacher_c.account_id,
            username: null,
            display_name: null,
            class_ids: [],
            status: null,
            secret_via_secure_control: true,
          },
        }),
      );
      check(
        passwordOperation.prepare_status === 400 && passwordOperation.prepare_error === 'invalid_request',
        'A8 public prepare rejects password-style manage_teacher payloads',
      );
    };

    /* ================================ B ================================ */
    const runB = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'b') return;

      const updateItem = (name: string, revision: string | null): Record<string, unknown> =>
        declaredItem({
          target_id: classA.id,
          action: 'class.manage',
          resource: 'class',
          resource_ref: { kind: 'class', class_id: classA.id },
          payload: {
            kind: 'manage_class',
            operation: 'update',
            class_id: classA.id,
            name,
            stage: classA.stage,
            school_year: classA.school_year,
            is_active: true,
          },
          business_revision: revision,
        });

      // B1 空版本前提 + 并发改名：不得覆盖并发变化
      const legacyName = `R2_LEGACY_NULL_NAME_${seedTag}`;
      const planB1 = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'class.manage', resource: 'class' },
        updateItem(legacyName, null),
      );
      check(planB1.prepare_status === 201 && planB1.approval_status === 201, 'B1 null-version public chain prepared and approved');
      const concurrentName = `R2_CONCURRENT_NAME_${seedTag}`;
      await database.query('UPDATE classes SET name = $2, updated_at = clock_timestamp() WHERE id = $1', [
        classA.id,
        concurrentName,
      ]);
      const modelBeforeB1 = modelCalls;
      const b1 = await executeViaRoute(sessionAdmin, planB1);
      check(b1.status >= 400 && b1.status < 500, 'B1 null-version approval is rejected instead of executed');
      check(
        b1.error === 'approval_invalid' && b1.reasons.includes('business_version_changed'),
        'B1 null-version approval reports approval_invalid/business_version_changed',
      );
      check((await classNameOf(classA.id)) === concurrentName, 'B1 concurrent class rename is preserved');
      check((await receiptRowsFor(planB1.operation_ids)) === 0, 'B1 zero operation receipts are recorded');
      check(!(await approvalConsumed(planB1.approval_id)), 'B1 approval is not consumed');
      check(modelCalls === modelBeforeB1, 'B1 makes zero model calls');

      // B2 非空一致对照：携带当前版本且无并发变化时正常执行
      const revisionB2 = await currentClassRevision(classA.id);
      check(typeof revisionB2 === 'string' && revisionB2 !== '', 'B2 setup reads the current class revision');
      const acceptedName = `R2_ACCEPTED_NAME_${seedTag}`;
      const planB2 = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'class.manage', resource: 'class' },
        updateItem(acceptedName, revisionB2 ?? null),
      );
      check(planB2.prepare_status === 201 && planB2.approval_status === 201, 'B2 non-null public chain prepared and approved');
      const b2 = await executeViaRoute(sessionAdmin, planB2);
      check(b2.status === 200 && b2.receiptStatus === 'saved', 'B2 consistent non-null version still executes');
      check((await classNameOf(classA.id)) === acceptedName, 'B2 accepted rename is written');
      check(await approvalConsumed(planB2.approval_id), 'B2 legal execution consumes the approval');

      // B3 真正无版本动作：公开 manage_class/create（业务对象尚不存在）保持合法
      const createName = `R2_NO_VERSION_CREATE_${seedTag}`;
      const planB3 = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'class.manage', resource: 'class' },
        declaredItem({
          target_id: 'new-class',
          action: 'class.manage',
          resource: 'class',
          resource_ref: { kind: 'class', class_id: null },
          payload: {
            kind: 'manage_class',
            operation: 'create',
            class_id: null,
            name: createName,
            stage: 'small',
            school_year: classA.school_year,
            is_active: true,
          },
          business_revision: null,
        }),
      );
      check(planB3.prepare_status === 201 && planB3.approval_status === 201, 'B3 null-version create chain prepared and approved');
      const b3 = await executeViaRoute(sessionAdmin, planB3);
      check(b3.status === 200 && b3.receiptStatus === 'saved', 'B3 version-free create still executes');
      check((await countClassesNamed(createName)) === 1, 'B3 create writes exactly one class');
      check(await approvalConsumed(planB3.approval_id), 'B3 legal execution consumes the approval');

      // B4 非空但过期版本：批准后并发推进修订，仍按版本冲突拒绝
      const revisionB4 = await currentClassRevision(classA.id);
      const staleName = `R2_STALE_NAME_${seedTag}`;
      const planB4 = await publicPlan(
        sessionAdmin,
        adminConversationId,
        { kind: 'action', action: 'class.manage', resource: 'class' },
        updateItem(staleName, revisionB4),
      );
      check(planB4.prepare_status === 201 && planB4.approval_status === 201, 'B4 stale-version public chain prepared and approved');
      await database.query('UPDATE classes SET updated_at = clock_timestamp() WHERE id = $1', [classA.id]);
      const b4 = await executeViaRoute(sessionAdmin, planB4);
      check(
        b4.error === 'approval_invalid' && b4.reasons.includes('business_version_changed'),
        'B4 stale non-null version still reports business_version_changed',
      );
      check((await receiptRowsFor(planB4.operation_ids)) === 0, 'B4 zero operation receipts are recorded');
      check(!(await approvalConsumed(planB4.approval_id)), 'B4 approval is not consumed');

      // B5 附件 CAS 无版本语义保持：prepare 派生 business_revision=null，执行期只按附件 CAS
      // 失败（revision_conflict），不得被误杀成 business_version_changed、不落回执、不消费批准
      const hostObs = await database.query<{ id: string; child_id: string; confirmed_at: Date | null }>(
        'SELECT id, child_id, confirmed_at FROM observations WHERE id = $1',
        [manifest.observations.a1_h1.id],
      );
      const confirmedObservation = hostObs.rows[0] ?? null;
      check(!!confirmedObservation && confirmedObservation.confirmed_at !== null, 'B5 setup reads a confirmed observation');
      if (confirmedObservation?.confirmed_at) {
        const revRow = await database.query<{ n: string }>(
          'SELECT attachment_revision::text AS n FROM yaya_observation_attachment_meta WHERE observation_id = $1',
          [confirmedObservation.id],
        );
        const currentAttachmentRevision = Number(revRow.rows[0]?.n ?? 0);
        const planB5 = await prepareAndApprove(runtimeA, sessionA, principalA, 'attach_observation_images', {
          observation_id: confirmedObservation.id,
          image_ids: [manifest.media.shared_photo.attachment_id],
          expected_attachment_revision: currentAttachmentRevision + 1,
          source_confirmed_at: new Date(confirmedObservation.confirmed_at).toISOString(),
        });
        const b5Result = await executeViaRoute(sessionA, {
          proposal_id: planB5.proposal_id,
          operation_ids: planB5.operation_ids,
          approval_id: planB5.approval_id,
          prepare_status: 201,
          prepare_error: null,
          approval_status: 201,
          approval_error: null,
        });
        check(
          !(b5Result.error === 'approval_invalid' && b5Result.reasons.includes('business_version_changed')),
          'B5 attachment CAS action is not rejected as a missing version premise',
        );
        check(b5Result.receiptStatus === null, 'B5 failed attach records no receipt');
        check((await receiptRowsFor(planB5.operation_ids)) === 0, 'B5 zero operation receipts are recorded');
        check(!(await approvalConsumed(planB5.approval_id)), 'B5 approval is not consumed');
      }
    };

    /* ================================ C ================================ */
    const waitForLock = async (tableFragment: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const waiting = await database.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND pid <> pg_backend_pid()
              AND query ILIKE $1`,
          [`%${tableFragment}%FOR UPDATE%`],
        );
        if (Number(waiting.rows[0]?.n ?? 0) > 0) return true;
        await sleep(50);
      }
      return false;
    };

    const runC = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'c') return;
      const targetTeacher = manifest.accounts.teacher_c.account_id;
      const planC = await prepareAndApprove(runtimeAdmin, sessionAdmin, principalAdmin, 'manage_teacher', {
        operation: 'assign_class',
        teacher_account_id: targetTeacher,
        class_id: classA.id,
      });

      let lockedResolve!: () => void;
      const locked = new Promise<void>((resolve) => {
        lockedResolve = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      await racerClient.query("SET deadlock_timeout='200ms'; SET lock_timeout='5s'; BEGIN");
      racerInTransaction = true;
      let paused = false;
      const adapter = {
        query: async (sql: string, values?: unknown[]) => {
          const rows = await racerClient.query(sql, values);
          if (!paused && sql.includes('SELECT role, status FROM app_accounts') && values?.[0] === targetTeacher) {
            paused = true;
            lockedResolve();
            await gate;
          }
          return rows;
        },
        release: () => undefined,
      } as unknown as TransactionClient;
      const safeError = (error: unknown): { ok: false; code: string } => ({
        ok: false,
        code: typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : String(error),
      });
      const normalPending = assignTeacherClassWithClient(
        adapter,
        targetTeacher,
        classA.id,
        admin.account_id,
      ).then(
        () => ({ ok: true as const }),
        safeError,
      );
      await locked;
      check(paused, 'C existing assignment service really holds the teacher row lock');

      const toolPending = runtimeAdmin
        .executeOperations(carrier(sessionAdmin), {
          approval_id: planC.approval_id,
          operation_ids: planC.operation_ids,
        })
        .then(
          (value) => ({ ok: true as const, kind: value.kind, receipt: value.kind === 'receipts' ? (value.receipts[0]?.status ?? null) : null }),
          (error: unknown) => {
            const mapped = errorOf(error);
            return { ok: false as const, kind: mapped.code, receipt: null, code: mapped.code, reasons: mapped.reasons };
          },
        );
      const waitObserved = await waitForLock('app_accounts');
      check(waitObserved, 'C tool execution waits on the teacher row held by the existing service');
      releaseGate?.();
      const normalResult = await normalPending;
      pending = null;
      await racerClient.query('ROLLBACK');
      racerInTransaction = false;
      const toolResult = (await toolPending) as
        | { ok: true; kind: string; receipt: string | null }
        | { ok: false; kind: string; receipt: null; code: string; reasons: string[] };
      check(
        normalResult.ok || normalResult.code !== '40P01',
        'C existing assignment service completes without40P01',
      );
      check(
        toolResult.ok || toolResult.code !== '40P01',
        'C tool execution completes without40P01',
      );
      check(toolResult.ok === true, 'C tool execution still finishes after the controlled wait');
      check(toolResult.ok && toolResult.receipt === 'saved', 'C tool execution records a saved receipt');
      check(await approvalConsumed(planC.approval_id), 'C tool execution consumes the approval');
      const assignments = await database.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM teacher_class_assignments WHERE account_id = $1 AND class_id = $2 AND removed_at IS NULL",
        [targetTeacher, classA.id],
      );
      check(Number(assignments.rows[0]?.n ?? 0) === 1, 'C exactly one active assignment is committed');
    };

    await runA();
    await runB();
    await runC();

    check(guard.hits === 0, 'R2 check made zero real provider requests through the guard');
  } catch (error) {
    fatal = error;
  } finally {
    if (racerInTransaction && racer) {
      await racer.query('ROLLBACK').catch((error: unknown) => cleanupIssues.push(`racer-rollback: ${String(error)}`));
    }
    const releaseGateFn = releaseGate as (() => void) | null;
    if (releaseGateFn) releaseGateFn();
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
      route_handler: 'real proposals/approval/operations/classes POST handlers in-process (no Next server)',
      executor: 'real createYayaToolkit().executeOperations + real AUTH sessions/CSRF + isolated PG',
      model: 'in-process invokeLlm substitute (real provider egress 0)',
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
