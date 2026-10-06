/**
 * 芽芽 v1 存储层对外接口（YAYA-DATA1 发布）。
 *
 * 本文件是其他 owner（MEDIA1 / TOOLS1 / AGENT1-CORE / UI1）接入存储的唯一口径：
 * - DTO 与仓库函数签名在此发布；物理 SQL 只在 scripts/upgrade-yaya-v1.sql 与
 *   src/storage/database/shared/schema.ts 定义；
 * - `content_digest` 算法按冻结契约实现（SHA-256 / UTF-8 规范 JSON），
 *   服务端对 schema 校验后的 payload、动作/资源/目标与附件关联计算；
 * - 私有路由只消费这里的 DTO，不自行 fork 存储形状；
 * - 错误码与 HTTP 映射固定在本文件，路由统一走 `mapYayaDataError`。
 *
 * 不变量（与 contract-v1.md 对齐）：
 * - 会话/消息/提案按账号私有；管理员不自动拥有他人聊天；
 * - 原始输入与模型输出都是数据；批准只来自经认证、CSRF 保护的服务端入口记录；
 * - 批准快照（actor/session/资源事实/digest/附件/业务版本）一经保存不随当前值更新；
 * - 操作身份（operation_id）在 prepare 预分配；回执与业务写同一 TransactionClient；
 * - 附件删除租约先锁后删；查询不完整或无引用检查不合格一律禁止回收。
 */
import type { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import type { TransactionClient } from "@/storage/database/pg-client";
import type {
  AccessAction,
  AccessResource,
  AccessResourceKind,
  Principal,
} from "../accounts/types";
import type { ObservationStatus } from "../types";
import type {
  YayaApprovalItemRef,
  YayaApprovalSubmitter,
  YayaAttachmentAssociation,
  YayaAttachmentProjection,
  YayaChatMessageProjection,
  YayaDomainPayload,
  YayaFragmentProjection,
  YayaImageLifecycleFacts,
  YayaMessageSourceRef,
  YayaOperationQueryOutcome,
  YayaOperationReceipt,
  YayaPlannedOperation,
  YayaProposalItem,
  YayaProvenanceKind,
  YayaReceiptEffect,
  YayaReceiptStatus,
  YayaSourceRef,
  YayaToolAuth,
} from "./types";

/* ------------------------------- 错误语义 ------------------------------- */

export const YAYA_DATA_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "owner_mismatch",
  "revision_conflict",
  "idempotency_conflict",
  "approval_invalid",
  "approval_expired",
  "approval_consumed",
  "operation_not_found",
  "operation_started",
  "operation_unknown",
  "attachment_missing",
  "attachment_conflict",
  "attachment_referenced",
  "reference_incomplete",
  "observation_not_confirmed",
  "source_conflict",
  "server_error",
] as const;
export type YayaDataErrorCode = (typeof YAYA_DATA_ERROR_CODES)[number];

export const YAYA_DATA_ERROR_HTTP_STATUS: Record<YayaDataErrorCode, 400 | 404 | 409 | 500> = {
  invalid_request: 400,
  not_found: 404,
  owner_mismatch: 404,
  revision_conflict: 409,
  idempotency_conflict: 409,
  approval_invalid: 409,
  approval_expired: 409,
  approval_consumed: 409,
  operation_not_found: 404,
  operation_started: 409,
  operation_unknown: 409,
  attachment_missing: 409,
  attachment_conflict: 409,
  attachment_referenced: 409,
  reference_incomplete: 409,
  observation_not_confirmed: 409,
  source_conflict: 409,
  server_error: 500,
};

export class YayaDataError extends Error {
  constructor(
    public readonly code: YayaDataErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "YayaDataError";
  }
}

