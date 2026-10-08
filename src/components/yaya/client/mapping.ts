/**
 * 消息 ↔ 服务端投影的纯映射（无 React / 无运行时依赖，供适配器与检查脚本共用）。
 *
 * 守门：客户端只存正文 + 必要原操作标记；不存执行授权、不凭事件内容分配身份。
 */
import type { ThreadAssistantMessagePart, ThreadMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { YayaStoredFragment } from "@/lib/yaya/storage-types";
import { receiptProvesSuccess, type YayaOperationQueryOutcome, type YayaSourceRef } from "@/lib/yaya/types";

import { yayaAttachmentContentUrl, yayaAttachmentIdFromUrl } from "./api";
import { YAYA_PART_NAMES } from "./parts";
import type { ProjectedMessage } from "./schemas";
import { parseYayaChatRecoveryMark } from "@/lib/yaya/chat-bind-contract";
import { parsePageQuote, quoteFromReferenceFragment, referenceFragmentText, type YayaPageQuote } from "@/lib/yaya/page-reference";

function fragmentIdFor(messageId: string, index: number): string {
  return `${messageId}:f${index}`;
}

export function requestProvenance(): YayaSourceRef {
  return { kind: "raw_input", ref_id: null, label: null, derived_from: null };
}

export function modelProvenance(): YayaSourceRef {
  return { kind: "model_text", ref_id: null, label: null, derived_from: null };
}

export function toolProvenance(): YayaSourceRef {
  return { kind: "tool_result", ref_id: null, label: null, derived_from: null };
}

export interface PersistedShape {
  fragments: YayaStoredFragment[];
  attachmentIds: string[];
  messageKind: "text" | "image" | "tool_result" | "receipt" | "mixed";
  executionState: "none" | "pending_approval" | "executed" | "unknown";
}

function summaryFragment(
  messageId: string,
  index: number,
  text: string,
  provenance: YayaSourceRef
): YayaStoredFragment {
  return {
    fragment_id: fragmentIdFor(messageId, index),
    text,
    sources: [],
    independently_readable: true,
    provenance,
  };
}

export interface MessageWireFacts {
  text: string;
  attachmentIds: string[];
}

/**
 * 运行请求的 user_text：上下文 chips 只随本条消息发送。
 * 冻结协议没有独立上下文字段，有限并入 user_text；业务 raw_text 仍以教师原文
 * 经历史适配器单独保存，不被改写。
 */
export function composeRunUserText(text: string, rawContext: unknown): string {
  if (text === "") return text;
  const context =
    typeof rawContext === "object" && rawContext !== null
      ? (rawContext as { object?: unknown; source?: unknown })
      : undefined;
  const parts: string[] = [];
  if (typeof context?.object === "string" && context.object.trim() !== "") {
    parts.push(`对象=${context.object.trim()}`);
  }
  if (typeof context?.source === "string" && context.source.trim() !== "") {
    parts.push(`来源=${context.source.trim()}`);
  }
  return parts.length === 0 ? text : `（本条消息上下文：${parts.join("；")}）\n${text}`;
}

export function collectUserFacts(message: ThreadMessage): MessageWireFacts {
  const attachmentIds: string[] = [];
  let text = "";
  for (const part of message.content) {
    if (part.type === "text") {
      text = text === "" ? part.text : `${text}\n${part.text}`;
      continue;
    }
    if (part.type !== "image") continue;
    const id = yayaAttachmentIdFromUrl(part.image);
    if (id !== null && !attachmentIds.includes(id)) attachmentIds.push(id);
  }
  return { text: text.trim(), attachmentIds };
}

/** 本地消息 → 服务端存储片段；只存正文与必要的原操作标记，不存执行授权。 */
export function persistShape(message: ThreadMessage): PersistedShape | null {
  if (message.role === "system") return null;
  const fragments: YayaStoredFragment[] = [];
  const attachmentIds: string[] = [];
  let executionState: PersistedShape["executionState"] = "none";
  let hasReceipt = false;
  let hasProposal = false;
  let hasImage = false;

  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.trim() !== "") {
        fragments.push(
          summaryFragment(
            message.id,
            fragments.length,
            part.text,
            message.role === "user" ? requestProvenance() : modelProvenance()
          )
        );
      }
      continue;
    }
    if (part.type === "image") {
      hasImage = true;
      const attachmentId = yayaAttachmentIdFromUrl(part.image);
      if (attachmentId !== null && !attachmentIds.includes(attachmentId)) attachmentIds.push(attachmentId);
      continue;
    }
    if (part.type !== "data") continue;
    if (part.name === YAYA_PART_NAMES.proposal) {
      const data = part.data as { proposal_id?: unknown };
      const proposalId = typeof data.proposal_id === "string" ? data.proposal_id : "未知";
      fragments.push(
        summaryFragment(
          message.id,
          fragments.length,
          "待核对提案（原提案 " + proposalId + "）；历史只读，需重新读取后再执行。",
          toolProvenance()
        )
      );
      hasProposal = true;
      if (executionState !== "executed") executionState = "pending_approval";
      continue;
    }
    if (part.name === YAYA_PART_NAMES.receipt) {
      const data = part.data as { operation_id?: unknown; outcome?: unknown };
      const outcome = data.outcome as YayaOperationQueryOutcome | undefined;
      const kind = typeof outcome?.kind === "string" ? outcome.kind : "unknown";
      const succeeded =
        (outcome?.kind === "saved" || outcome?.kind === "saved_detail_unavailable") &&
        receiptProvesSuccess(outcome.receipt);
      fragments.push(
        summaryFragment(
          message.id,
          fragments.length,
          `操作回执（原操作 ${String(data.operation_id ?? "未知")}）：${
            succeeded ? "已保存" : "结果需按原操作核对"
          }`,
          toolProvenance()
        )
      );
      hasReceipt = true;
      if (succeeded) executionState = "executed";
      else if (executionState === "none") executionState = "unknown";
      continue;
    }
    if (part.name === YAYA_PART_NAMES.clarify) {
      const data = part.data as { question?: unknown };
      if (typeof data.question === "string" && data.question.trim() !== "") {
        fragments.push(summaryFragment(message.id, fragments.length, data.question, modelProvenance()));
      }
      continue;
    }
    if (part.name === YAYA_PART_NAMES.stopped) {
      const data = part.data as { detail?: unknown };
      fragments.push(
        summaryFragment(
          message.id,
          fragments.length,
          typeof data.detail === "string" && data.detail !== ""
            ? `（已停止：${data.detail}）`
            : "（本次整理已停止）",
          toolProvenance()
        )
      );
      if (executionState === "pending_approval") executionState = "unknown";
      continue;
    }
    if (part.name === YAYA_PART_NAMES.runError) {
      const data = part.data as {
        message?: unknown;
        client_request_id?: unknown;
        conversation_id?: unknown;
      };
      fragments.push(
        summaryFragment(
          message.id,
          fragments.length,
          `（未完成：${typeof data.message === "string" ? data.message : "请重新读取核对"}）`,
          toolProvenance()
        )
      );
      if (typeof data.client_request_id === "string" && data.client_request_id !== "") {
        fragments.push(
          summaryFragment(
            message.id,
            fragments.length,
            "原运行标记：" + data.client_request_id + "；历史只读，重新读取不会自动重发。",
            toolProvenance()
          )
        );
      }
      continue;
    }
  }

  const quote = message.role === "user" ? parsePageQuote(message.metadata.custom?.quote) : null;
  if (quote !== null) {
    fragments.push({
      fragment_id: message.id + ":page-focus",
      text: referenceFragmentText(quote),
      sources: quote.yayaPage.sources,
      independently_readable: quote.yayaPage.sources.length === 0,
      provenance: { kind: "tool_result", ref_id: "page:" + quote.yayaPage.path, label: quote.yayaPage.title, derived_from: null },
    });
  }
  if (hasProposal && executionState === "none") executionState = "pending_approval";
  if (fragments.length === 0 && attachmentIds.length === 0 && executionState === "none") return null;
  const messageKind: PersistedShape["messageKind"] = hasReceipt
    ? "receipt"
    : hasProposal
      ? "tool_result"
      : hasImage && fragments.length > 0
        ? "mixed"
        : hasImage
          ? "image"
          : "text";
  return { fragments, attachmentIds, messageKind, executionState };
}

