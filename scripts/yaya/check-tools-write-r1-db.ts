/**
 * YAYA-TOOLS1-R1 验收：模型前写保护、准备态批准守门、锁后版本核对。
 *
 * 分层（输出 JSON 中逐项标注）：
 * - real executor：真实 `createYayaToolkit().executeOperations` + 真实 AUTH 会话/CSRF + 隔离 PG；
 * - real route handler：真实 `/api/yaya/operations` POST handler（进程内 NextRequest，不含 Next server）；
 * - model double：`invoke` 注入的进程内替身（真实 provider 出口 0）；
 * - provider guard：LLM_* 指向自有回环守门，证明 route 路径真实 provider 出口 0。
 *
 * 用例分组（`TOOLS1_R1_CASE=a|b|c|all` 可单跑）：
 * A 模型前写保护：缺/错 CSRF、不可信 Origin、撤会话、停用账号在模型前拒绝；合法对照仍执行。
 * B needs_prepare 守门：批准取消/到期（执行前与模型等待中）、换会话、同权转班、版本变化全部拒绝且
 *   观察上下文逐字节不变；合法复核保存准备态且不归档；既有 review 场景准备保存故障整单回滚。
 * C 锁后版本核对：真实双连接受控交错（班级改名 / 观察版本），等待后旧批准冲突、他端新值保留、
 *   回执 0 新增、批准不消费。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-tools-write-r1-db.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { NextRequest } from 'next/server';

import { isoDateInShanghai } from '../../src/lib/format';
import { buildPrincipal } from '../../src/lib/accounts/repository';
import {
  computeCsrfToken,
  createSessionToken,
  hashSessionToken,
} from '../../src/lib/accounts/session';
import type { invokeLlm, LlmResult } from '../../src/lib/llm';
import { withPrivateWrite, yayaDataRepository } from '../../src/lib/yaya/data';
import { createYayaToolkit } from '../../src/lib/yaya/tools/write';
import type { YayaOperationProposal } from '../../src/lib/yaya/types';
import { startModelRequestGuard, modelGuardEnv } from '../harness-safety';
import {
  createAcceptanceSeed,
  type AcceptanceSeedHandle,
} from './acceptance/seed';

const REQUESTED_CASE = (process.env.TOOLS1_R1_CASE ?? 'all').toLowerCase();

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

interface ProposedWrite {
  proposal_id: string;
  operation_ids: string[];
  approval_id: string;
}

interface ObservationFacts {
  status: string;
  agent_context: unknown;
  ai_draft: unknown;
  confirmed_content: unknown;
  raw_text: string;
  child_id: string;
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runChecks(): Promise<void> {
  assert.equal(globalThis.__pgPool, undefined, 'r1 check must run in a fresh process');
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  process.env.AUTH_TRUSTED_ORIGINS = 'http://127.0.0.1:3100';

  let seed: AcceptanceSeedHandle | null = null;
  let db: Client | null = null;
  let racer: Client | null = null;
  let racerInTransaction = false;
  let pending: Promise<unknown> | null = null;
  const cleanupIssues: string[] = [];
  let fatal: unknown = null;

  try {
    seed = await createAcceptanceSeed();
    const manifest = seed.manifest;
    db = new Client({ connectionString: seed.database_url });
    racer = new Client({ connectionString: seed.database_url });
    await db.connect();
    await racer.connect();
    const racerClient = racer;
    const database = db;
    const today = isoDateInShanghai();

    const sessionFor = async (accountId: string): Promise<SessionHandle> => {
      const token = createSessionToken();
      await database.query(
        "INSERT INTO app_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [accountId, token.tokenHash],
      );
      return { token: token.token, csrf: computeCsrfToken(token.token) };
    };
    const carrier = (session: SessionHandle, requestId = 'tools1-r1'): { headers: Headers } => ({
      headers: new Headers({
        cookie: `cga_session=${session.token}`,
        origin: 'http://127.0.0.1:3100',
        'x-csrf-token': session.csrf,
        'x-request-id': requestId,
      }),
    });

    const accountA = manifest.accounts.teacher_a;
    const admin = manifest.accounts.admin;
    const sessionA = await sessionFor(accountA.account_id);
    const sessionA3 = await sessionFor(accountA.account_id);
    const sessionA9 = await sessionFor(accountA.account_id);
    const sessionAValidRoute = await sessionFor(accountA.account_id);
    const sessionSecond = await sessionFor(accountA.account_id);
    const sessionAdmin = await sessionFor(admin.account_id);

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

    const teacherConversation = await withPrivateWrite(
      carrier(sessionA),
      ({ client, principal }) =>
        yayaDataRepository.createConversation(client, {
          owner_account_id: principal.account_id,
          title: `tools1 r1 teacher ${manifest.seed_id}`,
        }),
    );
    const adminConversation = await withPrivateWrite(carrier(sessionAdmin), ({ client, principal }) =>
      yayaDataRepository.createConversation(client, {
        owner_account_id: principal.account_id,
        title: `tools1 r1 admin ${manifest.seed_id}`,
      }),
    );

    const modelState = { quote: '' };
    let modelCalls = 0;
    let beforeReturn: (() => Promise<void>) | null = null;
    const invoke: typeof invokeLlm = async (_messages, options) => {
      modelCalls += 1;
      if (beforeReturn) {
        const hook = beforeReturn;
        beforeReturn = null;
        await hook();
      }
      let payload: unknown;
      if (options?.responseType === 'growth_profile') {
        payload = {
          summary: '合成 R1 小结',
          recent_change: '合成 R1 变化',
          development_clues: ['具体行为'],
          next_support: '合成 R1 支持',
          next_focus: '合成 R1 观察',
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
        model: 'tools1-r1-double',
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
    const runtimeA = toolkitFor(sessionA, teacherConversation.conversation_id);
    const runtimeAdmin = toolkitFor(sessionAdmin, adminConversation.conversation_id);

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
    ): Promise<ProposedWrite> => {
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

    const observationFacts = async (observationId: string): Promise<ObservationFacts | undefined> => {
      const row = await database.query<ObservationFacts>(
        'SELECT status, agent_context, ai_draft, confirmed_content, raw_text, child_id FROM observations WHERE id = $1',
        [observationId],
      );
      return row.rows[0];
    };
    const agentContextOf = async (observationId: string): Promise<string> =>
      JSON.stringify((await observationFacts(observationId))?.agent_context ?? null);
    const approvalConsumed = async (approvalId: string): Promise<boolean> => {
      const row = await database.query<{ consumed_at: Date | null }>(
        'SELECT consumed_at FROM yaya_approvals WHERE id = $1',
        [approvalId],
      );
      return row.rows[0]?.consumed_at !== null && row.rows[0]?.consumed_at !== undefined;
    };
    const receiptRowsFor = async (operationIds: readonly string[]): Promise<number> => {
      const row = await database.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM yaya_operations WHERE operation_id = ANY($1::varchar[]) AND status IS NOT NULL',
        [[...operationIds]],
      );
      return Number(row.rows[0]?.n ?? 0);
    };
    const createObservationViaTool = async (rawText: string): Promise<string> => {
      const plan = await prepareAndApprove(runtimeA, sessionA, principalA, 'create_observation', {
        child_id: manifest.children.class_a_same_name.id,
        observed_at: today,
        raw_text: rawText,
      });
      const result = await runtimeA.executeOperations(carrier(sessionA), {
        approval_id: plan.approval_id,
        operation_ids: plan.operation_ids,
      });
      return result.kind === 'receipts' ? (result.receipts[0]?.business_object_id ?? '') : '';
    };
    const organizeViaTool = async (observationId: string, quote: string): Promise<void> => {
      const plan = await prepareAndApprove(runtimeA, sessionA, principalA, 'organize_observation', {
        observation_id: observationId,
      });
      modelState.quote = quote;
      await runtimeA.executeOperations(carrier(sessionA), {
        approval_id: plan.approval_id,
        operation_ids: plan.operation_ids,
      });
    };

    const b5 = manifest.observations.b5_ai_organized;
    const b5Facts = await observationFacts(b5.id);
    const b5ChildId = b5Facts?.child_id ?? '';
    const b5Draft = b5Facts?.ai_draft as Record<string, unknown> | undefined;
    const b5BaseRaw = b5Facts?.raw_text ?? '';
    const resetB5 = async (): Promise<void> => {
      await database.query(
        `UPDATE observations SET agent_context = NULL, status = 'ai_organized', confirmed_content = NULL, updated_at = clock_timestamp() WHERE id = $1`,
        [b5.id],
      );
    };

    /* ================================ A ================================ */
    const runA = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'a') return;
      const growthChild = manifest.children.class_a_same_name.id;

      const planA1 = await prepareAndApprove(runtimeA, sessionA, principalA, 'refresh_growth_profile', {
        child_id: growthChild,
      });
      const callsBeforeA1 = modelCalls;
      const missingCsrfHeaders = new Headers(carrier(sessionA).headers);
      missingCsrfHeaders.delete('x-csrf-token');
      const a1 = await runtimeA
        .executeOperations(
          { headers: missingCsrfHeaders },
          { approval_id: planA1.approval_id, operation_ids: planA1.operation_ids },
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error: errorOf(error) }),
        );
      check('error' in a1 && a1.error.code === 'csrf_rejected', 'A1 executor missing CSRF rejected as csrf_rejected');
      check(modelCalls === callsBeforeA1, 'A1 executor missing CSRF makes zero model calls');
      check(!(await approvalConsumed(planA1.approval_id)), 'A1 failed preflight keeps approval unconsumed');

      const planA2 = await prepareAndApprove(runtimeA, sessionA, principalA, 'refresh_growth_profile', {
        child_id: growthChild,
      });
      const callsBeforeA2 = modelCalls;
      const badOriginHeaders = new Headers(carrier(sessionA).headers);
      badOriginHeaders.set('origin', 'http://127.0.0.1:1');
      const a2 = await runtimeA
        .executeOperations(
          { headers: badOriginHeaders },
          { approval_id: planA2.approval_id, operation_ids: planA2.operation_ids },
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error: errorOf(error) }),
        );
      check('error' in a2 && a2.error.code === 'csrf_rejected', 'A2 executor untrusted origin rejected as csrf_rejected');
      check(modelCalls === callsBeforeA2, 'A2 executor untrusted origin makes zero model calls');

      const planA3 = await prepareAndApprove(runtimeA, sessionA3, principalA, 'refresh_growth_profile', {
        child_id: growthChild,
      });
      await database.query('UPDATE app_sessions SET revoked_at = now() WHERE token_hash = $1', [
        hashSessionToken(sessionA3.token),
      ]);
      const callsBeforeA3 = modelCalls;
      const a3 = await runtimeA
        .executeOperations(carrier(sessionA3), {
          approval_id: planA3.approval_id,
          operation_ids: planA3.operation_ids,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error: errorOf(error) }),
        );
      check('error' in a3 && a3.error.code === 'unauthenticated', 'A3 revoked session rejected as unauthenticated');
      check(modelCalls === callsBeforeA3, 'A3 revoked session makes zero model calls');

      const planA4 = await prepareAndApprove(runtimeA, sessionA, principalA, 'refresh_growth_profile', {
        child_id: growthChild,
      });
      await database.query("UPDATE app_accounts SET status = 'disabled' WHERE id = $1", [
        accountA.account_id,
      ]);
      const callsBeforeA4 = modelCalls;
      const a4 = await runtimeA
        .executeOperations(carrier(sessionA), {
          approval_id: planA4.approval_id,
          operation_ids: planA4.operation_ids,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error: errorOf(error) }),
        );
      check(
        'error' in a4 && ['unauthenticated', 'account_disabled'].includes(a4.error.code),
        'A4 disabled account rejected before model',
      );
      check(modelCalls === callsBeforeA4, 'A4 disabled account makes zero model calls');
      await database.query("UPDATE app_accounts SET status = 'active' WHERE id = $1", [
        accountA.account_id,
      ]);

      // 合法对照：完整 CSRF/Origin/会话 → 模型一次、回执 saved
      const planA5 = await prepareAndApprove(runtimeA, sessionA, principalA, 'refresh_growth_profile', {
        child_id: growthChild,
      });
      const callsBeforeA5 = modelCalls;
      const a5 = await runtimeA.executeOperations(carrier(sessionA), {
        approval_id: planA5.approval_id,
        operation_ids: planA5.operation_ids,
      });
      check(a5.kind === 'receipts' && a5.receipts[0]?.status === 'saved', 'A5 legal executor request still executes');
      check(modelCalls === callsBeforeA5 + 1, 'A5 legal executor request calls the model exactly once');
      check(await approvalConsumed(planA5.approval_id), 'A5 legal execution consumes the approval');

      /* ---- 真实 route handler（进程内 NextRequest） ---- */
      const { POST: operationsPost } = await import('../../src/app/api/yaya/operations/route');
      const routeRequest = (
        session: SessionHandle,
        plan: ProposedWrite,
        mutate?: (headers: Headers) => void,
      ): NextRequest => {
        const headers = new Headers(carrier(session).headers);
        headers.set('content-type', 'application/json');
        mutate?.(headers);
        return new NextRequest('http://127.0.0.1:3100/api/yaya/operations', {
          method: 'POST',
          headers,
          body: JSON.stringify({ approval_id: plan.approval_id, operation_ids: plan.operation_ids }),
        });
      };

      const planA6 = await prepareAndApprove(runtimeA, sessionA, principalA, 'refresh_growth_profile', {
        child_id: growthChild,
      });
      const hitsBeforeA6 = guard.hits;
      const a6 = await operationsPost(routeRequest(sessionA, planA6, (headers) => headers.delete('x-csrf-token')));
      const a6Body = (await a6.json()) as { error?: string };
      check(a6.status === 403 && a6Body.error === 'csrf_rejected', 'A6 route handler missing CSRF is 403 csrf_rejected');
      check(guard.hits === hitsBeforeA6, 'A6 route handler missing CSRF never reaches the provider guard');
      check(!(await approvalConsumed(planA6.approval_id)), 'A6 route rejected request keeps approval unconsumed');

      const planA7 = await prepareAndApprove(runtimeA, sessionA, principalA, 'refresh_growth_profile', {
        child_id: growthChild,
      });
      const hitsBeforeA7 = guard.hits;
      const a7 = await operationsPost(
        routeRequest(sessionA, planA7, (headers) => headers.set('origin', 'http://127.0.0.1:1')),
      );
      const a7Body = (await a7.json()) as { error?: string };
      check(a7.status === 403 && a7Body.error === 'csrf_rejected', 'A7 route handler untrusted origin is 403 csrf_rejected');
      check(guard.hits === hitsBeforeA7, 'A7 route handler untrusted origin never reaches the provider guard');

      // 合法 route 对照：无模型工具（create_observation）走完整 handler
      const rawRoute = `[合成] R1 合法 route 观察：孩子用积木搭桥。${manifest.seed_id}`;
      const planA8 = await prepareAndApprove(runtimeA, sessionAValidRoute, principalA, 'create_observation', {
        child_id: growthChild,
        observed_at: today,
        raw_text: rawRoute,
      });
      const hitsBeforeA8 = guard.hits;
      const a8 = await operationsPost(routeRequest(sessionAValidRoute, planA8));
      const a8Body = (await a8.json()) as { receipts?: { status?: string }[] };
      check(
        a8.status === 200 && a8Body.receipts?.[0]?.status === 'saved',
        'A8 legal route handler still commits (create_observation)',
      );
      check(guard.hits === hitsBeforeA8, 'A8 legal route handler makes no provider attempt for a no-model tool');

      const planA9 = await prepareAndApprove(runtimeA, sessionA9, principalA, 'refresh_growth_profile', {
        child_id: growthChild,
      });
      await database.query('UPDATE app_sessions SET revoked_at = now() WHERE token_hash = $1', [
        hashSessionToken(sessionA9.token),
      ]);
      const a9 = await operationsPost(routeRequest(sessionA9, planA9));
      const a9Body = (await a9.json()) as { error?: string };
      check(a9.status === 401 && a9Body.error === 'unauthenticated', 'A9 route handler revoked session is 401');
    };

    /* ================================ B ================================ */
    const runB = async (): Promise<void> => {
      if (REQUESTED_CASE !== 'all' && REQUESTED_CASE !== 'b') return;
      check(b5Draft !== undefined, 'B setup: seeded ai_organized draft available');
      const editedDraft = (suffix: string): Record<string, unknown> => ({
        ...(b5Draft ?? {}),
        objective_description: `合成 R1 教师修改：${suffix}`,
      });
      const approveB5 = async (suffix: string): Promise<ProposedWrite> =>
        prepareAndApprove(runtimeA, sessionA, principalA, 'confirm_observation', {
          observation_id: b5.id,
          input: { content: editedDraft(suffix) },
        });
      const expectRejectedApprove = async (
        plan: ProposedWrite,
        label: string,
        expectedReasons: readonly string[],
      ): Promise<void> => {
        const before = await agentContextOf(b5.id);
        const outcome = await runtimeA
          .executeOperations(carrier(sessionA), {
            approval_id: plan.approval_id,
            operation_ids: plan.operation_ids,
          })
          .then(
            (value) => ({ value }),
            (error) => ({ error: errorOf(error) }),
          );
        check('error' in outcome, `${label}: rejected instead of needs_prepare`);
        if ('error' in outcome) {
          check(
            expectedReasons.some((reason) => outcome.error.reasons.includes(reason)),
            `${label}: reasons include one of ${expectedReasons.join('/')}`,
          );
        }
        check((await agentContextOf(b5.id)) === before, `${label}: agent_context byte-identical`);
        const facts = await observationFacts(b5.id);
        check(facts?.confirmed_content === null, `${label}: not archived`);
        check(!(await approvalConsumed(plan.approval_id)), `${label}: approval not consumed`);
      };

      // B1 批准执行前已取消
      await resetB5();
      const planB1 = await approveB5('cancelled_before');
      await database.query('UPDATE yaya_approvals SET cancelled_at = now() WHERE id = $1', [planB1.approval_id]);
      {
        const callsBefore = modelCalls;
        await expectRejectedApprove(planB1, 'B1 cancelled before execution', ['approval_cancelled']);
        check(modelCalls === callsBefore, 'B1 cancelled-before makes zero model calls');
      }

      // B2 批准执行前已过期
      await resetB5();
      const planB2 = await approveB5('expired_before');
      await database.query(
        "UPDATE yaya_approvals SET expires_at = now() - interval '1 second' WHERE id = $1",
        [planB2.approval_id],
      );
      {
        const callsBefore = modelCalls;
        await expectRejectedApprove(planB2, 'B2 expired before execution', ['approval_expired']);
        check(modelCalls === callsBefore, 'B2 expired-before makes zero model calls');
      }

      // B3 原会话变化（同账号新会话不继承旧批准）
      await resetB5();
      const planB3 = await approveB5('session_changed');
      {
        const before = await agentContextOf(b5.id);
        const callsBefore = modelCalls;
        const outcome = await runtimeA
          .executeOperations(carrier(sessionSecond), {
            approval_id: planB3.approval_id,
            operation_ids: planB3.operation_ids,
          })
          .then(
            (value) => ({ value }),
            (error) => ({ error: errorOf(error) }),
          );
        check('error' in outcome, 'B3 session change rejected instead of needs_prepare');
        check('error' in outcome && outcome.error.reasons.includes('session_changed'), 'B3 session_changed reason');
        check((await agentContextOf(b5.id)) === before, 'B3 session change agent_context byte-identical');
        check(!(await approvalConsumed(planB3.approval_id)), 'B3 session change keeps approval unconsumed');
        check(modelCalls === callsBefore, 'B3 session change makes zero model calls');
      }

      // B4 模型等待中取消
      await resetB5();
      const planB4 = await approveB5('cancelled_during_model');
      beforeReturn = async () => {
        await database.query('UPDATE yaya_approvals SET cancelled_at = now() WHERE id = $1', [planB4.approval_id]);
      };
      await expectRejectedApprove(planB4, 'B4 cancelled during model', ['approval_cancelled']);

      // B5 模型等待中到期
      await resetB5();
      const planB5 = await approveB5('expired_during_model');
      beforeReturn = async () => {
        await database.query(
          "UPDATE yaya_approvals SET expires_at = now() - interval '1 second' WHERE id = $1",
          [planB5.approval_id],
        );
      };
      await expectRejectedApprove(planB5, 'B5 expired during model', ['approval_expired']);

      // B6 模型等待中同权转班（两个班都在教师 A 任教范围内）
      await resetB5();
      const planB6 = await approveB5('same_scope_transfer');
      beforeReturn = async () => {
        await database.query(
          'UPDATE child_class_enrollments SET end_date = current_date WHERE child_id = $1 AND end_date IS NULL',
          [b5ChildId],
        );
        await database.query(
          'INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1, $2, current_date)',
          [b5ChildId, manifest.classes.class_a.id],
        );
      };
      await expectRejectedApprove(planB6, 'B6 same-scope transfer during model', ['attribution_changed']);
      await database.query(
        'UPDATE child_class_enrollments SET end_date = current_date WHERE child_id = $1 AND end_date IS NULL',
        [b5ChildId],
      );
      await database.query(
        'INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1, $2, current_date)',
        [b5ChildId, manifest.classes.class_b.id],
      );

      // B7 模型等待中业务版本变化
      await resetB5();
      const planB7 = await approveB5('version_change');
      beforeReturn = async () => {
        await database.query('UPDATE observations SET updated_at = clock_timestamp() WHERE id = $1', [b5.id]);
      };
      await expectRejectedApprove(planB7, 'B7 version change during model', ['business_version_changed']);

      /* ---- B8/B9：合法准备态保存 + 原子故障（独立观察） ---- */
      const rawB = `[合成] R1 准备态原子夹具：孩子在阅读区安静翻书。${manifest.seed_id}`;
      const observationB = await createObservationViaTool(rawB);
      check(!!observationB, 'B8 setup: fresh observation created via tool');
      await organizeViaTool(observationB, '安静翻书');
      const draftB = (await observationFacts(observationB))?.ai_draft as Record<string, unknown> | undefined;
      const editedB1 = { ...(draftB ?? {}), objective_description: '合成 R1 准备态修改一。' };
      const editedB2 = { ...(draftB ?? {}), objective_description: '合成 R1 准备态修改二。' };

      const planPrepared1 = await prepareAndApprove(runtimeA, sessionA, principalA, 'confirm_observation', {
        observation_id: observationB,
        input: { content: editedB1 },
      });
      const prepared1 = await runtimeA.executeOperations(carrier(sessionA), {
        approval_id: planPrepared1.approval_id,
        operation_ids: planPrepared1.operation_ids,
      });
      check(prepared1.kind === 'needs_prepare', 'B8 legal teacher edit stops at prepare state');
      const afterPrepared1 = await agentContextOf(observationB);
      const preparedFacts = await observationFacts(observationB);
      check(
        preparedFacts?.agent_context !== null &&
          JSON.stringify(preparedFacts?.agent_context).includes('teacher_edit_review'),
        'B8 prepare state saves teacher_edit_review',
      );
      check(preparedFacts?.confirmed_content === null, 'B8 prepare state does not archive');
      check(!(await approvalConsumed(planPrepared1.approval_id)), 'B8 prepare state does not consume the approval');
      check(preparedFacts?.raw_text === rawB, 'B8 prepare state never rewrites raw_text');

      // B9：已有旧 review，第二次准备保存注入故障 → 整单回滚
      const planPrepared2 = await prepareAndApprove(runtimeA, sessionA, principalA, 'confirm_observation', {
        observation_id: observationB,
        input: { content: editedB2 },
      });
      await database.query(
        `CREATE FUNCTION r1_review_fail() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.id = '${observationB}' AND NEW.agent_context ? 'teacher_edit_review' THEN
             RAISE EXCEPTION 'synthetic R1 preparation save failure';
           END IF;
           RETURN NEW;
         END $$;
         CREATE TRIGGER r1_review_fail BEFORE UPDATE ON observations FOR EACH ROW EXECUTE FUNCTION r1_review_fail();`,
      );
      const prepared2 = await runtimeA
        .executeOperations(carrier(sessionA), {
          approval_id: planPrepared2.approval_id,
          operation_ids: planPrepared2.operation_ids,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error: errorOf(error) }),
        );
      await database.query('DROP TRIGGER r1_review_fail ON observations; DROP FUNCTION r1_review_fail();');
      check('error' in prepared2, 'B9 preparation-save failure surfaces an error');
      check((await agentContextOf(observationB)) === afterPrepared1, 'B9 failure keeps old review byte-identical');
      const afterFailedSave = await observationFacts(observationB);
      check(afterFailedSave?.confirmed_content === null, 'B9 failure keeps confirmation content empty');
      check(afterFailedSave?.raw_text === rawB, 'B9 failure keeps raw_text');
      check(!(await approvalConsumed(planPrepared2.approval_id)), 'B9 failure keeps approval unconsumed');

      // 合法归档仍需新提案（原批准快照已因准备态写入失效）
      const planArchive = await prepareAndApprove(runtimeA, sessionA, principalA, 'confirm_observation', {
        observation_id: observationB,
        input: { content: editedB1 },
      });
      const archived = await runtimeA.executeOperations(carrier(sessionA), {
        approval_id: planArchive.approval_id,
        operation_ids: planArchive.operation_ids,
      });
      check(archived.kind === 'receipts' && archived.receipts[0]?.status === 'saved', 'B8 legal archive still works');
      const archivedFacts = await observationFacts(observationB);
      check(
        archivedFacts?.status === 'confirmed' && archivedFacts?.confirmed_content !== null,
        'B8 legal archive writes confirmed content',
      );
      check(archivedFacts?.raw_text === rawB, 'B8 legal archive never rewrites raw_text');
    };

    /* ================================ C ================================ */
    const waitForLock = async (tableFragment: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const waiting = await database.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
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
      const klass = manifest.classes.class_a;

      const planC1 = await prepareAndApprove(runtimeAdmin, sessionAdmin, principalAdmin, 'manage_class', {
        operation: 'update',
        class_id: klass.id,
        name: 'APPROVED_STALE_NAME',
        stage: klass.stage,
        school_year: klass.school_year,
        is_active: true,
      });
      const receiptsBeforeC1 = await receiptRowsFor(planC1.operation_ids);

      await racerClient.query('BEGIN');
      racerInTransaction = true;
      await racerClient.query('UPDATE classes SET name = $2, updated_at = clock_timestamp() WHERE id = $1', [
        klass.id,
        'OTHER_WRITER_NEW_NAME',
      ]);
      pending = runtimeAdmin
        .executeOperations(carrier(sessionAdmin), {
          approval_id: planC1.approval_id,
          operation_ids: planC1.operation_ids,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error: errorOf(error) }),
        );
      const waitObserved = await waitForLock('classes');
      check(waitObserved, 'C1 controlled race observed a class-row lock wait');
      await racerClient.query('COMMIT');
      racerInTransaction = false;
      const c1 = (await pending) as { value?: unknown; error?: { code: string; reasons: string[] } };
      pending = null;
      const finalName = (
        await database.query<{ name: string }>('SELECT name FROM classes WHERE id = $1', [klass.id])
      ).rows[0]?.name;
      check('error' in c1, 'C1 stale class approval is rejected after the lock wait');
      check(
        'error' in c1 && c1.error?.code === 'approval_invalid' && c1.error.reasons.includes('business_version_changed'),
        'C1 stale class approval reports business_version_changed',
      );
      check(finalName === 'OTHER_WRITER_NEW_NAME', 'C1 concurrent writer new name is preserved');
      check((await receiptRowsFor(planC1.operation_ids)) === receiptsBeforeC1, 'C1 rejected execution adds zero receipts');
      check(!(await approvalConsumed(planC1.approval_id)), 'C1 rejected execution keeps approval unconsumed');

      // C2 观察版本竞争：准备/批准确认归档，另一端持行锁推进 updated_at
      const rawC = `[合成] R1 版本竞争观察：孩子把积木排成一排。${manifest.seed_id}`;
      const observationC = await createObservationViaTool(rawC);
      await organizeViaTool(observationC, '把积木排成一排');
      const draftC = (await observationFacts(observationC))?.ai_draft as Record<string, unknown> | undefined;
      const planC2 = await prepareAndApprove(runtimeA, sessionA, principalA, 'confirm_observation', {
        observation_id: observationC,
        input: { content: { ...(draftC ?? {}) } },
      });
      const receiptsBeforeC2 = await receiptRowsFor(planC2.operation_ids);
      await racerClient.query('BEGIN');
      racerInTransaction = true;
      await racerClient.query('UPDATE observations SET updated_at = clock_timestamp() WHERE id = $1', [observationC]);
      pending = runtimeA
        .executeOperations(carrier(sessionA), {
          approval_id: planC2.approval_id,
          operation_ids: planC2.operation_ids,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error: errorOf(error) }),
        );
      const waitObservedC2 = await waitForLock('observations');
      check(waitObservedC2, 'C2 controlled race observed an observation-row lock wait');
      await racerClient.query('COMMIT');
      racerInTransaction = false;
      const c2 = (await pending) as { value?: unknown; error?: { code: string; reasons: string[] } };
      pending = null;
      check('error' in c2, 'C2 stale observation approval is rejected after the lock wait');
      check(
        'error' in c2 && c2.error?.code === 'approval_invalid' && c2.error.reasons.includes('business_version_changed'),
        'C2 stale observation approval reports business_version_changed',
      );
      const factsC2 = await observationFacts(observationC);
      check(factsC2?.confirmed_content === null, 'C2 rejected confirm writes zero business change');
      check((await receiptRowsFor(planC2.operation_ids)) === receiptsBeforeC2, 'C2 rejected execution adds zero receipts');
      check(!(await approvalConsumed(planC2.approval_id)), 'C2 rejected execution keeps approval unconsumed');
      void b5BaseRaw;
    };

    await runA();
    await runB();
    await runC();

    check(guard.hits === 0, 'R1 check made zero real provider requests through the guard');
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
      executor: 'real createYayaToolkit().executeOperations + real AUTH sessions/CSRF + isolated PG',
      route_handler: 'real /api/yaya/operations POST handler in-process (no Next server)',
      model: 'in-process invokeLlm substitute (real provider egress 0)',
      provider_guard: 'LLM_* pointed at owned loopback guard; hits counted',
    },
    not_run: ['Next HTTP server', 'real provider model quality', 'browser', 'hosted DB', 'deployment'],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

runChecks().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
