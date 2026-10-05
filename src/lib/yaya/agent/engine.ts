/**
 * 芽芽有界会话动作引擎（AGENT1-CORE）。
 *
 * 固定一次 run_id，驱动「模型动作 → 服务端白名单/参数校验 → 依赖端授权执行 →
 * 结果作为数据反馈 → 下一步或终答」的有限循环；写入只产出准备态提案，永不执行。
 *
 * 守门要点：
 * - 每次 await、重试与派发前重核运行/取消/deadline/身份（guardRun）；
 * - 所有实际尝试（含失败、超时、重试、被拒绝的公开检索）计入预算；
 * - 等待全部有上界（finiteCall），没有悬挂计时器；
 * - 恢复只按原 operation 查询，不执行旧批准内容，回执只来自依赖端；
 * - 多模态只转发授权字节，混入 URL 即拒绝；provider 不支持图片时显式停止。
 */
import { extractJson } from '../../ai';
import { LlmUnsupportedCapabilityError } from '../../llm';
import {
  decidePublicSearch,
  receiptProvesSuccess,
  YAYA_PAYLOAD_KINDS,
  type YayaChildIdentifierScan,
  type YayaOperationProposal,
  type YayaOperationQueryOutcome,
  type YayaPlannedOperation,
  type YayaSourceRef,
  type YayaUntrustedEnvelope,
} from '../types';

import { buildYayaSystemPrompt, formatYayaToolResult, formatYayaUserMessage } from './prompt';
import {
  DEFAULT_YAYA_AGENT_LIMITS,
  parseYayaActionParams,
  yayaAgentActionSchema,
  YAYA_AUTHORIZED_IMAGE_MEDIA_TYPES,
  type YayaAgentAction,
  type YayaAgentBudgetState,
  type YayaAgentDependencies,
  type YayaAgentEvent,
  type YayaAgentLimits,
  type YayaAgentStopReason,
  type YayaAuthorizedImage,
  type YayaCurrentIdentity,
  type YayaModelMessage,
  type YayaModelResponse,
  type YayaRecoveryRequest,
  type YayaRecoveryResult,
  type YayaRunOutcome,
  type YayaRunRequest,
  type YayaRunResult,
} from './types';

class YayaStopSignal extends Error {
  readonly reason: YayaAgentStopReason;
  readonly detail: string | null;
  constructor(reason: YayaAgentStopReason, detail: string | null = null) {
    super(detail ?? reason);
    this.name = 'YayaStopSignal';
    this.reason = reason;
    this.detail = detail;
  }
}

