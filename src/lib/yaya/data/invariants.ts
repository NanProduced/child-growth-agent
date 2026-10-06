/**
 * YAYA-DATA1 纯不变量与守卫（无数据库、无模型、无 Next 依赖）。
 *
 * 这些函数是路由与仓库共用的判定核心，也是 check-data.ts 的反例对象：
 * - prepare 形状校验（空白业务 ID / 重复 item_key / 非法组合 / ref 类型错配）；
 * - client_message_id 幂等回放与版本前提；
 * - 消息正文投影（非 full 片段不外泄正文）与 owner 判定；
 * - 回执结果守卫（成功证明不完整不得落账）；
 * - 替代资格与旧迟到消费拒绝；
 * - 删除会话的附件引用解除计划与租约 CAS。
 */
import { isLegalAccessCombination } from "../../accounts/authorize";
import type { AccessAction, AccessResourceKind } from "../../accounts/types";
import type {
  YayaAttachmentAssociation,
  YayaDomainPayload,
  YayaFragmentProjection,
  YayaImageLifecycleFacts,
  YayaOperationReceipt,
  YayaReceiptEffect,
  YayaReceiptStatus,
  YayaSourceRef,
} from "../types";
import {
  YayaDataError,
  type YayaAttachmentStatus,
  type YayaItemResourceRef,
  type YayaMediaAttachmentStatus,
  type YayaProposalItemAccess,
  type YayaStoredFragment,
} from "../storage-types";

export interface YayaPrepareItemValidationInput {
  item_key: string;
  target_id: string;
  action: AccessAction;
  resource: AccessResourceKind;
  resource_ref: YayaItemResourceRef;
  content_digest: string;
  attachment_associations: readonly YayaAttachmentAssociation[];
  payload: YayaDomainPayload;
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * prepare 逐项形状校验：返回稳定的错误码列表（每项最多一个结构错误），
 * 重复 item_key 在所有项之间判定。不采信请求体 digest；digest 由服务端重算。
 */
export function validatePrepareItems(
  items: readonly YayaPrepareItemValidationInput[],
): string[] {
  if (items.length === 0) return ["empty_items"];
  const errors: string[] = [];
  const keys = new Set<string>();
  let duplicateKey = false;
  for (const item of items) {
    if (isBlank(item.item_key)) {
      errors.push("blank_item_key");
      continue;
    }
    if (keys.has(item.item_key)) duplicateKey = true;
    keys.add(item.item_key);
    if (isBlank(item.target_id)) {
      errors.push("blank_target_id");
      continue;
    }
    if (!isLegalAccessCombination(item.action, item.resource)) {
      errors.push("illegal_combination");
      continue;
    }
    const ref = item.resource_ref;
    if (ref.kind !== item.resource) {
      errors.push("resource_ref_mismatch");
      continue;
    }
    if (ref.kind === "transfer" && isBlank(ref.target_class_id)) {
      errors.push("blank_target_class");
      continue;
    }
    if (ref.kind === "child" && isBlank(ref.child_id)) {
      errors.push("blank_target_id");
      continue;
    }
    if (ref.kind === "observation" && isBlank(ref.observation_id)) {
      errors.push("blank_target_id");
      continue;
    }
  }
  if (duplicateKey) errors.push("duplicate_item_key");
  return errors;
}

/** 服务端重算 digest 与准备值比较；不一致不得进入批准快照 */
export function verifyItemDigest(
  item: YayaPrepareItemValidationInput,
  serverDigest: string,
): "ok" | "digest_mismatch" {
  return item.content_digest === serverDigest ? "ok" : "digest_mismatch";
}

/* ------------------------------ 批准请求净身 ------------------------------ */

export interface YayaNormalizedApprovalAction {
  action: "approve" | "reject" | "cancel";
  operation_ids: string[];
}

/**
 * 只从批准请求体提取 action/operation_ids；approved/scope/Principal/资源事实/
 * digest 等一切自报字段一律丢弃，不参与任何判定。
 */
export function normalizeApprovalAction(body: unknown): YayaNormalizedApprovalAction {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new YayaDataError("invalid_request", "批准请求体必须是对象。");
  }
  const record = body as Record<string, unknown>;
  const action = record.action;
  if (action !== "approve" && action !== "reject" && action !== "cancel") {
    throw new YayaDataError("invalid_request", "批准动作不合法。");
  }
  const rawIds = record.operation_ids;
  if (action === "cancel") {
    return { action, operation_ids: [] };
  }
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new YayaDataError("invalid_request", "必须明确选择要处理的 operation_id 集合。");
  }
  const seen = new Set<string>();
  const operationIds: string[] = [];
  for (const entry of rawIds) {
    if (isBlank(entry)) {
      throw new YayaDataError("invalid_request", "operation_id 不能为空。");
    }
    if (seen.has(entry as string)) {
      throw new YayaDataError("invalid_request", "operation_id 集合存在重复。");
    }
    seen.add(entry as string);
    operationIds.push(entry as string);
  }
  return { action, operation_ids: operationIds };
}

