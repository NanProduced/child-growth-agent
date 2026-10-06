/**
 * 芽芽 v1 可序列化 HTTP / 事件协议（YAYA-API0）。
 *
 * 本模块只发布**可序列化**的请求 / 响应 / 事件契约与纯校验函数，不创建
 * 任何 Next route、不装配服务、不调用模型 / 数据库 / 对象存储。
 * 正式运行 API 归 AGENT-APP1，operations POST 归 TOOLS1，UI1 只消费本协议。
 *
 * 复用口径（不维护影子协议）：
 * - 事件种类与停止原因复用 `agent/types.ts` 的 `YayaAgentEvent` /
 *   `YAYA_AGENT_STOP_REASONS`；线格式只加协议版本、run_id、seq 信封与
 *   显式终态 `run_end`；
 * - 提案 / 回执 / 查询结论 / 来源引用复用冻结的 `YayaOperationProposal`、
 *   `YayaOperationReceipt`、`YayaOperationQueryOutcome`、`YayaSourceRef`；
 * - `YayaRunRequest` 里的 `signal` / `onEvent` 是进程内对象，不能 JSON 化，
 *   因此浏览器请求改用本文件的 `YayaRunStartRequest`（服务器建立 run_id）。
 *
 * 安全边界：
 * - 新请求协议拒绝客户端自报 Principal / scope / 角色 / 批准身份（严格对象 +
 *   显式权威字段扫描）；服务器响应合法携带批准身份 / 摘要等字段，响应解析只
 *   扫描秘密字段，不套用请求禁止字段；
 * - 密码类管理动作只返回安全控件意图 / 目标，协议不接受也不返回任何秘密字段；
 * - 响应头未发送前允许 HTTP 错误；流已开始后失败必须是显式终态事件
 *   （`run_end`），不允许中途伪装成 HTTP 503；停止详情使用协议固定文案，
 *   不回传内部异常栈或未经校验的模型原始 JSON。
 *
 * 浏览器消费边界：本模块是 UI1 可直接打包的纯协议层，**不得引入
 * `node:crypto` / Next / 数据库 / 模型模块**；摘要格式校验在本文件内联
 * 实现，不导入服务器侧 `storage-types`。
 */
import { z } from "zod";

import { ACCESS_ACTIONS, ACCESS_RESOURCE_KINDS } from "../accounts/types";
import type { LlmUsage } from "../llm";
import { MEDIA_MAX_IMAGES_PER_UPLOAD } from "../media/limits";
import {
  compareBatchReceipts,
  itemsToResend,
  queryOperationOutcome,
  receiptProvesSuccess,
  YAYA_PAYLOAD_KINDS,
  YAYA_PROVENANCE_KINDS,
  YAYA_RECEIPT_EFFECTS,
  YAYA_RECEIPT_STATUSES,
  type YayaBatchComparison,
  type YayaDomainPayload,
  type YayaOperationProposal,
  type YayaOperationQueryOutcome,
  type YayaOperationReceipt,
  type YayaPlannedOperation,
  type YayaSourceRef,
  type YayaToolAuth,
} from "./types";
import {
  YAYA_AGENT_ACTIONS,
  YAYA_AGENT_STOP_REASONS,
  type YayaAgentEvent,
  type YayaAgentStopReason,
  type YayaRunOutcome,
} from "./agent/types";

/* ------------------------------- 协议常量 ------------------------------- */

/** NDJSON 事件流协议版本（每行一个事件，信封字段固定） */
export const YAYA_RUN_EVENT_PROTOCOL = "yaya-run-events-v1" as const;
export const YAYA_RUN_EVENT_CONTENT_TYPE = "application/x-ndjson; charset=utf-8" as const;

/** 一次运行最多引用的图片数（与 MEDIA 上传限额同源） */
export const YAYA_MAX_RUN_ATTACHMENTS = MEDIA_MAX_IMAGES_PER_UPLOAD;
export const YAYA_MAX_CLIENT_REQUEST_ID_LENGTH = 128;

/**
 * 接口路径表（AGENT-APP1 / TOOLS1 / UI1 共同口径）：
 * - 运行三接口归 AGENT-APP1；operations POST 归 TOOLS1；批准入口归 DATA1 且已存在；
 * - 只有 operations GET 与 approval 是已发布实现，其余为第二波接续契约。
 */
export const YAYA_API_PATHS = {
  run_start: "/api/yaya/conversations/{conversation_id}/runs",
  run_lookup: "/api/yaya/conversations/{conversation_id}/runs?client_request_id={client_request_id}",
  run_cancel: "/api/yaya/runs/{run_id}/cancel",
  operations_query: "/api/yaya/operations?operation_id={operation_id}",
  operations_execute: "/api/yaya/operations",
  approval: "/api/yaya/proposals/{proposal_id}/approval",
} as const;

/**
 * 内容摘要格式（与 storage-types.isYayaDigestHex 同口径，服务器仍负责计算）。
 * 协议层不导入 storage-types：其运行时引入 node:crypto，会破坏浏览器打包。
 */
const YAYA_CONTENT_DIGEST_HEX = /^[0-9a-f]{64}$/;
export function isYayaDigestHexWire(value: unknown): value is string {
  return typeof value === "string" && YAYA_CONTENT_DIGEST_HEX.test(value);
}

/** 语义深比较：对象键顺序无关；数组保持业务顺序；用于终态、提案与回执一致性 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => valuesEqual(entry, b[index]));
  }
  if (typeof a !== "object") return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
    return false;
  }
  return aKeys.every((key) => valuesEqual(aRecord[key], bRecord[key]));
}

/* ------------------------------- 违规与解析结果 ------------------------------- */