export interface YayaDataErrorBody {
  error: YayaDataErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** 错误映射：只暴露冻结错误体，未知错误统一 500，不泄露内部细节 */
export function mapYayaDataError(error: unknown): NextResponse<YayaDataErrorBody> {
  if (error instanceof YayaDataError) {
    return Response.json(
      {
        error: error.code,
        message: error.message,
        ...(error.details ? { details: { ...error.details } } : {}),
      },
      { status: YAYA_DATA_ERROR_HTTP_STATUS[error.code] },
    ) as NextResponse<YayaDataErrorBody>;
  }
  return Response.json(
    { error: "server_error", message: "服务器暂时无法处理该请求，请稍后重试。" },
    { status: 500 },
  ) as NextResponse<YayaDataErrorBody>;
}

/* ------------------------------- 内容 digest ------------------------------- */

export interface YayaDigestInput {
  payload: YayaDomainPayload;
  action: AccessAction;
  resource: AccessResourceKind;
  target_id: string;
  attachment_associations: readonly YayaAttachmentAssociation[];
}

const DIGEST_HEX = /^[0-9a-f]{64}$/;

/** 规范 JSON：对象键排序、数组保持业务顺序、拒绝 undefined/非有限数字/非 JSON 值 */
export function canonicalizeYayaValue(value: unknown): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new YayaDataError("invalid_request", "digest 输入包含非有限数字。");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalizeYayaValue(entry));
  if (kind !== "object") {
    throw new YayaDataError("invalid_request", "digest 输入包含非 JSON 值（undefined/函数/符号等）。");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new YayaDataError("invalid_request", "digest 输入包含非 JSON 对象。");
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) {
      throw new YayaDataError("invalid_request", `digest 输入字段 ${key} 为 undefined。`);
    }
    sorted[key] = canonicalizeYayaValue(entry);
  }
  return sorted;
}

/**
 * 内容 digest（SHA-256，UTF-8 十六进制）。
 * 附件关联按 (attachment_id, target_id) 排序；重复 attachment_id 直接拒绝。
 * 不包含密码/令牌/签名 URL；服务端始终用本函数重算，不采信请求体自报摘要。
 */
