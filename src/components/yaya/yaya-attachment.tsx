"use client";

/**
 * 可复用的选图 / 附件条 / 图片查看组件（芽芽与后续传统页面共用）。
 *
 * - 至多 8 张、JPEG/PNG/WebP、单图 ≤10MiB（客户端只做快速失败，服务端守门）；
 * - 每张图片独立上传、独立失败、独立重试/移除；失败不丢文字与其他图片；
 * - 预览只用本地 File 或授权内容接口 URL，不抓任意远程 URL。
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Attachment } from "@assistant-ui/react";
import { ImagePlus, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { MEDIA_ALLOWED_CONTENT_TYPES, MEDIA_MAX_IMAGE_BYTES, MEDIA_MAX_IMAGES_PER_UPLOAD } from "@/lib/media/limits";

export const YAYA_IMAGE_ACCEPT = MEDIA_ALLOWED_CONTENT_TYPES.join(",");
export const YAYA_MAX_IMAGES = MEDIA_MAX_IMAGES_PER_UPLOAD;
export const YAYA_MAX_IMAGE_BYTES = MEDIA_MAX_IMAGE_BYTES;

export function YayaImagePicker({
  onFiles,
  onLimitExceeded,
  disabled = false,
  max = YAYA_MAX_IMAGES,
  label = "添加图片",
  className,
}: {
  onFiles: (files: File[]) => void;
  onLimitExceeded?: (count: number) => void;
  disabled?: boolean;
  max?: number;
  label?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  return (
    <>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={YAYA_IMAGE_ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > max) onLimitExceeded?.(files.length - max);
          if (files.length > 0) onFiles(files.slice(0, max));
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={label}
        title={label}
        className={cn("size-11 shrink-0 rounded-full text-muted-foreground", className)}
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus className="size-5" aria-hidden />
      </Button>
    </>
  );
}

function useObjectUrl(file: File | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file === undefined) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

export interface YayaAttachmentPreview {
  src: string | null;
  alt: string;
}

function AttachmentTile({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: Attachment;
  onRemove: (attachment: Attachment) => void;
  onRetry?: (file: File) => void;
}) {
  const pending = attachment.status.type !== "complete";
  const progress =
    attachment.status.type === "running" ? Math.round((attachment.status.progress ?? 0) * 100) : null;
  const failed = attachment.status.type === "incomplete" && attachment.status.reason === "error";
  const preview = useObjectUrl(attachment.file);
  return (
    <li className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border bg-muted" data-yaya-attachment>
      {preview !== null ? (
        // 本地文件预览；非业务图，不用 next/image 优化。
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt={attachment.name} className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
          {attachment.name}
        </span>
      )}
      {pending ? (
        <span className="absolute inset-x-0 bottom-0 bg-background/85 px-1 py-0.5 text-center text-[10px] text-muted-foreground">
          {failed ? "上传失败" : progress !== null ? `上传中 ${progress}%` : "上传中…"}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`移除 ${attachment.name}`}
        className="absolute right-0.5 top-0.5 flex size-11 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"
        onClick={() => onRemove(attachment)}
      >
        <X className="size-3.5" aria-hidden />
      </button>
      {failed && onRetry !== undefined && attachment.file !== undefined ? (
        <button
          type="button"
          aria-label={`重试上传 ${attachment.name}`}
          className="absolute bottom-0.5 right-0.5 flex size-11 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"
          onClick={() => {
            const file = attachment.file;
            if (file !== undefined) onRetry(file);
          }}
        >
          <RotateCcw className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

export function YayaAttachmentStrip({
  attachments,
  onRemove,
  onRetry,
  className,
}: {
  attachments: readonly Attachment[];
  onRemove: (attachment: Attachment) => void;
  onRetry?: (file: File) => void;
  className?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-2", className)} data-yaya-attachment-strip>
      {attachments.map((attachment) => (
        <AttachmentTile
          key={attachment.id}
          attachment={attachment}
          onRemove={onRemove}
          onRetry={onRetry}
        />
      ))}
    </ul>
  );
}

export function YayaImageViewer({
  open,
  src,
  filename,
  onOpenChange,
}: {
  open: boolean;
  src: string | null;
  filename?: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-2 sm:p-4" data-yaya-image-viewer>
        <DialogTitle className="sr-only">{filename ?? "图片查看"}</DialogTitle>
        <DialogDescription className="sr-only">
          授权内容接口返回的图片；不可用时不会显示占位成功。
        </DialogDescription>
        {src !== null ? (
          // 授权内容接口需要同源凭据，不走 next/image 远程优化。
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={filename ?? "图片"} className="max-h-[75vh] w-full rounded-md object-contain" />
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">图片当前不可读。</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface YayaGalleryImage {
  attachmentId: string;
  src: string;
  filename?: string;
}

export function YayaAttachmentGallery({
  images,
  onOpen,
  className,
}: {
  images: readonly YayaGalleryImage[];
  onOpen?: (image: YayaGalleryImage) => void;
  className?: string;
}) {
  if (images.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)} data-yaya-gallery>
      {images.map((image) => (
        <button
          key={image.attachmentId}
          type="button"
          className="relative size-24 overflow-hidden rounded-lg border focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => onOpen?.(image)}
          aria-label={`查看图片 ${image.filename ?? ""}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.src} alt={image.filename ?? "观察图片"} className="size-full object-cover" loading="lazy" />
        </button>
      ))}
    </div>
  );
}
