"use client";

/**
 * 消息渲染：用户气泡 / 芽芽回答（安全 Markdown + 特殊卡）。
 * 长答完整呈现（收起可展开），图片走授权内容接口，正文不执行原始 HTML。
 */
import { useMemo, useState } from "react";
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import type { TextMessagePartProps } from "@assistant-ui/react";

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
import { YAYA_PART_NAMES } from "./client/parts";

function AssistantText({ text }: TextMessagePartProps) {
  if (text.trim() === "") return null;
  return <YayaMarkdown text={text} />;
}

function AssistantEmpty() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <YayaAvatar mood="thinking" size={20} />
      正在想…
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
  },
  Fallback: undefined,
} as const;

function UserContent() {
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
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
          {text}
        </div>
      ) : null}
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
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <YayaAvatar mood="idle" size={24} className="mt-1" />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <MessagePrimitive.Parts
          components={{
            Text: AssistantText,
            Empty: AssistantEmpty,
            data: DATA_COMPONENTS,
          }}
        />
      </div>
    </div>
  );
}

export function YayaMessage() {
  return (
    <MessagePrimitive.Root
      data-yaya-message
      className="group px-1 py-1.5"
    >
      <MessagePrimitive.If user>
        <div className="flex flex-col items-end gap-1.5">
          <UserContent />
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <AssistantContent />
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}
