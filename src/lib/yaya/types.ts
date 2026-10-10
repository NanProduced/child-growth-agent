/**
 * 芽芽助手 v1 共享核心契约（整合冻结版 yaya-v1.0）。
 *
 * 核心口径已冻结；reference_only 仅表示这些纯函数检查不证明真实认证或事务实现。
 * - 不实现认证、会话、数据库、对象存储、模型调用、聊天 UI 与迁移。
 * - 正式开发与归属见 docs/yaya-v1/contract-v1.md / development-plan.md。
 * - 授权事实始终来自服务端 AUTH 契约；本模块只读引用并复用
 *   `authorizeAction` / `isLegalAccessCombination` / `modelWaitPremiseChanged`，
 *   不维护第二套角色权限。
 *
 * R1 修正：
 * 1. 批准绑定保存批准时/执行时的服务端资源事实与逐项身份；复用 AUTH 授权与
 *    归属前提比较，同权转班（A→B 仍在范围）也失效；非法组合先拒绝。
 * 2. 批准必须来自经认证、CSRF 保护的入口记录；请求体/模型自报的
 *    origin=teacher_action、approved=true 一律不是证明。
 * 3. 聊天正文/附件按多来源与 full/historical_read_only 投影；未知/损坏/服务不可用
 *    不默认 full；标题与摘要另行投影。
 * 4. 回执汇总对照预期条目清单；operation_id 预分配；区分进行中/失败/冲突/
 *    已保存/详情不可读/未知；多观察批次逐项，同一观察内指南决定仍全有或全无。
 * 5. 图片引用保护覆盖全部观察状态；引用查询不完整不物理删除；挂到业务记录后
 *    按记录投影读取，不裸 image_id 放行、不只凭上传者身份否定。
 * 6. 领域 payload 无损复用真实 `ConfirmObservationInput` / `GuideEvidenceMutationRequest`，
 *    organize/follow-up 表达真实参数；候选选择必须属于已核验候选。
 */

import {
  authorizeAction,
  isLegalAccessCombination,
  modelWaitPremiseChanged,
} from "../accounts/authorize";
import type {
  AccessAction,
  AccessDecision,
  AccessResource,
  AccessResourceKind,
  AccountRole,
  Principal,
} from "../accounts/types";
import type { GuideEvidenceMutationRequest } from "../guide/view-types";
import type { FollowUpAction, ObservationStatus } from "../types";
import type { ConfirmObservationInput } from "../validation";

/** 契约检查输出标志：只证明草案内部自洽，不证明运行时守门通过 */
export const YAYA_CONTRACT_STATUS = "reference_only" as const;

/** Core semantics are frozen for development, not certified for production. */
export const YAYA_CONTRACT_FROZEN = true as const;
export const YAYA_CONTRACT_VERSION = "yaya-v1.0" as const;

/** 已保存 raw_text 永不改写 */
export const YAYA_RAW_TEXT_IS_IMMUTABLE = true as const;

/* ------------------------------- 工具覆盖模型 ------------------------------- */

/** 阶段：read=明确意图只读直查；prepare=产生草稿/待核对准备态；commit=正式业务写，必须教师批准 */
export const YAYA_TOOL_PHASES = ["read", "prepare", "commit"] as const;
export type YayaToolPhase = (typeof YAYA_TOOL_PHASES)[number];

/**
 * 工具授权引用：
 * - action：与 AUTH 契约的动作/资源组合一致的单对象操作；
 * - scope_query：按当前会话范围裁剪的列表/目录读，不经过单对象 action 授权。
 */
export type YayaToolAuth =
  | { kind: "action"; action: AccessAction; resource: AccessResourceKind }
  | { kind: "scope_query" };

/**
 * 范围策略：
 * - business_scope：园所私有列表/详情，空任教范围返回 403 empty_scope，绝不等于全园；
 * - authenticated_reference：登录即可用的公开教育参考（如指南目录），不含园所私域数据。
 * 两者不得混成同一空范围策略。
 */
export const YAYA_TOOL_SCOPE_POLICIES = ["business_scope", "authenticated_reference"] as const;
export type YayaToolScopePolicy = (typeof YAYA_TOOL_SCOPE_POLICIES)[number];

/** 区分平台现有功能与助手新增内部能力（内部能力不得伪装成业务功能） */
export const YAYA_COVERAGE_ORIGINS = ["platform_feature", "assistant_internal"] as const;
export type YayaCoverageOrigin = (typeof YAYA_COVERAGE_ORIGINS)[number];

/**
 * 工具覆盖登记项。只允许登记真实存在的功能：
 * `coverage_origin=platform_feature` 必须 `implemented=true`（不登记假功能）；
 * `assistant_internal`（本轮提案、尚未实现）可为 false。
 */
export interface YayaToolCoverage {
  tool_id: string;
  entry: string;
  service: string;
  auth: YayaToolAuth;
  phase: YayaToolPhase;
  scope_policy: YayaToolScopePolicy;
  coverage_origin: YayaCoverageOrigin;
  secret_input: "none" | "secure_control";
  implemented: boolean;
}

/** 组合合法性：复用 AUTH `isLegalAccessCombination`，不另立一套 */
export function isLegalToolCombination(auth: YayaToolAuth): boolean {
  if (auth.kind === "scope_query") return true;
  return isLegalAccessCombination(auth.action, auth.resource);
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
  readonly kind: YayaProvenanceKind;
  readonly ref_id: string | null;
  readonly label: string | null;
  /**
   * 派生来源：图像解读/模型文本等必须记录派生自哪个素材/观察；
   * 教师直接输入为 null。来源标签由服务端管线赋值，不靠改标签提升来源等级。
   */
  readonly derived_from: string | null;
}

/** 只有已保存观察事实可以支撑正式指南证据；图像解读/模型文本/公开网页都不行 */
export function isFormalEvidenceKind(kind: YayaProvenanceKind): boolean {
  return kind === "child_fact";
}

/** 只有未派生的教师原输入能成为观察 raw_text；图像解读不得冒充原文 */
export function mayBecomeObservationRawText(source: YayaSourceRef): boolean {
  return source.kind === "raw_input" && source.derived_from === null;
}

