"use client";

/** Unified natural-language composer; page focus uses assistant-ui's native quote. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { ChevronDown, FileText, LoaderCircle, RotateCcw, SendHorizontal, Square, TextQuote, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useTeacher } from "@/components/teacher-provider";
import { pageReferenceResponseSchema, parsePageQuote, type YayaPageQuote } from "@/lib/yaya/page-reference";
import { yayaGetJson, YayaApiError } from "./client/api";
import { useYayaStore } from "./yaya-provider";

import { YayaImagePicker, YAYA_MAX_IMAGES, useObjectUrl } from "./yaya-attachment";

function ComposerAttachmentTile() {
  const aui = useAui();
  const attachment = useAuiState((state) => state.attachment);
  const preview = useObjectUrl(attachment?.file);
  if (attachment === null || attachment === undefined) return null;
  const pending = attachment.status.type !== "complete" && attachment.status.type !== "requires-action";
  const progress = attachment.status.type === "running" ? Math.round(attachment.status.progress * 100) : null;
  const failed = attachment.status.type === "incomplete" && attachment.status.reason === "error";
  return (
    <AttachmentPrimitive.Root className="relative w-24 shrink-0 overflow-hidden rounded-lg border bg-muted" data-yaya-attachment>
      <AttachmentPrimitive.unstable_Thumb className="h-20 w-full">
        {preview !== null ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={attachment.name} className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center p-1 text-xs text-muted-foreground">
            <AttachmentPrimitive.Name />
          </span>
        )}
      </AttachmentPrimitive.unstable_Thumb>
      {pending ? (
        <span className="block bg-background/85 px-1 py-1 text-center text-xs text-muted-foreground" role="status">
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
          className="flex min-h-11 w-full items-center justify-center gap-2 bg-background text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={() => {
            const file = attachment.file;
            if (file !== undefined) void aui.composer.addAttachment(file);
          }}
        >
          <RotateCcw className="size-3.5" aria-hidden />重试
        </button>
      ) : null}
    </AttachmentPrimitive.Root>
  );
}

export function YayaComposer({ disabled = false }: { disabled?: boolean }) {
  const aui = useAui();
  const store = useYayaStore();
  const { revalidate } = useTeacher();
  const available = useAuiState((s) => { try { return s.composer.attachments !== undefined; } catch { return false; } });
  const attachments = useAuiState((s) => { try { return s.composer.attachments; } catch { return [] as const; } });
  const canSend = useAuiState((s) => { try { return s.composer.canSend; } catch { return false; } });
  const running = useAuiState((s) => { try { return s.thread.isRunning; } catch { return false; } });
  const nativeQuote = useAuiState((s) => { try { return s.composer.quote; } catch { return undefined; } });
  const quote = useMemo(() => parsePageQuote(nativeQuote), [nativeQuote]);
  const [notice, setNotice] = useState<string | null>(null);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceMenu, setReferenceMenu] = useState(false);
  const selection = useRef("");
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const actor = store.identity.accountId;
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, [actor]);
  useEffect(() => {
    if (quote && quote.yayaPage.owner_account_id !== actor && available) aui.composer.setQuote(undefined);
  }, [actor, aui, available, quote]);

  const captureSelection = () => {
    const selected = window.getSelection();
    const range = selected && selected.rangeCount ? selected.getRangeAt(0) : null;
    const element = range?.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element : range?.commonAncestorContainer.parentElement;
    selection.current = element?.closest("main") && !element.closest("input,textarea,[contenteditable],[data-yaya-panel]")
      ? (selected?.toString().trim() ?? "") : "";
  };
  const addReference = async (includeSelection: boolean) => {
    setReferenceMenu(false);
    const selected = includeSelection ? selection.current : "";
    if (includeSelection && !selected) { setNotice("请先在主页面选中文字，再选择引用。"); return; }
    if (selected.length > 1200) { setNotice("选中文字较长，请缩短至1200字以内；输入内容没有丢失。"); return; }
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    const token = ++generation.current;
    setReferenceBusy(true); setNotice(null);
    const sourcePath = window.location.pathname + window.location.search;
    try {
      const { reference } = await yayaGetJson("/api/yaya/page-reference?path=" + encodeURIComponent(sourcePath), pageReferenceResponseSchema, active.signal);
      if (token !== generation.current) return;
      if (reference.owner_account_id !== actor) {
        aui.composer.setQuote(undefined);
        await revalidate();
        setNotice("账号已变化，请重新引用资料。");
        return;
      }
      if (selected && reference.sources.length === 0) {
        setNotice("列表页的选中文字可能包含多个幼儿资料，请在具体幼儿、班级或观察页面引用文字；也可以只引用当前页面入口并直接提问。输入没有丢失。");
        return;
      }
      const next: YayaPageQuote = { text: reference.title, messageId: "page:" + reference.path, yayaPage: reference, selection: selected };
      aui.composer.setQuote(next);
      setNotice(null);
    } catch (error) {
      if (token !== generation.current || active.signal.aborted) return;
      if (error instanceof YayaApiError && [401, 403, 503].includes(error.status)) {
        aui.composer.setQuote(undefined);
        void revalidate();
      }
      setNotice(error instanceof Error ? error.message : "页面引用暂时不可用，可继续直接提问。");
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setReferenceBusy(false); // Closing the Activity aborts, but must not leave a permanent send lock.
      }
    }
  };
  const clearReference = () => {
    generation.current++; controller.current?.abort(); setReferenceBusy(false);
    setNotice(null); // QuoteDismiss owns the actual quote clearing.
  };
  if (!available) return null;
  const remaining = Math.max(0, YAYA_MAX_IMAGES - attachments.length);

  return (
    <ComposerPrimitive.Root className="shrink-0 bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-5" data-yaya-composer
      onSubmitCapture={(event) => { if (referenceBusy) { event.preventDefault(); event.stopPropagation(); } }}
      onKeyDownCapture={(event) => { if (referenceBusy && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); } }}
    >
      <div className="mx-auto w-full max-w-3xl rounded-2xl border bg-background p-3 transition-colors focus-within:border-ring/65">
        {attachments.length > 0 ? <div className="mb-2 flex max-h-44 flex-wrap gap-2 overflow-y-auto"><ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachmentTile }} /></div> : null}
        {quote && quote.yayaPage.owner_account_id === actor ? (
          <ComposerPrimitive.Quote className="mb-2 flex max-w-full items-center rounded-xl bg-muted/60" data-yaya-page-quote>
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" className="h-11 min-w-0 flex-1 justify-start gap-2 px-3 text-xs" aria-label="查看页面引用">
                  <FileText className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">已引用：<ComposerPrimitive.QuoteText /></span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="z-60 w-[min(360px,calc(100vw-32px))] space-y-3 text-sm">
                <p className="font-medium">{quote.yayaPage.title}</p>
                <p className="text-xs leading-5 text-muted-foreground">这是本条消息的关注线索，不会替芽芽指定工具或改变权限。切换页面不会改写此引用。</p>
                <p className="break-words text-xs leading-5">{quote.yayaPage.summary}</p>
                {quote.selection ? <blockquote className="max-h-44 overflow-auto whitespace-pre-wrap text-sm leading-6">{quote.selection}</blockquote> : null}
                <a href={quote.yayaPage.path} className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4">查看来源页面</a>
              </PopoverContent>
            </Popover>
            <ComposerPrimitive.QuoteDismiss asChild onClick={clearReference}><Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label="移除页面引用"><X className="size-4" aria-hidden /></Button></ComposerPrimitive.QuoteDismiss>
          </ComposerPrimitive.Quote>
        ) : null}
        <ComposerPrimitive.Input
          aria-label="给芽芽的消息"
          placeholder="直接描述你的问题或观察…"
          rows={2}
          data-yaya-composer-input
          className={cn("max-h-44 min-h-20 w-full resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 text-base leading-7 outline-none placeholder:text-muted-foreground", "focus-visible:ring-0 disabled:opacity-60")}
          disabled={disabled}
        />
        <div className="mt-1 flex items-center gap-2">
          <YayaImagePicker
            onFiles={(files) => { for (const file of files.slice(0, remaining)) void aui.composer.addAttachment(file); }}
            onLimitExceeded={(count) => setNotice("本次选择超过8张上限，已忽略" + count + "张；已有图片仍保留。")}
            disabled={disabled || running || remaining === 0}
            max={remaining}
            label={remaining === 0 ? "已达8张图片上限" : "添加图片"}
          />
          <Popover open={referenceMenu} onOpenChange={setReferenceMenu}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" className="h-11 gap-1.5 px-2 text-xs sm:text-sm" aria-label="引用页面或选中文字" disabled={disabled || running || referenceBusy} onPointerDown={captureSelection} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") captureSelection(); }}>
                {referenceBusy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <FileText className="size-4" aria-hidden />}
                {referenceBusy ? "正在引用…" : "引用当前页"}
                <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="z-60 w-72 p-2">
              <Button type="button" variant="ghost" className="h-11 w-full justify-start gap-2" onClick={() => void addReference(false)}><FileText className="size-4" aria-hidden />引用当前页面</Button>
              <Button type="button" variant="ghost" className="h-11 w-full justify-start gap-2" onClick={() => void addReference(true)}><TextQuote className="size-4" aria-hidden />引用选中文字</Button>
              <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">可选。直接提问也可以，不需要先选幼儿或业务模块。</p>
            </PopoverContent>
          </Popover>
          <span className="flex-1" />
          {running ? (
            <ComposerPrimitive.Cancel asChild><Button type="button" size="icon" className="size-11 shrink-0 rounded-full" aria-label="停止回答"><Square className="size-4" aria-hidden /></Button></ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send asChild><Button type="submit" size="icon" className="size-11 shrink-0 rounded-full disabled:bg-muted disabled:text-muted-foreground" disabled={disabled || !canSend || referenceBusy} aria-label="发送"><SendHorizontal className="size-5" aria-hidden /></Button></ComposerPrimitive.Send>
          )}
        </div>
      </div>
      {notice !== null ? <p className="mx-auto mt-2 max-w-3xl text-xs leading-5 text-amber-700" role="status">{notice}</p> : null}
      <p className="mx-auto mt-2 max-w-3xl text-right text-xs leading-5 text-muted-foreground">写入前会请你核对确认</p>
    </ComposerPrimitive.Root>
  );
}
