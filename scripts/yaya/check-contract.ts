/**
 * YAYA0-CONTRACT 离线参考检查（reference_only）。
 *
 * 只读取契约类型与纯函数，验证草案内部自洽：
 * - 不连接数据库、不调用模型、不访问对象存储、不启动浏览器、不修改任何业务数据；
 * - 通过不等于运行时守门通过，不能替代 AUTH/事务/模型的真实验收。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-contract.ts
 */

import assert from "node:assert/strict";

import {
  evaluateApprovalReuse,
  isFormalEvidenceKind,
  isLegalToolCombination,
  itemsToResend,
  mayBecomeObservationRawText,
  mayDeleteImageWithChat,
  mayPurgeImage,
  projectChatMessage,
  publicSearchQueryAllowed,
  receiptClaimsSuccess,
  receiptForItem,
  receiptMatchesItem,
  requiresBusinessTarget,
  resolveUnresolvedOperation,
  roleCanUseTool,
  scopeFromClassIds,
  scopeIsSchoolWide,
  selectionIsResolved,
  summarizeReceipts,
  YAYA_CONTRACT_FROZEN,
  YAYA_CONTRACT_STATUS,
  YAYA_PAYLOAD_KINDS,
  YAYA_RAW_TEXT_IS_IMMUTABLE,
  type YayaApprovalBinding,
  type YayaApprovalContext,
  type YayaOperationReceipt,
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
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.classes",
    entry: "GET /api/classes、GET /api/classes?catalog=true（页面 /classes）",
    service: "scopedListClasses",
    auth: { kind: "scope_query" },
    phase: "read",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.class_detail",
    entry: "GET /api/classes/[id]（页面 /classes/[id]）",
    service: "scopedGetClass",
    auth: { kind: "action", action: "class.read", resource: "class" },
    phase: "read",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.child_class_context",
    entry: "GET /api/children/[id]/class-context",
    service: "class-context（enrollment 解析）",
    auth: { kind: "action", action: "child.read", resource: "child" },
    phase: "read",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.observations",
    entry: "GET /api/observations（页面 /observations）",
    service: "scopedListObservations",
    auth: { kind: "scope_query" },
    phase: "read",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.evidence_book",
    entry: "GET /api/children/[id]/evidence-book（页面 /children/[id]/evidence）",
    service: "loadChildEvidenceBook",
    auth: { kind: "action", action: "child.read", resource: "child" },
    phase: "read",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.evidence_overview",
    entry: "GET /api/classes/[id]/evidence-overview（页面 /classes/[id]/evidence）",
    service: "loadClassEvidenceOverview",
    auth: { kind: "action", action: "class.read", resource: "class" },
    phase: "read",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "query.guide_catalog",
    entry: "证据页内嵌目录（无独立 HTTP 接口）",
    service: "listGuideItems / getGuideItem / listEducationSuggestions",
    auth: { kind: "scope_query" },
    phase: "read",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "create_child",
    entry: "POST /api/children（页面 /children/new）",
    service: "createChild",
    auth: { kind: "action", action: "child.create_profile", resource: "class" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "create_observation",
    entry: "POST /api/observations（页面 /observations/new）",
    service: "createObservation",
    auth: { kind: "action", action: "observation.write", resource: "child" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "organize_observation",
    entry: "POST /api/observations/[id]/organize（Review 页）",
    service: "processObservationAgent（写 ai_draft/agent_context）",
    auth: { kind: "action", action: "observation.organize", resource: "observation" },
    phase: "prepare",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "follow_up_observation",
    entry: "POST /api/observations/[id]/follow-up（Review 页）",
    service: "appendFollowUpAction + processObservationAgent",
    auth: { kind: "action", action: "observation.organize", resource: "observation" },
    phase: "prepare",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "confirm_observation",
    entry: "POST /api/observations/[id]/confirm（Review 页归档）",
    service: "confirmObservation（含 guide_decisions 同事务）",
    auth: { kind: "action", action: "observation.confirm", resource: "observation" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "guide_decide",
    entry: "POST /api/observations/[id]/guide-evidence（suggest/confirm/reject/withdraw）",
    service: "applyGuideEvidenceMutation / saveGuideEvidenceSuggestionResult",
    auth: { kind: "action", action: "guide.decide", resource: "observation" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "refresh_growth_profile",
    entry: "POST /api/children/[id]/growth-profile",
    service: "updateGrowthProfileAfterConfirmation",
    auth: { kind: "action", action: "growth_profile.write", resource: "child" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "refresh_activity_support",
    entry: "POST /api/children/[id]/activity-support",
    service: "updateActivitySupport",
    auth: { kind: "action", action: "activity_support.write", resource: "child" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.create_class",
    entry: "POST /api/classes（页面 /classes）",
    service: "createClass",
    auth: { kind: "action", action: "class.manage", resource: "class" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.update_class",
    entry: "PATCH /api/classes/[id]（页面 /classes/[id]）",
    service: "updateClass",
    auth: { kind: "action", action: "class.manage", resource: "class" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.transfer_child",
    entry: "POST /api/classes/[id]/children（幼儿页转班对话框）",
    service: "enrollChildInClass",
    auth: { kind: "action", action: "child.transfer", resource: "transfer" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_create",
    entry: "POST /api/admin/teachers（页面 /admin/teachers；密码走安全控件）",
    service: "createTeacherWithAssignments",
    auth: { kind: "action", action: "teacher.manage", resource: "school" },
    phase: "commit",
    secret_input: "secure_control",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_set_status",
    entry: "PATCH /api/admin/teachers/[id]（页面 /admin/teachers）",
    service: "setTeacherStatus",
    auth: { kind: "action", action: "teacher.manage", resource: "school" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_password_reset",
    entry: "POST /api/admin/teachers/[id]/password-reset（密码走安全控件）",
    service: "resetTeacherPassword",
    auth: { kind: "action", action: "teacher.manage", resource: "school" },
    phase: "commit",
    secret_input: "secure_control",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_assign",
    entry: "POST /api/admin/teachers/[id]/assignments",
    service: "assignTeacherClass",
    auth: { kind: "action", action: "teacher.assign", resource: "class" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
  {
    tool_id: "admin.teacher_unassign",
    entry: "DELETE /api/admin/teachers/[id]/assignments/[classId]",
    service: "unassignTeacherClass",
    auth: { kind: "action", action: "teacher.assign", resource: "class" },
    phase: "commit",
    secret_input: "none",
    implemented: true,
  },
];

/* --------------------------------- 检查设施 --------------------------------- */

let passed = 0;
let total = 0;

function check(name: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}`);
    throw error;
  }
}

function toolAuth(toolId: string): YayaToolAuth {
  const tool = TOOLS.find((candidate) => candidate.tool_id === toolId);
  assert.ok(tool, `reference tool missing: ${toolId}`);
  return tool.auth;
}

function approvalBinding(overrides: Partial<YayaApprovalBinding> = {}): YayaApprovalBinding {
  return {
    approval_id: "approval-1",
    proposal_id: "proposal-1",
    operation_id: "op-1",
    origin: "teacher_action",
    actor_account_id: "account-teacher-a",
    session_id: "session-1",
    auth: toolAuth("confirm_observation"),
    target_id: "observation-1",
    item_keys: ["item-1"],
    content_digest: "digest-v1",
    attachment_refs: ["image-1"],
    business_revision: "guide-rev-7",
    approved_at: "2026-10-05T08:00:00.000Z",
    cancelled: false,
    ...overrides,
  };
}

function approvalContext(overrides: Partial<YayaApprovalContext> = {}): YayaApprovalContext {
  return {
    origin: "teacher_action",
    actor_account_id: "account-teacher-a",
    session_id: "session-1",
    session_valid: true,
    account_active: true,
    role: "teacher",
    scope: { kind: "classes", class_ids: ["class-a"] },
    target_current_class_id: "class-a",
    content_digest: "digest-v1",
    attachment_refs: ["image-1"],
    business_revision: "guide-rev-7",
    ...overrides,
  };
}

function receipt(overrides: Partial<YayaOperationReceipt> = {}): YayaOperationReceipt {
  return {
    operation_id: "op-1",
    proposal_id: "proposal-1",
    item_key: "child-a",
    target_id: "child-a",
    status: "saved",
    business_object_id: "observation-a",
    business_revision: "guide-rev-8",
    recorded_at: "2026-10-05T08:00:01.000Z",
    ...overrides,
  };
}

function reasonsOf(checkResult: ReturnType<typeof evaluateApprovalReuse>): readonly string[] {
  return checkResult.ok ? [] : checkResult.reasons;
}

/* --------------------------------- 反例断言 --------------------------------- */

check("草案标记 reference_only 且未冻结（TECH0 未交付）", () => {
  assert.equal(YAYA_CONTRACT_STATUS, "reference_only");
  assert.equal(YAYA_CONTRACT_FROZEN, false);
});

check("覆盖表无虚构入口：所有 action/resource 组合均合法", () => {
  for (const tool of TOOLS) {
    assert.ok(
      isLegalToolCombination(tool.auth),
      `illegal combination registered: ${tool.tool_id}`
    );
  }
});

check("管理员教学禁止：管理工具可用，教学/整理/确认/决定/小结/支持一律拒绝", () => {
  const teachingTools = [
    "create_observation",
    "organize_observation",
    "follow_up_observation",
    "confirm_observation",
    "guide_decide",
    "refresh_growth_profile",
    "refresh_activity_support",
  ] as const;
  for (const toolId of teachingTools) {
    assert.equal(roleCanUseTool("admin", toolAuth(toolId)), false, `${toolId} must deny admin`);
  }
  const adminTools = [
    "create_child",
    "admin.create_class",
    "admin.update_class",
    "admin.transfer_child",
    "admin.teacher_create",
    "admin.teacher_set_status",
    "admin.teacher_password_reset",
    "admin.teacher_assign",
    "admin.teacher_unassign",
  ] as const;
  for (const toolId of adminTools) {
    assert.equal(roleCanUseTool("admin", toolAuth(toolId)), true, `${toolId} must allow admin`);
  }
  assert.equal(roleCanUseTool("teacher", toolAuth("confirm_observation")), true);
  assert.equal(roleCanUseTool("teacher", toolAuth("admin.teacher_create")), true);
});

check("空任教≠全园：空数组是 none，非空也不等于 school", () => {
  const empty = scopeFromClassIds([]);
  assert.equal(empty.kind, "none");
  assert.equal(scopeIsSchoolWide(empty), false);
  const classes = scopeFromClassIds(["class-a"]);
  assert.equal(classes.kind, "classes");
  assert.equal(scopeIsSchoolWide(classes), false);
});

check("同班教师不共享聊天：非本人会话一律 hidden", () => {
  const message = {
    message_id: "message-1",
    owner_account_id: "account-teacher-a",
    session_id: "session-a",
    target_child_id: "child-a",
    target_class_id: "class-a",
    attachment_refs: ["image-1"],
  };
  const teacherBViewer = {
    account_id: "account-teacher-b",
    role: "teacher" as const,
    scope: { kind: "classes", class_ids: ["class-a"] } as const,
    reachable_child_ids: ["child-a"],
  };
  const projection = projectChatMessage(message, teacherBViewer);
  assert.equal(projection.visibility, "hidden");
  assert.equal(projection.body_facts_readable, false);
  assert.equal(projection.attachments_readable, false);
});

check("修改批准内容失效：内容摘要变化 → content_changed", () => {
  const result = evaluateApprovalReuse(
    approvalBinding(),
    approvalContext({ content_digest: "digest-v2" })
  );
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("content_changed"));
});

check("附件关系变化失效：附件集合变化 → attachments_changed", () => {
  const result = evaluateApprovalReuse(
    approvalBinding(),
    approvalContext({ attachment_refs: ["image-1", "image-2"] })
  );
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("attachments_changed"));
});

check("换 session 不沿用批准：新登录会话 → session_changed", () => {
  const result = evaluateApprovalReuse(
    approvalBinding(),
    approvalContext({ session_id: "session-2" })
  );
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("session_changed"));
});

check("转班/撤权不沿用批准：当前归属移出范围 → scope_changed", () => {
  const transferred = evaluateApprovalReuse(
    approvalBinding(),
    approvalContext({ target_current_class_id: "class-b" })
  );
  assert.equal(transferred.ok, false);
  assert.ok(reasonsOf(transferred).includes("scope_changed"));
  const revoked = evaluateApprovalReuse(
    approvalBinding(),
    approvalContext({ scope: { kind: "none" } })
  );
  assert.equal(revoked.ok, false);
  assert.ok(reasonsOf(revoked).includes("empty_scope"));
  assert.ok(reasonsOf(revoked).includes("scope_changed"));
});

check("停用账号/停止批准不沿用：disabled / cancelled 均拒绝", () => {
  const disabled = evaluateApprovalReuse(
    approvalBinding(),
    approvalContext({ account_active: false })
  );
  assert.equal(disabled.ok, false);
  assert.ok(reasonsOf(disabled).includes("account_disabled"));
  const cancelled = evaluateApprovalReuse(
    approvalBinding({ cancelled: true }),
    approvalContext()
  );
  assert.equal(cancelled.ok, false);
  assert.ok(reasonsOf(cancelled).includes("approval_cancelled"));
});

check("模型生成 approved 无效：model_suggestion 即使内容全同也不构成批准", () => {
  const modelBinding = approvalBinding({ origin: "model_suggestion" });
  const result = evaluateApprovalReuse(modelBinding, approvalContext());
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("model_approval_not_binding"));
  const modelContext = approvalContext({ origin: "model_suggestion" });
  const result2 = evaluateApprovalReuse(approvalBinding(), modelContext);
  assert.equal(result2.ok, false);
  assert.ok(reasonsOf(result2).includes("model_approval_not_binding"));
});

check("原文/工具结果中的指令不能提权：角色与批准判定只来自服务端事实", () => {
  assert.equal(roleCanUseTool("admin", toolAuth("confirm_observation")), false);
  const result = evaluateApprovalReuse(
    approvalBinding({ actor_account_id: "account-admin" }),
    approvalContext({ actor_account_id: "account-admin", role: "admin" })
  );
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("role_not_allowed"));
});

check("业务版本变化失效：guide 容器 revision 不一致 → business_version_changed", () => {
  const result = evaluateApprovalReuse(
    approvalBinding(),
    approvalContext({ business_revision: "guide-rev-8" })
  );
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes("business_version_changed"));
});

check("完整一致时批准可复用：全部绑定一致才 ok", () => {
  const result = evaluateApprovalReuse(approvalBinding(), approvalContext());
  assert.equal(result.ok, true);
});

check("两人不同事实不串档：回执按 item_key + target 同时匹配", () => {
  const plans = [
    { item_key: "item-child-a", target_id: "child-a" },
    { item_key: "item-child-b", target_id: "child-b" },
  ] as const;
  const receipts = [
    receipt({ item_key: "item-child-a", target_id: "child-a", business_object_id: "observation-a" }),
    receipt({
      item_key: "item-child-b",
      target_id: "child-b",
      status: "failed",
      business_object_id: null,
    }),
  ];
  const a = receiptForItem(receipts, "item-child-a");
  const b = receiptForItem(receipts, "item-child-b");
  assert.ok(a);
  assert.ok(b);
  assert.equal(receiptMatchesItem(a, plans[0]), true);
  assert.equal(receiptMatchesItem(a, plans[1]), false);
  assert.equal(receiptMatchesItem(b, plans[0]), false);
  assert.equal(a.target_id, "child-a");
  assert.equal(b.target_id, "child-b");
});

check("部分成功不重发：只重试明确失败项，成功项与待核对项都不重发", () => {
  const receipts = [
    receipt({ item_key: "item-child-a", target_id: "child-a", status: "saved" }),
    receipt({ item_key: "item-child-b", target_id: "child-b", status: "failed" }),
    receipt({ item_key: "item-child-c", target_id: "child-c", status: "needs_verification" }),
    receipt({ item_key: "item-child-d", target_id: "child-d", status: "conflict" }),
  ];
  const summary = summarizeReceipts(receipts);
  assert.equal(summary.total, 4);
  assert.equal(summary.saved, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.needs_verification, 1);
  assert.equal(summary.conflict, 1);
  assert.equal(summary.all_saved, false);
  const resend = itemsToResend(receipts);
  assert.equal(resend.length, 1);
  assert.equal(resend[0]?.item_key, "item-child-b");
});

check("未知回执不假成功：无回执 → needs_verification，绝不显示 saved", () => {
  const resolution = resolveUnresolvedOperation([], "op-lost");
  assert.equal(resolution.kind, "needs_verification");
  assert.equal(receiptClaimsSuccess("needs_verification"), false);
  const replay = resolveUnresolvedOperation(
    [receipt({ operation_id: "op-lost", status: "saved" })],
    "op-lost"
  );
  assert.equal(replay.kind, "replay_receipt");
  assert.equal(receiptClaimsSuccess("failed"), false);
  assert.equal(receiptClaimsSuccess("conflict"), false);
});

check("重复提交幂等：已有同 operation_id 回执时按回执重放，不再次执行", () => {
  const receipts = [receipt({ operation_id: "op-dup", status: "saved" })];
  const resolution = resolveUnresolvedOperation(receipts, "op-dup");
  assert.equal(resolution.kind, "replay_receipt");
});

check("图像解读不冒充原文：image_interpretation 既不格式证据也不成为 raw_text", () => {
  assert.equal(isFormalEvidenceKind("image_interpretation"), false);
  assert.equal(isFormalEvidenceKind("model_text"), false);
  assert.equal(isFormalEvidenceKind("public_web"), false);
  assert.equal(isFormalEvidenceKind("guide_catalog"), false);
  assert.equal(isFormalEvidenceKind("child_fact"), true);
  assert.equal(mayBecomeObservationRawText("image_interpretation"), false);
  assert.equal(mayBecomeObservationRawText("teacher_supplement"), false);
  assert.equal(mayBecomeObservationRawText("model_text"), false);
  assert.equal(mayBecomeObservationRawText("raw_input"), true);
});

check("raw_text 不可改写：payload 联合没有更新原文的 kind", () => {
  assert.equal(YAYA_RAW_TEXT_IS_IMMUTABLE, true);
  for (const kind of YAYA_PAYLOAD_KINDS) {
    assert.equal(kind.includes("raw_text"), false, `payload kind must not edit raw_text: ${kind}`);
    assert.equal(kind.startsWith("update_"), false, `payload kind must not update records: ${kind}`);
  }
  assert.equal(YAYA_PAYLOAD_KINDS.includes("create_observation"), true);
});

check("撤销后消息投影：仍属本人但幼儿已不可达 → 仅元数据且附件不可读", () => {
  const message = {
    message_id: "message-2",
    owner_account_id: "account-teacher-a",
    session_id: "session-1",
    target_child_id: "child-x",
    target_class_id: "class-a",
    attachment_refs: ["image-9"],
  };
  const viewer = {
    account_id: "account-teacher-a",
    role: "teacher" as const,
    scope: { kind: "classes", class_ids: ["class-b"] } as const,
    reachable_child_ids: [],
  };
  const projection = projectChatMessage(message, viewer);
  assert.equal(projection.visibility, "metadata_only");
  assert.equal(projection.body_facts_readable, false);
  assert.equal(projection.attachments_readable, false);
  assert.equal(projection.execution_allowed, false);
});

check("删除聊天与档案图片分离：被档案引用的图片不随聊天删除/清空", () => {
  const referenced = {
    image_id: "image-1",
    referenced_by_archived_records: true,
    referenced_by_chat_messages: true,
  };
  assert.equal(mayDeleteImageWithChat(referenced), false);
  assert.equal(mayPurgeImage(referenced), false);
  const chatOnly = {
    image_id: "image-2",
    referenced_by_archived_records: false,
    referenced_by_chat_messages: true,
  };
  assert.equal(mayDeleteImageWithChat(chatOnly), true);
  assert.equal(mayPurgeImage(chatOnly), false);
});

check("密码仅安全控件：覆盖表标注 secure_control，且聊天 payload 无密码字段", () => {
  const secureTools = TOOLS.filter((tool) => tool.secret_input === "secure_control");
  assert.deepEqual(
    secureTools.map((tool) => tool.tool_id).sort(),
    ["admin.teacher_create", "admin.teacher_password_reset"]
  );
  for (const tool of secureTools) {
    assert.equal(tool.phase, "commit");
    assert.equal(roleCanUseTool("admin", tool.auth), true);
    assert.ok(tool.entry.includes("安全控件"), `${tool.tool_id} must collect secret via secure control`);
  }
  assert.equal(
    YAYA_PAYLOAD_KINDS.some((kind) => kind.includes("password")),
    false
  );
});

check("公开检索不带幼儿识别信息；通用问答不强制选对象", () => {
  assert.equal(publicSearchQueryAllowed({ has_child_identifiers: true }), false);
  assert.equal(publicSearchQueryAllowed({ has_child_identifiers: false }), true);
  assert.equal(requiresBusinessTarget(null), false);
  assert.equal(requiresBusinessTarget(toolAuth("query.children")), true);
});

check("候选歧义必须显式选择：required 且未选 → 未解决", () => {
  const unresolved = {
    required: true,
    candidates: [
      { candidate_kind: "child" as const, candidate_id: "child-a", label: "小雨" },
      { candidate_kind: "child" as const, candidate_id: "child-b", label: "小雨" },
    ],
    selected_id: null,
  };
  assert.equal(selectionIsResolved(unresolved), false);
  assert.equal(selectionIsResolved({ ...unresolved, selected_id: "child-b" }), true);
  assert.equal(selectionIsResolved({ ...unresolved, required: false }), true);
});

check("准备态不等于正式记录：organize/follow-up 不提交 commit，确认与决定了才 commit", () => {
  const organize = TOOLS.find((tool) => tool.tool_id === "organize_observation");
  const followUp = TOOLS.find((tool) => tool.tool_id === "follow_up_observation");
  const confirm = TOOLS.find((tool) => tool.tool_id === "confirm_observation");
  const guide = TOOLS.find((tool) => tool.tool_id === "guide_decide");
  assert.equal(organize?.phase, "prepare");
  assert.equal(followUp?.phase, "prepare");
  assert.equal(confirm?.phase, "commit");
  assert.equal(guide?.phase, "commit");
  const previewOnly = summarizeReceipts([]);
  assert.equal(previewOnly.all_saved, false);
});

/* ----------------------------------- 汇总 ----------------------------------- */

console.log(JSON.stringify({ passed, total, reference_only: true }));
assert.equal(passed, total);