export const YAYA_API_VIOLATION_CODES = [
  "malformed_request",
  "forged_authority_field",
  "secret_field_present",
  "invalid_shape",
  "unsupported_protocol",
  "malformed_event",
  "run_mismatch",
  "missing_run_started",
  "sequence_duplicate",
  "sequence_gap",
  "event_after_terminal",
  "missing_terminal",
  "duplicate_terminal",
  "contradictory_terminal",
  "receipt_identity_mismatch",
  "contradictory_receipt",
  "unverified_success",
  "response_incomplete",
  "response_identity_mismatch",
] as const;
export type YayaApiViolationCode = (typeof YAYA_API_VIOLATION_CODES)[number];

export interface YayaApiViolation {
  code: YayaApiViolationCode;
  path: string;
  message: string;
}

export type YayaApiParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; violations: readonly YayaApiViolation[] };

function violation(
  code: YayaApiViolationCode,
  path: string,
  message: string,
): YayaApiViolation {
  return { code, path, message };
}

/* ------------------------------- 字段扫描 ------------------------------- */

/**
 * 客户端不得自报的权威字段。新协议请求体拒绝这些字段（递归键名扫描），
 * 服务端身份 / 范围 / 批准只能来自当前认证事实与批准记录。
 */
export const YAYA_FORGED_AUTHORITY_FIELDS = [
  "principal",
  "account_id",
  "actor_account_id",
  "owner_account_id",
  "role",
  "scope",
  "class_ids",
  "school_id",
  "session",
  "session_id",
  "csrf",
  "csrf_token",
  "csrf_verified",
  "approved",
  "approval",
  "approval_source",
  "runtime_approved",
  "runtime_approved_state",
  "content_digest",
  "resource_facts",
  "submitter",
  "execution_at",
] as const;

/** 秘密字段名：密码类管理动作与任何请求 / 事件都不得承载这些字段 */
export const YAYA_SECRET_FIELD_NAMES = [
  "password",
  "passcode",
  "secret",
  "token",
  "api_key",
  "apikey",
  "credential",
  "credentials",
  "authorization",
  "signature",
  "signed_url",
] as const;

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FORGED_AUTHORITY_NORMALIZED: ReadonlySet<string> = new Set(
  YAYA_FORGED_AUTHORITY_FIELDS.map(normalizeFieldName),
);
const SECRET_NORMALIZED: ReadonlySet<string> = new Set(
  YAYA_SECRET_FIELD_NAMES.map(normalizeFieldName),
);

function scanFieldNames(
  value: unknown,
  names: ReadonlySet<string>,
  path: string,
  hits: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanFieldNames(entry, names, `${path}[${index}]`, hits));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const fieldPath = path === "" ? key : `${path}.${key}`;
    if (names.has(normalizeFieldName(key))) hits.push(fieldPath);
    scanFieldNames(entry, names, fieldPath, hits);
  }
}

/** 返回命中的权威字段路径（空数组表示没有自报权威身份） */
export function findForgedAuthorityFields(value: unknown): string[] {
  const hits: string[] = [];
  scanFieldNames(value, FORGED_AUTHORITY_NORMALIZED, "", hits);
  return hits;
}

/** 返回命中的秘密字段路径（空数组表示不含密码 / 令牌等秘密） */
export function findSecretFields(value: unknown): string[] {
  const hits: string[] = [];
  scanFieldNames(value, SECRET_NORMALIZED, "", hits);
  return hits;
}

/**
 * 扫描模式：
 * - request：请求体禁止自报权威字段，也禁止任何秘密字段；
 * - response：服务器响应合法携带批准身份 / 摘要 / 资源事实，只禁止秘密字段；
 * - none：线事件载荷已由专属 schema 校验（payload 守卫另行排除秘密字段）。
 */
export type YayaScanMode = "request" | "response" | "none";

function scanViolations(input: unknown, mode: YayaScanMode): YayaApiViolation[] {
  const violations: YayaApiViolation[] = [];
  if (mode === "request") {
    for (const path of findForgedAuthorityFields(input)) {
      violations.push(
        violation(
          "forged_authority_field",
          path,
          "客户端不能自报身份 / 范围 / 角色 / 批准字段；服务端只认当前认证与批准记录。",
        ),
      );
    }
  }
  if (mode !== "none") {
    for (const path of findSecretFields(input)) {
      violations.push(
        violation("secret_field_present", path, "协议不接受密码 / 令牌等秘密字段。"),
      );
    }
  }
  return violations;
}

function zodViolations(error: z.ZodError, basePath: string): YayaApiViolation[] {
  return error.issues.map((issue) => {
    const where = issue.path.map((segment) => String(segment)).join(".");
    return violation(
      "malformed_request",
      where === "" ? basePath : basePath === "" ? where : `${basePath}.${where}`,
      issue.message || "字段不符合协议",
    );
  });
}

function parseWith<T>(
  input: unknown,
  schema: z.ZodType<T>,
  options: { scan?: YayaScanMode; basePath?: string } = {},
): YayaApiParseResult<T> {
  const basePath = options.basePath ?? "";
  const violations: YayaApiViolation[] =
    options.scan === undefined || options.scan === "none"
      ? []
      : scanViolations(input, options.scan);
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    violations.push(...zodViolations(parsed.error, basePath));
    return { ok: false, violations };
  }
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: parsed.data };
}

function nonBlankString(): z.ZodString {
  return z.string().refine((value) => value.trim().length > 0, "不能为空白字符串");
}

/* ------------------------------- 运行发起 ------------------------------- */

