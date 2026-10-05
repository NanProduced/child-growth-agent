import type { ObservationStatus } from "../types";
import type { MediaContentType } from "./limits";

/**
 * MEDIA1 附件元数据端口（最小接口；DDL 与真实 repository 归 DATA1）。
 *
 * 冻结语义（DATA1 接入时按此实现，不得放宽）：
 * 1. 记录只保存 object key/checksum/尺寸等元数据，**绝不保存公开或签名 URL**；
 * 2. `insertPending` 以 attachment_id 唯一，`markReady` 只能 pending→ready；
 * 3. `addObservationReferences` 必须在**业务保存的同一事务**内执行；对每个附件
 *    先校验 status=ready（deleting/deleted/pending 一律拒绝），再写引用并原子递增
 *    宿主观察的 attachment revision（返回同一个 revision 值）；
 * 4. `getReferenceFacts` 必须完整返回三种引用（观察全状态、消息、提案）；查询
 *    不完整/不可用要抛错，由调用方按“引用查询不完整”保守处理，**不得返回空集冒充无引用**；
 * 5. `beginDeletionLease` 是 CAS：ready/deletion_unknown → deleting，拿到租约令牌；
 *    期间所有新增引用必须被拒绝；`completeDeletion` 必须核对租约令牌；
 * 6. `releaseConversationReferences` 只解除该 owner 自己会话的消息引用，其他会话/
 *    提案/观察引用一律保留；
 * 7. `appendAttachmentAudit` 独立于业务内容，只记录追加事实与身份，不改 raw_text/
 *    confirmed_content。
 */

export const ATTACHMENT_STATUSES = [
  "pending",
  "ready",
  "deleting",
  "deleted",
  "deletion_unknown",
] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export interface AttachmentRecord {
  attachment_id: string;
  owner_account_id: string;
  status: AttachmentStatus;
  object_key: string;
  thumbnail_key: string;
  model_key: string;
  content_type: MediaContentType;
  byte_size: number;
  checksum_sha256: string;
  thumbnail_checksum: string;
  model_checksum: string;
  width: number;
  height: number;
  client_upload_id: string | null;
  created_at: string;
  /** 回收租约令牌；仅 status=deleting 时非空 */
  deletion_lease_id: string | null;
}

export type AttachmentRefKind = "observation" | "proposal" | "message";

export interface AttachmentReference {
  attachment_id: string;
  ref_kind: AttachmentRefKind;
  ref_id: string;
  /** 仅 ref_kind=message 时非空 */
  conversation_id: string | null;
}

export interface ObservationAttachmentRefFact {
  observation_id: string;
  /** 观察已保存的全部状态都保护图片（draft/needs_input/ai_organized/confirmed） */
  status: ObservationStatus;
}

export interface MessageAttachmentRefFact {
  conversation_id: string;
  message_id: string;
}

export interface AttachmentReferenceFacts {
  attachment_id: string;
  observation_refs: readonly ObservationAttachmentRefFact[];
  message_refs: readonly MessageAttachmentRefFact[];
  proposal_refs: readonly string[];
}

export interface AttachmentAuditEntry {
  audit_id: string;
  action: "attach_observation_images" | "create_observation_attachments";
  observation_id: string;
  attachment_ids: readonly string[];
  actor_account_id: string;
  source_confirmed_at: string | null;
  request_id: string | null;
  recorded_at: string;
}

export type DeletionLeaseResult =
  | { outcome: "acquired"; lease_token: string }
  | { outcome: "already_deleting" }
  | { outcome: "already_deleted" }
  | { outcome: "not_ready" }
  | { outcome: "not_found" };

export interface ObservationReferencesResult {
  added: number;
  attachment_revision: number;
}

export interface AttachmentMetadataPort {
  findByClientUploadId(
    owner_account_id: string,
    client_upload_id: string,
  ): Promise<AttachmentRecord | null>;
  insertPending(record: AttachmentRecord): Promise<void>;
  markReady(attachment_id: string): Promise<AttachmentRecord>;
  removePending(attachment_id: string): Promise<boolean>;
  get(attachment_id: string): Promise<AttachmentRecord | null>;
  addObservationReferences(input: {
    observation_id: string;
    attachment_ids: readonly string[];
    actor_account_id: string;
  }): Promise<ObservationReferencesResult>;
  getObservationAttachmentRevision(observation_id: string): Promise<number>;
  getReferenceFacts(attachment_id: string): Promise<AttachmentReferenceFacts>;
  releaseConversationReferences(input: {
    conversation_id: string;
    message_ids: readonly string[];
    owner_account_id: string;
  }): Promise<number>;
  beginDeletionLease(attachment_id: string): Promise<DeletionLeaseResult>;
  completeDeletion(
    attachment_id: string,
    lease_token: string,
    outcome: "deleted" | "unknown" | "failed",
  ): Promise<AttachmentRecord>;
  appendAttachmentAudit(entry: AttachmentAuditEntry): Promise<void>;
}