function stop(reason: YayaAgentStopReason, detail: string | null = null): YayaStopSignal {
  return new YayaStopSignal(reason, detail);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface EngineState {
  runId: string;
  userText: string;
  attachmentIds: readonly string[];
  events: YayaAgentEvent[];
  onEvent?: (event: YayaAgentEvent) => void;
  budget: YayaAgentBudgetState;
  turns: YayaModelMessage[];
  knownSources: Map<string, YayaSourceRef>;
  controller: AbortController;
  deadlineAt: number;
  limits: YayaAgentLimits;
  expectedAccountId: string | null;
}

function emit(state: EngineState, event: YayaAgentEvent): void {
  state.events.push(event);
  state.onEvent?.(event);
}

function createEngineState(
  input: {
    run_id: string;
    user_text?: string;
    attachment_ids?: readonly string[];
    signal?: AbortSignal;
    onEvent?: (event: YayaAgentEvent) => void;
  },
  limits: YayaAgentLimits,
): EngineState {
  const controller = new AbortController();
  const signal = input.signal;
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return {
    runId: input.run_id,
    userText: input.user_text ?? '',
    attachmentIds: input.attachment_ids ?? [],
    events: [],
    onEvent: input.onEvent,
    budget: { model_attempts: 0, tool_steps: 0, tool_attempts: 0, tool_retries: 0 },
    turns: [],
    knownSources: new Map(),
    controller,
    deadlineAt: Date.now() + limits.deadline_ms,
    limits,
    expectedAccountId: null,
  };
}

/** 有限等待：deadline/取消/单次上限三者取最小；无论底层是否 settle，等待都会结束 */
async function finiteCall<T>(
  run: () => Promise<T>,
  state: EngineState,
  limitMs: number,
): Promise<T> {
  const remaining = state.deadlineAt - Date.now();
  if (remaining <= 0) throw stop('deadline', '运行已超过 deadline');
  const waitMs = Math.min(remaining, limitMs);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.controller.signal.removeEventListener('abort', onAbort);
      action();
    };
    const timer = setTimeout(() => finish(() => reject(stop('deadline', '等待超时'))), waitMs);
    const onAbort = () => finish(() => reject(stop('cancelled')));
    state.controller.signal.addEventListener('abort', onAbort, { once: true });
    run().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

function checkDeadline(state: EngineState): void {
  if (state.controller.signal.aborted) throw stop('cancelled');
  if (Date.now() >= state.deadlineAt) throw stop('deadline', '运行已超过 deadline');
}

/** 每次 await / 重试 / 派发前调用：固定 run_id、取消、deadline、当前身份逐项重核 */
async function guardRun(
  state: EngineState,
  deps: YayaAgentDependencies,
): Promise<YayaCurrentIdentity> {
  checkDeadline(state);
  let identity: YayaCurrentIdentity;
  try {
    identity = await finiteCall(
      () => deps.resolveCurrentIdentity({ run_id: state.runId }),
      state,
      state.limits.model_wait_ms,
    );
  } catch (error) {
    if (error instanceof YayaStopSignal) throw error;
    throw stop('identity_unavailable', messageOf(error));
  }
  checkDeadline(state);
  if (identity.run_id !== state.runId) throw stop('run_replaced', `run_id=${identity.run_id}`);
  if (identity.identity_state === 'unavailable') throw stop('identity_unavailable');
  if (identity.identity_state !== 'authenticated' || identity.principal === null) {
    throw stop('unauthenticated');
  }
  if (!identity.session_valid) throw stop('session_invalid');
  if (identity.principal.account_status !== 'active') throw stop('account_disabled');
  state.expectedAccountId ??= identity.principal.account_id;
  if (identity.principal.account_id !== state.expectedAccountId) {
    throw stop('identity_changed');
  }
  return identity;
}

function parseAction(content: string): YayaAgentAction {
  let json: unknown;
  try {
    json = extractJson(content);
  } catch {
    throw stop('invalid_action', '模型输出不是可解析的 JSON 动作');
  }
  const parsed = yayaAgentActionSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join('.') || 'action' : 'action';
    throw stop('invalid_action', `${where}: ${issue?.message ?? '动作不符合协议'}`);
  }
  return parsed.data;
}

function validateAuthorizedImages(images: readonly YayaAuthorizedImage[]): void {
  for (const image of images) {
    if ('url' in image || 'signed_url' in image || 'key' in image) {
      throw stop('source_mismatch', '图片只能使用服务端授权字节，不接受 URL/签名链接');
    }
    if (typeof image.image_id !== 'string' || image.image_id.trim().length === 0) {
      throw stop('source_mismatch', '图片缺少 image_id');
    }
    if (!(YAYA_AUTHORIZED_IMAGE_MEDIA_TYPES as readonly string[]).includes(image.media_type)) {
      throw stop('source_mismatch', `不支持的图片类型：${String(image.media_type)}`);
    }
    if (
      typeof image.data_base64 !== 'string' ||
      image.data_base64.length === 0 ||
      image.data_base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data_base64)
    ) {
      throw stop('source_mismatch', '图片字节不是合法 base64');
    }
    if (
      image.source === null ||
      typeof image.source !== 'object' ||
      typeof image.source.kind !== 'string'
    ) {
      throw stop('source_mismatch', '图片缺少服务端来源');
    }
  }
}

