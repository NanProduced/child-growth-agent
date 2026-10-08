"use client";

/**
 * 消息渲染：用户气泡 / 芽芽回答（安全 Markdown + 特殊卡）。
 * 长答默认完整呈现，图片走授权内容接口，正文不执行原始 HTML。
 */
import { useMemo, useState } from "react";
import { ActionBarPrimitive, AuiIf, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import type { TextMessagePartProps } from "@assistant-ui/react";
import { Check, ChevronDown, Copy, Loader2, Quote } from "lucide-react";
import { parsePageQuote } from "@/lib/yaya/page-reference";

import { YayaAttachmentGallery, YayaImageViewer, type YayaGalleryImage } from "./yaya-attachment";
import { YayaAvatar } from "./yaya-avatar";
import { YayaMarkdown } from "./yaya-markdown";
import {
  YayaClarifyPart,
  YayaHistoryNotePart,
  YayaHistoryStatePart,
  YayaReceiptPart,
  YayaRunErrorPart,
  YayaSearchRefusedPart,
  YayaSourcesPart,
  YayaStoppedPart,
  YayaToolResultPart,
} from "./yaya-parts";
import { YayaProposalCard } from "./yaya-proposal";
import { YayaRecoveryPart } from './yaya-recovery';
import { YAYA_PART_NAMES } from "./client/parts";
import { useYayaStore } from "./yaya-provider";

function AssistantText({ text }: TextMessagePartProps) {
  if (text.trim() === "") return null;
  return <YayaMarkdown text={text} />;
}

function AssistantEmpty() {
  const isRunning = useAuiState((state) => state.message.status?.type === "running");
  if (!isRunning) return null;
  return (
    <p role="status" className="flex items-center gap-2 text-sm leading-[1.65] text-muted-foreground">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
      正在处理…
    </p>
  );
}

const DATA_COMPONENTS = {
  by_name: {
    [YAYA_PART_NAMES.sources]: YayaSourcesPart,
    [YAYA_PART_NAMES.clarify]: YayaClarifyPart,
    [YAYA_PART_NAMES.proposal]: YayaProposalCard,
    [YAYA_PART_NAMES.receipt]: YayaReceiptPart,
    [YAYA_PART_NAMES.stopped]: YayaStoppedPart,
    [YAYA_PART_NAMES.toolResult]: YayaToolResultPart,
    [YAYA_PART_NAMES.searchRefused]: YayaSearchRefusedPart,
    [YAYA_PART_NAMES.runError]: YayaRunErrorPart,
    [YAYA_PART_NAMES.historyState]: YayaHistoryStatePart,
    [YAYA_PART_NAMES.historyNote]: YayaHistoryNotePart,
    [YAYA_PART_NAMES.recovery]: YayaRecoveryPart,
  },
  Fallback: undefined,
} as const;

function UserContent() {
  const store = useYayaStore();
  const content = useAuiState((state) => state.message.content);
  const images = useMemo<YayaGalleryImage[]>(() => {
    const list: YayaGalleryImage[] = [];
    for (const part of content) {
      if (part.type !== "image") continue;
      list.push({ attachmentId: part.id ?? part.image, src: part.image, filename: part.filename });
    }
    return list;
  }, [content]);
  const [viewer, setViewer] = useState<YayaGalleryImage | null>(null);
  const text = useMemo(
    () =>
      content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    [content]
  );
  return (
    <>
      {images.length > 0 ? (
        <YayaAttachmentGallery className="justify-end" images={images} onOpen={(image) => setViewer(image)} />
      ) : null}
      {text.trim() !== "" ? (
        <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl bg-emerald-50 px-4 py-3 text-base leading-[1.65] text-emerald-950 [overflow-wrap:anywhere] sm:max-w-[85%] sm:text-[15px]">
          {text}
        </div>
      ) : null}
      <MessagePrimitive.Quote>{(rawQuote) => {
        const quote = parsePageQuote(rawQuote);
        return quote !== null && quote.yayaPage.owner_account_id === store.identity.accountId ? (
        <details className="group max-w-[90%] text-left text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere] sm:max-w-[85%]" data-yaya-page-quote>
          <summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
            <Quote className="size-3.5 shrink-0" aria-hidden />
            <span>引用：{quote.text}</span>
            <ChevronDown className="size-3.5 shrink-0 group-open:rotate-180" aria-hidden />
          </summary>
          <div className="space-y-2 pb-2 pl-2">
            <p className="whitespace-pre-wrap">{quote.yayaPage.summary}</p>
            {quote.selection.trim() !== "" ? (
              <div className="space-y-1">
                <p className="font-medium text-foreground">选中片段</p>
                <blockquote className="whitespace-pre-wrap border-l border-border pl-3 text-foreground/80">{quote.selection}</blockquote>
              </div>
            ) : null}
            <p className="tabular-nums">引用时间：<time dateTime={quote.yayaPage.captured_at}>{quote.yayaPage.captured_at}</time></p>
            <p>仅作对话的关注线索，不作为观察事实依据，也不会自动指定操作对象。</p>
          </div>
        </details>
        ) : null;
      }}</MessagePrimitive.Quote>
      <YayaImageViewer
        open={viewer !== null}
        src={viewer?.src ?? null}
        filename={viewer?.filename}
        onOpenChange={(open) => {
          if (!open) setViewer(null);
        }}
      />
    </>
  );
}

function AssistantContent() {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <YayaAvatar mood="idle" size={28} className="mt-1" />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <MessagePrimitive.Parts
          components={{
            Text: AssistantText,
            Empty: AssistantEmpty,
            data: DATA_COMPONENTS,
          }}
        />
        <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="flex items-center">
        <ActionBarPrimitive.Copy
          aria-label="复制芽芽回答"
          className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:hidden motion-reduce:transition-none"
        >
          <AuiIf condition={(state) => !state.message.isCopied}>
            <Copy className="size-4" aria-hidden />
            复制
          </AuiIf>
          <AuiIf condition={(state) => state.message.isCopied}>
            <Check className="size-4" aria-hidden />
            已复制
          </AuiIf>
        </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </div>
  );
}

export function YayaMessage() {
  return (
    <MessagePrimitive.Root
      data-yaya-message
      className="group mx-auto w-full max-w-[75ch] py-4"
    >
      <AuiIf condition={(state) => state.message.role === "user"}>
        <div className="flex flex-col items-end gap-2">
          <UserContent />
        </div>
      </AuiIf>
      <AuiIf condition={(state) => state.message.role === "assistant"}>
        <AssistantContent />
      </AuiIf>
    </MessagePrimitive.Root>
  );
}
