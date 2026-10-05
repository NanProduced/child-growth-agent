/**
 * YAYA-DATA1 反例检查（纯函数 + 可注入替身，不连数据库、不调模型）。
 *
 * 本文件先行：它在存储层实现之前编写并实际运行（RED，模块不存在），
 * 实现完成后复跑为 GREEN。这里的每条 check 对应 DATA1 必达边界的一个反例：
 * 他人会话/标题泄漏、跨 session 批准、批准后改内容、同权转班、响应丢失原 ID 恢复、
 * 幂等读回无 owner、替代与旧消费交错、回执失败整单回滚（DB 层在 check-data-db.ts）、
 * 部分批次、删除与新引用交错。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  compareBatchReceipts,
  decideImageRetention,
  evaluateApprovalExecution,
  itemsToResend,
  projectChatMessage,
  projectConversationTitle,
  queryOperationOutcome,
  receiptProvesSuccess,
  type YayaApprovalBinding,
  type YayaApprovalItemRef,
  type YayaApprovalSubmitter,
  type YayaChatMessageRef,
  type YayaDomainPayload,
  type YayaFragmentProjection,
  type YayaOperationReceipt,
  type YayaPlannedOperation,
} from "../../src/lib/yaya/types";
import type { Principal } from "../../src/lib/accounts/types";
import {
  attachmentLeaseTransition,
  checkConversationRevision,
  guardBusinessWriteResult,
  guardExecutionAgainstOperation,
  normalizeApprovalAction,
  operationOwnedBy,
  operationSupersedeEligibility,
  planConversationAttachmentRefs,
  projectStoredMessageText,
  receiptRowToReceipt,
  resolveClientMessageReplay,
  validateMessageAttachments,
  validatePrepareItems,
  verifyItemDigest,
  type YayaPrepareItemValidationInput,
} from "../../src/lib/yaya/data/invariants";
import {
  YAYA_APPROVAL_TTL_SECONDS,
  YAYA_ATTACHMENT_STATUSES,
  computeYayaContentDigest,
  YayaDataError,
  type YayaStoredFragment,
} from "../../src/lib/yaya/storage-types";

let passed = 0;
const failures: string[] = [];
function check(name: string, run: () => void): void {
  try {
    run();
    passed++;
  } catch (error: unknown) {
    failures.push(name);
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const teacher: Principal = {
  account_id: "acct-teacher",
  username: "teacher-a",
  display_name: "教师甲",
  role: "teacher",
  account_status: "active",
  scope: { kind: "classes", class_ids: ["class-a", "class-b"] },
};

const createPayload: YayaDomainPayload = {
  kind: "create_observation",
  child_id: "child-1",
  observed_at: "2026-10-05",
  raw_text: "幼儿把积木放在一起。",
  context: null,
  confirmed_class_id: null,
  image_ids: ["att-1"],
  source_input: null,
};

/* ------------------------------ 内容 digest ------------------------------ */

const digestInput = {
  payload: createPayload,
  action: "observation.write" as const,
  resource: "child" as const,
  target_id: "child-1",
  attachment_associations: [
    { attachment_id: "att-2", target_id: "child-1" },
    { attachment_id: "att-1", target_id: "child-1" },
  ],
};

check("digest 与附件顺序无关但对内容敏感", () => {
  const original = computeYayaContentDigest(digestInput);
  const reordered = computeYayaContentDigest({
    ...digestInput,
    attachment_associations: [...digestInput.attachment_associations].reverse(),
  });
  assert.equal(original, reordered);
  const changed = computeYayaContentDigest({
    ...digestInput,
    payload: { ...createPayload, raw_text: "改了原文。" },
  });
  assert.notEqual(original, changed);
  assert.match(original, /^[0-9a-f]{64}$/);
});

check("重复附件、undefined 与非有限数字不得进入 digest", () => {
  assert.throws(
    () =>
      computeYayaContentDigest({
        ...digestInput,
        attachment_associations: [
          { attachment_id: "att-1", target_id: "child-1" },
          { attachment_id: "att-1", target_id: "child-1" },
        ],
      }),
    (error: unknown) => error instanceof YayaDataError && error.code === "invalid_request"
  );
  assert.throws(() =>
    computeYayaContentDigest({
      ...digestInput,
      payload: { kind: "create_observation", child_id: "child-1", observed_at: "2026-10-05", raw_text: undefined as unknown as string, context: null, confirmed_class_id: null, image_ids: [], source_input: null },
    })
  );
  assert.throws(() =>
    computeYayaContentDigest({
      ...digestInput,
      payload: { kind: "create_observation", child_id: "child-1", observed_at: "2026-10-05", raw_text: "x", context: null, confirmed_class_id: null, image_ids: [], source_input: Number.NaN as unknown as null },
    })
  );
});