function isPreparedProposal(proposal: YayaOperationProposal): boolean {
  if (
    typeof proposal.proposal_id !== 'string' ||
    proposal.proposal_id.length === 0 ||
    typeof proposal.batch_id !== 'string' ||
    proposal.batch_id.length === 0 ||
    proposal.proposal_origin !== 'model_suggestion' ||
    proposal.items.length === 0
  ) {
    return false;
  }
  return proposal.items.every(
    (item) =>
      typeof item.item_key === 'string' &&
      item.item_key.length > 0 &&
      typeof item.content_digest === 'string' &&
      item.content_digest.length > 0 &&
      Array.isArray(item.attachment_associations) &&
      (YAYA_PAYLOAD_KINDS as readonly string[]).includes(item.payload.kind),
  );
}

function completeAnswer(state: EngineState, action: YayaAgentAction): YayaRunOutcome {
  const content = action.content.trim();
  const sources: YayaSourceRef[] = [];
  for (const ref of action.source_refs) {
    const source = state.knownSources.get(ref);
    if (source === undefined) throw stop('source_mismatch', `回答引用了未知来源：${ref}`);
    sources.push(source);
  }
  emit(state, { type: 'answer', content, sources });
  return { kind: 'answered', content, sources };
}

function completeClarify(state: EngineState, action: YayaAgentAction): YayaRunOutcome {
  const question = action.content.trim();
  emit(state, { type: 'clarify', question });
  return { kind: 'clarified', question };
}

