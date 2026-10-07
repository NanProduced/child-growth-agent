"use client";

/**
 * UI1 运行时适配器：useLocalRuntime / useRemoteThreadListRuntime 的自有实现。
 *
 * 守门要点（TECH0 + api-contract-v1）：
 * - 模型适配器只消费 yaya-run-events-v1 NDJSON，逐行协议校验通过后才展示；
 * - 历史加载永不返回 unstable_resume，加载即只读，不自动执行任何旧操作；
 * - 本地 approved 状态不构成执行授权；批准/执行是独立卡片动作（actions.ts）；
 * - 会话事实源在服务端：RemoteThreadListAdapter 以 conversation_id 为 remoteId；
 * - 附件每张图片独立上传，client_upload_id 稳定可重试，不新建身份绕过未知结果。
 */
import {
  fromThreadMessageLike,
  useAui,
  type AssistantClient,
  type AttachmentAdapter,
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ChatModelRunResult,
  type CompleteAttachment,
  type ExportedMessageRepository,
  type PendingAttachment,
  type RemoteThreadListAdapter,
  type RuntimeAdapters,
  type ThreadAssistantMessagePart,
  type ThreadHistoryAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";

/** 会话元数据形状由适配器签名派生（@assistant-ui/react 未直接导出该类型）。 */
type RemoteThreadMetadata = Awaited<ReturnType<RemoteThreadListAdapter["fetch"]>>;
import { useMemo } from "react";

import { YAYA_MAX_RUN_ATTACHMENTS, type YayaRunWireEvent } from "@/lib/yaya/api-contract";
import { receiptProvesSuccess, type YayaOperationQueryOutcome } from "@/lib/yaya/types";
import { fetchWithAccountAuth } from "@/lib/accounts/client";

import {
  yayaApiErrorToPart,
  yayaAttachmentContentUrl,
  yayaGetJson,
  yayaHttpError,
  yayaUploadImage,
  yayaWriteJson,
  YayaApiError,
  YAYA_CONVERSATIONS_PATH,
} from "./api";
import { requestYayaRunCancel } from "./actions";
import { collectUserFacts, composeRunUserText, persistShape, projectedToThreadMessageLike } from "./mapping";
import { YAYA_PART_NAMES, type YayaRunErrorPartData } from "./parts";
import {
  conversationListResponseSchema,
  conversationMessagesResponseSchema,
  conversationResponseSchema,
  saveMessageResponseSchema,
  type ProjectedMessage,
} from "./schemas";
import type { YayaClientStore } from "./store";
import { readYayaRunStream } from "./wire";

/* ------------------------------- 工具 ------------------------------- */

function silentUnsupported(message: string): Error {
  const error = new Error(message);
  (error as unknown as Record<symbol, boolean>)[Symbol.for("assistant-ui.silent-runtime-action")] = true;
  return error;
}

function conversationPath(remoteId: string, suffix = ""): string {
  return `${YAYA_CONVERSATIONS_PATH}/${encodeURIComponent(remoteId)}${suffix}`;
}

export function currentRemoteId(aui: AssistantClient): string | null {
  const item = aui.threadListItem;
  const state = item?.getState?.();
  const remoteId = state?.remoteId;
  return typeof remoteId === "string" && remoteId !== "" ? remoteId : null;
}

/**
 * 新会话首次发送时，运行/保存在服务端会话建立之前触发；等待 initialize
 * 拿回 remoteId（已建立时返回缓存身份）。不允许在身份未定时假装成功。
 */
async function ensureRemoteId(aui: AssistantClient): Promise<string | null> {
  const direct = currentRemoteId(aui);
  if (direct !== null) return direct;
  try {
    const result = await aui.threadListItem.initialize();
    return typeof result.remoteId === "string" && result.remoteId !== "" ? result.remoteId : null;
  } catch {
    return null;
  }
}

const STOP_DETAIL_FALLBACK = "这次整理没有完成；输入还在，可重新读取核对后再试。";

function failureDataParts(data: YayaRunErrorPartData): ThreadAssistantMessagePart[] {
  return [
    {
      type: "data",
      id: `err-${data.stage}-${data.status ?? "none"}`,
      name: YAYA_PART_NAMES.runError,
      data,
    },
  ];
}

function eventParts(event: YayaRunWireEvent): ThreadAssistantMessagePart[] {
  switch (event.type) {
    case "answer": {
      const parts: ThreadAssistantMessagePart[] = [
        { type: "text", id: "answer", text: event.content, status: { type: "complete" } },
      ];
      if (event.sources.length > 0) {
        parts.push({
          type: "data",
          id: "sources",
          name: YAYA_PART_NAMES.sources,
          data: { sources: event.sources },
        });
      }
      return parts;
    }
    case "clarify":
      return [
        { type: "data", id: "clarify", name: YAYA_PART_NAMES.clarify, data: { question: event.question } },
      ];
    case "proposal_prepared":
      return [
        {
          type: "data",
          id: `proposal-${event.proposal.proposal_id}`,
          name: YAYA_PART_NAMES.proposal,
          data: { proposal_id: event.proposal.proposal_id, proposal_origin: event.proposal.proposal_origin },
        },
      ];
    case "receipt":
      return [
        {
          type: "data",
          id: `receipt-${event.operation_id}`,
          name: YAYA_PART_NAMES.receipt,
          data: { operation_id: event.operation_id, outcome: event.outcome, expected_plan: null },
        },
      ];
    case "stopped":
      return [
        {
          type: "data",
          id: `stopped-${event.reason}`,
          name: YAYA_PART_NAMES.stopped,
          data: { reason: event.reason, detail: event.detail ?? STOP_DETAIL_FALLBACK },
        },
      ];
    case "tool_result":
      return [
        {
          type: "data",
          id: `tool-${event.tool}`,
          name: YAYA_PART_NAMES.toolResult,
          data: { tool: event.tool, outcome: event.outcome, source_kind: event.source_kind },
        },
      ];
    case "public_search_refused":
      return [
        {
          type: "data",
          id: `search-${event.tool}`,
          name: YAYA_PART_NAMES.searchRefused,
          data: { tool: event.tool, reason: event.reason },
        },
      ];
    default:
      return [];
  }
}

/* --------------------------- 模型适配器 --------------------------- */

export function createYayaChatModelAdapter(store: YayaClientStore, aui: AssistantClient): ChatModelAdapter {
  return {
    async run(options: ChatModelRunOptions): Promise<ChatModelRunResult> {
      const remoteId = await ensureRemoteId(aui);
      if (remoteId === null) {
        return {
          content: failureDataParts({
            stage: "not_wired",
            status: null,
            code: "no_conversation",
            message: "会话尚未建立，请重试。",
            detail: null,
          }),
          status: { type: "incomplete", reason: "error" },
        };
      }
      const wiring = store.threadWiring(remoteId);
      const lastUser = [...options.messages].reverse().find((message) => message.role === "user");
      if (lastUser === undefined) {
        return {
          content: failureDataParts({
            stage: "not_wired",
            status: null,
            code: "no_user_message",
            message: "没有可整理的用户消息。",
            detail: null,
          }),
          status: { type: "incomplete", reason: "error" },
        };
      }
      const facts = collectUserFacts(lastUser);
      if (facts.text === "" && facts.attachmentIds.length === 0) {
        return {
          content: failureDataParts({
            stage: "not_wired",
            status: null,
            code: "empty_message",
            message: "文字与图片至少提供其一。",
            detail: null,
          }),
          status: { type: "incomplete", reason: "error" },
        };
      }
      if (facts.attachmentIds.length > YAYA_MAX_RUN_ATTACHMENTS) {
        return {
          content: failureDataParts({
            stage: "not_wired",
            status: null,
            code: "attachment_limit",
            message: `一次最多引用 ${YAYA_MAX_RUN_ATTACHMENTS} 张图片；未发送本次运行。`,
            detail: null,
            conversation_id: remoteId,
          }),
          status: { type: "incomplete", reason: "error" },
        };
      }

      // 上下文 chips 只随本条消息发送；冻结协议没有独立上下文字段，
      // 有限并入 user_text（不写入业务 raw_text，历史保存仍是教师原文）。
      const userText = composeRunUserText(facts.text, options.runConfig.custom?.yaya_context);

      try {
        await wiring.waitForWrites();
        if (wiring.persistedMessageId(lastUser.id) === null) {
          const history = await yayaGetJson(conversationPath(remoteId, "/messages?limit=200"), conversationMessagesResponseSchema);
          const saved = history.messages.find(message => message.role === "user" && message.message_id === lastUser.id);
          if (!saved) throw new YayaApiError(0, "message_unverified", "用户消息尚未核实保存，请重新读取后再发送。");
          wiring.bindPersistedMessage(lastUser.id, saved.message_id);
        }
        if (wiring.revision === null) {
          const { conversation } = await yayaGetJson(conversationPath(remoteId), conversationResponseSchema);
          wiring.setRevision(conversation.revision);
        }
      } catch (error) {
        const apiError =
          error instanceof YayaApiError ? error : new YayaApiError(0, "network_error", "无法读取会话版本，请重试。");
        return {
          content: failureDataParts(yayaApiErrorToPart(apiError)),
          status: { type: "incomplete", reason: "error" },
        };
      }

      const clientRequestId = wiring.clientRequestId(lastUser.id);
      const runIdentity = { client_request_id: clientRequestId, conversation_id: remoteId };
      let response: Response;
      try {
        response = await fetchWithAccountAuth(conversationPath(remoteId, "/runs"), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/x-ndjson" },
          body: JSON.stringify({
            conversation_id: remoteId,
            client_request_id: clientRequestId,
            user_text: userText,
            attachment_ids: facts.attachmentIds,
            expected_conversation_revision: wiring.revision ?? 1,
          }),
          signal: options.abortSignal,
        });
      } catch (error) {
        if (options.abortSignal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          await requestYayaRunCancel(remoteId, clientRequestId, null).catch(() => false);
          throw error;
        }
        return {
          content: failureDataParts({
            stage: "network",
            status: null,
            code: "network_error",
            message: "网络连接异常，请重试。",
            detail: null,
            ...runIdentity,
          }),
          status: { type: "incomplete", reason: "error" },
        };
      }

      if (!response.ok) {
        const apiError = await yayaHttpError(response);
        if (apiError.status === 401 || apiError.status === 403 || apiError.status === 503) {
          window.dispatchEvent(new Event("cga:auth-changed"));
        }
        return {
          content: failureDataParts({ ...yayaApiErrorToPart(apiError), ...runIdentity }),
          status: { type: "incomplete", reason: "error" },
        };
      }

      const streamed: ThreadAssistantMessagePart[] = [];
      let serverRunId: string | null = null;
      const result = await readYayaRunStream(response, options.abortSignal, (event) => {
        serverRunId = event.run_id;
        for (const part of eventParts(event)) streamed.push(part);
      });
      if (!result.ok) {
        if (result.kind === "aborted") {
          await requestYayaRunCancel(remoteId, clientRequestId, serverRunId).catch(() => false);
          throw new DOMException("Aborted", "AbortError");
        }
        if (result.kind === "http") {
          return {
            content: failureDataParts({
              stage: "http",
              status: result.status,
              code: result.code,
              message: result.message,
              detail: null,
              ...runIdentity,
            }),
            status: { type: "incomplete", reason: "error" },
          };
        }
        return {
          content: [
            ...streamed,
            {
              type: "data",
              id: "wire-error",
              name: YAYA_PART_NAMES.runError,
              data: {
                stage: "malformed",
                status: null,
                code: null,
                message: "事件流未通过协议校验，未显示成功。",
                detail: result.detail,
                ...runIdentity,
              } satisfies YayaRunErrorPartData,
            },
          ],
          status: { type: "incomplete", reason: "error" },
        };
      }
      if (streamed.length === 0 && result.outcome.kind === "answered") {
        streamed.push({ type: "text", id: "answer", text: result.outcome.content, status: { type: "complete" } });
      }
      wiring.invalidateRevision(); // 服务器终态消息已推进会话版本，下一次写入重新读取。
      return { content: streamed, status: { type: "complete", reason: "stop" } };
    },
  };
}

