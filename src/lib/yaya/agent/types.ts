/**
 * 芽芽 v1 会话动作引擎共享类型（AGENT1-CORE）。
 *
 * 引擎只做三件事：把模型输出解析成有界动作、在授权依赖端之上驱动一次性
 * read→数据反馈循环、写入一律停在准备态提案。它不持有认证、事务、存储、
 * 批准或执行能力；这些全部由注入端口（正式接服务，测试接替身）承担。
 *
 * 安全口径：
 * - 模型只能输出 answer / read / clarify / propose_write；没有批准、SQL、
 *   HTTP、密码工具，动作参数先过白名单与参数 schema 才会触达依赖端；
 * - 所有模型/工具尝试（含失败、超时、重试、被拒绝）计入预算；
 * - 每次 await、重试与派发前都重核固定 run_id、取消、deadline 与当前身份；
 * - 公开检索默认关闭：只认服务端扫描结论，不信模型自报脱敏；
 * - 图片输入只接受服务端已授权、已处理的字节，不接受签名 URL。
 */
import { z } from 'zod';

import type { Principal } from '../../accounts/types';
import type { LlmUsage } from '../../llm';
import type {
  YayaChildIdentifierScan,
  YayaOperationProposal,
  YayaOperationQueryOutcome,
  YayaPlannedOperation,
  YayaProvenanceKind,
  YayaSourceRef,
  YayaToolAuth,
  YayaToolScopePolicy,
} from '../types';

/* ---------------------------------- 动作协议 ---------------------------------- */

export const YAYA_AGENT_ACTIONS = ['answer', 'read', 'clarify', 'propose_write'] as const;
export type YayaAgentActionKind = (typeof YAYA_AGENT_ACTIONS)[number];

const yayaAgentActionObject = z.strictObject({
  action: z.enum(YAYA_AGENT_ACTIONS),
  content: z.string(),
  tool: z.string(),
  params_json: z.string(),
  source_refs: z.array(z.string()),
});

/** 应用侧参数解析：只接受 JSON 对象；解析失败不触达任何工具 */
export function parseYayaActionParams(
  paramsJson: string,
): { ok: true; params: unknown } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(paramsJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'params_json 必须是 JSON 对象' };
    }
    return { ok: true, params: parsed };
  } catch {
    return { ok: false, error: 'params_json 不是合法 JSON' };
  }
}

export const yayaAgentActionSchema = yayaAgentActionObject.superRefine((value, ctx) => {
  if (value.action === 'answer' || value.action === 'clarify') {
    if (value.content.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: `${value.action} 的 content 不能为空` });
    }
    if (value.tool !== '') {
      ctx.addIssue({ code: 'custom', message: `${value.action} 不允许携带 tool` });
    }
    if (value.params_json !== '') {
      ctx.addIssue({ code: 'custom', message: `${value.action} 不允许携带 params_json` });
    }
    if (value.action === 'clarify' && value.source_refs.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'clarify 不允许携带 source_refs' });
    }
  } else {
    if (value.content.trim().length > 0) {
      ctx.addIssue({ code: 'custom', message: `${value.action} 的 content 必须为空` });
    }
    if (value.tool.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: `${value.action} 必须指定 tool` });
    }
    if (value.source_refs.length > 0) {
      ctx.addIssue({ code: 'custom', message: `${value.action} 不允许携带 source_refs` });
    }
    const parsed = parseYayaActionParams(value.params_json);
    if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error });
  }
  if (new Set(value.source_refs).size !== value.source_refs.length) {
    ctx.addIssue({ code: 'custom', message: 'source_refs 不能重复' });
  }
});

export type YayaAgentAction = z.infer<typeof yayaAgentActionObject>;

/** StepFun strict json_schema 形态的应用协议（Coze 由 Prompt 承载，同一 Zod 校验） */
export const YAYA_ACTION_WIRE_FORMAT = {
  name: 'yaya_agent_action',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'content', 'tool', 'params_json', 'source_refs'],
    properties: {
      action: { type: 'string', enum: [...YAYA_AGENT_ACTIONS] },
      content: { type: 'string' },
      tool: { type: 'string' },
      params_json: { type: 'string' },
      source_refs: { type: 'array', items: { type: 'string' } },
    },
  },
} as const;

/* ---------------------------------- 身份与运行 ---------------------------------- */

export const YAYA_IDENTITY_STATES = [
  'authenticated',
  'unauthenticated',
  'invalid_session',
  'unavailable',
] as const;
export type YayaIdentityState = (typeof YAYA_IDENTITY_STATES)[number];

/** 服务端解析的当前身份与运行标识；模型/客户端不能自报 */
export interface YayaCurrentIdentity {
  run_id: string;
  identity_state: YayaIdentityState;
  principal: Principal | null;
  session_valid: boolean;
}