/* ------------------------------ 幂等与版本 ------------------------------ */

export type YayaClientMessageReplay = "insert" | "replay" | "idempotency_conflict";

export function resolveClientMessageReplay(
  existing: { content_digest: string } | null,
  incomingDigest: string,
): YayaClientMessageReplay {
  if (existing === null) return "insert";
  return existing.content_digest === incomingDigest ? "replay" : "idempotency_conflict";
}

export function checkConversationRevision(
  current: number,
  expected: number,
): "ok" | "revision_conflict" {
  return current === expected ? "ok" : "revision_conflict";
}

export function operationOwnedBy(actorAccountId: string, viewerAccountId: string): boolean {
  return actorAccountId === viewerAccountId;
}

/* ------------------------------ 消息正文投影 ------------------------------ */

export interface YayaVisibleFragmentText {
  fragment_id: string;
  visibility: "full" | "historical_read_only" | "hidden";
  text: string | null;
}

/**
 * 只有 full 片段返回正文；historical_read_only/hidden 与缺失投影一律 null。
 * 未定义来源片段（投影缺失）按 hidden 保守处理，不默认 full。
 */
export function projectStoredMessageText(
  fragments: readonly YayaStoredFragment[],
  projections: readonly YayaFragmentProjection[],
): YayaVisibleFragmentText[] {
  return fragments.map((fragment) => {
    const projection = projections.find((entry) => entry.fragment_id === fragment.fragment_id);
    if (projection === undefined) {
      return { fragment_id: fragment.fragment_id, visibility: "hidden" as const, text: null };
    }
    return {
      fragment_id: fragment.fragment_id,
      visibility: projection.visibility,
      text: projection.visibility === "full" ? fragment.text : null,
    };
  });
}

/* ------------------------------ 执行回执守卫 ------------------------------ */

export interface YayaBusinessWriteResultInput {
  status: YayaReceiptStatus;
  effect: YayaReceiptEffect;
  business_object_id: string | null;
  business_revision: string | null;
}

/**
 * 成功三态（saved / saved_detail_unavailable / unchanged）必须同时具备
 * effect=committed 与非空白业务对象标识；否则不得作为成功落账。
 */
export function guardBusinessWriteResult(result: YayaBusinessWriteResultInput): string[] {
  const successStatus =
    result.status === "saved" ||
    result.status === "saved_detail_unavailable" ||
    result.status === "unchanged";
  if (!successStatus) return [];
  const hasBusinessId =
    typeof result.business_object_id === "string" && result.business_object_id.trim() !== "";
  return result.effect === "committed" && hasBusinessId ? [] : ["invalid_success_proof"];
}

/* ------------------------------ 替代与迟到消费 ------------------------------ */

export interface YayaOperationRowFacts {
  receipt_status: YayaReceiptStatus | null;
  started_at: string | null;
  superseded_by: string | null;
}

export type YayaSupersedeEligibility =
  | "eligible"
  | "already_executed"
  | "in_progress"
  | "already_superseded";

export function operationSupersedeEligibility(row: YayaOperationRowFacts): YayaSupersedeEligibility {
  if (row.superseded_by !== null) return "already_superseded";
  if (row.receipt_status !== null) return "already_executed";
  if (row.started_at !== null) return "in_progress";
  return "eligible";
}

export type YayaExecutionGuard = "ok" | "superseded" | "started" | "already_executed";

export function guardExecutionAgainstOperation(row: YayaOperationRowFacts): YayaExecutionGuard {
  if (row.superseded_by !== null) return "superseded";
  if (row.receipt_status !== null) return "already_executed";
  if (row.started_at !== null) return "started";
  return "ok";
}

/* ------------------------------ 附件引用与租约 ------------------------------ */

export interface YayaConversationAttachmentRefPlan {
  complete: boolean;
  detach_message_refs: readonly { conversation_id: string; message_id: string }[];
  unreferenced: readonly string[];
}

/**
 * 删除某个会话时该会话消息引用的解除计划：
 * - 引用查询不完整 → 不解除、不产生回收候选（后续禁止物理删除）；
 * - 只解除 deletingConversationId 自己的消息引用；
 * - 观察/提案引用与其他会话消息引用保留；
 * - `unreferenced` 仅在解除后全局无任何引用时给出（对象回收仍归 MEDIA1）。
 */
