/**
 * TOOLS1 真实写工具与批准执行检查（一次性隔离 PostgreSQL + 真实 AUTH/业务服务；
 * 模型为测试进程内替身，0 真实 provider 请求）。
 *
 * 覆盖验收清单：
 * - 未批准写 0；伪造批准/越权/管理员教学拒绝；verifyRun 拒绝零提案；
 * - 重复执行只返回原回执；响应丢失后按原 operation 查询；
 * - 归属/版本/依据/附件变化拒绝且零部分写入；
 * - 回执或附件关联失败时业务同事务回滚；
 * - AI 等待期间撤会话/停用/转班，迟到结果被拒；
 * - 多幼儿分项：一个失败不重发另一个已保存项；
 * - 安全控件不泄露秘密，普通管理入口（教师创建/密码重置）仍可用；
 * - 原有保存、指南、账号与业务访问回归。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-tools-write-db.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { isoDateInShanghai } from '../../src/lib/format';
import { buildPrincipal } from '../../src/lib/accounts/repository';
import { computeCsrfToken, createSessionToken } from '../../src/lib/accounts/session';
import { setTeacherStatus } from '../../src/lib/accounts/repository';
import { NextRequest } from 'next/server';
import type { HeaderCarrier } from '../../src/lib/accounts/guards';
import type { invokeLlm, LlmResult } from '../../src/lib/llm';
import { withTransaction } from '../../src/storage/database/pg-client';
import { withPrivateRead, withPrivateWrite, yayaDataRepository } from '../../src/lib/yaya/data';
import { createYayaReadRegistry } from '../../src/lib/yaya/tools/read';
import { createYayaToolkit } from '../../src/lib/yaya/tools/write';
import type { YayaOperationProposal } from '../../src/lib/yaya/types';
import { startModelRequestGuard, modelGuardEnv } from '../harness-safety';
import { createAcceptanceSeed, type AcceptanceSeedHandle } from './acceptance/seed';

let passed = 0;
function check(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
}

interface SessionHandle {
  token: string;
  csrf: string;
}

interface ModelContextState {
  quote: string;
  review: 'accept' | 'clarify';
  guideInvalid: boolean;
  beforeReturn: (() => Promise<void>) | null;
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

function growthProfileFor(): Record<string, unknown> {
  return {
    summary: '已有多条确认观察，记录保留了具体行为与语言证据。',
    recent_change: '最近一次记录能看到主动参与的具体行为。',
    development_clues: ['能主动参与并完成选择'],
    next_support: '继续提供自由选择机会并记录具体行为。',
    next_focus: '下一次可以继续看看类似情境中的具体行为和语言。',
  };
}

function activitySupportFor(quote: string): Record<string, unknown> {
  const suggestion = {
    title: '滚球接力',
    purpose: '在游戏中练习动作协调与轮流等待。',
    steps: ['布置滚球路线', '两人一组轮流滚球'],
    materials: ['软球', '标志桶'],
    observe: '观察幼儿如何调整力度与等待顺序。',
    adaptation: '路线过长时缩短距离，鼓励合作完成。',
    evidence: [`健康: ${quote}`],
  };
  return { suggestions: [suggestion, { ...suggestion, title: '投掷小游戏' }] };
}

function createModelDouble(state: ModelContextState): typeof invokeLlm {
  return (async (_messages, options) => {
    if (state.beforeReturn) {
      const hook = state.beforeReturn;
      state.beforeReturn = null;
      await hook();
    }
    let payload: unknown;
    switch (options?.responseType) {
      case 'follow_up_decision':
        payload = { decision: 'proceed', question: '', reason: '已有足够信息整理。' };
        break;
      case 'observation_draft':
        payload = draftFor(state.quote);
        break;
      case 'teacher_edit_review':
        payload =
          state.review === 'accept'
            ? {
                decision: 'accept',
                summary: '修改内容有原文依据。',
                change_summary: ['调整了目标描述'],
                fact_check: 'supported',
                question: '',
              }
            : {
                decision: 'clarify',
                summary: '修改缺少依据。',
                change_summary: ['调整了目标描述'],
                fact_check: 'partially_supported',
                question: '请补充这条修改依据的具体行为。',
              };
        break;
      case 'growth_profile':
        payload = growthProfileFor();
        break;
      case 'activity_support':
        payload = activitySupportFor(state.quote);
        break;
      case 'guide_evidence_suggestion':
        payload = state.guideInvalid ? { nope: true } : { suggestions: [] };
        break;
      default:
        throw new Error(`unexpected model call: ${String(options?.responseType)}`);
    }
    return {
      content: JSON.stringify(payload),
      provider: 'stepfun',
      model: 'tools1-double',
      usage: undefined,
    } satisfies LlmResult;
  }) as typeof invokeLlm;
}

async function runDb(): Promise<number> {
  assert.equal(globalThis.__pgPool, undefined, 'tools-write db check must run in a fresh process');
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  process.env.AUTH_TRUSTED_ORIGINS = 'http://127.0.0.1:3000';

  let seed: AcceptanceSeedHandle | null = null;
  let sessionClient: Client | null = null;
  const cleanupIssues: string[] = [];
  let failure: unknown = null;

  try {
    seed = await createAcceptanceSeed();
    const manifest = seed.manifest;
    sessionClient = new Client({ connectionString: seed.database_url });
    await sessionClient.connect();
    const db = sessionClient;
    const today = isoDateInShanghai();

    const sessionFor = async (accountId: string): Promise<SessionHandle> => {
      const token = createSessionToken();
      await db.query(
        "INSERT INTO app_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [accountId, token.tokenHash],
      );
      return { token: token.token, csrf: computeCsrfToken(token.token) };
    };
    const carrier = (session: SessionHandle, requestId = 'tools1-check'): { headers: Headers } => ({
      headers: new Headers({
        cookie: `cga_session=${session.token}`,
        origin: 'http://127.0.0.1:3000',
        'x-csrf-token': session.csrf,
        'x-request-id': requestId,
      }),
    });

    const accountA = manifest.accounts.teacher_a;
    const accountB = manifest.accounts.teacher_b;
    const accountC = manifest.accounts.teacher_c;
    const admin = manifest.accounts.admin;
    const sessionA = await sessionFor(accountA.account_id);
    const sessionB = await sessionFor(accountB.account_id);
    const sessionC = await sessionFor(accountC.account_id);
    const sessionAdmin = await sessionFor(admin.account_id);

    const classIds = {
      a: manifest.classes.class_a.id,
      b: manifest.classes.class_b.id,
      c: manifest.classes.class_c.id,
    };
    const principalOf = (account: typeof accountA) =>
      buildPrincipal(
        {
          id: account.account_id,
          username: account.username,
          display_name: account.display_name,
          role: 'teacher',
          status: 'active',
          class_ids: account.current_class_keys.map(
            (key) =>
              manifest.classes[key as 'class_a' | 'class_b' | 'class_c' | 'class_fault'].id,
          ),
        },
        manifest.school_id,
      );
    const adminPrincipal = buildPrincipal(
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
    type PrincipalLike = ReturnType<typeof principalOf> | typeof adminPrincipal;
    const identityOf = (principal: PrincipalLike, runId: string) => ({
      run_id: runId,
      identity_state: 'authenticated' as const,
      session_valid: true,
      principal,
    });

    /* ---------------- SQL 断言与夹具 ---------------- */
    const count = async (sql: string, params: unknown[] = []): Promise<number> => {
      const result = await db.query<{ n: string }>(sql, params);
      return Number(result.rows[0]?.n ?? 0);
    };
    const proposalCount = () => count('SELECT count(*)::text AS n FROM yaya_proposals');
    const operationCountFor = (operationId: string) =>
      count('SELECT count(*)::text AS n FROM yaya_operations WHERE operation_id = $1 AND status IS NOT NULL', [operationId]);
    const observationsOf = (childId: string) =>
      count('SELECT count(*)::text AS n FROM observations WHERE child_id = $1', [childId]);
    const rawTextOf = async (observationId: string): Promise<string> => {
      const result = await db.query<{ raw_text: string }>('SELECT raw_text FROM observations WHERE id = $1', [observationId]);
      return result.rows[0]?.raw_text ?? '';
    };
    const approvalConsumed = async (approvalId: string): Promise<boolean> => {
      const result = await db.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM yaya_approvals WHERE id = $1', [approvalId]);
      return result.rows[0]?.consumed_at !== null && result.rows[0]?.consumed_at !== undefined;
    };
    const getObservationRow = async (observationId: string) =>
      (
        await db.query<{
          status: string;
          raw_text: string;
          ai_draft: unknown;
          confirmed_content: unknown;
          guide_evidence: unknown;
          agent_context: unknown;
          confirmed_at: Date | null;
          updated_at: Date;
        }>(
          'SELECT status, raw_text, ai_draft, confirmed_content, guide_evidence, agent_context, confirmed_at, updated_at FROM observations WHERE id = $1',
          [observationId],
        )
      ).rows[0];

    /* ---------------- 模型替身与工具工厂 ---------------- */
    const modelState: ModelContextState = {
      quote: '',
      review: 'accept',
      guideInvalid: false,
      beforeReturn: null,
    };
    const invoke = createModelDouble(modelState);
    let runSerial = 0;
    const nextRun = () => `tools1-run-${++runSerial}`;

    const toolkitFor = (
      session: SessionHandle,
      conversationId: string,
      extra: { verifyRun?: (input: { client: unknown; run_id: string }) => Promise<void> } = {},
    ) =>
      createYayaToolkit({
        request: carrier(session),
        resolveConversationId: async () => conversationId,
        invoke,
        ...extra,
      });

    const adminConversation = await withTransaction((client) =>
      yayaDataRepository.createConversation(client, {
        owner_account_id: admin.account_id,
        title: `tools1 admin ${manifest.seed_id}`,
      }),
    );
    const teacherCConversation = await withTransaction((client) =>
      yayaDataRepository.createConversation(client, {
        owner_account_id: accountC.account_id,
        title: `tools1 teacher c ${manifest.seed_id}`,
      }),
    );
    const toolkitA = toolkitFor(sessionA, manifest.conversations.teacher_a_scenario.conversation_id);
    const toolkitB = toolkitFor(sessionB, manifest.conversations.teacher_b_private.conversation_id);
    const toolkitC = toolkitFor(sessionC, teacherCConversation.conversation_id);
    const toolkitAdmin = toolkitFor(sessionAdmin, adminConversation.conversation_id);

    type ProposedWrite =
      | {
          ok: true;
          proposals: readonly YayaOperationProposal[];
          operationIds: string[];
          proposalId: string;
        }
      | { ok: false; code: string; message: string; proposals: []; operationIds: []; proposalId: null };
    const propose = async (
      runtime: ReturnType<typeof toolkitFor>,
      principal: PrincipalLike,
      tool: string,
      params: unknown,
    ): Promise<ProposedWrite> => {
      const runId = nextRun();
      const result = await runtime.toolkit.proposeWrite({
        run_id: runId,
        tool,
        params,
        identity: identityOf(principal, runId),
        proposal_origin: 'model_suggestion',
      });
      if (!result.ok) {
        return {
          ok: false,
          code: result.code,
          message: result.message,
          proposals: [],
          operationIds: [],
          proposalId: null,
        };
      }
      const proposalId = result.proposals[0].proposal_id;
      const rows = await db.query<{ operation_id: string }>(
        'SELECT operation_id FROM yaya_proposal_items WHERE proposal_id = $1 ORDER BY item_key',
        [proposalId],
      );
      return {
        ok: true,
        proposals: result.proposals,
        operationIds: rows.rows.map((row) => row.operation_id),
        proposalId,
      };
    };

    const approve = async (session: SessionHandle, proposalId: string, operationIds: readonly string[]) =>
      withPrivateWrite(carrier(session), ({ client, principal, sessionId, schoolId }) =>
        yayaDataRepository.recordApproval(client, {
          proposal_id: proposalId,
          operation_ids: operationIds,
          principal,
          session_id: sessionId,
          school_id: schoolId,
          execution_at: new Date().toISOString(),
        }),
      );

    const execute = (session: SessionHandle, approvalId: string, operationIds: readonly string[], body?: unknown) =>
      toolkitFor(session, manifest.conversations.teacher_a_scenario.conversation_id).executeOperations(
        carrier(session),
        body ?? { approval_id: approvalId, operation_ids: operationIds },
      );

    /** 提议 → 批准 → 执行 的标准闭环 */
    const runWrite = async (
      runtime: ReturnType<typeof toolkitFor>,
      session: SessionHandle,
      principal: PrincipalLike,
      tool: string,
      params: unknown,
    ) => {
      const proposed = await propose(runtime, principal, tool, params);
      assert.ok(proposed.ok, `propose ${tool} should succeed`);
      const proposal = proposed.proposals[0];
      const operationIds = proposed.operationIds;
      const approval = await approve(session, proposal.proposal_id, operationIds);
      const result = await execute(session, approval.approval.approval_id, operationIds);
      return { proposal, approval: approval.approval, result };
    };

    assert.equal(
      await count('SELECT count(*)::text AS n FROM yaya_operations', []),
      1,
      'seed only has the fault receipt operation',
    );

    /* ============ A. 真实表：admin 建档 / 工具链闭环 ============ */
    const childX = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'create_child', {
      name: `合成幼儿X·${manifest.seed_id}`,
      gender: '女',
      birth_date: '2022-03-01',
      target_class_id: classIds.a,
      note: 'tools1 验收',
    });
    const childXId = childX.result.kind === 'receipts' ? (childX.result.receipts[0].business_object_id ?? '') : '';
    check(!!childXId, 'admin create_child commits a business object id');
    check(childX.result.kind === 'receipts' && childX.result.receipts[0].status === 'saved', 'admin create_child receipt saved');

    const childY = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'create_child', {
      name: `合成幼儿Y·${manifest.seed_id}`,
      gender: '男',
      birth_date: '2022-05-01',
      target_class_id: classIds.a,
      note: 'tools1 验收',
    });
    const childYId = childY.result.kind === 'receipts' ? (childY.result.receipts[0].business_object_id ?? '') : '';
    check(!!childYId, 'second child for split-batch checks exists');

    const rawX = `[合成] 王一诺在积木区自己搭好三块积木，向同伴介绍自己的作品。${manifest.seed_id}`;
    const createX = await propose(toolkitA, principalOf(accountA), 'create_observation', {
      child_id: childXId,
      observed_at: today,
      raw_text: rawX,
      image_ids: [],
    });
    check(createX.ok, 'teacher_a can prepare create_observation for their class child');
    if (!createX.ok) throw new Error('create_observation prepare failed');
    const proposalX = createX.proposals[0];
    const operationX = createX.operationIds[0];
    check(proposalX.proposal_origin === 'model_suggestion', 'proposal keeps model origin');
    check(proposalX.items[0].content_digest.length === 64, 'proposal item carries a server-computed digest');

    const beforeUnapproved = await observationsOf(childXId);
    let unapprovedRejected = false;
    try {
      await execute(sessionA, '00000000-0000-4000-8000-000000000000', [operationX]);
    } catch (error) {
      unapprovedRejected = true;
      check((error as { code?: string }).code === 'approval_invalid', 'unapproved execution is rejected as approval_invalid');
    }
    check(unapprovedRejected, 'execution without a real approval throws');
    check((await observationsOf(childXId)) === beforeUnapproved, 'unapproved execution writes zero business rows');

    let forgedRejected = false;
    try {
      const approvalX = await approve(sessionA, proposalX.proposal_id, [operationX]);
      await toolkitFor(sessionA, manifest.conversations.teacher_a_scenario.conversation_id).executeOperations(
        carrier(sessionA),
        { approval_id: approvalX.approval.approval_id, operation_ids: [operationX], approved: true },
      );
    } catch (error) {
      forgedRejected = true;
      check((error as { code?: string }).code === 'invalid_request', 'forged approved field is rejected before execution');
    }
    check(forgedRejected, 'forged authority fields never reach business execution');

    const approvalX = (await withPrivateRead(carrier(sessionA), ({ client, principal }) =>
      yayaDataRepository.getApproval(client, principal.account_id, proposalX.proposal_id),
    ))!;
    const executedX = await execute(sessionA, approvalX.approval_id, [operationX]);
    check(executedX.kind === 'receipts', 'approved execution returns receipts');
    const receiptX = executedX.kind === 'receipts' ? executedX.receipts[0] : null;
    check(!!receiptX && receiptX.status === 'saved' && receiptX.effect === 'committed', 'create_observation receipt proves success');
    const observationXId = receiptX?.business_object_id ?? '';
    check((await observationsOf(childXId)) === beforeUnapproved + 1, 'approved execution writes exactly one observation');
    check((await rawTextOf(observationXId)) === rawX, 'raw_text is stored verbatim');

    const replayX = await execute(sessionA, approvalX.approval_id, [operationX]);
    check(
      replayX.kind === 'receipts' && JSON.stringify(replayX.receipts[0]) === JSON.stringify(receiptX),
      'repeated execution returns the original receipt (idempotent replay)',
    );
    check((await observationsOf(childXId)) === beforeUnapproved + 1, 'repeated execution writes no duplicate row');
    check((await operationCountFor(operationX)) === 1, 'operation ledger keeps a single receipt row');

    const queriedX = await withPrivateRead(carrier(sessionA), ({ client, principal }) =>
      yayaDataRepository.queryOperation(client, principal.account_id, operationX),
    );
    check(queriedX?.outcome.kind === 'saved', 'lost response can be recovered by querying the original operation');

    /* ============ B. 授权负例 ============ */
    const proposalsBeforeNegatives = await proposalCount();
    const crossScope = await propose(toolkitB, principalOf(accountB), 'create_observation', {
      child_id: childXId,
      observed_at: today,
      raw_text: rawX,
    });
    check(!crossScope.ok && crossScope.code === 'out_of_scope', 'teacher_b cannot prepare writes for class_a child');
    const adminTeaching = await propose(toolkitAdmin, adminPrincipal, 'confirm_observation', {
      observation_id: manifest.observations.b5_ai_organized.id,
      input: { content: draftFor('分类') },
    });
    check(
      !adminTeaching.ok && adminTeaching.code === 'forbidden_role',
      'admin cannot prepare teaching writes through the assistant',
    );
    const emptyScope = await propose(toolkitC, principalOf(accountC), 'organize_observation', {
      observation_id: manifest.observations.b3_draft.id,
    });
    check(!emptyScope.ok && emptyScope.code === 'empty_scope', 'unassigned teacher gets empty_scope, not an empty write');
    check((await proposalCount()) === proposalsBeforeNegatives, 'rejected proposals write zero proposal rows');

    let verifyRunCalls = 0;
    const toolkitVerify = toolkitFor(sessionA, manifest.conversations.teacher_a_scenario.conversation_id, {
      verifyRun: async () => {
        verifyRunCalls += 1;
        throw new Error('run invalid');
      },
    });
    const verifyProposalsBefore = await proposalCount();
    const verifyFailed = await propose(toolkitVerify, principalOf(accountA), 'organize_observation', {
      observation_id: manifest.observations.b3_draft.id,
    });
    check(!verifyFailed.ok && verifyFailed.code === 'failed', 'injected run verification failure fails the proposal');
    check(verifyRunCalls === 1, 'run verification runs inside the prepare transaction');
    check((await proposalCount()) === verifyProposalsBefore, 'failed run verification writes zero proposals');

    /* ============ C. AI 等待期间事实变化：换会话 / 停用 / 转班 ============ */
    const organizeX1 = await propose(toolkitA, principalOf(accountA), 'organize_observation', {
      observation_id: observationXId,
    });
    check(organizeX1.ok, 'organize_observation prepared');
    if (!organizeX1.ok) throw new Error('organize prepare failed');
    const opOrganizeX1 = organizeX1.operationIds[0];
    const approvalOrganizeX1 = await approve(sessionA, organizeX1.proposals[0].proposal_id, [opOrganizeX1]);
    modelState.quote = '自己搭好三块积木';
    modelState.beforeReturn = async () => {
      const { hashSessionToken } = await import('../../src/lib/accounts/session');
      await db.query('UPDATE app_sessions SET revoked_at = now() WHERE token_hash = $1', [
        hashSessionToken(sessionA.token),
      ]);
    };
    let revokedRejected = false;
    try {
      await execute(sessionA, approvalOrganizeX1.approval.approval_id, [opOrganizeX1]);
    } catch (error) {
      revokedRejected = true;
      check(
        (error as { code?: string }).code === 'approval_invalid' || (error as { code?: string }).code === 'unauthenticated',
        'revoked session during model wait is rejected',
      );
    }
    check(revokedRejected, 'late result after session revocation cannot write');
    const observationXAfterRevoke = await getObservationRow(observationXId);
    check(observationXAfterRevoke.status === 'draft' && observationXAfterRevoke.ai_draft === null, 'revoked-session organize writes zero business changes');
    check((await proposalCount()) > 0, 'no proposal rows were silently dropped');
    check(!(await approvalConsumed(approvalOrganizeX1.approval.approval_id)), 'rejected execution does not consume the approval');

    const sessionA2 = await sessionFor(accountA.account_id);
    const toolkitA2 = toolkitFor(sessionA2, manifest.conversations.teacher_a_scenario.conversation_id);
    modelState.beforeReturn = null;
    const organizeX2 = await propose(toolkitA2, principalOf(accountA), 'organize_observation', {
      observation_id: observationXId,
    });
    check(organizeX2.ok, 're-propose after revocation succeeds with a fresh session');
    if (!organizeX2.ok) throw new Error('re-propose failed');
    const opOrganizeX2 = organizeX2.operationIds[0];
    const approvalOrganizeX2 = await approve(sessionA2, organizeX2.proposals[0].proposal_id, [opOrganizeX2]);
    modelState.quote = '自己搭好三块积木';
    const organizedX = await execute(sessionA2, approvalOrganizeX2.approval.approval_id, [opOrganizeX2]);
    check(organizedX.kind === 'receipts' && organizedX.receipts[0].status === 'saved', 'fresh approval organizes the observation');
    const observationXOrganized = await getObservationRow(observationXId);
    check(observationXOrganized.status === 'ai_organized' && observationXOrganized.ai_draft !== null, 'organize writes ai_draft in the business transaction');

    /* 停用教师：b3_draft 组织等待期间停用 teacher_a */
    const b3 = manifest.observations.b3_draft;
    const organizeB3 = await propose(toolkitA2, principalOf(accountA), 'organize_observation', {
      observation_id: b3.id,
    });
    check(organizeB3.ok, 'organize b3 prepared');
    if (!organizeB3.ok) throw new Error('organize b3 prepare failed');
    const opOrganizeB3 = organizeB3.operationIds[0];
    const approvalB3 = await approve(sessionA2, organizeB3.proposals[0].proposal_id, [opOrganizeB3]);
    modelState.quote = '长积木横着放';
    let disableHookRan = false;
    modelState.beforeReturn = async () => {
      disableHookRan = true;
      await db.query("UPDATE app_accounts SET status = 'disabled' WHERE id = $1", [accountA.account_id]);
    };
    let disabledRejected = false;
    try {
      await execute(sessionA2, approvalB3.approval.approval_id, [opOrganizeB3]);
    } catch (error) {
      disabledRejected = true;
      const code = (error as { code?: string }).code;
      // 停用账号的会话按失效处理（401 unauthenticated）；不允许迟到结果落库。
      check(
        code === 'account_disabled' || code === 'approval_invalid' || code === 'unauthenticated',
        `disabled teacher during model wait is rejected (got ${String(code)})`,
      );
    }
    check(disableHookRan, 'disable hook ran during the model wait');
    check(disabledRejected, 'disabled teacher cannot commit a waiting result');
    check((await getObservationRow(b3.id)).status === 'draft', 'disabled-teacher organize writes zero business changes');
    modelState.beforeReturn = null;
    await db.query("UPDATE app_accounts SET status = 'active' WHERE id = $1", [accountA.account_id]);

    /* 转班：childY 的观察在模型等待期间被转出当前班级（teacher_a 仍教两班） */
    const rawY = `[合成] 幼儿Y在户外活动时主动邀请同伴一起滚球。${manifest.seed_id}`;
    const createYProposal = await propose(toolkitA2, principalOf(accountA), 'create_observation', {
      child_id: childYId,
      observed_at: today,
      raw_text: rawY,
    });
    check(createYProposal.ok, 'prepare create_observation for childY');
    if (!createYProposal.ok) throw new Error('create Y failed');
    const opCreateY = createYProposal.operationIds[0];
    const approvalCreateY = await approve(sessionA2, createYProposal.proposals[0].proposal_id, [opCreateY]);
    const executedY = await execute(sessionA2, approvalCreateY.approval.approval_id, [opCreateY]);
    const observationYId = executedY.kind === 'receipts' ? executedY.receipts[0].business_object_id ?? '' : '';
    check(executedY.kind === 'receipts' && !!observationYId, 'childY observation created');

    const organizeY = await propose(toolkitA2, principalOf(accountA), 'organize_observation', {
      observation_id: observationYId,
    });
    check(organizeY.ok, 'organize childY prepared');
    if (!organizeY.ok) throw new Error('organize Y prepare failed');
    const opOrganizeY = organizeY.operationIds[0];
    const approvalOrganizeY = await approve(sessionA2, organizeY.proposals[0].proposal_id, [opOrganizeY]);
    modelState.quote = '主动邀请同伴一起滚球';
    let transferHookError: unknown = null;
    modelState.beforeReturn = async () => {
      try {
        await db.query(
          'UPDATE child_class_enrollments SET end_date = start_date WHERE child_id = $1 AND end_date IS NULL',
          [childYId],
        );
        await db.query(
          'INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1, $2, $3::date)',
          [childYId, classIds.b, today],
        );
        await db.query('UPDATE children SET class_name = (SELECT name FROM classes WHERE id = $2) WHERE id = $1', [
          childYId,
          classIds.b,
        ]);
      } catch (error) {
        transferHookError = error;
      }
    };
    let transferRejected = false;
    try {
      await execute(sessionA2, approvalOrganizeY.approval.approval_id, [opOrganizeY]);
    } catch (error) {
      transferRejected = true;
      check((error as { code?: string }).code === 'approval_invalid', 'transferred child during model wait is rejected');
    }
    check(transferHookError === null, 'transfer hook applied without error');
    check(transferRejected, 'attribution change during model wait cannot commit');
    check((await getObservationRow(observationYId)).status === 'draft', 'transfer-during-wait writes zero business changes');
    // 转回松果班，供后续分项与附件用例使用
    await db.query(
      'UPDATE child_class_enrollments SET end_date = start_date WHERE child_id = $1 AND end_date IS NULL',
      [childYId],
    );
    await db.query(
      'INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1, $2, $3::date)',
      [childYId, classIds.a, today],
    );
    await db.query('UPDATE children SET class_name = (SELECT name FROM classes WHERE id = $2) WHERE id = $1', [
      childYId,
      classIds.a,
    ]);

    /* ============ D. 版本变化 + 教师修改复核 + 确认归档 ============ */
    // 版本变化：先批准确认，再直接改动 ai_draft，执行必须拒绝
    const confirmXPayload = {
      observation_id: observationXId,
      input: {
        content: draftFor('自己搭好三块积木'),
        teacher_note: '教师补充',
      },
    };
    const confirmX1 = await propose(toolkitA2, principalOf(accountA), 'confirm_observation', confirmXPayload);
    check(confirmX1.ok, 'confirm_observation prepared');
    if (!confirmX1.ok) throw new Error('confirm prepare failed');
    const opConfirmX = confirmX1.operationIds[0];
    const approvalConfirmX = await approve(sessionA2, confirmX1.proposals[0].proposal_id, [opConfirmX]);
    // 仅推进行版本（不改内容）：版本前提变化必须在批准执行边界被拒
    await db.query('UPDATE observations SET updated_at = now() WHERE id = $1', [observationXId]);
    let versionRejected = false;
    try {
      await execute(sessionA2, approvalConfirmX.approval.approval_id, [opConfirmX]);
    } catch (error) {
      versionRejected = true;
      const details = (error as { details?: { reasons?: string[] } }).details;
      check(
        (error as { code?: string }).code === 'approval_invalid' &&
          Boolean(details?.reasons?.includes('business_version_changed')),
        'concurrent observation change refuses the stale approval',
      );
    }
    check(versionRejected, 'version change rejects the approval');
    const observationXVersioned = await getObservationRow(observationXId);
    check(observationXVersioned.confirmed_content === null, 'version-changed confirm writes zero confirmed content');
    check(!(await approvalConsumed(approvalConfirmX.approval.approval_id)), 'version-changed approval stays unconsumed');


    // 教师修改：模型复核 accept → 第一次执行停在准备态并保存复核；第二次执行归档
    const editedDraft = draftFor('自己搭好三块积木');
    editedDraft.objective_description = '能自己搭好并介绍作品，表达清晰。';
    const confirmEdited = await propose(toolkitA2, principalOf(accountA), 'confirm_observation', {
      observation_id: observationXId,
      input: { content: editedDraft, teacher_note: '教师调整了目标描述' },
    });
    check(confirmEdited.ok, 'edited confirm prepared');
    if (!confirmEdited.ok) throw new Error('edited confirm prepare failed');
    const opConfirmEdited = confirmEdited.operationIds[0];
    const approvalConfirmedEdited = await approve(sessionA2, confirmEdited.proposals[0].proposal_id, [opConfirmEdited]);
    modelState.review = 'accept';
    const needsReview = await execute(sessionA2, approvalConfirmedEdited.approval.approval_id, [opConfirmEdited]);
    check(needsReview.kind === 'needs_prepare', 'teacher edit first stops at prepare state with agent review');
    if (needsReview.kind === 'needs_prepare') {
      check((needsReview.notice as { requires_agent_confirmation?: boolean })?.requires_agent_confirmation === true, 'prepare notice requires agent confirmation');
    }
    const observationXReviewed = await getObservationRow(observationXId);
    check(observationXReviewed.confirmed_content === null, 'first teacher-edit execution does not archive');
    check(observationXReviewed.status === 'ai_organized', 'review state keeps the record unarchived');
    const reviewRow = (await db.query<{ agent_context: { teacher_edit_review?: { decision?: string } } }>(
      'SELECT agent_context FROM observations WHERE id = $1',
      [observationXId],
    )).rows[0];
    check(reviewRow?.agent_context?.teacher_edit_review?.decision === 'accept', 'review result is saved as prepare state');
    check(!(await approvalConsumed(approvalConfirmedEdited.approval.approval_id)), 'needs_prepare does not consume the approval');
    // 准备态写入改变了业务版本：旧批准按契约失效，教师对同一提案重新批准后再执行
    let staleApprovalRejected = false;
    try {
      await execute(sessionA2, approvalConfirmedEdited.approval.approval_id, [opConfirmEdited]);
    } catch (error) {
      staleApprovalRejected = true;
      const details = (error as { details?: { reasons?: string[] } }).details;
      check(
        (error as { code?: string }).code === 'approval_invalid' &&
          Boolean(details?.reasons?.includes('business_version_changed')),
        'prepare-state write invalidates the old approval snapshot',
      );
    }
    check(staleApprovalRejected, 'old approval cannot archive after prepare-state changes');
    // 同一已批准操作不重批（DATA 语义）：重新准备一份提案，匹配复核后归档
    const confirmEdited2 = await propose(toolkitA2, principalOf(accountA), 'confirm_observation', {
      observation_id: observationXId,
      input: { content: editedDraft, teacher_note: '教师调整了目标描述' },
    });
    check(confirmEdited2.ok, 're-propose after review prepare succeeds');
    if (!confirmEdited2.ok) throw new Error('re-propose failed');
    const opConfirmEdited2 = confirmEdited2.operationIds[0];
    const approvalConfirmedEdited2 = await approve(sessionA2, confirmEdited2.proposals[0].proposal_id, [
      opConfirmEdited2,
    ]);
    const confirmedEdited = await execute(sessionA2, approvalConfirmedEdited2.approval.approval_id, [
      opConfirmEdited2,
    ]);
    check(confirmedEdited.kind === 'receipts' && confirmedEdited.receipts[0].status === 'saved', 'second execution archives after matching review');
    const observationXConfirmed = await getObservationRow(observationXId);
    check(observationXConfirmed.status === 'confirmed' && observationXConfirmed.confirmed_content !== null, 'confirm writes confirmed_content');
    check(observationXConfirmed.raw_text === rawX, 'confirm never rewrites raw_text');
    check(await approvalConsumed(approvalConfirmedEdited2.approval.approval_id), 'successful execution consumes the approval');

    // 同宿主原子性：b5_ai_organized 的确认 + 失败指南决定必须整单回滚
    const b5 = manifest.observations.b5_ai_organized;
    const b5Row = await getObservationRow(b5.id);
    const b5Draft = b5Row.ai_draft as { highlight_quote?: string };
    const b5Before = JSON.stringify(b5Row.guide_evidence ?? null);
    const confirmB5 = await propose(toolkitA2, principalOf(accountA), 'confirm_observation', {
      observation_id: b5.id,
      input: {
        content: { ...(b5Row.ai_draft as Record<string, unknown>) },
        guide_decisions: {
          expected_guide_revision: 0,
          decisions: [
            {
              link_id: 'missing-link',
              support: 'single_event',
              basis: [{ observation_id: b5.id, quote: b5Draft.highlight_quote ?? '', quote_source: 'raw_text' }],
            },
          ],
        },
      },
    });
    check(confirmB5.ok, 'confirm with guide decisions prepared');
    if (!confirmB5.ok) throw new Error('confirm b5 prepare failed');
    const opConfirmB5 = confirmB5.operationIds[0];
    const approvalConfirmB5 = await approve(sessionA2, confirmB5.proposals[0].proposal_id, [opConfirmB5]);
    let atomicRejected = false;
    try {
      await execute(sessionA2, approvalConfirmB5.approval.approval_id, [opConfirmB5]);
    } catch (error) {
      atomicRejected = true;
      check((error as { code?: string }).code !== undefined, 'failed guide decision surfaces a frozen error code');
    }
    check(atomicRejected, 'failed guide decision rejects the confirm');
    const b5After = await getObservationRow(b5.id);
    check(b5After.status === 'ai_organized' && b5After.confirmed_content === null, 'same-host atomicity: observation not archived');
    check(JSON.stringify(b5After.guide_evidence ?? null) === b5Before, 'same-host atomicity: guide evidence unchanged');
    check(!(await approvalConsumed(approvalConfirmB5.approval.approval_id)), 'rolled-back confirm keeps approval unconsumed');

    /* ============ E. 追问（回答/跳过/停止） ============ */
    const b4 = manifest.observations.b4_needs_input;
    const b4Raw = await rawTextOf(b4.id);
    const followUp = await propose(toolkitA2, principalOf(accountA), 'follow_up_observation', {
      observation_id: b4.id,
      action: 'answer',
      content: '她和一个同伴一起站着看画。',
    });
    check(followUp.ok, 'follow-up prepared');
    if (!followUp.ok) throw new Error('follow-up prepare failed');
    const opFollowUp = followUp.operationIds[0];
    const approvalFollowUp = await approve(sessionA2, followUp.proposals[0].proposal_id, [opFollowUp]);
    modelState.quote = b4Raw.includes('站着看同伴画画') ? '站着看同伴画画' : b4Raw.slice(5, 15);
    const followUpDone = await execute(sessionA2, approvalFollowUp.approval.approval_id, [opFollowUp]);
    check(followUpDone.kind === 'receipts' && followUpDone.receipts[0].status === 'saved', 'follow-up execution saves answer + re-organize in one transaction');
    const b4After = (await db.query<{ status: string; agent_context: { follow_up?: { answers?: unknown[] } } }>(
      'SELECT status, agent_context FROM observations WHERE id = $1',
      [b4.id],
    )).rows[0];
    check(b4After?.status === 'ai_organized', 'follow-up ends in ai_organized');
    check((b4After?.agent_context?.follow_up?.answers?.length ?? 0) >= 1, 'follow-up answer is persisted');

    /* ============ F. 附件：创建附图 / 归档追加 / 版本与所有权拒绝 ============ */
    const readyAttachment = async (ownerId: string, label: string): Promise<string> => {
      const attachmentId = randomUUID();
      await withTransaction(async (client) => {
        await yayaDataRepository.insertPendingAttachment(client, {
          attachment_id: attachmentId,
          owner_account_id: ownerId,
          status: 'pending',
          revision: 0,
          object_key: `tools1/${manifest.seed_id}/${label}.png`,
          thumbnail_key: `tools1/${manifest.seed_id}/${label}-thumb.png`,
          model_key: `tools1/${manifest.seed_id}/${label}-model.png`,
          content_type: 'image/png',
          byte_size: 128,
          checksum_sha256: 'a'.repeat(64),
          thumbnail_checksum: 'b'.repeat(64),
          model_checksum: 'c'.repeat(64),
          source_checksum: 'd'.repeat(64),
          width: 8,
          height: 8,
          client_upload_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleting_started_at: null,
          deleted_at: null,
          deletion_lease_id: null,
        });
        await yayaDataRepository.markAttachmentReady(client, attachmentId);
      });
      return attachmentId;
    };
    const ownImage = await readyAttachment(accountA.account_id, 'own');
    const foreignImage = await readyAttachment(accountB.account_id, 'foreign');

    // 创建观察 + 附图（同一事务）
    const createWithImage = await propose(toolkitA2, principalOf(accountA), 'create_observation', {
      child_id: childXId,
      observed_at: today,
      raw_text: `[合成] 幼儿X用红色积木搭桥并留出通道。${manifest.seed_id}`,
      image_ids: [ownImage],
    });
    check(createWithImage.ok, 'create_observation with images prepared');
    if (!createWithImage.ok) throw new Error('create with image prepare failed');
    const opCreateWithImage = createWithImage.operationIds[0];
    const approvalCreateWithImage = await approve(sessionA2, createWithImage.proposals[0].proposal_id, [opCreateWithImage]);
    const createdWithImage = await execute(sessionA2, approvalCreateWithImage.approval.approval_id, [opCreateWithImage]);
    const observationWithImageId =
      createdWithImage.kind === 'receipts' ? createdWithImage.receipts[0].business_object_id ?? '' : '';
    check(createdWithImage.kind === 'receipts' && !!observationWithImageId, 'observation with image committed');
    check(
      (await count('SELECT count(*)::text AS n FROM yaya_attachment_refs WHERE attachment_id = $1 AND record_kind = $2 AND record_id = $3', [
        ownImage,
        'observation',
        observationWithImageId,
      ])) === 1,
      'create_observation links the image in the same transaction',
    );

    // 归档追加：a3_empty confirmed，无附件
    const a3 = manifest.observations.a3_empty;
    const a3Row = await getObservationRow(a3.id);
    const revisionA3Before = await withTransaction((client) =>
      yayaDataRepository.getObservationAttachmentRevisionNumber(client, a3.id),
    );
    const attachA3 = await propose(toolkitA2, principalOf(accountA), 'attach_observation_images', {
      observation_id: a3.id,
      image_ids: [ownImage],
      expected_attachment_revision: revisionA3Before,
      source_confirmed_at: a3Row.confirmed_at ? new Date(a3Row.confirmed_at as unknown as string).toISOString() : null,
    });
    check(attachA3.ok, 'attach_observation_images prepared');
    if (!attachA3.ok) throw new Error('attach prepare failed');
    const opAttachA3 = attachA3.operationIds[0];
    const approvalAttachA3 = await approve(sessionA2, attachA3.proposals[0].proposal_id, [opAttachA3]);
    const attachedA3 = await execute(sessionA2, approvalAttachA3.approval.approval_id, [opAttachA3]);
    check(attachedA3.kind === 'receipts' && attachedA3.receipts[0].status === 'saved', 'archive append commits');
    const revisionA3After = await withTransaction((client) =>
      yayaDataRepository.getObservationAttachmentRevisionNumber(client, a3.id),
    );
    check(revisionA3After === revisionA3Before + 1, 'archive append increments the attachment revision');

    // 附件变化：过期 revision 拒绝，零新增引用
    const refsBeforeStale = await count('SELECT count(*)::text AS n FROM yaya_attachment_refs WHERE record_id = $1', [a3.id]);
    const staleAttach = await propose(toolkitA2, principalOf(accountA), 'attach_observation_images', {
      observation_id: a3.id,
      image_ids: [ownImage],
      expected_attachment_revision: revisionA3Before,
      source_confirmed_at: a3Row.confirmed_at ? new Date(a3Row.confirmed_at as unknown as string).toISOString() : null,
    });
    check(staleAttach.ok, 'stale attach still prepares (version checked at execution)');
    if (!staleAttach.ok) throw new Error('stale attach prepare failed');
    const opStaleAttach = staleAttach.operationIds[0];
    const approvalStaleAttach = await approve(sessionA2, staleAttach.proposals[0].proposal_id, [opStaleAttach]);
    let staleAttachRejected = false;
    try {
      await execute(sessionA2, approvalStaleAttach.approval.approval_id, [opStaleAttach]);
    } catch (error) {
      staleAttachRejected = true;
      check((error as { code?: string }).code === 'revision_conflict', 'stale attachment revision is rejected');
    }
    check(staleAttachRejected, 'stale attachment append fails');
    check(
      (await count('SELECT count(*)::text AS n FROM yaya_attachment_refs WHERE record_id = $1', [a3.id])) === refsBeforeStale,
      'stale attachment append writes zero new references',
    );

    // 附件所有权：teacherA 关联 teacherB 的图片 → 准备阶段即拒绝（零提案、零引用）
    const proposalsBeforeForeign = await proposalCount();
    const foreignAttach = await propose(toolkitA2, principalOf(accountA), 'attach_observation_images', {
      observation_id: a3.id,
      image_ids: [foreignImage],
      expected_attachment_revision: revisionA3After,
      source_confirmed_at: a3Row.confirmed_at ? new Date(a3Row.confirmed_at as unknown as string).toISOString() : null,
    });
    check(!foreignAttach.ok, 'foreign-owned image cannot prepare an attachment proposal');
    check((await proposalCount()) === proposalsBeforeForeign, 'foreign-owned attachment writes zero proposals');
    check(
      (await withTransaction((client) => yayaDataRepository.getObservationAttachmentRevisionNumber(client, a3.id))) ===
        revisionA3After,
      'foreign-owned attachment leaves the business revision unchanged',
    );

    // 附件删除后执行：准备就绪的图片在批准后被回收 → 执行失败且业务同事务零变化
    const deletedImage = await readyAttachment(accountA.account_id, 'deleted-before-execute');
    const attachDeleted = await propose(toolkitA2, principalOf(accountA), 'attach_observation_images', {
      observation_id: a3.id,
      image_ids: [deletedImage],
      expected_attachment_revision: revisionA3After,
      source_confirmed_at: a3Row.confirmed_at ? new Date(a3Row.confirmed_at as unknown as string).toISOString() : null,
    });
    check(attachDeleted.ok, 'attachment proposal prepared before the image is recycled');
    if (!attachDeleted.ok) throw new Error('deleted-image attach prepare failed');
    const opDeletedAttach = attachDeleted.operationIds[0];
    const approvalDeletedAttach = await approve(sessionA2, attachDeleted.proposals[0].proposal_id, [
      opDeletedAttach,
    ]);
    await db.query("UPDATE yaya_attachments SET status = 'deleted', deleted_at = now() WHERE id = $1", [deletedImage]);
    let deletedAttachRejected = false;
    try {
      await execute(sessionA2, approvalDeletedAttach.approval.approval_id, [opDeletedAttach]);
    } catch (error) {
      deletedAttachRejected = true;
      const code = (error as { code?: string }).code;
      check(
        code === 'attachment_conflict' || code === 'attachment_missing',
        `recycled attachment fails at execution (got ${String(code)})`,
      );
    }
    check(deletedAttachRejected, 'attachment recycled after approval rejects the execution');
    check(
      (await withTransaction((client) => yayaDataRepository.getObservationAttachmentRevisionNumber(client, a3.id))) ===
        revisionA3After,
      'failed attachment execution rolls back the business transaction',
    );
    check(
      !(await approvalConsumed(approvalDeletedAttach.approval.approval_id)),
      'failed attachment execution keeps approval unconsumed',
    );

    /* ============ G. 依据集变化：成长小结 / 活动支持 ============ */
    const growthBefore = await count('SELECT count(*)::text AS n FROM children WHERE id = $1 AND growth_profile IS NULL', [childXId]);
    const growthProposal = await propose(toolkitA2, principalOf(accountA), 'refresh_growth_profile', {
      child_id: childXId,
    });
    check(growthProposal.ok, 'refresh_growth_profile prepared');
    if (!growthProposal.ok) throw new Error('growth prepare failed');
    const opGrowth = growthProposal.operationIds[0];
    const approvalGrowth = await approve(sessionA2, growthProposal.proposals[0].proposal_id, [opGrowth]);
    // 模型等待期间新增一条已确认观察 → 依据集变化（生成快照与保存时不一致）
    let growthBasisHookRan = false;
    modelState.beforeReturn = async () => {
      growthBasisHookRan = true;
      await db.query(
        `INSERT INTO observations (id, child_id, class_id, observed_at, raw_text, status, confirmed_content, confirmed_at)
         VALUES ($1, $2, $3, $4::date, $5, 'confirmed', $6::jsonb, now())`,
        [
          randomUUID(),
          childXId,
          classIds.a,
          today,
          `[合成] 依据集变化夹具观察。${manifest.seed_id}`,
          JSON.stringify(draftFor('依据集变化夹具')),
        ],
      );
    };
    let staleEvidenceRejected = false;
    try {
      await execute(sessionA2, approvalGrowth.approval.approval_id, [opGrowth]);
    } catch (error) {
      staleEvidenceRejected = true;
      check((error as { code?: string }).code === 'approval_invalid', 'stale evidence refuses the growth profile write');
    }
    modelState.beforeReturn = null;
    check(growthBasisHookRan, 'evidence-set hook ran during the model wait');
    check(staleEvidenceRejected, 'evidence-set change rejects the growth profile approval');
    check(
      (await count('SELECT count(*)::text AS n FROM children WHERE id = $1 AND growth_profile IS NULL', [childXId])) === growthBefore,
      'stale growth profile writes zero changes',
    );

    const activityProposal = await propose(toolkitA2, principalOf(accountA), 'refresh_activity_support', {
      child_id: childXId,
    });
    check(activityProposal.ok, 'refresh_activity_support prepared');
    if (!activityProposal.ok) throw new Error('activity prepare failed');
    const opActivity = activityProposal.operationIds[0];
    const approvalActivity = await approve(sessionA2, activityProposal.proposals[0].proposal_id, [opActivity]);
    modelState.quote = '自己搭好三块积木';
    const activityDone = await execute(sessionA2, approvalActivity.approval.approval_id, [opActivity]);
    check(activityDone.kind === 'receipts' && activityDone.receipts[0].status === 'saved', 'activity support commits with confirmed evidence');
    const childXProfile = (await db.query<{ growth_profile: { activity_support?: unknown } }>(
      'SELECT growth_profile FROM children WHERE id = $1',
      [childXId],
    )).rows[0];
    check(childXProfile?.growth_profile?.activity_support !== undefined, 'activity support is stored under growth_profile.activity_support');

    /* ============ H. 指南证据：建议失败落账 / 拒绝决定 ============ */
    const a2 = manifest.observations.a2_photo;
    const a2GuideBefore = (await db.query<{ guide_evidence: { revision?: number } | null }>(
      'SELECT guide_evidence FROM observations WHERE id = $1',
      [a2.id],
    )).rows[0];
    const revisionBeforeSuggest = a2GuideBefore?.guide_evidence?.revision ?? 0;
    const suggestProposal = await propose(toolkitA2, principalOf(accountA), 'guide_decision', {
      observation_id: a2.id,
      mutation: { action: 'suggest' },
    });
    check(suggestProposal.ok, 'guide suggest prepared');
    if (!suggestProposal.ok) throw new Error('suggest prepare failed');
    const opSuggest = suggestProposal.operationIds[0];
    const approvalSuggest = await approve(sessionA2, suggestProposal.proposals[0].proposal_id, [opSuggest]);
    modelState.guideInvalid = true; // 两次模型输出都不合法 → last_attempt{ok:false}
    const suggestDone = await execute(sessionA2, approvalSuggest.approval.approval_id, [opSuggest]);
    check(suggestDone.kind === 'receipts' && suggestDone.receipts[0].status === 'saved', 'AI suggestion failure is still recorded as a committed write');
    modelState.guideInvalid = false;
    const a2Evidence = (await db.query<{ guide_evidence: { revision?: number; last_attempt?: { ok?: boolean } } }>(
      'SELECT guide_evidence FROM observations WHERE id = $1',
      [a2.id],
    )).rows[0];
    check(a2Evidence?.guide_evidence?.last_attempt?.ok === false, 'failed suggestion records last_attempt{ok:false}');
    check((a2Evidence?.guide_evidence?.revision ?? 0) === revisionBeforeSuggest + 1, 'failed suggestion still increments the container revision');

    // 教师拒绝现有关联（a1_h1 有 1 条 link）
    const a1h1 = manifest.observations.a1_h1;
    const a1Evidence = (await db.query<{ guide_evidence: { revision: number; links: { id: string }[] } }>(
      'SELECT guide_evidence FROM observations WHERE id = $1',
      [a1h1.id],
    )).rows[0];
    const linkId = a1Evidence?.guide_evidence?.links?.[0]?.id ?? '';
    check(!!linkId, 'seeded guide link for reject flow exists');
    const rejectProposal = await propose(toolkitA2, principalOf(accountA), 'guide_decision', {
      observation_id: a1h1.id,
      mutation: {
        action: 'withdraw',
        link_id: linkId,
        expected_guide_revision: a1Evidence?.guide_evidence?.revision ?? 0,
        reason: '证据不足',
      },
    });
    check(rejectProposal.ok, 'guide withdraw prepared');
    if (!rejectProposal.ok) throw new Error('withdraw prepare failed');
    const opReject = rejectProposal.operationIds[0];
    const approvalReject = await approve(sessionA2, rejectProposal.proposals[0].proposal_id, [opReject]);
    const rejectDone = await execute(sessionA2, approvalReject.approval.approval_id, [opReject]);
    check(rejectDone.kind === 'receipts' && rejectDone.receipts[0].status === 'saved', 'guide withdraw commits');
    const a1After = (await db.query<{ guide_evidence: { links: { status: string }[] } }>(
      'SELECT guide_evidence FROM observations WHERE id = $1',
      [a1h1.id],
    )).rows[0];
    check(a1After?.guide_evidence?.links?.[0]?.status === 'withdrawn', 'guide withdraw writes the terminal status');

    /* ============ I. 多幼儿分项：一个失败不影响另一个 ============ */
    const childZ = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'create_child', {
      name: `合成幼儿Z·${manifest.seed_id}`,
      gender: '女',
      birth_date: '2022-07-01',
      target_class_id: classIds.a,
      note: 'tools1 分项验收',
    });
    const childZId =
      childZ.result.kind === 'receipts' ? (childZ.result.receipts[0].business_object_id ?? '') : '';
    check(!!childZId, 'third child for split-batch checks exists');
    const rawSplitX = `[合成] 分项观察X：幼儿X完成拼图。${manifest.seed_id}`;
    const rawSplitY = `[合成] 分项观察Y：幼儿Z完成拼图。${manifest.seed_id}`;
    const splitProposalX = await propose(toolkitA2, principalOf(accountA), 'create_observation', {
      child_id: childXId,
      observed_at: today,
      raw_text: rawSplitX,
    });
    const splitProposalY = await propose(toolkitA2, principalOf(accountA), 'create_observation', {
      child_id: childZId,
      observed_at: today,
      raw_text: rawSplitY,
    });
    check(
      splitProposalX.ok && splitProposalY.ok,
      `two children prepare independent proposals (x=${splitProposalX.ok ? 'ok' : splitProposalX.code}, y=${splitProposalY.ok ? 'ok' : splitProposalY.code})`,
    );
    if (!splitProposalX.ok || !splitProposalY.ok) throw new Error('split proposals failed');
    const opSplitX = splitProposalX.operationIds[0];
    const opSplitY = splitProposalY.operationIds[0];
    const approvalSplitX = await approve(sessionA2, splitProposalX.proposals[0].proposal_id, [opSplitX]);
    const approvalSplitY = await approve(sessionA2, splitProposalY.proposals[0].proposal_id, [opSplitY]);
    const childXBeforeSplit = await observationsOf(childXId);
    const executedSplitX = await execute(sessionA2, approvalSplitX.approval.approval_id, [opSplitX]);
    check(executedSplitX.kind === 'receipts' && executedSplitX.receipts[0].status === 'saved', 'first child item commits');
    // 第二项失败：执行前把幼儿Z转出当前班
    await db.query(
      'UPDATE child_class_enrollments SET end_date = start_date WHERE child_id = $1 AND end_date IS NULL',
      [childZId],
    );
    await db.query(
      'INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1, $2, $3::date)',
      [childZId, classIds.c, today],
    );
    await db.query('UPDATE children SET class_name = (SELECT name FROM classes WHERE id = $2) WHERE id = $1', [
      childZId,
      classIds.c,
    ]);
    let splitYRejected = false;
    try {
      await execute(sessionA2, approvalSplitY.approval.approval_id, [opSplitY]);
    } catch (error) {
      splitYRejected = true;
      check((error as { code?: string }).code === 'approval_invalid', 'second child item is rejected after transfer');
    }
    check(splitYRejected, 'second child failure does not affect the committed first item');
    check((await observationsOf(childXId)) === childXBeforeSplit + 1, 'first child item persists exactly once');
    check(
      (await count('SELECT count(*)::text AS n FROM observations WHERE child_id = $1 AND raw_text = $2', [childZId, rawSplitY])) === 0,
      'failed child item writes zero rows and is not auto-resent',
    );

    /* ============ J. 管理员工具：班级、任教、启停 ============ */
    const createdClass = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'manage_class', {
      operation: 'create',
      name: `合成班级·${manifest.seed_id}`,
      stage: 'small',
      school_year: manifest.semester.school_year,
    });
    const newClassId = createdClass.result.kind === 'receipts' ? (createdClass.result.receipts[0].business_object_id ?? '') : '';
    check(!!newClassId, 'admin manage_class creates a class');
    const updatedClass = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'manage_class', {
      operation: 'update',
      class_id: newClassId,
      name: `合成班级改名·${manifest.seed_id}`,
      stage: 'small',
      school_year: manifest.semester.school_year,
    });
    check(updatedClass.result.kind === 'receipts', 'admin manage_class updates the class');

    const teacherCAccount = accountC;
    const assign = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'manage_teacher', {
      operation: 'assign_class',
      teacher_account_id: teacherCAccount.account_id,
      class_id: newClassId,
    });
    check(assign.result.kind === 'receipts' && assign.result.receipts[0].status === 'saved', 'admin assigns a teaching class');
    const removeAssign = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'manage_teacher', {
      operation: 'remove_assignment',
      teacher_account_id: teacherCAccount.account_id,
      class_id: newClassId,
    });
    check(removeAssign.result.kind === 'receipts', 'admin removes a teaching assignment');
    const disableC = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'manage_teacher', {
      operation: 'set_status',
      teacher_account_id: teacherCAccount.account_id,
      status: 'disabled',
    });
    check(disableC.result.kind === 'receipts', 'admin disables a teacher account');
    const enableC = await runWrite(toolkitAdmin, sessionAdmin, adminPrincipal, 'manage_teacher', {
      operation: 'set_status',
      teacher_account_id: teacherCAccount.account_id,
      status: 'active',
    });
    check(enableC.result.kind === 'receipts', 'admin re-enables the teacher account');

    const teacherTriesManage = await propose(toolkitA2, principalOf(accountA), 'manage_class', {
      operation: 'create',
      name: `教师越权班·${manifest.seed_id}`,
      stage: 'small',
      school_year: manifest.semester.school_year,
    });
    check(!teacherTriesManage.ok && teacherTriesManage.code === 'forbidden_role', 'teacher cannot manage classes through the assistant');

    /* ============ K. 安全控件 + 普通管理入口回归 ============ */
    // 真实管理路由：密码只提交给既有服务端入口；本脚本只断言非秘密结果
    const { POST: adminCreateTeacher } = await import('../../src/app/api/admin/teachers/route');
    const { POST: adminResetPassword } = await import(
      '../../src/app/api/admin/teachers/[id]/password-reset/route'
    );
    const createTeacherResponse = await adminCreateTeacher(
      new NextRequest('http://127.0.0.1:3000/api/admin/teachers', {
        method: 'POST',
        headers: carrier(sessionAdmin).headers,
        body: JSON.stringify({
          username: `${manifest.seed_id}-secure-control`,
          display_name: '安全控件教师',
          initial_password: 'Tools1-Temp-Password!',
          class_ids: [],
        }),
      }),
    );
    check(createTeacherResponse.status === 201, 'existing admin route can still create a teacher account');
    const createdTeacherBody = (await createTeacherResponse.json()) as {
      teacher: { account_id: string };
    };
    const teacherCreated = createdTeacherBody.teacher;
    check(teacherCreated.account_id.length > 0, 'created teacher has a non-secret account id');
    check(
      !JSON.stringify(createdTeacherBody).includes('Tools1-Temp-Password!') &&
        !JSON.stringify(createdTeacherBody).toLowerCase().includes('password'),
      'admin route response never echoes the password',
    );
    const resetResponse = await adminResetPassword(
      new NextRequest(
        `http://127.0.0.1:3000/api/admin/teachers/${teacherCreated.account_id}/password-reset`,
        {
          method: 'POST',
          headers: carrier(sessionAdmin).headers,
          body: JSON.stringify({
            account_id: teacherCreated.account_id,
            new_password: 'Tools1-New-Password!',
          }),
        },
      ),
      { params: Promise.resolve({ id: teacherCreated.account_id }) },
    );
    check(resetResponse.status === 200, 'existing admin route can still reset a teacher password');
    const resetBody = (await resetResponse.json()) as { revoked_session_count?: number };
    check(
      !JSON.stringify(resetBody).toLowerCase().includes('password'),
      'password reset response carries no secret fields',
    );
    const secureControlProposal = await propose(toolkitAdmin, adminPrincipal, 'manage_teacher', {
      operation: 'reset_password',
      teacher_account_id: teacherCreated.account_id,
      new_password: 'must-not-enter',
    });
    check(
      !secureControlProposal.ok && secureControlProposal.code === 'invalid_params',
      'assistant cannot carry passwords into a teacher management proposal',
    );

    /* ============ L. 回归：READ1 / 既有业务入口 ============ */
    const readRegistry = createYayaReadRegistry();
    const listChildren = await readRegistry.dispatch({ tool: 'list_children', params: {} }, { request: carrier(sessionA2) });
    check(listChildren.ok, 'READ1 list_children still works over the same real sessions');
    const directObservation = await withPrivateRead(carrier(sessionA2), ({ client, principal }) =>
      yayaDataRepository.queryBatch(client, principal.account_id, manifest.fault_fixtures.operation.batch_id),
    );
    check(directObservation.operations.length === 1, 'DATA receipt queries still work for seeded operations');
    const persistedTeacher = await setTeacherStatus(teacherCreated.account_id, 'disabled');
    check(persistedTeacher.teacher.status === 'disabled', 'AUTH repository status changes remain intact outside the toolkit');

    check(guard.hits === 0, 'db check made zero real provider requests');
  } catch (error) {
    failure = error;
  } finally {
    if (sessionClient) {
      await sessionClient.end().catch((error: unknown) => cleanupIssues.push(`session-client: ${String(error)}`));
    }
    if (seed) {
      await seed.teardown().catch((error: unknown) => cleanupIssues.push(`seed-teardown: ${String(error)}`));
    }
    await guard.close().catch((error: unknown) => cleanupIssues.push(`model-guard: ${String(error)}`));
  }
  if (failure) throw failure;
  if (cleanupIssues.length > 0) throw new Error(`tools-write db check cleanup incomplete: ${cleanupIssues.join('; ')}`);
  return passed;
}

runDb()
  .then((count) => {
    console.log(
      JSON.stringify({
        ok: true,
        passed: count,
        total: count,
        real_model_requests: 0,
        layers: {
          database: 'one-shot isolated PostgreSQL (ID/tag/loopback/empty verified, ID+tag teardown)',
          auth: 'real AUTH sessions/CSRF + runBusinessWrite/withPrivateWrite',
          business: 'real queries/guide/media metadata/accounts repository',
          model: 'in-process substitute (invokeLlm injection, zero provider requests)',
        },
        cleanup: 'verified',
      }),
    );
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