/**
 * 浏览器发起会话运行（服务器建立 run_id；不携带 signal/onEvent）。
 * `client_request_id` 由客户端生成并保持稳定：首响应丢失时凭 owner +
 * conversation_id + client_request_id 查回原运行，不要求先拿到 run_id。
 * `expected_conversation_revision` 是必要版本前提。
 */
export interface YayaRunStartRequest {
  conversation_id: string;
  client_request_id: string;
  user_text: string;
  attachment_ids: readonly string[];
  expected_conversation_revision: number;
}

export const yayaRunStartRequestSchema: z.ZodType<YayaRunStartRequest> = z
  .strictObject({
    conversation_id: nonBlankString(),
    client_request_id: nonBlankString().refine(
      (value) => value.length <= YAYA_MAX_CLIENT_REQUEST_ID_LENGTH,
      `client_request_id 最长 ${YAYA_MAX_CLIENT_REQUEST_ID_LENGTH} 字符`,
    ),
    user_text: z.string(),
    attachment_ids: z
      .array(nonBlankString())
      .max(YAYA_MAX_RUN_ATTACHMENTS, `一次最多引用 ${YAYA_MAX_RUN_ATTACHMENTS} 张图片`)
      .refine((ids) => new Set(ids).size === ids.length, "attachment_ids 不能重复"),
    expected_conversation_revision: z.number().int().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.user_text.trim() === "" && value.attachment_ids.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["user_text"],
        message: "文字与图片至少提供其一",
      });
    }
  });

export function parseYayaRunStartRequest(
  input: unknown,
): YayaApiParseResult<YayaRunStartRequest> {
  return parseWith(input, yayaRunStartRequestSchema, { scan: "request" });
}

/* ------------------------------- 原运行查询 ------------------------------- */

export const YAYA_RUN_LOOKUP_UNVERIFIABLE_REASONS = [
  "owner_binding_failed",
  "terminal_unreadable",
] as const;
export type YayaRunLookupUnverifiableReason =
  (typeof YAYA_RUN_LOOKUP_UNVERIFIABLE_REASONS)[number];

/**
 * 五态分开：缺失 / 运行中 / 已结束 / 不可核验 / 服务失败。
 * 查询只读，不启动模型、不执行旧批准、不产生任何业务写；服务失败不得冒充缺失。
 */
export type YayaRunLookupResponse =
  | { status: "missing" }
  | { status: "in_progress"; run_id: string }
  | { status: "finished"; run_id: string; outcome: YayaRunOutcome }
  | { status: "unverifiable"; reason: YayaRunLookupUnverifiableReason }
  | { status: "service_failure" };

export const yayaRunLookupResponseSchema: z.ZodType<YayaRunLookupResponse> =
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("missing") }),
    z.strictObject({ status: z.literal("in_progress"), run_id: nonBlankString() }),
    z.strictObject({
      status: z.literal("finished"),
      run_id: nonBlankString(),
      outcome: z.lazy(() => yayaRunOutcomeSchema),
    }),
    z.strictObject({
      status: z.literal("unverifiable"),
      reason: z.enum(YAYA_RUN_LOOKUP_UNVERIFIABLE_REASONS),
    }),
    z.strictObject({ status: z.literal("service_failure") }),
  ]);

export function parseYayaRunLookupResponse(
  input: unknown,
): YayaApiParseResult<YayaRunLookupResponse> {
  return parseWith(input, yayaRunLookupResponseSchema, { scan: "response" });
}

/** 数据层事实：由 AGENT-APP1 从 owner 绑定的运行记录读取，本模块只做分类 */
export type YayaRunLookupFacts =
  | { kind: "not_found" }
  | { kind: "query_failed" }
  | {
      kind: "found";
      run_id: string;
      owner_verified: boolean;
      state: { kind: "active" } | { kind: "terminal"; outcome: unknown };
    };

/**
 * 查询事实 → 五态响应。owner 绑定核不上、终态不可读一律 `unverifiable`；
 * 数据库/服务查询失败是 `service_failure`，绝不折叠成 `missing`。
 * stopped 终态的 detail 与实时事件同口径，统一替换为协议安全文案。
 */
export function classifyYayaRunLookup(facts: YayaRunLookupFacts): YayaRunLookupResponse {
  if (facts.kind === "query_failed") return { status: "service_failure" };
  if (facts.kind === "not_found") return { status: "missing" };
  if (!facts.owner_verified || facts.run_id.trim() === "") {
    return { status: "unverifiable", reason: "owner_binding_failed" };
  }
  if (facts.state.kind === "active") {
    return { status: "in_progress", run_id: facts.run_id };
  }
  const parsed = yayaRunOutcomeSchema.safeParse(facts.state.outcome);
  if (!parsed.success) return { status: "unverifiable", reason: "terminal_unreadable" };
  const outcome =
    parsed.data.kind === "stopped"
      ? { ...parsed.data, detail: safeYayaStopDetail(parsed.data.reason) }
      : parsed.data;
  return { status: "finished", run_id: facts.run_id, outcome };
}

/* ------------------------------- 取消运行 ------------------------------- */

/** 取消请求体必须为空（run_id 在路径）；权威 / 秘密字段一律拒绝 */
export type YayaRunCancelRequest = Record<string, never>;

export const yayaRunCancelRequestSchema: z.ZodType<YayaRunCancelRequest> = z.strictObject({});

export function parseYayaRunCancelRequest(
  input: unknown,
): YayaApiParseResult<YayaRunCancelRequest> {
  return parseWith(input, yayaRunCancelRequestSchema, { scan: "request" });
}

