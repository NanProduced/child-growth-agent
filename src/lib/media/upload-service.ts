import { randomUUID } from "node:crypto";

import { buildObjectKey } from "./config";
import { MediaError } from "./errors";
import { processImage, sniffImageContentType } from "./image-processing";
import {
  MEDIA_MAX_IMAGES_PER_UPLOAD,
  MEDIA_MAX_IMAGE_BYTES,
  type MediaContentType,
} from "./limits";
import type { AttachmentRecord } from "./metadata-port";
import type { MediaObjectStore } from "./object-store";
import type { MediaServiceDeps } from "./runtime";

/**
 * MEDIA1 上传编排。
 *
 * 冻结口径：
 * - 账号私有上传：只要求已认证账号，不要求幼儿、不要求 ≥10 字；上传不形成业务观察；
 * - 每次最多 8 张、单图 10MiB；服务端魔数 + 解码 + 像素上限；不支持的格式**逐图**
 *   明确报错，其他图片与文字不受影响；
 * - 对象只写一次并回读核对 checksum；只保存对象引用，不保存任何 URL；
 * - 半上传补偿：元数据保存失败时只删除**本轮确实创建**的对象（精确 key），
 *   不按前缀清空；失败原因如实上报，不伪造成成功；
 * - client_upload_id 幂等：同账号同标识的已完成上传直接返回原附件，不重复写对象。
 */

export interface UploadFileInput {
  filename: string | null;
  declared_content_type: string | null;
  body: Buffer;
  client_upload_id: string | null;
}

export interface UploadBatchInput {
  owner_account_id: string;
  files: readonly UploadFileInput[];
}

export interface UploadAttachmentView {
  attachment_id: string;
  status: "ready";
  content_type: MediaContentType;
  byte_size: number;
  width: number;
  height: number;
  created_at: string;
}

export type UploadFileResult =
  | { client_upload_id: string | null; ok: true; attachment: UploadAttachmentView }
  | { client_upload_id: string | null; ok: false; code: string; message: string };

export interface UploadBatchResult {
  uploads: readonly UploadFileResult[];
}

export function toAttachmentView(record: AttachmentRecord): UploadAttachmentView {
  return {
    attachment_id: record.attachment_id,
    status: "ready",
    content_type: record.content_type,
    byte_size: record.byte_size,
    width: record.width,
    height: record.height,
    created_at: record.created_at,
  };
}

function normalizeDeclared(value: string | null): string | null {
  if (value === null) return null;
  const essence = value.split(";", 1)[0]?.trim().toLowerCase();
  return essence && essence.length > 0 ? essence : null;
}

async function uploadOne(
  deps: MediaServiceDeps,
  ownerAccountId: string,
  file: UploadFileInput,
): Promise<UploadAttachmentView> {
  if (file.client_upload_id !== null) {
    const existing = await deps.metadata.findByClientUploadId(ownerAccountId, file.client_upload_id);
    if (existing !== null) {
      if (existing.status === "ready") return toAttachmentView(existing);
      throw new MediaError("upload_incomplete", "该上传标识的上一次请求尚未完成，请更换标识或稍后重试。");
    }
  }

  if (file.body.length > MEDIA_MAX_IMAGE_BYTES) {
    throw new MediaError("file_too_large", "单张图片不能超过 10MiB，请压缩后再上传。");
  }
  const declared = normalizeDeclared(file.declared_content_type);
  const sniffed = sniffImageContentType(file.body);
  if (declared !== null && sniffed !== null && declared !== sniffed) {
    throw new MediaError("content_type_mismatch", "图片声明类型与实际内容不一致，已拒绝上传。");
  }
  const processed = await processImage(file.body);

  const attachmentId = randomUUID();
  const keyFor = (variant: "original" | "thumbnail" | "model") =>
    buildObjectKey({
      environment: deps.environment,
      owner_account_id: ownerAccountId,
      attachment_id: attachmentId,
      variant,
    });
  const keys = {
    original: keyFor("original"),
    thumbnail: keyFor("thumbnail"),
    model: keyFor("model"),
  };

  const createdKeys: string[] = [];
  let pendingInserted = false;
  const put = async (
    store: MediaObjectStore,
    key: string,
    content_type: string,
    body: Buffer,
  ): Promise<string> => {
    const result = await store.putOnce({ key, content_type, body });
    if (result.outcome === "conflict") {
      throw new MediaError("object_conflict", "对象已存在且内容不一致，拒绝覆盖。");
    }
    if (result.outcome === "created") createdKeys.push(key);
    return result.checksum_sha256;
  };

  try {
    const originalChecksum = await put(deps.store, keys.original, processed.content_type, processed.original);
    const thumbnailChecksum = await put(deps.store, keys.thumbnail, "image/webp", processed.thumbnail);
    const modelChecksum = await put(deps.store, keys.model, "image/jpeg", processed.model);
    const record: AttachmentRecord = {
      attachment_id: attachmentId,
      owner_account_id: ownerAccountId,
      status: "pending",
      object_key: keys.original,
      thumbnail_key: keys.thumbnail,
      model_key: keys.model,
      content_type: processed.content_type,
      byte_size: processed.original.length,
      checksum_sha256: originalChecksum,
      thumbnail_checksum: thumbnailChecksum,
      model_checksum: modelChecksum,
      width: processed.width,
      height: processed.height,
      client_upload_id: file.client_upload_id,
      created_at: new Date().toISOString(),
      deletion_lease_id: null,
    };
    await deps.metadata.insertPending(record);
    pendingInserted = true;
    const ready = await deps.metadata.markReady(attachmentId);
    return toAttachmentView(ready);
  } catch (error) {
    // 补偿只删除本轮确实创建的对象；先补偿对象，再尽力清理 pending 元数据。
    for (const key of createdKeys) {
      try {
        await deps.store.delete(key);
      } catch {
        // 补偿失败不覆盖原始错误；对象保留为可核验的孤儿，绝不按前缀全量清空。
      }
    }
    if (pendingInserted) {
      try {
        await deps.metadata.removePending(attachmentId);
      } catch {
        // 同上：pending 记录保留可核验，由后续清理处理。
      }
    }
    if (error instanceof MediaError) throw error;
    throw new MediaError("metadata_unavailable", "图片已处理但元数据保存失败，请稍后重试。");
  }
}

export async function uploadImages(
  deps: MediaServiceDeps,
  input: UploadBatchInput,
): Promise<UploadBatchResult> {
  if (input.files.length === 0) {
    throw new MediaError("invalid_request", "请选择要上传的图片。");
  }
  if (input.files.length > MEDIA_MAX_IMAGES_PER_UPLOAD) {
    throw new MediaError(
      "too_many_images",
      `每次最多上传 ${MEDIA_MAX_IMAGES_PER_UPLOAD} 张图片；请分批上传。`,
    );
  }
  const uploads: UploadFileResult[] = [];
  for (const file of input.files) {
    try {
      uploads.push({
        client_upload_id: file.client_upload_id,
        ok: true,
        attachment: await uploadOne(deps, input.owner_account_id, file),
      });
    } catch (error) {
      if (error instanceof MediaError) {
        uploads.push({
          client_upload_id: file.client_upload_id,
          ok: false,
          code: error.code,
          message: error.message,
        });
        continue;
      }
      throw error;
    }
  }
  return { uploads };
}
