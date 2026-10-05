/**
 * 会话仓库（账号私有）。
 *
 * - 所有读写都以 owner_account_id 过滤；非本人（含管理员）一律 not_found，不泄漏存在性；
 * - 删除为软删除：保留业务记录/操作核验/仍有效引用；只解除本会话消息的附件引用；
 * - 改名有版本前提；GET 路径不续期、不写库、不调用模型。
 */
import type { TransactionClient } from "@/storage/database/pg-client";
import { YayaDataError } from "../storage-types";
import type {
  YayaConversationSummaryView,
  YayaConversationView,
  YayaCreateConversationInput,
  YayaDeleteConversationInput,
  YayaDeleteConversationResult,
  YayaRenameConversationInput,
} from "../storage-types";
import type { Principal } from "../../accounts/types";
import { projectConversationSummary } from "./projection";
import { toConversationView, type YayaConversationRow } from "./rows";

const CONVERSATION_COLUMNS =
  "id, account_id, title, title_source_fragments, revision, created_at, updated_at, deleted_at";

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

export async function createConversation(
  client: TransactionClient,
  input: YayaCreateConversationInput,
): Promise<YayaConversationView> {
  const result = await client.query<YayaConversationRow>(
    `INSERT INTO yaya_conversations (account_id, title) VALUES ($1, $2)
     RETURNING ${CONVERSATION_COLUMNS}`,
    [input.owner_account_id, input.title],
  );
  const row = result.rows[0];
  if (!row) throw new YayaDataError("server_error", "创建会话失败。");
  return toConversationView(row);
}

export async function listConversations(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
): Promise<readonly YayaConversationSummaryView[]> {
  const result = await client.query<YayaConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM yaya_conversations
      WHERE account_id = $1 AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC`,
    [principal.account_id],
  );
  const summaries: YayaConversationSummaryView[] = [];
  for (const row of result.rows) {
    summaries.push(await projectConversationSummary(client, principal, schoolId, row));
  }
  return summaries;
}

export async function getConversation(
  client: TransactionClient,
  ownerAccountId: string,
  conversationId: string,
): Promise<YayaConversationView | null> {
  const result = await client.query<YayaConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM yaya_conversations
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [conversationId, ownerAccountId],
  );
  const row = result.rows[0];
  return row ? toConversationView(row) : null;
}

/** 详情读取同样按当前来源投影标题；非本人返回 null（不泄漏存在性） */
export async function getConversationSummary(
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  conversationId: string,
): Promise<YayaConversationSummaryView | null> {
  const result = await client.query<YayaConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM yaya_conversations
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [conversationId, principal.account_id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return projectConversationSummary(client, principal, schoolId, row);
}

export async function renameConversation(
  client: TransactionClient,
  input: YayaRenameConversationInput,
): Promise<YayaConversationView> {
  const row = await lockOwnedConversation(client, input.owner_account_id, input.conversation_id);
  if (row.revision !== input.expected_revision) {
    throw new YayaDataError("revision_conflict", "会话已在其他位置更新，请刷新后重试。");
  }
  const sourceFragments = [...(input.title_source_fragments ?? [])];
  if (sourceFragments.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new YayaDataError("invalid_request", "标题来源片段不合法。");
  }
  const updated = await client.query<YayaConversationRow>(
    `UPDATE yaya_conversations
        SET title = $3, title_source_fragments = $4::jsonb,
            revision = revision + 1, updated_at = now()
      WHERE id = $1 AND account_id = $2
      RETURNING ${CONVERSATION_COLUMNS}`,
    [input.conversation_id, input.owner_account_id, input.title, JSON.stringify(sourceFragments)],
  );
  const next = updated.rows[0];
  if (!next) throw new YayaDataError("not_found", "会话不存在。");
  return toConversationView(next);
}

/**
 * 删除会话：软删除会话与其消息，解除本会话消息的附件引用；
 * 观察/提案引用与其他会话消息引用保留；不物理删除任何附件对象。
 */
export async function deleteConversation(
  client: TransactionClient,
  input: YayaDeleteConversationInput,
): Promise<YayaDeleteConversationResult> {
  const row = await lockOwnedConversation(client, input.owner_account_id, input.conversation_id);
  if (row.revision !== input.expected_revision) {
    throw new YayaDataError("revision_conflict", "会话已在其他位置更新，请刷新后重试。");
  }
  const detached = await client.query<{ attachment_id: string }>(
    `SELECT DISTINCT r.attachment_id FROM yaya_attachment_refs r
      JOIN yaya_messages m ON m.id = r.record_id
      WHERE r.record_kind = 'message' AND m.conversation_id = $1`,
    [input.conversation_id],
  );
  const detachedIds = detached.rows.map((entry) => entry.attachment_id);
  const deleted = await client.query<YayaConversationRow>(
    `UPDATE yaya_conversations
        SET deleted_at = now(), revision = revision + 1, updated_at = now()
      WHERE id = $1 AND account_id = $2
      RETURNING ${CONVERSATION_COLUMNS}`,
    [input.conversation_id, input.owner_account_id],
  );
  const next = deleted.rows[0];
  if (!next) throw new YayaDataError("not_found", "会话不存在。");
  await client.query(
    "UPDATE yaya_messages SET deleted_at = now() WHERE conversation_id = $1 AND deleted_at IS NULL",
    [input.conversation_id],
  );
  await client.query(
    `DELETE FROM yaya_attachment_refs r
      USING yaya_messages m
      WHERE r.record_kind = 'message' AND r.record_id = m.id AND m.conversation_id = $1
        AND m.deleted_at IS NOT NULL`,
    [input.conversation_id],
  );
  let unreferenced: string[] = [];
  if (detachedIds.length > 0) {
    const remaining = await client.query<{ id: string }>(
      `SELECT a.id FROM yaya_attachments a
        WHERE a.id = ANY($1::varchar[])
          AND NOT EXISTS (SELECT 1 FROM yaya_attachment_refs r WHERE r.attachment_id = a.id)`,
      [detachedIds],
    );
    unreferenced = remaining.rows.map((entry) => entry.id);
  }
  return {
    conversation: toConversationView(next),
    detached_attachment_ids: detachedIds,
    unreferenced_attachment_ids: unreferenced,
  };
}
