import { createHash, randomUUID } from "node:crypto";

import { buildObjectKey } from "./config";
import { MediaError } from "./errors";
import { processImage, sniffImageContentType } from "./image-processing";
import {
  MEDIA_ALLOWED_CONTENT_TYPES,
  MEDIA_MAX_IMAGES_PER_UPLOAD,
  MEDIA_MAX_IMAGE_BYTES,
  type MediaContentType,
} from "./limits";
import type { AttachmentRecord, RegisterAttachmentInput } from "./metadata-port";
import { sha256Hex } from "./object-store";
import type { MediaServiceDeps } from "./runtime";

/**
 * MEDIA1 上传编排（R1：未知结果不得破坏已提交对象；R2：无键上传同一身份可恢复）。
 *
 * 冻结口径：
 * - 账号私有上传：只要求已认证账号，不要求幼儿、不要求 ≥10 字；上传不形成业务观察；
 * - 每次最多 8 张、单图 10MiB；服务端魔数 + 解码 + 像素上限；不支持的格式**逐图**
 *   明确报错，其他图片与文字不受影响；
 * - 对象只写一次并回读核对 checksum；只保存对象引用，不保存任何 URL；
 * - **稳定身份**：显式 `client_upload_id` 派生确定性 attachment_id；无键上传按
 *   `owner + 原始字节 checksum` 派生内容身份——同一输入重试永远命中同一身份，
 *   不需要教师或客户端携带任何标识；不同内容（含仅 EXIF 不同）身份不同；
 * - **幂等与内容绑定**：按原身份读回；同内容恢复原结果，同键异内容明确冲突；
 * - **未知结果**：注册异常不等于未提交。按原身份读回：已提交且完整 → 恢复；
 *   读回失败/未找到 → 保留对象与可恢复身份，报 `upload_unknown`，
 *   **绝不**在注册尝试后进行破坏性补偿；正常回应也走同一核对（身份/owner/
 *   内容/完整性/ready），非 ready 或错配回应不显示成功；
 * - **确定失败补偿**：只有随机兜底身份（内容身份已被回收后的重新上传）在对象写入
 *   阶段失败时才精确清理本轮创建的 key；delete 未知/抛错报 `compensation_unknown`；
 * - 不按前缀扫描或清空；一张失败不清空其余图片与文字。
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
  | {
      client_upload_id: string | null;
      ok: false;
      code: string;
      message: string;
      /** 未知结果的可恢复身份：对象已保留，可用同一上传标识重试 */
      recoverable?: { attachment_id: string };
    };

export interface UploadBatchResult {
  uploads: readonly UploadFileResult[];
}

function normalizedClientUploadId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 确定性附件身份（显式幂等键）：同一 owner + client_upload_id 永远映射同一
 * attachment_id，使重试/响应丢失后可以按原身份读回，不新建上传身份绕过未知结果。
 */
export function deterministicAttachmentId(ownerAccountId: string, clientUploadId: string): string {
  return uuidShapedHash(`yaya-media1:client:${ownerAccountId}\u0000${clientUploadId}`);
}

/**
 * 内容派生的稳定附件身份（无幂等键上传）：同一 owner + 同一原始字节映射同一
 * attachment_id，因此“同一输入重试”不需要教师或客户端携带任何标识，也能按原身份
 * 恢复未知结果；不同内容（含仅 EXIF 不同）得到不同身份，绝不静默复用旧图。
 * 与显式键命名空间分离，两者不会互相碰撞。
 */
export function contentAttachmentId(ownerAccountId: string, sourceChecksum: string): string {
  return uuidShapedHash(`yaya-media1:content:${ownerAccountId}\u0000${sourceChecksum}`);
}

