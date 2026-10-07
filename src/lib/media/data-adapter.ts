import { randomUUID } from "node:crypto";

import {
  withTransaction,
  type TransactionClient,
  type TransactionConnect,
} from "@/storage/database/pg-client";
import {
  addObservationAttachmentRefsAtRevision,
  appendMediaAttachmentAudit,
  beginAttachmentDeletion,
  commitAttachmentDeletion,
  failAttachmentDeletion,
  getMediaAttachment,
  getObservationAttachmentRevisionNumber,
  insertPendingAttachment,
  linkAttachmentRef,
  listAttachmentRefs,
  lockAttachmentsForReference,
  markAttachmentReady,
  queryAttachmentLifecycle,
} from "@/lib/yaya/data/attachments";
import { YayaDataError, type YayaMediaAttachmentRecord } from "@/lib/yaya/storage-types";
import { MediaError } from "./errors";
import { MEDIA_ALLOWED_CONTENT_TYPES, type MediaContentType } from "./limits";
import type {
  AttachmentMetadataPort,
  AttachmentRecord,
  RegisterAttachmentInput,
} from "./metadata-port";

/**
 * DATA1 附件 repository ↔ MEDIA1 AttachmentMetadataPort 的唯一适配器。
 *
 * 根因：两套端口结构不同（DATA：insertPending/markReady 两阶段 + 通用 CAS 原语；
 * MEDIA：单次原子登记 + revision CAS 租约 + 创建/追加分开）。本适配器只做
 * 形状/错误码转换，不复制 SQL，不伪造字段：
 * - 字段缺失（source_checksum/三 key/checksum/宽高/类型）一律按记录不可核验拒绝；
 * - `registerAttachment` 在**同一短事务**内完成 insertPending + markReady，
 *   pending 中间态不对外暴露；异常按原 attachment_id 读回核对由上传编排完成；
 * - `beginDeletionLease` 走 DATA 通用 CAS 原语（锁内完整引用核查 + revision CAS），
 *   有引用 / 引用不完整 / 版本冲突 / 进行中 / 已删除分别表达；
 * - `appendObservationAttachments` 在同一 client 内完成宿主前提 + revision CAS
 *   + 聚合审计，任一失败整事务回滚；
 * - 两种调用方式：`bindDataAttachmentMetadataPort(client)` 绑定现有 TransactionClient
 *   （业务保存事务内使用）；`createDataAttachmentMetadataPort(connect?)` 每个方法
 *   独立短事务（禁止在已有事务内使用，否则会另开连接）。
 */

function toMediaContentType(value: string): MediaContentType {
  if ((MEDIA_ALLOWED_CONTENT_TYPES as readonly string[]).includes(value)) {
    return value as MediaContentType;
  }
  throw new MediaError("metadata_unavailable", "附件类型不在受支持范围内，记录不可核验。");
}

function toAttachmentRecord(record: YayaMediaAttachmentRecord): AttachmentRecord {
  if (record.source_checksum === null || record.source_checksum.trim() === "") {
    throw new MediaError("metadata_unavailable", "附件缺少原始字节校验信息，记录不可核验。");
  }
  const status =
    record.status === "deletion_unknown"
      ? ("deleting" as const)
      : (record.status as AttachmentRecord["status"]);
  const delete_result =
    record.status === "deletion_unknown"
      ? ("unknown" as const)
      : record.status === "deleted"
        ? ("deleted" as const)
        : null;
  return {
    attachment_id: record.attachment_id,
    owner_account_id: record.owner_account_id,
    status,
    revision: record.revision,
    delete_result,
    object_key: record.object_key,
    content_type: toMediaContentType(record.content_type),
    byte_size: record.byte_size,
    checksum_sha256: record.checksum_sha256,
    thumbnail_key: record.thumbnail_key,
    model_key: record.model_key,
    thumbnail_checksum: record.thumbnail_checksum,
    model_checksum: record.model_checksum,
    source_checksum: record.source_checksum,
    width: record.width,
    height: record.height,
    client_upload_id: record.client_upload_id,
    created_at: record.created_at,
    updated_at: record.updated_at,
    deletion_started_at: record.deleting_started_at,
    deleted_at: record.deleted_at,
  };
}

function throwMapped(error: unknown, fallbackMessage: string): never {
  if (error instanceof MediaError) throw error;
  if (error instanceof YayaDataError) {
    switch (error.code) {
      case "attachment_missing":
        throw new MediaError("attachment_not_found", error.message, error.details);
      case "attachment_referenced":
        throw new MediaError("attachment_referenced", error.message, error.details);
      case "reference_incomplete":
        throw new MediaError("reference_query_incomplete", error.message, error.details);
      case "revision_conflict":
        throw new MediaError("revision_conflict", error.message, error.details);
      case "observation_not_confirmed":
        throw new MediaError("observation_not_confirmed", error.message, error.details);
      case "source_conflict":
        throw new MediaError("source_conflict", error.message, error.details);
      case "invalid_request":
        throw new MediaError("invalid_request", error.message, error.details);
      case "not_found":
        throw new MediaError("attachment_not_found", error.message, error.details);
      case "server_error":
        throw new MediaError("metadata_unavailable", "附件元数据不可核验，请稍后重试。");
      default:
        throw new MediaError("metadata_unavailable", fallbackMessage);
    }
  }
  throw new MediaError("metadata_unavailable", fallbackMessage);
}