/* --------------------------- 历史适配器 --------------------------- */

/* 消息 ↔ 投影的纯映射见 mapping.ts（供检查脚本复用）。 */

export function createYayaThreadHistoryAdapter(store: YayaClientStore, aui: AssistantClient): ThreadHistoryAdapter {
  const save = async (message: ThreadMessage): Promise<void> => {
    // 助手/工具消息由 run 终态同事务保存，客户端没有该写入通道。
    if (message.role !== "user") return;
    const remoteId = await ensureRemoteId(aui);
    if (remoteId === null) return;
    const shape = persistShape(message);
    if (shape === null) return;
    const wiring = store.threadWiring(remoteId);
    const ensureRevision = async (): Promise<number> => {
      if (wiring.revision === null) {
        const { conversation } = await yayaGetJson(conversationPath(remoteId), conversationResponseSchema);
        wiring.setRevision(conversation.revision);
      }
      return wiring.revision ?? 1;
    };
    const attempt = async (): Promise<void> => {
      const expectedRevision = await ensureRevision();
      const result = await yayaWriteJson(
        conversationPath(remoteId, "/messages"),
        "POST",
        {
          conversation_id: remoteId,
          client_message_id: message.id,
          role: message.role,
          message_kind: shape.messageKind,
          execution_state: shape.executionState,
          fragments: shape.fragments,
          attachment_ids: shape.attachmentIds,
          expected_conversation_revision: expectedRevision,
        },
        saveMessageResponseSchema
      );
      wiring.setRevision(result.conversation.revision);
      wiring.bindPersistedMessage(message.id, result.message.message_id);
    };
    try {
      await attempt();
    } catch (error) {
      if (error instanceof YayaApiError && error.status === 409) {
        wiring.invalidateRevision();
        await attempt();
        return;
      }
      throw error;
    }
  };

  return {
    async load(): Promise<ExportedMessageRepository> {
      const remoteId = await ensureRemoteId(aui);
      if (remoteId === null) return { messages: [] };
      const response = await yayaGetJson(
        conversationPath(remoteId, "/messages?limit=200"),
        conversationMessagesResponseSchema
      );
      store.threadWiring(remoteId).setRevision(response.conversation.revision);
      const items: ExportedMessageRepository["messages"] = [];
      let parentId: string | null = null;
      for (const view of response.messages) {
        if (view.role === "user") store.threadWiring(remoteId).bindPersistedMessage(view.message_id, view.message_id);
        const like = projectedToThreadMessageLike(view);
        if (like === null || like.id === undefined) continue;
        items.push({
          parentId,
          message: fromThreadMessageLike(like, like.id, { type: "complete", reason: "stop" }),
        });
        parentId = like.id;
      }
      return { headId: parentId, messages: items };
    },
    async append(item): Promise<void> {
      const remoteId = await ensureRemoteId(aui);
      if (remoteId === null) return;
      const promise = save(item.message);
      store.threadWiring(remoteId).trackWrite(promise);
      await promise;
    },
  };
}

