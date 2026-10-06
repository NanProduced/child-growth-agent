/**
 * 操作账本：同事务执行、原身份查询与原子替代（DATA1）。
 *
 * - `executeApprovedOperations` 必须在调用方（TOOLS1）已有的 `withTransaction`
 *   client 内执行：批准消费 + callback 业务变更 + 回执全部使用同一个 client，
 *   callback 不得另开连接或自行提交；callback 抛错或回执缺成功证明则整单回滚；
 * - 不在模型等待期间持锁：本函数只在模型返回后的短事务里加行锁；
 * - 重复请求返回原回执，不重复执行；已替代/已开始的旧操作拒绝迟到写入；
 * - `supersedeWithReplacement` 锁旧操作 → 核尚未开始 → 取消旧批准 → 同事务发布新身份。
 */
import type { TransactionClient } from "@/storage/database/pg-client";
import {
  evaluateApprovalExecution,
  itemsToResend,
  queryOperationOutcome,
  type YayaApprovalBinding,
  type YayaApprovalItemExecution,
  type YayaApprovalItemRef,
  type YayaApprovalSubmitter,
  type YayaOperationReceipt,
  type YayaPlannedOperation,
  type YayaProposalItem,
} from "../types";
import {
  YAYA_MAX_BATCH_ITEMS,
  YayaDataError,
  computeYayaContentDigest,
  type YayaBatchQueryView,
  type YayaBusinessWriteResult,
  type YayaExecuteApprovedInput,
  type YayaExecutionItemContext,
  type YayaOperationQueryView,
  type YayaSupersedeInput,
  type YayaSupersedeResult,
} from "../storage-types";
import { readAccessResourceFacts } from "./access-facts";
import {
  guardBusinessWriteResult,
  guardExecutionAgainstOperation,
  receiptRowToReceipt,
  type YayaOperationRow,
} from "./invariants";
import { parseAssociations, prepareProposal } from "./proposals";
import { iso, isoRequired, parseResourceRef } from "./rows";

interface ApprovalRow {
  id: string;
  proposal_id: string;
  batch_id: string;
  actor_account_id: string;
  session_id: string;
  approval_source: string;
  items: unknown;
  approved_at: Date | string;
  expires_at: Date | string | null;
  cancelled_at: Date | string | null;
  consumed_at: Date | string | null;
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
  status: string;
}

const OPERATION_COLUMNS =
  "operation_id, proposal_id, item_key, batch_id, target_id, actor_account_id, approval_id, status, effect, business_object_id, business_revision, started_at, recorded_at, superseded_by";

function toPlanned(row: YayaOperationRow): YayaPlannedOperation {
  return {
    batch_id: row.batch_id,
    proposal_id: row.proposal_id,
    item_key: row.item_key,
    operation_id: row.operation_id,
    target_id: row.target_id,
    actor_account_id: row.actor_account_id,
  };
}

function toQueryView(row: YayaOperationRow): YayaOperationQueryView {
  const planned = toPlanned(row);
  const receipt = receiptRowToReceipt(row);
  const outcome = queryOperationOutcome(receipt ? [receipt] : [], planned);
  return {
    operation_id: row.operation_id,
    planned,
    status: row.status,
    superseded_by: row.superseded_by,
    started: row.started_at !== null,
    outcome,
  };
}

export async function queryOperation(
  client: TransactionClient,
  ownerAccountId: string,
  operationId: string,
): Promise<YayaOperationQueryView | null> {
  const result = await client.query<YayaOperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM yaya_operations
      WHERE operation_id = $1 AND actor_account_id = $2`,
    [operationId, ownerAccountId],
  );
  const row = result.rows[0];
  return row ? toQueryView(row) : null;
}

export async function queryBatch(
  client: TransactionClient,
  ownerAccountId: string,
  batchId: string,
): Promise<YayaBatchQueryView> {
  const result = await client.query<YayaOperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM yaya_operations
      WHERE batch_id = $1 AND actor_account_id = $2 ORDER BY operation_id`,
    [batchId, ownerAccountId],
  );
  return { batch_id: batchId, operations: result.rows.map(toQueryView) };
}