/* ------------------------------ prepare 校验 ------------------------------ */

function prepareItem(overrides: Partial<YayaPrepareItemValidationInput> = {}): YayaPrepareItemValidationInput {
  return {
    item_key: "item-1",
    target_id: "child-1",
    action: "observation.write",
    resource: "child",
    resource_ref: { kind: "child", child_id: "child-1" },
    content_digest: "a".repeat(64),
    attachment_associations: [{ attachment_id: "att-1", target_id: "child-1" }],
    payload: createPayload,
    ...overrides,
  };
}

check("空白业务 ID 与重复 item_key 必须先拒绝", () => {
  assert.deepEqual(validatePrepareItems([prepareItem({ target_id: "   " })]), ["blank_target_id"]);
  assert.deepEqual(validatePrepareItems([prepareItem({ item_key: " " })]), ["blank_item_key"]);
  const duplicated = validatePrepareItems([
    prepareItem(),
    prepareItem({ target_id: "child-2", resource_ref: { kind: "child", child_id: "child-2" } }),
  ]);
  assert.deepEqual(duplicated, ["duplicate_item_key"]);
  assert.deepEqual(validatePrepareItems([]), ["empty_items"]);
});

check("非法动作/资源组合与 ref 类型错配不得进入 prepare", () => {
  assert.deepEqual(
    validatePrepareItems([prepareItem({ action: "observation.confirm", resource: "child" })]),
    ["illegal_combination"]
  );
  assert.deepEqual(
    validatePrepareItems([
      prepareItem({ resource_ref: { kind: "class", class_id: "class-a" } }),
    ]),
    ["resource_ref_mismatch"]
  );
  assert.deepEqual(
    validatePrepareItems([
      prepareItem({ action: "child.transfer", resource: "transfer", resource_ref: { kind: "transfer", child_id: "child-1", target_class_id: "class-b" } }),
    ]),
    []
  );
  assert.deepEqual(
    validatePrepareItems([
      prepareItem({ action: "child.transfer", resource: "transfer", resource_ref: { kind: "transfer", child_id: "child-1", target_class_id: "  " } }),
    ]),
    ["blank_target_class"]
  );
});

check("服务端 digest 覆盖请求体自报值（篡改无法进入准备态）", () => {
  const item = prepareItem({ content_digest: "f".repeat(64) });
  const serverDigest = computeYayaContentDigest({
    payload: item.payload,
    action: item.action,
    resource: item.resource,
    target_id: item.target_id,
    attachment_associations: item.attachment_associations,
  });
  assert.notEqual(serverDigest, item.content_digest);
  assert.equal(verifyItemDigest(item, serverDigest), "digest_mismatch");
  assert.equal(verifyItemDigest({ ...item, content_digest: serverDigest }, serverDigest), "ok");
});

/* ------------------------------ 批准与快照 ------------------------------ */

const approvalItem: YayaApprovalItemRef = {
  item_key: "item-1",
  operation_id: "op-1",
  action: "observation.confirm",
  resource: "observation",
  target_id: "obs-1",
  resource_facts_at_approval: {
    kind: "observation",
    observation_id: "obs-1",
    child_id: "child-1",
    current_class_id: "class-a",
    observed_class_id: "class-a",
    author_account_id: "acct-teacher",
  },
  content_digest: "digest-1",
  attachment_associations: [],
  business_revision: null,
};

const binding: YayaApprovalBinding = {
  approval_id: "approval-1",
  batch_id: "batch-1",
  proposal_id: "proposal-1",
  proposal_origin: "teacher_card",
  approval_source: "authenticated_entry",
  actor_account_id: "acct-teacher",
  session_id: "session-1",
  items: [approvalItem],
  approved_at: "2026-10-05T08:00:00.000Z",
  expires_at: null,
  cancelled_at: null,
};

