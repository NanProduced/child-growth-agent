/**
 * 芽芽助手 v1 契约草案共享类型（YAYA0-CONTRACT）。
 *
 * 状态：reference_only（仅类型与纯函数，无运行时实现，不得当作接口冻结）。
 * - 不实现认证、会话、数据库、对象存储、模型调用、聊天 UI 与迁移。
 * - 与 TECH0 协议能力（SDK 工具循环、runtime 附件/历史、图片存储、公开检索）相关的内容
 *   一律 provisional；TECH0 结论交付并由主评审确认前，不得自称最终冻结或可实现。
 * - 授权事实始终来自服务端 AUTH 契约；本模块只读引用 `src/lib/accounts/types.ts` 的冻结定义，
 *   不修改、不复制、不扩权。任何工具调用仍须经过服务端 `runBusinessWrite`/`withBusinessRead`。
 *
 * 设计边界：
 * - 不提供万能任意 JSON 执行器；领域 payload 用判别联合表达，且不含任何 approved/密码字段。
 * - 批准是教师动作产生的一次性绑定，模型输出的 approved 字段不构成批准。
 * - 回执与业务写必须同一事务协调；模型等待不持锁。
 */

import {
  ACTION_RESOURCE_KINDS,
  TEACHING_ACCESS_ACTIONS,
  type AccessAction,
  type AccessResourceKind,
  type AccountRole,
} from "../accounts/types";

/** 契约检查输出标志：只证明草案内部自洽，不证明运行时守门通过 */
export const YAYA_CONTRACT_STATUS = "reference_only" as const;

/** TECH0 未交付前不得声称冻结 */
export const YAYA_CONTRACT_FROZEN = false as const;

/* ------------------------------- 工具覆盖模型 ------------------------------- */

/** 阶段：read=明确意图只读直查；prepare=产生草稿/待核对准备态；commit=正式业务写，必须教师批准 */
export const YAYA_TOOL_PHASES = ["read", "prepare", "commit"] as const;
export type YayaToolPhase = (typeof YAYA_TOOL_PHASES)[number];

/**
 * 工具授权引用：
 * - action：与 AUTH 契约的动作/资源组合一致的单对象操作；
 * - scope_query：按当前会话范围裁剪的列表/目录读，不经过单对象 action 授权，
 *   空任教范围返回 403 empty_scope，绝不等于全园。
 */
export type YayaToolAuth =
  | { kind: "action"; action: AccessAction; resource: AccessResourceKind }
  | { kind: "scope_query" };

/**
 * 工具覆盖登记项。只允许登记真实存在的功能：
 * `implemented` 固定为字面量 true，未实现功能无法通过类型检查进入覆盖表。
 */
export interface YayaToolCoverage {
  tool_id: string;
  entry: string;
  service: string;
  auth: YayaToolAuth;
  phase: YayaToolPhase;
  secret_input: "none" | "secure_control";
  implemented: true;
}

/** 组合合法性：非法组合不得登记（服务端返回 400 illegal_action_resource_combination） */
export function isLegalToolCombination(auth: YayaToolAuth): boolean {
  if (auth.kind === "scope_query") return true;
  const allowed = ACTION_RESOURCE_KINDS[auth.action] as readonly AccessResourceKind[];
  return allowed.includes(auth.resource);
}

/** 角色上限：管理员对教学动作一律 403 forbidden_role；教师是否可做仍取决于服务端范围 */
export function roleCanUseTool(role: AccountRole, auth: YayaToolAuth): boolean {
  if (role === "admin" && auth.kind === "action") {
    return !(TEACHING_ACCESS_ACTIONS as readonly AccessAction[]).includes(auth.action);
  }
  return true;
}

/* ---------------------------------- 范围 ---------------------------------- */

/** 与 AUTH `DataScope` 同构的聊天执行投影；classes 空数组是明确为空，绝不是全园 */
export type YayaScope =
  | { kind: "school" }
  | { kind: "classes"; class_ids: readonly string[] }
  | { kind: "none" };

export function scopeFromClassIds(classIds: readonly string[]): YayaScope {
  return classIds.length === 0 ? { kind: "none" } : { kind: "classes", class_ids: [...classIds] };
}

export function scopeIsSchoolWide(scope: YayaScope): boolean {
  return scope.kind === "school";
}

/* ------------------------------- 出处与来源 ------------------------------- */

export const YAYA_PROVENANCE_KINDS = [
  "raw_input", // 保存前的教师原输入（表单/聊天文本、上传图片本身）
  "child_fact", // 已保存观察 raw_text 中的事实
  "teacher_supplement", // 教师补充/澄清
  "image_interpretation", // 图像解读
  "guide_catalog", // 指南目录静态参考（教育参考，不是证据）
  "public_web", // 公开检索结果
  "tool_result", // 平台工具结果
  "model_text", // 模型生成文本
] as const;
export type YayaProvenanceKind = (typeof YAYA_PROVENANCE_KINDS)[number];

