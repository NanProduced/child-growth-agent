/**
 * 消息仓库（账号私有）。
 *
 * - client_message_id 幂等：同摘要返回原消息，不同摘要 409；
 * - 版本前提：expected_conversation_revision 与会话当前 revision 一致才追加，
 *   幂等命中不受版本影响（响应丢失后的重试必须成功返回原消息）；
 * - 消息附件必须 ready 且 uploader 就是消息 owner；
 * - 读取按当前来源投影，恢复动作不执行工具；GET 不写库、不续期、不调用模型。
 */
import type { TransactionClient } from "@/storage/database/pg-client";
import type { Principal } from "../../accounts/types";
import {
  authorizeYayaMessageWrite,
  parseYayaChatRecoveryMark,
  type YayaChatRecoveryMark,
  type YayaMessageWriteChannel,
} from "../chat-bind-contract";
import { lockAttachmentsForReference } from "./attachments";
import {
  checkConversationRevision,
  deriveYayaRunClientMessageId,
  resolveClientMessageReplay,
} from "./invariants";
import { projectConversationView, projectMessageRow } from "./projection";
import {
  parseStoredFragments,
  toConversationView,
  type YayaConversationRow,
  type YayaMessageRow,
} from "./rows";
import {
  YayaDataError,
  computeYayaMessageDigest,
  type YayaConversationMessagesView,
  type YayaConversationSummaryView,
  type YayaListMessagesOptions,
  type YayaRunTerminalMessageInput,
  type YayaSaveMessageInput,
  type YayaSaveMessageResult,
} from "../storage-types";

const CONVERSATION_COLUMNS =
  "id, account_id, title, title_source_fragments, revision, created_at, updated_at, deleted_at";
const MESSAGE_COLUMNS =
  "id, conversation_id, owner_account_id, client_message_id, client_digest, role, message_kind, fragments, attachment_ids, execution_state, revision, created_at, updated_at, deleted_at, run_id, binding_state, recovery_mark";

const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 200;

