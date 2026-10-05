import { NextRequest, NextResponse } from "next/server";

import { MediaError } from "@/lib/media/errors";
import { MEDIA_MAX_IMAGES_PER_UPLOAD, MEDIA_MAX_IMAGE_BYTES } from "@/lib/media/limits";
import { requireMediaWritePrincipal } from "@/lib/media/request-guard";
import { mediaRouteError } from "@/lib/media/route-error";
import { mediaRuntimeOrThrow } from "@/lib/media/runtime";
import {
  uploadImages,
  type UploadFileInput,
  type UploadFileResult,
} from "@/lib/media/upload-service";

/**
 * POST /api/yaya/uploads
 *
 * 账号私有图片上传（multipart/form-data）：
 * - 字段 `files`：最多 8 个文件；可选 `client_batch_id` 提供重复请求幂等；
 * - 不要求幼儿、不要求文字长度；上传不形成业务观察；
 * - 逐图返回结果：不支持的格式/超限只影响该图，其他图片与文字保留；
 * - 响应只含附件元数据，不含对象 key 或任何 URL。
 */

const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface UploadSlot {
  client_upload_id: string | null;
  error: MediaError | null;
  input: UploadFileInput | null;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMediaWritePrincipal(request);
    const runtime = mediaRuntimeOrThrow();
    const form = await request.formData().catch(() => null);
    if (form === null) {
      throw new MediaError("invalid_request", "请求必须为 multipart/form-data。");
    }
    const entries = form.getAll("files");
    if (entries.length === 0) {
      throw new MediaError("invalid_request", "请选择要上传的图片。");
    }
    if (entries.length > MEDIA_MAX_IMAGES_PER_UPLOAD) {
      throw new MediaError(
        "too_many_images",
        `每次最多上传 ${MEDIA_MAX_IMAGES_PER_UPLOAD} 张图片；请分批上传。`,
      );
    }
    const rawBatchId = form.get("client_batch_id");
    let batchId: string | null = null;
    if (typeof rawBatchId === "string" && rawBatchId.length > 0) {
      if (!BATCH_ID_PATTERN.test(rawBatchId)) {
        throw new MediaError("invalid_request", "client_batch_id 格式不合法。");
      }
      batchId = rawBatchId;
    }

    const slots: UploadSlot[] = [];
    const validInputs: UploadFileInput[] = [];
    for (const [index, entry] of entries.entries()) {
      const clientUploadId = batchId === null ? null : `${batchId}:${index}`;
      if (!(entry instanceof File)) {
        slots.push({
          client_upload_id: clientUploadId,
          error: new MediaError("invalid_request", "上传项不是有效文件。"),
          input: null,
        });
        continue;
      }
      if (entry.size > MEDIA_MAX_IMAGE_BYTES) {
        slots.push({
          client_upload_id: clientUploadId,
          error: new MediaError("file_too_large", "单张图片不能超过 10MiB，请压缩后再上传。"),
          input: null,
        });
        continue;
      }
      const input: UploadFileInput = {
        filename: entry.name.length > 0 ? entry.name : null,
        declared_content_type: entry.type.length > 0 ? entry.type : null,
        body: Buffer.from(await entry.arrayBuffer()),
        client_upload_id: clientUploadId,
      };
      slots.push({ client_upload_id: clientUploadId, error: null, input });
      validInputs.push(input);
    }

    const batch =
      validInputs.length > 0
        ? await uploadImages(runtime, {
            owner_account_id: principal.account_id,
            files: validInputs,
          })
        : { uploads: [] as UploadFileResult[] };

    let cursor = 0;
    const uploads: UploadFileResult[] = slots.map((slot) => {
      if (slot.error !== null) {
        return {
          client_upload_id: slot.client_upload_id,
          ok: false,
          code: slot.error.code,
          message: slot.error.message,
        };
      }
      const result = batch.uploads[cursor];
      cursor += 1;
      if (result === undefined) {
        throw new MediaError("metadata_unavailable", "上传结果不完整，请重试。");
      }
      return result;
    });
    return NextResponse.json({ uploads });
  } catch (error) {
    return mediaRouteError(error);
  }
}