export interface YayaSourceRef {
  kind: YayaProvenanceKind;
  ref_id: string | null;
  label: string | null;
}

/** 只有已保存观察事实可以支撑正式指南证据；图像解读/模型文本/公开网页都不行 */
export function isFormalEvidenceKind(kind: YayaProvenanceKind): boolean {
  return kind === "child_fact";
}

/** 只有教师原输入能成为观察 raw_text；图像解读不得冒充原文 */
export function mayBecomeObservationRawText(kind: YayaProvenanceKind): boolean {
  return kind === "raw_input";
}

/** 已保存 raw_text 永不改写 */
export const YAYA_RAW_TEXT_IS_IMMUTABLE = true as const;

/** 不可信数据信封：原文/图片/网页/工具结果只能作为数据，不能当作系统指令 */
export interface YayaUntrustedEnvelope<T> {
  untrusted: true;
  provenance: YayaSourceRef;
  content: T;
}

/* ---------------------------------- 图片 ---------------------------------- */

export interface YayaImageRef {
  image_id: string;
  source: YayaSourceRef;
  attached_observation_ids: readonly string[];
}

/** 图片生命周期事实：聊天删除与档案引用分离，不允许按桶前缀清空 */
export interface YayaImageLifecycleFacts {
  image_id: string;
  referenced_by_archived_records: boolean;
  referenced_by_chat_messages: boolean;
}

export function mayDeleteImageWithChat(facts: YayaImageLifecycleFacts): boolean {
  return !facts.referenced_by_archived_records;
}

export function mayPurgeImage(facts: YayaImageLifecycleFacts): boolean {
  return !facts.referenced_by_archived_records && !facts.referenced_by_chat_messages;
}

/* -------------------------------- 候选选择 -------------------------------- */

export interface YayaCandidateRef {
  candidate_kind: "child" | "class" | "observation" | "guide_item";
  candidate_id: string;
  label: string;
}

export interface YayaCandidateSelection {
  required: boolean;
  candidates: readonly YayaCandidateRef[];
  selected_id: string | null;
}

export function selectionIsResolved(selection: YayaCandidateSelection): boolean {
  return !selection.required || selection.selected_id !== null;
}

/* ------------------------------- 领域 payload ------------------------------- */

export const YAYA_PAYLOAD_KINDS = [
  "create_observation",
  "confirm_observation",
  "guide_decision",
  "create_child",
  "transfer_child",
  "manage_class",
  "manage_teacher",
  "refresh_growth_profile",
  "refresh_activity_support",
] as const;
export type YayaPayloadKind = (typeof YAYA_PAYLOAD_KINDS)[number];

/**
 * 领域 payload 判别联合（不是任意 JSON 执行器）：
 * - 每个 kind 由 TOOLS1 用各自 Zod schema 校验，未列入的 kind 不执行；
 * - **没有任何 approved 字段**；批准只来自 `YayaApprovalBinding`（教师动作）；
 * - 密码字段不存在：`manage_teacher` 的密码由安全控件直接提交服务端，模型与聊天不接触。
 */
export type YayaDomainPayload =
  | {
      kind: "create_observation";
      child_id: string;
      observed_at: string;
      raw_text: string;
      context: string | null;
      confirmed_class_id: string | null;
      image_ids: readonly string[];
    }
  | {
      kind: "confirm_observation";
      observation_id: string;
      teacher_note: string | null;
      guide_decision_count: number;
    }
  | {
      kind: "guide_decision";
      observation_id: string;
      decision: "confirm" | "reject" | "withdraw";
      target_link_id: string | null;
      target_item_id: string | null;
    }
  | {
      kind: "create_child";
      name: string;
      gender: "男" | "女" | "其他";
      birth_date: string;
      target_class_id: string;
      note: string | null;
    }
  | {
      kind: "transfer_child";
      child_id: string;
      target_class_id: string;
      effective_date: string | null;
    }
  | {
      kind: "manage_class";
      operation: "create" | "update";
      class_id: string | null;
      name: string;
      stage: "small" | "middle" | "large";
      school_year: string;
      is_active: boolean | null;
    }
  | {
      kind: "manage_teacher";
      operation: "create" | "set_status" | "reset_password" | "assign_class" | "remove_assignment";
      teacher_account_id: string | null;
      username: string | null;
      display_name: string | null;
      class_ids: readonly string[];
      status: "active" | "disabled" | null;
      secret_via_secure_control: true;
    }
  | { kind: "refresh_growth_profile"; child_id: string }
  | { kind: "refresh_activity_support"; child_id: string };

