import type { ClassStage, ObservationStatus } from "@/lib/types";
import type {
  GuideCatalog,
  GuideEvidenceLinkStatus,
  GuideEvidenceQuoteSource,
  GuideEvidenceSupportKind,
  GuideGoalRef,
  GuidePerformanceItem,
  ObservationClassContextSnapshot,
} from "./types";

/**
 * 指南证据链读模型与 API 契约（G0 冻结）。
 * 个人页与班级页共用同一状态计算规则；AI 待核对属于工作流状态，不进入正式人数统计。
 */

export const GUIDE_ITEM_EVIDENCE_STATUSES = [
  "no_records",
  "has_clues",
  "confirmed_observed",
] as const;
export type GuideItemEvidenceStatus = (typeof GUIDE_ITEM_EVIDENCE_STATUSES)[number];

/** 正式状态展示文案（已批准，实现不得改写） */
export const GUIDE_ITEM_EVIDENCE_STATUS_LABELS: Record<GuideItemEvidenceStatus, string> = {
  no_records: "暂无相关记录",
  has_clues: "已有相关线索",
  confirmed_observed: "已确认观察到",
};

/** 关联工作流状态展示文案；ai_suggested 不计入正式状态与人数 */
export const GUIDE_EVIDENCE_LINK_STATUS_LABELS: Record<GuideEvidenceLinkStatus, string> = {
  ai_suggested: "AI 关联待核对",
  confirmed_performance: "已确认观察到",
  confirmed_clue: "已有相关线索",
  rejected: "已不采用",
  withdrawn: "已撤回",
};

/** 筛选范围：日期一律按观察发生日期（observed_at）计算，含首尾 */
export interface EvidenceScope {
  kind: "semester" | "all_history";
  semester_id: string | null;
  label: string;
  /** 含首尾；all_history 时为 null */
  start_date: string | null;
  end_date: string | null;
  filter_field: "observed_at";
}

export type EvidenceNoticeCode =
  | "catalog_version_mismatch"
  | "item_not_in_catalog"
  | "basis_expired"
  | "ai_link_failed"
  | "history_unknown"
  | "out_of_stage_evidence"
  | "empty_roster"
  | "empty_evidence";

/** 非阻断提示：错误、历史不确定、AI 关联失败与空状态都通过它显式表达 */
export interface EvidenceNotice {
  code: EvidenceNoticeCode;
  severity: "info" | "warning" | "error";
  message: string;
  child_id?: string;
  observation_id?: string;
  item_id?: string;
}

export interface EvidenceChildRef {
  id: string;
  name: string;
  birth_date: string;
  class_id: string | null;
  class_name: string | null;
  stage: ClassStage | null;
}

export interface EvidenceBasisView {
  observation_id: string;
  observed_at: string;
  quote: string;
  quote_source: GuideEvidenceQuoteSource;
  observation_status: ObservationStatus;
  /** 发生时班级快照；null 表示历史班级未知，按未知展示 */
  class_context: ObservationClassContextSnapshot | null;
}

export interface EvidenceLinkView {
  link_id: string;
  item_id: string;
  catalog_version: string;
  status: GuideEvidenceLinkStatus;
  support: GuideEvidenceSupportKind | null;
  basis: EvidenceBasisView[];
  ai_reason: string | null;
  teacher_note: string | null;
  created_at: string;
  decided_at: string | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
}

export interface GuideStatusCounts {
  no_records: number;
  has_clues: number;
  confirmed_observed: number;
}

export interface ChildGuideItemView {
  item: GuidePerformanceItem;
  status: GuideItemEvidenceStatus;
  /** 进入正式状态（线索/表现）的关联，按最近观察日期倒序 */
  confirmed_links: EvidenceLinkView[];
  /** AI 建议待核对；工作流状态，不计入 status 与人数 */
  pending_suggestions: EvidenceLinkView[];
  /** 进入正式状态的最早/最近观察日期 */
  first_observed_at: string | null;
  latest_observed_at: string | null;
}

