/**
 * 首页 v2 展示 DTO（AUTH0 冻结）。
 *
 * 首页是**服务端已按身份与范围裁剪后的展示数据**，不是“全园数据 + 前端过滤”：
 * - 未登录 / 教师 / 管理员 / 身份服务不可用四种状态由服务端判定；
 * - DTO 不包含密码、密码哈希、会话令牌、CSRF 令牌，也不包含无权查看的班级与观察；
 * - 身份服务不可用时 fail closed：不渲染任何全园数据，只给出重试提示。
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
 * - teacher：教师，数据仅限其当前任教班级；
 * - admin：管理员，数据为全园范围；
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
  /** 范围内班级数；classes 空数组时为 0，绝不表示全园 */
  class_count: number;
  /** 范围内幼儿数（服务端按范围统计） */
  child_count: number;
}

/* ------------------------------ 学段班级组 ------------------------------ */

export interface HomeClassSummary {
  class_id: string;
  name: string;
  stage: ClassStage;
  school_year: string;
  is_active: boolean;
  /** 当前在班幼儿数 */
  child_count: number;
  /** 未确认观察数（draft / needs_input / ai_organized） */
  pending_count: number;
  /** 待教师确认数（ai_organized） */
  confirmation_count: number;
}

/** 班级按学段分组展示；组内与组间顺序固定为小班→中班→大班 */
export const HOME_CLASS_STAGE_ORDER = ["small", "middle", "large"] as const;

export interface HomeStageClassGroup {
  stage: ClassStage;
  stage_label: string;
  classes: HomeClassSummary[];
}

/* -------------------------------- 主要行动 -------------------------------- */

export const HOME_PRIMARY_ACTION_CODES = [
  "login",
  "process_confirmations",
  "supplement_observation",
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

/* ------------------------------ 观察摘要 ------------------------------ */

/**
 * 首页观察摘要：只含展示所需字段。
 * - child_name=null 表示档案不可用或无权查看，显式表达，不用占位文案伪造；
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
  "school_data_unavailable",
  "empty_classes",
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
  pending_count: number;
  pending: HomeObservationSummary[];
  recent: HomeObservationSummary[];
  notices: HomeNotice[];
}

/** 首页顶层状态：与 HomeViewer.kind 一一对应，便于页面分支 */
export type HomeV2State = HomeViewerKind;
