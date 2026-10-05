/**
 * 提案与可信批准仓库（DATA1）。
 *
 * - prepare 预分配 proposal_id / batch_id / 逐项 operation_id，并写 planned 操作行；
 * - 批准必须来自本模块的 `recordApproval`：actor/session/资源事实/内容 digest/
 *   附件关联/业务版本全部服务端生成；请求体只提供 action 与 operation_id 集合；
 * - 批准快照一经写入不随当前值更新；同一提案的新批准取代旧 pending 批准；
 * - 批准不执行业务：执行入口 `executeApprovedOperations` 在 operations.ts。
 */
import { randomUUID } from "node:crypto";
import type { TransactionClient } from "@/storage/database/pg-client";
import type { AccessDecision, AccessAction, AccessResourceKind } from "../../accounts/types";
import {
  authorizeAction,
  isLegalAccessCombination,
} from "../../accounts/authorize";
import { resourceTargetId, type YayaApprovalItemRef, type YayaAttachmentAssociation, type YayaToolAuth } from "../types";
import {
  YAYA_APPROVAL_TTL_SECONDS,
  YAYA_MAX_BATCH_ITEMS,
  YayaDataError,
  computeYayaContentDigest,
  type YayaApprovalView,
  type YayaCancelApprovalInput,
  type YayaItemResourceRef,
  type YayaPreparedItemView,
  type YayaPreparedProposalView,
  type YayaPrepareProposalInput,
  type YayaRecordApprovalInput,
  type YayaRecordApprovalResult,
  type YayaRejectItemsInput,
} from "../storage-types";
import { readAccessResourceFacts } from "./access-facts";
import { assertAttachmentsReadyForOwner } from "./attachment-guards";
import { validatePrepareItems, verifyItemDigest } from "./invariants";
import { isoRequired, parseResourceRef } from "./rows";

const PROPOSAL_COLUMNS =
  "id, batch_id, conversation_id, owner_account_id, proposal_origin, auth, status, prepared_at, closed_at";
const ITEM_COLUMNS =
  "proposal_id, item_key, operation_id, target_id, action, resource, resource_ref, payload, content_digest, attachment_associations, business_revision, status";

interface ProposalRow {
  id: string;
  batch_id: string;
  conversation_id: string;
  owner_account_id: string;
  proposal_origin: "teacher_card" | "model_suggestion";
  auth: unknown;
  status: "open" | "cancelled" | "closed";
  prepared_at: Date | string;
  closed_at: Date | string | null;
}

interface ProposalItemRow {
  proposal_id: string;
  item_key: string;
  operation_id: string;
  target_id: string;
  action: string;
  resource: string;
  resource_ref: unknown;
  payload: unknown;
  content_digest: string;
  attachment_associations: unknown;
  business_revision: string | null;
  status: "pending" | "approved" | "rejected" | "superseded";
}

interface OperationRow {
  operation_id: string;
  proposal_id: string;
  item_key: string;
  batch_id: string;
  target_id: string;
  actor_account_id: string;
  approval_id: string | null;
  status: string | null;
  effect: string | null;
  business_object_id: string | null;
  business_revision: string | null;
  started_at: Date | string | null;
  recorded_at: Date | string | null;
  superseded_by: string | null;
}

function parseToolAuth(value: unknown): YayaToolAuth {
  if (typeof value !== "object" || value === null) {
    throw new YayaDataError("server_error", "提案授权记录损坏。");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "scope_query") return { kind: "scope_query" };
  if (
    record.kind === "action" &&
    typeof record.action === "string" &&
    typeof record.resource === "string"
  ) {
    return {
      kind: "action",
      action: record.action as AccessAction,
      resource: record.resource as AccessResourceKind,
    };
  }
  throw new YayaDataError("server_error", "提案授权记录损坏。");
}

export function parseAssociations(value: unknown): YayaAttachmentAssociation[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new YayaDataError("server_error", "附件关联记录损坏。");
  const associations: YayaAttachmentAssociation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new YayaDataError("server_error", "附件关联记录损坏。");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.attachment_id !== "string" || typeof record.target_id !== "string") {
      throw new YayaDataError("server_error", "附件关联记录损坏。");
    }
    associations.push({ attachment_id: record.attachment_id, target_id: record.target_id });
  }
  return associations;
}