async function lockOwnedConversation(
  client: TransactionClient,
  ownerAccountId: string,
  conversationId: string,
): Promise<YayaConversationRow> {
  const result = await client.query<YayaConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM yaya_conversations
      WHERE id = $1 AND account_id = $2 FOR UPDATE`,
    [conversationId, ownerAccountId],
  );
  const row = result.rows[0];
  if (!row || row.deleted_at !== null) {
    throw new YayaDataError("not_found", "会话不存在。");
  }
  return row;
}

/**
 * 装配恢复标记：conversation/owner 取自锁后事实（服务端填入，不采信调用方），
 * run / actor / proposal / operations 由内部调用方（AGENT-APP1）提供；
 * 形状经契约严格解析（含秘密字段扫描），不合法直接 invalid_request。
 */
function buildRecoveryMark(input: YayaSaveMessageInput, ownerAccountId: string): YayaChatRecoveryMark | null {
  if (input.recovery === undefined || input.recovery === null) return null;
  if (input.run === undefined) {
    throw new YayaDataError("invalid_request", "恢复标记缺少 run 身份。");
  }
  const parsed = parseYayaChatRecoveryMark({
    mark: "yaya-recovery-v1",
    conversation_id: input.conversation_id,
    owner_account_id: ownerAccountId,
    actor_account_id: input.recovery.actor_account_id,
    run: input.run,
    proposal: input.recovery.proposal,
    operations: input.recovery.operations,
  });
  if (!parsed.ok) {
    throw new YayaDataError("invalid_request", "恢复标记形状不合法。");
  }
  return parsed.value;
}

export async function saveMessage(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  input: YayaSaveMessageInput,
  channel: YayaMessageWriteChannel = "http",
): Promise<YayaSaveMessageResult> {
  // 共享写入边界（唯一判定处）：HTTP 只写 user，run 终态只写 assistant/tool
  const verdict = authorizeYayaMessageWrite({ channel, role: input.role });
  if (!verdict.accepted) {
    throw new YayaDataError(
      "invalid_request",
      verdict.reason === "assistant_write_requires_server_channel"
        ? "助手消息只能经内部 run 终态通道写入。"
        : "user 消息不能经 run 终态通道写入。",
    );
  }
  if (
    channel === "http" &&
    (input.run !== undefined || input.binding_state !== undefined || input.recovery !== undefined)
  ) {
    throw new YayaDataError("invalid_request", "HTTP 通道不得携带绑定字段。");
  }
  // 版本前提在共享 repository 边界守门：HTTP 通道必须携带（缺省 / null 拒绝），
  // 不依赖公共 route 兜底；run 终态通道可缺省（跳过 CAS，仍行锁串行）
  if (
    channel === "http" &&
    (input.expected_conversation_revision ?? null) === null
  ) {
    throw new YayaDataError("invalid_request", "HTTP 通道必须携带会话版本前提。");
  }
  if (channel === "run_terminal") {
    if (
      input.run === undefined ||
      input.run.run_id.trim() === "" ||
      input.run.client_request_id.trim() === ""
    ) {
      throw new YayaDataError("invalid_request", "run 终态消息缺少 run 身份。");
    }
    if (input.binding_state !== "bound" && input.binding_state !== "unknown") {
      throw new YayaDataError("invalid_request", "run 终态消息绑定状态不合法。");
    }
    if (input.client_message_id === null) {
      throw new YayaDataError("invalid_request", "run 终态消息缺少派生消息身份。");
    }
  }
  const ownerAccountId = principal.account_id;
  const conversation = await lockOwnedConversation(client, ownerAccountId, input.conversation_id);
  if (
    input.expected_conversation_revision !== undefined &&
    input.expected_conversation_revision !== null &&
    (!Number.isInteger(input.expected_conversation_revision) || input.expected_conversation_revision < 1)
  ) {
    throw new YayaDataError("invalid_request", "版本前提不合法。");
  }
  const recoveryMark = buildRecoveryMark(input, ownerAccountId);
  const parsed = parseStoredFragments(input.fragments);
  if (parsed.corrupt) {
    throw new YayaDataError("invalid_request", "消息片段形状不合法。");
  }
  const attachmentIds = [...input.attachment_ids];
  if (attachmentIds.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new YayaDataError("invalid_request", "附件 id 不合法。");
  }
  const contentDigest = computeYayaMessageDigest({
    role: input.role,
    message_kind: input.message_kind,
    fragments: input.fragments,
    attachment_ids: attachmentIds,
    // run 终态：绑定与恢复身份纳入幂等一致性（HTTP 通道已在上方拒绝这些字段）
    ...(input.run === undefined
      ? {}
      : {
          binding: {
            run_id: input.run.run_id,
            client_request_id: input.run.client_request_id,
            binding_state: input.binding_state ?? "unknown",
            execution_state: input.execution_state,
            recovery: recoveryMark,
          },
        }),
  });

  if (input.client_message_id !== null) {
    const existing = await client.query<YayaMessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM yaya_messages
        WHERE conversation_id = $1 AND client_message_id = $2`,
      [input.conversation_id, input.client_message_id],
    );
    const row = existing.rows[0];
    if (row) {
      const replay = resolveClientMessageReplay(
        { content_digest: row.client_digest ?? "" },
        contentDigest,
      );
      if (replay === "idempotency_conflict") {
        throw new YayaDataError(
          "idempotency_conflict",
          "同一 client_message_id 的内容与已保存消息不一致。",
        );
      }
      const message = await projectMessageRow(client, principal, schoolId, row);
      return {
        message,
        conversation: await projectConversationView(client, principal, schoolId, toConversationView(conversation)),
        replayed: true,
      };
    }
  }

  if (
    input.expected_conversation_revision !== undefined &&
    input.expected_conversation_revision !== null &&
    checkConversationRevision(conversation.revision, input.expected_conversation_revision) !== "ok"
  ) {
    throw new YayaDataError("revision_conflict", "会话已在其他位置更新，请刷新后重试。");
  }
  // 与所有引用写入共享附件行锁：锁后核 ready+owner，防止与删除租约交错
  await lockAttachmentsForReference(client, ownerAccountId, attachmentIds);

  const inserted = await client.query<YayaMessageRow>(
    `INSERT INTO yaya_messages
       (conversation_id, owner_account_id, client_message_id, client_digest, role, message_kind,
        fragments, attachment_ids, execution_state, run_id, binding_state, recovery_mark)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      input.conversation_id,
      ownerAccountId,
      input.client_message_id,
      contentDigest,
      input.role,
      input.message_kind,
      JSON.stringify(input.fragments),
      JSON.stringify(attachmentIds),
      input.execution_state,
      input.run?.run_id ?? null,
      input.binding_state ?? null,
      recoveryMark === null ? null : JSON.stringify(recoveryMark),
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new YayaDataError("server_error", "保存消息失败。");
  for (const attachmentId of new Set(attachmentIds)) {
    await client.query(
      `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
       VALUES ($1, 'message', $2, $3)
       ON CONFLICT (attachment_id, record_kind, record_id) DO NOTHING`,
      [attachmentId, row.id, ownerAccountId],
    );
  }
  const updated = await client.query<YayaConversationRow>(
    `UPDATE yaya_conversations
        SET revision = revision + 1, updated_at = now()
      WHERE id = $1 AND account_id = $2
      RETURNING ${CONVERSATION_COLUMNS}`,
    [input.conversation_id, ownerAccountId],
  );
  const message = await projectMessageRow(client, principal, schoolId, row);
  const conversationRow = updated.rows[0] ?? conversation;
  return {
    message,
    conversation: await projectConversationView(client, principal, schoolId, toConversationView(conversationRow)),
    replayed: false,
  };
}

/**
 * 内部 run 终态保存（AGENT-APP1 专用通道）：`client_message_id` 由 run 身份
 * 确定性派生（APP 不自报），绑定状态与恢复标记随消息同事务落库。
 * 不自开事务：与调用方共用同一 TransactionClient，回滚即一起回滚。
 */
export async function saveRunTerminalMessage(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  input: YayaRunTerminalMessageInput,
): Promise<YayaSaveMessageResult> {
  const verdict = authorizeYayaMessageWrite({ channel: "run_terminal", role: input.role });
  if (!verdict.accepted) {
    throw new YayaDataError("invalid_request", "user 消息不能经 run 终态通道写入。");
  }
  if (
    typeof input.run?.run_id !== "string" ||
    typeof input.run.client_request_id !== "string" ||
    input.run.run_id.trim() === "" ||
    input.run.client_request_id.trim() === ""
  ) {
    throw new YayaDataError("invalid_request", "run 终态消息缺少 run 身份。");
  }
  const clientMessageId = deriveYayaRunClientMessageId(input.run.run_id, input.role, input.part);
  return await saveMessage(
    client,
    principal,
    schoolId,
    {
      conversation_id: input.conversation_id,
      client_message_id: clientMessageId,
      role: input.role,
      message_kind: input.message_kind,
      execution_state: input.execution_state,
      fragments: input.fragments,
      attachment_ids: input.attachment_ids,
      expected_conversation_revision: input.expected_conversation_revision ?? undefined,
      run: { run_id: input.run.run_id, client_request_id: input.run.client_request_id },
      binding_state: input.binding_state,
      recovery: input.recovery ?? null,
    },
    "run_terminal",
  );
}

export async function listMessages(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  conversationId: string,
  options: YayaListMessagesOptions = {},
): Promise<YayaConversationMessagesView> {
  const conversation = await client.query<YayaConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM yaya_conversations
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [conversationId, principal.account_id],
  );
  const row = conversation.rows[0];
  if (!row) throw new YayaDataError("not_found", "会话不存在。");
  const requested = options.limit ?? DEFAULT_MESSAGE_LIMIT;
  const limit = Math.min(MAX_MESSAGE_LIMIT, Math.max(1, Math.trunc(requested)));
  const messages = await client.query<YayaMessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM yaya_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [conversationId, limit],
  );
  const ordered = [...messages.rows].reverse();
  const projected = [];
  for (const messageRow of ordered) {
    projected.push(await projectMessageRow(client, principal, schoolId, messageRow));
  }
  const conversationView: YayaConversationSummaryView = await projectConversationView(
    client,
    principal,
    schoolId,
    toConversationView(row),
  );
  return { conversation: conversationView, messages: projected };
}