export type YayaRunGuardFailure =
  | 'cancelled'
  | 'deadline'
  | 'run_replaced'
  | 'identity_changed'
  | 'unauthenticated'
  | 'identity_unavailable'
  | 'session_invalid'
  | 'account_disabled';

export type YayaRunGuard = { ok: true } | { ok: false; reason: YayaRunGuardFailure };

/* ---------------------------------- 工具白名单 ---------------------------------- */

export type YayaParamValidation =
  | { ok: true; params: unknown }
  | { ok: false; error: string };

/** 参数校验端口：最小结构接口，TOOLS1 可用 Zod 适配（zodToolParams） */
export interface YayaToolParamSchema {
  validate(value: unknown): YayaParamValidation;
}

export function zodToolParams<T>(schema: z.ZodType<T>): YayaToolParamSchema {
  return {
    validate: (value) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) return { ok: true, params: parsed.data };
      const issue = parsed.error.issues[0];
      const where = issue ? issue.path.join('.') || 'params' : 'params';
      return { ok: false, error: `${where}: ${issue?.message ?? '不符合参数要求'}` };
    },
  };
}

export interface YayaReadToolDefinition {
  tool: string;
  description: string;
  scope_policy: YayaToolScopePolicy;
  params: YayaToolParamSchema;
  /** 公开检索类工具：调用前必须通过服务端无识别信息预检 */
  public_search?: boolean;
}

export interface YayaWriteToolDefinition {
  tool: string;
  description: string;
  auth: YayaToolAuth;
  params: YayaToolParamSchema;
}

export interface YayaToolCatalog {
  read_tools: readonly YayaReadToolDefinition[];
  write_tools: readonly YayaWriteToolDefinition[];
}

/* ---------------------------------- 上下文投影 ---------------------------------- */

export interface YayaContextTurn {
  role: 'user' | 'assistant';
  content: string;
}

export const YAYA_AUTHORIZED_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type YayaAuthorizedImageMediaType = (typeof YAYA_AUTHORIZED_IMAGE_MEDIA_TYPES)[number];

/**
 * 服务端当前授权投影出的图片：只有已授权、已处理的字节。
 * 该类型没有 URL 字段；运行期仍会拒绝混入的 url/signed_url/key。
 */
export interface YayaAuthorizedImage {
  image_id: string;
  media_type: YayaAuthorizedImageMediaType;
  data_base64: string;
  source: YayaSourceRef;
}

export interface YayaContextRequest {
  run_id: string;
  user_text: string;
  attachment_ids: readonly string[];
  identity: YayaCurrentIdentity;
}

/** 会话历史、来源标签、授权图片与指南静态参考都走当前授权投影 */
export interface YayaProjectedContext {
  history: readonly YayaContextTurn[];
  sources: readonly YayaSourceRef[];
  images: readonly YayaAuthorizedImage[];
  guide_catalog: string | null;
}

/* ---------------------------------- 模型端口 ---------------------------------- */

export type YayaModelRole = 'system' | 'user' | 'assistant';

export interface YayaModelMessage {
  role: YayaModelRole;
  text: string;
  images?: readonly YayaAuthorizedImage[];
}

export interface YayaModelRequest {
  run_id: string;
  messages: readonly YayaModelMessage[];
  signal: AbortSignal;
}

export interface YayaModelResponse {
  content: string;
  provider: string;
  model: string;
  /** 未知 usage 记 null，不填 0 */
  usage: LlmUsage | null;
}

export interface YayaModelGateway {
  generate(request: YayaModelRequest): Promise<YayaModelResponse>;
}

/* ---------------------------------- 依赖端口 ---------------------------------- */

export type YayaReadToolFailureCode =
  | 'denied'
  | 'forbidden_role'
  | 'out_of_scope'
  | 'empty_scope'
  | 'not_found'
  | 'failed'
  | 'unauthenticated'
  | 'identity_unavailable';

export type YayaReadToolOutcome =
  | { ok: true; data: unknown; source: YayaSourceRef }
  | { ok: false; code: YayaReadToolFailureCode; message: string };

export interface YayaReadToolInput {
  run_id: string;
  tool: string;
  params: unknown;
  identity: YayaCurrentIdentity;
}

export type YayaProposeWriteFailureCode =
  | 'denied'
  | 'forbidden_role'
  | 'out_of_scope'
  | 'empty_scope'
  | 'invalid_params'
  | 'unsupported'
  | 'failed'
  | 'unauthenticated'
  | 'identity_unavailable';

export type YayaProposeWriteOutcome =
  | { ok: true; proposals: readonly YayaOperationProposal[] }
  | { ok: false; code: YayaProposeWriteFailureCode; message: string };

export interface YayaProposeWriteInput {
  run_id: string;
  tool: string;
  params: unknown;
  identity: YayaCurrentIdentity;
  /** 模型提案来源固定标记，依赖端不得改写为教师卡片来源 */
  proposal_origin: 'model_suggestion';
}

export interface YayaOperationQueryInput {
  run_id: string;
  operation: YayaPlannedOperation;
  identity: YayaCurrentIdentity;
}