/**
 * 取消只承诺停止该 run 后续派发 / 消费；不宣称撤销已提交业务，
 * 也不保证上游物理请求已经取消（三个固定布尔把语义写进响应）。
 */
export interface YayaRunCancelResponse {
  run_id: string;
  status: "cancel_requested";
  stops_subsequent_dispatch: true;
  rolls_back_committed_business: false;
  upstream_http_cancel_verified: false;
}

export const yayaRunCancelResponseSchema: z.ZodType<YayaRunCancelResponse> = z.strictObject({
  run_id: nonBlankString(),
  status: z.literal("cancel_requested"),
  stops_subsequent_dispatch: z.literal(true),
  rolls_back_committed_business: z.literal(false),
  upstream_http_cancel_verified: z.literal(false),
});

export function parseYayaRunCancelResponse(
  input: unknown,
): YayaApiParseResult<YayaRunCancelResponse> {
  return parseWith(input, yayaRunCancelResponseSchema, { scan: "response" });
}

/* ------------------------------- 失败投递 ------------------------------- */

export type YayaRunFailureMode = "http_error" | "terminal_event";

/**
 * 响应头未发送前用 HTTP 错误（DATA/AUTH 冻结错误体）；
 * 流已开始后必须用显式终态事件，不能把中途失败伪装成 HTTP 503。
 */
export function selectYayaRunFailureMode(headersSent: boolean): YayaRunFailureMode {
  return headersSent ? "terminal_event" : "http_error";
}

/* ------------------------------- 共享 DTO 校验 ------------------------------- */

const yayaSourceRefSchema: z.ZodType<YayaSourceRef> = z.strictObject({
  kind: z.enum(YAYA_PROVENANCE_KINDS),
  ref_id: z.string().nullable(),
  label: z.string().nullable(),
  derived_from: z.string().nullable(),
});

const yayaLlmUsageSchema: z.ZodType<LlmUsage> = z.strictObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});

const yayaToolAuthSchema: z.ZodType<YayaToolAuth> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("scope_query") }),
  z.strictObject({
    kind: z.literal("action"),
    action: z.enum(ACCESS_ACTIONS),
    resource: z.enum(ACCESS_RESOURCE_KINDS),
  }),
]);

/**
 * 领域 payload 的线上守卫：只校验判别 kind 与秘密字段排除；
 * 逐 kind 的完整 schema 归 TOOLS1 / DATA（准备时已校验），本协议不复制第二套。
 */
export const yayaDomainPayloadWireSchema: z.ZodType<YayaDomainPayload> =
  z.custom<YayaDomainPayload>(
    (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      if (typeof record.kind !== "string") return false;
      if (!(YAYA_PAYLOAD_KINDS as readonly string[]).includes(record.kind)) return false;
      return findSecretFields(value).length === 0;
    },
    { message: "payload 不是已登记的领域动作或包含秘密字段" },
  );

export const yayaOperationProposalSchema: z.ZodType<YayaOperationProposal> = z.strictObject({
  proposal_id: nonBlankString(),
  batch_id: nonBlankString(),
  proposal_origin: z.enum(["teacher_card", "model_suggestion"]),
  auth: yayaToolAuthSchema,
  items: z
    .array(
      z.strictObject({
        item_key: nonBlankString(),
        target_id: z.string().nullable(),
        content_digest: z.string().refine(isYayaDigestHexWire, "content_digest 必须是 SHA-256 十六进制"),
        attachment_associations: z.array(
          z.strictObject({
            attachment_id: nonBlankString(),
            target_id: nonBlankString(),
          }),
        ),
        payload: yayaDomainPayloadWireSchema,
      }),
    )
    .min(1),
  prepared_at: nonBlankString(),
});

export const yayaOperationReceiptSchema: z.ZodType<YayaOperationReceipt> = z.strictObject({
  batch_id: nonBlankString(),
  proposal_id: nonBlankString(),
  item_key: nonBlankString(),
  operation_id: nonBlankString(),
  target_id: nonBlankString(),
  actor_account_id: nonBlankString(),
  status: z.enum(YAYA_RECEIPT_STATUSES),
  effect: z.enum(YAYA_RECEIPT_EFFECTS),
  business_object_id: z.string().nullable(),
  business_revision: z.string().nullable(),
  recorded_at: nonBlankString(),
});

export const yayaOperationQueryOutcomeSchema: z.ZodType<YayaOperationQueryOutcome> =
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("in_progress") }),
    z.strictObject({ kind: z.literal("failed"), effect: z.enum(YAYA_RECEIPT_EFFECTS) }),
    z.strictObject({ kind: z.literal("conflict") }),
    z.strictObject({ kind: z.literal("saved"), receipt: yayaOperationReceiptSchema }),
    z.strictObject({
      kind: z.literal("saved_detail_unavailable"),
      receipt: yayaOperationReceiptSchema,
    }),
    z.strictObject({
      kind: z.literal("unknown"),
      reason: z.enum([
        "no_receipt",
        "identity_mismatch",
        "contradictory_receipts",
        "invalid_success_proof",
        "verification_required",
      ]),
    }),
  ]);

export const yayaRunOutcomeSchema: z.ZodType<YayaRunOutcome> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("answered"),
    content: z.string(),
    sources: z.array(yayaSourceRefSchema),
  }),
  z.strictObject({ kind: z.literal("clarified"), question: z.string() }),
  z.strictObject({
    kind: z.literal("proposed"),
    proposals: z.array(yayaOperationProposalSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("stopped"),
    reason: z.enum(YAYA_AGENT_STOP_REASONS),
    detail: z.string().nullable(),
  }),
]);