function parseApprovalItems(value: unknown): YayaApprovalItemRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new YayaDataError("approval_invalid", "批准记录条目损坏。");
  }
  const items: YayaApprovalItemRef[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new YayaDataError("approval_invalid", "批准记录条目损坏。");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.item_key !== "string" ||
      typeof record.operation_id !== "string" ||
      typeof record.action !== "string" ||
      typeof record.resource !== "string" ||
      typeof record.target_id !== "string" ||
      typeof record.resource_facts_at_approval !== "object" ||
      record.resource_facts_at_approval === null
    ) {
      throw new YayaDataError("approval_invalid", "批准记录条目损坏。");
    }
    items.push(entry as YayaApprovalItemRef);
  }
  return items;
}

function buildBinding(proposalOrigin: "teacher_card" | "model_suggestion", row: ApprovalRow, items: YayaApprovalItemRef[]): YayaApprovalBinding {
  return {
    approval_id: row.id,
    batch_id: row.batch_id,
    proposal_id: row.proposal_id,
    proposal_origin: proposalOrigin,
    approval_source: row.approval_source as YayaApprovalBinding["approval_source"],
    actor_account_id: row.actor_account_id,
    session_id: row.session_id,
    items,
    approved_at: isoRequired(row.approved_at),
    expires_at: iso(row.expires_at),
    cancelled_at: iso(row.cancelled_at),
  };
}

/** `verifyApprovedOperations` 输入：与正式执行同一套提交者/批准/版本解析口径 */
export interface YayaVerifyApprovedInput {
  approval_id: string;
  operation_ids: readonly string[];
  submitter: YayaApprovalSubmitter;
  school_id: string;
  resolveBusinessRevision?: (context: YayaExecutionItemContext) => Promise<string | null>;
}

/**
 * 同 client 的批准核验结果（不消费批准、不写业务）：
 * - `replayed_receipts` 非空表示所选操作全部已有回执，调用方应直接按原回执返回；
 * - `executions` 为已核验的逐项执行上下文（输入顺序）。
 */
export interface YayaVerifiedApprovedOperations {
  approval_id: string;
  proposal_id: string;
  batch_id: string;
  proposal_origin: "teacher_card" | "model_suggestion";
  replayed_receipts: readonly YayaOperationReceipt[] | null;
  executions: readonly YayaExecutionItemContext[];
  operations: readonly YayaOperationRow[];
}

/**
 * 目标业务行锁（稳定顺序：children → classes → observations → teacher accounts）。
 * 锁后读取并核对批准版本，消除“先读旧修订、等待行锁后被并发覆盖”的窗口；
 * 只锁当前操作明确指向的目标行，不给普通只读 getter 加锁。
 */
async function lockExecutionTargets(
  client: TransactionClient,
  items: readonly ProposalItemRow[],
): Promise<void> {
  const targets = new Map<string, { table: string; id: string; rank: number }>();
  const add = (rank: number, table: string, id: string): void => {
    targets.set(`${rank}:${id}`, { table, id, rank });
  };
  for (const item of items) {
    const ref = parseResourceRef(item.resource_ref);
    if (ref === null) continue;
    if (ref.kind === "child" || ref.kind === "transfer") add(0, "children", ref.child_id);
    if (ref.kind === "class" && ref.class_id !== null) add(1, "classes", ref.class_id);
    if (ref.kind === "observation") {
      const found = await client.query<{ child_id: string }>(
        "SELECT child_id FROM observations WHERE id = $1",
        [ref.observation_id],
      );
      const childId = found.rows[0]?.child_id;
      if (childId) add(0, "children", childId);
      add(2, "observations", ref.observation_id);
    }
    if (ref.kind === "school") {
      const payload = item.payload as YayaProposalItem["payload"];
      if (payload.kind === "manage_teacher" && payload.teacher_account_id) {
        add(3, "app_accounts", payload.teacher_account_id);
      }
    }
  }
  const ordered = [...targets.values()].sort(
    (left, right) => left.rank - right.rank || left.id.localeCompare(right.id),
  );
  for (const target of ordered) {
    await client.query(`SELECT id FROM ${target.table} WHERE id = $1 FOR UPDATE`, [target.id]);
  }
}