function toPreparedItem(row: ProposalItemRow): YayaPreparedItemView {
  const ref = parseResourceRef(row.resource_ref);
  if (ref === null) throw new YayaDataError("server_error", "提案资源引用损坏。");
  return {
    item_key: row.item_key,
    operation_id: row.operation_id,
    target_id: row.target_id,
    action: row.action as YayaPreparedItemView["action"],
    resource: row.resource as YayaPreparedItemView["resource"],
    resource_ref: ref,
    payload: row.payload as YayaPreparedItemView["payload"],
    content_digest: row.content_digest,
    attachment_associations: parseAssociations(row.attachment_associations),
    business_revision: row.business_revision,
    status: row.status,
  };
}

function toProposalView(row: ProposalRow, items: readonly ProposalItemRow[]): YayaPreparedProposalView {
  return {
    proposal_id: row.id,
    batch_id: row.batch_id,
    conversation_id: row.conversation_id,
    owner_account_id: row.owner_account_id,
    proposal_origin: row.proposal_origin,
    auth: parseToolAuth(row.auth),
    status: row.status,
    prepared_at: isoRequired(row.prepared_at),
    items: items.map(toPreparedItem),
  };
}

async function loadProposalItems(
  client: TransactionClient,
  proposalId: string,
): Promise<ProposalItemRow[]> {
  const result = await client.query<ProposalItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM yaya_proposal_items WHERE proposal_id = $1
      ORDER BY item_key`,
    [proposalId],
  );
  return result.rows;
}

/** prepare：预分配身份并写 planned 操作行；不构成任何业务写 */
export async function prepareProposal(
  client: TransactionClient,
  input: YayaPrepareProposalInput & { owner_account_id: string },
): Promise<YayaPreparedProposalView> {
  if (input.items.length === 0 || input.items.length > YAYA_MAX_BATCH_ITEMS) {
    throw new YayaDataError("invalid_request", "提案条目数量不合法。");
  }
  const conversation = await client.query(
    "SELECT id FROM yaya_conversations WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL FOR SHARE",
    [input.conversation_id, input.owner_account_id],
  );
  if (!conversation.rowCount) {
    throw new YayaDataError("not_found", "会话不存在。");
  }
  const shapeErrors = validatePrepareItems(
    input.items.map((item) => ({ ...item, content_digest: "" })),
  );
  if (shapeErrors.length > 0) {
    throw new YayaDataError("invalid_request", "提案条目形状不合法。", { reasons: shapeErrors });
  }
  await assertAttachmentsReadyForOwner(
    client,
    input.owner_account_id,
    input.items.flatMap((item) => item.attachment_associations.map((entry) => entry.attachment_id)),
  );

  const proposalId = randomUUID();
  const batchId = randomUUID();
  const proposal = await client.query<ProposalRow>(
    `INSERT INTO yaya_proposals
       (id, batch_id, conversation_id, owner_account_id, proposal_origin, auth)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING ${PROPOSAL_COLUMNS}`,
    [
      proposalId,
      batchId,
      input.conversation_id,
      input.owner_account_id,
      input.proposal_origin,
      JSON.stringify(input.auth),
    ],
  );
  for (const item of input.items) {
    const operationId = randomUUID();
    const digest = computeYayaContentDigest({
      payload: item.payload,
      action: item.action,
      resource: item.resource,
      target_id: item.target_id,
      attachment_associations: item.attachment_associations,
    });
    await client.query(
      `INSERT INTO yaya_proposal_items
         (proposal_id, item_key, operation_id, target_id, action, resource, resource_ref,
          payload, content_digest, attachment_associations, business_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11)`,
      [
        proposalId,
        item.item_key,
        operationId,
        item.target_id,
        item.action,
        item.resource,
        JSON.stringify(item.resource_ref),
        JSON.stringify(item.payload),
        digest,
        JSON.stringify(item.attachment_associations),
        item.business_revision,
      ],
    );
    await client.query(
      `INSERT INTO yaya_operations
         (operation_id, proposal_id, item_key, batch_id, target_id, actor_account_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [operationId, proposalId, item.item_key, batchId, item.target_id, input.owner_account_id],
    );
    for (const association of item.attachment_associations) {
      // 提案是引用保护的业务记录之一：准备态即建立引用，防止准备期间素材被回收。
      await client.query(
        `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
         VALUES ($1, 'proposal', $2, $3)
         ON CONFLICT (attachment_id, record_kind, record_id) DO NOTHING`,
        [association.attachment_id, proposalId, input.owner_account_id],
      );
    }
  }
  const proposalRow = proposal.rows[0];
  if (!proposalRow) throw new YayaDataError("server_error", "创建提案失败。");
  return toProposalView(proposalRow, await loadProposalItems(client, proposalId));
}

