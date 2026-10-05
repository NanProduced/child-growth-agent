/**
 * 附件元数据、引用与删除租约（DATA1）。
 *
 * - 元数据/消息/提案/观察引用 DDL 与仓库统一在此；MEDIA1 通过本接口接入；
 * - `deleting` 租约先查无引用再锁定（CAS revision），租约生效后禁止新引用；
 * - 外部删除结果未知时保持 `deleting + delete_result=unknown`，绝不恢复 ready、
 *   也绝不伪装 deleted；
 * - 归档后资料追加有独立审计（yaya_attachment_appends）与观察级 revision CAS；
 * - DATA1 不物理删除对象：解除引用后由 MEDIA1 按租约回收。
 */
import { randomUUID } from "node:crypto";
import type { TransactionClient } from "@/storage/database/pg-client";
import {
  YayaDataError,
  type YayaAttachmentAppendInput,
  type YayaAttachmentAppendResult,
  type YayaAttachmentLeaseInput,
  type YayaAttachmentLifecycleFacts,
  type YayaAttachmentMetadataInput,
  type YayaAttachmentRefView,
  type YayaAttachmentStatus,
  type YayaAttachmentView,
  type YayaLinkAttachmentInput,
  type YayaObservationAttachmentView,
} from "../storage-types";
import type { ObservationStatus } from "../../types";
import { assertAttachmentsReadyForOwner } from "./attachment-guards";
import { attachmentLeaseTransition } from "./invariants";
import { iso, isoRequired } from "./rows";

const ATTACHMENT_COLUMNS =
  "id, uploader_account_id, conversation_id, object_key, media_type, byte_size, checksum, source_kind, derived_from, metadata, status, revision, delete_result, deleting_started_at, deleted_at, created_at, updated_at";

