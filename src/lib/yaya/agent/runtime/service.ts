/**
 * 芽芽运行服务（AGENT-APP1）：三条正式接口的服务端逻辑。
 *
 * - 发起：API0 严格请求校验 → 同事务登记（先落库）→ NDJSON 事件流；
 *   同键同内容不再次派发（终态回放），异内容 409，活跃中 409 且绝不二次派发；
 * - 查询：五态只读；不启动模型、不执行旧批准、不续期；终态按当前来源权限投影，
 *   不可核验时如实返回 unverifiable，不返回旧私域内容；
 * - 取消：空请求体；持久化取消并 abort 本进程的派发；不撤销已提交业务。
 * - 事件：逐条 API0 schema；流已开始后失败用显式终态；内部异常文本/模型原始 JSON
 *   不进入事件（停止详情统一 safeYayaStopDetail）。
 */
import { randomUUID } from 'node:crypto';
import { configuredChatModelCallLimit } from '@/lib/coze-runtime';

import { NextResponse } from 'next/server';

import { AccountsError } from '@/lib/accounts/errors';
import type { HeaderCarrier } from '@/lib/accounts/guards';
import { parseCookieHeader, SESSION_COOKIE_NAME } from '@/lib/accounts/session';
import type { Principal } from '@/lib/accounts/types';
import { withPrivateRead, withPrivateWrite, yayaDataRepository } from '@/lib/yaya/data';
import {
  classifyYayaRunLookup,
  encodeYayaRunEventLine,
  parseYayaRunCancelRequest,
  parseYayaRunStartRequest,
  projectYayaAgentEvent,
  projectYayaRunEnd,
  YAYA_MAX_CLIENT_REQUEST_ID_LENGTH,
  YAYA_RUN_EVENT_CONTENT_TYPE,
  yayaRunOutcomeSchema,
  type YayaRunLookupResponse,
  type YayaRunWireEvent,
} from '@/lib/yaya/api-contract';
import { YayaDataError } from '@/lib/yaya/storage-types';

import { runYayaAgent } from '../engine';
import {
  DEFAULT_YAYA_AGENT_LIMITS,
  type YayaAgentEvent,
  type YayaRunOutcome,
} from '../types';

import {
  createYayaRunRuntimeState,
  createYayaRunRuntimeStateFromRecord,
  revalidateYayaRunContext,
  revalidateYayaRunContextWithClient,
} from './context';
import { createYayaRunDependencies, type YayaRunDependencyOptions } from './deps';
import { persistRunTerminalMessage } from './terminal-message';
import { loadAccountsConfig } from '@/lib/accounts/config';
import {
  boundaryStopForIdentity,
  isYayaRunOwnedByThisProcess,
  resolveYayaRunBoundaryIdentity,
} from './identity';
import {
  abortYayaRunProcess,
  getYayaRunProcessInstanceId,
  registerYayaRunProcess,
  unregisterYayaRunProcess,
} from './registry';
import {
  assertYayaRunAttachments,
  finalizeYayaRun,
  findYayaRunStoredRowByClientRequest,
  loadYayaRun,
  markYayaRunInterrupted,
  registerYayaRun,
  requestYayaRunCancel,
  type YayaRunRecord,
} from './store';

const NDJSON_HEADERS: Record<string, string> = {
  'Content-Type': YAYA_RUN_EVENT_CONTENT_TYPE,
  'Cache-Control': 'no-store',
  'X-Accel-Buffering': 'no',
};

function stoppedOutcome(reason: 'run_replaced' | 'model_failed'): YayaRunOutcome {
  return { kind: 'stopped', reason, detail: null };
}

/**
 * 发布前按**当前**授权核验待发布终态（含已存终态与回退路径，含正常成功）：
 * 停止终态无私域内容直通；其余与查询口径共用 runTerminalPresentable，
 * 不可核验时改发 context_revoked，绝不发布旧私域内容。
 */