export interface YayaProposalItem {
  item_key: string;
  target_id: string | null;
  content_digest: string;
  attachment_refs: readonly string[];
  payload: YayaDomainPayload;
}

export interface YayaOperationProposal {
  proposal_id: string;
  origin: "teacher_card" | "model_suggestion";
  auth: YayaToolAuth;
  items: readonly YayaProposalItem[];
  prepared_at: string;
}

/* ----------------------------- 批准绑定与失效 ----------------------------- */

export interface YayaApprovalBinding {
  approval_id: string;
  proposal_id: string;
  operation_id: string;
  origin: "teacher_action" | "model_suggestion";
  actor_account_id: string;
  session_id: string;
  auth: YayaToolAuth;
  target_id: string | null;
  item_keys: readonly string[];
  content_digest: string;
  attachment_refs: readonly string[];
  business_revision: string | null;
  approved_at: string;
  cancelled: boolean;
}

export interface YayaApprovalContext {
  origin: "teacher_action" | "model_suggestion";
  actor_account_id: string | null;
  session_id: string | null;
  session_valid: boolean;
  account_active: boolean;
  role: AccountRole | null;
  scope: YayaScope;
  /** 服务端读取的绑定目标当前归属事实（child/observation=当前班级；class=该班本身；transfer=转班前归属） */
  target_current_class_id: string | null;
  content_digest: string;
  attachment_refs: readonly string[];
  business_revision: string | null;
}

export const YAYA_APPROVAL_INVALID_REASONS = [
  "model_approval_not_binding",
  "approval_cancelled",
  "actor_changed",
  "session_changed",
  "session_invalid",
  "account_disabled",
  "role_not_allowed",
  "empty_scope",
  "scope_changed",
  "content_changed",
  "attachments_changed",
  "business_version_changed",
] as const;
export type YayaApprovalInvalidReason = (typeof YAYA_APPROVAL_INVALID_REASONS)[number];

export type YayaApprovalCheck =
  | { ok: true }
  | { ok: false; reasons: readonly YayaApprovalInvalidReason[] };

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}

/**
 * 批准复用判定（纯参考算法）：
 * actor/原始 session/角色上限/当前范围/内容摘要/附件集合/业务版本必须全部一致；
 * 修改内容、转班撤权、换登录会话、取消批准、模型自带的 approved 一律失效。
 */