/* ------------------------------- 事件线格式 ------------------------------- */

export interface YayaRunEnvelope {
  readonly protocol: typeof YAYA_RUN_EVENT_PROTOCOL;
  readonly run_id: string;
  readonly seq: number;
}

/** 每个流唯一的显式结束事件；此后不得再有事件 */
export interface YayaRunEndEvent extends YayaRunEnvelope {
  readonly type: "run_end";
  readonly outcome: YayaRunOutcome;
}

export type YayaRunAgentWireEvent = YayaAgentEvent & YayaRunEnvelope;
export type YayaRunWireEvent = YayaRunAgentWireEvent | YayaRunEndEvent;

const envelopeShape = {
  protocol: z.literal(YAYA_RUN_EVENT_PROTOCOL),
  run_id: nonBlankString(),
  seq: z.number().int().min(1),
};

function wireEvent<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject({ ...envelopeShape, ...shape });
}

export const yayaRunWireEventSchema: z.ZodType<YayaRunWireEvent> = z.discriminatedUnion(
  "type",
  [
    wireEvent({ type: z.literal("run_started") }),
    wireEvent({ type: z.literal("model_attempted"), attempt: z.number().int().min(1) }),
    wireEvent({
      type: z.literal("model_completed"),
      provider: z.string(),
      model: z.string(),
      usage: yayaLlmUsageSchema.nullable(),
    }),
    wireEvent({
      type: z.literal("action_parsed"),
      action: z.enum(YAYA_AGENT_ACTIONS),
      tool: z.string().nullable(),
    }),
    wireEvent({
      type: z.literal("tool_result"),
      tool: z.string(),
      outcome: z.enum(["ok", "failed"]),
      source_kind: z.enum(YAYA_PROVENANCE_KINDS).nullable(),
    }),
    wireEvent({
      type: z.literal("public_search_refused"),
      tool: z.string(),
      reason: z.enum(["provider_disabled", "identifiers_present", "scan_unknown_conservative"]),
    }),
    wireEvent({ type: z.literal("proposal_prepared"), proposal: yayaOperationProposalSchema }),
    wireEvent({
      type: z.literal("answer"),
      content: z.string(),
      sources: z.array(yayaSourceRefSchema),
    }),
    wireEvent({ type: z.literal("clarify"), question: z.string() }),
    wireEvent({
      type: z.literal("receipt"),
      operation_id: nonBlankString(),
      outcome: yayaOperationQueryOutcomeSchema,
    }),
    wireEvent({
      type: z.literal("stopped"),
      reason: z.enum(YAYA_AGENT_STOP_REASONS),
      detail: z.string().nullable(),
    }),
    wireEvent({ type: z.literal("run_end"), outcome: yayaRunOutcomeSchema }),
  ],
);

const YAYA_STOP_DETAIL_BY_REASON: Record<YayaAgentStopReason, string> = {
  cancelled: "运行已取消；已提交的业务不会被撤销。",
  deadline: "运行超过时间上限，已停止。",
  run_replaced: "该运行已被新的运行取代。",
  identity_changed: "当前身份已变化，本次运行已停止。",
  unauthenticated: "登录状态不可用，请登录后重试。",
  identity_unavailable: "身份服务暂时不可用，请稍后重试。",
  session_invalid: "登录状态已失效，请重新登录。",
  account_disabled: "账号已停用。",
  max_model_calls: "达到本次运行的模型调用上限，请缩小问题后重试。",
  max_tool_steps: "达到本次运行的工具步数上限，请缩小问题后重试。",
  max_tool_attempts: "达到本次运行的工具尝试上限，请缩小问题后重试。",
  invalid_action: "模型输出不符合动作协议，本次运行已停止。",
  invalid_params: "工具参数不符合协议，本次运行已停止。",
  unknown_read_tool: "请求的读取工具不在可用清单中。",
  unknown_write_tool: "请求的写入工具不在可用清单中。",
  model_failed: "模型调用失败，请稍后重试。",
  model_unsupported_capability: "当前模型不支持所需能力。",
  tool_failed: "工具执行失败，请稍后重试。",
  tool_unauthorized: "当前身份无权执行该操作。",
  propose_failed: "准备提案失败，请稍后重试。",
  source_mismatch: "来源校验不一致，本次运行已停止。",
  context_revoked: "当前授权已变化，本次运行已停止。",
  tool_protocol_unavailable: "工具参数协议不可用，本次运行已停止。",
};

/** 协议固定停止文案：不回传内部异常文本、堆栈或未经校验的模型原始 JSON */
export function safeYayaStopDetail(reason: YayaAgentStopReason): string {
  return YAYA_STOP_DETAIL_BY_REASON[reason];
}

/** 进程内 agent 事件 → 可序列化线事件；stopped 详情一律替换为协议文案 */
export function projectYayaAgentEvent(
  event: YayaAgentEvent,
  envelope: { run_id: string; seq: number },
): YayaRunWireEvent {
  const base = {
    protocol: YAYA_RUN_EVENT_PROTOCOL,
    run_id: envelope.run_id,
    seq: envelope.seq,
  } as const;
  if (event.type === "stopped") {
    return { ...base, ...event, detail: safeYayaStopDetail(event.reason) };
  }
  return { ...base, ...event };
}

/** 运行终态 → 显式结束事件；stopped 详情同样替换为协议文案 */
export function projectYayaRunEnd(
  outcome: YayaRunOutcome,
  envelope: { run_id: string; seq: number },
): YayaRunEndEvent {
  const base = {
    protocol: YAYA_RUN_EVENT_PROTOCOL,
    run_id: envelope.run_id,
    seq: envelope.seq,
  } as const;
  if (outcome.kind === "stopped") {
    return { ...base, type: "run_end", outcome: { ...outcome, detail: safeYayaStopDetail(outcome.reason) } };
  }
  return { ...base, type: "run_end", outcome };
}

