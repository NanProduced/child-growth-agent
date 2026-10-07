import sharp from "sharp";
import type { Metadata, Sharp } from "sharp";

import { MediaError } from "./errors";
import {
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_PIXELS,
  MEDIA_MODEL_MAX_EDGE,
  MEDIA_THUMBNAIL_MAX_EDGE,
  type MediaContentType,
} from "./limits";

/**
 * MEDIA1 服务端图片处理（真实 sharp 解码/编码）。
 *
 * - 魔数先判格式（不信任文件名/声明类型）；JPEG/PNG/WebP 之外明确拒绝；
 * - 解码前检查像素上限，并给 sharp 同样的 limitInputPixels，两级都挡解压炸弹；
 * - 所有输出都重新编码，天然移除 EXIF/EXIF 方向；编码后再读元数据核对确实没有
 *   EXIF，清理失败即拒绝保存；
 * - 生成缩略图（WebP）与模型用图（JPEG）；拍摄时间/人脸等 EXIF 信息不作为业务
 *   事实，也不会出现在返回结构里（图像解读只由后续模型/教师确认产生）。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ProcessedImage {
  content_type: MediaContentType;
  width: number;
  height: number;
  original: Buffer;
  thumbnail: Buffer;
  model: Buffer;
}

/** 魔数识别；识别不了返回 null（不猜测、不按扩展名放行） */
export function sniffImageContentType(body: Uint8Array): MediaContentType | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  if (body.length >= 8 && Buffer.from(body.subarray(0, 8)).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (
    body.length >= 12 &&
    Buffer.from(body.subarray(0, 4)).toString("latin1") === "RIFF" &&
    Buffer.from(body.subarray(8, 12)).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function assertWithinPixelLimit(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new MediaError("decode_failed", "图片尺寸无法识别，请更换图片后重试。");
  }
  if (width * height > MEDIA_MAX_PIXELS) {
    throw new MediaError(
      "pixel_limit_exceeded",
      `图片像素超过上限（${MEDIA_MAX_PIXELS} 像素），请先缩小后再上传。`,
    );
  }
}

function orientedSize(meta: Metadata): { width: number; height: number } {
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (meta.orientation !== undefined && meta.orientation >= 5) {
    return { width: height, height: width };
  }
  return { width, height };
}

function encodeOriginal(image: Sharp, contentType: MediaContentType): Promise<Buffer> {
  const oriented = image.autoOrient();
  if (contentType === "image/jpeg") return oriented.jpeg({ quality: 88 }).toBuffer();
  if (contentType === "image/png") return oriented.png({ compressionLevel: 8 }).toBuffer();
  return oriented.webp({ quality: 85 }).toBuffer();
}

function basePipeline(body: Buffer): Sharp {
  return sharp(body, { limitInputPixels: MEDIA_MAX_PIXELS, failOn: "error" });
}

export async function processImage(body: Buffer): Promise<ProcessedImage> {
  if (body.length === 0) throw new MediaError("decode_failed", "图片内容为空，无法解码。");
  if (body.length > MEDIA_MAX_IMAGE_BYTES) {
    throw new MediaError("file_too_large", "单张图片不能超过 10MiB，请压缩后再上传。");
  }
  const sniffed = sniffImageContentType(body);
  if (sniffed === null) {
    throw new MediaError(
      "unsupported_format",
      "仅支持 JPEG、PNG、WebP 图片；其他格式不会被上传，文字与其他图片仍会保留。",
    );
  }

  let meta: Metadata;
  try {
    // 头部解析不设像素上限（只读头，不解码整图），由显式尺寸检查给出明确错误；
    // 真正的解码管线仍带 limitInputPixels 兜底。
    meta = await sharp(body, { limitInputPixels: false, failOn: "error" }).metadata();
  } catch {
    throw new MediaError("decode_failed", "图片无法解码或已损坏，请更换图片后重试。");
  }
  const { width, height } = orientedSize(meta);
  assertWithinPixelLimit(width, height);
  const formatName = meta.format;
  const formatMatches =
    (sniffed === "image/jpeg" && formatName === "jpeg") ||
    (sniffed === "image/png" && formatName === "png") ||
    (sniffed === "image/webp" && formatName === "webp");
  if (!formatMatches) {
    throw new MediaError("unsupported_format", "图片实际格式与内容不符，已拒绝上传。");
  }

  let original: Buffer;
  let thumbnail: Buffer;
  let model: Buffer;
  try {
    original = await encodeOriginal(basePipeline(body), sniffed);
    thumbnail = await basePipeline(body)
      .autoOrient()
      .resize({
        width: MEDIA_THUMBNAIL_MAX_EDGE,
        height: MEDIA_THUMBNAIL_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 72 })
      .toBuffer();
    model = await basePipeline(body)
      .autoOrient()
      .resize({
        width: MEDIA_MODEL_MAX_EDGE,
        height: MEDIA_MODEL_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError("decode_failed", "图片处理失败，请更换图片后重试。");
  }

  // 输出核对：三张图都不得携带 EXIF（清理失败不保存）。
  const [originalMeta, thumbnailMeta, modelMeta] = await Promise.all([
    sharp(original).metadata(),
    sharp(thumbnail).metadata(),
    sharp(model).metadata(),
  ]);
  if (originalMeta.exif !== undefined || thumbnailMeta.exif !== undefined || modelMeta.exif !== undefined) {
    throw new MediaError("decode_failed", "图片元数据清理失败，已拒绝保存。");
  }

  return { content_type: sniffed, width, height, original, thumbnail, model };
}
