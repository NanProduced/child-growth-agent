"use client";

/**
 * 芽芽输入区：附件条 → 上下文 chips → 文本输入 → 发送/停止。
 *
 * - 中文 IME 组合期间 Enter 不发送（由 ComposerPrimitive.Input 的 isComposing 守门）；
 * - 上下文 chips（对象/来源）只作用于本条消息的待确认卡：随 runConfig.custom 传给
 *   模型适配器（冻结协议没有独立上下文字段，适配器会把上下文并入 user_text；
 *   `ponytail:` 升级点：协议新增上下文字段后改为结构化传递）；
 * - 至多 8 张图片，逐张独立上传；失败可重试、可移除，不丢文字。
 */
import { useEffect, useMemo, useState } from "react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { ChevronDown, RotateCcw, SendHorizontal, Square, Tag, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { YayaImagePicker, YAYA_MAX_IMAGES } from "./yaya-attachment";

const SOURCE_OPTIONS = ["观察草稿", "成长档案", "指南条目", "公开资料"] as const;

export interface YayaComposerContext {
  object: string | null;
  source: string | null;
}

function useAttachmentPreview(file: File | undefined): string | null {
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

function ComposerAttachmentTile() {
  const aui = useAui();
  const attachment = useAuiState((state) => state.attachment);
  const preview = useAttachmentPreview(attachment?.file);
  if (attachment === null || attachment === undefined) return null;
  const pending = attachment.status.type !== "complete";
  const progress = attachment.status.type === "running" ? Math.round(attachment.status.progress * 100) : null;
  const failed = attachment.status.type === "incomplete" && attachment.status.reason === "error";
  return (
    <AttachmentPrimitive.Root className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border bg-muted" data-yaya-attachment>
      {preview !== null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt={attachment.name} className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center p-1 text-[10px] text-muted-foreground">
          {attachment.name}
        </span>
      )}
      {pending ? (
        <span className="absolute inset-x-0 bottom-0 bg-background/85 px-1 py-0.5 text-center text-[10px] text-muted-foreground">
          {failed ? "上传失败" : progress !== null ? `上传中 ${progress}%` : "上传中…"}
        </span>
      ) : null}
      <AttachmentPrimitive.Remove asChild>
        <button
          type="button"
          aria-label={`移除 ${attachment.name}`}
          className="absolute right-0.5 top-0.5 flex size-11 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </AttachmentPrimitive.Remove>
      {failed && attachment.file !== undefined ? (
        <button
          type="button"
          aria-label={`重试上传 ${attachment.name}`}
            className="absolute bottom-0.5 right-0.5 flex size-11 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"
          onClick={() => {
            const file = attachment.file;
            if (file !== undefined) void aui.composer.addAttachment(file);
          }}
        >
          <RotateCcw className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </AttachmentPrimitive.Root>
  );
}

export function YayaComposer({ disabled = false }: { disabled?: boolean }) {
  const aui = useAui();
  // 空线程占位期间 composer/thread 读取会抛错；所有读取包一层，探测不可用即不渲染。
  const composerAvailable = useAuiState((state) => {
    try {
      return state.composer.attachments !== undefined;
    } catch {
      return false;
    }
  });
  const attachments = useAuiState((state) => {
    try {
      return state.composer.attachments;
    } catch {
      return [] as const;
    }
  });
  const canSend = useAuiState((state) => {
    try {
      return state.composer.canSend;
    } catch {
      return false;
    }
  });
  const isRunning = useAuiState((state) => {
    try {
      return state.thread.isRunning;
    } catch {
      return false;
    }
  });
  const [objectName, setObjectName] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [objectDraft, setObjectDraft] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);

  const context = useMemo<YayaComposerContext>(() => ({ object: objectName, source }), [objectName, source]);
  useEffect(() => {
    if (!composerAvailable) return;
    aui.composer.setRunConfig({ custom: { yaya_context: context } });
  }, [aui, composerAvailable, context]);

  if (!composerAvailable) return null;

  const remaining = Math.max(0, YAYA_MAX_IMAGES - attachments.length);

  const addFiles = (files: File[]) => {
    for (const file of files.slice(0, remaining)) {
      void aui.composer.addAttachment(file);
    }
  };

  return (
    <ComposerPrimitive.Root className="border-t bg-background px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      <div className="mx-auto w-full max-w-3xl">
        <ComposerPrimitive.Attachments
          components={{
            Attachment: ComposerAttachmentTile,
          }}
        />
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11 rounded-full text-xs text-muted-foreground"
                aria-label="设置本条消息的对象与来源"
              >
                <Tag className="size-3.5" aria-hidden />
                上下文
                <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="yaya-object" className="text-xs font-medium text-foreground">
                  对象（可选）
                </label>
                <input
                  id="yaya-object"
                  value={objectDraft}
                  onChange={(event) => setObjectDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      setObjectName(objectDraft.trim() === "" ? null : objectDraft.trim());
                    }
                  }}
                  onBlur={() => setObjectName(objectDraft.trim() === "" ? null : objectDraft.trim())}
                  placeholder="例如：小满"
                  className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">来源（可选）</p>
                <div className="flex flex-wrap gap-1.5">
                  {SOURCE_OPTIONS.map((option) => (
                    <Button
                      key={option}
                      type="button"
                      variant={source === option ? "default" : "outline"}
                      size="sm"
                      className="h-11 rounded-full text-xs"
                      onClick={() => setSource(source === option ? null : option)}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                对象与来源只作用于本条消息的待确认卡；页面切换不会改写已存在的卡片。
              </p>
            </PopoverContent>
          </Popover>
          {objectName !== null ? (
            <button
              type="button"
              className="inline-flex h-11 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 text-xs text-emerald-800"
              onClick={() => {
                setObjectName(null);
                setObjectDraft("");
              }}
              aria-label={`移除对象 ${objectName}`}
            >
              对象：{objectName}
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
          {source !== null ? (
            <button
              type="button"
              className="inline-flex h-11 items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-3 text-xs text-sky-800"
              onClick={() => setSource(null)}
              aria-label={`移除来源 ${source}`}
            >
              来源：{source}
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="flex items-end gap-1.5">
          <YayaImagePicker
            onFiles={addFiles}
            onLimitExceeded={(count) =>
              setAttachmentNotice("本次选择超过 8 张上限，已忽略 " + count + " 张；已有图片仍保留。")
            }
            disabled={disabled || isRunning || remaining === 0}
            max={remaining}
            label={remaining === 0 ? "已达 8 张图片上限" : "添加图片"}
          />
          <ComposerPrimitive.Input
            aria-label="给芽芽的消息"
            placeholder="问个幼教问题，或说“记一条小满的观察”…"
            rows={1}
            data-yaya-composer-input
            className={cn(
              "max-h-40 min-h-11 flex-1 resize-none overflow-y-auto rounded-2xl border bg-background px-3 py-2.5 text-base leading-6 outline-none sm:text-sm",
              "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
            )}
            disabled={disabled}
          />
          {isRunning ? (
            <ComposerPrimitive.Cancel asChild>
              <Button type="button" size="icon" className="size-11 shrink-0 rounded-full" aria-label="停止回答">
                <Square className="size-4" aria-hidden />
              </Button>
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button
                type="submit"
                size="icon"
                className="size-11 shrink-0 rounded-full"
                disabled={disabled || !canSend}
                aria-label="发送"
              >
                <SendHorizontal className="size-4" aria-hidden />
              </Button>
            </ComposerPrimitive.Send>
          )}
        </div>
        {attachmentNotice !== null ? (
          <p className="mt-1.5 text-xs leading-5 text-amber-700" aria-live="polite">
            {attachmentNotice}
          </p>
        ) : null}
        <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
          回车发送，Shift+Enter 换行；图片只作观察素材，分析结果不等于幼儿发展结论。
        </p>
      </div>
    </ComposerPrimitive.Root>
  );
}
