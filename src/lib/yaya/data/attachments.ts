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
  type YayaMediaAttachmentAuditEntry,
  type YayaMediaAttachmentRecord,
  type YayaMediaDeletionLeaseResult,
  type YayaMediaObservationReferencesResult,
  type YayaMediaReferenceFacts,
  type YayaObservationAttachmentView,
} from "../storage-types";
import type { ObservationStatus } from "../../types";
import {
  attachmentLeaseTransition,
  mapMediaAttachmentStatus,
  mediaAttachmentLeaseTransition,
  sortAttachmentLockIds,
} from "./invariants";
import { iso, isoRequired } from "./rows";

const ATTACHMENT_COLUMNS =
  "id, uploader_account_id, conversation_id, object_key, thumbnail_key, model_key, media_type, byte_size, checksum_sha256, thumbnail_checksum, model_checksum, width, height, source_kind, derived_from, metadata, status, revision, delete_result, deletion_lease_id, deleting_started_at, deleted_at, client_upload_id, created_at, updated_at";

interface AttachmentRow {
  id: string;
  uploader_account_id: string;
  conversation_id: string | null;
  object_key: string;
  thumbnail_key: string | null;
  model_key: string | null;
  media_type: string;
  byte_size: number | string;
  checksum_sha256: string;
  thumbnail_checksum: string | null;
  model_checksum: string | null;
  width: number | null;
  height: number | null;
  source_kind: string;
  derived_from: string | null;
  metadata: unknown;
  status: YayaAttachmentStatus;
  revision: number;
  delete_result: "deleted" | "unknown" | null;
  deletion_lease_id: string | null;
  deleting_started_at: Date | string | null;
  deleted_at: Date | string | null;
  client_upload_id: string | null;
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
    checksum_sha256: row.checksum_sha256,
    source_kind: row.source_kind as YayaAttachmentView["source_kind"],
    derived_from: row.derived_from,
    metadata:
      row.metadata !== null && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : null,
    status: row.status,
    revision: row.revision,
    delete_result: row.delete_result,
    deletion_lease_id: row.deletion_lease_id,
    thumbnail_key: row.thumbnail_key,
    model_key: row.model_key,
    thumbnail_checksum: row.thumbnail_checksum,
    model_checksum: row.model_checksum,
    width: row.width,
    height: row.height,
    client_upload_id: row.client_upload_id,
    deleting_started_at: iso(row.deleting_started_at),
    deleted_at: iso(row.deleted_at),
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

/**
 * 附件引用写入的唯一协调锁原语：
 * - 去重并按 attachment_id 稳定排序后 `FOR UPDATE`（多附件统一锁序，防死锁）；
 * - 锁后核当前事实：存在、uploader=actor、status=ready；
 * - 调用方必须在同一事务内紧接着写引用/审计，不得在锁外先查后写。
 */
export async function lockAttachmentsForReference(
  client: TransactionClient,
  actorAccountId: string,
  attachmentIds: readonly string[],
): Promise<AttachmentRow[]> {
  const ids = sortAttachmentLockIds(attachmentIds);
  if (ids.length === 0) return [];
  const rows = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments
      WHERE id = ANY($1::varchar[]) ORDER BY id FOR UPDATE`,
    [ids],
  );
  if (rows.rows.length !== ids.length) {
    const found = new Set(rows.rows.map((row) => row.id));
    throw new YayaDataError("attachment_missing", "引用的附件不存在。", {
      attachment_ids: ids.filter((id) => !found.has(id)),
    });
  }
  for (const row of rows.rows) {
    if (row.uploader_account_id !== actorAccountId) {
      throw new YayaDataError("attachment_conflict", "附件不属于当前账号。", {
        attachment_id: row.id,
      });
    }
    if (row.status !== "ready") {
      throw new YayaDataError("attachment_conflict", "附件当前状态不可新增引用。", {
        attachment_id: row.id,
        status: row.status,
        delete_result: row.delete_result,
      });
    }
  }
  return rows.rows;
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
    typeof input.checksum_sha256 !== "string" ||
    input.checksum_sha256.trim() === ""
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
          checksum_sha256, source_kind, derived_from, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING ${ATTACHMENT_COLUMNS}`,
      [
        attachmentId,
        input.uploader_account_id,
        input.conversation_id,
        input.object_key,
        input.media_type,
        input.byte_size,
        input.checksum_sha256,
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
            deleted_at = CASE WHEN $2::varchar = 'deleted' THEN now() ELSE deleted_at END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${ATTACHMENT_COLUMNS}`,
    [input.attachment_id, next.status, next.revision, next.delete_result],
  );
  const updatedRow = updated.rows[0];
  if (!updatedRow) throw new YayaDataError("server_error", "附件状态写入失败。");
  return toAttachmentView(updatedRow);
}

/** 建立附件引用：与所有引用写入共享附件行锁，锁后核 ready+owner */
export async function linkAttachmentRef(
  client: TransactionClient,
  input: YayaLinkAttachmentInput,
): Promise<YayaAttachmentRefView> {
  await lockAttachmentsForReference(client, input.linked_by_account_id, [input.attachment_id]);
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
  // 统一锁序：先附件（稳定排序），再观察附件 meta；锁后核 ready+owner。
  await lockAttachmentsForReference(client, input.appended_by_account_id, ids);
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

/* --------------------------- 媒体附件存储接口（DATA1-R1） --------------------------- */

/** 媒体端口记录只暴露三派生对象齐备的行；缺列一律按存储损坏拒绝。 */
function toMediaRecord(row: AttachmentRow): YayaMediaAttachmentRecord {
  if (
    row.thumbnail_key === null ||
    row.model_key === null ||
    row.thumbnail_checksum === null ||
    row.model_checksum === null ||
    row.width === null ||
    row.height === null
  ) {
    throw new YayaDataError("server_error", "附件缺少派生对象元数据，不能按媒体端口暴露。");
  }
  return {
    attachment_id: row.id,
    owner_account_id: row.uploader_account_id,
    status: mapMediaAttachmentStatus(row.status, row.delete_result),
    object_key: row.object_key,
    thumbnail_key: row.thumbnail_key,
    model_key: row.model_key,
    content_type: row.media_type,
    byte_size: Number(row.byte_size),
    checksum_sha256: row.checksum_sha256,
    thumbnail_checksum: row.thumbnail_checksum,
    model_checksum: row.model_checksum,
    width: row.width,
    height: row.height,
    client_upload_id: row.client_upload_id,
    created_at: isoRequired(row.created_at),
    deletion_lease_id: row.deletion_lease_id,
  };
}

export async function findAttachmentByClientUploadId(
  client: TransactionClient,
  ownerAccountId: string,
  clientUploadId: string,
): Promise<YayaMediaAttachmentRecord | null> {
  if (typeof clientUploadId !== "string" || clientUploadId.trim() === "") {
    throw new YayaDataError("invalid_request", "client_upload_id 不合法。");
  }
  const result = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments
      WHERE uploader_account_id = $1 AND client_upload_id = $2`,
    [ownerAccountId, clientUploadId],
  );
  const row = result.rows[0];
  return row ? toMediaRecord(row) : null;
}

export async function insertPendingAttachment(
  client: TransactionClient,
  input: YayaMediaAttachmentRecord,
): Promise<YayaMediaAttachmentRecord> {
  if (
    typeof input.attachment_id !== "string" ||
    input.attachment_id.trim() === "" ||
    typeof input.owner_account_id !== "string" ||
    input.status !== "pending" ||
    typeof input.object_key !== "string" ||
    input.object_key.trim() === "" ||
    typeof input.thumbnail_key !== "string" ||
    typeof input.model_key !== "string" ||
    typeof input.content_type !== "string" ||
    !Number.isFinite(input.byte_size) ||
    input.byte_size < 0 ||
    input.checksum_sha256.trim() === "" ||
    input.thumbnail_checksum.trim() === "" ||
    input.model_checksum.trim() === "" ||
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width < 0 ||
    input.height < 0
  ) {
    throw new YayaDataError("invalid_request", "待登记附件记录不合法。");
  }
  try {
    const result = await client.query<AttachmentRow>(
      `INSERT INTO yaya_attachments
         (id, uploader_account_id, object_key, thumbnail_key, model_key, media_type, byte_size,
          checksum_sha256, thumbnail_checksum, model_checksum, width, height, client_upload_id,
          source_kind, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'raw_input', 'pending')
       RETURNING ${ATTACHMENT_COLUMNS}`,
      [
        input.attachment_id,
        input.owner_account_id,
        input.object_key,
        input.thumbnail_key,
        input.model_key,
        input.content_type,
        input.byte_size,
        input.checksum_sha256,
        input.thumbnail_checksum,
        input.model_checksum,
        input.width,
        input.height,
        input.client_upload_id,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new YayaDataError("server_error", "登记待上传附件失败。");
    return toMediaRecord(row);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "23505"
    ) {
      throw new YayaDataError("attachment_conflict", "附件标识或上传标识已存在，拒绝覆盖。");
    }
    throw error;
  }
}

export async function markAttachmentReady(
  client: TransactionClient,
  attachmentId: string,
): Promise<YayaMediaAttachmentRecord> {
  const result = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments WHERE id = $1 FOR UPDATE`,
    [attachmentId],
  );
  const row = result.rows[0];
  if (!row) throw new YayaDataError("attachment_missing", "附件不存在。");
  if (row.status !== "pending") {
    throw new YayaDataError("attachment_conflict", "附件状态不允许标记为可用。");
  }
  const updated = await client.query<AttachmentRow>(
    `UPDATE yaya_attachments
        SET status = 'ready', revision = revision + 1, updated_at = now()
      WHERE id = $1
      RETURNING ${ATTACHMENT_COLUMNS}`,
    [attachmentId],
  );
  const next = updated.rows[0];
  if (!next) throw new YayaDataError("server_error", "标记附件可用失败。");
  return toMediaRecord(next);
}

export async function removePendingAttachment(
  client: TransactionClient,
  attachmentId: string,
): Promise<boolean> {
  const result = await client.query(
    "DELETE FROM yaya_attachments WHERE id = $1 AND status = 'pending' RETURNING id",
    [attachmentId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getMediaAttachment(
  client: TransactionClient,
  attachmentId: string,
): Promise<YayaMediaAttachmentRecord | null> {
  const result = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments WHERE id = $1`,
    [attachmentId],
  );
  const row = result.rows[0];
  return row ? toMediaRecord(row) : null;
}

export async function addObservationAttachmentRefs(
  client: TransactionClient,
  input: { observation_id: string; attachment_ids: readonly string[]; actor_account_id: string },
): Promise<YayaMediaObservationReferencesResult> {
  const ids = sortAttachmentLockIds(input.attachment_ids);
  if (ids.length === 0 || ids.length !== input.attachment_ids.length) {
    throw new YayaDataError("invalid_request", "附件集合不合法。");
  }
  await lockAttachmentsForReference(client, input.actor_account_id, ids);
  const observation = await client.query("SELECT id FROM observations WHERE id = $1", [
    input.observation_id,
  ]);
  if (!observation.rowCount) throw new YayaDataError("not_found", "观察记录不存在。");
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
  const existing = await client.query<{ attachment_id: string }>(
    `SELECT attachment_id FROM yaya_attachment_refs
      WHERE record_kind = 'observation' AND record_id = $1 AND attachment_id = ANY($2::varchar[])`,
    [input.observation_id, ids],
  );
  const existingIds = new Set(existing.rows.map((row) => row.attachment_id));
  const addedIds = ids.filter((id) => !existingIds.has(id));
  for (const attachmentId of addedIds) {
    await client.query(
      `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
       VALUES ($1, 'observation', $2, $3)`,
      [attachmentId, input.observation_id, input.actor_account_id],
    );
  }
  const revision = current + addedIds.length;
  if (addedIds.length > 0) {
    await client.query(
      `UPDATE yaya_observation_attachment_meta
          SET attachment_revision = $2, updated_at = now()
        WHERE observation_id = $1`,
      [input.observation_id, revision],
    );
  }
  return { added: addedIds.length, attachment_revision: revision };
}

export async function getObservationAttachmentRevisionNumber(
  client: TransactionClient,
  observationId: string,
): Promise<number> {
  const result = await client.query<{ attachment_revision: number }>(
    "SELECT attachment_revision FROM yaya_observation_attachment_meta WHERE observation_id = $1",
    [observationId],
  );
  return result.rows[0]?.attachment_revision ?? 0;
}

/** 三种引用完整返回；悬空/损坏按 reference_incomplete 抛错（禁止当空集回收） */
export async function getMediaAttachmentReferenceFacts(
  client: TransactionClient,
  attachmentId: string,
): Promise<YayaMediaReferenceFacts> {
  const facts = await queryAttachmentLifecycle(client, attachmentId);
  if (!facts.reference_query_complete) {
    throw new YayaDataError("reference_incomplete", "附件引用查询不完整，禁止回收。", {
      attachment_id: attachmentId,
    });
  }
  return {
    attachment_id: attachmentId,
    observation_refs: facts.observation_refs,
    message_refs: facts.message_refs,
    proposal_refs: facts.proposal_refs,
  };
}

/** 只解除指定 owner 会话中指定消息的附件引用；其他会话/提案/观察引用保留 */
export async function releaseConversationAttachmentRefs(
  client: TransactionClient,
  input: { conversation_id: string; message_ids: readonly string[]; owner_account_id: string },
): Promise<number> {
  const conversation = await client.query<{ account_id: string }>(
    "SELECT account_id FROM yaya_conversations WHERE id = $1",
    [input.conversation_id],
  );
  const owner = conversation.rows[0]?.account_id;
  if (owner === undefined) throw new YayaDataError("not_found", "会话不存在。");
  if (owner !== input.owner_account_id) {
    throw new YayaDataError("owner_mismatch", "只能解除自己会话中的附件引用。");
  }
  const messageIds = [...new Set(input.message_ids)];
  if (messageIds.length === 0) return 0;
  const result = await client.query(
    `DELETE FROM yaya_attachment_refs r
      USING yaya_messages m
      WHERE r.record_kind = 'message' AND r.record_id = m.id
        AND m.conversation_id = $1 AND m.owner_account_id = $2
        AND m.id = ANY($3::varchar[])`,
    [input.conversation_id, input.owner_account_id, messageIds],
  );
  return result.rowCount ?? 0;
}

/** 媒体端口租约：ready / deletion_unknown 可取得；租约令牌写入同一行 */
export async function acquireAttachmentDeletionLease(
  client: TransactionClient,
  attachmentId: string,
): Promise<YayaMediaDeletionLeaseResult> {
  const result = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments WHERE id = $1 FOR UPDATE`,
    [attachmentId],
  );
  const row = result.rows[0];
  if (!row) return { outcome: "not_found" };
  const leaseToken = randomUUID();
  const transition = mediaAttachmentLeaseTransition(
    { status: row.status, delete_result: row.delete_result, deletion_lease_id: row.deletion_lease_id },
    { action: "begin", lease_token: leaseToken },
  );
  if (!transition.ok) {
    if (transition.reason === "already_deleting") return { outcome: "already_deleting" };
    if (transition.reason === "already_deleted") return { outcome: "already_deleted" };
    return { outcome: "not_ready" };
  }
  await client.query(
    `UPDATE yaya_attachments
        SET status = 'deleting', delete_result = NULL, deletion_lease_id = $2,
            deleting_started_at = now(), revision = revision + 1, updated_at = now()
      WHERE id = $1`,
    [attachmentId, leaseToken],
  );
  return { outcome: "acquired", lease_token: leaseToken };
}

/** 完成租约：令牌必须匹配；unknown 保留 deletion_unknown，failed 才回 ready */
export async function completeAttachmentDeletionByLease(
  client: TransactionClient,
  input: { attachment_id: string; lease_token: string; outcome: "deleted" | "unknown" | "failed" },
): Promise<YayaMediaAttachmentRecord> {
  const result = await client.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM yaya_attachments WHERE id = $1 FOR UPDATE`,
    [input.attachment_id],
  );
  const row = result.rows[0];
  if (!row) throw new YayaDataError("attachment_missing", "附件不存在。");
  const transition = mediaAttachmentLeaseTransition(
    { status: row.status, delete_result: row.delete_result, deletion_lease_id: row.deletion_lease_id },
    { action: "complete", lease_token: input.lease_token, outcome: input.outcome },
  );
  if (!transition.ok) {
    throw new YayaDataError("revision_conflict", "回收租约不匹配，拒绝落状态。", {
      attachment_id: input.attachment_id,
    });
  }
  const next = transition.next;
  const updated = await client.query<AttachmentRow>(
    `UPDATE yaya_attachments
        SET status = $2, delete_result = $3, deletion_lease_id = NULL,
            deleted_at = CASE WHEN $2::varchar = 'deleted' THEN now() ELSE deleted_at END,
            revision = revision + 1, updated_at = now()
      WHERE id = $1
      RETURNING ${ATTACHMENT_COLUMNS}`,
    [input.attachment_id, next.status, next.delete_result],
  );
  const updatedRow = updated.rows[0];
  if (!updatedRow) throw new YayaDataError("server_error", "附件状态写入失败。");
  return toMediaRecord(updatedRow);
}

