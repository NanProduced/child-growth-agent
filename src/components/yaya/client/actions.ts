"use client";

/**
 * UI1 批准 / 执行 / 恢复动作（卡片显式点击才调用）。
 *
 * - 批准走 DATA 可信入口 `POST /proposals/{id}/approval`，只提交选中项；
 * - 执行走 `POST /operations`，请求体只有 approval_id + operation_ids；
 *   响应必须通过冻结 `assessYayaOperationsExecutionResponse` 语义核验；
 * - 结果未知只查询原 operation_id（DATA GET，已实现）；协议不自动重发任何 POST；
 * - 提案投影 / operation 身份只信服务端返回，客户端不自行分配执行身份。
 */
import { z } from "zod";

import { fetchWithAccountAuth } from "@/lib/accounts/client";
import {
  assessYayaOperationsExecutionResponse,
  parseYayaRunLookupResponse,
  yayaRunCancelResponseSchema,
  type YayaOperationsExecutionAssessment,
  type YayaRunLookupResponse,
} from "@/lib/yaya/api-contract";
import type {
  YayaOperationQueryOutcome,
  YayaOperationReceipt,
  YayaPlannedOperation,
} from "@/lib/yaya/types";
import { yayaOperationQueryOutcomeSchema } from "@/lib/yaya/api-contract";

import {
  yayaGetJson,
  yayaWriteJson,
  YAYA_CONVERSATIONS_PATH,
  YAYA_PROPOSALS_PATH,
} from "./api";
import {
  approvalResponseSchema,
  proposalResponseSchema,
  rejectProposalResponseSchema,
  type ProjectedProposal,
} from "./schemas";
import type { YayaIdentity } from "./store";

export async function fetchProposalProjection(proposalId: string): Promise<ProjectedProposal> {
  const { proposal } = await yayaGetJson(
    `${YAYA_PROPOSALS_PATH}?proposal_id=${encodeURIComponent(proposalId)}`,
    proposalResponseSchema
  );
  return proposal;
}

export interface ApprovalOutcome {
  approval_id: string;
  proposal_id: string;
  cancelled_approval_id: string | null;
}

export async function approveProposalItems(
  proposalId: string,
  operationIds: readonly string[]
): Promise<ApprovalOutcome> {
  const result = await yayaWriteJson(
    `${YAYA_PROPOSALS_PATH}/${encodeURIComponent(proposalId)}/approval`,
    "POST",
    { action: "approve", operation_ids: [...operationIds] },
    approvalResponseSchema
  );
  return {
    approval_id: result.approval.approval_id,
    proposal_id: result.approval.proposal_id,
    cancelled_approval_id: result.cancelled_approval_id,
  };
}

export async function rejectProposalItems(
  proposalId: string,
  operationIds: readonly string[]
): Promise<ProjectedProposal> {
  const result = await yayaWriteJson(
    `${YAYA_PROPOSALS_PATH}/${encodeURIComponent(proposalId)}/approval`,
    "POST",
    { action: "reject", operation_ids: [...operationIds] },
    rejectProposalResponseSchema
  );
  return result.proposal;
}

export async function cancelProposal(proposalId: string): Promise<void> {
  await yayaWriteJson(
    `${YAYA_PROPOSALS_PATH}/${encodeURIComponent(proposalId)}/approval`,
    "POST",
    { action: "cancel" },
    z.looseObject({})
  );
}

/** 由服务端投影构造对账计划；actor 来自当前身份，操作身份来自服务端预分配。 */
export function planFromProjection(
  proposal: ProjectedProposal,
  identity: YayaIdentity,
  operationIds: readonly string[]
): YayaPlannedOperation[] {
  const selected = new Set(operationIds);
  return proposal.items
    .filter((item) => selected.has(item.operation_id))
    .map((item) => ({
      batch_id: proposal.batch_id,
      proposal_id: proposal.proposal_id,
      item_key: item.item_key,
      operation_id: item.operation_id,
      target_id: item.target_id ?? "",
      actor_account_id: identity.accountId,
    }));
}

function identityMismatchOutcome(): YayaOperationQueryOutcome {
  return { kind: "unknown", reason: "identity_mismatch" };
}