export function planConversationAttachmentRefs(
  facts: YayaImageLifecycleFacts,
  deletingConversationId: string,
): YayaConversationAttachmentRefPlan {
  if (!facts.reference_query_complete) {
    return { complete: false, detach_message_refs: [], unreferenced: [] };
  }
  const detach = facts.message_refs.filter(
    (ref) => ref.conversation_id === deletingConversationId,
  );
  const remaining =
    facts.observation_refs.length +
    facts.proposal_refs.length +
    facts.message_refs.filter((ref) => ref.conversation_id !== deletingConversationId).length;
  return {
    complete: true,
    detach_message_refs: detach,
    unreferenced: remaining === 0 && detach.length > 0 ? [facts.image_id] : [],
  };
}

export interface YayaAttachmentLeaseState {
  status: YayaAttachmentStatus;
  revision: number;
  delete_result: "deleted" | "unknown" | null;
}

export type YayaAttachmentLeaseAction =
  | { action: "begin"; expected_revision: number }
  | { action: "commit_delete"; expected_revision: number }
  | { action: "fail_delete"; expected_revision: number };

export type YayaAttachmentLeaseTransition =
  | { ok: true; next: YayaAttachmentLeaseState }
  | { ok: false; reason: "revision_conflict" | "not_ready" | "not_deleting" };

/**
 * 删除租约状态机（CAS）：
 * - begin：仅 ready 且 revision 匹配 → deleting；
 * - commit_delete：仅 deleting 且 revision 匹配 → deleted（delete_result=deleted）；
 * - fail_delete：仅 deleting 且 revision 匹配 → 保持 deleting + delete_result=unknown
 *   （外部删除结果未知，绝不恢复 ready，也绝不伪装 deleted）。
 */
export function attachmentLeaseTransition(
  current: YayaAttachmentLeaseState,
  action: YayaAttachmentLeaseAction,
): YayaAttachmentLeaseTransition {
  const revisionMatches = current.revision === action.expected_revision;
  if (action.action === "begin") {
    if (current.status !== "ready") return { ok: false, reason: "not_ready" };
    if (!revisionMatches) return { ok: false, reason: "revision_conflict" };
    return {
      ok: true,
      next: { status: "deleting", revision: current.revision + 1, delete_result: null },
    };
  }
  if (current.status !== "deleting") return { ok: false, reason: "not_deleting" };
  if (!revisionMatches) return { ok: false, reason: "revision_conflict" };
  if (action.action === "commit_delete") {
    return {
      ok: true,
      next: { status: "deleted", revision: current.revision + 1, delete_result: "deleted" },
    };
  }
  return {
    ok: true,
    next: { status: "deleting", revision: current.revision + 1, delete_result: "unknown" },
  };
}

/* ------------------------------ 消息附件守卫 ------------------------------ */

export interface YayaMessageAttachmentFacts {
  attachment_id: string;
  uploader_account_id: string;
  status: YayaAttachmentStatus | "absent";
}

export function validateMessageAttachments(
  ownerAccountId: string,
  attachments: readonly YayaMessageAttachmentFacts[],
): string[] {
  const errors: string[] = [];
  for (const attachment of attachments) {
    if (attachment.status === "absent") {
      errors.push(`attachment_missing:${attachment.attachment_id}`);
      continue;
    }
    if (attachment.uploader_account_id !== ownerAccountId) {
      errors.push(`attachment_owner_mismatch:${attachment.attachment_id}`);
      continue;
    }
    if (attachment.status !== "ready") {
      errors.push(`attachment_conflict:${attachment.attachment_id}`);
    }
  }
  return errors;
}

/* ------------------------------ 会话标题来源与脱敏 ------------------------------ */

export type YayaConversationTitleSourceState = "valid" | "none" | "corrupt" | "missing";

/**
 * 标题来源状态：
 * - valid：合法字符串数组（可能为空 → 由调用方按 none 区分）；
 * - none：明确的无派生来源（手工标题）；
 * - corrupt：非数组或含非字符串（损坏，必须按受限处理）；
 * - missing：列缺失/无法核验（必须按受限处理，不得当作手工标题）。
 */
export function conversationTitleSourceState(value: unknown): YayaConversationTitleSourceState {
  if (value === null || value === undefined) return "missing";
  if (!Array.isArray(value)) return "corrupt";
  if (value.length === 0) return "none";
  if (value.some((entry) => typeof entry !== "string")) return "corrupt";
  return "valid";
}

/** 非 full 片段一律不携带 provenance（label/ref/derived_from 可能是受限旁路） */
export function redactProvenanceForVisibility(
  visibility: "full" | "historical_read_only" | "hidden",
  provenance: YayaSourceRef | null,
): YayaSourceRef | null {
  return visibility === "full" ? provenance : null;
}