async function executeRead(
  state: EngineState,
  deps: YayaAgentDependencies,
  action: YayaAgentAction,
): Promise<void> {
  const definition = deps.tools.read_tools.find((entry) => entry.tool === action.tool);
  if (definition === undefined) throw stop('unknown_read_tool', action.tool);

  const parsed = parseYayaActionParams(action.params_json);
  if (!parsed.ok) throw stop('invalid_params', `${action.tool}: ${parsed.error}`);
  const validated = definition.params.validate(parsed.params);
  if (!validated.ok) throw stop('invalid_params', `${action.tool}: ${validated.error}`);
  const params = validated.params;

  if (state.budget.tool_steps >= state.limits.max_tool_steps) throw stop('max_tool_steps');
  state.budget.tool_steps += 1;

  if (definition.public_search === true) {
    // 被拒绝的公开检索同样是一次工具尝试，计入预算。
    if (state.budget.tool_attempts >= state.limits.max_tool_attempts) {
      throw stop('max_tool_attempts');
    }
    state.budget.tool_attempts += 1;
    await guardRun(state, deps);
    const policy = deps.publicSearchPolicy;
    let scan: YayaChildIdentifierScan = 'unknown';
    if (policy.provider_enabled) {
      try {
        scan = await finiteCall(
          () => policy.scanChildIdentifiers({ tool: action.tool, params }),
          state,
          state.limits.tool_wait_ms,
        );
      } catch (error) {
        if (error instanceof YayaStopSignal) throw error;
        scan = 'unknown';
      }
    }
    checkDeadline(state);
    const decision = decidePublicSearch({
      provider_enabled: policy.provider_enabled,
      child_identifier_scan: scan,
      // 服务端未执行去识别算法时不声称已脱敏；未知一律保守拒绝。
      server_redaction_applied: false,
    });
    if (!decision.allowed) {
      emit(state, {
        type: 'public_search_refused',
        tool: action.tool,
        reason: decision.reason,
      });
      const refusal: YayaUntrustedEnvelope<unknown> = {
        untrusted: true,
        provenance: {
          kind: 'tool_result',
          ref_id: null,
          label: '公开检索被拒绝',
          derived_from: null,
        },
        content: { refused: true, reason: decision.reason },
      };
      emit(state, {
        type: 'tool_result',
        tool: action.tool,
        outcome: 'failed',
        source_kind: 'tool_result',
      });
      state.turns.push({ role: 'user', text: formatYayaToolResult(action.tool, refusal) });
      return;
    }
  }

  let retry = 0;
  for (;;) {
    if (state.budget.tool_attempts >= state.limits.max_tool_attempts) {
      throw stop('max_tool_attempts');
    }
    state.budget.tool_attempts += 1;
    const identity = await guardRun(state, deps);

    let outcome: Awaited<ReturnType<YayaAgentDependencies['readTool']>>;
    try {
      outcome = await finiteCall(
        () =>
          deps.readTool({
            run_id: state.runId,
            tool: action.tool,
            params,
            identity,
          }),
        state,
        state.limits.tool_wait_ms,
      );
    } catch (error) {
      if (error instanceof YayaStopSignal) throw error;
      if (retry < state.limits.max_tool_retries) {
        retry += 1;
        state.budget.tool_retries += 1;
        continue;
      }
      throw stop('tool_failed', `${action.tool}: ${messageOf(error)}`);
    }
    await guardRun(state, deps);

    if (outcome.ok) {
      const envelope: YayaUntrustedEnvelope<unknown> = {
        untrusted: true,
        provenance: outcome.source,
        content: outcome.data,
      };
      if (typeof outcome.source.ref_id === 'string' && outcome.source.ref_id.length > 0) {
        state.knownSources.set(outcome.source.ref_id, outcome.source);
      }
      emit(state, {
        type: 'tool_result',
        tool: action.tool,
        outcome: 'ok',
        source_kind: outcome.source.kind,
      });
      state.turns.push({ role: 'user', text: formatYayaToolResult(action.tool, envelope) });
      return;
    }

    if (outcome.code === 'unauthenticated') throw stop('unauthenticated', outcome.message);
    if (outcome.code === 'identity_unavailable') {
      throw stop('identity_unavailable', outcome.message);
    }
    // 业务性失败（越权/未找到/失败）作为数据反馈，不伪装成空数据，也不重试。
    const failure: YayaUntrustedEnvelope<unknown> = {
      untrusted: true,
      provenance: {
        kind: 'tool_result',
        ref_id: null,
        label: `读取失败：${action.tool}`,
        derived_from: null,
      },
      content: { ok: false, code: outcome.code, message: outcome.message },
    };
    emit(state, {
      type: 'tool_result',
      tool: action.tool,
      outcome: 'failed',
      source_kind: 'tool_result',
    });
    state.turns.push({ role: 'user', text: formatYayaToolResult(action.tool, failure) });
    return;
  }
}

async function executeProposeWrite(
  state: EngineState,
  deps: YayaAgentDependencies,
  action: YayaAgentAction,
): Promise<YayaRunOutcome> {
  const definition = deps.tools.write_tools.find((entry) => entry.tool === action.tool);
  if (definition === undefined) throw stop('unknown_write_tool', action.tool);

  const parsed = parseYayaActionParams(action.params_json);
  if (!parsed.ok) throw stop('invalid_params', `${action.tool}: ${parsed.error}`);
  const validated = definition.params.validate(parsed.params);
  if (!validated.ok) throw stop('invalid_params', `${action.tool}: ${validated.error}`);

  if (state.budget.tool_steps >= state.limits.max_tool_steps) throw stop('max_tool_steps');
  state.budget.tool_steps += 1;
  if (state.budget.tool_attempts >= state.limits.max_tool_attempts) {
    throw stop('max_tool_attempts');
  }
  state.budget.tool_attempts += 1;

  const identity = await guardRun(state, deps);
  let outcome: Awaited<ReturnType<YayaAgentDependencies['proposeWrite']>>;
  try {
    outcome = await finiteCall(
      () =>
        deps.proposeWrite({
          run_id: state.runId,
          tool: action.tool,
          params: validated.params,
          identity,
          proposal_origin: 'model_suggestion',
        }),
      state,
      state.limits.tool_wait_ms,
    );
  } catch (error) {
    if (error instanceof YayaStopSignal) throw error;
    throw stop('propose_failed', `${action.tool}: ${messageOf(error)}`);
  }
  await guardRun(state, deps);

  if (!outcome.ok) {
    switch (outcome.code) {
      case 'unauthenticated':
        throw stop('unauthenticated', outcome.message);
      case 'identity_unavailable':
        throw stop('identity_unavailable', outcome.message);
      case 'invalid_params':
        throw stop('invalid_params', outcome.message);
      case 'denied':
      case 'forbidden_role':
      case 'out_of_scope':
      case 'empty_scope':
        throw stop('tool_unauthorized', outcome.message);
      case 'unsupported':
      case 'failed':
        throw stop('propose_failed', outcome.message);
    }
  }
  if (outcome.proposals.length === 0) {
    throw stop('propose_failed', '依赖端未返回已准备的提案身份');
  }
  for (const proposal of outcome.proposals) {
    if (!isPreparedProposal(proposal)) {
      throw stop('propose_failed', '提案缺少服务端预分配身份');
    }
    emit(state, { type: 'proposal_prepared', proposal });
  }
  return { kind: 'proposed', proposals: outcome.proposals };
}