/**
 * 依据来源引用：类别标签只能标来源，不能独自证明确认、真实性或版本有效。
 * 正式依据必须来自已确认观察且带来源确认时间（版本一致由 G0/G5 再核）。
 */
export interface YayaEvidenceBasisRef {
  source_kind: YayaProvenanceKind;
  observation_status: ObservationStatus;
  source_confirmed_at: string | null;
}

export function basisIsFormalEvidence(basis: YayaEvidenceBasisRef): boolean {
  return (
    basis.source_kind === "child_fact" &&
    basis.observation_status === "confirmed" &&
    basis.source_confirmed_at !== null
  );
}

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

export interface YayaImageObservationRef {
  observation_id: string;
  status: ObservationStatus;
}

/**
 * 图片引用事实。引用保护覆盖 draft/needs_input/ai_organized/confirmed 全部已保存观察、
 * 消息与提案；`reference_query_complete=false`（引用查询不完整/不可用）时禁止物理删除。
 */
export interface YayaImageLifecycleFacts {
  image_id: string;
  reference_query_complete: boolean;
  observation_refs: readonly YayaImageObservationRef[];
  message_refs: readonly { conversation_id: string; message_id: string }[];
  proposal_refs: readonly string[];
}

export type YayaImageRetention =
  | "retain_business_reference"
  | "retain_other_conversations"
  | "retain_unknown_references"
  | "deletable_with_conversation";

/** 删除某个会话时该图片的保留结论；未引用对象的回收策略与仍被引用对象分开 */
export function decideImageRetention(
  facts: YayaImageLifecycleFacts,
  deletingConversationId: string
): YayaImageRetention {
  if (!facts.reference_query_complete) return "retain_unknown_references";
  if (facts.observation_refs.length > 0 || facts.proposal_refs.length > 0) {
    return "retain_business_reference";
  }
  if (facts.message_refs.some((ref) => ref.conversation_id !== deletingConversationId)) {
    return "retain_other_conversations";
  }
  return "deletable_with_conversation";
}

/** 物理清空只允许在引用查询完整且无任何有效引用时进行 */
export function mayPurgeImage(facts: YayaImageLifecycleFacts): boolean {
  return (
    facts.reference_query_complete &&
    facts.observation_refs.length === 0 &&
    facts.proposal_refs.length === 0 &&
    facts.message_refs.length === 0
  );
}

export interface YayaImageBusinessRef {
  record_kind: "observation" | "proposal";
  record_id: string;
}

export interface YayaImageViewerRecordAccess {
  record_kind: "observation" | "proposal";
  record_id: string;
  projection: "full" | "historical_read_only";
}

export interface YayaImageReadFacts {
  image_id: string;
  uploader_account_id: string;
  attached_records: readonly YayaImageBusinessRef[];
}

export type YayaImageReadDecision =
  | { readable: true; via: "business_record"; projection: "full" }
  | { readable: true; via: "uploader_private" }
  | {
      readable: false;
      metadata_only: boolean;
      reason:
        | "historical_metadata_only"
        | "attached_but_no_record_access"
        | "not_attached_and_not_uploader";
    };

/**
 * 图片读取投影（与聊天附件投影同一口径）：
 * - 已挂到业务记录：按 `record_kind + record_id` 完整匹配合法引用与投影读取，
 *   不裸 image_id 放行，也不只凭上传者身份否定其他合法业务读取；
 * - historical_read_only 只返回元数据，**不可读图片字节/预览 URL**；
 * - full 才是真正可读；
 * - 多引用时取最佳可用投影（full 优先于 historical），结果与遍历顺序无关；
 * - 未关联素材：仅上传者本人可读（账号私有）；未知/缺失授权一律拒绝。
 */
export function decideImageReadAccess(
  facts: YayaImageReadFacts,
  viewer: { account_id: string; record_access: readonly YayaImageViewerRecordAccess[] }
): YayaImageReadDecision {
  if (facts.attached_records.length > 0) {
    const projections: ("full" | "historical_read_only")[] = [];
    for (const record of facts.attached_records) {
      for (const access of viewer.record_access) {
        if (access.record_kind === record.record_kind && access.record_id === record.record_id) {
          projections.push(access.projection);
        }
      }
    }
    if (projections.includes("full")) {
      return { readable: true, via: "business_record", projection: "full" };
    }
    if (projections.includes("historical_read_only")) {
      return { readable: false, metadata_only: true, reason: "historical_metadata_only" };
    }
    return { readable: false, metadata_only: false, reason: "attached_but_no_record_access" };
  }
  if (viewer.account_id === facts.uploader_account_id) {
    return { readable: true, via: "uploader_private" };
  }
  return { readable: false, metadata_only: false, reason: "not_attached_and_not_uploader" };
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
  /** 候选快照修订号；执行前必须与当前服务端修订一致，否则重新核验 */
  snapshot_revision: string;
}

export type YayaCandidateResolution =
  | { resolved: true; candidate: YayaCandidateRef | null }
  | {
      resolved: false;
      reason: "selection_required" | "not_in_candidates" | "kind_mismatch" | "stale_candidates";
    };

/**
 * 候选解析：selected_id 必须属于当前已核验候选且类型匹配；
 * 不在列表中的 id（如 child-z）不得 resolved；快照过期时执行前重新核验。
 */
export function resolveCandidateSelection(
  selection: YayaCandidateSelection,
  expectedKind: YayaCandidateRef["candidate_kind"],
  currentRevision: string
): YayaCandidateResolution {
  if (selection.snapshot_revision !== currentRevision) {
    return { resolved: false, reason: "stale_candidates" };
  }
  if (selection.selected_id === null) {
    return selection.required
      ? { resolved: false, reason: "selection_required" }
      : { resolved: true, candidate: null };
  }
  const candidate = selection.candidates.find(
    (entry) => entry.candidate_id === selection.selected_id
  );
  if (candidate === undefined) return { resolved: false, reason: "not_in_candidates" };
  if (candidate.candidate_kind !== expectedKind) return { resolved: false, reason: "kind_mismatch" };
  return { resolved: true, candidate };
}