export function computeYayaContentDigest(input: YayaDigestInput): string {
  const seenAttachments = new Set<string>();
  for (const association of input.attachment_associations) {
    if (typeof association.attachment_id !== "string" || association.attachment_id.trim() === "") {
      throw new YayaDataError("invalid_request", "附件关联缺少 attachment_id。");
    }
    if (typeof association.target_id !== "string" || association.target_id.trim() === "") {
      throw new YayaDataError("invalid_request", "附件关联缺少 target_id。");
    }
    if (seenAttachments.has(association.attachment_id)) {
      throw new YayaDataError("invalid_request", "附件关联存在重复 attachment_id。");
    }
    seenAttachments.add(association.attachment_id);
  }
  const associations = [...input.attachment_associations]
    .map((entry) => ({ attachment_id: entry.attachment_id, target_id: entry.target_id }))
    .sort((a, b) =>
      a.attachment_id === b.attachment_id
        ? a.target_id.localeCompare(b.target_id)
        : a.attachment_id.localeCompare(b.attachment_id),
    );
  const canonical = canonicalizeYayaValue({
    action: input.action,
    attachment_associations: associations,
    payload: input.payload,
    resource: input.resource,
    target_id: input.target_id,
  });
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function isYayaDigestHex(value: unknown): value is string {
  return typeof value === "string" && DIGEST_HEX.test(value);
}

/** client_message_id 幂等比较用的消息内容摘要（不含身份与时间） */
export function computeYayaMessageDigest(input: {
  role: string;
  message_kind: string;
  fragments: unknown;
  attachment_ids: readonly string[];
}): string {
  const canonical = canonicalizeYayaValue({
    attachment_ids: [...input.attachment_ids],
    fragments: input.fragments,
    message_kind: input.message_kind,
    role: input.role,
  });
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/* ------------------------------- 安全常量 ------------------------------- */

/** 批准有效期：服务端固定 TTL（秒），不采信请求体 */
export const YAYA_APPROVAL_TTL_SECONDS = 24 * 60 * 60;

/** 单次 prepare / 单次批准可选操作数上界（有界批次） */
export const YAYA_MAX_BATCH_ITEMS = 20;

/* ------------------------------- 资源引用 ------------------------------- */

/**
 * prepare 阶段由 TOOLS1 提供的服务端资源引用；批准时用它重读当前资源事实，
 * 不采信任何请求体资源事实。形状与 AUTH `ResourceRef` 对齐。
 */
export type YayaItemResourceRef =
  | { kind: "school" }
  | { kind: "class"; class_id: string | null }
  | { kind: "child"; child_id: string }
  | { kind: "transfer"; child_id: string; target_class_id: string }
  | { kind: "observation"; observation_id: string };

/* ------------------------------- 会话与消息 ------------------------------- */

/**
 * 内部存储视图：**绝不可直接序列化给客户端**（含原始 title / title_source_fragments）。
 * 对外响应一律使用 `YayaConversationSummaryView`（投影视图，不含原始受限字段）。
 */
export interface YayaConversationView {
  conversation_id: string;
  owner_account_id: string;
  title: string | null;
  /** 合法来源片段 id 数组；`null` 表示损坏/无法核验（受限），`[]` 表示无派生来源（手工标题） */
  title_source_fragments: readonly string[] | null;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * 对外投影视图：只含投影后的标题与白名单字段；
 * 原始 `title` 与 `title_source_fragments` 不在本 DTO 中，服务端不把它们发给客户端。
 */
export interface YayaConversationSummaryView {
  conversation_id: string;
  owner_account_id: string;
  /** 服务端按当前来源投影后的标题；受限/损坏/无法核验时使用通用标题 */
  projected_title: string;
  title_restricted: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type YayaMessageRole = "user" | "assistant" | "tool";
export type YayaMessageKind = "text" | "image" | "tool_result" | "receipt" | "mixed";
export type YayaMessageExecutionState = "none" | "pending_approval" | "executed" | "unknown";

export interface YayaStoredFragment {
  fragment_id: string;
  text: string | null;
  sources: readonly YayaMessageSourceRef[];
  /** 服务端标记：该片段正文可在不泄漏受限来源的前提下独立展示 */
  independently_readable: boolean;
  provenance: YayaSourceRef;
}

export interface YayaProjectedFragmentView {
  fragment_id: string;
  visibility: "full" | "historical_read_only" | "hidden";
  reason: YayaFragmentProjection["reason"];
  /** 只有 full 片段返回正文；historical_read_only/hidden 一律 null */
  text: string | null;
  /** 只有 full 片段返回来源标签/ref；受限片段一律 null，防止经 provenance 旁路泄漏 */
  provenance: YayaSourceRef | null;
  independently_readable: boolean;
}

export interface YayaProjectedMessageView {
  message_id: string;
  conversation_id: string;
  owner_account_id: string;
  role: YayaMessageRole;
  message_kind: YayaMessageKind;
  execution_state: YayaMessageExecutionState;
  revision: number;
  created_at: string;
  projection: YayaChatMessageProjection;
  fragments: readonly YayaProjectedFragmentView[];
  attachment_ids: readonly string[];
  /** 无论投影如何都只含白名单元数据；hidden 时为 null */
  metadata: YayaChatMessageProjection["metadata"];
}

export interface YayaSaveMessageInput {
  conversation_id: string;
  client_message_id: string | null;
  role: YayaMessageRole;
  message_kind: YayaMessageKind;
  execution_state: YayaMessageExecutionState;
  fragments: readonly YayaStoredFragment[];
  attachment_ids: readonly string[];
  /** 版本前提：与会话当前 revision 不一致时拒绝追加 */
  expected_conversation_revision: number;
}

export interface YayaSaveMessageResult {
  message: YayaProjectedMessageView;
  conversation: YayaConversationSummaryView;
  /** true 表示 client_message_id 幂等命中，未重复落库 */
  replayed: boolean;
}

export interface YayaConversationMessagesView {
  conversation: YayaConversationSummaryView;
  messages: readonly YayaProjectedMessageView[];
}

export interface YayaCreateConversationInput {
  owner_account_id: string;
  title: string | null;
}

export interface YayaRenameConversationInput {
  principal: Principal;
  school_id: string;
  conversation_id: string;
  title: string | null;
  /** 标题派生自哪些消息片段；手工改名传空数组 */
  title_source_fragments?: readonly string[];
  expected_revision: number;
}

export interface YayaDeleteConversationInput {
  principal: Principal;
  school_id: string;
  conversation_id: string;
  expected_revision: number;
}

export interface YayaDeleteConversationResult {
  /** 对外投影视图（不含原始 title） */
  conversation: YayaConversationSummaryView;
  /** 本会话消息引用被解除的附件 id（去重） */
  detached_attachment_ids: readonly string[];
  /** 解除后全局已无任何引用的附件 id（仅候选；对象回收归 MEDIA1） */
  unreferenced_attachment_ids: readonly string[];
}

export interface YayaListMessagesOptions {
  /** 取最近 N 条（含），默认 100，上限 200 */
  limit?: number;
}

/* ------------------------------- 提案 ------------------------------- */

export interface YayaPrepareItemInput {
  item_key: string;
  target_id: string;
  action: AccessAction;
  resource: AccessResourceKind;
  resource_ref: YayaItemResourceRef;
  payload: YayaDomainPayload;
  attachment_associations: readonly YayaAttachmentAssociation[];
  business_revision: string | null;
}

export interface YayaPrepareProposalInput {
  conversation_id: string;
  proposal_origin: "teacher_card" | "model_suggestion";
  auth: YayaToolAuth;
  items: readonly YayaPrepareItemInput[];
}

export interface YayaPreparedItemView {
  item_key: string;
  operation_id: string;
  target_id: string;
  action: AccessAction;
  resource: AccessResourceKind;
  resource_ref: YayaItemResourceRef;
  payload: YayaDomainPayload;
  content_digest: string;
  attachment_associations: readonly YayaAttachmentAssociation[];
  business_revision: string | null;
  status: "pending" | "approved" | "rejected" | "superseded";
}

export interface YayaPreparedProposalView {
  proposal_id: string;
  batch_id: string;
  conversation_id: string;
  owner_account_id: string;
  proposal_origin: "teacher_card" | "model_suggestion";
  auth: YayaToolAuth;
  status: "open" | "cancelled" | "closed";
  prepared_at: string;
  items: readonly YayaPreparedItemView[];
}

/** 提案条目的当前业务来源访问结论 */
export type YayaProposalItemAccess =
  | "full"
  | "historical_read_only"
  | "denied"
  | "unavailable"
  | "broken";

/**
 * 提案条目对外投影：owner 边界之外再按**当前**业务来源授权投影；
 * 非 full 时 `payload` 一律 null，防撤权/转班后重开旧内容。
 */
export interface YayaProjectedProposalItemView {
  item_key: string;
  operation_id: string;
  target_id: string;
  action: AccessAction;
  resource: AccessResourceKind;
  resource_ref: YayaItemResourceRef;
  content_digest: string;
  attachment_associations: readonly YayaAttachmentAssociation[];
  business_revision: string | null;
  status: "pending" | "approved" | "rejected" | "superseded";
  access: YayaProposalItemAccess;
  payload: YayaDomainPayload | null;
}

/** 提案对外投影：执行内部读取仍用完整存储记录，本 DTO 只用于响应。 */
export interface YayaProjectedProposalView {
  proposal_id: string;
  batch_id: string;
  conversation_id: string;
  owner_account_id: string;
  proposal_origin: "teacher_card" | "model_suggestion";
  auth: YayaToolAuth;
  status: "open" | "cancelled" | "closed";
  prepared_at: string;
  items: readonly YayaProjectedProposalItemView[];
  /** 提案图片引用的读取投影（业务记录 + 上传者口径，与消息附件同一冻结口径） */
  attachments: readonly YayaAttachmentProjection[];
}

/* ------------------------------- 批准 ------------------------------- */

export interface YayaApprovalActionInput {
  action: "approve" | "reject" | "cancel";
  operation_ids: readonly string[];
}

export interface YayaApprovalView {
  approval_id: string;
  proposal_id: string;
  batch_id: string;
  actor_account_id: string;
  approval_source: "authenticated_entry" | "request_body_claim" | "model_output";
  approved_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  consumed_at: string | null;
  items: readonly YayaApprovalItemRef[];
}

export interface YayaRecordApprovalInput {
  proposal_id: string;
  operation_ids: readonly string[];
  principal: Principal;
  session_id: string;
  school_id: string;
  execution_at: string;
}

export interface YayaRecordApprovalResult {
  approval: YayaApprovalView;
  /** 同一提案上被本次新批准取代的旧 pending 批准（若有） */
  cancelled_approval_id: string | null;
}

export interface YayaRejectItemsInput {
  owner_account_id: string;
  proposal_id: string;
  operation_ids: readonly string[];
}

export interface YayaCancelApprovalInput {
  owner_account_id: string;
  proposal_id: string;
}

/* ------------------------------- 执行与回执 ------------------------------- */

export interface YayaBusinessWriteResult {
  status: YayaReceiptStatus;
  effect: YayaReceiptEffect;
  business_object_id: string | null;
  business_revision: string | null;
}

export interface YayaExecutionItemContext {
  operation: YayaPlannedOperation;
  proposal_item: YayaProposalItem;
  approval_item: YayaApprovalItemRef;
  proposal_origin: "teacher_card" | "model_suggestion";
}

export interface YayaExecuteApprovedInput {
  approval_id: string;
  operation_ids: readonly string[];
  submitter: YayaApprovalSubmitter;
  /** 当前园所 id（与 AUTH 同源，服务端传入；用于 school/class 资源事实读取） */
  school_id: string;
  /**
   * 当前业务版本解析器：批准快照中 business_revision 非 null 时必填，
   * 用于与当前事实比较（business_version_changed）。
   */
  resolveBusinessRevision?: (context: YayaExecutionItemContext) => Promise<string | null>;
  /** 业务变更回调：必须使用传入的同一个 client，不得另开连接或自行提交 */
  callback: (client: TransactionClient, context: YayaExecutionItemContext) => Promise<YayaBusinessWriteResult>;
}

export type YayaExecuteApproved = (
  client: TransactionClient,
  input: YayaExecuteApprovedInput,
) => Promise<readonly YayaOperationReceipt[]>;

export interface YayaOperationQueryView {
  operation_id: string;
  planned: YayaPlannedOperation;
  status: YayaReceiptStatus | null;
  superseded_by: string | null;
  started: boolean;
  outcome: YayaOperationQueryOutcome;
}

export interface YayaBatchQueryView {
  batch_id: string;
  operations: readonly YayaOperationQueryView[];
}

export interface YayaSupersedeInput {
  operation_id: string;
  actor_account_id: string;
  /** 替代的新身份（同事务内 prepare）：通常只含一项 */
  replacement: YayaPrepareProposalInput;
}

export interface YayaSupersedeResult {
  superseded_operation_id: string;
  cancelled_approval_ids: readonly string[];
  replacement: YayaPreparedProposalView;
}

/* ------------------------------- 附件 ------------------------------- */

/** 内部存储状态；媒体端口状态映射见 mapMediaAttachmentStatus（含 deletion_unknown） */
export const YAYA_ATTACHMENT_STATUSES = ["pending", "ready", "deleting", "deleted"] as const;
export type YayaAttachmentStatus = (typeof YAYA_ATTACHMENT_STATUSES)[number];

export const YAYA_ATTACHMENT_RECORD_KINDS = ["message", "proposal", "observation"] as const;
export type YayaAttachmentRecordKind = (typeof YAYA_ATTACHMENT_RECORD_KINDS)[number];

/** DATA1 通用附件登记（单对象）；媒体管线用 insertPendingAttachment/markAttachmentReady。 */
export interface YayaAttachmentMetadataInput {
  attachment_id?: string;
  uploader_account_id: string;
  conversation_id: string | null;
  object_key: string;
  media_type: string;
  byte_size: number;
  checksum_sha256: string;
  source_kind: YayaProvenanceKind;
  derived_from: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface YayaAttachmentView {
  attachment_id: string;
  uploader_account_id: string;
  conversation_id: string | null;
  object_key: string;
  media_type: string;
  byte_size: number;
  checksum_sha256: string;
  source_kind: YayaProvenanceKind;
  derived_from: string | null;
  metadata: Record<string, unknown> | null;
  status: YayaAttachmentStatus;
  revision: number;
  delete_result: "deleted" | "unknown" | null;
  deletion_lease_id: string | null;
  thumbnail_key: string | null;
  model_key: string | null;
  thumbnail_checksum: string | null;
  model_checksum: string | null;
  width: number | null;
  height: number | null;
  client_upload_id: string | null;
  deleting_started_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface YayaAttachmentRefView {
  ref_id: string;
  attachment_id: string;
  record_kind: YayaAttachmentRecordKind;
  record_id: string;
  linked_at: string;
  linked_by_account_id: string | null;
}

/** 与冻结图片生命周期事实同构；`reference_query_complete=false` 时禁止回收 */
export type YayaAttachmentLifecycleFacts = YayaImageLifecycleFacts;

export interface YayaLinkAttachmentInput {
  attachment_id: string;
  record_kind: YayaAttachmentRecordKind;
  record_id: string;
  linked_by_account_id: string;
}

export interface YayaAttachmentLeaseInput {
  attachment_id: string;
  expected_revision: number;
  actor_account_id: string;
}

export interface YayaAttachmentAppendInput {
  observation_id: string;
  attachment_ids: readonly string[];
  expected_attachment_revision: number;
  appended_by_account_id: string;
  approval_id: string | null;
  note: string | null;
  /**
   * 宿主确认来源前提：与宿主当前 status=confirmed 和 confirmed_at 在
   * 同一事务锁内比较；不一致/缺失一律拒绝（来源写进审计不等于前提成立）。
   */
  source_confirmed_at: string | null;
}

export interface YayaAttachmentAppendResult {
  observation_id: string;
  attachment_revision: number;
  appended_attachment_ids: readonly string[];
  appended_at: string;
}

export interface YayaObservationAttachmentView {
  observation_id: string;
  attachment_revision: number;
  updated_at: string | null;
}

/* --------------------------- 媒体附件存储接口（MEDIA 消费） --------------------------- */

/**
 * 与 MEDIA1 `AttachmentMetadataPort` 结构化一致的 DATA1 端口。
 * 字段/方法映射与错误码转换见 docs/yaya-v1/media-storage-interface-r1.md。
 */
export const YAYA_MEDIA_ATTACHMENT_STATUSES = [
  "pending",
  "ready",
  "deleting",
  "deleted",
  "deletion_unknown",
] as const;
export type YayaMediaAttachmentStatus = (typeof YAYA_MEDIA_ATTACHMENT_STATUSES)[number];

export const YAYA_MEDIA_INTERFACE_REVISION = "yaya-media-storage-r2" as const;

/** 媒体端口记录：只存对象标识/checksum/尺寸/状态，不含 URL */
export interface YayaMediaAttachmentRecord {
  attachment_id: string;
  owner_account_id: string;
  status: YayaMediaAttachmentStatus;
  /** 元数据修订；回收租约/落账的 CAS 身份 */
  revision: number;
  object_key: string;
  thumbnail_key: string;
  model_key: string;
  content_type: string;
  byte_size: number;
  checksum_sha256: string;
  thumbnail_checksum: string;
  model_checksum: string;
  /** 原始上传字节 SHA-256；既有/不完整行为 null，消费方必须按不可核验拒绝，不得伪造 */
  source_checksum: string | null;
  width: number;
  height: number;
  client_upload_id: string | null;
  created_at: string;
  updated_at: string;
  deleting_started_at: string | null;
  deleted_at: string | null;
  /** 回收租约令牌；仅端口 status=deleting 时非空 */
  deletion_lease_id: string | null;
}

export type YayaMediaDeletionLeaseResult =
  | { outcome: "acquired"; lease_token: string; record: YayaMediaAttachmentRecord }
  | { outcome: "referenced" }
  | { outcome: "reference_incomplete" }
  | { outcome: "revision_conflict" }
  | { outcome: "not_ready"; status: YayaMediaAttachmentStatus }
  | { outcome: "not_found" };

export interface YayaMediaObservationReferenceFact {
  observation_id: string;
  status: ObservationStatus;
}
export interface YayaMediaMessageReferenceFact {
  conversation_id: string;
  message_id: string;
}
export interface YayaMediaReferenceFacts {
  attachment_id: string;
  observation_refs: readonly YayaMediaObservationReferenceFact[];
  message_refs: readonly YayaMediaMessageReferenceFact[];
  proposal_refs: readonly string[];
}
export interface YayaMediaObservationReferencesResult {
  added: number;
  attachment_revision: number;
}
export interface YayaMediaAttachmentAuditEntry {
  audit_id: string;
  action: "attach_observation_images" | "create_observation_attachments";
  observation_id: string;
  attachment_ids: readonly string[];
  actor_account_id: string;
  source_confirmed_at: string | null;
  request_id: string | null;
  /** 批准来源（TOOLS1 批准执行时传入；教师直接追加为 null） */
  approval_id?: string | null;
  recorded_at: string;
}

export interface YayaAttachmentMetadataPort {
  findByClientUploadId(ownerAccountId: string, clientUploadId: string): Promise<YayaMediaAttachmentRecord | null>;
  insertPending(record: YayaMediaAttachmentRecord): Promise<void>;
  markReady(attachmentId: string): Promise<YayaMediaAttachmentRecord>;
  removePending(attachmentId: string): Promise<boolean>;
  get(attachmentId: string): Promise<YayaMediaAttachmentRecord | null>;
  addObservationReferences(input: {
    observation_id: string;
    attachment_ids: readonly string[];
    actor_account_id: string;
    /**
     * 归档追加（R2）：提供该字段时走观察附件 revision CAS（等价
     * addObservationReferencesAtRevision）；创建关联不提供，不做版本前提。
     */
    expected_attachment_revision?: number;
    /** 归档追加的宿主确认来源前提；提供 expected 时必须一并提供 */
    source_confirmed_at?: string | null;
  }): Promise<YayaMediaObservationReferencesResult>;
  /** 归档追加的显式 CAS 入口：必须携带 expected_revision 与宿主来源前提，复用同一原语 */
  addObservationReferencesAtRevision(input: {
    observation_id: string;
    attachment_ids: readonly string[];
    actor_account_id: string;
    expected_attachment_revision: number;
    source_confirmed_at: string | null;
  }): Promise<YayaMediaObservationReferencesResult>;
  getObservationAttachmentRevision(observationId: string): Promise<number>;
  getReferenceFacts(attachmentId: string): Promise<YayaMediaReferenceFacts>;
  releaseConversationReferences(input: {
    conversation_id: string;
    message_ids: readonly string[];
    owner_account_id: string;
  }): Promise<number>;
  /** 媒体租约：可选 expected_revision 做 CAS；有引用/不完整/进行中/已删除分别表达 */
  beginDeletionLease(attachmentId: string, expectedRevision?: number): Promise<YayaMediaDeletionLeaseResult>;
  completeDeletion(
    attachmentId: string,
    leaseToken: string,
    outcome: "deleted" | "unknown" | "failed",
  ): Promise<YayaMediaAttachmentRecord>;
  appendAttachmentAudit(entry: YayaMediaAttachmentAuditEntry): Promise<void>;
}

/* ------------------------------- 仓库接口 ------------------------------- */

/**
 * DATA1 发布的仓库接口。TOOLS1 只通过 `executeApprovedOperations` 消费批准；
 * 业务写回调必须使用同一 TransactionClient（通常包在既有 runBusinessWrite 内）。
 */
export interface YayaDataRepository {
  /* 会话与消息（私有） */
  createConversation(client: TransactionClient, input: YayaCreateConversationInput): Promise<YayaConversationView>;
  listConversations(client: TransactionClient, principal: Principal, schoolId: string): Promise<readonly YayaConversationSummaryView[]>;
  getConversation(client: TransactionClient, ownerAccountId: string, conversationId: string): Promise<YayaConversationView | null>;
  getConversationSummary(
    client: TransactionClient,
    principal: Principal,
    schoolId: string,
    conversationId: string,
  ): Promise<YayaConversationSummaryView | null>;
  renameConversation(client: TransactionClient, input: YayaRenameConversationInput): Promise<YayaConversationSummaryView>;
  deleteConversation(client: TransactionClient, input: YayaDeleteConversationInput): Promise<YayaDeleteConversationResult>;
  saveMessage(
    client: TransactionClient,
    principal: Principal,
    schoolId: string,
    input: YayaSaveMessageInput,
  ): Promise<YayaSaveMessageResult>;
  listMessages(
    client: TransactionClient,
    principal: Principal,
    schoolId: string,
    conversationId: string,
    options?: YayaListMessagesOptions,
  ): Promise<YayaConversationMessagesView>;

  /* 提案与批准 */
  prepareProposal(client: TransactionClient, input: YayaPrepareProposalInput & { owner_account_id: string }): Promise<YayaPreparedProposalView>;
  getProposal(client: TransactionClient, ownerAccountId: string, proposalId: string): Promise<YayaPreparedProposalView | null>;
  /** 对外投影：owner + 当前业务来源双重投影；内部执行读取仍用 getProposal */
  getProjectedProposal(
    client: TransactionClient,
    principal: Principal,
    schoolId: string,
    proposalId: string,
  ): Promise<YayaProjectedProposalView | null>;
  recordApproval(client: TransactionClient, input: YayaRecordApprovalInput): Promise<YayaRecordApprovalResult>;
  rejectProposalItems(client: TransactionClient, input: YayaRejectItemsInput): Promise<YayaPreparedProposalView>;
  cancelPendingApproval(client: TransactionClient, input: YayaCancelApprovalInput): Promise<{ cancelled_approval_id: string | null }>;
  getApproval(client: TransactionClient, ownerAccountId: string, proposalId: string): Promise<YayaApprovalView | null>;

  /* 执行、查询与替代 */
  executeApprovedOperations: YayaExecuteApproved;
  queryOperation(client: TransactionClient, ownerAccountId: string, operationId: string): Promise<YayaOperationQueryView | null>;
  queryBatch(client: TransactionClient, ownerAccountId: string, batchId: string): Promise<YayaBatchQueryView>;
  supersedeWithReplacement(client: TransactionClient, input: YayaSupersedeInput): Promise<YayaSupersedeResult>;

  /* 附件元数据与引用 */
  registerAttachment(client: TransactionClient, input: YayaAttachmentMetadataInput): Promise<YayaAttachmentView>;
  getAttachment(client: TransactionClient, attachmentId: string): Promise<YayaAttachmentView | null>;
  queryAttachmentLifecycle(client: TransactionClient, attachmentId: string): Promise<YayaAttachmentLifecycleFacts>;
  beginAttachmentDeletion(client: TransactionClient, input: YayaAttachmentLeaseInput): Promise<YayaAttachmentView>;
  commitAttachmentDeletion(client: TransactionClient, input: Omit<YayaAttachmentLeaseInput, "actor_account_id">): Promise<YayaAttachmentView>;
  failAttachmentDeletion(client: TransactionClient, input: Omit<YayaAttachmentLeaseInput, "actor_account_id">): Promise<YayaAttachmentView>;
  linkAttachmentRef(client: TransactionClient, input: YayaLinkAttachmentInput): Promise<YayaAttachmentRefView>;
  listAttachmentRefs(
    client: TransactionClient,
    record: { record_kind: YayaAttachmentRecordKind; record_id: string },
  ): Promise<readonly YayaAttachmentRefView[]>;
  appendObservationAttachments(client: TransactionClient, input: YayaAttachmentAppendInput): Promise<YayaAttachmentAppendResult>;
  getObservationAttachmentRevision(client: TransactionClient, observationId: string): Promise<YayaObservationAttachmentView>;

  /* 媒体附件存储接口（DATA1-R1，供 MEDIA1 端口消费） */
  findAttachmentByClientUploadId(
    client: TransactionClient,
    ownerAccountId: string,
    clientUploadId: string,
  ): Promise<YayaMediaAttachmentRecord | null>;
  insertPendingAttachment(client: TransactionClient, input: YayaMediaAttachmentRecord): Promise<YayaMediaAttachmentRecord>;
  markAttachmentReady(client: TransactionClient, attachmentId: string): Promise<YayaMediaAttachmentRecord>;
  removePendingAttachment(client: TransactionClient, attachmentId: string): Promise<boolean>;
  getMediaAttachment(client: TransactionClient, attachmentId: string): Promise<YayaMediaAttachmentRecord | null>;
  addObservationAttachmentRefs(
    client: TransactionClient,
    input: { observation_id: string; attachment_ids: readonly string[]; actor_account_id: string },
  ): Promise<YayaMediaObservationReferencesResult>;
  /** 归档追加 CAS（R2）：expected_revision 与宿主确认来源前提不匹配即拒绝 */
  addObservationAttachmentRefsAtRevision(
    client: TransactionClient,
    input: {
      observation_id: string;
      attachment_ids: readonly string[];
      actor_account_id: string;
      expected_attachment_revision: number;
      source_confirmed_at: string | null;
    },
  ): Promise<YayaMediaObservationReferencesResult>;
  getObservationAttachmentRevisionNumber(client: TransactionClient, observationId: string): Promise<number>;
  /** 三种引用完整返回；悬空引用/损坏按 reference_incomplete 抛错，调用方保守禁止回收 */
  getMediaAttachmentReferenceFacts(client: TransactionClient, attachmentId: string): Promise<YayaMediaReferenceFacts>;
  releaseConversationAttachmentRefs(
    client: TransactionClient,
    input: { conversation_id: string; message_ids: readonly string[]; owner_account_id: string },
  ): Promise<number>;
  acquireAttachmentDeletionLease(
    client: TransactionClient,
    attachmentId: string,
    expectedRevision?: number,
  ): Promise<YayaMediaDeletionLeaseResult>;
  completeAttachmentDeletionByLease(
    client: TransactionClient,
    input: { attachment_id: string; lease_token: string; outcome: "deleted" | "unknown" | "failed" },
  ): Promise<YayaMediaAttachmentRecord>;
  appendMediaAttachmentAudit(client: TransactionClient, entry: YayaMediaAttachmentAuditEntry): Promise<void>;
}