/* --------------------------- 附件适配器 --------------------------- */

export function createYayaAttachmentAdapter(): AttachmentAdapter {
  const uploaded = new Map<string, string>();
  const retryIds = new Map<string, string>();

  const fileKey = (file: File): string =>
    [file.name, file.size, file.lastModified, file.type].join("\u0000");

  const newId = (): string =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `upload-${Date.now().toString(36)}`;

  return {
    accept: "image/jpeg,image/png,image/webp",
    async *add({ file }): AsyncGenerator<PendingAttachment, void> {
      const key = fileKey(file);
      const id = retryIds.get(key) ?? newId();
      retryIds.delete(key);
      const base = { id, type: "image" as const, name: file.name, contentType: file.type, file };
      if (file.size > 10 * 1024 * 1024) {
        retryIds.set(key, id);
        yield {
          ...base,
          status: { type: "incomplete", reason: "error", message: "单张图片不能超过 10MiB，请压缩后再上传。" },
        };
        return;
      }
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        retryIds.set(key, id);
        yield {
          ...base,
          status: { type: "incomplete", reason: "error", message: "只支持 JPEG / PNG / WebP 图片。" },
        };
        return;
      }

      // 上传进度用队列回传：onProgress 推入队列，生成器逐条 yield 给输入区。
      const progressQueue: number[] = [];
      let wake: (() => void) | null = null;
      const push = (value: number) => {
        progressQueue.push(value);
        wake?.();
        wake = null;
      };
      let settled: { ok: true; attachmentId: string } | { ok: false; message: string } | null = null;
      void yayaUploadImage(file, {
        clientUploadId: id,
        onProgress: ({ loaded, total }) => {
          if (total > 0) push(Math.max(0, Math.min(1, loaded / total)));
        },
      })
        .then((result) => {
          settled = result.ok
            ? { ok: true, attachmentId: result.attachment.attachment_id }
            : { ok: false, message: result.message };
        })
        .catch((error: unknown) => {
          settled = {
            ok: false,
            message: error instanceof YayaApiError ? error.message : "上传暂未完成，请重试。",
          };
        })
        .finally(() => {
          wake?.();
          wake = null;
        });

      yield { ...base, status: { type: "running", reason: "uploading", progress: 0 } };
      while (settled === null) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        while (progressQueue.length > 0) {
          const progress = progressQueue.shift() ?? 0;
          yield { ...base, status: { type: "running", reason: "uploading", progress } };
        }
      }
      // settled 收窄：TS 控制流在闭包赋值后仍视作可空，运行时此处必已赋值。
      const outcome = settled as { ok: true; attachmentId: string } | { ok: false; message: string };
      if (outcome.ok) {
        uploaded.set(id, outcome.attachmentId);
        yield { ...base, status: { type: "requires-action", reason: "composer-send" } };
        return;
      }
      uploaded.delete(id);
      retryIds.set(key, id);
      yield { ...base, status: { type: "incomplete", reason: "error", message: outcome.message } };
    },
    async remove(attachment) {
      uploaded.delete(attachment.id);
      if (attachment.file !== undefined) {
        const key = fileKey(attachment.file);
        if (retryIds.get(key) === attachment.id) retryIds.delete(key);
      }
    },
    async send(attachment): Promise<CompleteAttachment> {
      let attachmentId = uploaded.get(attachment.id);
      if (attachmentId === undefined) {
        const result = await yayaUploadImage(attachment.file, { clientUploadId: attachment.id });
        if (!result.ok) {
          throw new YayaApiError(400, result.code, result.message);
        }
        attachmentId = result.attachment.attachment_id;
        uploaded.set(attachment.id, attachmentId);
      }
      return {
        id: attachment.id,
        type: "image",
        name: attachment.name,
        contentType: attachment.contentType,
        file: attachment.file,
        status: { type: "complete" },
        content: [
          {
            type: "image",
            id: attachmentId,
            image: yayaAttachmentContentUrl(attachmentId, "thumbnail"),
            filename: attachment.name,
          },
        ],
      };
    },
  };
}

