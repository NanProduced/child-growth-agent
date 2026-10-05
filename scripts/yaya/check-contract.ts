/**
 * YAYA0-CONTRACT-R1 离线参考检查（reference_only）。
 *
 * 只读取契约类型与纯函数，验证草案内部自洽：
 * - 不连接数据库、不调用模型、不访问对象存储、不启动浏览器、不修改任何业务数据；
 * - 通过不等于运行时守门通过，不能替代 AUTH/事务/模型的真实验收。
 *
 * RED→GREEN：新增反例先在 3248c2d 草案上运行（8 项失败，见 docs/yaya-v1/contract-draft.md 附录），
 * 修复后原 26 个有效场景全部保留并通过。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-contract.ts
 */

import assert from "node:assert/strict";

import { authorizeAction } from "../../src/lib/accounts/authorize";
import type { AccessResource, Principal } from "../../src/lib/accounts/types";
import type { GuideEvidenceMutationRequest } from "../../src/lib/guide/view-types";
import type { ConfirmObservationInput } from "../../src/lib/validation";
import {
  basisIsFormalEvidence,
  compareAttachmentAssociations,
  compareBatchReceipts,
  decideImageReadAccess,
  decideImageRetention,
  decidePublicSearch,
  evaluateApprovalExecution,
  isFormalEvidenceKind,
  isLegalToolCombination,
  itemsToResend,
  mayBecomeObservationRawText,
  mayPurgeImage,
  payloadIsAllOrNothing,
  projectChatMessage,
  projectConversationTitle,
  queryOperationOutcome,
  receiptCanBeResent,
  receiptProvesSuccess,
  requiresBusinessTarget,
  resolveCandidateSelection,
  scopeFromClassIds,
  scopeIsSchoolWide,
  YAYA_CONTRACT_FROZEN,
  YAYA_CONTRACT_STATUS,
  YAYA_PAYLOAD_KINDS,
  YAYA_RAW_TEXT_IS_IMMUTABLE,
  type YayaApprovalBinding,
  type YayaApprovalItemExecution,
  type YayaApprovalItemRef,
  type YayaApprovalSubmitter,
  type YayaChatMessageRef,
  type YayaDomainPayload,
  type YayaEvaluatedAttachment,
  type YayaEvaluatedSource,
  type YayaImageLifecycleFacts,
  type YayaMultiChildTrace,
  type YayaOperationReceipt,
  type YayaPlannedOperation,
  type YayaSourceRef,
  type YayaToolAuth,
  type YayaToolCoverage,
} from "../../src/lib/yaya/types";

/* --------------------------- 工具覆盖参考目录（仅真实入口） --------------------------- */