function submitter(overrides: Partial<YayaApprovalSubmitter> = {}): YayaApprovalSubmitter {
  return {
    identity_state: "authenticated",
    principal: teacher,
    session_id: "session-1",
    session_valid: true,
    csrf_verified: true,
    runtime_approved_state: true,
    execution_at: "2026-10-05T09:00:00.000Z",
    ...overrides,
  };
}

function execution(overrides: Partial<Parameters<typeof evaluateApprovalExecution>[2][number]> = {}) {
  return [
    {
      item_key: "item-1",
      operation_id: "op-1",
      resource_facts: approvalItem.resource_facts_at_approval,
      content_digest: "digest-1",
      attachment_associations: [],
      business_revision: null,
      ...overrides,
    },
  ];
}

check("跨 session 批准拒绝", () => {
  const result = evaluateApprovalExecution(binding, submitter({ session_id: "session-2" }), execution());
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reasons.includes("session_changed"));
});

check("批准后改内容拒绝", () => {
  const result = evaluateApprovalExecution(binding, submitter(), execution({ content_digest: "digest-2" }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reasons.includes("content_changed"));
});

check("同权转班（A→B 仍在范围）拒绝", () => {
  const result = evaluateApprovalExecution(
    binding,
    submitter(),
    execution({
      resource_facts: {
        kind: "observation",
        observation_id: "obs-1",
        child_id: "child-1",
        current_class_id: "class-b",
        observed_class_id: "class-a",
        author_account_id: "acct-teacher",
      },
    })
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reasons.includes("attribution_changed"));
});

check("取消/过期/停用不沿用批准", () => {
  const cancelled = evaluateApprovalExecution({ ...binding, cancelled_at: "2026-10-05T08:30:00.000Z" }, submitter(), execution());
  assert.ok(!cancelled.ok && cancelled.reasons.includes("approval_cancelled"));
  const expired = evaluateApprovalExecution(
    { ...binding, expires_at: "2026-10-05T08:30:00.000Z" },
    submitter(),
    execution()
  );
  assert.ok(!expired.ok && expired.reasons.includes("approval_expired"));
});

check("操作身份缺项/错配/多出都拒绝", () => {
  const missing = evaluateApprovalExecution(binding, submitter(), []);
  assert.ok(!missing.ok && missing.reasons.includes("missing_item"));
  const mismatch = evaluateApprovalExecution(binding, submitter(), execution({ operation_id: "op-9" }));
  assert.ok(!mismatch.ok && mismatch.reasons.includes("operation_id_mismatch"));
  const unexpected = evaluateApprovalExecution(
    binding,
    submitter(),
    [...execution(), { ...execution()[0], item_key: "extra", operation_id: "op-extra" }]
  );
  assert.ok(!unexpected.ok && unexpected.reasons.includes("unexpected_item"));
});

check("批准请求体不得携带 approved/Principal/scope 自报字段", () => {
  const normalized = normalizeApprovalAction({
    action: "approve",
    operation_ids: ["op-1", "op-2"],
    approved: true,
    approval_source: "authenticated_entry",
    principal: { account_id: "attacker" },
    actor_account_id: "attacker",
    scope: "school",
    resource_facts_at_approval: { kind: "school" },
    content_digest: "forged",
  });
  assert.deepEqual(normalized, { action: "approve", operation_ids: ["op-1", "op-2"] });
  assert.throws(
    () => normalizeApprovalAction({ action: "approve", operation_ids: [] }),
    (error: unknown) => error instanceof YayaDataError && error.code === "invalid_request"
  );
  assert.throws(() => normalizeApprovalAction({ action: "commit", operation_ids: ["op-1"] }));
  assert.throws(() => normalizeApprovalAction({ action: "reject", operation_ids: ["op-1", "op-1"] }));
  assert.throws(() => normalizeApprovalAction(null));
  const cancel = normalizeApprovalAction({ action: "cancel", approved: true });
  assert.deepEqual(cancel, { action: "cancel", operation_ids: [] });
});

/* ------------------------------ 会话、消息与标题 ------------------------------ */

const restrictedFragments: YayaChatMessageRef["fragments"] = [
  { fragment_id: "f-1", sources: [{ kind: "child", child_id: "child-1", current_class_id: "class-a" }], independently_readable: true },
];

check("他人会话的消息与标题一律隐藏（管理员也不例外）", () => {
  const message: YayaChatMessageRef = {
    message_id: "msg-1",
    owner_account_id: "acct-teacher",
    session_id: "chat-session-1",
    created_at: "2026-10-05T08:00:00.000Z",
    message_kind: "text",
    execution_state: "none",
    fragments: restrictedFragments,
    attachment_ids: ["att-1"],
  };
  const otherViewer = { account_id: "acct-admin", role: "admin" as const };
  const projected = projectChatMessage(message, otherViewer, [], []);
  assert.equal(projected.visibility, "hidden");
  assert.equal(projected.metadata, null);
  assert.equal(projected.execution_allowed, false);
  const title = projectConversationTitle(
    { title: "小满午睡观察", derived_from_fragment_ids: ["f-1"] },
    projected.fragments,
    "受限会话"
  );
  assert.deepEqual(title, { title: "受限会话", restricted: true });
});

check("来源非 full 时标题回退且历史片段正文不外泄", () => {
  const display: YayaFragmentProjection[] = [
    { fragment_id: "f-1", visibility: "historical_read_only", reason: "ok" },
  ];
  assert.deepEqual(
    projectConversationTitle({ title: "小满午睡观察", derived_from_fragment_ids: ["f-1"] }, display),
    { title: "受限会话", restricted: true }
  );
  assert.deepEqual(
    projectConversationTitle({ title: "通用标题", derived_from_fragment_ids: [] }, display),
    { title: "通用标题", restricted: false }
  );
  const fragments: YayaStoredFragment[] = [
    { fragment_id: "f-1", text: "完整正文", sources: [], independently_readable: true, provenance: { kind: "raw_input", ref_id: null, label: null, derived_from: null } },
    { fragment_id: "f-2", text: "历史正文", sources: [], independently_readable: true, provenance: { kind: "child_fact", ref_id: "obs-1", label: null, derived_from: null } },
  ];
  const visible = projectStoredMessageText(fragments, [
    { fragment_id: "f-1", visibility: "full", reason: "ok" },
    { fragment_id: "f-2", visibility: "historical_read_only", reason: "ok" },
  ]);
  assert.deepEqual(visible, [
    { fragment_id: "f-1", visibility: "full", text: "完整正文" },
    { fragment_id: "f-2", visibility: "historical_read_only", text: null },
  ]);
});

check("client_message_id 幂等：同摘要回放，不同摘要冲突", () => {
  assert.equal(resolveClientMessageReplay(null, "d1"), "insert");
  assert.equal(resolveClientMessageReplay({ content_digest: "d1" }, "d1"), "replay");
  assert.equal(resolveClientMessageReplay({ content_digest: "d1" }, "d2"), "idempotency_conflict");
});

check("会话版本前提不一致时拒绝追加", () => {
  assert.equal(checkConversationRevision(5, 5), "ok");
  assert.equal(checkConversationRevision(6, 5), "revision_conflict");
});

check("消息附件必须 ready 且属于消息 owner", () => {
  assert.deepEqual(
    validateMessageAttachments("acct-teacher", [
      { attachment_id: "att-1", uploader_account_id: "acct-teacher", status: "ready" },
    ]),
    []
  );
  assert.deepEqual(
    validateMessageAttachments("acct-teacher", [
      { attachment_id: "att-1", uploader_account_id: "acct-other", status: "ready" },
    ]),
    ["attachment_owner_mismatch:att-1"]
  );
  assert.deepEqual(
    validateMessageAttachments("acct-teacher", [
      { attachment_id: "att-1", uploader_account_id: "acct-teacher", status: "deleting" },
    ]),
    ["attachment_conflict:att-1"]
  );
  assert.deepEqual(
    validateMessageAttachments("acct-teacher", [
      { attachment_id: "att-1", uploader_account_id: "acct-teacher", status: "absent" },
    ]),
    ["attachment_missing:att-1"]
  );
});

/* ------------------------------ 回执与幂等读回 ------------------------------ */

const planned: YayaPlannedOperation = {
  batch_id: "batch-1",
  proposal_id: "proposal-1",
  item_key: "item-1",
  operation_id: "op-1",
  target_id: "child-1",
  actor_account_id: "acct-teacher",
};

const savedReceipt: YayaOperationReceipt = {
  ...planned,
  status: "saved",
  effect: "committed",
  business_object_id: "observation-1",
  business_revision: "rev-1",
  recorded_at: "2026-10-05T08:00:00.000Z",
};

check("响应丢失按原 operation_id 恢复：成功只读回执，不重发", () => {
  const outcome = queryOperationOutcome([savedReceipt], planned);
  assert.equal(outcome.kind, "saved");
  assert.equal(itemsToResend([planned], [savedReceipt]).length, 0);
  const noReceipt = queryOperationOutcome([], planned);
  assert.deepEqual(noReceipt, { kind: "unknown", reason: "no_receipt" });
  assert.equal(itemsToResend([planned], []).length, 0);
});

check("幂等读回先验 owner；未知效果/空白业务 ID 不假成功", () => {
  assert.equal(operationOwnedBy("acct-teacher", "acct-teacher"), true);
  assert.equal(operationOwnedBy("acct-teacher", "acct-other"), false);
  assert.equal(
    receiptProvesSuccess({ ...savedReceipt, effect: "unknown" }),
    false
  );
  assert.equal(receiptProvesSuccess({ ...savedReceipt, business_object_id: "   " }), false);
  assert.equal(
    queryOperationOutcome([{ ...savedReceipt, business_object_id: null }], planned).kind,
    "unknown"
  );
  assert.equal(receiptRowToReceipt(null), null);
});

check("部分批次逐项回执、不因缺失项全成功", () => {
  const second: YayaPlannedOperation = { ...planned, item_key: "item-2", operation_id: "op-2", target_id: "child-2" };
  const comparison = compareBatchReceipts([planned, second], [savedReceipt]);
  assert.equal(comparison.all_saved, false);
  assert.deepEqual(comparison.missing_operation_ids, ["op-2"]);
  const contradictory = compareBatchReceipts(
    [planned],
    [savedReceipt, { ...savedReceipt, status: "failed", effect: "none", business_object_id: null, business_revision: null }]
  );
  assert.equal(contradictory.all_saved, false);
  assert.deepEqual(contradictory.contradictory_operation_ids, ["op-1"]);
});

check("回执结果守卫：成功证明不完整不得落账", () => {
  assert.deepEqual(
    guardBusinessWriteResult({ status: "saved", effect: "committed", business_object_id: "observation-1", business_revision: null }),
    []
  );
  assert.deepEqual(
    guardBusinessWriteResult({ status: "saved", effect: "unknown", business_object_id: "observation-1", business_revision: null }),
    ["invalid_success_proof"]
  );
  assert.deepEqual(
    guardBusinessWriteResult({ status: "saved_detail_unavailable", effect: "committed", business_object_id: "  ", business_revision: null }),
    ["invalid_success_proof"]
  );
  assert.deepEqual(
    guardBusinessWriteResult({ status: "failed", effect: "none", business_object_id: null, business_revision: null }),
    []
  );
});

/* ------------------------------ 替代操作 ------------------------------ */

check("替代资格：仅未开始的 planned 可替代；已执行/已开始/已替代只能查原操作", () => {
  assert.equal(
    operationSupersedeEligibility({ receipt_status: null, started_at: null, superseded_by: null }),
    "eligible"
  );
  assert.equal(
    operationSupersedeEligibility({ receipt_status: "saved", started_at: "2026-10-05T08:00:00.000Z", superseded_by: null }),
    "already_executed"
  );
  assert.equal(
    operationSupersedeEligibility({ receipt_status: null, started_at: "2026-10-05T08:00:00.000Z", superseded_by: null }),
    "in_progress"
  );
  assert.equal(
    operationSupersedeEligibility({ receipt_status: null, started_at: null, superseded_by: "op-2" }),
    "already_superseded"
  );
});

check("替代后旧迟到消费必须被拒绝", () => {
  assert.equal(guardExecutionAgainstOperation({ superseded_by: "op-2", started_at: null, receipt_status: null }), "superseded");
  assert.equal(guardExecutionAgainstOperation({ superseded_by: null, started_at: "2026-10-05T08:00:00.000Z", receipt_status: null }), "started");
  assert.equal(guardExecutionAgainstOperation({ superseded_by: null, started_at: null, receipt_status: "saved" }), "already_executed");
  assert.equal(guardExecutionAgainstOperation({ superseded_by: null, started_at: null, receipt_status: null }), "ok");
});

/* ------------------------------ 附件、删除与租约 ------------------------------ */

check("删除会话只解除本会话消息引用，业务引用与其他会话引用保留", () => {
  const facts = {
    image_id: "att-x",
    reference_query_complete: true,
    observation_refs: [],
    message_refs: [
      { conversation_id: "conv-a", message_id: "m-1" },
      { conversation_id: "conv-a", message_id: "m-2" },
      { conversation_id: "conv-b", message_id: "m-3" },
    ],
    proposal_refs: [],
  };
  const plan = planConversationAttachmentRefs(facts, "conv-a");
  assert.deepEqual(plan.detach_message_refs, [
    { conversation_id: "conv-a", message_id: "m-1" },
    { conversation_id: "conv-a", message_id: "m-2" },
  ]);
  assert.deepEqual(plan.unreferenced, []);
  assert.equal(decideImageRetention(facts, "conv-a"), "retain_other_conversations");

  const onlyMine = planConversationAttachmentRefs(
    { ...facts, message_refs: [{ conversation_id: "conv-a", message_id: "m-1" }] },
    "conv-a"
  );
  assert.deepEqual(onlyMine.unreferenced, ["att-x"]);

  const business = planConversationAttachmentRefs(
    { ...facts, observation_refs: [{ observation_id: "obs-1", status: "draft" }] },
    "conv-a"
  );
  assert.deepEqual(business.unreferenced, []);
  assert.equal(decideImageRetention({ ...facts, observation_refs: [{ observation_id: "obs-1", status: "draft" }] }, "conv-a"), "retain_business_reference");
});

check("引用查询不完整时不得产生删除/回收候选", () => {
  const plan = planConversationAttachmentRefs(
    {
      image_id: "att-x",
      reference_query_complete: false,
      observation_refs: [],
      message_refs: [{ conversation_id: "conv-a", message_id: "m-1" }],
      proposal_refs: [],
    },
    "conv-a"
  );
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.detach_message_refs, []);
  assert.deepEqual(plan.unreferenced, []);
  assert.equal(decideImageRetention({ image_id: "att-x", reference_query_complete: false, observation_refs: [], message_refs: [], proposal_refs: [] }, "conv-a"), "retain_unknown_references");
});