interface AttachmentRow {
  id: string;
  uploader_account_id: string;
  conversation_id: string | null;
  object_key: string;
  media_type: string;
  byte_size: number | string;
  checksum: string;
  source_kind: string;
  derived_from: string | null;
  metadata: unknown;
  status: YayaAttachmentStatus;
  revision: number;
  delete_result: "deleted" | "unknown" | null;
  deleting_started_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toAttachmentView(row: AttachmentRow): YayaAttachmentView {
  return {
    attachment_id: row.id,
    uploader_account_id: row.uploader_account_id,
    conversation_id: row.conversation_id,
    object_key: row.object_key,
    media_type: row.media_type,
    byte_size: Number(row.byte_size),
    checksum: row.checksum,
    source_kind: row.source_kind as YayaAttachmentView["source_kind"],
    derived_from: row.derived_from,
    metadata:
      row.metadata !== null && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : null,
    status: row.status,
    revision: row.revision,
    delete_result: row.delete_result,
    deleting_started_at: iso(row.deleting_started_at),
    deleted_at: iso(row.deleted_at),
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

export async function registerAttachment(
  client: TransactionClient,
  input: YayaAttachmentMetadataInput,
): Promise<YayaAttachmentView> {
  if (
    typeof input.object_key !== "string" ||
    input.object_key.trim() === "" ||
    typeof input.media_type !== "string" ||
    input.media_type.trim() === "" ||
    !Number.isFinite(input.byte_size) ||
    input.byte_size < 0 ||
    typeof input.checksum !== "string" ||
    input.checksum.trim() === ""
  ) {
    throw new YayaDataError("invalid_request", "附件元数据不合法。");
  }
  if (input.conversation_id !== null) {
    const conversation = await client.query(
      "SELECT id FROM yaya_conversations WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL",
      [input.conversation_id, input.uploader_account_id],
    );
    if (!conversation.rowCount) throw new YayaDataError("not_found", "会话不存在。");
  }
  const attachmentId = input.attachment_id ?? randomUUID();
  try {
    const result = await client.query<AttachmentRow>(
      `INSERT INTO yaya_attachments
         (id, uploader_account_id, conversation_id, object_key, media_type, byte_size,
          checksum, source_kind, derived_from, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING ${ATTACHMENT_COLUMNS}`,
      [
        attachmentId,
        input.uploader_account_id,
        input.conversation_id,
        input.object_key,
        input.media_type,
        input.byte_size,
        input.checksum,
        input.source_kind,
        input.derived_from,
        input.metadata === undefined || input.metadata === null
          ? null
          : JSON.stringify(input.metadata),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new YayaDataError("server_error", "登记附件失败。");
    return toAttachmentView(row);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
    ) {
      throw new YayaDataError("attachment_conflict", "附件已登记或对象键重复。");
    }
    throw error;
  }
}

export async function getAttachment(
  client: TransactionClient,
  attachmentId: string,
): Promise<YayaAttachmentView | null> {
  const result = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments WHERE id = $1`,
    [attachmentId],
  );
  const row = result.rows[0];
  return row ? toAttachmentView(row) : null;
}

/**
 * 完整引用查询：消息/提案/观察三类引用统一从 yaya_attachment_refs 读取。
 * 悬空引用（指向不存在的记录）视为查询不完整，调用方必须按“未知引用”保留。
 */
export async function queryAttachmentLifecycle(
  client: TransactionClient,
  attachmentId: string,
): Promise<YayaAttachmentLifecycleFacts> {
  const rows = await client.query<{
    record_kind: string;
    record_id: string;
    message_conversation_id: string | null;
    observation_status: string | null;
    proposal_id: string | null;
  }>(
    `SELECT r.record_kind, r.record_id,
            m.conversation_id AS message_conversation_id,
            o.status AS observation_status,
            p.id AS proposal_id
       FROM yaya_attachment_refs r
       LEFT JOIN yaya_messages m ON r.record_kind = 'message' AND m.id = r.record_id
       LEFT JOIN observations o ON r.record_kind = 'observation' AND o.id = r.record_id
       LEFT JOIN yaya_proposals p ON r.record_kind = 'proposal' AND p.id = r.record_id
      WHERE r.attachment_id = $1`,
    [attachmentId],
  );
  let complete = true;
  const observations: { observation_id: string; status: ObservationStatus }[] = [];
  const messages: { conversation_id: string; message_id: string }[] = [];
  const proposals: string[] = [];
  for (const row of rows.rows) {
    if (row.record_kind === "message") {
      if (row.message_conversation_id === null) {
        complete = false;
        continue;
      }
      messages.push({ conversation_id: row.message_conversation_id, message_id: row.record_id });
    } else if (row.record_kind === "observation") {
      if (row.observation_status === null) {
        complete = false;
        continue;
      }
      observations.push({
        observation_id: row.record_id,
        status: row.observation_status as ObservationStatus,
      });
    } else if (row.record_kind === "proposal") {
      if (row.proposal_id === null) {
        complete = false;
        continue;
      }
      proposals.push(row.record_id);
    } else {
      complete = false;
    }
  }
  return {
    image_id: attachmentId,
    reference_query_complete: complete,
    observation_refs: observations,
    message_refs: messages,
    proposal_refs: proposals,
  };
}

/** 删除租约：无有效引用且 CAS 通过才进入 deleting；不物理删除对象 */
export async function beginAttachmentDeletion(
  client: TransactionClient,
  input: YayaAttachmentLeaseInput,
): Promise<YayaAttachmentView> {
  const result = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments WHERE id = $1 FOR UPDATE`,
    [input.attachment_id],
  );
  const row = result.rows[0];
  if (!row) throw new YayaDataError("attachment_missing", "附件不存在。");
  const refs = await client.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM yaya_attachment_refs WHERE attachment_id = $1",
    [input.attachment_id],
  );
  if (Number(refs.rows[0]?.count ?? 0) > 0) {
    throw new YayaDataError("attachment_referenced", "附件仍被引用，不能进入删除租约。");
  }
  const transition = attachmentLeaseTransition(
    { status: row.status, revision: row.revision, delete_result: row.delete_result },
    { action: "begin", expected_revision: input.expected_revision },
  );
  if (!transition.ok) {
    throw transition.reason === "revision_conflict"
      ? new YayaDataError("revision_conflict", "附件版本已变化，请刷新后重试。")
      : new YayaDataError("attachment_conflict", "附件当前状态不能进入删除租约。");
  }
  const updated = await client.query<AttachmentRow>(
    `UPDATE yaya_attachments
        SET status = 'deleting', revision = $2, deleting_started_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING ${ATTACHMENT_COLUMNS}`,
    [input.attachment_id, transition.next.revision],
  );
  const next = updated.rows[0];
  if (!next) throw new YayaDataError("server_error", "删除租约写入失败。");
  return toAttachmentView(next);
}

export async function commitAttachmentDeletion(
  client: TransactionClient,
  input: Omit<YayaAttachmentLeaseInput, "actor_account_id">,
): Promise<YayaAttachmentView> {
  return transitionAttachment(client, input, "commit_delete");
}

/**
 * 外部删除结果未知：保持 deleting + delete_result=unknown；
 * 不恢复 ready、不伪装 deleted，等待可核验的重试。
 */
export async function failAttachmentDeletion(
  client: TransactionClient,
  input: Omit<YayaAttachmentLeaseInput, "actor_account_id">,
): Promise<YayaAttachmentView> {
  return transitionAttachment(client, input, "fail_delete");
}

async function transitionAttachment(
  client: TransactionClient,
  input: { attachment_id: string; expected_revision: number },
  action: "commit_delete" | "fail_delete",
): Promise<YayaAttachmentView> {
  const result = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments WHERE id = $1 FOR UPDATE`,
    [input.attachment_id],
  );
  const row = result.rows[0];
  if (!row) throw new YayaDataError("attachment_missing", "附件不存在。");
  const transition = attachmentLeaseTransition(
    { status: row.status, revision: row.revision, delete_result: row.delete_result },
    { action, expected_revision: input.expected_revision },
  );
  if (!transition.ok) {
    throw transition.reason === "revision_conflict"
      ? new YayaDataError("revision_conflict", "附件版本已变化，请刷新后重试。")
      : new YayaDataError("attachment_conflict", "附件当前状态不允许该操作。");
  }
  const next = transition.next;
  const updated = await client.query<AttachmentRow>(
    `UPDATE yaya_attachments
        SET status = $2, revision = $3, delete_result = $4,
            deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE deleted_at END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${ATTACHMENT_COLUMNS}`,
    [input.attachment_id, next.status, next.revision, next.delete_result],
  );
  const updatedRow = updated.rows[0];
  if (!updatedRow) throw new YayaDataError("server_error", "附件状态写入失败。");
  return toAttachmentView(updatedRow);
}

/** 建立附件引用：deleting/deleted 状态拒绝新引用 */
export async function linkAttachmentRef(
  client: TransactionClient,
  input: YayaLinkAttachmentInput,
): Promise<YayaAttachmentRefView> {
  const attachment = await client.query<{ status: YayaAttachmentStatus }>(
    "SELECT status FROM yaya_attachments WHERE id = $1 FOR UPDATE",
    [input.attachment_id],
  );
  const row = attachment.rows[0];
  if (!row) throw new YayaDataError("attachment_missing", "附件不存在。");
  if (row.status !== "ready") {
    throw new YayaDataError("attachment_conflict", "附件正在删除或已删除，不能建立新引用。");
  }
  const inserted = await client.query<{
    id: string;
    attachment_id: string;
    record_kind: string;
    record_id: string;
    linked_at: Date | string;
    linked_by_account_id: string | null;
  }>(
    `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (attachment_id, record_kind, record_id) DO NOTHING
     RETURNING id, attachment_id, record_kind, record_id, linked_at, linked_by_account_id`,
    [input.attachment_id, input.record_kind, input.record_id, input.linked_by_account_id],
  );
  const created = inserted.rows[0];
  if (created) return toRefView(created);
  const existing = await client.query<{
    id: string;
    attachment_id: string;
    record_kind: string;
    record_id: string;
    linked_at: Date | string;
    linked_by_account_id: string | null;
  }>(
    `SELECT id, attachment_id, record_kind, record_id, linked_at, linked_by_account_id
       FROM yaya_attachment_refs
      WHERE attachment_id = $1 AND record_kind = $2 AND record_id = $3`,
    [input.attachment_id, input.record_kind, input.record_id],
  );
  const found = existing.rows[0];
  if (!found) throw new YayaDataError("server_error", "附件引用写入失败。");
  return toRefView(found);
}

function toRefView(row: {
  id: string;
  attachment_id: string;
  record_kind: string;
  record_id: string;
  linked_at: Date | string;
  linked_by_account_id: string | null;
}): YayaAttachmentRefView {
  return {
    ref_id: row.id,
    attachment_id: row.attachment_id,
    record_kind: row.record_kind as YayaAttachmentRefView["record_kind"],
    record_id: row.record_id,
    linked_at: isoRequired(row.linked_at),
    linked_by_account_id: row.linked_by_account_id,
  };
}

export async function listAttachmentRefs(
  client: TransactionClient,
  record: { record_kind: YayaAttachmentRefView["record_kind"]; record_id: string },
): Promise<readonly YayaAttachmentRefView[]> {
  const result = await client.query<{
    id: string;
    attachment_id: string;
    record_kind: string;
    record_id: string;
    linked_at: Date | string;
    linked_by_account_id: string | null;
  }>(
    `SELECT id, attachment_id, record_kind, record_id, linked_at, linked_by_account_id
       FROM yaya_attachment_refs WHERE record_kind = $1 AND record_id = $2
      ORDER BY linked_at, id`,
    [record.record_kind, record.record_id],
  );
  return result.rows.map(toRefView);
}

/**
 * 归档后资料追加：观察级 revision CAS + 独立追加审计；不改 raw_text/confirmed_content。
 * 授权（当前教师写权限、人工批准）由调用方在业务边界完成；本函数只做存储原子性。
 */
export async function appendObservationAttachments(
  client: TransactionClient,
  input: YayaAttachmentAppendInput,
): Promise<YayaAttachmentAppendResult> {
  const ids = [...input.attachment_ids];
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new YayaDataError("invalid_request", "追加附件集合不合法。");
  }
  if (!Number.isInteger(input.expected_attachment_revision) || input.expected_attachment_revision < 0) {
    throw new YayaDataError("invalid_request", "附件修订前提不合法。");
  }
  const observation = await client.query("SELECT id FROM observations WHERE id = $1", [
    input.observation_id,
  ]);
  if (!observation.rowCount) throw new YayaDataError("not_found", "观察记录不存在。");
  await assertAttachmentsReadyForOwner(client, input.appended_by_account_id, ids);
  await client.query(
    `INSERT INTO yaya_observation_attachment_meta (observation_id, attachment_revision)
     VALUES ($1, 0) ON CONFLICT (observation_id) DO NOTHING`,
    [input.observation_id],
  );
  const meta = await client.query<{ attachment_revision: number }>(
    "SELECT attachment_revision FROM yaya_observation_attachment_meta WHERE observation_id = $1 FOR UPDATE",
    [input.observation_id],
  );
  const current = meta.rows[0]?.attachment_revision;
  if (current === undefined) throw new YayaDataError("server_error", "附件修订状态缺失。");
  if (current !== input.expected_attachment_revision) {
    throw new YayaDataError("revision_conflict", "观察附件修订已变化，请刷新后重试。");
  }
  const already = await client.query<{ attachment_id: string }>(
    `SELECT attachment_id FROM yaya_attachment_refs
      WHERE record_kind = 'observation' AND record_id = $1 AND attachment_id = ANY($2::varchar[])`,
    [input.observation_id, ids],
  );
  if (already.rows.length > 0) {
    throw new YayaDataError("attachment_referenced", "附件已关联到该观察。", {
      attachment_ids: already.rows.map((entry) => entry.attachment_id),
    });
  }
  const nextRevision = current + 1;
  for (const attachmentId of ids) {
    await client.query(
      `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
       VALUES ($1, 'observation', $2, $3)`,
      [attachmentId, input.observation_id, input.appended_by_account_id],
    );
    await client.query(
      `INSERT INTO yaya_attachment_appends
         (attachment_id, observation_id, attachment_revision, appended_by_account_id, approval_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        attachmentId,
        input.observation_id,
        nextRevision,
        input.appended_by_account_id,
        input.approval_id,
        input.note,
      ],
    );
  }
  const updated = await client.query<{ updated_at: Date | string }>(
    `UPDATE yaya_observation_attachment_meta
        SET attachment_revision = $2, updated_at = now()
      WHERE observation_id = $1
      RETURNING updated_at`,
    [input.observation_id, nextRevision],
  );
  return {
    observation_id: input.observation_id,
    attachment_revision: nextRevision,
    appended_attachment_ids: ids,
    appended_at: isoRequired(updated.rows[0]?.updated_at ?? new Date()),
  };
}

export async function getObservationAttachmentRevision(
  client: TransactionClient,
  observationId: string,
): Promise<YayaObservationAttachmentView> {
  const result = await client.query<{ attachment_revision: number; updated_at: Date | string }>(
    "SELECT attachment_revision, updated_at FROM yaya_observation_attachment_meta WHERE observation_id = $1",
    [observationId],
  );
  const row = result.rows[0];
  return {
    observation_id: observationId,
    attachment_revision: row?.attachment_revision ?? 0,
    updated_at: row ? isoRequired(row.updated_at) : null,
  };
}