/** 单事件 → 一行 NDJSON（含换行符） */
export function encodeYayaRunEventLine(event: YayaRunWireEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** 单行 NDJSON → 已校验事件；坏行 / 未注册字段 / 未知协议一律拒绝 */
export function parseYayaRunWireLine(line: string): YayaApiParseResult<YayaRunWireEvent> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {
      ok: false,
      violations: [violation("malformed_event", "", "事件行不是合法 JSON")],
    };
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    "protocol" in raw &&
    (raw as Record<string, unknown>).protocol !== YAYA_RUN_EVENT_PROTOCOL
  ) {
    return {
      ok: false,
      violations: [
        violation("unsupported_protocol", "protocol", "事件流协议版本不受支持"),
      ],
    };
  }
  const parsed = parseWith(raw, yayaRunWireEventSchema, { scan: "none" });
  if (parsed.ok) return parsed;
  return {
    ok: false,
    violations: parsed.violations.map((entry) => ({
      ...entry,
      code: "malformed_event" as const,
    })),
  };
}

/* ------------------------------- 事件流校验 ------------------------------- */

export type YayaRunStreamVerdict =
  | { ok: true; run_id: string; outcome: YayaRunOutcome; event_count: number }
  | { ok: false; run_id: string | null; violations: readonly YayaApiViolation[] };

/**
 * 流校验（纯函数）：协议版本、run 身份、序号连续、唯一终态、终态与已发布
 * 事件一致、回执身份与成功证明、合法幂等重放（完全相同的重复回执允许）。
 * 中断（缺终态 / 序号缺口）不猜结果，返回明确违规。
 */
export function validateYayaRunEventStream(
  events: readonly unknown[],
  expectedRunId?: string,
): YayaRunStreamVerdict {
  const violations: YayaApiViolation[] = [];
  if (events.length === 0) {
    return {
      ok: false,
      run_id: null,
      violations: [violation("missing_run_started", "", "事件流为空，缺少 run_started")],
    };
  }

  const parsed: YayaRunWireEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const result = parseWith(events[index], yayaRunWireEventSchema, {
      scan: "none",
      basePath: `events[${index}]`,
    });
    if (!result.ok) {
      const first = result.violations[0];
      violations.push(
        violation(
          "malformed_event",
          `events[${index}]`,
          first ? first.message : "事件不符合协议",
        ),
      );
    } else {
      parsed.push(result.value);
    }
  }
  if (violations.length > 0) return { ok: false, run_id: null, violations };

  const first = parsed[0];
  if (first === undefined || first.type !== "run_started") {
    violations.push(violation("missing_run_started", "events[0]", "事件流必须以 run_started 开始"));
  }

  const streamRunId = first?.run_id ?? null;
  for (let index = 0; index < parsed.length; index += 1) {
    const event = parsed[index];
    if (event === undefined) continue;
    if (streamRunId !== null && event.run_id !== streamRunId) {
      violations.push(
        violation("run_mismatch", `events[${index}].run_id`, "事件 run_id 与流内其他事件不一致"),
      );
    }
    if (expectedRunId !== undefined && event.run_id !== expectedRunId) {
      violations.push(
        violation("run_mismatch", `events[${index}].run_id`, "事件 run_id 与预期运行不一致"),
      );
    }
    if (event.seq < index + 1) {
      violations.push(
        violation("sequence_duplicate", `events[${index}].seq`, "事件序号重复或乱序"),
      );
    } else if (event.seq > index + 1) {
      violations.push(violation("sequence_gap", `events[${index}].seq`, "事件序号存在缺口，流可能中断"));
    }
  }

  const endIndexes = parsed
    .map((event, index) => (event.type === "run_end" ? index : -1))
    .filter((index) => index >= 0);
  if (endIndexes.length === 0) {
    violations.push(violation("missing_terminal", "", "事件流缺少 run_end 终态"));
  }
  if (endIndexes.length > 1) {
    violations.push(violation("duplicate_terminal", "", "事件流存在多个 run_end"));
  }
  const endIndex = endIndexes[0] ?? -1;
  if (endIndex >= 0 && endIndex !== parsed.length - 1) {
    violations.push(violation("event_after_terminal", `events[${endIndex + 1}]`, "run_end 之后不得再有事件"));
  }
  const end = endIndex >= 0 ? parsed[endIndex] : undefined;

  const answers = parsed.filter((event) => event.type === "answer");
  const clarifies = parsed.filter((event) => event.type === "clarify");
  const stoppeds = parsed.filter((event) => event.type === "stopped");
  const proposals = parsed.filter((event) => event.type === "proposal_prepared");
  const proposalIds = proposals.map((event) => event.proposal.proposal_id);
  if (new Set(proposalIds).size !== proposalIds.length) {
    violations.push(
      violation("contradictory_terminal", "", "提案身份重复或歧义，不得折叠成一致"),
    );
  }

  if (end !== undefined && end.type === "run_end") {
    const outcome = end.outcome;
    if (outcome.kind === "answered") {
      const answer = answers[0];
      if (
        answers.length !== 1 ||
        answer === undefined ||
        answer.content !== outcome.content ||
        valuesEqual(answer.sources, outcome.sources) === false
      ) {
        violations.push(violation("contradictory_terminal", "", "answer 事件与终态不一致"));
      }
      if (clarifies.length > 0 || proposals.length > 0 || stoppeds.length > 0) {
        violations.push(violation("contradictory_terminal", "", "终态为回答但存在其他终局事件"));
      }
    } else if (outcome.kind === "clarified") {
      const clarify = clarifies[0];
      if (
        clarifies.length !== 1 ||
        clarify === undefined ||
        clarify.question !== outcome.question
      ) {
        violations.push(violation("contradictory_terminal", "", "clarify 事件与终态不一致"));
      }
      if (answers.length > 0 || proposals.length > 0 || stoppeds.length > 0) {
        violations.push(violation("contradictory_terminal", "", "终态为澄清但存在其他终局事件"));
      }
    } else if (outcome.kind === "proposed") {
      if (proposals.length === 0 || proposals.length !== outcome.proposals.length) {
        violations.push(violation("contradictory_terminal", "", "提案事件与终态不一致"));
      } else if (
        valuesEqual(
          proposals.map((event) => event.proposal),
          outcome.proposals,
        ) === false
      ) {
        // 完整业务内容比对：同 proposal_id 但批次 / 目标 / 动作 / 原文 / 摘要 / 附件
        // 任一不同都判矛盾，重复或歧义不得折叠成一致。
        violations.push(violation("contradictory_terminal", "", "提案业务内容与终态不一致"));
      }
      if (answers.length > 0 || clarifies.length > 0 || stoppeds.length > 0) {
        violations.push(violation("contradictory_terminal", "", "终态为提案但存在其他终局事件"));
      }
    } else {
      const stopped = stoppeds[0];
      if (
        stoppeds.length !== 1 ||
        stopped === undefined ||
        stopped.reason !== outcome.reason ||
        stopped.detail !== outcome.detail
      ) {
        violations.push(violation("contradictory_terminal", "", "stopped 事件与终态不一致"));
      }
      if (answers.length > 0 || clarifies.length > 0 || proposals.length > 0) {
        violations.push(violation("contradictory_terminal", "", "终态为停止但存在其他终局事件"));
      }
    }
  }

  const receiptsByOperation = new Map<string, YayaOperationQueryOutcome[]>();
  for (const event of parsed) {
    if (event.type !== "receipt") continue;
    const outcome = event.outcome;
    if (
      (outcome.kind === "saved" || outcome.kind === "saved_detail_unavailable") &&
      outcome.receipt.operation_id !== event.operation_id
    ) {
      violations.push(
        violation("receipt_identity_mismatch", `receipt(${event.operation_id})`, "回执身份与原操作不一致"),
      );
    }
    if (
      (outcome.kind === "saved" || outcome.kind === "saved_detail_unavailable") &&
      !receiptProvesSuccess(outcome.receipt)
    ) {
      violations.push(
        violation("unverified_success", `receipt(${event.operation_id})`, "成功回执缺少完整成功证明"),
      );
    }
    const list = receiptsByOperation.get(event.operation_id);
    if (list === undefined) receiptsByOperation.set(event.operation_id, [outcome]);
    else list.push(outcome);
  }
  for (const [operationId, outcomes] of receiptsByOperation) {
    const head = outcomes[0];
    if (head === undefined) continue;
    if (!outcomes.every((entry) => valuesEqual(entry, head))) {
      violations.push(
        violation("contradictory_receipt", `receipt(${operationId})`, "同一操作回执互相矛盾"),
      );
    }
  }

  if (violations.length > 0 || end === undefined || end.type !== "run_end") {
    return { ok: false, run_id: streamRunId, violations };
  }
  return { ok: true, run_id: end.run_id, outcome: end.outcome, event_count: parsed.length };
}

