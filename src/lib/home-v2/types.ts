/**
 * 首页 v2 展示 DTO（AUTH0-R1 返修候选）。
 *
 * 首页是**服务端已按身份与范围裁剪后的展示数据**，不是“全园数据 + 前端过滤”：
 * - 未登录 / 教师 / 管理员 / 身份服务不可用四种状态由服务端判定；
 * - DTO 不包含密码、密码哈希、会话令牌、CSRF 令牌，也不包含无权查看的班级与观察；
 * - 身份服务不可用时 fail closed：不渲染任何全园数据，只给出重试提示；
 * - 可操作待办只包含当前具有教学操作权限的记录；原班历史只读记录不进入待办与待确认计数；
 * - `null` 一律表示“未获取/读取失败”，与真实零值 `0` 严格区分。
 *
 * 冻结文件归属见 `docs/auth-v1/contract.md` 与 `docs/auth-v1/ownership.md`。
 * 本文件只定义展示结构，不实现数据装配，不改动现有首页代码。
 */

import type { ClassStage, ObservationStatus } from "@/lib/types";

/* -------------------------------- 观察者状态 -------------------------------- */

export const HOME_VIEWER_KINDS = [
  "logged_out",
  "teacher",
  "admin",
  "identity_unavailable",
] as const;
export type HomeViewerKind = (typeof HOME_VIEWER_KINDS)[number];

/**
 * 首页观察者：角色与姓名来自服务端会话解析。
 * - logged_out：未登录，不加载任何园所数据；
 * - teacher：教师，数据仅限其当前任教班级与当前负责幼儿；
 * - admin：管理员，数据为全园范围（只读；管理员无教学操作权限）；
 * - identity_unavailable：身份/权限服务不可用（503 语义），fail closed。
 */
export type HomeViewer =
  | { kind: "logged_out" }
  | { kind: "teacher"; display_name: string }
  | { kind: "admin"; display_name: string }
  | { kind: "identity_unavailable" };

/* -------------------------------- 范围摘要 -------------------------------- */

export interface HomeScopeSummary {
  kind: "school" | "classes" | "none";
  label: string;
  /** 范围内班级数；null=未获取（读取失败），不是 0；classes 空数组时为真实 0 */
  class_count: number | null;
  /** 范围内幼儿数（服务端按范围统计）；null=未获取，不是 0 */
  child_count: number | null;
}

/* ------------------------------ 学段班级组 ------------------------------ */

export interface HomeClassSummary {
  class_id: string;
  name: string;
  stage: ClassStage;
  school_year: string;
  is_active: boolean;
  /** 当前在班幼儿数；null=未获取 */
  child_count: number | null;
  /** 待教师确认（ai_organized）；null=未获取 */
  confirmation_count: number | null;
  /** 待补充信息（needs_input）；null=未获取 */
  supplement_count: number | null;
  /** 待 AI 整理（draft）；null=未获取 */
  organize_count: number | null;
}

/** 班级按学段分组展示；组内与组间顺序固定为小班→中班→大班 */
export const HOME_CLASS_STAGE_ORDER = ["small", "middle", "large"] as const;

export interface HomeStageClassGroup {
  stage: ClassStage;
  stage_label: string;
  classes: HomeClassSummary[];
}

/* -------------------------------- 主要行动 -------------------------------- */

/**
 * 单一主行动，固定优先级：
 * 待确认 → 待补充 → 待整理 → 建档 / 新记录。
 * 教师未分配班级只提供“等待分配”，不提供创建班级捷径（建班是管理员动作）。
 */
export const HOME_PRIMARY_ACTION_CODES = [
  "login",
  "process_confirmations",
  "supplement_observation",
  "organize_draft",
  "create_class",
  "create_profile",
  "start_observation",
  "await_class_assignment",
  "manage_school",
  "retry",
] as const;
export type HomePrimaryActionCode = (typeof HOME_PRIMARY_ACTION_CODES)[number];

export interface HomePrimaryAction {
  code: HomePrimaryActionCode;
  label: string;
  href: string;
  helper: string;
}

/* ------------------------------ 待办数量 ------------------------------ */

/**
 * 可操作待办数量：只统计当前具有教学操作权限的记录；
 * 原班历史只读记录不计入。三个状态数量不可混用。
 * null=未获取（读取失败），0=真实零值；两者不得混淆。
 */
export interface HomePendingCounts {
  availability: "available" | "unavailable";
  confirmations: number | null;
  supplements: number | null;
  organizes: number | null;
}

/* ------------------------------ 观察摘要 ------------------------------ */

/**
 * 首页观察摘要：只含展示所需字段。
 * - child_name=null 表示档案不可用或无权查看，显式表达，不用占位文案伪造；
 * - class_id / class_label / stage 保留观察**发生时**班级（当前负责幼儿的转入前历史同样保留原班）；
 * - 只有 excerpt（服务端截断），不携带 raw_text 原文。
 */
export interface HomeObservationSummary {
  observation_id: string;
  child_id: string;
  child_name: string | null;
  class_id: string | null;
  class_label: string | null;
  stage: ClassStage | null;
  observed_at: string;
  created_at: string;
  context: string | null;
  excerpt: string;
  status: ObservationStatus;
  is_demo: boolean;
}

/* -------------------------------- 提示 -------------------------------- */

export const HOME_NOTICE_CODES = [
  "identity_unavailable",
  "scope_empty",
  "data_unavailable",
  "empty_classes",
  "empty_children",
  "empty_observations",
  "legacy_client_state_pending_cleanup",
] as const;
export type HomeNoticeCode = (typeof HOME_NOTICE_CODES)[number];

export interface HomeNotice {
  code: HomeNoticeCode;
  severity: "info" | "warning" | "error";
  message: string;
}

/* -------------------------------- 首页 DTO -------------------------------- */

export interface HomeV2Data {
  viewer: HomeViewer;
  /** 未登录或身份不可用时为 null，不返回全园范围 */
  scope: HomeScopeSummary | null;
  /** 按学段分组的可见班级；未登录/身份不可用/空范围时为空数组，不返回全园班级 */
  class_groups: HomeStageClassGroup[];
  primary_action: HomePrimaryAction;
  /** 可操作待办数量；与 pending 列表一致，均不含历史只读记录 */
  pending_counts: HomePendingCounts;
  /** 仅含当前具有教学操作权限的记录；无权限的历史只读入口留在班级历史页面 */
  pending: HomeObservationSummary[];
  recent: HomeObservationSummary[];
  notices: HomeNotice[];
}

/** 首页顶层状态：与 HomeViewer.kind 一一对应，便于页面分支 */
export type HomeV2State = HomeViewerKind;