export function evaluateApprovalReuse(
  binding: YayaApprovalBinding,
  current: YayaApprovalContext
): YayaApprovalCheck {
  const reasons: YayaApprovalInvalidReason[] = [];
  if (binding.origin !== "teacher_action" || current.origin !== "teacher_action") {
    reasons.push("model_approval_not_binding");
  }
  if (binding.cancelled) {
    reasons.push("approval_cancelled");
  }
  if (current.actor_account_id === null || current.actor_account_id !== binding.actor_account_id) {
    reasons.push("actor_changed");
  }
  if (current.session_id === null || current.session_id !== binding.session_id) {
    reasons.push("session_changed");
  }
  if (!current.session_valid) {
    reasons.push("session_invalid");
  }
  if (!current.account_active) {
    reasons.push("account_disabled");
  }
  if (current.role === null || !roleCanUseTool(current.role, binding.auth)) {
    reasons.push("role_not_allowed");
  }
  if (current.scope.kind === "none") {
    reasons.push("empty_scope");
    reasons.push("scope_changed");
  } else if (current.scope.kind === "classes") {
    if (
      current.target_current_class_id === null ||
      !current.scope.class_ids.includes(current.target_current_class_id)
    ) {
      reasons.push("scope_changed");
    }
  }
  if (current.content_digest !== binding.content_digest) {
    reasons.push("content_changed");
  }
  if (!sameStringSet(current.attachment_refs, binding.attachment_refs)) {
    reasons.push("attachments_changed");
  }
  if (current.business_revision !== binding.business_revision) {
    reasons.push("business_version_changed");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/* ------------------------------- 回执与幂等 ------------------------------- */

export const YAYA_RECEIPT_STATUSES = [
  "saved",
  "unchanged",
  "failed",
  "conflict",
  "needs_verification",
] as const;
export type YayaReceiptStatus = (typeof YAYA_RECEIPT_STATUSES)[number];

export interface YayaOperationReceipt {
  operation_id: string;
  proposal_id: string;
  item_key: string;
  target_id: string | null;
  status: YayaReceiptStatus;
  business_object_id: string | null;
  business_revision: string | null;
  recorded_at: string;
}

export function receiptClaimsSuccess(status: YayaReceiptStatus): boolean {
  return status === "saved" || status === "unchanged";
}

/** 只有明确失败才允许重发；conflict 需刷新前提，needs_verification 只能回读，成功项永不重发 */
export function receiptCanBeResent(status: YayaReceiptStatus): boolean {
  return status === "failed";
}

export function receiptForItem(
  receipts: readonly YayaOperationReceipt[],
  itemKey: string
): YayaOperationReceipt | null {
  return receipts.find((receipt) => receipt.item_key === itemKey) ?? null;
}

export function receiptForOperation(
  receipts: readonly YayaOperationReceipt[],
  operationId: string
): YayaOperationReceipt | null {
  return receipts.find((receipt) => receipt.operation_id === operationId) ?? null;
}

export interface YayaBatchItemPlan {
  item_key: string;
  target_id: string | null;
}

/** 逐项核对：回执必须与条目的 item_key 和目标同时匹配，防止两人事实串档 */
export function receiptMatchesItem(
  receipt: YayaOperationReceipt,
  plan: YayaBatchItemPlan
): boolean {
  return receipt.item_key === plan.item_key && receipt.target_id === plan.target_id;
}

export type YayaUnresolvedResolution =
  | { kind: "replay_receipt"; receipt: YayaOperationReceipt }
  | { kind: "needs_verification" };

/** 响应丢失/超时后：有回执按回执幂等重放；无回执一律待核对，绝不假装成功 */
export function resolveUnresolvedOperation(
  receipts: readonly YayaOperationReceipt[],
  operationId: string
): YayaUnresolvedResolution {
  const receipt = receiptForOperation(receipts, operationId);
  return receipt
    ? { kind: "replay_receipt", receipt }
    : { kind: "needs_verification" };
}

export interface YayaBatchSummary {
  total: number;
  saved: number;
  failed: number;
  conflict: number;
  needs_verification: number;
  all_saved: boolean;
}

/** 批量逐项汇总：不假装全有或全无；all_saved 仅当每一项都成功 */
export function summarizeReceipts(
  receipts: readonly YayaOperationReceipt[]
): YayaBatchSummary {
  const count = (status: YayaReceiptStatus) =>
    receipts.filter((receipt) => receipt.status === status).length;
  return {
    total: receipts.length,
    saved: count("saved") + count("unchanged"),
    failed: count("failed"),
    conflict: count("conflict"),
    needs_verification: count("needs_verification"),
    all_saved: receipts.length > 0 && receipts.every((receipt) => receiptClaimsSuccess(receipt.status)),
  };
}

export function itemsToResend(
  receipts: readonly YayaOperationReceipt[]
): readonly YayaOperationReceipt[] {
  return receipts.filter((receipt) => receiptCanBeResent(receipt.status));
}

/* ------------------------------- 会话与投影 ------------------------------- */

export interface YayaChatMessageRef {
  message_id: string;
  owner_account_id: string;
  session_id: string;
  target_child_id: string | null;
  target_class_id: string | null;
  attachment_refs: readonly string[];
}

export interface YayaChatViewer {
  account_id: string;
  role: AccountRole;
  scope: YayaScope;
  /** 服务端按当前归属与任教关系解析的可达幼儿集合；空集合不等于全园 */
  reachable_child_ids: readonly string[];
}

export type YayaMessageVisibility = "full" | "metadata_only" | "hidden";

export interface YayaChatMessageProjection {
  visibility: YayaMessageVisibility;
  body_facts_readable: boolean;
  attachments_readable: boolean;
  execution_allowed: boolean;
}

/**
 * 聊天正文与附件的服务端可执行投影（不是前端隐藏）：
 * - 同班教师也不共享私有会话；
 * - 撤权/转班后，引用已不可达幼儿的消息降为仅元数据，正文事实与附件不可读，也不能执行；
 * - 执行仍需当前有效身份与新的批准。
 */
export function projectChatMessage(
  message: YayaChatMessageRef,
  viewer: YayaChatViewer
): YayaChatMessageProjection {
  if (message.owner_account_id !== viewer.account_id) {
    return {
      visibility: "hidden",
      body_facts_readable: false,
      attachments_readable: false,
      execution_allowed: false,
    };
  }
  const childOutOfScope =
    message.target_child_id !== null &&
    !viewer.reachable_child_ids.includes(message.target_child_id);
  if (childOutOfScope) {
    return {
      visibility: "metadata_only",
      body_facts_readable: false,
      attachments_readable: false,
      execution_allowed: false,
    };
  }
  return {
    visibility: "full",
    body_facts_readable: true,
    attachments_readable: true,
    execution_allowed: false,
  };
}

/* ------------------------------- 范围与会话规则 ------------------------------- */

/** 通用幼教问答不需要业务对象；只有业务工具才要求目标 */
export function requiresBusinessTarget(auth: YayaToolAuth | null): boolean {
  return auth !== null;
}

/** 公开检索不得携带幼儿识别信息（姓名/照片/原始观察等） */
export function publicSearchQueryAllowed(query: { has_child_identifiers: boolean }): boolean {
  return !query.has_child_identifiers;
}