/**
 * 引用写入时的 attachment_conflict：按锁后当前状态映射为删除中/不可用，
 * 不折叠成服务器错误（与进程内端口语义一致）。
 */
async function conflictToMediaError(
  client: TransactionClient,
  error: YayaDataError,
): Promise<MediaError> {
  const rawId = error.details?.attachment_id;
  if (typeof rawId === "string") {
    const latest = await getMediaAttachment(client, rawId).catch(() => null);
    if (latest !== null) {
      const status = toAttachmentRecord(latest).status;
      if (status === "deleting") {
        return new MediaError("attachment_deleting", "附件正在回收，不能新增引用。");
      }
      return new MediaError("attachment_gone", "附件不可用，不能新增引用。");
    }
  }
  return new MediaError("attachment_conflict", error.message, error.details);
}

function buildPort(
  run: <T>(work: (client: TransactionClient) => Promise<T>) => Promise<T>,
): AttachmentMetadataPort {
  return {
    registerAttachment: (input: RegisterAttachmentInput) =>
      run(async (client) => {
        const pending: YayaMediaAttachmentRecord = {
          attachment_id: input.attachment_id,
          owner_account_id: input.owner_account_id,
          status: "pending",
          revision: 0,
          object_key: input.object_key,
          thumbnail_key: input.thumbnail_key,
          model_key: input.model_key,
          content_type: input.content_type,
          byte_size: input.byte_size,
          checksum_sha256: input.checksum_sha256,
          thumbnail_checksum: input.thumbnail_checksum,
          model_checksum: input.model_checksum,
          source_checksum: input.source_checksum,
          width: input.width,
          height: input.height,
          client_upload_id: input.client_upload_id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleting_started_at: null,
          deleted_at: null,
          deletion_lease_id: null,
        };
        try {
          await insertPendingAttachment(client, pending);
          const ready = await markAttachmentReady(client, input.attachment_id);
          return toAttachmentRecord(ready);
        } catch (error) {
          if (error instanceof YayaDataError && error.code === "attachment_conflict") {
            throw new MediaError("idempotency_conflict", error.message, error.details);
          }
          throwMapped(error, "附件登记失败，请稍后重试。");
        }
      }),

    get: (attachmentId: string) =>
      run(async (client) => {
        try {
          const record = await getMediaAttachment(client, attachmentId);
          return record === null ? null : toAttachmentRecord(record);
        } catch (error) {
          throwMapped(error, "附件元数据不可用，请稍后重试。");
        }
      }),

    getReferenceFacts: (attachmentId: string) =>
      run(async (client) => {
        const facts = await queryAttachmentLifecycle(client, attachmentId);
        return {
          attachment_id: facts.image_id,
          reference_query_complete: facts.reference_query_complete,
          observation_refs: [...facts.observation_refs],
          message_refs: [...facts.message_refs],
          proposal_refs: [...facts.proposal_refs],
        };
      }),

    beginDeletionLease: (input) =>
      run(async (client) => {
        if (input.actor_account_id === undefined || input.actor_account_id.trim() === "") {
          // 操作者身份必须来自可信调用上下文；缺失时 fail closed，不用上传者冒充。
          throw new MediaError("invalid_request", "回收租约缺少可信操作者身份，已拒绝。");
        }
        if (!Number.isInteger(input.expected_revision) || input.expected_revision < 0) {
          throw new MediaError("invalid_request", "回收租约版本前提不合法。");
        }
        let current: YayaMediaAttachmentRecord | null;
        try {
          current = await getMediaAttachment(client, input.attachment_id);
        } catch (error) {
          throwMapped(error, "附件元数据不可用，请稍后重试。");
        }
        if (current === null) return { outcome: "not_found" as const };
        if (current.owner_account_id !== input.actor_account_id) {
          throw new MediaError("not_owner", "只能回收自己上传的图片。");
        }
        if (current.revision !== input.expected_revision) {
          return { outcome: "revision_conflict" as const };
        }
        try {
          await beginAttachmentDeletion(client, {
            attachment_id: input.attachment_id,
            expected_revision: input.expected_revision,
            actor_account_id: input.actor_account_id,
          });
        } catch (error) {
          if (error instanceof YayaDataError) {
            switch (error.code) {
              case "attachment_referenced":
                return { outcome: "referenced" as const };
              case "reference_incomplete":
                return { outcome: "reference_incomplete" as const };
              case "revision_conflict":
                return { outcome: "revision_conflict" as const };
              case "attachment_missing":
                return { outcome: "not_found" as const };
              case "attachment_conflict": {
                const latest = await getMediaAttachment(client, input.attachment_id);
                if (latest === null) return { outcome: "not_found" as const };
                return {
                  outcome: "not_ready" as const,
                  status: toAttachmentRecord(latest).status,
                };
              }
            }
            throwMapped(error, "回收租约暂时不可用，请稍后重试。");
          }
          throwMapped(error, "回收租约暂时不可用，请稍后重试。");
        }
        const acquired = await getMediaAttachment(client, input.attachment_id);
        if (acquired === null) {
          throw new MediaError("metadata_unavailable", "租约记录缺失，回收已拒绝。");
        }
        return { outcome: "acquired" as const, record: toAttachmentRecord(acquired) };
      }),

    commitDeletion: (input) =>
      run(async (client) => {
        try {
          await commitAttachmentDeletion(client, {
            attachment_id: input.attachment_id,
            expected_revision: input.expected_revision,
          });
        } catch (error) {
          throwMapped(error, "删除落账失败，请稍后重试。");
        }
        const record = await getMediaAttachment(client, input.attachment_id);
        if (record === null) throw new MediaError("attachment_not_found", "附件不存在。");
        return toAttachmentRecord(record);
      }),

    failDeletion: (input) =>
      run(async (client) => {
        try {
          await failAttachmentDeletion(client, {
            attachment_id: input.attachment_id,
            expected_revision: input.expected_revision,
          });
        } catch (error) {
          throwMapped(error, "删除状态落账失败，请稍后重试。");
        }
        const record = await getMediaAttachment(client, input.attachment_id);
        if (record === null) throw new MediaError("attachment_not_found", "附件不存在。");
        return toAttachmentRecord(record);
      }),

    linkObservationReferences: (input) =>
      run(async (client) => {
        const ids = [...input.attachment_ids];
        if (ids.length === 0 || new Set(ids).size !== ids.length) {
          throw new MediaError("invalid_request", "关联附件集合不合法。");
        }
        try {
          // 先按稳定顺序锁全部附件并核 ready+owner（后一附件失败不留半成功）。
          await lockAttachmentsForReference(client, input.actor_account_id, ids);
          const existing = await listAttachmentRefs(client, {
            record_kind: "observation",
            record_id: input.observation_id,
          });
          const existingIds = new Set(existing.map((ref) => ref.attachment_id));
          let linked = 0;
          for (const attachmentId of ids) {
            if (existingIds.has(attachmentId)) continue;
            await linkAttachmentRef(client, {
              attachment_id: attachmentId,
              record_kind: "observation",
              record_id: input.observation_id,
              linked_by_account_id: input.actor_account_id,
            });
            linked += 1;
          }
          return { linked };
        } catch (error) {
          if (error instanceof YayaDataError && error.code === "attachment_conflict") {
            throw await conflictToMediaError(client, error);
          }
          throwMapped(error, "附件关联失败，请稍后重试。");
        }
      }),

    appendObservationAttachments: (input) =>
      run(async (client) => {
        try {
          // 宿主前提 + revision CAS + 引用写入在同一事务；任一步失败整单回滚。
          const result = await addObservationAttachmentRefsAtRevision(client, {
            observation_id: input.observation_id,
            attachment_ids: input.attachment_ids,
            actor_account_id: input.actor_account_id,
            expected_attachment_revision: input.expected_attachment_revision,
            source_confirmed_at: input.source_confirmed_at,
          });
          await appendMediaAttachmentAudit(client, {
            audit_id: randomUUID(),
            action: "attach_observation_images",
            observation_id: input.observation_id,
            attachment_ids: [...input.attachment_ids],
            actor_account_id: input.actor_account_id,
            source_confirmed_at: input.source_confirmed_at,
            request_id: input.request_id,
            approval_id: input.approval_id ?? null,
            recorded_at: new Date().toISOString(),
          });
          return {
            attachment_revision: result.attachment_revision,
            appended: [...input.attachment_ids],
          };
        } catch (error) {
          if (error instanceof YayaDataError && error.code === "attachment_conflict") {
            throw await conflictToMediaError(client, error);
          }
          throwMapped(error, "资料追加失败，请稍后重试。");
        }
      }),

    getObservationAttachmentRevision: (observationId: string) =>
      run((client) => getObservationAttachmentRevisionNumber(client, observationId)),
  };
}

/** 绑定现有 TransactionClient（业务保存事务内使用；不另开连接、不自行提交） */
export function bindDataAttachmentMetadataPort(client: TransactionClient): AttachmentMetadataPort {
  return buildPort((work) => work(client));
}

/** 普通短事务入口：每个方法独立 withTransaction（禁止在已有事务内调用） */
export function createDataAttachmentMetadataPort(connect?: TransactionConnect): AttachmentMetadataPort {
  return buildPort((work) => withTransaction(work, connect));
}