const TOOLS: readonly YayaToolCoverage[] = [
  {
    tool_id: "query.children",
    entry: "GET /api/children（页面 /children、/observations/new）",
    service: "scopedListChildren",
    auth: { kind: "scope_query" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.classes",
    entry: "GET /api/classes、GET /api/classes?catalog=true（页面 /classes）",
    service: "scopedListClasses",
    auth: { kind: "scope_query" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.class_detail",
    entry: "GET /api/classes/[id]（页面 /classes/[id]）",
    service: "scopedGetClass",
    auth: { kind: "action", action: "class.read", resource: "class" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.child_class_context",
    entry: "GET /api/children/[id]/class-context",
    service: "class-context（enrollment 解析）",
    auth: { kind: "action", action: "child.read", resource: "child" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.observations",
    entry: "GET /api/observations（页面 /observations）",
    service: "scopedListObservations",
    auth: { kind: "scope_query" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.evidence_book",
    entry: "GET /api/children/[id]/evidence-book（页面 /children/[id]/evidence）",
    service: "loadChildEvidenceBook",
    auth: { kind: "action", action: "child.read", resource: "child" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.evidence_overview",
    entry: "GET /api/classes/[id]/evidence-overview（页面 /classes/[id]/evidence）",
    service: "loadClassEvidenceOverview",
    auth: { kind: "action", action: "class.read", resource: "class" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.guide_catalog",
    entry: "证据页内嵌目录（无独立 HTTP 接口）",
    service: "listGuideItems / getGuideItem / listEducationSuggestions",
    auth: { kind: "scope_query" },
    phase: "read",
    scope_policy: "authenticated_reference",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "create_child",
    entry: "POST /api/children（页面 /children/new）",
    service: "createChild",
    auth: { kind: "action", action: "child.create_profile", resource: "class" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "create_observation",
    entry: "POST /api/observations（页面 /observations/new）",
    service: "createObservation",
    auth: { kind: "action", action: "observation.write", resource: "child" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "organize_observation",
    entry: "POST /api/observations/[id]/organize（Review 页）",
    service: "processObservationAgent（写 ai_draft/agent_context）",
    auth: { kind: "action", action: "observation.organize", resource: "observation" },
    phase: "prepare",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "follow_up_observation",
    entry: "POST /api/observations/[id]/follow-up（Review 页）",
    service: "appendFollowUpAction + processObservationAgent",
    auth: { kind: "action", action: "observation.organize", resource: "observation" },
    phase: "prepare",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "confirm_observation",
    entry: "POST /api/observations/[id]/confirm（Review 页归档）",
    service: "confirmObservation（含 guide_decisions 同事务）",
    auth: { kind: "action", action: "observation.confirm", resource: "observation" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "guide_decide",
    entry: "POST /api/observations/[id]/guide-evidence（suggest/confirm/reject/withdraw）",
    service: "applyGuideEvidenceMutation；suggest 走 generateGuideEvidenceSuggestions + saveGuideEvidenceSuggestionResult",
    auth: { kind: "action", action: "guide.decide", resource: "observation" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "refresh_growth_profile",
    entry: "POST /api/children/[id]/growth-profile",
    service: "updateGrowthProfileAfterConfirmation",
    auth: { kind: "action", action: "growth_profile.write", resource: "child" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "refresh_activity_support",
    entry: "POST /api/children/[id]/activity-support",
    service: "updateActivitySupport",
    auth: { kind: "action", action: "activity_support.write", resource: "child" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.create_class",
    entry: "POST /api/classes（页面 /classes）",
    service: "createClass",
    auth: { kind: "action", action: "class.manage", resource: "class" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.update_class",
    entry: "PATCH /api/classes/[id]（页面 /classes/[id]）",
    service: "updateClass",
    auth: { kind: "action", action: "class.manage", resource: "class" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.transfer_child",
    entry: "POST /api/classes/[id]/children（幼儿页转班对话框）",
    service: "enrollChildInClass",
    auth: { kind: "action", action: "child.transfer", resource: "transfer" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_list",
    entry: "GET /api/admin/teachers（页面 /admin/teachers）",
    service: "listTeachers",
    auth: { kind: "action", action: "teacher.manage", resource: "school" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_create",
    entry: "POST /api/admin/teachers（页面 /admin/teachers；密码走安全控件）",
    service: "createTeacherWithAssignments",
    auth: { kind: "action", action: "teacher.manage", resource: "school" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "secure_control",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_set_status",
    entry: "PATCH /api/admin/teachers/[id]（页面 /admin/teachers）",
    service: "setTeacherStatus",
    auth: { kind: "action", action: "teacher.manage", resource: "school" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_password_reset",
    entry: "POST /api/admin/teachers/[id]/password-reset（密码走安全控件）",
    service: "resetTeacherPassword",
    auth: { kind: "action", action: "teacher.manage", resource: "school" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "secure_control",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_assign",
    entry: "POST /api/admin/teachers/[id]/assignments",
    service: "assignTeacherClass",
    auth: { kind: "action", action: "teacher.assign", resource: "class" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_unassign",
    entry: "DELETE /api/admin/teachers/[id]/assignments/[classId]",
    service: "unassignTeacherClass",
    auth: { kind: "action", action: "teacher.assign", resource: "class" },
    phase: "commit",
    scope_policy: "business_scope",
    coverage_origin: "platform_feature",
    secret_input: "none",
    implemented: true,
  },
];

/** 助手新增内部能力（本轮提案，尚未实现；不得伪装成平台业务功能） */
const INTERNAL_CAPABILITIES: readonly YayaToolCoverage[] = [
  {
    tool_id: "internal.receipt_query",
    entry: "GET /api/yaya/operations?operation_id=…（provisional，本轮未实现）",
    service: "yaya operations ledger（授权回执查询）",
    auth: { kind: "scope_query" },
    phase: "read",
    scope_policy: "business_scope",
    coverage_origin: "assistant_internal",
    secret_input: "none",
    implemented: false,
  },
];

/* --------------------------------- 检查设施 --------------------------------- */

let passed = 0;
let total = 0;
const failedNames: string[] = [];

function check(name: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failedNames.push(name);
    console.error(`FAIL - ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toolById(toolId: string): YayaToolCoverage {
  const tool = [...TOOLS, ...INTERNAL_CAPABILITIES].find((candidate) => candidate.tool_id === toolId);
  assert.ok(tool, `reference tool missing: ${toolId}`);
  return tool;
}

function toolAuth(toolId: string): YayaToolAuth {
  return toolById(toolId).auth;
}

function actionTool(toolId: string): Extract<YayaToolAuth, { kind: "action" }> {
  const auth = toolAuth(toolId);
  if (auth.kind !== "action") throw new Error(`expected action tool: ${toolId}`);
  return auth;
}

function principalOf(
  role: "admin" | "teacher",
  classIds: readonly string[] = [],
  accountStatus: "active" | "disabled" = "active"
): Principal {
  if (role === "admin") {
    return {
      account_id: "account-admin",
      username: "admin",
      display_name: "管理员",
      role,
      account_status: accountStatus,
      scope: { kind: "school", school_id: "school-1" },
    };
  }
  return {
    account_id: "account-teacher-a",
    username: "teacher.a",
    display_name: "教师A",
    role,
    account_status: accountStatus,
    scope: { kind: "classes", class_ids: [...classIds] },
  };
}

function denyOf(decision: ReturnType<typeof authorizeAction>): string | null {
  if (decision.allowed) return null;
  return "invalid_request" in decision ? "invalid_request" : decision.deny;
}

function childResource(childId = "child-a", currentClassId: string | null = "class-a"): AccessResource {
  return { kind: "child", child_id: childId, current_class_id: currentClassId };
}

function classResource(classId = "class-a"): AccessResource {
  return { kind: "class", class_id: classId };
}

function schoolResource(): AccessResource {
  return { kind: "school", school_id: "school-1" };
}

function transferResource(
  childId = "child-a",
  currentClassId: string | null = "class-a",
  targetClassId = "class-b"
): AccessResource {
  return { kind: "transfer", child_id: childId, current_class_id: currentClassId, target_class_id: targetClassId };
}

function observationResource(
  observationId = "observation-1",
  childId = "child-a",
  currentClassId: string | null = "class-a",
  observedClassId: string | null = "class-a"
): AccessResource {
  return {
    kind: "observation",
    observation_id: observationId,
    child_id: childId,
    current_class_id: currentClassId,
    observed_class_id: observedClassId,
    author_account_id: null,
  };
}

function bindingItem(overrides: Partial<YayaApprovalItemRef> = {}): YayaApprovalItemRef {
  return {
    item_key: "item-1",
    operation_id: "op-1",
    action: "observation.confirm",
    resource: "observation",
    target_id: "observation-1",
    resource_facts_at_approval: observationResource(),
    content_digest: "digest-v1",
    attachment_associations: [{ attachment_id: "image-1", target_id: "observation-1" }],
    business_revision: "guide-rev-7",
    ...overrides,
  };
}

function binding(overrides: Partial<YayaApprovalBinding> = {}): YayaApprovalBinding {
  return {
    approval_id: "approval-1",
    batch_id: "batch-1",
    proposal_id: "proposal-1",
    proposal_origin: "teacher_card",
    approval_source: "authenticated_entry",
    actor_account_id: "account-teacher-a",
    session_id: "session-1",
    items: [bindingItem()],
    approved_at: "2026-10-05T08:00:00.000Z",
    expires_at: null,
    cancelled_at: null,
    ...overrides,
  };
}

function submitter(overrides: Partial<YayaApprovalSubmitter> = {}): YayaApprovalSubmitter {
  return {
    identity_state: "authenticated",
    principal: principalOf("teacher", ["class-a"]),
    session_id: "session-1",
    session_valid: true,
    csrf_verified: true,
    runtime_approved_state: false,
    execution_at: "2026-10-05T08:05:00.000Z",
    ...overrides,
  };
}

function executionItem(
  overrides: Partial<YayaApprovalItemExecution> = {}
): YayaApprovalItemExecution {
  return {
    item_key: "item-1",
    operation_id: "op-1",
    resource_facts: observationResource(),
    content_digest: "digest-v1",
    attachment_associations: [{ attachment_id: "image-1", target_id: "observation-1" }],
    business_revision: "guide-rev-7",
    ...overrides,
  };
}

function reasonsOf(result: ReturnType<typeof evaluateApprovalExecution>): readonly string[] {
  return result.ok ? [] : result.reasons;
}

function planned(overrides: Partial<YayaPlannedOperation> = {}): YayaPlannedOperation {
  return {
    batch_id: "batch-1",
    proposal_id: "proposal-1",
    item_key: "child-a",
    operation_id: "op-a",
    target_id: "child-a",
    actor_account_id: "account-teacher-a",
    ...overrides,
  };
}

function receipt(overrides: Partial<YayaOperationReceipt> = {}): YayaOperationReceipt {
  return {
    ...planned(),
    status: "saved",
    effect: "committed",
    business_object_id: "observation-a",
    business_revision: "rev-1",
    recorded_at: "2026-10-05T08:00:01.000Z",
    ...overrides,
  };
}

function chatMessage(overrides: Partial<YayaChatMessageRef> = {}): YayaChatMessageRef {
  return {
    message_id: "message-1",
    owner_account_id: "account-teacher-a",
    session_id: "session-1",
    created_at: "2026-10-05T08:00:00.000Z",
    message_kind: "text",
    execution_state: "none",
    fragments: [],
    attachment_ids: [],
    ...overrides,
  };
}

/* --------------------------------- 反例断言 --------------------------------- */

check("草案标记 reference_only 且未冻结（TECH0 未交付）", () => {
  assert.equal(YAYA_CONTRACT_STATUS, "reference_only");
  assert.equal(YAYA_CONTRACT_FROZEN, false);
});

check("覆盖表无虚构入口：组合合法、范围策略与来源完整", () => {
  for (const tool of TOOLS) {
    assert.equal(isLegalToolCombination(tool.auth), true, `illegal combination: ${tool.tool_id}`);
    assert.equal(tool.implemented, true, `platform feature must be implemented: ${tool.tool_id}`);
    assert.equal(tool.coverage_origin, "platform_feature");
    assert.ok(
      tool.scope_policy === "business_scope" || tool.scope_policy === "authenticated_reference",
      `invalid scope policy: ${tool.tool_id}`
    );
  }
  for (const tool of INTERNAL_CAPABILITIES) {
    assert.equal(tool.coverage_origin, "assistant_internal");
    assert.equal(isLegalToolCombination(tool.auth), true);
  }
  assert.equal(toolById("query.guide_catalog").scope_policy, "authenticated_reference");
  assert.equal(toolById("query.children").scope_policy, "business_scope");
});

check("管理员教学禁止：管理工具可用，教学/整理/确认/决定/小结/支持一律拒绝", () => {
  const admin = principalOf("admin");
  const teacher = principalOf("teacher", ["class-a"]);
  const teachingResources: readonly [string, AccessResource][] = [
    ["create_observation", childResource()],
    ["organize_observation", observationResource()],
    ["follow_up_observation", observationResource()],
    ["confirm_observation", observationResource()],
    ["guide_decide", observationResource()],
    ["refresh_growth_profile", childResource()],
    ["refresh_activity_support", childResource()],
  ];
  for (const [toolId, resource] of teachingResources) {
    const tool = actionTool(toolId);
    assert.equal(denyOf(authorizeAction(admin, tool.action, resource)), "forbidden_role", toolId);
  }
  assert.equal(authorizeAction(admin, "class.manage", classResource()).allowed, true);
  assert.equal(authorizeAction(admin, "teacher.manage", schoolResource()).allowed, true);
  assert.equal(authorizeAction(admin, "child.transfer", transferResource()).allowed, true);
  assert.equal(authorizeAction(admin, "child.create_profile", classResource()).allowed, true);
  assert.equal(authorizeAction(teacher, "observation.confirm", observationResource()).allowed, true);
});

check("空任教≠全园：空数组是 none，非空也不等于 school", () => {
  const empty = scopeFromClassIds([]);
  assert.equal(empty.kind, "none");
  assert.equal(scopeIsSchoolWide(empty), false);
  const classes = scopeFromClassIds(["class-a"]);
  assert.equal(classes.kind, "classes");
  assert.equal(scopeIsSchoolWide(classes), false);
  assert.equal(scopeIsSchoolWide({ kind: "school" }), true);
});

check("同班教师不共享聊天：非本人会话一律 hidden", () => {
  const message = chatMessage({
    fragments: [
      {
        fragment_id: "f1",
        sources: [{ kind: "child", child_id: "child-a", current_class_id: "class-a" }],
        independently_readable: true,
      },
    ],
  });
  const projection = projectChatMessage(
    message,
    { account_id: "account-teacher-b", role: "teacher" },
    [{ fragment_id: "f1", source_index: 0, access: "full" }],
    []
  );
  assert.equal(projection.visibility, "hidden");
  assert.equal(projection.metadata, null);
  assert.equal(projection.fragments[0]?.visibility, "hidden");
  assert.equal(projection.fragments[0]?.reason, "owner_mismatch");
});

check("修改批准内容失效：内容摘要变化 → content_changed", () => {
  const result = evaluateApprovalExecution(binding(), submitter(), [
    executionItem({ content_digest: "digest-v2" }),
  ]);
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("content_changed"));
});

check("附件关系变化失效：附件集合变化 → attachments_changed", () => {
  const result = evaluateApprovalExecution(binding(), submitter(), [
    executionItem({
      attachment_associations: [
        { attachment_id: "image-1", target_id: "observation-1" },
        { attachment_id: "image-2", target_id: "observation-1" },
      ],
    }),
  ]);
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("attachments_changed"));
});

check("换 session 不沿用批准：新登录会话 → session_changed", () => {
  const result = evaluateApprovalExecution(binding(), submitter({ session_id: "session-2" }), [
    executionItem(),
  ]);
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("session_changed"));
});

check("转班/撤权不沿用批准：归属事实变化与越权拒绝", () => {
  const moved = evaluateApprovalExecution(
    binding(),
    submitter({ principal: principalOf("teacher", ["class-b"]) }),
    [executionItem()]
  );
  assert.equal(moved.ok, false);
  assert.ok(reasonsOf(moved).includes("out_of_scope"));
  const revoked = evaluateApprovalExecution(
    binding(),
    submitter({ principal: principalOf("teacher", []) }),
    [executionItem()]
  );
  assert.equal(revoked.ok, false);
  assert.ok(reasonsOf(revoked).includes("empty_scope"));
});

check("停用账号/停止批准/过期不沿用：disabled、cancelled、expired 均拒绝", () => {
  const disabled = evaluateApprovalExecution(
    binding(),
    submitter({ principal: principalOf("teacher", ["class-a"], "disabled") }),
    [executionItem()]
  );
  assert.equal(disabled.ok, false);
  assert.ok(reasonsOf(disabled).includes("account_disabled"));
  const cancelled = evaluateApprovalExecution(
    binding({ cancelled_at: "2026-10-05T08:01:00.000Z" }),
    submitter(),
    [executionItem()]
  );
  assert.equal(cancelled.ok, false);
  assert.ok(reasonsOf(cancelled).includes("approval_cancelled"));
  const expired = evaluateApprovalExecution(
    binding({ expires_at: "2026-10-05T08:04:00.000Z" }),
    submitter(),
    [executionItem()]
  );
  assert.equal(expired.ok, false);
  assert.ok(reasonsOf(expired).includes("approval_expired"));
});

check("模型生成 approved 无效：模型/请求体自报批准都不是证明", () => {
  for (const source of ["model_output", "request_body_claim"] as const) {
    const result = evaluateApprovalExecution(
      binding({ approval_source: source, proposal_origin: "model_suggestion" }),
      submitter({ runtime_approved_state: true }),
      [executionItem()]
    );
    assert.equal(result.ok, false);
    assert.ok(reasonsOf(result).includes("untrusted_approval_source"), source);
  }
});

check("原文/工具结果中的指令不能提权：角色与批准判定只来自服务端事实", () => {
  assert.equal(
    denyOf(authorizeAction(principalOf("admin"), "observation.confirm", observationResource())),
    "forbidden_role"
  );
  const forged = evaluateApprovalExecution(
    binding({ approval_source: "request_body_claim" }),
    submitter(),
    [executionItem()]
  );
  assert.equal(forged.ok, false);
});

check("业务版本变化失效：guide 容器 revision 不一致 → business_version_changed", () => {
  const result = evaluateApprovalExecution(binding(), submitter(), [
    executionItem({ business_revision: "guide-rev-8" }),
  ]);
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("business_version_changed"));
});

check("完整一致时批准可复用：逐项身份与前提全同才 ok", () => {
  const single = evaluateApprovalExecution(binding(), submitter(), [executionItem()]);
  assert.equal(single.ok, true);
  const twoItemBinding = binding({
    batch_id: "batch-2",
    items: [
      bindingItem({ item_key: "item-a", operation_id: "op-a" }),
      bindingItem({ item_key: "item-b", operation_id: "op-b", target_id: "observation-2", resource_facts_at_approval: observationResource("observation-2") }),
    ],
  });
  const twoItemExecution = [
    executionItem({ item_key: "item-a", operation_id: "op-a" }),
    executionItem({ item_key: "item-b", operation_id: "op-b", resource_facts: observationResource("observation-2") }),
  ];
  assert.equal(evaluateApprovalExecution(twoItemBinding, submitter(), twoItemExecution).ok, true);
});

check("两人不同事实不串档：回执按完整身份匹配", () => {
  const plan = [
    planned({ item_key: "item-child-a", operation_id: "op-a", target_id: "child-a" }),
    planned({ item_key: "item-child-b", operation_id: "op-b", target_id: "child-b" }),
  ];
  const receipts = [
    receipt({ item_key: "item-child-a", operation_id: "op-a", target_id: "child-a", status: "saved" }),
    receipt({
      item_key: "item-child-b",
      operation_id: "op-b",
      target_id: "child-b",
      status: "failed",
      effect: "none",
      business_object_id: null,
    }),
  ];
  const comparison = compareBatchReceipts(plan, receipts);
  assert.equal(comparison.expected, 2);
  assert.equal(comparison.received, 2);
  assert.equal(comparison.all_saved, false);
  assert.equal(comparison.saved, 1);
  assert.equal(comparison.failed, 1);
  assert.deepEqual(
    itemsToResend(receipts).map((entry) => entry.operation_id),
    ["op-b"]
  );
  const wrongTarget = compareBatchReceipts(plan, [
    receipt({ item_key: "item-child-a", operation_id: "op-a", target_id: "child-b", status: "saved" }),
  ]);
  assert.deepEqual(wrongTarget.unexpected_operation_ids, ["op-a"]);
  assert.ok(wrongTarget.missing_operation_ids.includes("op-a"));
  assert.ok(wrongTarget.missing_operation_ids.includes("op-b"));
  assert.equal(wrongTarget.all_saved, false);
});

check("部分成功不重发：只重试确认无已提交效果的失败项", () => {
  const receipts = [
    receipt({ operation_id: "op-a", status: "saved", effect: "committed" }),
    receipt({ operation_id: "op-b", status: "failed", effect: "none" }),
    receipt({ operation_id: "op-c", status: "failed", effect: "unknown" }),
    receipt({ operation_id: "op-d", status: "conflict", effect: "unknown" }),
    receipt({ operation_id: "op-e", status: "in_progress", effect: "unknown" }),
    receipt({ operation_id: "op-f", status: "needs_verification", effect: "unknown" }),
    receipt({ operation_id: "op-g", status: "saved_detail_unavailable", effect: "committed" }),
    receipt({ operation_id: "op-h", status: "unchanged", effect: "committed" }),
  ];
  assert.deepEqual(
    itemsToResend(receipts).map((entry) => entry.operation_id),
    ["op-b"]
  );
});

check("未知回执不假成功：无回执 → unknown，绝不显示 saved", () => {
  const expected = planned({ operation_id: "op-lost" });
  const outcome = queryOperationOutcome([], expected);
  assert.equal(outcome.kind, "unknown");
  assert.equal(
    receiptProvesSuccess(receipt({ status: "needs_verification", effect: "unknown", business_object_id: null })),
    false
  );
  assert.equal(
    receiptProvesSuccess(receipt({ status: "failed", effect: "none", business_object_id: null })),
    false
  );
  assert.equal(
    receiptProvesSuccess(receipt({ status: "conflict", effect: "unknown", business_object_id: null })),
    false
  );
  assert.equal(
    receiptProvesSuccess(receipt({ status: "in_progress", effect: "unknown", business_object_id: null })),
    false
  );
  assert.equal(receiptProvesSuccess(receipt({ status: "saved" })), true);
  assert.equal(receiptProvesSuccess(receipt({ status: "saved_detail_unavailable" })), true);
  assert.equal(receiptProvesSuccess(receipt({ status: "unchanged" })), true);
});

check("重复提交幂等：同 operation_id 回执重放，不再次执行", () => {
  const plan = [planned({ operation_id: "op-dup" })];
  const receipts = [receipt({ operation_id: "op-dup", status: "saved" })];
  const outcome = queryOperationOutcome(receipts, planned({ operation_id: "op-dup" }));
  assert.equal(outcome.kind, "saved");
  const comparison = compareBatchReceipts(plan, receipts);
  assert.equal(comparison.all_saved, true);
});

check("图像解读不冒充原文：既不格式证据也不成为 raw_text", () => {
  const imageDerived: YayaSourceRef = {
    kind: "image_interpretation",
    ref_id: "image-1",
    label: null,
    derived_from: "image-1",
  };
  const modelText: YayaSourceRef = {
    kind: "model_text",
    ref_id: "message-2",
    label: null,
    derived_from: "observation-1",
  };
  const spoofedRaw: YayaSourceRef = {
    kind: "raw_input",
    ref_id: "image-1",
    label: null,
    derived_from: "image-1",
  };
  assert.equal(isFormalEvidenceKind("image_interpretation"), false);
  assert.equal(isFormalEvidenceKind("model_text"), false);
  assert.equal(isFormalEvidenceKind("public_web"), false);
  assert.equal(isFormalEvidenceKind("guide_catalog"), false);
  assert.equal(isFormalEvidenceKind("child_fact"), true);
  assert.equal(mayBecomeObservationRawText(imageDerived), false);
  assert.equal(mayBecomeObservationRawText(modelText), false);
  assert.equal(mayBecomeObservationRawText(spoofedRaw), false);
  assert.equal(
    mayBecomeObservationRawText({ kind: "raw_input", ref_id: "message-1", label: null, derived_from: null }),
    true
  );
});

check("raw_text 不可改写：payload 联合没有更新原文的 kind", () => {
  assert.equal(YAYA_RAW_TEXT_IS_IMMUTABLE, true);
  for (const kind of YAYA_PAYLOAD_KINDS) {
    assert.equal(kind.includes("raw_text"), false, `payload kind must not edit raw_text: ${kind}`);
    assert.equal(kind.startsWith("update_"), false, `payload kind must not update records: ${kind}`);
  }
  assert.equal(YAYA_PAYLOAD_KINDS.includes("create_observation"), true);
});

check("撤销后消息投影：仅元数据且附件不可读", () => {
  const message = chatMessage({
    fragments: [
      {
        fragment_id: "f1",
        sources: [{ kind: "child", child_id: "child-x", current_class_id: "class-a" }],
        independently_readable: false,
      },
    ],
    attachment_ids: ["image-9"],
  });
  const projection = projectChatMessage(
    message,
    { account_id: "account-teacher-a", role: "teacher" },
    [{ fragment_id: "f1", source_index: 0, access: "denied" }],
    [{ attachment_id: "image-9", access: "denied" }]
  );
  assert.equal(projection.visibility, "hidden");
  assert.equal(projection.fragments[0]?.visibility, "hidden");
  assert.equal(projection.fragments[0]?.reason, "source_denied");
  assert.equal(projection.attachments[0]?.readable, false);
  assert.equal(projection.execution_allowed, false);
  assert.ok(projection.metadata);
  assert.deepEqual(Object.keys(projection.metadata).sort(), [
    "created_at",
    "execution_state",
    "fragment_count",
    "has_attachments",
    "message_kind",
  ]);
});

check("删除聊天与档案图片分离：全状态观察引用保护", () => {
  const draftRef: YayaImageLifecycleFacts = {
    image_id: "image-draft",
    reference_query_complete: true,
    observation_refs: [{ observation_id: "observation-draft", status: "draft" }],
    message_refs: [{ conversation_id: "conversation-1", message_id: "message-1" }],
    proposal_refs: [],
  };
  assert.equal(decideImageRetention(draftRef, "conversation-1"), "retain_business_reference");
  assert.equal(mayPurgeImage(draftRef), false);
  const otherConversation: YayaImageLifecycleFacts = {
    ...draftRef,
    observation_refs: [],
    message_refs: [{ conversation_id: "conversation-2", message_id: "message-9" }],
  };
  assert.equal(decideImageRetention(otherConversation, "conversation-1"), "retain_other_conversations");
  const incomplete: YayaImageLifecycleFacts = {
    image_id: "image-unknown",
    reference_query_complete: false,
    observation_refs: [],
    message_refs: [],
    proposal_refs: [],
  };
  assert.equal(decideImageRetention(incomplete, "conversation-1"), "retain_unknown_references");
  assert.equal(mayPurgeImage(incomplete), false);
  const ownOnly: YayaImageLifecycleFacts = {
    ...draftRef,
    observation_refs: [],
    proposal_refs: [],
  };
  assert.equal(decideImageRetention(ownOnly, "conversation-1"), "deletable_with_conversation");
  assert.equal(mayPurgeImage(ownOnly), false);
});

check("密码仅安全控件：覆盖表标注 secure_control，且聊天 payload 无密码字段", () => {
  const secureTools = TOOLS.filter((tool) => tool.secret_input === "secure_control");
  assert.deepEqual(
    secureTools.map((tool) => tool.tool_id).sort(),
    ["admin.teacher_create", "admin.teacher_password_reset"]
  );
  for (const tool of secureTools) {
    assert.equal(tool.phase, "commit");
    assert.ok(tool.entry.includes("安全控件"), `${tool.tool_id} must collect secret via secure control`);
  }
  assert.equal(
    YAYA_PAYLOAD_KINDS.some((kind) => kind.includes("password")),
    false
  );
  const manageTeacher: YayaDomainPayload = {
    kind: "manage_teacher",
    operation: "create",
    teacher_account_id: null,
    username: "teacher.b",
    display_name: "教师B",
    class_ids: ["class-a"],
    status: null,
    secret_via_secure_control: true,
  };
  assert.equal("password" in manageTeacher, false);
});

check("公开检索不带幼儿识别信息；通用问答不强制选对象", () => {
  assert.equal(requiresBusinessTarget(null), false);
  assert.equal(requiresBusinessTarget(toolAuth("query.children")), true);
  assert.deepEqual(decidePublicSearch({ provider_enabled: true, child_identifier_scan: "present", server_redaction_applied: true }), {
    allowed: false,
    reason: "identifiers_present",
  });
  assert.deepEqual(decidePublicSearch({ provider_enabled: true, child_identifier_scan: "unknown", server_redaction_applied: true }), {
    allowed: false,
    reason: "scan_unknown_conservative",
  });
  assert.deepEqual(decidePublicSearch({ provider_enabled: false, child_identifier_scan: "known_absent", server_redaction_applied: false }), {
    allowed: false,
    reason: "provider_disabled",
  });
  assert.deepEqual(decidePublicSearch({ provider_enabled: true, child_identifier_scan: "known_absent", server_redaction_applied: false }), {
    allowed: true,
  });
});

check("候选歧义必须显式选择：required 且未选 → 未解决", () => {
  const selection = {
    required: true,
    candidates: [
      { candidate_kind: "child" as const, candidate_id: "child-a", label: "小雨" },
      { candidate_kind: "child" as const, candidate_id: "child-b", label: "小雨" },
    ],
    selected_id: null,
    snapshot_revision: "rev-1",
  };
  assert.deepEqual(resolveCandidateSelection(selection, "child", "rev-1"), {
    resolved: false,
    reason: "selection_required",
  });
  assert.equal(
    resolveCandidateSelection({ ...selection, selected_id: "child-b" }, "child", "rev-1").resolved,
    true
  );
  assert.equal(
    resolveCandidateSelection({ ...selection, required: false }, "child", "rev-1").resolved,
    true
  );
});

check("准备态不等于正式记录：organize/follow-up 不提交 commit，确认与决定了才 commit", () => {
  assert.equal(toolById("organize_observation").phase, "prepare");
  assert.equal(toolById("follow_up_observation").phase, "prepare");
  assert.equal(toolById("confirm_observation").phase, "commit");
  assert.equal(toolById("guide_decide").phase, "commit");
  assert.equal(toolById("query.children").phase, "read");
  const previewOnly = compareBatchReceipts([], []);
  assert.equal(previewOnly.all_saved, false);
});

check("同权转班不掩盖归属变化：A/B 同权限，A→B 后仍 attribution_changed", () => {
  const moved = executionItem({
    resource_facts: observationResource("observation-1", "child-a", "class-b", "class-a"),
  });
  const result = evaluateApprovalExecution(
    binding(),
    submitter({ principal: principalOf("teacher", ["class-a", "class-b"]) }),
    [moved]
  );
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("attribution_changed"));
  assert.equal(reasonsOf(result).includes("out_of_scope"), false);
});

check("非法组合先于角色拒绝：observation.confirm + class 一律 illegal_combination", () => {
  const illegalBinding = binding({
    items: [
      bindingItem({
        action: "observation.confirm",
        resource: "class",
        target_id: "class-a",
        resource_facts_at_approval: classResource(),
      }),
    ],
  });
  const execution = executionItem({ resource_facts: classResource() });
  for (const principal of [principalOf("teacher", ["class-a"]), principalOf("admin")]) {
    const result = evaluateApprovalExecution(illegalBinding, submitter({ principal }), [execution]);
    assert.equal(result.ok, false);
    assert.ok(reasonsOf(result).includes("illegal_combination"));
    assert.equal(reasonsOf(result).includes("role_not_allowed"), false);
  }
  assert.equal(
    isLegalToolCombination({ kind: "action", action: "observation.confirm", resource: "class" }),
    false
  );
});

check("教师管理动作拒绝：授权与批准都不放行（修正原错误预期）", () => {
  const teacher = principalOf("teacher", ["class-a"]);
  assert.equal(denyOf(authorizeAction(teacher, "teacher.manage", schoolResource())), "forbidden_role");
  assert.equal(denyOf(authorizeAction(teacher, "class.manage", classResource())), "forbidden_role");
  const managementBinding = binding({
    items: [
      bindingItem({
        action: "teacher.manage",
        resource: "school",
        target_id: "school-1",
        resource_facts_at_approval: schoolResource(),
      }),
    ],
  });
  const result = evaluateApprovalExecution(managementBinding, submitter({ principal: teacher }), [
    executionItem({ resource_facts: schoolResource() }),
  ]);
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("role_not_allowed"));
});

check("管理员不自动获得他人聊天：owner 边界先于角色", () => {
  const message = chatMessage({ owner_account_id: "account-teacher-a" });
  const projection = projectChatMessage(message, { account_id: "account-admin", role: "admin" }, [], []);
  assert.equal(projection.visibility, "hidden");
  assert.equal(projection.metadata, null);
});

check("多来源投影：独立可核验片段保留，不可拆分正文保守受限", () => {
  const message = chatMessage({
    fragments: [
      {
        fragment_id: "f1",
        sources: [
          { kind: "class", class_id: "class-a" },
          { kind: "child", child_id: "child-a", current_class_id: "class-a" },
        ],
        independently_readable: true,
      },
      {
        fragment_id: "f2",
        sources: [
          { kind: "class", class_id: "class-a" },
          { kind: "child", child_id: "child-b", current_class_id: "class-a" },
        ],
        independently_readable: false,
      },
    ],
  });
  const evaluations: readonly YayaEvaluatedSource[] = [
    { fragment_id: "f1", source_index: 0, access: "denied" },
    { fragment_id: "f1", source_index: 1, access: "full" },
    { fragment_id: "f2", source_index: 0, access: "denied" },
    { fragment_id: "f2", source_index: 1, access: "full" },
  ];
  const projection = projectChatMessage(
    message,
    { account_id: "account-teacher-a", role: "teacher" },
    evaluations,
    []
  );
  assert.equal(projection.fragments[0]?.visibility, "full");
  assert.equal(projection.fragments[1]?.visibility, "hidden");
  assert.equal(projection.fragments[1]?.reason, "source_denied");
  assert.equal(projection.visibility, "partial");
});

check("历史只读投影：正文 historical，附件仅元数据", () => {
  const message = chatMessage({
    fragments: [
      {
        fragment_id: "f1",
        sources: [
          {
            kind: "observation",
            observation_id: "observation-1",
            child_id: "child-a",
            current_class_id: "class-b",
            observed_class_id: "class-a",
          },
        ],
        independently_readable: true,
      },
    ],
    attachment_ids: ["image-1"],
  });
  const projection = projectChatMessage(
    message,
    { account_id: "account-teacher-a", role: "teacher" },
    [{ fragment_id: "f1", source_index: 0, access: "historical_read_only" }],
    [{ attachment_id: "image-1", access: "historical_read_only" }]
  );
  assert.equal(projection.fragments[0]?.visibility, "historical_read_only");
  assert.equal(projection.visibility, "partial");
  assert.equal(projection.attachments[0]?.readable, false);
  assert.equal(projection.attachments[0]?.metadata_only, true);
});

check("未知/损坏/服务不可用不默认 full", () => {
  const message = chatMessage({
    fragments: [
      {
        fragment_id: "f1",
        sources: [{ kind: "class", class_id: "class-a" }],
        independently_readable: true,
      },
    ],
  });
  const viewer = { account_id: "account-teacher-a", role: "teacher" } as const;
  const unavailable = projectChatMessage(
    message,
    viewer,
    [{ fragment_id: "f1", source_index: 0, access: "unavailable" }],
    []
  );
  assert.equal(unavailable.fragments[0]?.reason, "source_unavailable");
  assert.equal(unavailable.visibility, "unavailable");
  const broken = projectChatMessage(
    message,
    viewer,
    [{ fragment_id: "f1", source_index: 0, access: "broken" }],
    []
  );
  assert.equal(broken.fragments[0]?.reason, "source_broken");
  assert.notEqual(broken.visibility, "full");
  const missingEvaluation = projectChatMessage(message, viewer, [], []);
  assert.equal(missingEvaluation.fragments[0]?.reason, "evaluation_missing");
  assert.notEqual(missingEvaluation.visibility, "full");
});

check("标题/搜索摘要不成为泄漏旁路：来源片段非 full 时用通用标题", () => {
  const message = chatMessage({
    fragments: [
      {
        fragment_id: "f1",
        sources: [{ kind: "class", class_id: "class-a" }],
        independently_readable: true,
      },
    ],
  });
  const projection = projectChatMessage(
    message,
    { account_id: "account-teacher-a", role: "teacher" },
    [{ fragment_id: "f1", source_index: 0, access: "denied" }],
    []
  );
  const restricted = projectConversationTitle(
    { title: "小雨今天在建构区的表现", derived_from_fragment_ids: ["f1"] },
    projection.fragments
  );
  assert.equal(restricted.restricted, true);
  assert.equal(restricted.title, "受限会话");
  const allowed = projectConversationTitle(
    { title: "公开指南查询", derived_from_fragment_ids: [] },
    projection.fragments
  );
  assert.equal(allowed.restricted, false);
});

check("缺项回执不假全成功：对照预期条目清单", () => {
  const plan = [
    planned({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" }),
    planned({ item_key: "item-b", operation_id: "op-b", target_id: "child-b" }),
  ];
  const comparison = compareBatchReceipts(plan, [
    receipt({ item_key: "item-a", operation_id: "op-a", target_id: "child-a", status: "saved" }),
  ]);
  assert.equal(comparison.expected, 2);
  assert.equal(comparison.received, 1);
  assert.deepEqual(comparison.missing_operation_ids, ["op-b"]);
  assert.equal(comparison.all_saved, false);
});

check("错配回执：身份不匹配 → missing + unexpected，不得算成功", () => {
  const plan = [planned({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" })];
  const comparison = compareBatchReceipts(plan, [
    receipt({ item_key: "item-a", operation_id: "op-a", target_id: "child-b", status: "saved" }),
  ]);
  assert.deepEqual(comparison.unexpected_operation_ids, ["op-a"]);
  assert.deepEqual(comparison.missing_operation_ids, ["op-a"]);
  assert.equal(comparison.all_saved, false);
});

check("重复与矛盾回执：duplicate/contradictory → 非全成功且查询未知", () => {
  const plan = [planned({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" })];
  const expected = planned({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" });
  const contradictory = [
    receipt({ item_key: "item-a", operation_id: "op-a", target_id: "child-a", status: "saved", effect: "committed" }),
    receipt({
      item_key: "item-a",
      operation_id: "op-a",
      target_id: "child-a",
      status: "failed",
      effect: "none",
      business_object_id: null,
    }),
  ];
  const comparison = compareBatchReceipts(plan, contradictory);
  assert.deepEqual(comparison.duplicate_operation_ids, ["op-a"]);
  assert.deepEqual(comparison.contradictory_operation_ids, ["op-a"]);
  assert.equal(comparison.all_saved, false);
  const outcome = queryOperationOutcome(contradictory, expected);
  assert.equal(outcome.kind, "unknown");
  const duplicateOnly = compareBatchReceipts(plan, [
    receipt({ item_key: "item-a", operation_id: "op-a", status: "saved" }),
    receipt({ item_key: "item-a", operation_id: "op-a", status: "saved" }),
  ]);
  assert.deepEqual(duplicateOnly.duplicate_operation_ids, ["op-a"]);
  assert.deepEqual(duplicateOnly.contradictory_operation_ids, []);
  assert.equal(duplicateOnly.all_saved, false);
});

check("操作身份预分配：batch_id 与逐项 operation_id，完整匹配不靠顺序", () => {
  const plan = [planned({ batch_id: "batch-9", item_key: "item-a", operation_id: "op-pre-a", target_id: "child-a" })];
  const byOriginalId = compareBatchReceipts(plan, [
    receipt({ batch_id: "batch-9", item_key: "item-a", operation_id: "op-pre-a", target_id: "child-a", status: "saved" }),
  ]);
  assert.equal(byOriginalId.all_saved, true);
  const byOtherId = compareBatchReceipts(plan, [
    receipt({ batch_id: "batch-9", item_key: "item-a", operation_id: "op-other", target_id: "child-a", status: "saved" }),
  ]);
  assert.deepEqual(byOtherId.missing_operation_ids, ["op-pre-a"]);
  assert.deepEqual(byOtherId.unexpected_operation_ids, ["op-other"]);
  assert.equal(byOtherId.all_saved, false);
  assert.deepEqual(
    queryOperationOutcome(
      [receipt({ operation_id: "op-other", status: "saved" })],
      planned({ batch_id: "batch-9", item_key: "item-a", operation_id: "op-pre-a", target_id: "child-a" })
    ).kind,
    "unknown"
  );
});

check("失败效果分级：只有 failed+none 可重发", () => {
  assert.equal(
    itemsToResend([receipt({ status: "failed", effect: "committed" })]).length,
    0
  );
  assert.equal(itemsToResend([receipt({ status: "failed", effect: "none" })]).length, 1);
  assert.equal(itemsToResend([receipt({ status: "conflict", effect: "unknown" })]).length, 0);
});

check("回执查询语义：进行中/失败/冲突/已保存/详情不可读/未知", () => {
  const expected = planned({ item_key: "child-a", operation_id: "op-q", target_id: "child-a" });
  assert.deepEqual(queryOperationOutcome([], expected), { kind: "unknown", reason: "no_receipt" });
  assert.deepEqual(queryOperationOutcome([receipt({ operation_id: "op-q", status: "in_progress", effect: "unknown" })], expected), {
    kind: "in_progress",
  });
  assert.deepEqual(queryOperationOutcome([receipt({ operation_id: "op-q", status: "failed", effect: "none", business_object_id: null })], expected), {
    kind: "failed",
    effect: "none",
  });
  assert.deepEqual(queryOperationOutcome([receipt({ operation_id: "op-q", status: "conflict", effect: "unknown" })], expected), {
    kind: "conflict",
  });
  assert.equal(queryOperationOutcome([receipt({ operation_id: "op-q", status: "saved" })], expected).kind, "saved");
  assert.equal(
    queryOperationOutcome([receipt({ operation_id: "op-q", status: "saved_detail_unavailable" })], expected).kind,
    "saved_detail_unavailable"
  );
  assert.deepEqual(queryOperationOutcome([receipt({ operation_id: "op-q", status: "needs_verification", effect: "unknown" })], expected), {
    kind: "unknown",
    reason: "verification_required",
  });
});

check("批次语义区分：同一观察全有或全无，多观察逐项", () => {
  assert.equal(payloadIsAllOrNothing("confirm_observation"), true);
  assert.equal(payloadIsAllOrNothing("guide_decision"), true);
  assert.equal(payloadIsAllOrNothing("create_observation"), false);
  assert.equal(payloadIsAllOrNothing("follow_up_observation"), false);
});

check("图片读取按记录投影：不裸 image_id、不只凭上传者", () => {
  const attached = {
    image_id: "image-1",
    uploader_account_id: "account-teacher-a",
    attached_records: [{ record_kind: "observation" as const, record_id: "observation-1" }],
  };
  const otherTeacher = decideImageReadAccess(attached, {
    account_id: "account-teacher-b",
    record_access: [{ record_kind: "observation", record_id: "observation-1", projection: "full" }],
  });
  assert.equal(otherTeacher.readable, true);
  assert.equal(otherTeacher.via, "business_record");
  const uploaderWithoutAccess = decideImageReadAccess(attached, {
    account_id: "account-teacher-a",
    record_access: [],
  });
  assert.equal(uploaderWithoutAccess.readable, false);
  assert.equal(uploaderWithoutAccess.reason, "attached_but_no_record_access");
  const unattached = {
    image_id: "image-2",
    uploader_account_id: "account-teacher-a",
    attached_records: [],
  };
  assert.equal(
    decideImageReadAccess(unattached, { account_id: "account-teacher-a", record_access: [] }).readable,
    true
  );
  assert.equal(
    decideImageReadAccess(unattached, { account_id: "account-teacher-b", record_access: [] }).readable,
    false
  );
});

check("伪造候选与陈旧候选：child-z、类型不符、旧快照都不 resolved", () => {
  const selection = {
    required: true,
    candidates: [{ candidate_kind: "child" as const, candidate_id: "child-a", label: "小雨" }],
    selected_id: "child-z",
    snapshot_revision: "rev-1",
  };
  assert.deepEqual(resolveCandidateSelection(selection, "child", "rev-1"), {
    resolved: false,
    reason: "not_in_candidates",
  });
  assert.deepEqual(
    resolveCandidateSelection({ ...selection, selected_id: "child-a" }, "class", "rev-1"),
    { resolved: false, reason: "kind_mismatch" }
  );
  assert.deepEqual(
    resolveCandidateSelection({ ...selection, selected_id: "child-a" }, "child", "rev-2"),
    { resolved: false, reason: "stale_candidates" }
  );
  const resolved = resolveCandidateSelection({ ...selection, selected_id: "child-a" }, "child", "rev-1");
  assert.equal(resolved.resolved, true);
  if (resolved.resolved) assert.equal(resolved.candidate?.candidate_id, "child-a");
});

check("确认输入无损复用 ConfirmObservationInput（正文/备注/澄清/指南决定）", () => {
  const confirmInput: ConfirmObservationInput = {
    content: {
      domain: "社会",
      sub_domain: "人际交往",
      objective_description: "在集体搭建活动中主动与同伴协商分工",
      highlights: ["主动邀请同伴一起搭积木", "遇到分歧时提出轮流方案"],
      support_suggestions: ["提供需要两人合作完成的任务"],
      highlight_quote: "我们一起搭吧，你搭这边我搭那边",
    },
    teacher_note: "教师现场备注",
    clarification: "对审核问题的补充说明",
    guide_decisions: {
      expected_guide_revision: 4,
      decisions: [
        {
          item_id: "social-4-5-3",
          support: "single_event",
          basis: [
            {
              observation_id: "observation-1",
              quote: "我们一起搭吧",
              quote_source: "confirmed_content",
              quote_field: "highlight_quote",
            },
          ],
          adult_help_used: false,
          teacher_note: "独立完成协商",
        },
      ],
    },
  };
  const payload: YayaDomainPayload = {
    kind: "confirm_observation",
    observation_id: "observation-1",
    input: confirmInput,
  };
  assert.equal(payload.kind, "confirm_observation");
  if (payload.kind === "confirm_observation") {
    assert.deepEqual(payload.input, confirmInput);
    assert.equal(payload.input.teacher_note, "教师现场备注");
    assert.equal(payload.input.clarification, "对审核问题的补充说明");
    assert.equal(payload.input.guide_decisions?.expected_guide_revision, 4);
    assert.equal(payload.input.guide_decisions?.decisions.length, 1);
  }
});

check("指南决定无损复用 GuideEvidenceMutationRequest（四种 action 全字段）", () => {
  const confirmMutation: GuideEvidenceMutationRequest = {
    action: "confirm",
    expected_guide_revision: 4,
    decisions: [
      {
        link_id: "link-1",
        support: "sustained",
        basis: [
          {
            observation_id: "observation-1",
            quote: "连续三天主动整理",
            quote_source: "confirmed_content",
            quote_field: "highlights",
          },
          {
            observation_id: "observation-2",
            quote: "提醒同伴收玩具",
            quote_source: "raw_text",
            quote_field: null,
          },
        ],
        sustained_note: {
          period_start: "2026-09-01",
          period_end: "2026-09-03",
          description: "连续三天主动整理玩具并提醒同伴。",
        },
        adult_help_used: true,
        teacher_note: "教师示范后独立完成",
      },
    ],
  };
  const rejectMutation: GuideEvidenceMutationRequest = {
    action: "reject",
    link_id: "link-2",
    expected_guide_revision: 4,
    reason: "引用片段不充分",
  };
  const withdrawMutation: GuideEvidenceMutationRequest = {
    action: "withdraw",
    link_id: "link-3",
    expected_guide_revision: 5,
    reason: "家长补充信息后需要重新整理",
  };
  const suggestMutation: GuideEvidenceMutationRequest = { action: "suggest" };
  const payload: YayaDomainPayload = {
    kind: "guide_decision",
    observation_id: "observation-1",
    mutation: confirmMutation,
  };
  assert.equal(payload.kind, "guide_decision");
  if (payload.kind === "guide_decision") {
    assert.deepEqual(payload.mutation, confirmMutation);
    const decision = confirmMutation.action === "confirm" ? confirmMutation.decisions[0] : undefined;
    assert.ok(decision);
    assert.equal(decision.support, "sustained");
    assert.equal(decision.basis[0]?.quote_field, "highlights");
    assert.equal(decision.basis[1]?.quote_source, "raw_text");
    assert.equal(decision.sustained_note?.description.length !== undefined, true);
    assert.equal(decision.adult_help_used, true);
    assert.equal(rejectMutation.action === "reject" ? rejectMutation.reason : null, "引用片段不充分");
    assert.equal(withdrawMutation.action === "withdraw" ? withdrawMutation.reason : null, "家长补充信息后需要重新整理");
    assert.equal(suggestMutation.action, "suggest");
  }
});

check("依据合法性：未确认 raw_text 不是正式证据，confirmed_content 引文可用", () => {
  assert.equal(
    basisIsFormalEvidence({
      source_kind: "child_fact",
      observation_status: "confirmed",
      source_confirmed_at: "2026-10-01T00:00:00.000Z",
    }),
    true
  );
  assert.equal(
    basisIsFormalEvidence({
      source_kind: "child_fact",
      observation_status: "draft",
      source_confirmed_at: null,
    }),
    false
  );
  assert.equal(
    basisIsFormalEvidence({
      source_kind: "child_fact",
      observation_status: "ai_organized",
      source_confirmed_at: null,
    }),
    false
  );
  assert.equal(
    basisIsFormalEvidence({
      source_kind: "image_interpretation",
      observation_status: "confirmed",
      source_confirmed_at: "2026-10-01T00:00:00.000Z",
    }),
    false
  );
});

check("重复附件 ID 不能绕过关联比较", () => {
  assert.deepEqual(
    compareAttachmentAssociations(
      [{ attachment_id: "image-1", target_id: "observation-1" }],
      [{ attachment_id: "image-1", target_id: "observation-1" }]
    ),
    { equal: true }
  );
  assert.deepEqual(
    compareAttachmentAssociations(
      [
        { attachment_id: "image-1", target_id: "observation-1" },
        { attachment_id: "image-1", target_id: "observation-2" },
      ],
      [{ attachment_id: "image-1", target_id: "observation-1" }]
    ),
    { equal: false, reason: "duplicate" }
  );
  assert.deepEqual(
    compareAttachmentAssociations(
      [{ attachment_id: "image-1", target_id: "observation-1" }],
      [{ attachment_id: "image-1", target_id: "observation-2" }]
    ),
    { equal: false, reason: "mismatch" }
  );
  const duplicated = evaluateApprovalExecution(
    binding({
      items: [
        bindingItem({
          attachment_associations: [
            { attachment_id: "image-1", target_id: "observation-1" },
            { attachment_id: "image-1", target_id: "observation-1" },
          ],
        }),
      ],
    }),
    submitter(),
    [executionItem()]
  );
  assert.equal(duplicated.ok, false);
  assert.ok(reasonsOf(duplicated).includes("duplicate_attachment"));
});

check("多人拆分追溯：原输入/逐人事实/教师补充关系保留", () => {
  const originalSource: YayaSourceRef = {
    kind: "raw_input",
    ref_id: "message-group-1",
    label: null,
    derived_from: null,
  };
  const trace: YayaMultiChildTrace = {
    group_input_id: "group-1",
    original_source: originalSource,
    child_facts: [
      {
        item_key: "item-child-a",
        child_id: "child-a",
        fact_source: { kind: "child_fact", ref_id: "observation-a", label: null, derived_from: null },
      },
      {
        item_key: "item-child-b",
        child_id: "child-b",
        fact_source: { kind: "child_fact", ref_id: "observation-b", label: null, derived_from: null },
      },
    ],
    teacher_supplement_sources: [
      { kind: "teacher_supplement", ref_id: "message-supplement-1", label: null, derived_from: null },
    ],
  };
  assert.notEqual(trace.child_facts[0]?.child_id, trace.child_facts[1]?.child_id);
  assert.equal(trace.child_facts[0]?.fact_source.ref_id !== trace.child_facts[1]?.fact_source.ref_id, true);
  assert.equal(trace.original_source.ref_id, "message-group-1");
  assert.equal(trace.teacher_supplement_sources.length, 1);
  const payload: YayaDomainPayload = {
    kind: "create_observation",
    child_id: "child-a",
    observed_at: "2026-10-05",
    raw_text: "小雨主动邀请同伴一起搭积木。",
    context: "区域活动",
    confirmed_class_id: "class-a",
    image_ids: [],
    source_input: trace,
  };
  assert.equal(payload.kind === "create_observation" ? payload.source_input?.group_input_id : null, "group-1");
});

check("公开检索由服务端约束：模型自报不算，未知保守拒绝", () => {
  assert.deepEqual(
    decidePublicSearch({ provider_enabled: true, child_identifier_scan: "unknown", server_redaction_applied: false }),
    { allowed: false, reason: "scan_unknown_conservative" }
  );
  assert.deepEqual(
    decidePublicSearch({ provider_enabled: true, child_identifier_scan: "present", server_redaction_applied: false }),
    { allowed: false, reason: "identifiers_present" }
  );
});

check("无关权限变化不使批准失效；空范围仍拒绝", () => {
  const result = evaluateApprovalExecution(
    binding(),
    submitter({ principal: principalOf("teacher", ["class-a"]) }),
    [executionItem()]
  );
  assert.equal(result.ok, true);
  const emptyScope = evaluateApprovalExecution(
    binding(),
    submitter({ principal: principalOf("teacher", []) }),
    [executionItem()]
  );
  assert.equal(emptyScope.ok, false);
  assert.ok(reasonsOf(emptyScope).includes("empty_scope"));
});

check("工具覆盖补管理员教师列表与内部能力区分", () => {
  const teacherList = toolById("admin.teacher_list");
  assert.equal(teacherList.phase, "read");
  assert.equal(teacherList.coverage_origin, "platform_feature");
  assert.equal(teacherList.implemented, true);
  const teacherListAuth = actionTool("admin.teacher_list");
  assert.equal(teacherListAuth.action, "teacher.manage");
  assert.equal(teacherListAuth.resource, "school");
  assert.equal(authorizeAction(principalOf("admin"), "teacher.manage", schoolResource()).allowed, true);
  assert.equal(
    denyOf(authorizeAction(principalOf("teacher", ["class-a"]), "teacher.manage", schoolResource())),
    "forbidden_role"
  );
  const internal = toolById("internal.receipt_query");
  assert.equal(internal.coverage_origin, "assistant_internal");
  assert.equal(internal.implemented, false);
  assert.equal(internal.scope_policy, "business_scope");
});

/* --------------------------- R2 反例（RED→GREEN 修复后） --------------------------- */

check("R2 模型提案+可信教师批准+前提一致可执行（保留提案来源）", () => {
  const modelProposal = binding({ proposal_origin: "model_suggestion" });
  assert.equal(modelProposal.proposal_origin, "model_suggestion", "proposal source must be preserved");
  const result = evaluateApprovalExecution(modelProposal, submitter(), [executionItem()]);
  assert.equal(result.ok, true, "trusted authenticated approval of a model proposal must execute");
});

check("R2 模型提案前提变化仍失效（内容/session/归属）", () => {
  const modelProposal = binding({ proposal_origin: "model_suggestion" });
  const contentChanged = evaluateApprovalExecution(modelProposal, submitter(), [
    executionItem({ content_digest: "digest-v2" }),
  ]);
  assert.equal(contentChanged.ok, false);
  assert.ok(reasonsOf(contentChanged).includes("content_changed"));
  const sessionChanged = evaluateApprovalExecution(
    modelProposal,
    submitter({ session_id: "session-2" }),
    [executionItem()]
  );
  assert.equal(sessionChanged.ok, false);
  assert.ok(reasonsOf(sessionChanged).includes("session_changed"));
  const moved = evaluateApprovalExecution(
    modelProposal,
    submitter({ principal: principalOf("teacher", ["class-a", "class-b"]) }),
    [executionItem({ resource_facts: observationResource("observation-1", "child-a", "class-b", "class-a") })]
  );
  assert.equal(moved.ok, false);
  assert.ok(reasonsOf(moved).includes("attribution_changed"));
});

check("R2 本地 runtime approved 状态不参与判定", () => {
  const trusted = evaluateApprovalExecution(binding(), submitter({ runtime_approved_state: true }), [
    executionItem(),
  ]);
  assert.equal(trusted.ok, true);
  const forged = evaluateApprovalExecution(
    binding({ approval_source: "request_body_claim" }),
    submitter({ runtime_approved_state: true }),
    [executionItem()]
  );
  assert.equal(forged.ok, false);
  assert.ok(reasonsOf(forged).includes("untrusted_approval_source"));
});

check("R2 saved+effect=unknown+business_id=null 不得成功", () => {
  const comparison = compareBatchReceipts(
    [planned({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" })],
    [
      receipt({
        item_key: "item-a",
        operation_id: "op-a",
        target_id: "child-a",
        status: "saved",
        effect: "unknown",
        business_object_id: null,
      }),
    ]
  );
  assert.equal(comparison.all_saved, false, "unknown effect without business id cannot be success");
  assert.deepEqual(comparison.unverified_success_operation_ids, ["op-a"]);
  assert.equal(comparison.saved, 0, "unverified success must not count as saved");
});

check("R2 预期清单重复 operation_id 不得全成功", () => {
  const duplicatedPlan = [
    planned({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" }),
    planned({ item_key: "item-b", operation_id: "op-a", target_id: "child-b" }),
  ];
  const comparison = compareBatchReceipts(duplicatedPlan, [
    receipt({ item_key: "item-b", operation_id: "op-a", target_id: "child-b" }),
  ]);
  assert.equal(comparison.all_saved, false, "duplicated plan operation_id must not collapse");
  assert.deepEqual(comparison.duplicate_plan_operation_ids, ["op-a"]);
});

check("R2 预期清单重复 item_key 不得全成功", () => {
  const duplicatedItems = [
    planned({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" }),
    planned({ item_key: "item-a", operation_id: "op-b", target_id: "child-b" }),
  ];
  const comparison = compareBatchReceipts(duplicatedItems, [
    receipt({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" }),
    receipt({ item_key: "item-a", operation_id: "op-b", target_id: "child-b" }),
  ]);
  assert.equal(comparison.all_saved, false);
  assert.deepEqual(comparison.duplicate_plan_item_keys, ["item-a"]);
});

check("R2 错目标回执不得计入 saved 统计且算缺项", () => {
  const comparison = compareBatchReceipts(
    [planned({ item_key: "item-a", operation_id: "op-a", target_id: "child-a" })],
    [receipt({ item_key: "item-a", operation_id: "op-a", target_id: "child-b", status: "saved" })]
  );
  assert.equal(comparison.saved, 0, "identity-mismatched receipt must not count as saved");
  assert.deepEqual(comparison.unexpected_operation_ids, ["op-a"]);
  assert.deepEqual(comparison.missing_operation_ids, ["op-a"]);
  assert.equal(comparison.all_saved, false);
});

check("R2 查询矛盾 actor/业务对象不得返回 saved", () => {
  const expected = planned({ operation_id: "op-q" });
  const actorConflict = queryOperationOutcome(
    [
      receipt({ operation_id: "op-q", actor_account_id: "account-teacher-a" }),
      receipt({ operation_id: "op-q", actor_account_id: "account-teacher-b" }),
    ],
    expected
  );
  assert.deepEqual(actorConflict, { kind: "unknown", reason: "identity_mismatch" });
  const businessConflict = queryOperationOutcome(
    [
      receipt({ operation_id: "op-q", business_object_id: "observation-a" }),
      receipt({ operation_id: "op-q", business_object_id: "observation-b" }),
    ],
    expected
  );
  assert.deepEqual(businessConflict, { kind: "unknown", reason: "contradictory_receipts" });
});

check("R2 合法重复同一回执：查询按同一结果，批内仍单独表达", () => {
  const expected = planned({ operation_id: "op-dup" });
  const identical = [
    receipt({ operation_id: "op-dup", business_object_id: "observation-a" }),
    receipt({ operation_id: "op-dup", business_object_id: "observation-a" }),
  ];
  assert.equal(queryOperationOutcome(identical, expected).kind, "saved");
  const comparison = compareBatchReceipts([planned({ operation_id: "op-dup" })], identical);
  assert.deepEqual(comparison.duplicate_operation_ids, ["op-dup"]);
  assert.deepEqual(comparison.contradictory_operation_ids, []);
  assert.equal(comparison.saved, 1, "identical duplicates count as one verified result");
  assert.equal(comparison.all_saved, false, "duplicate ledger rows must still be reviewed");
});

check("R2 unchanged 保留合法幂等语义：不要求 revision 递增", () => {
  const unchanged = receipt({
    operation_id: "op-u",
    status: "unchanged",
    effect: "committed",
    business_object_id: "observation-a",
    business_revision: null,
  });
  assert.equal(receiptProvesSuccess(unchanged), true);
  assert.equal(queryOperationOutcome([unchanged], planned({ operation_id: "op-u" })).kind, "saved");
  const comparison = compareBatchReceipts([planned({ operation_id: "op-u" })], [unchanged]);
  assert.equal(comparison.all_saved, true);
});

check("R2 saved_detail_unavailable 是已保存；无完整证明则未知", () => {
  const savedDetail = receipt({ operation_id: "op-d", status: "saved_detail_unavailable" });
  assert.equal(
    queryOperationOutcome([savedDetail], planned({ operation_id: "op-d" })).kind,
    "saved_detail_unavailable"
  );
  const invalid = receipt({
    operation_id: "op-d",
    status: "saved",
    effect: "committed",
    business_object_id: null,
  });
  assert.deepEqual(queryOperationOutcome([invalid], planned({ operation_id: "op-d" })), {
    kind: "unknown",
    reason: "invalid_success_proof",
  });
  assert.equal(receiptCanBeResent(savedDetail), false, "saved detail unavailable must not be resent");
});

check("R2 未知/进行中不得转换为未保存；确定失败才进重试路线", () => {
  const expected = planned({ operation_id: "op-x" });
  assert.deepEqual(queryOperationOutcome([], expected), { kind: "unknown", reason: "no_receipt" });
  assert.equal(
    queryOperationOutcome([receipt({ operation_id: "op-x", status: "in_progress", effect: "unknown" })], expected).kind,
    "in_progress"
  );
  assert.equal(
    itemsToResend([receipt({ operation_id: "op-x", status: "failed", effect: "committed" })]).length,
    0
  );
  assert.equal(
    itemsToResend([receipt({ operation_id: "op-x", status: "failed", effect: "none" })]).length,
    1
  );
});

check("R2 批准身份≠执行幂等身份：原操作未知只查原 operation_id", () => {
  const original = planned({ operation_id: "op-original", target_id: "child-a" });
  const receipts = [receipt({ operation_id: "op-original", target_id: "child-a" })];
  assert.equal(queryOperationOutcome(receipts, original).kind, "saved");
  const newIdentity = planned({ operation_id: "op-new", target_id: "child-a" });
  assert.deepEqual(queryOperationOutcome(receipts, newIdentity), {
    kind: "unknown",
    reason: "no_receipt",
  });
});

check("R2 历史只读图片统一为仅元数据（与聊天附件投影一致）", () => {
  const decision = decideImageReadAccess(
    {
      image_id: "image-1",
      uploader_account_id: "account-teacher-a",
      attached_records: [{ record_kind: "observation", record_id: "observation-1" }],
    },
    {
      account_id: "account-teacher-b",
      record_access: [
        { record_kind: "observation", record_id: "observation-1", projection: "historical_read_only" },
      ],
    }
  );
  assert.equal(decision.readable, false, "historical read-only must not expose bytes");
  assert.equal(decision.readable === false ? decision.metadata_only : null, true);
  assert.equal(decision.readable === false ? decision.reason : null, "historical_metadata_only");
  const chatProjection = projectChatMessage(
    chatMessage({
      fragments: [],
      attachment_ids: ["image-1"],
    }),
    { account_id: "account-teacher-a", role: "teacher" },
    [],
    [{ attachment_id: "image-1", access: "historical_read_only" }]
  );
  assert.equal(chatProjection.attachments[0]?.readable, false);
  assert.equal(chatProjection.attachments[0]?.metadata_only, true);
});

check("R2 图片关联身份按 record_kind + record_id 完整匹配", () => {
  const decision = decideImageReadAccess(
    {
      image_id: "image-1",
      uploader_account_id: "account-teacher-a",
      attached_records: [{ record_kind: "observation", record_id: "record-1" }],
    },
    {
      account_id: "account-teacher-b",
      record_access: [
        { record_kind: "proposal", record_id: "record-1", projection: "full" },
      ],
    }
  );
  assert.equal(decision.readable, false);
  assert.equal(decision.readable === false ? decision.reason : null, "attached_but_no_record_access");
});

check("R2 多引用结果不受遍历顺序影响", () => {
  const access = [
    { record_kind: "observation" as const, record_id: "record-a", projection: "historical_read_only" as const },
    { record_kind: "observation" as const, record_id: "record-b", projection: "full" as const },
  ];
  const viewer = { account_id: "account-teacher-b", record_access: access };
  const first = decideImageReadAccess(
    {
      image_id: "image-1",
      uploader_account_id: "account-teacher-a",
      attached_records: [
        { record_kind: "observation", record_id: "record-a" },
        { record_kind: "observation", record_id: "record-b" },
      ],
    },
    viewer
  );
  const second = decideImageReadAccess(
    {
      image_id: "image-1",
      uploader_account_id: "account-teacher-a",
      attached_records: [
        { record_kind: "observation", record_id: "record-b" },
        { record_kind: "observation", record_id: "record-a" },
      ],
    },
    viewer
  );
  assert.equal(
    first.readable && "projection" in first ? first.projection : null,
    "full",
    "best projection must win over traversal order"
  );
  assert.equal(
    second.readable && "projection" in second ? second.projection : null,
    "full",
    "best projection must win over traversal order"
  );
  const historicalOnly = decideImageReadAccess(
    {
      image_id: "image-2",
      uploader_account_id: "account-teacher-a",
      attached_records: [
        { record_kind: "observation", record_id: "record-a" },
        { record_kind: "observation", record_id: "record-b" },
      ],
    },
    {
      account_id: "account-teacher-b",
      record_access: access.map((entry) => ({ ...entry, projection: "historical_read_only" as const })),
    }
  );
  assert.equal(historicalOnly.readable, false);
  assert.equal(historicalOnly.readable === false ? historicalOnly.metadata_only : null, true);
});

check("R2 上传者已无业务权限/未知授权一律拒绝", () => {
  const attached = {
    image_id: "image-1",
    uploader_account_id: "account-teacher-a",
    attached_records: [{ record_kind: "observation" as const, record_id: "observation-1" }],
  };
  const uploaderWithoutAccess = decideImageReadAccess(attached, {
    account_id: "account-teacher-a",
    record_access: [],
  });
  assert.equal(uploaderWithoutAccess.readable, false);
  assert.equal(
    uploaderWithoutAccess.readable === false ? uploaderWithoutAccess.reason : null,
    "attached_but_no_record_access"
  );
  const unrelatedRecordAccess = decideImageReadAccess(attached, {
    account_id: "account-teacher-b",
    record_access: [
      { record_kind: "proposal", record_id: "proposal-1", projection: "full" },
    ],
  });
  assert.equal(unrelatedRecordAccess.readable, false);
});

/* ----------------------------------- 汇总 ----------------------------------- */

console.log(
  JSON.stringify({ passed, total, reference_only: true, failed: failedNames })
);
assert.equal(passed, total);