async function publishableOutcome(
  run: YayaRunRecord,
  token: string,
  outcome: YayaRunOutcome,
): Promise<YayaRunOutcome> {
  if (outcome.kind === 'stopped') return outcome;
  const carrier = carrierForToken(token);
  try {
    const presentable = await withPrivateRead(carrier, async ({ principal }) =>
      runTerminalPresentable(run, carrier, principal),
    );
    return presentable ? outcome : { kind: 'stopped', reason: 'context_revoked', detail: null };
  } catch (error) {
    if (error instanceof AccountsError) {
      if (error.code === 'account_disabled') {
        return { kind: 'stopped', reason: 'account_disabled', detail: null };
      }
      if (error.code === 'identity_unavailable') {
        return { kind: 'stopped', reason: 'identity_unavailable', detail: null };
      }
      return { kind: 'stopped', reason: 'session_invalid', detail: null };
    }
    return { kind: 'stopped', reason: 'context_revoked', detail: null };
  }
}

function carrierFromRequest(request: Request): HeaderCarrier {
  const cookie = request.headers.get('cookie');
  return { headers: new Headers(cookie === null ? {} : { cookie }) };
}

function carrierForToken(token: string): HeaderCarrier {
  return { headers: new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` }) };
}

/* --------------------------------- 发起 --------------------------------- */

export type YayaRunStartOptions = YayaRunDependencyOptions;

export async function startYayaRun(
  request: Request,
  conversationId: string,
  options: YayaRunStartOptions = {},
): Promise<Response> {
  // 先给未认证请求 401（头未发前的身份边界），再做请求形状校验。
  const token = parseCookieHeader(request.headers.get('cookie')).get(SESSION_COOKIE_NAME) ?? '';
  if (token === '') {
    throw new AccountsError('unauthenticated', '请先登录园所账号。');
  }
  const rawBody = await request.text();
  let body: unknown;
  if (rawBody.trim() === '') {
    body = undefined;
  } else {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw new YayaDataError('invalid_request', '请求体不是合法 JSON。');
    }
  }
  const parsed = parseYayaRunStartRequest(body);
  if (!parsed.ok) {
    const first = parsed.violations[0];
    throw new YayaDataError('invalid_request', first?.message ?? '运行请求不符合协议。', {
      violations: parsed.violations.map((entry) => ({ ...entry })),
    });
  }
  const input = parsed.value;
  if (input.conversation_id !== conversationId) {
    throw new YayaDataError('invalid_request', '路径会话与请求体会话不一致。');
  }
  const ownerInstance = getYayaRunProcessInstanceId();

  const registration = await withPrivateWrite(request, async ({ client, principal, sessionId }) => {
    const conversation = await yayaDataRepository.getConversation(
      client,
      principal.account_id,
      conversationId,
    );
    if (conversation === null) throw new YayaDataError('not_found', '会话不存在。');
    const registered = await registerYayaRun(client, {
      run_id: randomUUID(),
      owner_account_id: principal.account_id,
      conversation_id: conversationId,
      client_request_id: input.client_request_id,
      user_text: input.user_text,
      attachment_ids: input.attachment_ids,
      expected_conversation_revision: input.expected_conversation_revision,
      session_id: sessionId,
      owner_instance: ownerInstance,
      deadline_at: new Date(Date.now() + DEFAULT_YAYA_AGENT_LIMITS.deadline_ms).toISOString(),
    });
    if (registered.kind === 'created') {
      // 新请求核对锁后的会话版本；原身份重放不因权威消息追加而被旧版本误拒。
      const latest = await client.query<{ revision: number }>('SELECT revision FROM yaya_conversations WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL FOR SHARE', [conversationId, principal.account_id]);
      if (latest.rows[0]?.revision !== input.expected_conversation_revision) throw new YayaDataError('revision_conflict', '会话已在其他位置更新，请刷新后重试。');
      await assertYayaRunAttachments(client, principal.account_id, input.attachment_ids);
    }
    return registered;
  });

  if (registration.kind === 'conflict') {
    throw new YayaDataError(
      'idempotency_conflict',
      '同一 client_request_id 的请求内容与已登记运行不一致。',
    );
  }
  if (registration.kind === 'active') {
    throw new YayaDataError(
      'operation_started',
      '原请求已登记且仍在运行或被中断，不会重复派发；请用查询接口获取状态。',
    );
  }
  if (registration.kind === 'replayed') {
    const presentable = await assessRunTerminalPresentableFromRequest(request, registration.run);
    if (!presentable) {
      throw new YayaDataError(
        'source_conflict',
        '原运行结果在当前授权下不可核验，已拒绝回放；请重新发起或咨询。',
      );
    }
    return buildReplayResponse(registration.run);
  }
  return buildStreamingResponse(registration.run, token, ownerInstance, options);
}

async function assessRunTerminalPresentableFromRequest(
  request: Request,
  run: YayaRunRecord,
): Promise<boolean> {
  const parsed = yayaRunOutcomeSchema.safeParse(run.outcome);
  if (!parsed.success) return false;
  if (parsed.data.kind === 'stopped') return true;
  const carrier = carrierFromRequest(request);
  return withPrivateRead(request, async ({ principal }) =>
    runTerminalPresentable(run, carrier, principal),
  );
}

async function runTerminalPresentable(
  run: YayaRunRecord,
  carrier: HeaderCarrier,
  principal: Principal,
): Promise<boolean> {
  const state = createYayaRunRuntimeStateFromRecord(run, carrier);
  const identity = {
    run_id: run.run_id,
    identity_state: 'authenticated' as const,
    principal,
    session_valid: true,
  };
  try {
    const verdict = await revalidateYayaRunContext(
      state,
      { run_id: run.run_id, identity, sources: [], image_ids: [] },
      { principal },
    );
    if (!verdict.ok) return false;
  } catch {
    // 查询路径重核不可用：保守不展示旧内容
    return false;
  }
  // R4：来源重核会等待 children/历史/图片等资源锁，等待可能跨过会话自然到期；
  // 进入时的 principal 与 session_valid=true 只代表核验开始时有效。全部异步核验完成后
  // 按当前事实再核一次身份（复用 AUTH 私有读守门与错误语义，与引擎边界在重核收尾处
  // 再次 guardRun 的规则一致），绝不把旧身份快照当成此刻仍有效。
  try {
    await withPrivateRead(carrier, async () => undefined);
  } catch (error) {
    if (error instanceof AccountsError) throw error;
    return false;
  }
  return true;
}

/** 终局事件只能从**已持久化裁决**的终态构造，保证事件流与库逐字一致 */
function canonicalTerminalEvents(outcome: YayaRunOutcome): YayaAgentEvent[] {
  switch (outcome.kind) {
    case 'answered':
      return [{ type: 'answer', content: outcome.content, sources: outcome.sources }];
    case 'clarified':
      return [{ type: 'clarify', question: outcome.question }];
    case 'proposed':
      return outcome.proposals.map((proposal) => ({ type: 'proposal_prepared', proposal }));
    case 'stopped':
      return [{ type: 'stopped', reason: outcome.reason, detail: null }];
  }
}

/** 引擎已产生的终局候选事件（answer/clarify/proposal_prepared/stopped）暂存不发 */
const TERMINAL_AGENT_EVENT_TYPES: ReadonlySet<YayaAgentEvent['type']> = new Set([
  'answer',
  'clarify',
  'proposal_prepared',
  'stopped',
]);

function buildReplayResponse(run: YayaRunRecord): Response {
  const parsed = yayaRunOutcomeSchema.safeParse(run.outcome);
  if (!parsed.success) {
    throw new YayaDataError('server_error', '原运行终态不可读。');
  }
  const outcome = parsed.data;
  const wire: YayaRunWireEvent[] = [];
  let seq = 0;
  const push = (event: YayaAgentEvent): void => {
    seq += 1;
    wire.push(projectYayaAgentEvent(event, { run_id: run.run_id, seq }));
  };
  push({ type: 'run_started', run_id: run.run_id });
  for (const event of canonicalTerminalEvents(outcome)) push(event);
  seq += 1;
  wire.push(projectYayaRunEnd(outcome, { run_id: run.run_id, seq }));
  const body = wire.map((event) => encodeYayaRunEventLine(event)).join('');
  return new Response(body, { status: 200, headers: { ...NDJSON_HEADERS } });
}

function buildStreamingResponse(
  run: YayaRunRecord,
  token: string,
  ownerInstance: string,
  options: YayaRunStartOptions,
): Response {
  const encoder = new TextEncoder();
  let clientGone = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: YayaRunWireEvent): void => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(encodeYayaRunEventLine(event)));
        } catch {
          // 客户端断开：运行继续到终态并落库，供按原 client_request_id 查询；不再派发业务操作。
          clientGone = true;
        }
      };
      void driveRun({ run, token, ownerInstance, options, write }).finally(() => {
        if (clientGone) return;
        try {
          controller.close();
        } catch {
          clientGone = true;
        }
      });
    },
    cancel() {
      clientGone = true;
    },
  });
  return new Response(stream, { status: 200, headers: { ...NDJSON_HEADERS } });
}

async function driveRun(input: {
  run: YayaRunRecord;
  token: string;
  ownerInstance: string;
  options: YayaRunDependencyOptions;
  write: (event: YayaRunWireEvent) => void;
}): Promise<void> {
  const { run, token, ownerInstance, options, write } = input;
  const entry = registerYayaRunProcess(run.run_id);
  const state = createYayaRunRuntimeState({
    run,
    token,
    owner_instance: ownerInstance,
    carrier: carrierForToken(token),
  });
  const deps = createYayaRunDependencies(state, options);
  let seq = 0;
  const writeAgent = (event: YayaAgentEvent): void => {
    seq += 1;
    write(projectYayaAgentEvent(event, { run_id: run.run_id, seq }));
  };
  const writeEnd = (outcome: YayaRunOutcome): void => {
    seq += 1;
    write(projectYayaRunEnd(outcome, { run_id: run.run_id, seq }));
  };
  const publishPersistedOutcome = (outcome: YayaRunOutcome): void => {
    for (const event of canonicalTerminalEvents(outcome)) writeAgent(event);
    writeEnd(outcome);
  };
  try {
    const result = await runYayaAgent(deps, {
      run_id: run.run_id,
      user_text: run.user_text,
      attachment_ids: run.attachment_ids,
      signal: entry.controller.signal,
      // 非终局进度仍逐条及时流出；终局候选（answer/clarify/proposal/stopped）暂存，
      // 等持久化裁决后只发布与最终结果一致的终局事件与唯一 run_end。
      onEvent: (event) => {
        if (TERMINAL_AGENT_EVENT_TYPES.has(event.type)) return;
        writeAgent(event);
      },
    }, { ...DEFAULT_YAYA_AGENT_LIMITS, max_model_calls: configuredChatModelCallLimit(DEFAULT_YAYA_AGENT_LIMITS.max_model_calls) });
    let stored: YayaRunRecord | null = null;
    let finalizeThrew = false;
    let finalizationRejected: YayaRunOutcome | null = null;
    let terminalPrincipal: Principal | null = null;
    // 最后保存边界：身份阶段（账号/会话/任教共享锁）→ run 行锁等待 → 来源阶段
    // （锁后重核全部已装载投影 + 身份重核）；墙钟到期/撤权/转班跨过锁等待时按当前事实停止。
    try {
      stored = await finalizeYayaRun(run.run_id, ownerInstance, result.outcome, {
        verify: async (client) => {
          const identity = await resolveYayaRunBoundaryIdentity(client, { run, token });
          const stop = boundaryStopForIdentity(identity, run);
          terminalPrincipal = stop === null ? identity.principal : null;
          return stop;
        },
        verifyProjections: async (client) => {
          // run 行锁等待完成后重新解析身份：锁等待可能跨过会话到期时刻。
          const identity = await resolveYayaRunBoundaryIdentity(client, { run, token });
          const identityStop = boundaryStopForIdentity(identity, run);
          if (identityStop !== null) { terminalPrincipal = null; return identityStop; }
          if (identity.principal === null) return null;
          const verdict = await revalidateYayaRunContextWithClient(
            state,
            { run_id: run.run_id, identity, sources: [], image_ids: [] },
            { principal: identity.principal },
            client,
          );
          if (!verdict.ok) return { kind: 'stopped', reason: 'context_revoked', detail: null };
          // 来源重核本身也会等待 child 共享锁：提交前再确认一次身份，覆盖整段锁等待。
          const finalIdentity = await resolveYayaRunBoundaryIdentity(client, { run, token });
          const finalStop = boundaryStopForIdentity(finalIdentity, run);
          terminalPrincipal = finalStop === null ? finalIdentity.principal : null;
          return finalStop;
        },
        persistTerminal: async (client, terminal) => {
          if (terminalPrincipal === null) return;
          await persistRunTerminalMessage(client, terminalPrincipal, loadAccountsConfig()?.schoolId ?? 'single-school', terminal);
          // Canonical messages can wait on the conversation row too. Recheck after
          // that await, so an expired session cannot commit a successful message.
          const identity = await resolveYayaRunBoundaryIdentity(client, { run, token });
          finalizationRejected = boundaryStopForIdentity(identity, run);
          const deadline = await client.query<{ expired: boolean }>('SELECT deadline_at <= clock_timestamp() AS expired FROM yaya_runs WHERE id=$1', [run.run_id]);
          if (finalizationRejected === null && deadline.rows[0]?.expired) finalizationRejected = { kind: 'stopped', reason: 'deadline', detail: null };
          if (finalizationRejected !== null) throw new YayaDataError('source_conflict', '终态消息保存期间前提失效。');
        },
      });
    } catch {
      finalizeThrew = true;
    }
    if (stored !== null) {
      const parsed = yayaRunOutcomeSchema.safeParse(stored.outcome);
      const candidate = parsed.success ? parsed.data : stoppedOutcome('model_failed');
      // 用落库记录自身重核（与查询口径一致）：注册期快照不含运行中累积的依赖。
      publishPersistedOutcome(await publishableOutcome(stored, token, candidate));
      return;
    }
    if (finalizeThrew) {
      // 持久化失败/结果未知：绝不先显示成功再改失败；标记中断，流以协议停止终态结束。
      await markYayaRunInterrupted(run.run_id, ownerInstance).catch(() => null);
      publishPersistedOutcome(finalizationRejected ?? stoppedOutcome('model_failed'));
      return;
    }
    const fallback = await loadYayaRun(run.run_id).catch(() => null);
    if (fallback !== null && fallback.state === 'terminal') {
      const parsed = yayaRunOutcomeSchema.safeParse(fallback.outcome);
      const candidate = parsed.success ? parsed.data : stoppedOutcome('model_failed');
      publishPersistedOutcome(await publishableOutcome(fallback, token, candidate));
      return;
    }
    publishPersistedOutcome(
      fallback !== null && fallback.state === 'active'
        ? stoppedOutcome('run_replaced')
        : stoppedOutcome('model_failed'),
    );
  } catch {
    // 非预期内部失败：不把内部异常文本/模型原始 JSON 写进事件；持久化中断恢复标记，查询按不可核验返回。
    await markYayaRunInterrupted(run.run_id, ownerInstance).catch(() => null);
    publishPersistedOutcome(stoppedOutcome('model_failed'));
  } finally {
    unregisterYayaRunProcess(run.run_id, entry);
  }
}

/* --------------------------------- 查询 --------------------------------- */

export async function lookupYayaRun(request: Request, conversationId: string): Promise<Response> {
  const url = new URL(request.url);
  const clientRequestId = url.searchParams.get('client_request_id');
  if (
    clientRequestId === null ||
    clientRequestId.trim() === '' ||
    clientRequestId.length > YAYA_MAX_CLIENT_REQUEST_ID_LENGTH
  ) {
    throw new YayaDataError('invalid_request', '缺少或不合法的 client_request_id。');
  }
  const carrier = carrierFromRequest(request);
  const response: YayaRunLookupResponse = await withPrivateRead(
    request,
    async ({ client, principal }) => {
      let conversation;
      try {
        conversation = await yayaDataRepository.getConversation(
          client,
          principal.account_id,
          conversationId,
        );
      } catch {
        return classifyYayaRunLookup({ kind: 'query_failed' });
      }
      if (conversation === null) throw new YayaDataError('not_found', '会话不存在。');
      let stored;
      try {
        stored = await findYayaRunStoredRowByClientRequest(
          principal.account_id,
          conversationId,
          clientRequestId,
        );
      } catch {
        return classifyYayaRunLookup({ kind: 'query_failed' });
      }
      if (stored.kind === 'missing') return classifyYayaRunLookup({ kind: 'not_found' });
      if (stored.kind === 'unreadable') {
        // 行存在但不可读：不是 missing，也不冒充进行中；按不可核验返回。
        return classifyYayaRunLookup({
          kind: 'found',
          run_id: stored.run_id,
          owner_verified: true,
          state: { kind: 'terminal', outcome: null },
        });
      }
      const run = stored.run;
      if (run.state === 'active') {
        return classifyYayaRunLookup({
          kind: 'found',
          run_id: run.run_id,
          owner_verified: isYayaRunOwnedByThisProcess(run),
          state: { kind: 'active' },
        });
      }
      if (run.state !== 'terminal') {
        return classifyYayaRunLookup({
          kind: 'found',
          run_id: run.run_id,
          owner_verified: true,
          state: { kind: 'terminal', outcome: null },
        });
      }
      const parsedOutcome = yayaRunOutcomeSchema.safeParse(run.outcome);
      if (!parsedOutcome.success) {
        return classifyYayaRunLookup({
          kind: 'found',
          run_id: run.run_id,
          owner_verified: true,
          state: { kind: 'terminal', outcome: null },
        });
      }
      if (parsedOutcome.data.kind !== 'stopped') {
        // 终态恢复按当前来源权限投影：依赖/历史/图片任一不可核验时不返回旧私域内容。
        const presentable = await runTerminalPresentable(run, carrier, principal);
        if (!presentable) {
          return classifyYayaRunLookup({
            kind: 'found',
            run_id: run.run_id,
            owner_verified: true,
            state: { kind: 'terminal', outcome: null },
          });
        }
      }
      return classifyYayaRunLookup({
        kind: 'found',
        run_id: run.run_id,
        owner_verified: true,
        state: { kind: 'terminal', outcome: run.outcome },
      });
    },
  );
  return NextResponse.json(response);
}

/* --------------------------------- 取消 --------------------------------- */

export async function cancelYayaRun(request: Request, runId: string): Promise<Response> {
  const rawBody = await request.text();
  let body: unknown = {};
  if (rawBody.trim() !== '') {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw new YayaDataError('invalid_request', '取消请求体必须是空对象。');
    }
  }
  const parsed = parseYayaRunCancelRequest(body);
  if (!parsed.ok) {
    const first = parsed.violations[0];
    throw new YayaDataError('invalid_request', first?.message ?? '取消请求体必须为空。');
  }
  const run = await withPrivateWrite(request, ({ client, principal }) =>
    requestYayaRunCancel(client, runId, principal.account_id),
  );
  if (run === null) throw new YayaDataError('not_found', '运行不存在。');
  if (run.state === 'active') abortYayaRunProcess(run.run_id);
  return NextResponse.json({
    run_id: run.run_id,
    status: 'cancel_requested',
    stops_subsequent_dispatch: true,
    rolls_back_committed_business: false,
    upstream_http_cancel_verified: false,
  });
}
