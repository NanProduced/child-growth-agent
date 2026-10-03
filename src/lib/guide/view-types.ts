import type { ClassStage, ObservationStatus } from "@/lib/types";
import type {
  GuideAgeBand,
  GuideCatalog,
  GuideDomainCode,
  GuideEvidenceLinkOrigin,
  GuideEvidenceLinkStatus,
  GuideEvidencePeriodNote,
  GuideEvidenceQuoteField,
  GuideEvidenceQuoteSource,
  GuideEvidenceSupportKind,
  GuideGoalRef,
  GuidePerformanceItem,
  ObservationClassContextSnapshot,
} from "./types";

/**
 * 指南证据链读模型与 API 契约（G0-R1 冻结）。
 * 个人页（历史回看）与班级页（当前名单统计）共用同一正式状态计算规则，
 * 但筛选口径不同：个人页不按当前学段排除历史证据，班级页只统计当前名单与可核对阶段的证据。
 * AI 待核对属于工作流状态，不进入正式人数统计。
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

/**
 * 可靠性：表达“统计是否可靠”，不是第四种儿童状态。
 * - reliable：所有相关证据都可读且通过核对；期间与阶段排除属于正常口径；
 * - partial：部分证据因损坏、失效依据、目录版本或阶段未知未纳入，计数为下限；
 * - unavailable：相关证据完全无法读取，不能展示为正常的 0。
 */
export const EVIDENCE_RELIABILITIES = ["reliable", "partial", "unavailable"] as const;
export type EvidenceReliability = (typeof EVIDENCE_RELIABILITIES)[number];

/** 关联不计入正式状态的原因（审计展示用；counts_toward_status=true 时为 null） */
export type EvidenceExclusionReason =
  | "workflow_pending"
  | "teacher_rejected"
  | "withdrawn"
  | "basis_invalid"
  | "basis_out_of_period"
  | "catalog_mismatch"
  | "support_insufficient"
  | "history_unknown"
  | "out_of_stage_evidence"
  | "unknown_status";

/** 单条依据核对失败原因；valid=true 时为 null */
export type EvidenceBasisInvalidReason =
  | "source_missing"
  | "cross_child"
  | "not_confirmed"
  | "quote_not_found"
  | "version_mismatch";

/**
 * 筛选范围：日期一律按观察发生日期（observed_at）计算，含首尾。
 * semester / custom_range 由显式配置或显式参数给出；all_history 不限日期。
 */
export interface EvidenceScope {
  kind: "semester" | "all_history" | "custom_range";
  semester_id: string | null;
  label: string;
  /** 含首尾；all_history 时为 null */
  start_date: string | null;
  end_date: string | null;
  filter_field: "observed_at";
}

/** 视图筛选：所选领域 / 指南参照年龄段 / 目标；null 表示不过滤 */
export interface EvidenceViewFilters {
  domain_code: GuideDomainCode | null;
  age_band: GuideAgeBand | null;
  goal_id: string | null;
}

/**
 * 统计口径：
 * - child_history：个人历史回看，按儿童与观察日期筛选，不按当前学段排除历史证据；
 * - class_current_roster：班级当前名单统计，分母为在班名单，只纳入可核对为同学段的有效证据。
 */
export type EvidenceAudience = "child_history" | "class_current_roster";

export type EvidenceNoticeCode =
  | "catalog_version_mismatch"
  | "item_not_in_catalog"
  | "basis_expired"
  | "basis_invalid"
  | "ai_link_failed"
  | "history_unknown"
  | "out_of_stage_evidence"
  | "guide_evidence_unreadable"
  | "unknown_link_status"
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
  quote_field: GuideEvidenceQuoteField | null;
  /** 发生时班级快照；null 表示历史班级未知，按未知展示 */
  class_context: ObservationClassContextSnapshot | null;
  source_confirmed_at: string | null;
  /** 服务端逐条核对结果：来源存在、同儿童、已确认、片段可核对、版本一致 */
  valid: boolean;
  invalid_reason: EvidenceBasisInvalidReason | null;
  /** 来源观察当前状态；来源不存在时为 null */
  observation_status: ObservationStatus | null;
}

export interface EvidenceLinkView {
  link_id: string;
  item_id: string;
  catalog_version: string;
  origin: GuideEvidenceLinkOrigin;
  status: GuideEvidenceLinkStatus;
  support: GuideEvidenceSupportKind | null;
  sustained_note: GuideEvidencePeriodNote | null;
  adult_help_used: boolean;
  basis: EvidenceBasisView[];
  ai_reason: string | null;
  teacher_note: string | null;
  revision: number;
  created_at: string;
  decided_at: string | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  /** 是否计入当前筛选范围的正式状态（线索/表现） */
  counts_toward_status: boolean;
  /** 不计入原因；counts_toward_status=true 时为 null */
  excluded_reason: EvidenceExclusionReason | null;
}

export interface GuideStatusCounts {
  no_records: number;
  has_clues: number;
  confirmed_observed: number;
}

export interface ChildGuideItemView {
  item: GuidePerformanceItem;
  status: GuideItemEvidenceStatus;
  reliability: EvidenceReliability;
  /** 该条目的全部关联（正式 + 工作流 + 审计），逐条带 counts_toward_status */
  links: EvidenceLinkView[];
  /** 计入状态的证据最早/最近观察日期 */
  first_observed_at: string | null;
  latest_observed_at: string | null;
}

export interface ChildEvidenceGoalView {
  goal: GuideGoalRef;
  items: ChildGuideItemView[];
}

