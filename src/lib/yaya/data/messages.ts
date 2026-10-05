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
import { assertAttachmentsReadyForOwner } from "./attachment-guards";
import {
  checkConversationRevision,
  resolveClientMessageReplay,
} from "./invariants";
import { projectMessageRow } from "./projection";
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
  type YayaListMessagesOptions,
  type YayaSaveMessageInput,
  type YayaSaveMessageResult,
} from "../storage-types";

const CONVERSATION_COLUMNS =
  "id, account_id, title, title_source_fragments, revision, created_at, updated_at, deleted_at";
const MESSAGE_COLUMNS =
  "id, conversation_id, owner_account_id, client_message_id, client_digest, role, message_kind, fragments, attachment_ids, execution_state, revision, created_at, updated_at, deleted_at";

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

export async function saveMessage(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  input: YayaSaveMessageInput,
): Promise<YayaSaveMessageResult> {
  const ownerAccountId = principal.account_id;
  const conversation = await lockOwnedConversation(client, ownerAccountId, input.conversation_id);
  if (
    !Number.isInteger(input.expected_conversation_revision) ||
    input.expected_conversation_revision < 1
  ) {
    throw new YayaDataError("invalid_request", "版本前提不合法。");
  }
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
      return { message, conversation: toConversationView(conversation), replayed: true };
    }
  }

  if (checkConversationRevision(conversation.revision, input.expected_conversation_revision) !== "ok") {
    throw new YayaDataError("revision_conflict", "会话已在其他位置更新，请刷新后重试。");
  }
  await assertAttachmentsReadyForOwner(client, ownerAccountId, attachmentIds);

  const inserted = await client.query<YayaMessageRow>(
    `INSERT INTO yaya_messages
       (conversation_id, owner_account_id, client_message_id, client_digest, role, message_kind,
        fragments, attachment_ids, execution_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
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
  return { message, conversation: toConversationView(conversationRow), replayed: false };
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
  return { conversation: toConversationView(row), messages: projected };
}
