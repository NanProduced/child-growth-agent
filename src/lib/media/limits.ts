/**
 * MEDIA1 输入限额与派生规格（初始值，按产品调整时只改这里）。
 *
 * 关键口径：
 * - 客户端限额不是权限依据，服务端始终重新校验（魔数、解码、像素、字节）。
 * - 单图 10MiB / 每次 8 张是初始限制；JPEG/PNG/WebP 之外明确说明不支持。
 * - 图像解码在服务端完成；本模块不抓取任何远程 URL。
 */

import { MediaError } from "./errors";

export const MEDIA_MAX_IMAGES_PER_UPLOAD = 8;

export const MEDIA_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const MEDIA_ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type MediaContentType = (typeof MEDIA_ALLOWED_CONTENT_TYPES)[number];

/**
 * 解码像素上限（宽×高）。低于常见手机原图上限、显著高于业务展示需要，
 * 目的是挡住解压炸弹，而不是压缩正常照片。
 */
export const MEDIA_MAX_PIXELS = 40_000_000;

/** 缩略图最大边（列表/预览用） */
export const MEDIA_THUMBNAIL_MAX_EDGE = 320;

/** 模型用图最大边（送入 LLM 前的服务端压缩图） */
export const MEDIA_MODEL_MAX_EDGE = 1024;

export const MEDIA_VARIANTS = ["original", "thumbnail", "model"] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

/**
 * 必要签名 URL 的 TTL 上限（秒）。首选服务端认证代理读取字节；
 * 如未来必须签名，不得超过该值，且签名绝不落库/日志/聊天/模型历史。
 */
export const MEDIA_SIGNED_URL_MAX_TTL_SECONDS = 300;

/** 签名 TTL 守卫：任何必要签名必须显式给出短 TTL，超限/非法一律拒绝 */
export function assertShortSignedUrlTtl(ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MEDIA_SIGNED_URL_MAX_TTL_SECONDS) {
    throw new MediaError(
      "invalid_request",
      `签名有效期必须为 1-${MEDIA_SIGNED_URL_MAX_TTL_SECONDS} 秒；长期签名一律拒绝。`,
    );
  }
}

/** 派生图内容类型：缩略图 WebP、模型图 JPEG（压缩与兼容性固定，不随原图格式变化） */
export function variantContentType(recordContentType: MediaContentType, variant: MediaVariant): string {
  if (variant === "thumbnail") return "image/webp";
  if (variant === "model") return "image/jpeg";
  return recordContentType;
}