/* ------------------------------- 批准请求（DATA 入口） ------------------------------- */

/**
 * DATA 批准入口的最小请求：只认 action 与 operation_ids；
 * 批准身份 / 摘要 / 资源事实由服务端从批准记录生成，客户端自报一律无效。
 * 具体路由与净身逻辑复用 DATA `normalizeApprovalAction`，本 schema 是其线上形状。
 */
export type YayaApprovalActionRequest =
  | { action: "approve" | "reject"; operation_ids: readonly string[] }
  | { action: "cancel" };

const approvalOperationIds = z
  .array(nonBlankString())
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "operation_ids 不能重复");

export const yayaApprovalActionRequestSchema: z.ZodType<YayaApprovalActionRequest> =
  z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("approve"), operation_ids: approvalOperationIds }),
    z.strictObject({ action: z.literal("reject"), operation_ids: approvalOperationIds }),
    z.strictObject({ action: z.literal("cancel") }),
  ]);

export function parseYayaApprovalActionRequest(
  input: unknown,
): YayaApiParseResult<YayaApprovalActionRequest> {
  return parseWith(input, yayaApprovalActionRequestSchema, { scan: "request" });
}

/* ------------------------------- 执行请求（TOOLS1 入口） ------------------------------- */

/**
 * operations POST 最小请求：只带批准身份与预分配 operation_id；
 * 提交者身份 / CSRF / 执行时刻由服务端解析，不得自报；
 * 请求体里的 approved / 模型 / 本地 tool part 都不是批准证明。
 */
export interface YayaOperationsExecuteRequest {
  approval_id: string;
  operation_ids: readonly string[];
}

export const yayaOperationsExecuteRequestSchema: z.ZodType<YayaOperationsExecuteRequest> =
  z.strictObject({
    approval_id: nonBlankString(),
    operation_ids: approvalOperationIds,
  });

export function parseYayaOperationsExecuteRequest(
  input: unknown,
): YayaApiParseResult<YayaOperationsExecuteRequest> {
  return parseWith(input, yayaOperationsExecuteRequestSchema, { scan: "request" });
}