/** 服务端投影消息 → 运行时消息（只读；受限内容不冒充可用）。 */
export function projectedToThreadMessageLike(view: ProjectedMessage): ThreadMessageLike | null {
  if (view.role !== "user" && view.role !== "assistant") return null;
  const parts: ThreadAssistantMessagePart[] = [];
  let pageQuote: YayaPageQuote | null = null;
  for (const fragment of view.fragments) {
    if (view.role === "user" && fragment.fragment_id.endsWith(":page-focus")) {
      const parsedQuote = fragment.visibility === "full" ? quoteFromReferenceFragment(fragment.text) : null;
      if (parsedQuote?.yayaPage.owner_account_id === view.owner_account_id) pageQuote = parsedQuote;
      continue; // Never print reference JSON as the teacher's original observation.
    }
    if (fragment.visibility === "full" && fragment.text !== null && fragment.text !== "") {
      parts.push({ type: "text", id: fragment.fragment_id, text: fragment.text, status: { type: "complete" } });
    }
  }
  if (view.role === "user") {
    for (const attachment of view.projection.attachments) {
      if (attachment.readable) {
        parts.push({
          type: "image",
          id: attachment.attachment_id,
          image: yayaAttachmentContentUrl(attachment.attachment_id, "thumbnail"),
        });
      } else if (attachment.metadata_only) {
        parts.push({
          type: "text",
          id: `meta-${attachment.attachment_id}`,
          text: "（一张图片仅保留元数据）",
          status: { type: "complete" },
        });
      } else {
        parts.push({
          type: "text",
          id: `restricted-${attachment.attachment_id}`,
          text: "（一张图片当前不可读）",
          status: { type: "complete" },
        });
      }
    }
  } else if (view.execution_state === "pending_approval" || view.execution_state === "unknown") {
    parts.push({
      type: "data",
      id: `history-${view.message_id}`,
      name: YAYA_PART_NAMES.historyState,
      data: {
        execution_state: view.execution_state,
        text:
          view.execution_state === "pending_approval"
            ? "这条消息曾包含待核对操作；历史只读，请重新核对后再执行。"
            : "这条消息包含结果未知的操作；只按原操作读取核对，不会自动重发。",
      },
    });
  }
  if (view.projection.visibility === "partial" || view.projection.visibility === "metadata_only") {
    parts.push({
      type: "data",
      id: `note-${view.message_id}`,
      name: YAYA_PART_NAMES.historyNote,
      data: { text: "部分内容按当前权限受限展示。" },
    });
  } else if (view.projection.visibility === "hidden" || view.projection.visibility === "unavailable") {
    parts.push({
      type: "data",
      id: `note-${view.message_id}`,
      name: YAYA_PART_NAMES.historyNote,
      data: { text: "这条历史消息当前不可读。" },
    });
  }
  const recovery = parseYayaChatRecoveryMark(view.recovery);
  if (view.role === "assistant" && recovery.ok) {
    parts.push({ type: "data", id: "recovery-" + view.message_id, name: YAYA_PART_NAMES.recovery, data: recovery.value });
  }
  return {
    role: view.role,
    id: view.message_id,
    createdAt: new Date(view.created_at),
    ...(view.role === "assistant" ? { status: { type: "complete" as const, reason: "stop" as const } } : {}),
    content: parts,
    ...(pageQuote === null ? {} : { metadata: { custom: { quote: pageQuote } } }),
  };
}