function receiptMatchesPlan(
  receipt: YayaOperationReceipt,
  plan: YayaPlannedOperation,
): boolean {
  return (
    receipt.operation_id === plan.operation_id &&
    receipt.batch_id === plan.batch_id &&
    receipt.proposal_id === plan.proposal_id &&
    receipt.item_key === plan.item_key &&
    receipt.target_id === plan.target_id &&
    receipt.actor_account_id === plan.actor_account_id
  );
}

/** 原操作响应必须仍指向请求的 operation；有计划时再核对完整回执身份。 */
export function reconcileOriginalOperationQuery(
  operationId: string,
  response: { operation_id: string; outcome: YayaOperationQueryOutcome },
  expected: YayaPlannedOperation | null,
): { operation_id: string; outcome: YayaOperationQueryOutcome } {
  if (response.operation_id !== operationId) {
    return { operation_id: operationId, outcome: identityMismatchOutcome() };
  }
  if (expected === null) {
    return {
      operation_id: operationId,
      outcome: { kind: "unknown", reason: "verification_required" },
    };
  }
  const outcome = response.outcome;
  if (outcome.kind === "saved" || outcome.kind === "saved_detail_unavailable") {
    if (!receiptMatchesPlan(outcome.receipt, expected)) {
      return { operation_id: operationId, outcome: identityMismatchOutcome() };
    }
  }
  return { operation_id: operationId, outcome };
}

export type ExecuteOutcome =
  | { kind: "assessed"; assessment: YayaOperationsExecutionAssessment }
  | { kind: "rejected"; message: string; detail: string | null };

export async function executeApprovedOperations(
  plan: readonly YayaPlannedOperation[],
  approvalId: string,
  operationIds: readonly string[]
): Promise<ExecuteOutcome> {
  const response = await fetchWithAccountAuth("/api/yaya/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approval_id: approvalId, operation_ids: [...operationIds] }),
  });
  if (!response.ok) {
    const { yayaHttpError } = await import("./api");
    const error = await yayaHttpError(response);
    return { kind: "rejected", message: error.message, detail: null };
  }
  const body: unknown = await response.json().catch(() => null);
  const assessed = assessYayaOperationsExecutionResponse(plan, body);
  if (!assessed.ok) {
    const first = assessed.violations[0];
    return {
      kind: "rejected",
      message: "执行回执未通过核验，未显示成功；请按原操作读取核对。",
      detail: first === undefined ? null : `${first.path !== "" ? `${first.path}：` : ""}${first.message}`,
    };
  }
  return { kind: "assessed", assessment: assessed.value };
}

const operationQueryResponseSchema = z.looseObject({
  operation: z.looseObject({
    operation_id: z.string().min(1),
    outcome: yayaOperationQueryOutcomeSchema,
  }),
});

/** 只按原 operation_id 查询；不启动模型、不执行旧批准、不产生业务写。 */
export async function queryOriginalOperation(
  operationId: string,
  expected: YayaPlannedOperation | null,
): Promise<{ operation_id: string; outcome: YayaOperationsExecutionAssessment["outcomes"][number]["outcome"] }> {
  const response = await yayaGetJson(
    `/api/yaya/operations?operation_id=${encodeURIComponent(operationId)}`,
    operationQueryResponseSchema
  );
  return reconcileOriginalOperationQuery(operationId, response.operation, expected);
}

/** 原运行查询（首响应丢失时）：五态分开，服务失败不冒充缺失。 */
export async function lookupOriginalRun(
  conversationId: string,
  clientRequestId: string
): Promise<YayaRunLookupResponse | null> {
  const response = await fetchWithAccountAuth(
    `${YAYA_CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/runs?client_request_id=${encodeURIComponent(
      clientRequestId
    )}`,
    { method: "GET", cache: "no-store" }
  );
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const parsed = parseYayaRunLookupResponse(body);
  return parsed.ok ? parsed.value : null;
}

/** 取消只停止原 run 的后续派发；首响应丢失时先按稳定 client_request_id 查原 run。 */
export async function requestYayaRunCancel(
  conversationId: string,
  clientRequestId: string,
  knownRunId: string | null,
): Promise<boolean> {
  let runId = knownRunId;
  if (runId === null) {
    const lookup = await lookupOriginalRun(conversationId, clientRequestId);
    if (lookup?.status !== "in_progress") return false;
    runId = lookup.run_id;
  }
  const response = await yayaWriteJson(
    `/api/yaya/runs/${encodeURIComponent(runId)}/cancel`,
    "POST",
    null,
    yayaRunCancelResponseSchema,
  );
  return response.run_id === runId;
}
