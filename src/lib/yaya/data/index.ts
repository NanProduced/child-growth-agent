/**
 * YAYA-DATA1 仓库聚合入口。
 *
 * `yayaDataRepository` 以实现对象 `satisfies YayaDataRepository` 保证与
 * storage-types.ts 发布的签名逐项一致；其他 owner 直接从这里取实现。
 */
import type { YayaDataRepository } from "../storage-types";
import * as attachments from "./attachments";
import * as conversations from "./conversations";
import * as messages from "./messages";
import * as operations from "./operations";
import * as proposals from "./proposals";

export * from "./invariants";
export * from "./private-auth";
export * from "./access-facts";
export * from "./route-errors";
export * from "./conversations";
export * from "./messages";
export * from "./proposals";
export * from "./operations";
export * from "./attachments";

export const yayaDataRepository = {
  createConversation: conversations.createConversation,
  listConversations: conversations.listConversations,
  getConversation: conversations.getConversation,
  getConversationSummary: conversations.getConversationSummary,
  renameConversation: conversations.renameConversation,
  deleteConversation: conversations.deleteConversation,
  saveMessage: messages.saveMessage,
  listMessages: messages.listMessages,
  prepareProposal: proposals.prepareProposal,
  getProposal: proposals.getProposal,
  recordApproval: proposals.recordApproval,
  rejectProposalItems: proposals.rejectProposalItems,
  cancelPendingApproval: proposals.cancelPendingApproval,
  getApproval: proposals.getApproval,
  executeApprovedOperations: operations.executeApprovedOperations,
  queryOperation: operations.queryOperation,
  queryBatch: operations.queryBatch,
  supersedeWithReplacement: operations.supersedeWithReplacement,
  registerAttachment: attachments.registerAttachment,
  getAttachment: attachments.getAttachment,
  queryAttachmentLifecycle: attachments.queryAttachmentLifecycle,
  beginAttachmentDeletion: attachments.beginAttachmentDeletion,
  commitAttachmentDeletion: attachments.commitAttachmentDeletion,
  failAttachmentDeletion: attachments.failAttachmentDeletion,
  linkAttachmentRef: attachments.linkAttachmentRef,
  listAttachmentRefs: attachments.listAttachmentRefs,
  appendObservationAttachments: attachments.appendObservationAttachments,
  getObservationAttachmentRevision: attachments.getObservationAttachmentRevision,
} satisfies YayaDataRepository;