export async function getProposal(
  client: TransactionClient,
  ownerAccountId: string,
  proposalId: string,
): Promise<YayaPreparedProposalView | null> {
  const result = await client.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM yaya_proposals WHERE id = $1 AND owner_account_id = $2`,
    [proposalId, ownerAccountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return toProposalView(row, await loadProposalItems(client, proposalId));
}

function approvalDenyReason(decision: AccessDecision): string | null {
  if (decision.allowed) return null;
  if ("invalid_request" in decision) return "illegal_combination";
  switch (decision.deny) {
    case "unauthenticated":
      return "unauthenticated";
    case "forbidden_role":
      return "role_not_allowed";
    case "out_of_scope":
      return "out_of_scope";
    case "empty_scope":
      return "empty_scope";
    case "account_disabled":
      return "account_disabled";
    case "identity_unavailable":
      return "identity_unavailable";
  }
}

/**
 * 可信批准：只接收 operation_id 集合。actor/session/资源事实/摘要/附件/版本
 * 全部由服务端读取或重算；任一项不满足即整批拒绝（不部分批准）。
 */
export async function recordApproval(
  client: TransactionClient,
  input: YayaRecordApprovalInput,
): Promise<YayaRecordApprovalResult> {
  if (input.operation_ids.length === 0 || input.operation_ids.length > YAYA_MAX_BATCH_ITEMS) {
    throw new YayaDataError("invalid_request", "批准的操作集合不合法。");
  }
  const proposalResult = await client.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM yaya_proposals
      WHERE id = $1 AND owner_account_id = $2 FOR UPDATE`,
    [input.proposal_id, input.principal.account_id],
  );
  const proposal = proposalResult.rows[0];
  if (!proposal) throw new YayaDataError("not_found", "提案不存在。");
  if (proposal.status !== "open") {
    throw new YayaDataError("approval_invalid", "提案已关闭或已取消。");
  }
  const items = await loadProposalItems(client, input.proposal_id);
  const itemsByOperation = new Map(items.map((item) => [item.operation_id, item]));
  for (const operationId of input.operation_ids) {
    const item = itemsByOperation.get(operationId);
    if (!item) throw new YayaDataError("invalid_request", "所选操作不属于该提案。");
    if (item.status !== "pending") {
      throw new YayaDataError("approval_invalid", "所选操作已被处理。");
    }
  }
  const operationRows = await client.query<OperationRow>(
    `SELECT operation_id, proposal_id, item_key, batch_id, target_id, actor_account_id,
            approval_id, status, effect, business_object_id, business_revision, started_at,
            recorded_at, superseded_by
       FROM yaya_operations
      WHERE operation_id = ANY($1::varchar[]) ORDER BY operation_id FOR UPDATE`,
    [[...input.operation_ids]],
  );
  if (operationRows.rows.length !== input.operation_ids.length) {
    throw new YayaDataError("operation_not_found", "操作不存在。");
  }

  const reasons: string[] = [];
  const approvalItems: YayaApprovalItemRef[] = [];
  for (const item of [...items].filter((entry) => input.operation_ids.includes(entry.operation_id)).sort((a, b) => a.item_key.localeCompare(b.item_key))) {
    const operation = operationRows.rows.find((row) => row.operation_id === item.operation_id);
    if (!operation || operation.proposal_id !== proposal.id || operation.actor_account_id !== input.principal.account_id) {
      reasons.push("operation_id_mismatch");
      continue;
    }
    if (operation.superseded_by !== null) reasons.push("approval_cancelled");
    if (operation.status !== null || operation.started_at !== null) reasons.push("operation_id_mismatch");
    const resourceRef = parseResourceRef(item.resource_ref);
    if (resourceRef === null) {
      reasons.push("resource_kind_mismatch");
      continue;
    }
    const action = item.action as YayaApprovalItemRef["action"];
    if (!isLegalAccessCombination(action, item.resource as YayaApprovalItemRef["resource"])) {
      reasons.push("illegal_combination");
      continue;
    }
    const facts = await readAccessResourceFacts(client, resourceRef, input.school_id);
    if (facts === null) {
      reasons.push("target_changed");
      continue;
    }
    if (facts.kind !== item.resource) {
      reasons.push("resource_kind_mismatch");
      continue;
    }
    if (resourceTargetId(facts) !== item.target_id) {
      reasons.push("target_changed");
      continue;
    }
    const deny = approvalDenyReason(authorizeAction(input.principal, action, facts));
    if (deny !== null) reasons.push(deny);
    const associations = parseAssociations(item.attachment_associations);
    const recomputed = computeYayaContentDigest({
      payload: item.payload as YayaPreparedItemView["payload"],
      action,
      resource: item.resource as YayaPreparedItemView["resource"],
      target_id: item.target_id,
      attachment_associations: associations,
    });
    if (item.content_digest !== recomputed) {
      reasons.push("content_changed");
      continue;
    }
    try {
      await assertAttachmentsReadyForOwner(
        client,
        input.principal.account_id,
        associations.map((entry) => entry.attachment_id),
      );
    } catch {
      reasons.push("attachments_changed");
    }
    approvalItems.push({
      item_key: item.item_key,
      operation_id: item.operation_id,
      action,
      resource: item.resource as YayaApprovalItemRef["resource"],
      target_id: item.target_id,
      resource_facts_at_approval: facts,
      content_digest: recomputed,
      attachment_associations: associations,
      business_revision: item.business_revision,
    });
  }
  if (reasons.length > 0) {
    throw new YayaDataError("approval_invalid", "批准前提不满足，已整批拒绝。", { reasons });
  }

  // 同一提案的新批准取代旧 pending 批准（不沿用旧批准，不静默重放）。
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM yaya_approvals
      WHERE proposal_id = $1 AND cancelled_at IS NULL AND consumed_at IS NULL FOR UPDATE`,
    [input.proposal_id],
  );
  let cancelledApprovalId: string | null = null;
  if (existing.rows[0]) {
    cancelledApprovalId = existing.rows[0].id;
    await client.query("UPDATE yaya_approvals SET cancelled_at = now() WHERE id = $1", [
      cancelledApprovalId,
    ]);
  }

  const approvalId = randomUUID();
  const approvedAt = new Date(input.execution_at);
  const expiresAt = new Date(approvedAt.getTime() + YAYA_APPROVAL_TTL_SECONDS * 1000);
  const inserted = await client.query<{
    id: string;
    proposal_id: string;
    batch_id: string;
    actor_account_id: string;
    approval_source: string;
    items: unknown;
    approved_at: Date | string;
    expires_at: Date | string | null;
    cancelled_at: Date | string | null;
    consumed_at: Date | string | null;
  }>(
    `INSERT INTO yaya_approvals
       (id, proposal_id, batch_id, actor_account_id, session_id, approval_source, items, approved_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'authenticated_entry', $6::jsonb, $7, $8)
     RETURNING id, proposal_id, batch_id, actor_account_id, approval_source, items,
               approved_at, expires_at, cancelled_at, consumed_at`,
    [
      approvalId,
      input.proposal_id,
      proposal.batch_id,
      input.principal.account_id,
      input.session_id,
      JSON.stringify(approvalItems),
      approvedAt.toISOString(),
      expiresAt.toISOString(),
    ],
  );
  const approvalRow = inserted.rows[0];
  if (!approvalRow) throw new YayaDataError("server_error", "记录批准失败。");
  await client.query(
    `UPDATE yaya_proposal_items SET status = 'approved'
      WHERE proposal_id = $1 AND operation_id = ANY($2::varchar[])`,
    [input.proposal_id, [...input.operation_ids]],
  );
  return {
    approval: {
      approval_id: approvalRow.id,
      proposal_id: approvalRow.proposal_id,
      batch_id: approvalRow.batch_id,
      actor_account_id: approvalRow.actor_account_id,
      approval_source: "authenticated_entry",
      approved_at: isoRequired(approvalRow.approved_at),
      expires_at: approvalRow.expires_at === null ? null : isoRequired(approvalRow.expires_at),
      cancelled_at: approvalRow.cancelled_at === null ? null : isoRequired(approvalRow.cancelled_at),
      consumed_at: approvalRow.consumed_at === null ? null : isoRequired(approvalRow.consumed_at),
      items: approvalItems,
    },
    cancelled_approval_id: cancelledApprovalId,
  };
}

export async function rejectProposalItems(
  client: TransactionClient,
  input: YayaRejectItemsInput,
): Promise<YayaPreparedProposalView> {
  const proposalResult = await client.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM yaya_proposals
      WHERE id = $1 AND owner_account_id = $2 FOR UPDATE`,
    [input.proposal_id, input.owner_account_id],
  );
  const proposal = proposalResult.rows[0];
  if (!proposal) throw new YayaDataError("not_found", "提案不存在。");
  const items = await loadProposalItems(client, input.proposal_id);
  const itemsByOperation = new Map(items.map((item) => [item.operation_id, item]));
  for (const operationId of input.operation_ids) {
    const item = itemsByOperation.get(operationId);
    if (!item) throw new YayaDataError("invalid_request", "所选操作不属于该提案。");
    if (item.status !== "pending") {
      throw new YayaDataError("approval_invalid", "所选操作已被处理。");
    }
  }
  await client.query(
    `UPDATE yaya_proposal_items SET status = 'rejected'
      WHERE proposal_id = $1 AND operation_id = ANY($2::varchar[])`,
    [input.proposal_id, [...input.operation_ids]],
  );
  const remaining = await client.query(
    "SELECT 1 FROM yaya_proposal_items WHERE proposal_id = $1 AND status = 'pending' LIMIT 1",
    [input.proposal_id],
  );
  if (!remaining.rowCount) {
    await client.query(
      "UPDATE yaya_proposals SET status = 'closed', closed_at = now() WHERE id = $1",
      [input.proposal_id],
    );
    proposal.status = "closed";
    proposal.closed_at = new Date();
  }
  return toProposalView(proposal, await loadProposalItems(client, input.proposal_id));
}

