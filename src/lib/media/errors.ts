/**
 * MEDIA1 媒体领域错误。
 *
 * 与 AUTH 的 AccountsError 分开：授权类失败继续抛 AccountsError（复用冻结错误体），
 * 本类只表达媒体/对象/元数据/处理语义，路由按 code 映射 HTTP 状态。
 */

export const MEDIA_ERROR_CODES = [
  "invalid_request",
  "too_many_images",
  "file_too_large",
  "unsupported_format",
  "content_type_mismatch",
  "decode_failed",
  "pixel_limit_exceeded",
  "checksum_mismatch",
  "object_conflict",
  "object_store_unavailable",
  "metadata_unavailable",
  "metadata_conflict",
  "media_unavailable",
  "invalid_variant",
  "attachment_not_found",
  "attachment_gone",
  "attachment_deleting",
  "attachment_referenced",
  "deletion_in_progress",
  "reference_query_incomplete",
  "revision_conflict",
  "observation_not_confirmed",
  "source_conflict",
  "not_owner",
  "forbidden",
  "metadata_only",
  "upload_incomplete",
  "bucket_identity_not_isolated",
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

const MEDIA_ERROR_HTTP_STATUS: Record<MediaErrorCode, number> = {
  invalid_request: 400,
  too_many_images: 400,
  file_too_large: 413,
  unsupported_format: 415,
  content_type_mismatch: 415,
  decode_failed: 422,
  pixel_limit_exceeded: 422,
  checksum_mismatch: 502,
  object_conflict: 409,
  object_store_unavailable: 503,
  metadata_unavailable: 503,
  metadata_conflict: 409,
  media_unavailable: 503,
  invalid_variant: 400,
  attachment_not_found: 404,
  attachment_gone: 410,
  attachment_deleting: 409,
  attachment_referenced: 409,
  deletion_in_progress: 409,
  reference_query_incomplete: 503,
  revision_conflict: 409,
  observation_not_confirmed: 409,
  source_conflict: 409,
  not_owner: 403,
  forbidden: 403,
  metadata_only: 403,
  upload_incomplete: 409,
  bucket_identity_not_isolated: 500,
};

export class MediaError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

/** 领域错误 → HTTP 状态；非 MediaError 一律 500，不泄露内部细节 */
export function mediaErrorStatus(error: unknown): number {
  return error instanceof MediaError ? MEDIA_ERROR_HTTP_STATUS[error.code] : 500;
}

export function mediaErrorBody(error: unknown): { error: string; message: string } {
  if (error instanceof MediaError) return { error: error.code, message: error.message };
  return { error: "server_error", message: "服务器暂时无法处理该请求，请稍后重试。" };
}
