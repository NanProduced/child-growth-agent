/**
 * MEDIA1 附件元数据端口工厂（DATA1-R1 发布）。
 *
 * 两种调用方式（口径见 docs/yaya-v1/media-storage-interface-r1.md）：
 * - `bindYayaAttachmentMetadataPort(client)`：事务绑定，全部方法使用调用方 client，
 *   不另开连接、不自行提交；创建观察附图/归档后追加必须在业务保存事务内使用；
 * - `createYayaAttachmentMetadataPort(connect?)`：普通短事务，每个方法独立
 *   `withTransaction`（缺省走 pg-client 连接池）。
 *
 * 对象存储 I/O 不在事务内；本端口只负责元数据/引用/审计。
 */
import {
  withTransaction,
  type TransactionClient,
  type TransactionConnect,
} from "@/storage/database/pg-client";
import type { YayaAttachmentMetadataPort } from "../storage-types";
import * as attachments from "./attachments";

export function bindYayaAttachmentMetadataPort(client: TransactionClient): YayaAttachmentMetadataPort {
  return {
    findByClientUploadId: (ownerAccountId, clientUploadId) =>
      attachments.findAttachmentByClientUploadId(client, ownerAccountId, clientUploadId),
    insertPending: (record) => attachments.insertPendingAttachment(client, record).then(() => undefined),
    markReady: (attachmentId) => attachments.markAttachmentReady(client, attachmentId),
    removePending: (attachmentId) => attachments.removePendingAttachment(client, attachmentId),
    get: (attachmentId) => attachments.getMediaAttachment(client, attachmentId),
    addObservationReferences: (input) => attachments.addObservationAttachmentRefs(client, input),
    getObservationAttachmentRevision: (observationId) =>
      attachments.getObservationAttachmentRevisionNumber(client, observationId),
    getReferenceFacts: async (attachmentId) => {
      const facts = await attachments.getMediaAttachmentReferenceFacts(client, attachmentId);
      return {
        attachment_id: facts.attachment_id,
        observation_refs: [...facts.observation_refs],
        message_refs: [...facts.message_refs],
        proposal_refs: [...facts.proposal_refs],
      };
    },
    releaseConversationReferences: (input) =>
      attachments.releaseConversationAttachmentRefs(client, input),
    beginDeletionLease: (attachmentId) => attachments.acquireAttachmentDeletionLease(client, attachmentId),
    completeDeletion: (attachmentId, leaseToken, outcome) =>
      attachments.completeAttachmentDeletionByLease(client, {
        attachment_id: attachmentId,
        lease_token: leaseToken,
        outcome,
      }),
    appendAttachmentAudit: (entry) => attachments.appendMediaAttachmentAudit(client, entry),
  };
}

export function createYayaAttachmentMetadataPort(
  connect?: TransactionConnect,
): YayaAttachmentMetadataPort {
  const run = <T>(work: (client: TransactionClient) => Promise<T>): Promise<T> =>
    withTransaction(work, connect);
  return {
    findByClientUploadId: (ownerAccountId, clientUploadId) =>
      run((client) => attachments.findAttachmentByClientUploadId(client, ownerAccountId, clientUploadId)),
    insertPending: (record) => run((client) => attachments.insertPendingAttachment(client, record).then(() => undefined)),
    markReady: (attachmentId) => run((client) => attachments.markAttachmentReady(client, attachmentId)),
    removePending: (attachmentId) => run((client) => attachments.removePendingAttachment(client, attachmentId)),
    get: (attachmentId) => run((client) => attachments.getMediaAttachment(client, attachmentId)),
    addObservationReferences: (input) => run((client) => attachments.addObservationAttachmentRefs(client, input)),
    getObservationAttachmentRevision: (observationId) =>
      run((client) => attachments.getObservationAttachmentRevisionNumber(client, observationId)),
    getReferenceFacts: (attachmentId) =>
      run(async (client) => {
        const facts = await attachments.getMediaAttachmentReferenceFacts(client, attachmentId);
        return {
          attachment_id: facts.attachment_id,
          observation_refs: [...facts.observation_refs],
          message_refs: [...facts.message_refs],
          proposal_refs: [...facts.proposal_refs],
        };
      }),
    releaseConversationReferences: (input) =>
      run((client) => attachments.releaseConversationAttachmentRefs(client, input)),
    beginDeletionLease: (attachmentId) =>
      run((client) => attachments.acquireAttachmentDeletionLease(client, attachmentId)),
    completeDeletion: (attachmentId, leaseToken, outcome) =>
      run((client) =>
        attachments.completeAttachmentDeletionByLease(client, {
          attachment_id: attachmentId,
          lease_token: leaseToken,
          outcome,
        }),
      ),
    appendAttachmentAudit: (entry) => run((client) => attachments.appendMediaAttachmentAudit(client, entry)),
  };
}
