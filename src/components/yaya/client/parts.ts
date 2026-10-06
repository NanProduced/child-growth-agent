/**
 * UI1 专用 data message part 名称与载荷（仅客户端展示语义）。
 *
 * 这些 part 只承载协议已批准事件的展示形态；任何执行语义仍以服务端
 * 提案 / 批准 / operation 记录为准，UI 不自行分配执行身份。
 */
import type { YayaAgentStopReason } from "@/lib/yaya/agent/types";
import type { YayaOperationQueryOutcome, YayaSourceRef } from "@/lib/yaya/types";

export const YAYA_PART_NAMES = {
  sources: "yaya-sources",
  clarify: "yaya-clarify",
  proposal: "yaya-proposal",
  receipt: "yaya-receipt",
  stopped: "yaya-stopped",
  toolResult: "yaya-tool-result",
  searchRefused: "yaya-search-refused",
  runError: "yaya-run-error",
  historyState: "yaya-history-state",
  historyNote: "yaya-history-note",
} as const;

export interface YayaSourcesPartData {
  sources: readonly YayaSourceRef[];
}

export interface YayaClarifyPartData {
  question: string;
}

export interface YayaProposalPartData {
  proposal_id: string;
  proposal_origin: "teacher_card" | "model_suggestion";
}

export interface YayaReceiptPartData {
  operation_id: string;
  outcome: YayaOperationQueryOutcome;
}

export interface YayaStoppedPartData {
  reason: YayaAgentStopReason;
  detail: string | null;
}

export interface YayaToolResultPartData {
  tool: string;
  outcome: "ok" | "failed";
  source_kind: string | null;
}

export interface YayaSearchRefusedPartData {
  tool: string;
  reason: "provider_disabled" | "identifiers_present" | "scan_unknown_conservative";
}

export interface YayaRunErrorPartData {
  stage: "http" | "malformed" | "network" | "not_wired";
  status: number | null;
  code: string | null;
  message: string;
  detail: string | null;
  /** 原运行查询所需身份（客户端生成、跨重试稳定）；只用于只读核对。 */
  client_request_id?: string | null;
  conversation_id?: string | null;
}

export interface YayaHistoryStatePartData {
  execution_state: "pending_approval" | "unknown" | "executed";
  text: string;
}

export interface YayaHistoryNotePartData {
  text: string;
}
