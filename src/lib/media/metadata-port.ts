import type { ObservationStatus } from "../types";
import type { MediaContentType } from "./limits";

/**
 * MEDIA1 附件元数据端口 v2（对齐 YAYA-DATA1 已发布 repository；DDL 归 DATA1）。
 *
 * 冻结语义（DATA1 接入时按此实现，不得放宽；逐方法映射见 media1-r1-delivery.md）：
 * 1. 记录只保存 object key/checksum/尺寸等元数据，**绝不保存公开或签名 URL**；
 * 2. 状态统一为 `ready | deleting | deleted` + `revision` CAS + `delete_result`；
 *    未知删除 = `deleting + delete_result="unknown"`，**不恢复 ready、不伪装 deleted**；
 * 3. `registerAttachment` 单次原子登记（insert 即 ready、revision=0）；
 *    调用方必须先写对象；异常不表示未提交，调用方按原 attachment_id 读回核对；
 * 4. `getReferenceFacts` 返回全部引用类别；悬空引用必须置
 *    `reference_query_complete=false`（调用方不得回收），基础设施不可用抛错；
 * 5. `beginDeletionLease` 必须在**共同原子边界**重查完整引用集合并做
 *    ready+revision CAS；前置无引用查询只是快速判断，不能单独授权物理删除；
 *    引用新增（link/append）与租约在附件行上互斥；租约之后的新引用必须拒绝；
 * 6. `commitDeletion` / `failDeletion` 必须核对 revision；
 *    `failDeletion` 保持 deleting+unknown；对象删除由 MEDIA1 在事务外按精确 key 执行；
 * 7. `appendObservationAttachments` 是单一原子边界：附件 ready/owner 校验、
 *    **宿主前提核验**、观察级 expected_revision CAS、引用写入与独立审计
 *    （含来源确认前提）全有或全无。宿主前提必须在该边界内重读/锁定宿主：
 *    当前 status=confirmed 且 confirmed_at 与提交的 `source_confirmed_at`
 *    为同一时刻；把来源写进审计**不等于**前提成立。服务层预检只用于快速失败；
 * 8. `linkObservationReferences` 供创建观察事务内关联；不递增 revision、不写审计；
 * 9. 不允许默认 ready、伪造 checksum、空引用或类型强转填平字段差异。
 *
 * 整合 R2 增量（YAYA-CORE-INTEGRATE1）：
 * 10. `beginDeletionLease` 有引用 / 引用不完整 / 版本冲突 / 进行中 / 已删除分别表达；
 *     操作者身份由可信调用上下文提供（生产 DATA 适配器要求必须提供并核对为上传者本人）；
 * 11. `pending` 为遗留/未就绪记录的真实状态：可见但不得当 ready 消费。
 */

export const ATTACHMENT_STATUSES = ["pending", "ready", "deleting", "deleted"] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export type AttachmentDeleteResult = "deleted" | "unknown" | null;

export interface AttachmentRecord {
  attachment_id: string;
  owner_account_id: string;
  status: AttachmentStatus;
  /** 元数据修订；删除租约/落账的 CAS 身份（DATA 同名列） */
  revision: number;
  delete_result: AttachmentDeleteResult;
  /** 原图对象（DATA `object_key` / `checksum` / `byte_size` / `media_type`） */
  object_key: string;
  content_type: MediaContentType;
  byte_size: number;
  checksum_sha256: string;
  /** 派生对象与尺寸（DATA `metadata` jsonb 扩展；缺失视为记录不完整） */
  thumbnail_key: string;
  model_key: string;
  thumbnail_checksum: string;
  model_checksum: string;
  width: number;
  height: number;
  /** 原始上传字节的 SHA-256：同 owner+client_upload_id 的内容绑定（幂等核对） */
  source_checksum: string;
  client_upload_id: string | null;
  created_at: string;
  updated_at: string;
  deletion_started_at: string | null;
  deleted_at: string | null;
}

/** 登记输入：对象必须先写入；本结构不得含 status/revision 等由存储生成的状态 */
export interface RegisterAttachmentInput {
  attachment_id: string;
  owner_account_id: string;
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
  source_checksum: string;
  client_upload_id: string | null;
}

export interface AttachmentReferenceFacts {
  attachment_id: string;
  /** false = 引用集合不完整（悬空引用/不可读）；禁止物理回收 */
  reference_query_complete: boolean;
  observation_refs: readonly { observation_id: string; status: ObservationStatus }[];
  message_refs: readonly { conversation_id: string; message_id: string }[];
  proposal_refs: readonly string[];
}

export interface AttachmentAuditEntry {
  audit_id: string;
  action: "attach_observation_images";
  observation_id: string;
  attachment_id: string;
  attachment_revision: number;
  actor_account_id: string;
  /** 宿主确认来源前提（共同保存条件的一部分） */
  source_confirmed_at: string | null;
  request_id: string | null;
  approval_id: string | null;
  recorded_at: string;
}

export type DeletionLeaseResult =
  | { outcome: "acquired"; record: AttachmentRecord }
  | { outcome: "referenced" }
  | { outcome: "reference_incomplete" }
  | { outcome: "revision_conflict" }
  | { outcome: "not_ready"; status: AttachmentStatus }
  | { outcome: "not_found" };

export interface ObservationReferencesResult {
  linked: number;
}

export interface AppendObservationAttachmentsInput {
  observation_id: string;
  attachment_ids: readonly string[];
  expected_attachment_revision: number;
  actor_account_id: string;
  /**
   * 宿主确认来源前提：端口必须在同一原子边界内重读/锁定宿主，
   * 要求 status=confirmed 且 confirmed_at 与本值同一时刻；
   * 不满足时拒绝写入（不得只把它写进审计）。
   */
  source_confirmed_at: string | null;
  request_id: string | null;
  approval_id: string | null;
}

export interface AppendObservationAttachmentsResult {
  attachment_revision: number;
  appended: readonly string[];
}

export interface AttachmentMetadataPort {
  get(attachment_id: string): Promise<AttachmentRecord | null>;
  registerAttachment(input: RegisterAttachmentInput): Promise<AttachmentRecord>;
  getReferenceFacts(attachment_id: string): Promise<AttachmentReferenceFacts>;
  beginDeletionLease(input: {
    attachment_id: string;
    expected_revision: number;
    /**
     * 可信调用上下文中的回收操作者账号（不从请求体自报）。
     * 生产 DATA 适配器要求必须提供并核对为附件上传者本人；
     * 进程内替身留空时保持既有测试语义。
     */
    actor_account_id?: string;
  }): Promise<DeletionLeaseResult>;
  commitDeletion(input: {
    attachment_id: string;
    expected_revision: number;
  }): Promise<AttachmentRecord>;
  failDeletion(input: {
    attachment_id: string;
    expected_revision: number;
  }): Promise<AttachmentRecord>;
  linkObservationReferences(input: {
    observation_id: string;
    attachment_ids: readonly string[];
    actor_account_id: string;
  }): Promise<ObservationReferencesResult>;
  appendObservationAttachments(
    input: AppendObservationAttachmentsInput,
  ): Promise<AppendObservationAttachmentsResult>;
  getObservationAttachmentRevision(observation_id: string): Promise<number>;
}