/* --------------------------- 会话列表适配器 --------------------------- */

function toRemoteThreadMetadata(conversation: {
  conversation_id: string;
  projected_title: string;
  revision: number;
  updated_at: string;
}): RemoteThreadMetadata {
  return {
    status: "regular",
    remoteId: conversation.conversation_id,
    title: conversation.projected_title,
    lastMessageAt: new Date(conversation.updated_at),
    custom: { revision: conversation.revision },
  };
}

export function createYayaThreadListAdapter(store: YayaClientStore): RemoteThreadListAdapter {
  const seed = (conversation: { conversation_id: string; revision: number }) => {
    store.threadWiring(conversation.conversation_id).setRevision(conversation.revision);
  };
  const getConversation = async (remoteId: string) => {
    const { conversation } = await yayaGetJson(conversationPath(remoteId), conversationResponseSchema);
    seed(conversation);
    return conversation;
  };
  return {
    async list() {
      const { conversations } = await yayaGetJson(YAYA_CONVERSATIONS_PATH, conversationListResponseSchema);
      for (const conversation of conversations) seed(conversation);
      return {
        threads: conversations
          .filter((entry) => entry.deleted_at === null)
          .map(toRemoteThreadMetadata),
      };
    },
    async initialize() {
      const { conversation } = await yayaWriteJson(
        YAYA_CONVERSATIONS_PATH,
        "POST",
        {},
        conversationResponseSchema
      );
      seed(conversation);
      return { remoteId: conversation.conversation_id };
    },
    async rename(remoteId, newTitle) {
      const first = await getConversation(remoteId);
      try {
        await yayaWriteJson(
          conversationPath(remoteId),
          "PATCH",
          { title: newTitle, expected_revision: first.revision },
          conversationResponseSchema
        );
      } catch (error) {
        if (!(error instanceof YayaApiError) || error.status !== 409) throw error;
        const fresh = await getConversation(remoteId);
        await yayaWriteJson(
          conversationPath(remoteId),
          "PATCH",
          { title: newTitle, expected_revision: fresh.revision },
          conversationResponseSchema
        );
      }
    },
    async archive() {
      throw silentUnsupported("会话不支持归档。");
    },
    async unarchive() {
      throw silentUnsupported("会话不支持归档。");
    },
    async delete(remoteId) {
      const first = await getConversation(remoteId);
      try {
        await yayaWriteJson(
          `${conversationPath(remoteId)}?expected_revision=${first.revision}`,
          "DELETE",
          null,
          conversationResponseSchema
        );
      } catch (error) {
        if (!(error instanceof YayaApiError) || error.status !== 409) throw error;
        const fresh = await getConversation(remoteId);
        await yayaWriteJson(
          `${conversationPath(remoteId)}?expected_revision=${fresh.revision}`,
          "DELETE",
          null,
          conversationResponseSchema
        );
      }
    },
    async fetch(remoteId) {
      return toRemoteThreadMetadata(await getConversation(remoteId));
    },
    async generateTitle() {
      // 标题由服务端投影（projected_title）；不调用第二模型、不静默改写标题。
      throw silentUnsupported("会话标题由服务端投影；本地不生成标题。");
    },
    unstable_useAdapters: createYayaRuntimeAdaptersHook(store),
  };
}

export function createYayaRuntimeAdaptersHook(store: YayaClientStore): () => RuntimeAdapters {
  return function useYayaThreadAdapters(): RuntimeAdapters {
    const aui = useAui();
    const history = useMemo(() => createYayaThreadHistoryAdapter(store, aui), [store, aui]);
    const attachments = useMemo(() => createYayaAttachmentAdapter(), []);
    return useMemo(() => ({ history, attachments }), [history, attachments]);
  };
}

export function receiptShowsSuccess(outcome: YayaOperationQueryOutcome): boolean {
  if (outcome.kind === "saved" || outcome.kind === "saved_detail_unavailable") {
    return receiptProvesSuccess(outcome.receipt);
  }
  return false;
}