function uuidShapedHash(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeDeclared(value: string | null): string | null {
  if (value === null) return null;
  const essence = value.split(";", 1)[0]?.trim().toLowerCase();
  return essence && essence.length > 0 ? essence : null;
}

export function attachmentRecordIsComplete(record: AttachmentRecord): boolean {
  const blank = (value: string) => typeof value !== "string" || value.trim() === "";
  return (
    !blank(record.object_key) &&
    !blank(record.thumbnail_key) &&
    !blank(record.model_key) &&
    !blank(record.checksum_sha256) &&
    !blank(record.thumbnail_checksum) &&
    !blank(record.model_checksum) &&
    !blank(record.source_checksum) &&
    (MEDIA_ALLOWED_CONTENT_TYPES as readonly string[]).includes(record.content_type) &&
    Number.isFinite(record.byte_size) &&
    record.byte_size >= 0 &&
    Number.isInteger(record.width) &&
    Number.isInteger(record.height) &&
    record.width > 0 &&
    record.height > 0
  );
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

/** 已登记记录恢复/回应核对：身份、owner、内容绑定、完整性与 ready 全部一致才成功 */
function restoreRegistered(
  record: AttachmentRecord,
  ownerAccountId: string,
  sourceChecksum: string,
  expectedAttachmentId: string,
): UploadAttachmentView {
  if (record.attachment_id !== expectedAttachmentId) {
    throw new MediaError("upload_unknown", "登记回应与预期身份不一致，结果未知。", {
      attachment_id: expectedAttachmentId,
    });
  }
  if (record.owner_account_id !== ownerAccountId) {
    throw new MediaError("idempotency_conflict", "该上传标识属于其他账号，拒绝复用。", {
      attachment_id: record.attachment_id,
    });
  }
  if (!attachmentRecordIsComplete(record)) {
    throw new MediaError("upload_unknown", "上次上传的元数据不完整，请稍后重试。", {
      attachment_id: record.attachment_id,
    });
  }
  if (record.source_checksum !== sourceChecksum) {
    throw new MediaError(
      "idempotency_conflict",
      "同一上传标识不能更换图片内容；请使用新的上传标识。",
      { attachment_id: record.attachment_id },
    );
  }
  if (record.status !== "ready") {
    throw new MediaError("attachment_gone", "该图片已进入回收流程，不能再作为新上传复用。", {
      attachment_id: record.attachment_id,
    });
  }
  return toAttachmentView(record);
}

async function readBackRegistered(
  deps: MediaServiceDeps,
  attachmentId: string,
): Promise<{ state: "found"; record: AttachmentRecord } | { state: "absent" } | { state: "unavailable" }> {
  try {
    const record = await deps.metadata.get(attachmentId);
    return record ? { state: "found", record } : { state: "absent" };
  } catch {
    return { state: "unavailable" };
  }
}

/** 对象写入阶段失败（注册未发生）：只清理本轮确实创建的精确 key */
async function compensateCreatedObjects(deps: MediaServiceDeps, createdKeys: readonly string[]): Promise<void> {
  const unknowns: string[] = [];
  for (const key of createdKeys) {
    let outcome: "deleted" | "not_found" | "unknown";
    try {
      outcome = await deps.store.delete(key);
    } catch {
      outcome = "unknown";
    }
    if (outcome === "unknown") unknowns.push(key);
  }
  if (unknowns.length > 0) {
    throw new MediaError("compensation_unknown", "上传失败且对象清理结果未知，请稍后核对后再试。", {
      object_keys: unknowns,
    });
  }
}

async function uploadOne(
  deps: MediaServiceDeps,
  ownerAccountId: string,
  file: UploadFileInput,
): Promise<UploadAttachmentView> {
  const clientUploadId = normalizedClientUploadId(file.client_upload_id);
  const sourceChecksum = sha256Hex(file.body);
  const keyedId = clientUploadId === null ? null : deterministicAttachmentId(ownerAccountId, clientUploadId);
  const contentId = contentAttachmentId(ownerAccountId, sourceChecksum);
  let attachmentId = keyedId ?? contentId;

  // 幂等前置：显式键与内容派生身份都可按“同一输入重试”读回原记录；
  // 读回失败保留未知语义，不进入新写入，也不产生新身份。
  {
    const preflightId = keyedId ?? contentId;
    const existing = await readBackRegistered(deps, preflightId);
    if (existing.state === "found") {
      if (existing.record.status === "deleted" && clientUploadId === null) {
        // 内容身份已被回收：主键不可复用，为本次新上传分配新身份（窄边界，见 R2 交付文档）。
        attachmentId = randomUUID();
      } else {
        return restoreRegistered(existing.record, ownerAccountId, sourceChecksum, preflightId);
      }
    } else if (existing.state === "unavailable") {
      throw new MediaError("upload_unknown", "无法核对上次上传结果，请稍后重试。", {
        attachment_id: preflightId,
      });
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
  let registerAttempted = false;
  const put = async (key: string, content_type: string, body: Buffer): Promise<string> => {
    const result = await deps.store.putOnce({ key, content_type, body });
    if (result.outcome === "conflict") {
      throw new MediaError("object_conflict", "对象已存在且内容不一致，拒绝覆盖。");
    }
    if (result.outcome === "created") createdKeys.push(key);
    return result.checksum_sha256;
  };

  try {
    const originalChecksum = await put(keys.original, processed.content_type, processed.original);
    const thumbnailChecksum = await put(keys.thumbnail, "image/webp", processed.thumbnail);
    const modelChecksum = await put(keys.model, "image/jpeg", processed.model);

    const registerInput: RegisterAttachmentInput = {
      attachment_id: attachmentId,
      owner_account_id: ownerAccountId,
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
      source_checksum: sourceChecksum,
      client_upload_id: clientUploadId,
    };

    registerAttempted = true;
    let registered: AttachmentRecord;
    try {
      registered = await deps.metadata.registerAttachment(registerInput);
    } catch (error) {
      // 注册异常不等于未提交：按原身份读回；未知时保留对象与可恢复身份。
      const readBack = await readBackRegistered(deps, attachmentId);
      if (readBack.state === "found") {
        return restoreRegistered(readBack.record, ownerAccountId, sourceChecksum, attachmentId);
      }
      throw new MediaError(
        "upload_unknown",
        "上传结果未知，图片对象已保留；请使用同一上传标识重试。",
        { attachment_id: attachmentId, cause: error instanceof MediaError ? error.code : "unknown" },
      );
    }
    // 正常回应同样走统一核对：身份/owner/内容/完整性/ready 一致才显示成功；
    // 核对失败不回读覆盖不一致的回应，也不做破坏性补偿（对象保留）。
    return restoreRegistered(registered, ownerAccountId, sourceChecksum, attachmentId);
  } catch (error) {
    if (!registerAttempted) {
      // 对象写入阶段失败（注册尚未发生）。确定性身份（显式键或内容派生）下，
      // 并发重复请求/同一输入重试可复用这些对象，因此保留；只有随机兜底身份
      // （内容身份已被回收后重新上传）才做精确补偿。
      const recoverableIdentity = attachmentId === contentId || attachmentId === keyedId;
      if (!recoverableIdentity && createdKeys.length > 0) {
        await compensateCreatedObjects(deps, createdKeys);
      }
      if (error instanceof MediaError) throw error;
      throw new MediaError("object_store_unavailable", "对象存储暂时不可用，请稍后重试。");
    }
    // 注册已尝试：任何未知/冲突结果都不做破坏性补偿。
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
        client_upload_id: normalizedClientUploadId(file.client_upload_id),
        ok: true,
        attachment: await uploadOne(deps, input.owner_account_id, file),
      });
    } catch (error) {
      if (error instanceof MediaError) {
        const attachmentId = error.details?.attachment_id;
        uploads.push({
          client_upload_id: normalizedClientUploadId(file.client_upload_id),
          ok: false,
          code: error.code,
          message: error.message,
          ...(error.code === "upload_unknown" && typeof attachmentId === "string"
            ? { recoverable: { attachment_id: attachmentId } }
            : {}),
        });
        continue;
      }
      throw error;
    }
  }
  return { uploads };
}