export interface YayaPublicSearchPolicyPort {
  provider_enabled: boolean;
  scanChildIdentifiers(input: { tool: string; params: unknown }): Promise<YayaChildIdentifierScan>;
}

/** 全部最小端口；正式服务在 TOOLS/DATA/MEDIA/AUTH 装配，测试使用替身 */
export interface YayaAgentDependencies {
  model: YayaModelGateway;
  resolveCurrentIdentity(input: { run_id: string }): Promise<YayaCurrentIdentity>;
  loadProjectedContext(input: YayaContextRequest): Promise<YayaProjectedContext>;
  readTool(input: YayaReadToolInput): Promise<YayaReadToolOutcome>;
  proposeWrite(input: YayaProposeWriteInput): Promise<YayaProposeWriteOutcome>;
  queryOperation(input: YayaOperationQueryInput): Promise<YayaOperationQueryOutcome>;
  publicSearchPolicy: YayaPublicSearchPolicyPort;
  tools: YayaToolCatalog;
}

/* ---------------------------------- 预算与上限 ---------------------------------- */

export interface YayaAgentBudgetState {
  model_attempts: number;
  tool_steps: number;
  tool_attempts: number;
  tool_retries: number;
}

export interface YayaAgentLimits {
  max_model_calls: number;
  max_tool_steps: number;
  max_tool_attempts: number;
  max_tool_retries: number;
  deadline_ms: number;
  model_wait_ms: number;
  tool_wait_ms: number;
}

export const DEFAULT_YAYA_AGENT_LIMITS: YayaAgentLimits = {
  max_model_calls: 8,
  max_tool_steps: 4,
  max_tool_attempts: 8,
  max_tool_retries: 1,
  deadline_ms: 90_000,
  model_wait_ms: 60_000,
  tool_wait_ms: 30_000,
};

/* ---------------------------------- 事件与结果 ---------------------------------- */

export const YAYA_AGENT_STOP_REASONS = [
  'cancelled',
  'deadline',
  'run_replaced',
  'identity_changed',
  'unauthenticated',
  'identity_unavailable',
  'session_invalid',
  'account_disabled',
  'max_model_calls',
  'max_tool_steps',
  'max_tool_attempts',
  'invalid_action',
  'invalid_params',
  'unknown_read_tool',
  'unknown_write_tool',
  'model_failed',
  'model_unsupported_capability',
  'tool_failed',
  'tool_unauthorized',
  'propose_failed',
  'source_mismatch',
] as const;
export type YayaAgentStopReason = (typeof YAYA_AGENT_STOP_REASONS)[number];

export type YayaAgentEvent =
  | { type: 'run_started'; run_id: string }
  | { type: 'model_attempted'; attempt: number }
  | { type: 'model_completed'; provider: string; model: string; usage: LlmUsage | null }
  | { type: 'action_parsed'; action: YayaAgentActionKind; tool: string | null }
  | {
      type: 'tool_result';
      tool: string;
      outcome: 'ok' | 'failed';
      source_kind: YayaProvenanceKind | null;
    }
  | {
      type: 'public_search_refused';
      tool: string;
      reason: 'provider_disabled' | 'identifiers_present' | 'scan_unknown_conservative';
    }
  | { type: 'proposal_prepared'; proposal: YayaOperationProposal }
  | { type: 'answer'; content: string; sources: readonly YayaSourceRef[] }
  | { type: 'clarify'; question: string }
  | { type: 'receipt'; operation_id: string; outcome: YayaOperationQueryOutcome }
  | { type: 'stopped'; reason: YayaAgentStopReason; detail: string | null };

export type YayaRunOutcome =
  | { kind: 'answered'; content: string; sources: readonly YayaSourceRef[] }
  | { kind: 'clarified'; question: string }
  | { kind: 'proposed'; proposals: readonly YayaOperationProposal[] }
  | { kind: 'stopped'; reason: YayaAgentStopReason; detail: string | null };

export interface YayaRunRequest {
  run_id: string;
  user_text: string;
  attachment_ids?: readonly string[];
  signal?: AbortSignal;
  onEvent?: (event: YayaAgentEvent) => void;
}

export interface YayaRunResult {
  outcome: YayaRunOutcome;
  events: readonly YayaAgentEvent[];
  budget: Readonly<YayaAgentBudgetState>;
}

export interface YayaRecoveryRequest {
  run_id: string;
  operations: readonly YayaPlannedOperation[];
  signal?: AbortSignal;
  onEvent?: (event: YayaAgentEvent) => void;
}

export interface YayaRecoveryEntry {
  operation: YayaPlannedOperation;
  outcome: YayaOperationQueryOutcome;
}

export interface YayaRecoveryResult {
  entries: readonly YayaRecoveryEntry[];
  events: readonly YayaAgentEvent[];
  stop_reason: YayaAgentStopReason | null;
  detail: string | null;
}