export async function cancelPendingApproval(
  client: TransactionClient,
  input: YayaCancelApprovalInput,
): Promise<{ cancelled_approval_id: string | null }> {
  const proposal = await client.query(
    "SELECT id FROM yaya_proposals WHERE id = $1 AND owner_account_id = $2",
    [input.proposal_id, input.owner_account_id],
  );
  if (!proposal.rowCount) throw new YayaDataError("not_found", "提案不存在。");
  const pending = await client.query<{ id: string }>(
    `SELECT id FROM yaya_approvals
      WHERE proposal_id = $1 AND cancelled_at IS NULL AND consumed_at IS NULL FOR UPDATE`,
    [input.proposal_id],
  );
  const row = pending.rows[0];
  if (!row) return { cancelled_approval_id: null };
  await client.query("UPDATE yaya_approvals SET cancelled_at = now() WHERE id = $1", [row.id]);
  return { cancelled_approval_id: row.id };
}

export async function getApproval(
  client: TransactionClient,
  ownerAccountId: string,
  proposalId: string,
): Promise<YayaApprovalView | null> {
  const result = await client.query<{
    id: string;
    proposal_id: string;
    batch_id: string;
    actor_account_id: string;
    approval_source: string;
    items: unknown;
    approved_at: Date | string;
    expires_at: Date | string | null;
    cancelled_at: Date | string | null;
    consumed_at: Date | string | null;
  }>(
    `SELECT a.id, a.proposal_id, a.batch_id, a.actor_account_id, a.approval_source, a.items,
            a.approved_at, a.expires_at, a.cancelled_at, a.consumed_at
       FROM yaya_approvals a
       JOIN yaya_proposals p ON p.id = a.proposal_id
      WHERE a.proposal_id = $1 AND p.owner_account_id = $2
      ORDER BY a.approved_at DESC LIMIT 1`,
    [proposalId, ownerAccountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (!Array.isArray(row.items)) throw new YayaDataError("server_error", "批准记录损坏。");
  return {
    approval_id: row.id,
    proposal_id: row.proposal_id,
    batch_id: row.batch_id,
    actor_account_id: row.actor_account_id,
    approval_source: row.approval_source as YayaApprovalView["approval_source"],
    approved_at: isoRequired(row.approved_at),
    expires_at: row.expires_at === null ? null : isoRequired(row.expires_at),
    cancelled_at: row.cancelled_at === null ? null : isoRequired(row.cancelled_at),
    consumed_at: row.consumed_at === null ? null : isoRequired(row.consumed_at),
    items: row.items as YayaApprovalItemRef[],
  };
}