/**
 * 批准核验（共享边界，不消费批准）：
 * - 与正式执行同一套判定：提交者/原 session/CSRF/批准生命周期 + 逐项身份/资源事实/
 *   内容摘要/附件关联/业务版本 + `evaluateApprovalExecution`；
 * - 先按稳定顺序取得目标行锁，再读取并核对批准版本；锁等待后按当前时间重新核验
 *   批准到期与会话有效性（与 AUTH private-auth 同一判定口径）；
 * - 任何前提不满足抛 `approval_invalid` 并附 reasons；调用方不得自行复制第二套规则。
 */
export async function verifyApprovedOperations(
  client: TransactionClient,
  input: YayaVerifyApprovedInput,
): Promise<YayaVerifiedApprovedOperations> {
  const uniqueIds = [...new Set(input.operation_ids)];
  if (
    uniqueIds.length === 0 ||
    uniqueIds.length !== input.operation_ids.length ||
    uniqueIds.length > YAYA_MAX_BATCH_ITEMS
  ) {
    throw new YayaDataError("invalid_request", "执行的操作集合不合法。");
  }
  const principal = input.submitter.principal;
  if (principal === null) {
    throw new YayaDataError("approval_invalid", "执行身份缺失。", { reasons: ["unauthenticated"] });
  }
  const operations = await client.query<YayaOperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM yaya_operations
      WHERE operation_id = ANY($1::varchar[]) ORDER BY operation_id FOR UPDATE`,
    [uniqueIds],
  );
  if (operations.rows.length !== uniqueIds.length) {
    throw new YayaDataError("operation_not_found", "操作不存在。");
  }
  for (const row of operations.rows) {
    if (row.actor_account_id !== principal.account_id) {
      throw new YayaDataError("operation_not_found", "操作不存在。");
    }
  }
  const existing = operations.rows.map((row) => receiptRowToReceipt(row));
  if (existing.every((receipt) => receipt !== null)) {
    const byId = new Map((existing as YayaOperationReceipt[]).map((receipt) => [receipt.operation_id, receipt]));
    const replayed = input.operation_ids.map((operationId) => {
      const receipt = byId.get(operationId);
      if (!receipt) throw new YayaDataError("operation_unknown", "回执缺失。");
      return receipt;
    });
    return {
      approval_id: input.approval_id,
      proposal_id: operations.rows[0]?.proposal_id ?? "",
      batch_id: operations.rows[0]?.batch_id ?? "",
      proposal_origin: "model_suggestion",
      replayed_receipts: replayed,
      executions: [],
      operations: operations.rows,
    };
  }
  if (existing.some((receipt) => receipt !== null)) {
    throw new YayaDataError("operation_unknown", "该批准集合存在部分回执，无法原子重放。");
  }

  const approvalResult = await client.query<ApprovalRow>(
    "SELECT * FROM yaya_approvals WHERE id = $1 FOR UPDATE",
    [input.approval_id],
  );
  const approval = approvalResult.rows[0];
  if (!approval) {
    throw new YayaDataError("approval_invalid", "批准记录不存在。");
  }
  const proposalResult = await client.query<{
    id: string;
    batch_id: string;
    proposal_origin: "teacher_card" | "model_suggestion";
  }>(
    "SELECT id, batch_id, proposal_origin FROM yaya_proposals WHERE id = $1",
    [approval.proposal_id],
  );
  const proposal = proposalResult.rows[0];
  if (!proposal) throw new YayaDataError("approval_invalid", "提案不存在。");
  if (proposal.batch_id !== approval.batch_id) {
    throw new YayaDataError("approval_invalid", "批准与提案批次不一致。");
  }
  const reasons: string[] = [];
  if (
    input.submitter.identity_state !== "authenticated" ||
    input.submitter.principal === null
  ) {
    reasons.push("unauthenticated");
  }
  if (!input.submitter.session_valid) reasons.push("session_invalid");
  if (!input.submitter.csrf_verified) reasons.push("csrf_not_verified");
  if (approval.session_id !== input.submitter.session_id) reasons.push("session_changed");
  if (approval.actor_account_id !== principal.account_id) reasons.push("actor_changed");
  if (approval.cancelled_at !== null) reasons.push("approval_cancelled");
  if (
    approval.expires_at !== null &&
    Date.parse(input.submitter.execution_at) >= Date.parse(isoRequired(approval.expires_at))
  ) {
    reasons.push("approval_expired");
  }
  if (approval.consumed_at !== null) {
    throw new YayaDataError("approval_consumed", "批准已被消费。");
  }
  const bindingItems = parseApprovalItems(approval.items);
  const proposalItems = await client.query<ProposalItemRow>(
    `SELECT proposal_id, item_key, operation_id, target_id, action, resource, resource_ref,
            payload, content_digest, attachment_associations, business_revision, status
       FROM yaya_proposal_items
      WHERE operation_id = ANY($1::varchar[]) ORDER BY item_key`,
    [uniqueIds],
  );
  // 先按稳定顺序取得目标行锁；后续逐项读取/版本核对都使用锁后事实。
  await lockExecutionTargets(client, proposalItems.rows);
  const proposalItemByOperation = new Map(proposalItems.rows.map((row) => [row.operation_id, row]));
  const executions: YayaApprovalItemExecution[] = [];
  const contexts: YayaExecutionItemContext[] = [];
  for (const row of operations.rows) {
    if (row.proposal_id !== approval.proposal_id) reasons.push("unexpected_item");
    const guard = guardExecutionAgainstOperation({
      receipt_status: row.status as YayaOperationRow["status"],
      started_at: row.started_at === null ? null : isoRequired(row.started_at),
      superseded_by: row.superseded_by,
    });
    if (guard === "superseded") reasons.push("approval_cancelled");
    if (guard === "started") reasons.push("operation_id_mismatch");
    const approvalItem = bindingItems.find(
      (item) => item.operation_id === row.operation_id && item.item_key === row.item_key,
    );
    if (!approvalItem) {
      reasons.push("missing_item");
      continue;
    }
    const proposalItem = proposalItemByOperation.get(row.operation_id);
    if (!proposalItem) {
      reasons.push("missing_item");
      continue;
    }
    const resourceRef = parseResourceRef(proposalItem.resource_ref);
    if (resourceRef === null) {
      reasons.push("resource_kind_mismatch");
      continue;
    }
    const facts = await readAccessResourceFacts(client, resourceRef, input.school_id);
    if (facts === null) {
      reasons.push("target_changed");
      continue;
    }
    const associations = parseAssociations(proposalItem.attachment_associations);
    const recomputed = computeYayaContentDigest({
      payload: proposalItem.payload as YayaProposalItem["payload"],
      action: approvalItem.action,
      resource: approvalItem.resource,
      target_id: approvalItem.target_id,
      attachment_associations: associations,
    });
    if (recomputed !== approvalItem.content_digest) reasons.push("content_changed");
    let businessRevision = approvalItem.business_revision;
    const context: YayaExecutionItemContext = {
      operation: toPlanned(row),
      proposal_item: {
        item_key: proposalItem.item_key,
        target_id: proposalItem.target_id,
        content_digest: proposalItem.content_digest,
        attachment_associations: associations,
        payload: proposalItem.payload as YayaProposalItem["payload"],
      },
      approval_item: approvalItem,
      proposal_origin: proposal.proposal_origin,
    };
    if (approvalItem.business_revision !== null) {
      if (!input.resolveBusinessRevision) {
        reasons.push("business_version_changed");
      } else {
        businessRevision = await input.resolveBusinessRevision(context);
      }
    }
    executions.push({
      item_key: approvalItem.item_key,
      operation_id: approvalItem.operation_id,
      resource_facts: facts,
      content_digest: recomputed,
      attachment_associations: approvalItem.attachment_associations,
      business_revision: businessRevision,
    });
    contexts.push(context);
  }
  const evaluation = evaluateApprovalExecution(
    buildBinding(proposal.proposal_origin, approval, bindingItems),
    input.submitter,
    executions,
  );
  if (!evaluation.ok) reasons.push(...evaluation.reasons);
  // 行锁等待可能跨过批准到期或会话期限：按当前时间/当前会话事实复核。
  if (approval.cancelled_at !== null) reasons.push("approval_cancelled");
  if (approval.expires_at !== null && new Date() >= new Date(isoRequired(approval.expires_at))) {
    reasons.push("approval_expired");
  }
  const sessionFresh = await client.query<{ valid: boolean }>(
    `SELECT revoked_at IS NULL AND expires_at > clock_timestamp() AS valid
       FROM app_sessions WHERE id = $1`,
    [approval.session_id],
  );
  if (sessionFresh.rows[0]?.valid !== true) reasons.push("session_invalid");
  if (reasons.length > 0) {
    throw new YayaDataError("approval_invalid", "批准前提已变化，已拒绝执行。", {
      reasons: [...new Set(reasons)],
    });
  }
  return {
    approval_id: approval.id,
    proposal_id: approval.proposal_id,
    batch_id: approval.batch_id,
    proposal_origin: proposal.proposal_origin,
    replayed_receipts: null,
    executions: contexts,
    operations: operations.rows,
  };
}

/**
 * 授权执行：调用方必须在业务写事务内传入同一个 client。
 * 返回逐项回执；重复调用（全部已有回执）返回原回执，不再次执行。
 * 核验与准备态保存共用 `verifyApprovedOperations`，不复制第二套审批规则。
 */
export async function executeApprovedOperations(
  client: TransactionClient,
  input: YayaExecuteApprovedInput,
): Promise<readonly YayaOperationReceipt[]> {
  const verified = await verifyApprovedOperations(client, {
    approval_id: input.approval_id,
    operation_ids: input.operation_ids,
    submitter: input.submitter,
    school_id: input.school_id,
    resolveBusinessRevision: input.resolveBusinessRevision,
  });
  if (verified.replayed_receipts !== null) return verified.replayed_receipts;

  const uniqueIds = [...new Set(input.operation_ids)];
  const consumed = await client.query(
    "UPDATE yaya_approvals SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL",
    [verified.approval_id],
  );
  if (!consumed.rowCount) {
    throw new YayaDataError("approval_consumed", "批准已被消费。");
  }
  await client.query(
    "UPDATE yaya_operations SET started_at = now(), approval_id = $2 WHERE operation_id = ANY($1::varchar[])",
    [uniqueIds, verified.approval_id],
  );

  const contextByOperation = new Map(
    verified.executions.map((context) => [context.operation.operation_id, context]),
  );
  const receipts: YayaOperationReceipt[] = [];
  for (const operationId of input.operation_ids) {
    const context = contextByOperation.get(operationId);
    if (!context) {
      throw new YayaDataError("operation_unknown", "执行上下文不完整。");
    }
    const result: YayaBusinessWriteResult = await input.callback(client, context);
    const violations = guardBusinessWriteResult(result);
    if (violations.length > 0) {
      throw new YayaDataError("operation_unknown", "业务结果缺少成功证明，回执未落账。", {
        reasons: violations,
      });
    }
    const updated = await client.query<YayaOperationRow>(
      `UPDATE yaya_operations
          SET status = $2, effect = $3, business_object_id = $4, business_revision = $5,
              recorded_at = now(), resolved_at = now()
        WHERE operation_id = $1
        RETURNING ${OPERATION_COLUMNS}`,
      [
        operationId,
        result.status,
        result.effect,
        result.business_object_id,
        result.business_revision,
      ],
    );
    const receipt = receiptRowToReceipt(updated.rows[0] ?? null);
    if (receipt === null) throw new YayaDataError("operation_unknown", "回执写入失败。");
    receipts.push(receipt);
  }
  return receipts;
}

/**
 * 原子替代：锁旧操作 → 核尚未开始 → supersede 旧执行与批准 → 同事务发布新身份。
 * 已执行/执行中/未知的旧操作只能按原 operation_id 查询。
 */
export async function supersedeWithReplacement(
  client: TransactionClient,
  input: YayaSupersedeInput,
): Promise<YayaSupersedeResult> {
  const oldResult = await client.query<YayaOperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM yaya_operations WHERE operation_id = $1 FOR UPDATE`,
    [input.operation_id],
  );
  const old = oldResult.rows[0];
  if (!old || old.actor_account_id !== input.actor_account_id) {
    throw new YayaDataError("operation_not_found", "操作不存在。");
  }
  if (old.status !== null) {
    throw new YayaDataError("operation_started", "原操作已执行，只能查询原操作。");
  }
  if (old.started_at !== null) {
    throw new YayaDataError("operation_started", "原操作已开始执行，不能替代。");
  }
  if (old.superseded_by !== null) {
    throw new YayaDataError("operation_started", "原操作已被替代，只能查询原操作。");
  }

  const pendingApprovals = await client.query<{ id: string; items: unknown }>(
    `SELECT id, items FROM yaya_approvals
      WHERE proposal_id = $1 AND cancelled_at IS NULL AND consumed_at IS NULL FOR UPDATE`,
    [old.proposal_id],
  );
  const cancelledApprovalIds: string[] = [];
  for (const approval of pendingApprovals.rows) {
    const items = Array.isArray(approval.items) ? (approval.items as { operation_id?: unknown }[]) : [];
    if (!items.some((item) => item.operation_id === old.operation_id)) continue;
    await client.query("UPDATE yaya_approvals SET cancelled_at = now() WHERE id = $1", [approval.id]);
    cancelledApprovalIds.push(approval.id);
  }

  const replacement = await prepareProposal(client, {
    ...input.replacement,
    owner_account_id: input.actor_account_id,
  });
  if (replacement.items.length !== 1) {
    throw new YayaDataError("invalid_request", "替代必须发布恰好一个新操作身份。");
  }
  const newOperationId = replacement.items[0].operation_id;
  const linked = await client.query(
    `UPDATE yaya_operations SET superseded_by = $2, superseded_at = now()
      WHERE operation_id = $1 AND superseded_by IS NULL AND started_at IS NULL AND status IS NULL`,
    [old.operation_id, newOperationId],
  );
  if (!linked.rowCount) {
    throw new YayaDataError("operation_started", "原操作已开始执行，不能替代。");
  }
  await client.query(
    `UPDATE yaya_proposal_items SET status = 'superseded'
      WHERE proposal_id = $1 AND operation_id = $2 AND status IN ('pending', 'approved')`,
    [old.proposal_id, old.operation_id],
  );
  return {
    superseded_operation_id: old.operation_id,
    cancelled_approval_ids: cancelledApprovalIds,
    replacement,
  };
}

/** 显式恢复候选：复用冻结查询判定，只输出已核验 failed+none */
export function operationRecoveryCandidates(
  plan: readonly YayaPlannedOperation[],
  receipts: readonly YayaOperationReceipt[],
): readonly YayaOperationReceipt[] {
  return itemsToResend(plan, receipts);
}