export interface ChildEvidenceBook {
  audience: "child_history";
  child: EvidenceChildRef;
  catalog_version: string;
  catalog: GuideCatalog;
  scope: EvidenceScope;
  filters: EvidenceViewFilters;
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
  reliability: EvidenceReliability;
  /** 计入状态的正式关联数（表现 + 线索） */
  confirmed_link_count: number;
  pending_suggestion_count: number;
  first_observed_at: string | null;
  latest_observed_at: string | null;
}

export interface ClassGuideItemView {
  item: GuidePerformanceItem;
  /** 三类人数之和恒等于 roster.child_count（reliability 非 reliable 时为下限） */
  counts: GuideStatusCounts;
  /** 分母：当前在班名单人数 */
  total: number;
  reliability: EvidenceReliability;
  /**
   * 已确认观察到占比（仅班级页允许展示）；
   * reliability 非 reliable、条目不参与行为统计或 total 为 0 时为 null，不显示正常 0%。
   */
  confirmed_ratio: number | null;
  children: ClassChildItemStatus[];
}

export interface ClassEvidenceGoalView {
  goal: GuideGoalRef;
  items: ClassGuideItemView[];
}

export interface ClassEvidenceOverview {
  audience: "class_current_roster";
  class: ClassEvidenceClassRef;
  catalog_version: string;
  catalog: GuideCatalog;
  scope: EvidenceScope;
  filters: EvidenceViewFilters;
  roster: ClassEvidenceRoster;
  goals: ClassEvidenceGoalView[];
  notices: EvidenceNotice[];
}

/**
 * 读模型查询参数：
 * - 缺省为当前学期；all_history / custom_range 必须显式声明；
 * - custom_range 必须同时给出 from 与 to；semester_id 优先于 scope。
 */
export interface EvidenceQueryOptions {
  scope?: "current_semester" | "all_history" | "custom_range";
  semester_id?: string;
  from?: string;
  to?: string;
  domain_code?: GuideDomainCode;
  age_band?: GuideAgeBand;
  goal_id?: string;
}

export type GuideEvidenceAction = "suggest" | "confirm" | "reject" | "withdraw";

export interface GuideEvidenceBasisInput {
  observation_id: string;
  quote: string;
  quote_source: GuideEvidenceQuoteSource;
  /** quote_source=confirmed_content 时必填；raw_text 时必须省略或为 null */
  quote_field?: GuideEvidenceQuoteField | null;
}

/** 已有 AI 建议或既有手动关联的决定 */
export interface GuideEvidenceLinkDecisionInput {
  link_id: string;
  support: GuideEvidenceSupportKind;
  basis: GuideEvidenceBasisInput[];
  sustained_note?: GuideEvidencePeriodNote | null;
  adult_help_used?: boolean;
  teacher_note?: string;
}

/** 无 AI 建议、AI 失败或旧记录时的手动关联 */
export interface GuideEvidenceManualDecisionInput {
  item_id: string;
  support: GuideEvidenceSupportKind;
  basis: GuideEvidenceBasisInput[];
  sustained_note?: GuideEvidencePeriodNote | null;
  adult_help_used?: boolean;
  teacher_note?: string;
}

export type GuideEvidenceDecisionInput =
  | GuideEvidenceLinkDecisionInput
  | GuideEvidenceManualDecisionInput;

export interface GuideEvidenceSuggestRequest {
  action: "suggest";
}

/**
 * 批量决定：一次请求内的决定要么全部生效，要么全部不生效（无部分写入）。
 * expected_guide_revision 为读取时的容器修订号；不匹配返回 409。
 * 完全相同的重复提交在结果状态已一致时返回 200 幂等成功。
 */
export interface GuideEvidenceConfirmRequest {
  action: "confirm";
  expected_guide_revision: number;
  decisions: GuideEvidenceDecisionInput[];
}

export interface GuideEvidenceRejectRequest {
  action: "reject";
  link_id: string;
  expected_guide_revision: number;
  reason?: string;
}

export interface GuideEvidenceWithdrawRequest {
  action: "withdraw";
  link_id: string;
  expected_guide_revision: number;
  reason?: string;
}

export type GuideEvidenceMutationRequest =
  | GuideEvidenceSuggestRequest
  | GuideEvidenceConfirmRequest
  | GuideEvidenceRejectRequest
  | GuideEvidenceWithdrawRequest;

export interface GuideEvidenceMutationResponse {
  observation_id: string;
  /** 操作后的容器修订号 */
  revision: number;
  /** 操作后的全部关联（含工作流状态） */
  links: EvidenceLinkView[];
  /** 非阻断提示；AI 关联失败时为 ai_link_failed */
  notice?: EvidenceNotice;
}

/**
 * 观察确认接口的指南扩展：归档观察与选中关联在同一确认事务中协调生效。
 * 未归档请求（如需要教师澄清）不应用决定，返回 status=deferred，由客户端在最终归档请求中重试。
 * 请求内决定与观察归档同为全有或全无；失败时整个确认失败，观察保持未归档。
 */
export interface ObservationConfirmGuideExtension {
  guide_decisions?: {
    expected_guide_revision: number;
    decisions: GuideEvidenceDecisionInput[];
  };
}

export interface ObservationConfirmGuideResult {
  guideEvidence?: {
    status: "applied" | "deferred";
    revision?: number;
    links?: EvidenceLinkView[];
  };
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
  /** 批量决定失败时定位具体关联或条目 */
  link_id?: string;
  item_id?: string;
}