function assertBudget(modelCalls: number, limits: YayaAgentLimits): void {
  if (modelCalls >= limits.max_model_calls) throw stop('max_model_calls');
}

async function runLoop(
  state: EngineState,
  deps: YayaAgentDependencies,
): Promise<YayaRunOutcome> {
  const identity = await guardRun(state, deps);
  const context = await finiteCall(
    () =>
      deps.loadProjectedContext({
        run_id: state.runId,
        user_text: state.userText,
        attachment_ids: state.attachmentIds,
        identity,
      }),
    state,
    state.limits.model_wait_ms,
  );
  await guardRun(state, deps);
  validateAuthorizedImages(context.images);
  for (const source of context.sources) {
    if (typeof source.ref_id === 'string' && source.ref_id.length > 0) {
      state.knownSources.set(source.ref_id, source);
    }
  }
  state.turns.push({ role: 'system', text: buildYayaSystemPrompt() });
  for (const turn of context.history) {
    state.turns.push({ role: turn.role, text: turn.content });
  }
  state.turns.push({
    role: 'user',
    text: formatYayaUserMessage({
      user_text: state.userText,
      images: context.images,
      sources: context.sources,
      guide_catalog: context.guide_catalog,
      tools: deps.tools,
    }),
    images: context.images,
  });

  for (;;) {
    assertBudget(state.budget.model_attempts, state.limits);
    state.budget.model_attempts += 1;
    emit(state, { type: 'model_attempted', attempt: state.budget.model_attempts });
    await guardRun(state, deps);

    let response: YayaModelResponse;
    try {
      response = await finiteCall(
        () =>
          deps.model.generate({
            run_id: state.runId,
            messages: state.turns,
            signal: state.controller.signal,
          }),
        state,
        state.limits.model_wait_ms,
      );
    } catch (error) {
      if (error instanceof YayaStopSignal) throw error;
      if (error instanceof LlmUnsupportedCapabilityError) {
        throw stop('model_unsupported_capability', error.message);
      }
      throw stop('model_failed', messageOf(error));
    }
    await guardRun(state, deps);
    emit(state, {
      type: 'model_completed',
      provider: response.provider,
      model: response.model,
      usage: response.usage,
    });
    state.turns.push({ role: 'assistant', text: response.content });

    const action = parseAction(response.content);
    emit(state, {
      type: 'action_parsed',
      action: action.action,
      tool: action.tool.length > 0 ? action.tool : null,
    });
    switch (action.action) {
      case 'answer':
        return completeAnswer(state, action);
      case 'clarify':
        return completeClarify(state, action);
      case 'read':
        await executeRead(state, deps, action);
        break;
      case 'propose_write':
        return await executeProposeWrite(state, deps, action);
    }
  }
}