export interface YayaOperationsExecuteResponse {
  receipts: readonly YayaOperationReceipt[];
}

export const yayaOperationsExecuteResponseSchema: z.ZodType<YayaOperationsExecuteResponse> =
  z.strictObject({ receipts: z.array(yayaOperationReceiptSchema).min(1) });

export function parseYayaOperationsExecuteResponse(
  input: unknown,
): YayaApiParseResult<YayaOperationsExecuteResponse> {
  return parseWith(input, yayaOperationsExecuteResponseSchema, { scan: "response" });
}

/* ------------------------------- 执行响应语义核验 ------------------------------- */

export interface YayaOperationsExecutionAssessment {
  response: YayaOperationsExecuteResponse;
  /** 复用冻结 `compareBatchReceipts`：缺项 / 多出 / 重复 / 矛盾 / 未证明成功 */
  comparison: YayaBatchComparison;
  /** 逐项查询语义，复用冻结 `queryOperationOutcome` */
  outcomes: readonly { operation_id: string; outcome: YayaOperationQueryOutcome }[];
  /** 显式恢复候选（仅“明确失败且确认无效果”），协议不自动重发 */
  explicit_resend_candidates: readonly YayaOperationReceipt[];
}

/**
 * operations POST 响应的**语义**核验（结构合法 ≠ 业务已保存）：
 * - 先做结构解析（response 扫描），再按 DATA prepare 的完整预期计划对账；
 * - 成功声明必须通过冻结 `receiptProvesSuccess`（saved + effect=unknown +
 *   空业务标识一律不算成功）；
 * - 缺项 / 身份错配（错 target / 错 actor / 多出）/ 矛盾回执 / 未证明成功
 *   一律拒绝，不能渲染全成功；
 * - 合法的 failed / in_progress / unknown 与 `unchanged` 保留在 comparison 与
 *   outcomes 中，不因非成功被丢弃；合法幂等重复回执允许（仍表达为重复）。
 */
export function assessYayaOperationsExecutionResponse(
  plan: readonly YayaPlannedOperation[],
  input: unknown,
): YayaApiParseResult<YayaOperationsExecutionAssessment> {
  const parsed = parseYayaOperationsExecuteResponse(input);
  if (!parsed.ok) return parsed;
  const receipts = parsed.value.receipts;
  const comparison = compareBatchReceipts(plan, receipts);
  const violations: YayaApiViolation[] = [];

  if (
    comparison.duplicate_plan_operation_ids.length > 0 ||
    comparison.duplicate_plan_item_keys.length > 0
  ) {
    violations.push(violation("invalid_shape", "plan", "预期计划存在重复身份，无法对账"));
  }
  for (const operationId of comparison.missing_operation_ids) {
    violations.push(
      violation("response_incomplete", `receipt(${operationId})`, "缺少该操作的合法回执"),
    );
  }
  for (const operationId of comparison.unexpected_operation_ids) {
    violations.push(
      violation(
        "response_identity_mismatch",
        `receipt(${operationId})`,
        "回执身份（batch/proposal/item/target/actor）与预期计划不一致",
      ),
    );
  }
  for (const operationId of comparison.contradictory_operation_ids) {
    violations.push(
      violation("contradictory_receipt", `receipt(${operationId})`, "同一操作回执互相矛盾"),
    );
  }
  for (const operationId of comparison.unverified_success_operation_ids) {
    violations.push(
      violation("unverified_success", `receipt(${operationId})`, "成功声明缺少完整成功证明"),
    );
  }
  if (violations.length > 0) return { ok: false, violations };

  return {
    ok: true,
    value: {
      response: parsed.value,
      comparison,
      outcomes: plan.map((operation) => ({
        operation_id: operation.operation_id,
        outcome: queryOperationOutcome(receipts, operation),
      })),
      explicit_resend_candidates: itemsToResend(plan, receipts),
    },
  };
}

/* ------------------------------- 密码安全控件意图 ------------------------------- */

export const YAYA_SECURE_CONTROL_KINDS = [
  "teacher_password_reset",
  "teacher_account_create",
] as const;
export type YayaSecureControlKind = (typeof YAYA_SECURE_CONTROL_KINDS)[number];

/**
 * 密码相关管理动作只返回“打开安全控件 + 目标”：秘密由安全窗口直接提交
 * 服务端，不经过聊天、事件或任何请求 / 响应体。
 */
export interface YayaSecureControlIntent {
  secure_control: YayaSecureControlKind;
  target_account_id: string | null;
  secrets_in_protocol: false;
}

export function projectYayaSecureControlIntent(
  input: unknown,
): YayaApiParseResult<YayaSecureControlIntent> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      violations: [violation("invalid_shape", "", "安全控件输入必须是对象")],
    };
  }
  const secrets = findSecretFields(input);
  if (secrets.length > 0) {
    return {
      ok: false,
      violations: secrets.map((path) =>
        violation("secret_field_present", path, "安全控件意图不得携带密码 / 令牌字段"),
      ),
    };
  }
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(YAYA_SECURE_CONTROL_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      violations: [violation("invalid_shape", "kind", "未登记的安全控件种类")],
    };
  }
  const target = record.target_account_id;
  if (target !== null && (typeof target !== "string" || target.trim() === "")) {
    return {
      ok: false,
      violations: [violation("invalid_shape", "target_account_id", "目标账号不合法")],
    };
  }
  return {
    ok: true,
    value: {
      secure_control: kind as YayaSecureControlKind,
      target_account_id: target,
      secrets_in_protocol: false,
    },
  };
}
