import type { AccountRole } from "../accounts/types";
import {
  decideImageReadAccess,
  type YayaImageBusinessRef,
  type YayaImageReadDecision,
  type YayaImageViewerRecordAccess,
} from "../yaya/types";
import { MediaError } from "./errors";
import { variantContentType, type MediaContentType, type MediaVariant } from "./limits";
import type { AttachmentRecord } from "./metadata-port";
import { sha256Hex } from "./object-store";
import type { MediaServiceDeps } from "./runtime";

/**
 * MEDIA1 授权读取与内容代理。
 *
 * 冻结口径：
 * - 读取判定复用共享纯函数 `decideImageReadAccess`（不复制、不 fork 语义）：
 *   已关联图片按 record_kind + record_id 的当前授权读取；历史只读只返回元数据；
 *   未关联图片仅上传者本人；未知/缺失授权一律拒绝；
 * - 字节只经认证代理返回，不产生公开 URL；必要的签名（本实现不生成）必须短 TTL；
 * - 读取时核对对象 checksum，损坏对象不冒充可用内容；
 * - 引用查询不完整时保守拒绝，不默认放行。
 */

export interface MediaViewer {
  account_id: string;
  role: AccountRole;
}

export type RecordAccessLoader = (
  record: YayaImageBusinessRef,
  attachmentId?: string,
) => Promise<YayaImageViewerRecordAccess | null>;

export interface AttachmentReadEvaluation {
  record: AttachmentRecord;
  decision: YayaImageReadDecision;
}

export interface AttachmentMetadataView {
  attachment_id: string;
  status: AttachmentRecord["status"];
  content_type: MediaContentType;
  byte_size: number;
  width: number;
  height: number;
  created_at: string;
  attached: boolean;
  readable: boolean;
  metadata_only: boolean;
}

function assertReadableStatus(record: AttachmentRecord): void {
  if (record.status === "deleting") {
    throw new MediaError("attachment_deleting", "附件正在回收，暂不可读。");
  }
  if (record.status !== "ready") {
    throw new MediaError("attachment_gone", "附件不可用或已回收。");
  }
}

async function buildFacts(
  deps: MediaServiceDeps,
  record: AttachmentRecord,
): Promise<{ facts: Parameters<typeof decideImageReadAccess>[0]; attachedRecords: readonly YayaImageBusinessRef[] }> {
  let referenceFacts;
  try {
    referenceFacts = await deps.metadata.getReferenceFacts(record.attachment_id);
  } catch (error) {
    if (error instanceof MediaError && error.code === "metadata_unavailable") {
      throw new MediaError(
        "reference_query_incomplete",
        "暂时无法确认附件引用关系，已保守拒绝读取。",
      );
    }
    throw error;
  }
  if (!referenceFacts.reference_query_complete) {
    throw new MediaError("reference_query_incomplete", "附件引用关系不完整，已保守拒绝读取。");
  }
  const attachedRecords: YayaImageBusinessRef[] = [
    ...referenceFacts.observation_refs.map((ref) => ({
      record_kind: "observation" as const,
      record_id: ref.observation_id,
    })),
    ...referenceFacts.proposal_refs.map((refId) => ({
      record_kind: "proposal" as const,
      record_id: refId,
    })),
  ];
  return {
    facts: {
      image_id: record.attachment_id,
      uploader_account_id: record.owner_account_id,
      attached_records: attachedRecords,
    },
    attachedRecords,
  };
}

export async function evaluateAttachmentRead(
  deps: MediaServiceDeps,
  input: { attachment_id: string; viewer: MediaViewer; loadRecordAccess: RecordAccessLoader },
): Promise<AttachmentReadEvaluation> {
  const record = await deps.metadata.get(input.attachment_id);
  if (record === null) throw new MediaError("attachment_not_found", "附件不存在。");
  assertReadableStatus(record);
  const { facts, attachedRecords } = await buildFacts(deps, record);
  const recordAccess: YayaImageViewerRecordAccess[] = [];
  for (const attached of attachedRecords) {
    const access = await input.loadRecordAccess(attached, record.attachment_id);
    if (access !== null) recordAccess.push(access);
  }
  const decision = decideImageReadAccess(facts, {
    account_id: input.viewer.account_id,
    record_access: recordAccess,
  });
  return { record, decision };
}

export function attachmentMetadataView(evaluation: AttachmentReadEvaluation): AttachmentMetadataView {
  const { record, decision } = evaluation;
  const readable = decision.readable;
  const metadataOnly = !decision.readable && decision.metadata_only;
  if (!readable && !metadataOnly) {
    throw new MediaError("forbidden", "当前账号没有该附件的读取权限。");
  }
  return {
    attachment_id: record.attachment_id,
    status: record.status,
    content_type: record.content_type,
    byte_size: record.byte_size,
    width: record.width,
    height: record.height,
    created_at: record.created_at,
    attached: decision.readable && decision.via === "business_record",
    readable,
    metadata_only: metadataOnly,
  };
}

function checksumForVariant(record: AttachmentRecord, variant: MediaVariant): string {
  if (variant === "thumbnail") return record.thumbnail_checksum;
  if (variant === "model") return record.model_checksum;
  return record.checksum_sha256;
}

export async function loadAttachmentContent(
  deps: MediaServiceDeps,
  input: {
    attachment_id: string;
    viewer: MediaViewer;
    loadRecordAccess: RecordAccessLoader;
    variant: MediaVariant;
  },
): Promise<{ body: Buffer; content_type: string; byte_size: number }> {
  const evaluation = await evaluateAttachmentRead(deps, input);
  const { record, decision } = evaluation;
  if (!decision.readable) {
    if (decision.metadata_only) {
      throw new MediaError("metadata_only", "该附件仅可查看元数据，不能读取图片内容。");
    }
    throw new MediaError("forbidden", "当前账号没有该附件的读取权限。");
  }
  const key =
    input.variant === "thumbnail"
      ? record.thumbnail_key
      : input.variant === "model"
        ? record.model_key
        : record.object_key;
  const stored = await deps.store.get(key);
  if (stored === null) throw new MediaError("attachment_gone", "附件对象不存在或已被回收。");
  if (sha256Hex(stored.body) !== checksumForVariant(record, input.variant)) {
    throw new MediaError("checksum_mismatch", "附件内容校验失败，已拒绝返回损坏内容。");
  }
  return {
    body: stored.body,
    content_type: variantContentType(record.content_type, input.variant),
    byte_size: stored.body.length,
  };
}