export async function runYayaAgent(
  deps: YayaAgentDependencies,
  request: YayaRunRequest,
  limits: YayaAgentLimits = DEFAULT_YAYA_AGENT_LIMITS,
): Promise<YayaRunResult> {
  const state = createEngineState(request, limits);
  emit(state, { type: 'run_started', run_id: state.runId });
  try {
    const outcome = await runLoop(state, deps);
    return { outcome, events: state.events, budget: { ...state.budget } };
  } catch (error) {
    if (error instanceof YayaStopSignal) {
      emit(state, { type: 'stopped', reason: error.reason, detail: error.detail });
      return {
        outcome: { kind: 'stopped', reason: error.reason, detail: error.detail },
        events: state.events,
        budget: { ...state.budget },
      };
    }
    throw error;
  } finally {
    state.controller.abort();
  }
}

/**
 * 恢复：只按原 operation 身份查询服务端回执；不执行任何旧批准内容，
 * 不调用模型，回执事件只来自依赖端且经身份/成功证明复核。
 */
export async function recoverYayaOperations(
  deps: YayaAgentDependencies,
  request: YayaRecoveryRequest,
  limits: YayaAgentLimits = DEFAULT_YAYA_AGENT_LIMITS,
): Promise<YayaRecoveryResult> {
  const state = createEngineState(
    {
      run_id: request.run_id,
      signal: request.signal,
      onEvent: request.onEvent,
    },
    limits,
  );
  const entries: YayaRecoveryResult['entries'][number][] = [];
  let stopReason: YayaAgentStopReason | null = null;
  let detail: string | null = null;

  try {
    for (const operation of request.operations) {
      const identity = await guardRun(state, deps);
      let outcome: YayaOperationQueryOutcome;
      if (
        identity.principal === null ||
        identity.principal.account_id !== operation.actor_account_id
      ) {
        // 只允许当前账号查询自己原操作的合法回执；不触达存储查询他人操作。
        outcome = { kind: 'unknown', reason: 'identity_mismatch' };
      } else {
        try {
          outcome = await finiteCall(
            () => deps.queryOperation({ run_id: state.runId, operation, identity }),
            state,
            state.limits.tool_wait_ms,
          );
        } catch (error) {
          if (error instanceof YayaStopSignal) throw error;
          // 查询失败保守返回未知：不重发、不新建执行。
          outcome = { kind: 'unknown', reason: 'verification_required' };
        }
        await guardRun(state, deps);
        outcome = verifyRecoveredOutcome(operation, outcome);
      }
      entries.push({ operation, outcome });
      emit(state, { type: 'receipt', operation_id: operation.operation_id, outcome });
    }
  } catch (error) {
    if (error instanceof YayaStopSignal) {
      stopReason = error.reason;
      detail = error.detail;
      emit(state, { type: 'stopped', reason: error.reason, detail: error.detail });
    } else {
      throw error;
    }
  } finally {
    state.controller.abort();
  }

  return { entries, events: state.events, stop_reason: stopReason, detail };
}

/** 复核依赖端返回的成功回执：身份错配/成功证明不完整一律降级为 unknown */
export function verifyRecoveredOutcome(
  expected: YayaPlannedOperation,
  outcome: YayaOperationQueryOutcome,
): YayaOperationQueryOutcome {
  if (outcome.kind !== 'saved' && outcome.kind !== 'saved_detail_unavailable') return outcome;
  const receipt = outcome.receipt;
  if (
    receipt.operation_id !== expected.operation_id ||
    receipt.batch_id !== expected.batch_id ||
    receipt.proposal_id !== expected.proposal_id ||
    receipt.item_key !== expected.item_key ||
    receipt.target_id !== expected.target_id ||
    receipt.actor_account_id !== expected.actor_account_id
  ) {
    return { kind: 'unknown', reason: 'identity_mismatch' };
  }
  if (!receiptProvesSuccess(receipt)) {
    return { kind: 'unknown', reason: 'invalid_success_proof' };
  }
  return outcome;
}
