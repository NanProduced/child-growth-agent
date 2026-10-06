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
import { DEFAULT_YAYA_AGENT_LIMITS, type YayaRunOutcome } from '../types';

import {
  createYayaRunRuntimeState,
  createYayaRunRuntimeStateFromRecord,
  revalidateYayaRunContext,
} from './context';
import { createYayaRunDependencies, type YayaRunDependencyOptions } from './deps';
import { isYayaRunOwnedByThisProcess } from './identity';
import {
  abortYayaRunProcess,
  getYayaRunProcessInstanceId,
  registerYayaRunProcess,
  unregisterYayaRunProcess,
} from './registry';
import {
  assertYayaRunAttachments,
  findYayaRunByClientRequest,
  finalizeYayaRun,
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
    if (conversation.revision !== input.expected_conversation_revision) {
      throw new YayaDataError('revision_conflict', '会话已在其他位置更新，请刷新后重试。');
    }
    await assertYayaRunAttachments(client, principal.account_id, input.attachment_ids);
    return registerYayaRun(client, {
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
  const verdict = await revalidateYayaRunContext(
    state,
    { run_id: run.run_id, identity, sources: [], image_ids: [] },
    { principal },
  );
  return verdict.ok;
}

function buildReplayResponse(run: YayaRunRecord): Response {
  const parsed = yayaRunOutcomeSchema.safeParse(run.outcome);
  if (!parsed.success) {
    throw new YayaDataError('server_error', '原运行终态不可读。');
  }
  const outcome = parsed.data;
  const wire: YayaRunWireEvent[] = [];
  let seq = 0;
  const push = (event: Parameters<typeof projectYayaAgentEvent>[0]): void => {
    seq += 1;
    wire.push(projectYayaAgentEvent(event, { run_id: run.run_id, seq }));
  };
  push({ type: 'run_started', run_id: run.run_id });
  switch (outcome.kind) {
    case 'answered':
      push({ type: 'answer', content: outcome.content, sources: outcome.sources });
      break;
    case 'clarified':
      push({ type: 'clarify', question: outcome.question });
      break;
    case 'proposed':
      for (const proposal of outcome.proposals) push({ type: 'proposal_prepared', proposal });
      break;
    case 'stopped':
      push({ type: 'stopped', reason: outcome.reason, detail: null });
      break;
  }
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
  try {
    const result = await runYayaAgent(deps, {
      run_id: run.run_id,
      user_text: run.user_text,
      attachment_ids: run.attachment_ids,
      signal: entry.controller.signal,
      onEvent: (event) => {
        seq += 1;
        write(projectYayaAgentEvent(event, { run_id: run.run_id, seq }));
      },
    });
    const stored = await finalizeYayaRun(run.run_id, ownerInstance, result.outcome);
    const storedOutcome = stored === null ? null : yayaRunOutcomeSchema.safeParse(stored.outcome);
    const outcome =
      storedOutcome !== null && storedOutcome.success ? storedOutcome.data : stoppedOutcome('run_replaced');
    seq += 1;
    write(projectYayaRunEnd(outcome, { run_id: run.run_id, seq }));
  } catch {
    // 非预期内部失败：不把内部异常文本/模型原始 JSON 写进事件；持久化中断恢复标记，查询按不可核验返回。
    await markYayaRunInterrupted(run.run_id, ownerInstance).catch(() => null);
    seq += 1;
    write(projectYayaRunEnd(stoppedOutcome('model_failed'), { run_id: run.run_id, seq }));
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
      let run: YayaRunRecord | null;
      try {
        run = await findYayaRunByClientRequest(
          principal.account_id,
          conversationId,
          clientRequestId,
        );
      } catch {
        return classifyYayaRunLookup({ kind: 'query_failed' });
      }
      if (run === null) return classifyYayaRunLookup({ kind: 'not_found' });
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
