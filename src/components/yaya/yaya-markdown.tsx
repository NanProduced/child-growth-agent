"use client";

/**
 * 芽芽回答的安全 Markdown 渲染。
 *
 * 只解析受支持的子集并用 React 元素构造输出：
 * - 永不输出原始 HTML（`<script>` 等一律当普通文本）；
 * - 链接只允许 http/https，其余协议不渲染成可点击链接；
 * - 不用 dangerouslySetInnerHTML，不存在 HTML 注入面；
 * - 长答默认收起，可展开全文（不裁断内容）。
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

export type YayaMarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string }
  | { type: "quote"; text: string }
  | { type: "divider" };

export type YayaInlineToken =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

const HEADING_PATTERN = /^(#{1,4})\s+(.*)$/;
const UNORDERED_PATTERN = /^[-*]\s+(.*)$/;
const ORDERED_PATTERN = /^\d+[.)]\s+(.*)$/;
const QUOTE_PATTERN = /^>\s?(.*)$/;

export function parseYayaMarkdown(source: string): YayaMarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: YayaMarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list !== null) {
      blocks.push({ type: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const line of lines) {
    if (code !== null) {
      if (line.trim().startsWith("```")) {
        blocks.push({ type: "code", text: code.join("\n") });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      blocks.push({ type: "divider" });
      continue;
    }
    const heading = HEADING_PATTERN.exec(line);
    if (heading && heading[1] !== undefined && heading[2] !== undefined) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const quote = QUOTE_PATTERN.exec(line);
    if (quote && quote[1] !== undefined) {
      flushParagraph();
      flushList();
      blocks.push({ type: "quote", text: quote[1] });
      continue;
    }
    const unordered = UNORDERED_PATTERN.exec(line);
    const ordered = ORDERED_PATTERN.exec(line);
    if (unordered && unordered[1] !== undefined) {
      flushParagraph();
      if (list === null || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }
    if (ordered && ordered[1] !== undefined) {
      flushParagraph();
      if (list === null || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (code !== null) blocks.push({ type: "code", text: code.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

export function parseYayaInline(text: string): YayaInlineToken[] {
  const tokens: YayaInlineToken[] = [];
  let rest = text;
  const pushText = (value: string) => {
    if (value === "") return;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.type === "text") last.text += value;
    else tokens.push({ type: "text", text: value });
  };
  // 依次匹配：行内代码 → 链接 → 加粗 → 斜体；不匹配即按文本推进一个字符。
  while (rest !== "") {
    const code = /^`([^`]+)`/.exec(rest);
    if (code && code[1] !== undefined) {
      tokens.push({ type: "code", text: code[1] });
      rest = rest.slice(code[0].length);
      continue;
    }
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link && link[1] !== undefined && link[2] !== undefined) {
      if (isSafeHref(link[2])) tokens.push({ type: "link", text: link[1], href: link[2] });
      else pushText(link[1]);
      rest = rest.slice(link[0].length);
      continue;
    }
    const strong = /^\*\*([^*]+)\*\*/.exec(rest);
    if (strong && strong[1] !== undefined) {
      tokens.push({ type: "strong", text: strong[1] });
      rest = rest.slice(strong[0].length);
      continue;
    }
    const em = /^\*([^*]+)\*/.exec(rest);
    if (em && em[1] !== undefined) {
      tokens.push({ type: "em", text: em[1] });
      rest = rest.slice(em[0].length);
      continue;
    }
    pushText(rest[0] ?? "");
    rest = rest.slice(1);
  }
  return tokens;
}

function InlineText({ text }: { text: string }) {
  const tokens = useMemo(() => parseYayaInline(text), [text]);
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.type) {
          case "strong":
            return (
              <strong key={index} className="font-semibold text-foreground">
                {token.text}
              </strong>
            );
          case "em":
            return <em key={index}>{token.text}</em>;
          case "code":
            return (
              <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {token.text}
              </code>
            );
          case "link":
            return (
              <a
                key={index}
                href={token.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {token.text}
              </a>
            );
          default:
            return <span key={index}>{token.text}</span>;
        }
      })}
    </>
  );
}

function MarkdownBody({ blocks }: { blocks: YayaMarkdownBlock[] }) {
  return (
    <div className="space-y-2 text-sm leading-6 [word-break:break-word]">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading":
            return (
              <p
                key={index}
                className={cn(
                  "font-semibold text-foreground",
                  block.level <= 2 ? "text-base" : "text-sm"
                )}
              >
                <InlineText text={block.text} />
              </p>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={index}
                className={cn("ml-4 space-y-1", block.ordered ? "list-decimal" : "list-disc")}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineText text={item} />
                  </li>
                ))}
              </ListTag>
            );
          }
          case "code":
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-5"
              >
                <code>{block.text}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote key={index} className="border-l-2 border-border pl-3 text-muted-foreground">
                <InlineText text={block.text} />
              </blockquote>
            );
          case "divider":
            return <hr key={index} className="border-border" />;
          default:
            return (
              <p key={index} className="whitespace-pre-wrap">
                <InlineText text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}

export function YayaMarkdown({
  text,
  collapsible = true,
  className,
}: {
  text: string;
  collapsible?: boolean;
  className?: string;
}) {
  const blocks = useMemo(() => parseYayaMarkdown(text), [text]);
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 320 || blocks.length > 8;
  const shouldCollapse = collapsible && isLong && !expanded;
  return (
    <div className={cn("relative", className)}>
      <div className={cn(shouldCollapse && "max-h-72 overflow-hidden")}>
        <MarkdownBody blocks={blocks} />
      </div>
      {shouldCollapse ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-background to-transparent">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="pointer-events-auto mb-1 inline-flex h-9 items-center gap-1 rounded-full border bg-background px-3 text-xs font-medium text-foreground shadow-sm"
          >
            展开全文 <ChevronDown className="size-3.5" />
          </button>
        </div>
      ) : null}
      {collapsible && isLong && expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 inline-flex h-9 items-center gap-1 text-xs font-medium text-muted-foreground"
        >
          收起 <ChevronUp className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