/**
 * 同一提案内多个匹配条目共享同一附件时取最佳合法投影：
 * full > historical_read_only > 无（denied/unavailable/broken 不覆盖其他条目的合法投影），
 * 结果与条目顺序无关。
 */
export function aggregateProposalRecordAccess(
  accesses: readonly YayaProposalItemAccess[],
): "full" | "historical_read_only" | null {
  let best: "full" | "historical_read_only" | null = null;
  for (const access of accesses) {
    if (access === "full") return "full";
    if (access === "historical_read_only") best = "historical_read_only";
  }
  return best;
}

/** 附件引用写入的稳定锁序：去重后按 attachment_id 排序（同一事务内统一顺序防死锁） */
export function sortAttachmentLockIds(attachmentIds: readonly string[]): string[] {
  return [...new Set(attachmentIds)].sort();
}

/* ------------------------------ 媒体端口状态与租约 ------------------------------ */

export function mapMediaAttachmentStatus(
  status: YayaAttachmentStatus,
  deleteResult: "deleted" | "unknown" | null,
): YayaMediaAttachmentStatus {
  if (status === "deleting") return deleteResult === "unknown" ? "deletion_unknown" : "deleting";
  return status;
}

export interface YayaMediaLeaseState {
  status: YayaAttachmentStatus;
  delete_result: "deleted" | "unknown" | null;
  deletion_lease_id: string | null;
}

export type YayaMediaLeaseAction =
  | { action: "begin"; lease_token: string }
  | { action: "complete"; lease_token: string; outcome: "deleted" | "unknown" | "failed" };

export type YayaMediaLeaseTransition =
  | { ok: true; next: YayaMediaLeaseState }
  | { ok: false; reason: "already_deleting" | "already_deleted" | "not_ready" | "lease_mismatch" };

/**
 * 媒体端口租约状态机（内部 deleting+unknown 映射 deletion_unknown）：
 * - begin：ready 或 deletion_unknown 可取得租约；pending → not_ready；
 *   deleting（租约持有中）→ already_deleting；deleted → already_deleted；
 * - complete：必须持有匹配令牌；unknown 保留 deletion_unknown，绝不变回 ready；
 *   failed（调用方确认未产生删除效果）才回 ready；deleted 落终态。
 */
export function mediaAttachmentLeaseTransition(
  current: YayaMediaLeaseState,
  action: YayaMediaLeaseAction,
): YayaMediaLeaseTransition {
  if (action.action === "begin") {
    if (current.status === "deleted") return { ok: false, reason: "already_deleted" };
    if (current.status === "deleting" && current.delete_result !== "unknown") {
      return { ok: false, reason: "already_deleting" };
    }
    if (current.status === "pending") return { ok: false, reason: "not_ready" };
    return {
      ok: true,
      next: { status: "deleting", delete_result: null, deletion_lease_id: action.lease_token },
    };
  }
  if (current.status !== "deleting" || current.deletion_lease_id !== action.lease_token) {
    return { ok: false, reason: "lease_mismatch" };
  }
  if (action.outcome === "deleted") {
    return { ok: true, next: { status: "deleted", delete_result: "deleted", deletion_lease_id: null } };
  }
  if (action.outcome === "unknown") {
    return {
      ok: true,
      next: { status: "deleting", delete_result: "unknown", deletion_lease_id: null },
    };
  }
  return { ok: true, next: { status: "ready", delete_result: null, deletion_lease_id: null } };
}

/* ------------------------------ 回执行映射 ------------------------------ */

export interface YayaOperationRow {
  operation_id: string;
  batch_id: string;
  proposal_id: string;
  item_key: string;
  target_id: string;
  actor_account_id: string;
  status: YayaReceiptStatus | null;
  effect: YayaReceiptEffect | null;
  business_object_id: string | null;
  business_revision: string | null;
  recorded_at: string | Date | null;
  started_at: string | Date | null;
  superseded_by: string | null;
  approval_id: string | null;
}

/** planned 行（status/recorded_at 为空）没有回执；查询语义按 no_receipt 处理 */
export function receiptRowToReceipt(row: YayaOperationRow | null): YayaOperationReceipt | null {
  if (row === null || row.status === null || row.recorded_at === null) return null;
  return {
    batch_id: row.batch_id,
    proposal_id: row.proposal_id,
    item_key: row.item_key,
    operation_id: row.operation_id,
    target_id: row.target_id,
    actor_account_id: row.actor_account_id,
    status: row.status,
    effect: row.effect ?? "unknown",
    business_object_id: row.business_object_id,
    business_revision: row.business_revision,
    recorded_at: new Date(row.recorded_at).toISOString(),
  };
}