check("deleting 租约 CAS：先锁后删，未知结果不恢复 ready", () => {
  assert.deepEqual(YAYA_ATTACHMENT_STATUSES, ["ready", "deleting", "deleted"]);
  const begin = attachmentLeaseTransition(
    { status: "ready", revision: 3, delete_result: null },
    { action: "begin", expected_revision: 3 }
  );
  assert.deepEqual(begin, { ok: true, next: { status: "deleting", revision: 4, delete_result: null } });
  const stale = attachmentLeaseTransition(
    { status: "ready", revision: 3, delete_result: null },
    { action: "begin", expected_revision: 2 }
  );
  assert.deepEqual(stale, { ok: false, reason: "revision_conflict" });
  const again = attachmentLeaseTransition(
    { status: "deleting", revision: 4, delete_result: null },
    { action: "begin", expected_revision: 4 }
  );
  assert.deepEqual(again, { ok: false, reason: "not_ready" });
  const unknown = attachmentLeaseTransition(
    { status: "deleting", revision: 4, delete_result: null },
    { action: "fail_delete", expected_revision: 4 }
  );
  assert.deepEqual(unknown, { ok: true, next: { status: "deleting", revision: 5, delete_result: "unknown" } });
  assert.notEqual(unknown.ok && unknown.next.status, "ready");
  const deleted = attachmentLeaseTransition(
    { status: "deleting", revision: 5, delete_result: "unknown" },
    { action: "commit_delete", expected_revision: 5 }
  );
  assert.deepEqual(deleted, { ok: true, next: { status: "deleted", revision: 6, delete_result: "deleted" } });
  const fromReady = attachmentLeaseTransition(
    { status: "ready", revision: 1, delete_result: null },
    { action: "commit_delete", expected_revision: 1 }
  );
  assert.deepEqual(fromReady, { ok: false, reason: "not_deleting" });
});

check("批准有效期与安全常量存在且为正", () => {
  assert.ok(Number.isInteger(YAYA_APPROVAL_TTL_SECONDS) && YAYA_APPROVAL_TTL_SECONDS > 0);
});

check("harness blob 保持 6702f2ddf3b436e79f8c92ae8756c33f611a8503", () => {
  const bytes = readFileSync(new URL("../harness-safety.ts", import.meta.url));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(blob, "6702f2ddf3b436e79f8c92ae8756c33f611a8503");
});

console.log(
  JSON.stringify({ passed, total: passed + failures.length, failures, data_layer: true, reference_only: false })
);
assert.equal(failures.length, 0);