/* ------------------------------- 领域 payload ------------------------------- */

export const YAYA_PAYLOAD_KINDS = [
  "create_observation",
  "organize_observation",
  "follow_up_observation",
  "confirm_observation",
  "guide_decision",
  "create_child",
  "transfer_child",
  "manage_class",
  "manage_teacher",
  "refresh_growth_profile",
  "refresh_activity_support",
  "attach_observation_images",
] as const;
export type YayaPayloadKind = (typeof YAYA_PAYLOAD_KINDS)[number];

/**
 * 多人拆分的追溯关系：一条群体输入拆成逐人事实后，
 * 仍保留原输入、逐人事实与教师补充的来源引用，防止 AI 概括替换原文或把群体事实复制给每个人。
 */
export interface YayaMultiChildTrace {
  group_input_id: string;
  original_source: YayaSourceRef;
  child_facts: readonly {
    item_key: string;
    child_id: string;
    fact_source: YayaSourceRef;
  }[];
  teacher_supplement_sources: readonly YayaSourceRef[];
}

/**
 * 领域 payload 判别联合（不是任意 JSON 执行器）：
 * - 每个 kind 由 TOOLS1 用各自 Zod schema 校验，未列入的 kind 不执行；
 * - **没有任何 approved 字段**；批准只来自 `YayaApprovalBinding`（服务端记录）；
 * - 密码字段不存在：`manage_teacher` 的密码由安全控件直接提交服务端；
 * - 确认归档与指南决定无损复用真实 `ConfirmObservationInput` / `GuideEvidenceMutationRequest`。
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
      /** 多人拆分追溯；未拆分时为 null */
      source_input: YayaMultiChildTrace | null;
    }
  | { kind: "organize_observation"; observation_id: string }
  | {
      kind: "follow_up_observation";
      observation_id: string;
      action: FollowUpAction;
      content: string;
    }
  | {
      kind: "confirm_observation";
      observation_id: string;
      /** 复用现有确认输入：content / teacher_note / clarification / guide_decisions 全量保留 */
      input: ConfirmObservationInput;
    }
  | {
      kind: "guide_decision";
      observation_id: string;
      /** 复用现有 G5 mutation：suggest/confirm/reject/withdraw 与全部决定字段 */
      mutation: GuideEvidenceMutationRequest;
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
  | { kind: "refresh_activity_support"; child_id: string }
  | {
      /** Teacher-approved attachment append; never changes raw_text/confirmed_content. */
      kind: "attach_observation_images";
      observation_id: string;
      image_ids: readonly string[];
      expected_attachment_revision: number;
      source_confirmed_at: string | null;
    };

/**
 * 同一宿主观察内的指南决定与归档是 G0/G5 的“全有或全无”事务；
 * 跨幼儿多观察批次按条逐项提交与逐项回执。两者不得混用汇总语义。
 */
export const YAYA_ALL_OR_NOTHING_PAYLOAD_KINDS = [
  "confirm_observation",
  "guide_decision",
  "attach_observation_images",
] as const;

export function payloadIsAllOrNothing(kind: YayaPayloadKind): boolean {
  return (YAYA_ALL_OR_NOTHING_PAYLOAD_KINDS as readonly string[]).includes(kind);
}

export interface YayaProposalItem {
  item_key: string;
  target_id: string | null;
  content_digest: string;
  attachment_associations: readonly YayaAttachmentAssociation[];
  payload: YayaDomainPayload;
}

export interface YayaOperationProposal {
  proposal_id: string;
  batch_id: string;
  proposal_origin: "teacher_card" | "model_suggestion";
  auth: YayaToolAuth;
  items: readonly YayaProposalItem[];
  prepared_at: string;
}

/* ----------------------------- 批准绑定与执行 ----------------------------- */

/** 附件与业务目标的关联；比较按“附件 → 目标”完整多元组，重复 ID 不能绕过 */
export interface YayaAttachmentAssociation {
  attachment_id: string;
  target_id: string;
}

/** 批准时保存的逐项身份与服务端资源事实快照 */
export interface YayaApprovalItemRef {
  item_key: string;
  operation_id: string;
  action: AccessAction;
  resource: AccessResourceKind;
  target_id: string;
  resource_facts_at_approval: AccessResource;
  content_digest: string;
  attachment_associations: readonly YayaAttachmentAssociation[];
  business_revision: string | null;
}

/**
 * 批准绑定（服务端记录）。
 * - `proposal_origin` 只记录提案来源（模型或教师卡片），不得改写用来掩盖来源；
 *   模型提案同样可以执行，只要存在真实教师批准。
 * - `approval_source` 必须是 `authenticated_entry`：经认证、CSRF 保护的教师入口写入；
 *   请求体自报、模型输出或仅本地 runtime 的 approved 状态都不是批准证明。
 * - 绑定 actor/原始 session、逐项 action/resource/target/operation_id、
 *   批准时资源事实、内容摘要、附件关联、业务版本与生命周期。
 *
 * 批准身份（approval_id，一次人工批准动作）与执行幂等身份（operation_id，一次执行）
 * 不是同一概念：同一个批准可以对应一个 operation_id 的一次执行；原操作结果未知时
 * 只能按原 operation_id 查询，不能新建操作重新执行。
 */
export interface YayaApprovalBinding {
  approval_id: string;
  batch_id: string;
  proposal_id: string;
  proposal_origin: "teacher_card" | "model_suggestion";
  approval_source: "authenticated_entry" | "request_body_claim" | "model_output";
  actor_account_id: string;
  session_id: string;
  items: readonly YayaApprovalItemRef[];
  approved_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
}

/** 执行请求上由服务端解析的身份与会话；模型/客户端不能自报 */
export interface YayaApprovalSubmitter {
  identity_state: "authenticated" | "unauthenticated" | "unavailable";
  principal: Principal | null;
  session_id: string | null;
  session_valid: boolean;
  csrf_verified: boolean;
  /** 仅本地 runtime 的 approved 状态；不参与判定，只用于拒绝自报来源的场景说明 */
  runtime_approved_state: boolean;
  execution_at: string;
}

/** 执行时重新读取的逐项服务端资源事实 */
export interface YayaApprovalItemExecution {
  item_key: string;
  operation_id: string;
  resource_facts: AccessResource;
  content_digest: string;
  attachment_associations: readonly YayaAttachmentAssociation[];
  business_revision: string | null;
}

export const YAYA_APPROVAL_INVALID_REASONS = [
  "untrusted_approval_source",
  "csrf_not_verified",
  "unauthenticated",
  "identity_unavailable",
  "actor_changed",
  "session_changed",
  "session_invalid",
  "account_disabled",
  "approval_cancelled",
  "approval_expired",
  "duplicate_item",
  "missing_item",
  "unexpected_item",
  "operation_id_mismatch",
  "resource_kind_mismatch",
  "illegal_combination",
  "role_not_allowed",
  "out_of_scope",
  "empty_scope",
  "target_changed",
  "attribution_changed",
  "content_changed",
  "attachments_changed",
  "duplicate_attachment",
  "business_version_changed",
] as const;
export type YayaApprovalInvalidReason = (typeof YAYA_APPROVAL_INVALID_REASONS)[number];

export type YayaApprovalCheck =
  | { ok: true }
  | { ok: false; reasons: readonly YayaApprovalInvalidReason[] };

/** 资源的目标业务对象 id（school/class/child/transfer/observation） */
export function resourceTargetId(resource: AccessResource): string {
  switch (resource.kind) {
    case "school":
      return resource.school_id;
    case "class":
      return resource.class_id;
    case "child":
      return resource.child_id;
    case "transfer":
      return resource.child_id;
    case "observation":
      return resource.observation_id;
  }
}

function accessDecisionReason(decision: AccessDecision): YayaApprovalInvalidReason | null {
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

export type YayaAttachmentComparison =
  | { equal: true }
  | { equal: false; reason: "duplicate" | "mismatch" };

/** 附件关联按 (attachment_id, target_id) 多元组比较；重复 ID 直接判不相等 */
export function compareAttachmentAssociations(
  binding: readonly YayaAttachmentAssociation[],
  current: readonly YayaAttachmentAssociation[]
): YayaAttachmentComparison {
  if (new Set(binding.map((entry) => entry.attachment_id)).size !== binding.length) {
    return { equal: false, reason: "duplicate" };
  }
  if (new Set(current.map((entry) => entry.attachment_id)).size !== current.length) {
    return { equal: false, reason: "duplicate" };
  }
  if (binding.length !== current.length) return { equal: false, reason: "mismatch" };
  const currentByAttachment = new Map(
    current.map((entry) => [entry.attachment_id, entry.target_id] as const)
  );
  for (const entry of binding) {
    if (currentByAttachment.get(entry.attachment_id) !== entry.target_id) {
      return { equal: false, reason: "mismatch" };
    }
  }
  return { equal: true };
}

/**
 * 批准执行判定（纯参考算法）：
 * - 只信任服务端批准记录与批准原 session；CSRF、身份、生命周期先校验；
 *   模型提案（proposal_origin=model_suggestion）不因来源被拒绝，但必须有可信批准；
 *   本地 runtime approved 状态、请求体自报、模型输出都不构成批准。
 * - 逐项身份完整匹配（item_key + operation_id + target + resource kind），缺项/重复/多出都拒绝；
 * - 先组合合法性，再复用 `authorizeAction`（管理员教学动作、教师管理动作都会正确拒绝）；
 * - 复用 `modelWaitPremiseChanged` 比较批准时与执行时的服务端归属事实：
 *   同一教师仍拥有新旧两班权限时，幼儿已转班也判 `attribution_changed`；
 * - 内容摘要、附件关联、业务版本一致才可执行；与本操作无关的权限变化不影响判定。
 */
export function evaluateApprovalExecution(
  binding: YayaApprovalBinding,
  submitter: YayaApprovalSubmitter,
  items: readonly YayaApprovalItemExecution[]
): YayaApprovalCheck {
  const reasons: YayaApprovalInvalidReason[] = [];
  if (binding.approval_source !== "authenticated_entry") {
    reasons.push("untrusted_approval_source");
  }
  if (!submitter.csrf_verified) {
    reasons.push("csrf_not_verified");
  }
  if (binding.cancelled_at !== null) {
    reasons.push("approval_cancelled");
  }
  if (binding.expires_at !== null && submitter.execution_at >= binding.expires_at) {
    reasons.push("approval_expired");
  }
  if (submitter.identity_state === "unavailable") {
    reasons.push("identity_unavailable");
  } else if (submitter.identity_state === "unauthenticated" || submitter.principal === null) {
    reasons.push("unauthenticated");
  }
  if (submitter.session_id === null || submitter.session_id !== binding.session_id) {
    reasons.push("session_changed");
  }
  if (!submitter.session_valid) {
    reasons.push("session_invalid");
  }
  const principal = submitter.principal;
  if (principal !== null && principal.account_id !== binding.actor_account_id) {
    reasons.push("actor_changed");
  }

  const bindingKeys = new Set<string>();
  const bindingOperationIds = new Set<string>();
  for (const item of binding.items) {
    if (bindingKeys.has(item.item_key) || bindingOperationIds.has(item.operation_id)) {
      reasons.push("duplicate_item");
    }
    bindingKeys.add(item.item_key);
    bindingOperationIds.add(item.operation_id);
  }

  const executedByItemKey = new Map<string, YayaApprovalItemExecution>();
  for (const item of items) {
    if (executedByItemKey.has(item.item_key)) {
      reasons.push("duplicate_item");
      continue;
    }
    executedByItemKey.set(item.item_key, item);
  }

  for (const item of binding.items) {
    const execution = executedByItemKey.get(item.item_key);
    if (execution === undefined) {
      reasons.push("missing_item");
      continue;
    }
    if (execution.operation_id !== item.operation_id) {
      reasons.push("operation_id_mismatch");
    }
    if (execution.resource_facts.kind !== item.resource) {
      reasons.push("resource_kind_mismatch");
      continue;
    }
    if (resourceTargetId(execution.resource_facts) !== item.target_id) {
      reasons.push("target_changed");
    }
    if (!isLegalAccessCombination(item.action, item.resource)) {
      reasons.push("illegal_combination");
      continue;
    }
    if (principal !== null) {
      const reason = accessDecisionReason(
        authorizeAction(principal, item.action, execution.resource_facts)
      );
      if (reason !== null) reasons.push(reason);
    }
    if (modelWaitPremiseChanged(item.resource_facts_at_approval, execution.resource_facts)) {
      reasons.push("attribution_changed");
    }
    if (item.content_digest !== execution.content_digest) {
      reasons.push("content_changed");
    }
    const attachment = compareAttachmentAssociations(
      item.attachment_associations,
      execution.attachment_associations
    );
    if (!attachment.equal) {
      reasons.push(
        attachment.reason === "duplicate" ? "duplicate_attachment" : "attachments_changed"
      );
    }
    if (item.business_revision !== execution.business_revision) {
      reasons.push("business_version_changed");
    }
  }

  for (const itemKey of executedByItemKey.keys()) {
    if (!bindingKeys.has(itemKey)) reasons.push("unexpected_item");
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/* ------------------------------- 回执与幂等 ------------------------------- */

export const YAYA_RECEIPT_STATUSES = [
  "in_progress",
  "saved",
  "saved_detail_unavailable",
  "unchanged",
  "failed",
  "conflict",
  "needs_verification",
] as const;
export type YayaReceiptStatus = (typeof YAYA_RECEIPT_STATUSES)[number];

/** 失败效果：none=确认无已提交效果（可重发）；committed=已产生效果；unknown=不确定 */
export const YAYA_RECEIPT_EFFECTS = ["none", "committed", "unknown"] as const;
export type YayaReceiptEffect = (typeof YAYA_RECEIPT_EFFECTS)[number];

/**
 * 操作身份在可能写入之前建立并可由客户端持有：
 * 批次 ID（batch_id）标识一次多条目提交；每条目有独立 operation_id。
 * 请求丢失后客户端凭 operation_id 查询原操作，不重新生成。
 */
export interface YayaPlannedOperation {
  batch_id: string;
  proposal_id: string;
  item_key: string;
  operation_id: string;
  target_id: string;
  actor_account_id: string;
}

export interface YayaOperationReceipt {
  batch_id: string;
  proposal_id: string;
  item_key: string;
  operation_id: string;
  target_id: string;
  actor_account_id: string;
  status: YayaReceiptStatus;
  effect: YayaReceiptEffect;
  business_object_id: string | null;
  business_revision: string | null;
  recorded_at: string;
}

/**
 * 成功必须同时具备：合法状态/效果组合 + 该操作必需的业务标识。
 * - saved / saved_detail_unavailable / unchanged：`effect=committed` 且 `business_object_id` 非空；
 * - `effect=unknown`、缺业务标识或状态/效果不匹配一律不算成功（unknown 效果不能成为确定成功）。
 */
export function receiptProvesSuccess(receipt: YayaOperationReceipt): boolean {
  if (typeof receipt.business_object_id !== "string" || receipt.business_object_id.trim().length === 0) return false;
  if (receipt.effect !== "committed") return false;
  return (
    receipt.status === "saved" ||
    receipt.status === "saved_detail_unavailable" ||
    receipt.status === "unchanged"
  );
}

/** 只有“明确失败且确认无已提交效果”才可重发；其余只能查询或重新批准 */
export function receiptCanBeResent(receipt: YayaOperationReceipt): boolean {
  return receipt.status === "failed" && receipt.effect === "none";
}

export interface YayaBatchComparison {
  expected: number;
  received: number;
  /** 预期清单本身不合法（重复 operation_id / 重复 item_key），必须先修正计划 */
  duplicate_plan_operation_ids: readonly string[];
  duplicate_plan_item_keys: readonly string[];
  missing_operation_ids: readonly string[];
  unexpected_operation_ids: readonly string[];
  /** 同一 operation_id 收到多余回执（即使内容相同也单独表达） */
  duplicate_operation_ids: readonly string[];
  contradictory_operation_ids: readonly string[];
  /** 声称成功但缺少完整证明（效果未知/缺业务标识）的条目 */
  unverified_success_operation_ids: readonly string[];
  saved: number;
  failed: number;
  conflict: number;
  in_progress: number;
  needs_verification: number;
  all_saved: boolean;
}

function receiptIdentifiesPlan(
  receipt: YayaOperationReceipt,
  planned: YayaPlannedOperation
): boolean {
  return (
    receipt.item_key === planned.item_key &&
    receipt.target_id === planned.target_id &&
    receipt.proposal_id === planned.proposal_id &&
    receipt.batch_id === planned.batch_id &&
    receipt.actor_account_id === planned.actor_account_id
  );
}

/** 同一操作的重复回执是否表达同一业务结果（合法幂等重放 vs 矛盾） */
function receiptSameResult(a: YayaOperationReceipt, b: YayaOperationReceipt): boolean {
  return (
    a.status === b.status &&
    a.effect === b.effect &&
    a.business_object_id === b.business_object_id &&
    a.business_revision === b.business_revision
  );
}

function receiptGroupIsIdentical(group: readonly YayaOperationReceipt[]): boolean {
  const first = group[0];
  if (first === undefined) return true;
  return group.every((receipt) => receiptSameResult(receipt, first));
}

/**
 * 回执汇总对照预期条目清单（不是只数收到的回执）：
 * - 汇总前核验预期清单的唯一性（重复 operation_id / item_key 直接判计划不合法）；
 * - 身份不匹配的回执进入 `unexpected`，不参与任何状态统计；
 * - 成功统计只统计已核验且证明完整的条目；`effect=unknown`/缺业务标识进入
 *   `unverified_success_operation_ids`，不得计入 saved；
 * - 缺项、多出、重复回执、矛盾回执、未验证成功都使 `all_saved=false`；
 * - 完全相同且身份一致的重复回执按同一结果处理（合法幂等重放），但仍单独表达。
 */
export function compareBatchReceipts(
  plan: readonly YayaPlannedOperation[],
  receipts: readonly YayaOperationReceipt[]
): YayaBatchComparison {
  const duplicatePlanOperations: string[] = [];
  const duplicatePlanItems: string[] = [];
  const seenOperations = new Set<string>();
  const seenItems = new Set<string>();
  for (const item of plan) {
    if (seenOperations.has(item.operation_id)) duplicatePlanOperations.push(item.operation_id);
    seenOperations.add(item.operation_id);
    if (seenItems.has(item.item_key)) duplicatePlanItems.push(item.item_key);
    seenItems.add(item.item_key);
  }
  const planByOperationId = new Map<string, YayaPlannedOperation>();
  for (const item of plan) {
    if (!planByOperationId.has(item.operation_id)) planByOperationId.set(item.operation_id, item);
  }

  const receiptsByOperationId = new Map<string, YayaOperationReceipt[]>();
  for (const receipt of receipts) {
    const list = receiptsByOperationId.get(receipt.operation_id);
    if (list === undefined) receiptsByOperationId.set(receipt.operation_id, [receipt]);
    else list.push(receipt);
  }

  const missing: string[] = [];
  const unexpected: string[] = [];
  const duplicate: string[] = [];
  const contradictory: string[] = [];
  const unverifiedSuccess: string[] = [];
  const matched = new Set<string>();
  let saved = 0;
  let failed = 0;
  let conflict = 0;
  let inProgress = 0;
  let needsVerification = 0;

  for (const [operationId, group] of receiptsByOperationId) {
    const planned = planByOperationId.get(operationId);
    if (planned === undefined || !group.every((receipt) => receiptIdentifiesPlan(receipt, planned))) {
      unexpected.push(operationId);
      continue;
    }
    matched.add(operationId);
    if (group.length > 1) duplicate.push(operationId);
    if (!receiptGroupIsIdentical(group)) {
      contradictory.push(operationId);
      continue;
    }
    const representative = group[0];
    if (representative === undefined) continue;
    switch (representative.status) {
      case "saved":
      case "saved_detail_unavailable":
      case "unchanged":
        if (receiptProvesSuccess(representative)) saved += 1;
        else unverifiedSuccess.push(operationId);
        break;
      case "failed":
        failed += 1;
        break;
      case "conflict":
        conflict += 1;
        break;
      case "in_progress":
        inProgress += 1;
        break;
      case "needs_verification":
        needsVerification += 1;
        break;
    }
  }
  for (const operationId of planByOperationId.keys()) {
    if (!matched.has(operationId)) missing.push(operationId);
  }

  const all_saved =
    plan.length > 0 &&
    duplicatePlanOperations.length === 0 &&
    duplicatePlanItems.length === 0 &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    duplicate.length === 0 &&
    contradictory.length === 0 &&
    unverifiedSuccess.length === 0 &&
    plan.every((item) => {
      const group = receiptsByOperationId.get(item.operation_id);
      return (
        group !== undefined &&
        group.length === 1 &&
        group[0] !== undefined &&
        receiptProvesSuccess(group[0])
      );
    });

  return {
    expected: plan.length,
    received: receipts.length,
    duplicate_plan_operation_ids: duplicatePlanOperations,
    duplicate_plan_item_keys: duplicatePlanItems,
    missing_operation_ids: missing,
    unexpected_operation_ids: unexpected,
    duplicate_operation_ids: duplicate,
    contradictory_operation_ids: contradictory,
    unverified_success_operation_ids: unverifiedSuccess,
    saved,
    failed,
    conflict,
    in_progress: inProgress,
    needs_verification: needsVerification,
    all_saved,
  };
}

/**
 * 授权回执查询语义：缺少回执或业务状态暂时未变都不能证明未写入。
 * 返回：进行中 / 确定失败（含效果）/ 冲突 / 已保存（详情不可读单独表达）/ 未知。
 */
export type YayaOperationQueryOutcome =
  | { kind: "in_progress" }
  | { kind: "failed"; effect: YayaReceiptEffect }
  | { kind: "conflict" }
  | { kind: "saved"; receipt: YayaOperationReceipt }
  | { kind: "saved_detail_unavailable"; receipt: YayaOperationReceipt }
  | {
      kind: "unknown";
      reason:
        | "no_receipt"
        | "identity_mismatch"
        | "contradictory_receipts"
        | "invalid_success_proof"
        | "verification_required";
    };

/**
 * 原操作查询：必须携带预分配的完整身份（operation_id + batch/proposal/item/target/actor）。
 * - 只按原 operation_id 查询，不新建操作重新执行（批准身份 ≠ 执行幂等身份）；
 * - 身份不匹配、业务结果矛盾、成功证明不完整都返回 unknown，不任选第一条；
 * - 完全相同的重复回执（合法幂等重放）视为同一结果；`unchanged` 保留合法幂等语义，
 *   不要求 revision 必须递增。
 */
export function queryOperationOutcome(
  receipts: readonly YayaOperationReceipt[],
  expected: YayaPlannedOperation
): YayaOperationQueryOutcome {
  const matches = receipts.filter((receipt) => receipt.operation_id === expected.operation_id);
  const first = matches[0];
  if (first === undefined) return { kind: "unknown", reason: "no_receipt" };
  if (!matches.every((receipt) => receiptIdentifiesPlan(receipt, expected))) {
    return { kind: "unknown", reason: "identity_mismatch" };
  }
  if (!matches.every((receipt) => receiptSameResult(receipt, first))) {
    return { kind: "unknown", reason: "contradictory_receipts" };
  }
  switch (first.status) {
    case "in_progress":
      return { kind: "in_progress" };
    case "failed":
      return { kind: "failed", effect: first.effect };
    case "conflict":
      return { kind: "conflict" };
    case "saved":
    case "unchanged":
      return receiptProvesSuccess(first)
        ? { kind: "saved", receipt: first }
        : { kind: "unknown", reason: "invalid_success_proof" };
    case "saved_detail_unavailable":
      return receiptProvesSuccess(first)
        ? { kind: "saved_detail_unavailable", receipt: first }
        : { kind: "unknown", reason: "invalid_success_proof" };
    case "needs_verification":
      return { kind: "unknown", reason: "verification_required" };
  }
}

export function itemsToResend(
  plan: readonly YayaPlannedOperation[],
  receipts: readonly YayaOperationReceipt[]
): readonly YayaOperationReceipt[] {
  const comparison = compareBatchReceipts(plan, receipts);
  if (comparison.duplicate_plan_operation_ids.length > 0 || comparison.duplicate_plan_item_keys.length > 0) {
    return [];
  }
  // A candidate permits explicit recovery, never automatic replay of a business POST.
  // ponytail: small bounded batches; index receipts if the batch limit grows.
  return plan.flatMap((expected) => {
    const outcome = queryOperationOutcome(receipts, expected);
    if (outcome.kind !== "failed" || outcome.effect !== "none") return [];
    const receipt = receipts.find((entry) => entry.operation_id === expected.operation_id);
    return receipt === undefined ? [] : [receipt];
  });
}

/* ------------------------------- 会话与投影 ------------------------------- */

/**
 * 消息正文引用的业务来源。消息可能同时引用班级、幼儿、观察与附件；
 * 投影按每个来源用现有授权动作核验（child.read / class.read / observation.read 等）。
 */
export type YayaMessageSourceRef =
  | { kind: "image"; image_id: string }
  | { kind: "child"; child_id: string; current_class_id: string | null }
  | { kind: "class"; class_id: string }
  | {
      kind: "observation";
      observation_id: string;
      child_id: string;
      current_class_id: string | null;
      observed_class_id: string | null;
    };

export type YayaSourceAccess =
  | "full"
  | "historical_read_only"
  | "denied"
  | "unavailable"
  | "broken";

/** 服务端按当前授权解析出的来源投影；缺失的解析结果按未知保守处理 */
export interface YayaEvaluatedSource {
  fragment_id: string;
  source_index: number;
  access: YayaSourceAccess;
}

export interface YayaMessageFragmentRef {
  fragment_id: string;
  sources: readonly YayaMessageSourceRef[];
  /** 服务端标记：该片段正文可在不泄漏受限来源的前提下独立展示 */
  independently_readable: boolean;
}

export interface YayaChatMessageRef {
  message_id: string;
  owner_account_id: string;
  session_id: string;
  created_at: string | null;
  message_kind: "text" | "image" | "tool_result" | "receipt" | "mixed";
  execution_state: "none" | "pending_approval" | "executed" | "unknown";
  fragments: readonly YayaMessageFragmentRef[];
  attachment_ids: readonly string[];
}

export interface YayaChatViewer {
  account_id: string;
  role: AccountRole;
}

export interface YayaEvaluatedAttachment {
  attachment_id: string;
  access: YayaSourceAccess;
}

/** 允许保留的元数据白名单：不含正文事实、标题、搜索摘要或来源标签 */
export interface YayaChatMetadataView {
  created_at: string | null;
  message_kind: YayaChatMessageRef["message_kind"];
  fragment_count: number;
  has_attachments: boolean;
  execution_state: YayaChatMessageRef["execution_state"];
}

export interface YayaFragmentProjection {
  fragment_id: string;
  visibility: "full" | "historical_read_only" | "hidden";
  reason:
    | "ok"
    | "owner_mismatch"
    | "source_denied"
    | "source_unavailable"
    | "source_broken"
    | "evaluation_missing";
}

export interface YayaAttachmentProjection {
  attachment_id: string;
  readable: boolean;
  metadata_only: boolean;
  reason:
    | "ok"
    | "metadata_only_historical"
    | "source_denied"
    | "source_unavailable"
    | "source_broken"
    | "evaluation_missing";
}

export interface YayaChatMessageProjection {
  visibility: "full" | "partial" | "metadata_only" | "hidden" | "unavailable";
  fragments: readonly YayaFragmentProjection[];
  attachments: readonly YayaAttachmentProjection[];
  metadata: YayaChatMetadataView | null;
  execution_allowed: false;
}

function projectFragment(
  fragment: YayaMessageFragmentRef,
  evaluatedSources: readonly YayaEvaluatedSource[]
): YayaFragmentProjection {
  const accesses: YayaSourceAccess[] = [];
  for (let index = 0; index < fragment.sources.length; index += 1) {
    const evaluation = evaluatedSources.find(
      (entry) => entry.fragment_id === fragment.fragment_id && entry.source_index === index
    );
    if (evaluation === undefined) {
      return { fragment_id: fragment.fragment_id, visibility: "hidden", reason: "evaluation_missing" };
    }
    accesses.push(evaluation.access);
  }
  if (accesses.length === 0) {
    return { fragment_id: fragment.fragment_id, visibility: "full", reason: "ok" };
  }
  if (accesses.some((access) => access === "broken")) {
    return { fragment_id: fragment.fragment_id, visibility: "hidden", reason: "source_broken" };
  }
  if (accesses.some((access) => access === "unavailable")) {
    return { fragment_id: fragment.fragment_id, visibility: "hidden", reason: "source_unavailable" };
  }
  if (accesses.some((access) => access === "denied")) {
    const readable = accesses.filter(
      (access) => access === "full" || access === "historical_read_only"
    );
    if (fragment.independently_readable && readable.length > 0) {
      return {
        fragment_id: fragment.fragment_id,
        visibility: readable.includes("historical_read_only") ? "historical_read_only" : "full",
        reason: "ok",
      };
    }
    return { fragment_id: fragment.fragment_id, visibility: "hidden", reason: "source_denied" };
  }
  if (accesses.some((access) => access === "historical_read_only")) {
    return { fragment_id: fragment.fragment_id, visibility: "historical_read_only", reason: "ok" };
  }
  return { fragment_id: fragment.fragment_id, visibility: "full", reason: "ok" };
}

function projectAttachment(
  attachmentId: string,
  evaluatedAttachments: readonly YayaEvaluatedAttachment[]
): YayaAttachmentProjection {
  const evaluation = evaluatedAttachments.find((entry) => entry.attachment_id === attachmentId);
  if (evaluation === undefined) {
    return { attachment_id: attachmentId, readable: false, metadata_only: true, reason: "evaluation_missing" };
  }
  switch (evaluation.access) {
    case "full":
      return { attachment_id: attachmentId, readable: true, metadata_only: false, reason: "ok" };
    case "historical_read_only":
      return {
        attachment_id: attachmentId,
        readable: false,
        metadata_only: true,
        reason: "metadata_only_historical",
      };
    case "denied":
      return { attachment_id: attachmentId, readable: false, metadata_only: false, reason: "source_denied" };
    case "unavailable":
      return { attachment_id: attachmentId, readable: false, metadata_only: false, reason: "source_unavailable" };
    case "broken":
      return { attachment_id: attachmentId, readable: false, metadata_only: false, reason: "source_broken" };
  }
}

/**
 * 消息正文与附件的服务端可执行投影（不是前端隐藏）：
 * - 会话账号私有是第一条边界：非本人（含同班教师、管理员）一律 hidden；
 * - 业务来源授权是第二条边界：逐来源核验 full / historical_read_only / denied /
 *   unavailable / broken，部分可核验的独立片段可保留，无法安全拆分的正文保守受限；
 * - 历史正文、预览、附件与发给模型的上下文都走当前授权投影；
 * - 未知来源、损坏关联、权限服务不可用不默认 full；执行仍需新的批准。
 */
export function projectChatMessage(
  message: YayaChatMessageRef,
  viewer: YayaChatViewer,
  evaluatedSources: readonly YayaEvaluatedSource[],
  evaluatedAttachments: readonly YayaEvaluatedAttachment[]
): YayaChatMessageProjection {
  if (message.owner_account_id !== viewer.account_id) {
    return {
      visibility: "hidden",
      fragments: message.fragments.map((fragment) => ({
        fragment_id: fragment.fragment_id,
        visibility: "hidden",
        reason: "owner_mismatch" as const,
      })),
      attachments: message.attachment_ids.map((attachmentId) => ({
        attachment_id: attachmentId,
        readable: false,
        metadata_only: false,
        reason: "source_denied" as const,
      })),
      metadata: null,
      execution_allowed: false,
    };
  }

  const fragments = message.fragments.map((fragment) =>
    projectFragment(fragment, evaluatedSources)
  );
  const attachments = message.attachment_ids.map((attachmentId) =>
    projectAttachment(attachmentId, evaluatedAttachments)
  );
  const visibleFragments = fragments.filter((fragment) => fragment.visibility !== "hidden");

  let visibility: YayaChatMessageProjection["visibility"];
  if (message.fragments.length === 0) {
    visibility = "full";
  } else if (visibleFragments.length === message.fragments.length) {
    visibility = visibleFragments.every((fragment) => fragment.visibility === "full")
      ? "full"
      : "partial";
  } else if (visibleFragments.length > 0) {
    visibility = "partial";
  } else {
    const reasons = new Set(fragments.map((fragment) => fragment.reason));
    visibility =
      reasons.has("source_unavailable") || reasons.has("evaluation_missing")
        ? "unavailable"
        : "hidden";
  }
  if (visibility === "full" && attachments.some((attachment) => !attachment.readable)) {
    visibility = "partial";
  }
  if (visibility === "full" && attachments.length > 0 && attachments.every((a) => a.metadata_only)) {
    visibility = "metadata_only";
  }

  return {
    visibility,
    fragments,
    attachments,
    metadata: {
      created_at: message.created_at,
      message_kind: message.message_kind,
      fragment_count: message.fragments.length,
      has_attachments: message.attachment_ids.length > 0,
      execution_state: message.execution_state,
    },
    execution_allowed: false,
  };
}

export interface YayaConversationTitleRef {
  title: string;
  derived_from_fragment_ids: readonly string[];
}

/** 会话标题/搜索摘要不得成为受限事实泄漏旁路：来源片段非 full 时用通用标题 */
export function projectConversationTitle(
  titleRef: YayaConversationTitleRef,
  fragmentProjections: readonly YayaFragmentProjection[],
  fallback = "受限会话"
): { title: string; restricted: boolean } {
  const restricted = titleRef.derived_from_fragment_ids.some((fragmentId) => {
    const projection = fragmentProjections.find((entry) => entry.fragment_id === fragmentId);
    return projection === undefined || projection.visibility !== "full";
  });
  return restricted ? { title: fallback, restricted: true } : { title: titleRef.title, restricted: false };
}

/* ------------------------------- 检索与问答 ------------------------------- */

/** 通用幼教问答不需要业务对象；只有业务工具才要求目标 */
export function requiresBusinessTarget(auth: YayaToolAuth | null): boolean {
  // Authorization is independent of object selection; lists/catalogs use server scope.
  // Concrete required parameters are still defined by each tool's schema.
  return auth?.kind === "action";
}

export type YayaChildIdentifierScan = "known_absent" | "present" | "unknown";

export interface YayaPublicSearchPolicyInput {
  provider_enabled: boolean;
  /** 服务端扫描结论；模型自报布尔值不参与判定 */
  child_identifier_scan: YayaChildIdentifierScan;
  server_redaction_applied: boolean;
}

export type YayaPublicSearchDecision =
  | { allowed: true }
  | { allowed: false; reason: "provider_disabled" | "identifiers_present" | "scan_unknown_conservative" };

/**
 * 公开检索服务端约束：仅服务端扫描确认无幼儿识别信息（known_absent）才放行；
 * present/unknown 一律拒绝（未知保守），客户端/模型自报不算。参考检查不实现去识别算法。
 */
export function decidePublicSearch(
  input: YayaPublicSearchPolicyInput
): YayaPublicSearchDecision {
  if (!input.provider_enabled) return { allowed: false, reason: "provider_disabled" };
  if (input.child_identifier_scan === "present") {
    return { allowed: false, reason: "identifiers_present" };
  }
  if (input.child_identifier_scan === "unknown") {
    return { allowed: false, reason: "scan_unknown_conservative" };
  }
  return { allowed: true };
}