export interface ChildEvidenceGoalView {
  goal: GuideGoalRef;
  items: ChildGuideItemView[];
}

export interface ChildEvidenceBook {
  child: EvidenceChildRef;
  catalog_version: string;
  catalog: GuideCatalog;
  scope: EvidenceScope;
  status_counts: GuideStatusCounts;
  goals: ChildEvidenceGoalView[];
  notices: EvidenceNotice[];
}

export interface ClassEvidenceClassRef {
  id: string;
  name: string;
  stage: ClassStage;
  school_year: string;
  is_active: boolean;
}

export interface ClassEvidenceRoster {
  /** 分母：当前在班名单人数，按儿童去重 */
  child_count: number;
  children: EvidenceChildRef[];
}

export interface ClassChildItemStatus {
  child_id: string;
  status: GuideItemEvidenceStatus;
  confirmed_links: EvidenceLinkView[];
  pending_suggestion_count: number;
  first_observed_at: string | null;
  latest_observed_at: string | null;
}

export interface ClassGuideItemView {
  item: GuidePerformanceItem;
  /** 三类人数之和恒等于 roster.child_count */
  counts: GuideStatusCounts;
  /** 分母：当前在班名单人数 */
  total: number;
  /** 已确认观察到占比（仅班级页允许展示）；total 为 0 时为 null */
  confirmed_ratio: number | null;
  children: ClassChildItemStatus[];
}

export interface ClassEvidenceGoalView {
  goal: GuideGoalRef;
  items: ClassGuideItemView[];
}

export interface ClassEvidenceOverview {
  class: ClassEvidenceClassRef;
  catalog_version: string;
  catalog: GuideCatalog;
  scope: EvidenceScope;
  roster: ClassEvidenceRoster;
  goals: ClassEvidenceGoalView[];
  notices: EvidenceNotice[];
}

/** 读模型查询参数；缺省为当前学期，查看全部历史必须显式声明 */
export interface EvidenceQueryOptions {
  scope?: "current_semester" | "all_history";
  /** 显式学期 id；提供时优先于 scope */
  semester_id?: string;
}

export type GuideEvidenceAction = "suggest" | "confirm" | "reject" | "withdraw";

export interface GuideEvidenceBasisInput {
  observation_id: string;
  quote: string;
  quote_source: GuideEvidenceQuoteSource;
}

export interface GuideEvidenceSuggestRequest {
  action: "suggest";
}

export interface GuideEvidenceConfirmRequest {
  action: "confirm";
  link_id: string;
  support: GuideEvidenceSupportKind;
  /**
   * 确认后写入的依据快照：single_event / clue_only 至少 1 条；
   * sustained 需跨日多条（observed_at 至少两天），或由 teacher_note
   * 给出明确期间与事实依据的连续观察纪要说明。
   */
  basis: GuideEvidenceBasisInput[];
  teacher_note?: string;
}

export interface GuideEvidenceRejectRequest {
  action: "reject";
  link_id: string;
  reason?: string;
}

export interface GuideEvidenceWithdrawRequest {
  action: "withdraw";
  link_id: string;
  reason?: string;
}

export type GuideEvidenceMutationRequest =
  | GuideEvidenceSuggestRequest
  | GuideEvidenceConfirmRequest
  | GuideEvidenceRejectRequest
  | GuideEvidenceWithdrawRequest;

export interface GuideEvidenceMutationResponse {
  observation_id: string;
  /** 操作后的全部关联（含工作流状态） */
  links: EvidenceLinkView[];
  /** 非阻断提示；AI 关联失败时为 ai_link_failed */
  notice?: EvidenceNotice;
}

export type EvidenceErrorCode =
  | "invalid_request"
  | "teacher_auth_disabled"
  | "unauthorized"
  | "not_found"
  | "state_conflict"
  | "basis_expired"
  | "catalog_version_mismatch"
  | "semester_config_missing"
  | "server_error";

/** 新增证据链接口的错误体；沿用现有接口的 message 字段并补充稳定 error 码 */
export interface EvidenceApiError {
  error: EvidenceErrorCode;
  message: string;
}