/** 独立聚合审计：只记录追加事实与身份，不改 raw_text/confirmed_content */
export async function appendMediaAttachmentAudit(
  client: TransactionClient,
  entry: YayaMediaAttachmentAuditEntry,
): Promise<void> {
  if (
    entry.action !== "attach_observation_images" &&
    entry.action !== "create_observation_attachments"
  ) {
    throw new YayaDataError("invalid_request", "审计动作不合法。");
  }
  if (
    !Array.isArray(entry.attachment_ids) ||
    entry.attachment_ids.length === 0 ||
    entry.attachment_ids.some((id) => typeof id !== "string" || id.trim() === "")
  ) {
    throw new YayaDataError("invalid_request", "审计附件集合不合法。");
  }
  const observation = await client.query("SELECT id FROM observations WHERE id = $1", [
    entry.observation_id,
  ]);
  if (!observation.rowCount) throw new YayaDataError("not_found", "观察记录不存在。");
  const auditId = entry.audit_id?.trim() ? entry.audit_id : randomUUID();
  await client.query(
    `INSERT INTO yaya_attachment_appends
       (id, audit_id, action, observation_id, attachment_ids, appended_by_account_id,
        source_confirmed_at, request_id, appended_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [
      auditId,
      auditId,
      entry.action,
      entry.observation_id,
      JSON.stringify(entry.attachment_ids),
      entry.actor_account_id,
      entry.source_confirmed_at,
      entry.request_id,
      entry.recorded_at,
    ],
  );
}
