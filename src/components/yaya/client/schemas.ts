/**
 * UI1 客户端响应校验（信任边界）。
 *
 * 服务端响应在进入 UI 状态前先按本文件校验：坏形状 / 缺关键字段 / 坏 JSON
 * 一律不渲染成功。schema 只要求 UI 真正消费的字段，允许服务端继续携带
 * 已冻结响应中的其余字段（content_digest / actor_account_id 等合法响应字段）。
 */
import { z } from "zod";

const isoString = z.string().min(1);

export const yayaSourceRefSchema = z.looseObject({
  kind: z.string().min(1),
  ref_id: z.string().nullable(),
  label: z.string().nullable(),
  derived_from: z.string().nullable(),
});

export const conversationSummarySchema = z.looseObject({
  conversation_id: z.string().min(1),
  owner_account_id: z.string().min(1),
  projected_title: z.string(),
  title_restricted: z.boolean(),
  revision: z.number().int().min(1),
  created_at: isoString,
  updated_at: isoString,
  deleted_at: z.string().nullable(),
});

export const conversationListResponseSchema = z.looseObject({
  conversations: z.array(conversationSummarySchema),
});

export const conversationResponseSchema = z.looseObject({
  conversation: conversationSummarySchema,
});

export const fragmentProjectionSchema = z.looseObject({
  fragment_id: z.string().min(1),
  visibility: z.enum(["full", "historical_read_only", "hidden"]),
  reason: z.string().min(1),
  text: z.string().nullable(),
  provenance: yayaSourceRefSchema.nullable(),
  independently_readable: z.boolean(),
});

export const attachmentProjectionSchema = z.looseObject({
  attachment_id: z.string().min(1),
  readable: z.boolean(),
  metadata_only: z.boolean(),
  reason: z.string().min(1),
});

export const messageProjectionSchema = z.looseObject({
  visibility: z.enum(["full", "partial", "metadata_only", "hidden", "unavailable"]),
  fragments: z.array(z.looseObject({
    fragment_id: z.string().min(1),
    visibility: z.enum(["full", "historical_read_only", "hidden"]),
    reason: z.string().min(1),
  })),
  attachments: z.array(attachmentProjectionSchema),
  metadata: z.unknown().nullable(),
  execution_allowed: z.literal(false),
});

export const projectedMessageSchema = z.looseObject({
  message_id: z.string().min(1),
  conversation_id: z.string().min(1),
  owner_account_id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool"]),
  message_kind: z.enum(["text", "image", "tool_result", "receipt", "mixed"]),
  execution_state: z.enum(["none", "pending_approval", "executed", "unknown"]),
  revision: z.number().int(),
  created_at: isoString,
  projection: messageProjectionSchema,
  fragments: z.array(fragmentProjectionSchema),
  attachment_ids: z.array(z.string().min(1)),
  metadata: z.unknown().nullable(),
});

export const conversationMessagesResponseSchema = z.looseObject({
  conversation: conversationSummarySchema,
  messages: z.array(projectedMessageSchema),
});

export const saveMessageResponseSchema = z.looseObject({
  message: projectedMessageSchema,
  conversation: conversationSummarySchema,
  replayed: z.boolean(),
});

export const uploadResultSchema = z.union([
  z.looseObject({
    client_upload_id: z.string().nullable(),
    ok: z.literal(true),
    attachment: z.looseObject({
      attachment_id: z.string().min(1),
      status: z.literal("ready"),
      content_type: z.string().min(1),
      byte_size: z.number().nonnegative(),
      width: z.number().positive(),
      height: z.number().positive(),
      created_at: isoString,
    }),
  }),
  z.looseObject({
    client_upload_id: z.string().nullable(),
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z
      .looseObject({ attachment_id: z.string().min(1) })
      .optional(),
  }),
]);

export const uploadBatchResponseSchema = z.looseObject({
  uploads: z.array(uploadResultSchema).min(1),
});

const projectedProposalItemSchema = z.looseObject({
  item_key: z.string().min(1),
  operation_id: z.string().min(1),
  target_id: z.string().nullable(),
  action: z.string().min(1),
  resource: z.string().min(1),
  resource_ref: z.unknown(),
  content_digest: z.string().min(1),
  attachment_associations: z.array(
    z.looseObject({ attachment_id: z.string().min(1), target_id: z.string().min(1) })
  ),
  business_revision: z.string().nullable(),
  status: z.enum(["pending", "approved", "rejected", "superseded"]),
  access: z.enum(["full", "historical_read_only", "denied", "unavailable", "broken"]),
  payload: z.unknown().nullable(),
});

export const projectedProposalSchema = z.looseObject({
  proposal_id: z.string().min(1),
  batch_id: z.string().min(1),
  conversation_id: z.string().min(1),
  owner_account_id: z.string().min(1),
  proposal_origin: z.enum(["teacher_card", "model_suggestion"]),
  auth: z.unknown(),
  status: z.enum(["open", "cancelled", "closed"]),
  prepared_at: isoString,
  items: z.array(projectedProposalItemSchema).min(1),
  attachments: z.array(attachmentProjectionSchema),
});

export const proposalResponseSchema = z.looseObject({
  proposal: projectedProposalSchema,
});

export const approvalResponseSchema = z.looseObject({
  approval: z.looseObject({
    approval_id: z.string().min(1),
    proposal_id: z.string().min(1),
    batch_id: z.string().min(1),
    actor_account_id: z.string().min(1),
    approval_source: z.string().min(1),
    approved_at: isoString,
    expires_at: z.string().nullable(),
    cancelled_at: z.string().nullable(),
    consumed_at: z.string().nullable(),
    items: z.array(z.unknown()),
  }),
  cancelled_approval_id: z.string().nullable(),
});

export const rejectProposalResponseSchema = z.looseObject({
  proposal: projectedProposalSchema,
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ProjectedMessage = z.infer<typeof projectedMessageSchema>;
export type ProjectedProposal = z.infer<typeof projectedProposalSchema>;
export type ProjectedProposalItem = z.infer<typeof projectedProposalItemSchema>;
export type UploadFileResult = z.infer<typeof uploadResultSchema>;
export type AttachmentProjection = z.infer<typeof attachmentProjectionSchema>;
