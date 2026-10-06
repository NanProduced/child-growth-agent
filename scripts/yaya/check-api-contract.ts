/**
 * YAYA-API0 离线参考检查（reference_only）。
 *
 * 只运行纯函数：不连数据库、不调用模型、不访问对象存储、不启动 HTTP 服务、
 * 不读写任何业务数据；通过不等于真实认证 / HTTP / 浏览器验收。
 *
 * 覆盖：正常、错形、伪造角色 / 批准、错 run、重复 / 矛盾事件、流中断、
 * 查询失败、未知回执、合法幂等与非空成功证明；并静态核对协议模块无
 * Next / 数据库 / 模型导入。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-api-contract.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { normalizeApprovalAction } from "../../src/lib/yaya/data/invariants";
import {
  assessYayaOperationsExecutionResponse,
  classifyYayaRunLookup,
  encodeYayaRunEventLine,
  findForgedAuthorityFields,
  findSecretFields,
  parseYayaApprovalActionRequest,
  parseYayaOperationsExecuteRequest,
  parseYayaOperationsExecuteResponse,
  parseYayaRunCancelRequest,
  parseYayaRunCancelResponse,
  parseYayaRunLookupResponse,
  parseYayaRunStartRequest,
  parseYayaRunWireLine,
  projectYayaAgentEvent,
  projectYayaRunEnd,
  projectYayaSecureControlIntent,
  safeYayaStopDetail,
  selectYayaRunFailureMode,
  validateYayaRunEventStream,
  YAYA_API_PATHS,
  YAYA_MAX_RUN_ATTACHMENTS,
  YAYA_RUN_EVENT_PROTOCOL,
} from "../../src/lib/yaya/api-contract";
import type { YayaAgentEvent } from "../../src/lib/yaya/agent/types";
import { YAYA_AGENT_STOP_REASONS } from "../../src/lib/yaya/agent/types";

let passed = 0;
const failures: string[] = [];
function check(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
  } catch (error: unknown) {
    failures.push(name);
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------------- 共享夹具 ------------------------------- */

const RUN_ID = "run-1";
const DIGEST = "a".repeat(64);

function envelope(seq: number, runId = RUN_ID) {
  return { protocol: YAYA_RUN_EVENT_PROTOCOL, run_id: runId, seq };
}

const STARTED = { ...envelope(1), type: "run_started" };
const ANSWER = { ...envelope(2), type: "answer", content: "小满今天很专注。", sources: [] };
const ANSWER_END = {
  ...envelope(3),
  type: "run_end",
  outcome: { kind: "answered", content: "小满今天很专注。", sources: [] },
};

const PLANNED = {
  batch_id: "batch-1",
  proposal_id: "prop-1",
  item_key: "item-1",
  operation_id: "op-1",
  target_id: "child-1",
  actor_account_id: "teacher-1",
};
const SAVED_RECEIPT = {
  ...PLANNED,
  status: "saved",
  effect: "committed",
  business_object_id: "observation-1",
  business_revision: "rev-1",
  recorded_at: "2026-10-06T08:00:00.000Z",
};

const PROPOSAL = {
  proposal_id: "prop-1",
  batch_id: "batch-1",
  proposal_origin: "model_suggestion",
  auth: { kind: "action", action: "observation.write", resource: "child" },
  items: [
    {
      item_key: "item-1",
      target_id: "child-1",
      content_digest: DIGEST,
      attachment_associations: [],
      payload: {
        kind: "create_observation",
        child_id: "child-1",
        observed_at: "2026-10-06T00:00:00.000Z",
        raw_text: "小满搭了一个很高的积木塔。",
        context: null,
        confirmed_class_id: null,
        image_ids: [],
        source_input: null,
      },
    },
  ],
  prepared_at: "2026-10-06T08:00:00.000Z",
};

const VALID_START = {
  conversation_id: "conv-1",
  client_request_id: "req-1",
  user_text: "小满今天表现怎么样？",
  attachment_ids: [],
  expected_conversation_revision: 1,
};

function firstCode(result: { ok: boolean; violations?: readonly { code: string }[] }): string {
  assert.equal(result.ok, false);
  return result.violations?.[0]?.code ?? "none";
}

/* ------------------------------- 正常 ------------------------------- */

check("正常：run 发起请求解析通过", () => {
  const result = parseYayaRunStartRequest(VALID_START);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.client_request_id, "req-1");
});

check("正常：仅图片（空文字 + 附件）放行", () => {
  const result = parseYayaRunStartRequest({
    ...VALID_START,
    user_text: "  ",
    attachment_ids: ["att-1"],
  });
  assert.equal(result.ok, true);
});

check("正常：五个查询状态响应都可解析", () => {
  assert.equal(parseYayaRunLookupResponse({ status: "missing" }).ok, true);
  assert.equal(
    parseYayaRunLookupResponse({ status: "in_progress", run_id: "run-1" }).ok,
    true,
  );
  assert.equal(
    parseYayaRunLookupResponse({
      status: "finished",
      run_id: "run-1",
      outcome: { kind: "answered", content: "hi", sources: [] },
    }).ok,
    true,
  );
  assert.equal(
    parseYayaRunLookupResponse({ status: "unverifiable", reason: "owner_binding_failed" }).ok,
    true,
  );
  assert.equal(parseYayaRunLookupResponse({ status: "service_failure" }).ok, true);
});

check("正常：取消请求体为空、响应固定语义", () => {
  assert.equal(parseYayaRunCancelRequest({}).ok, true);
  const response = parseYayaRunCancelResponse({
    run_id: "run-1",
    status: "cancel_requested",
    stops_subsequent_dispatch: true,
    rolls_back_committed_business: false,
    upstream_http_cancel_verified: false,
  });
  assert.equal(response.ok, true);
});

check("正常：批准与控制面请求解析通过", () => {
  assert.equal(
    parseYayaApprovalActionRequest({ action: "approve", operation_ids: ["op-1"] }).ok,
    true,
  );
  assert.equal(
    parseYayaApprovalActionRequest({ action: "reject", operation_ids: ["op-1"] }).ok,
    true,
  );
  assert.equal(parseYayaApprovalActionRequest({ action: "cancel" }).ok, true);
  assert.equal(
    parseYayaOperationsExecuteRequest({ approval_id: "approval-1", operation_ids: ["op-1"] })
      .ok,
    true,
  );
  assert.equal(
    parseYayaOperationsExecuteResponse({ receipts: [SAVED_RECEIPT] }).ok,
    true,
  );
});

check("正常：answer 流校验通过并返回终态", () => {
  const verdict = validateYayaRunEventStream([STARTED, ANSWER, ANSWER_END]);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.run_id, RUN_ID);
    assert.equal(verdict.outcome.kind, "answered");
    assert.equal(verdict.event_count, 3);
  }
});

check("正常：NDJSON 行编码 / 解析往返一致", () => {
  const projected = projectYayaAgentEvent(
    {
      type: "answer",
      content: "好的",
      sources: [{ kind: "model_text", ref_id: null, label: null, derived_from: null }],
    } satisfies YayaAgentEvent,
    { run_id: RUN_ID, seq: 2 },
  );
  const line = encodeYayaRunEventLine(projected);
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.trim().includes("\n"), false);
  const parsed = parseYayaRunWireLine(line.trim());
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, projected);
});

check("正常：proposal 流与终态一致", () => {
  const started = { ...envelope(1), type: "run_started" };
  const prepared = { ...envelope(2), type: "proposal_prepared", proposal: PROPOSAL };
  const end = {
    ...envelope(3),
    type: "run_end",
    outcome: { kind: "proposed", proposals: [PROPOSAL] },
  };
  const verdict = validateYayaRunEventStream([started, prepared, end]);
  assert.equal(verdict.ok, true);
});

/* ------------------------------- 错形 ------------------------------- */

check("错形：缺少 conversation_id / client_request_id / 版本", () => {
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, conversation_id: "" })),
    "malformed_request",
  );
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, client_request_id: "   " })),
    "malformed_request",
  );
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, expected_conversation_revision: 0 })),
    "malformed_request",
  );
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, expected_conversation_revision: 1.5 })),
    "malformed_request",
  );
});

check("错形：空文字且无图片被拒绝", () => {
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, user_text: "" })),
    "malformed_request",
  );
});

check("错形：附件重复、空串、超上限被拒绝", () => {
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, attachment_ids: ["a", "a"] })),
    "malformed_request",
  );
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, attachment_ids: [""] })),
    "malformed_request",
  );
  const tooMany = Array.from({ length: YAYA_MAX_RUN_ATTACHMENTS + 1 }, (_, index) => `a${index}`);
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, attachment_ids: tooMany })),
    "malformed_request",
  );
  assert.equal(YAYA_MAX_RUN_ATTACHMENTS, 8);
});

check("错形：未知额外字段被严格拒绝", () => {
  assert.equal(
    firstCode(parseYayaRunStartRequest({ ...VALID_START, extra_field: 1 })),
    "malformed_request",
  );
});

check("错形：事件缺信封 / 空行 / 坏 JSON 被拒绝", () => {
  assert.equal(firstCode(parseYayaRunWireLine("")), "malformed_event");
  assert.equal(firstCode(parseYayaRunWireLine("{oops")), "malformed_event");
  assert.equal(
    firstCode(parseYayaRunWireLine(JSON.stringify({ type: "answer", content: "x" }))),
    "malformed_event",
  );
  assert.equal(
    firstCode(parseYayaRunWireLine(JSON.stringify({ ...envelope(1), type: "answer" }))),
    "malformed_event",
  );
});

check("错形：执行响应必须非空回执", () => {
  assert.equal(
    firstCode(parseYayaOperationsExecuteResponse({ receipts: [] })),
    "malformed_request",
  );
});

/* ------------------------------- 伪造角色 / 批准 ------------------------------- */

check("伪造：run 发起带 principal / role / scope 被拒绝", () => {
  const result = parseYayaRunStartRequest({
    ...VALID_START,
    principal: { account_id: "other", role: "admin" },
  });
  assert.equal(firstCode(result), "forged_authority_field");
  const paths = findForgedAuthorityFields({
    principal: { account_id: "other" },
  });
  assert.deepEqual(paths.sort(), ["principal", "principal.account_id"]);
});

check("伪造：请求体 self-reported 批准被拒绝", () => {
  const result = parseYayaRunStartRequest({
    ...VALID_START,
    approval: { approved: true, approval_source: "request_body_claim" },
  });
  assert.equal(firstCode(result), "forged_authority_field");
});

check("伪造：operations 执行带 approved / actor_account_id / submitter 被拒绝", () => {
  for (const forged of [
    { approved: true },
    { actor_account_id: "teacher-2" },
    { submitter: { csrf_verified: true } },
    { approval_source: "authenticated_entry" },
  ]) {
    const result = parseYayaOperationsExecuteRequest({
      approval_id: "approval-1",
      operation_ids: ["op-1"],
      ...forged,
    });
    assert.equal(firstCode(result), "forged_authority_field");
  }
});

check("伪造：DATA 批准入口净身，自报字段不进入判定", () => {
  const normalized = normalizeApprovalAction({
    action: "approve",
    operation_ids: ["op-1"],
    approved: true,
    principal: { account_id: "other" },
    approval_source: "request_body_claim",
  });
  assert.deepEqual(normalized, { action: "approve", operation_ids: ["op-1"] });
  assert.equal("approved" in normalized, false);
  assert.equal("principal" in normalized, false);
});

check("秘密：请求体与安全控件拒绝密码字段", () => {
  const withSecret = parseYayaRunStartRequest({ ...VALID_START, password: "p@ss" });
  assert.equal(firstCode(withSecret), "secret_field_present");
  assert.deepEqual(findSecretFields({ a: { api_key: "k" } }), ["a.api_key"]);
  const rejected = projectYayaSecureControlIntent({
    kind: "teacher_password_reset",
    target_account_id: "teacher-2",
    password: "p@ss",
  });
  assert.equal(firstCode(rejected), "secret_field_present");
});

check("秘密：安全控件只返回意图与目标", () => {
  const result = projectYayaSecureControlIntent({
    kind: "teacher_password_reset",
    target_account_id: "teacher-2",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, {
      secure_control: "teacher_password_reset",
      target_account_id: "teacher-2",
      secrets_in_protocol: false,
    });
  }
  const bad = projectYayaSecureControlIntent({ kind: "unknown_kind", target_account_id: null });
  assert.equal(firstCode(bad), "invalid_shape");
});

/* ------------------------------- 错 run ------------------------------- */

check("错 run：与预期 run_id 不一致被拒绝", () => {
  const verdict = validateYayaRunEventStream([STARTED, ANSWER, ANSWER_END], "run-2");
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "run_mismatch"));
  }
});

check("错 run：流内事件 run_id 互相矛盾被拒绝", () => {
  const other = { ...envelope(3, "run-2"), type: "answer", content: "x", sources: [] };
  const verdict = validateYayaRunEventStream([STARTED, other]);
  assert.equal(verdict.ok, false);
});

check("错协议：未知版本事件被拒绝", () => {
  const result = parseYayaRunWireLine(
    JSON.stringify({ ...envelope(1), protocol: "yaya-run-events-v2", type: "run_started" }),
  );
  assert.equal(firstCode(result), "unsupported_protocol");
});

/* ------------------------------- 重复 / 矛盾事件 ------------------------------- */

check("重复：序号重复被拒绝", () => {
  const duplicated = { ...ANSWER, seq: 1 };
  const verdict = validateYayaRunEventStream([STARTED, duplicated]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "sequence_duplicate"));
  }
});

check("矛盾：run_end 之后仍有事件被拒绝", () => {
  const verdict = validateYayaRunEventStream([STARTED, ANSWER, ANSWER_END, ANSWER]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "event_after_terminal"));
  }
});

check("矛盾：多个 run_end 被拒绝", () => {
  const verdict = validateYayaRunEventStream([STARTED, ANSWER, ANSWER_END, ANSWER_END]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "duplicate_terminal"));
  }
});

check("矛盾：终态为回答但无 answer 事件被拒绝", () => {
  const verdict = validateYayaRunEventStream([STARTED, ANSWER_END]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "contradictory_terminal"));
  }
});

check("矛盾：answer 内容与终态不一致被拒绝", () => {
  const end = {
    ...envelope(3),
    type: "run_end",
    outcome: { kind: "answered", content: "另一段内容", sources: [] },
  };
  const verdict = validateYayaRunEventStream([STARTED, ANSWER, end]);
  assert.equal(verdict.ok, false);
});

check("矛盾：stopped 事件原因与终态不一致被拒绝", () => {
  const stopped = {
    ...envelope(2),
    type: "stopped",
    reason: "cancelled",
    detail: safeYayaStopDetail("cancelled"),
  };
  const end = {
    ...envelope(3),
    type: "run_end",
    outcome: { kind: "stopped", reason: "deadline", detail: safeYayaStopDetail("deadline") },
  };
  const verdict = validateYayaRunEventStream([STARTED, stopped, end]);
  assert.equal(verdict.ok, false);
});

check("矛盾：提案身份与终态不一致被拒绝", () => {
  const prepared = { ...envelope(2), type: "proposal_prepared", proposal: PROPOSAL };
  const otherProposal = { ...PROPOSAL, proposal_id: "prop-2" };
  const end = {
    ...envelope(3),
    type: "run_end",
    outcome: { kind: "proposed", proposals: [otherProposal] },
  };
  const verdict = validateYayaRunEventStream([STARTED, prepared, end]);
  assert.equal(verdict.ok, false);
});

/* ------------------------------- 流中断 ------------------------------- */

check("中断：空流 / 首事件不是 run_started / 缺终态都被拒绝", () => {
  assert.equal(
    validateYayaRunEventStream([]).ok,
    false,
  );
  const firstNotStarted = validateYayaRunEventStream([ANSWER, ANSWER_END]);
  assert.equal(firstNotStarted.ok, false);
  if (!firstNotStarted.ok) {
    assert.equal(firstNotStarted.violations[0]?.code, "missing_run_started");
  }
  const interrupted = validateYayaRunEventStream([STARTED, ANSWER]);
  assert.equal(interrupted.ok, false);
  if (!interrupted.ok) {
    assert.ok(interrupted.violations.some((entry) => entry.code === "missing_terminal"));
  }
});

check("中断：序号缺口被识别", () => {
  const gap = { ...ANSWER_END, seq: 4 };
  const verdict = validateYayaRunEventStream([STARTED, ANSWER, gap]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "sequence_gap"));
  }
});

/* ------------------------------- 查询失败与五态分离 ------------------------------- */

check("查询：服务失败不冒充缺失", () => {
  const failed = classifyYayaRunLookup({ kind: "query_failed" });
  assert.deepEqual(failed, { status: "service_failure" });
  const missing = classifyYayaRunLookup({ kind: "not_found" });
  assert.deepEqual(missing, { status: "missing" });
  assert.notDeepEqual(failed, missing);
});

check("查询：运行中 / 已结束 / 不可核验分开", () => {
  const active = classifyYayaRunLookup({
    kind: "found",
    run_id: "run-1",
    owner_verified: true,
    state: { kind: "active" },
  });
  assert.deepEqual(active, { status: "in_progress", run_id: "run-1" });
  const finished = classifyYayaRunLookup({
    kind: "found",
    run_id: "run-1",
    owner_verified: true,
    state: { kind: "terminal", outcome: { kind: "answered", content: "hi", sources: [] } },
  });
  assert.equal(finished.status, "finished");
  const notOwner = classifyYayaRunLookup({
    kind: "found",
    run_id: "run-1",
    owner_verified: false,
    state: { kind: "active" },
  });
  assert.deepEqual(notOwner, { status: "unverifiable", reason: "owner_binding_failed" });
});

check("查询：终态不可读一律不可核验，不伪造 finished", () => {
  for (const outcome of [
    { kind: "answered", content: "hi", sources: [] , extra: 1 },
    { kind: "unknown_kind" },
    null,
  ]) {
    const result = classifyYayaRunLookup({
      kind: "found",
      run_id: "run-1",
      owner_verified: true,
      state: { kind: "terminal", outcome },
    });
    assert.deepEqual(result, { status: "unverifiable", reason: "terminal_unreadable" });
  }
});

/* ------------------------------- 未知回执 / 成功证明 / 合法幂等 ------------------------------- */

check("回执：unknown 不冒充成功", () => {
  const unknown = {
    ...envelope(2),
    type: "receipt",
    operation_id: "op-1",
    outcome: { kind: "unknown", reason: "no_receipt" },
  };
  const stopped = {
    ...envelope(3),
    type: "stopped",
    reason: "cancelled",
    detail: safeYayaStopDetail("cancelled"),
  };
  const end = {
    ...envelope(4),
    type: "run_end",
    outcome: { kind: "stopped", reason: "cancelled", detail: safeYayaStopDetail("cancelled") },
  };
  const verdict = validateYayaRunEventStream([STARTED, unknown, stopped, end]);
  assert.equal(verdict.ok, true);
});

check("回执：空业务标识的成功证明被拒绝", () => {
  const fake = { ...SAVED_RECEIPT, business_object_id: "  " };
  const event = {
    ...envelope(2),
    type: "receipt",
    operation_id: "op-1",
    outcome: { kind: "saved", receipt: fake },
  };
  const end = {
    ...envelope(4),
    type: "run_end",
    outcome: { kind: "stopped", reason: "cancelled", detail: safeYayaStopDetail("cancelled") },
  };
  const stopped = {
    ...envelope(3),
    type: "stopped",
    reason: "cancelled",
    detail: safeYayaStopDetail("cancelled"),
  };
  const verdict = validateYayaRunEventStream([STARTED, event, stopped, end]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "unverified_success"));
  }
});

check("回执：回执身份与原操作不一致被拒绝", () => {
  const event = {
    ...envelope(2),
    type: "receipt",
    operation_id: "op-2",
    outcome: { kind: "saved", receipt: SAVED_RECEIPT },
  };
  const stopped = {
    ...envelope(3),
    type: "stopped",
    reason: "cancelled",
    detail: safeYayaStopDetail("cancelled"),
  };
  const end = {
    ...envelope(4),
    type: "run_end",
    outcome: { kind: "stopped", reason: "cancelled", detail: safeYayaStopDetail("cancelled") },
  };
  const verdict = validateYayaRunEventStream([STARTED, event, stopped, end]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "receipt_identity_mismatch"));
  }
});

check("回执：相同结果重复是合法幂等，矛盾回执被拒绝", () => {
  const receipt = {
    ...envelope(2),
    type: "receipt",
    operation_id: "op-1",
    outcome: { kind: "saved", receipt: SAVED_RECEIPT },
  };
  const replay = { ...receipt, seq: 3 };
  const stopped = {
    ...envelope(4),
    type: "stopped",
    reason: "cancelled",
    detail: safeYayaStopDetail("cancelled"),
  };
  const end = {
    ...envelope(5),
    type: "run_end",
    outcome: { kind: "stopped", reason: "cancelled", detail: safeYayaStopDetail("cancelled") },
  };
  assert.equal(validateYayaRunEventStream([STARTED, receipt, replay, stopped, end]).ok, true);

  const contradictory = {
    ...envelope(3),
    type: "receipt",
    operation_id: "op-1",
    outcome: { kind: "failed", effect: "none" },
  };
  const badVerdict = validateYayaRunEventStream([
    STARTED,
    receipt,
    contradictory,
    { ...stopped, seq: 4 },
    { ...end, seq: 5 },
  ]);
  assert.equal(badVerdict.ok, false);
  if (!badVerdict.ok) {
    assert.ok(badVerdict.violations.some((entry) => entry.code === "contradictory_receipt"));
  }
});

/* ------------------------------- R1：恢复响应与提案内容一致性 ------------------------------- */

check("恢复：四种终态 classify → 解析往返一致", () => {
  const outcomes: unknown[] = [
    { kind: "answered", content: "hi", sources: [] },
    { kind: "clarified", question: "哪个班？" },
    { kind: "proposed", proposals: [PROPOSAL] },
    { kind: "stopped", reason: "model_failed", detail: "raw internal marker" },
  ];
  for (const outcome of outcomes) {
    const lookup = classifyYayaRunLookup({
      kind: "found",
      run_id: RUN_ID,
      owner_verified: true,
      state: { kind: "terminal", outcome },
    });
    assert.equal(lookup.status, "finished");
    const parsed = parseYayaRunLookupResponse(lookup);
    assert.equal(parsed.ok, true);
  }
});

check("恢复：finished + proposed 不被误判为伪造字段", () => {
  const lookup = classifyYayaRunLookup({
    kind: "found",
    run_id: RUN_ID,
    owner_verified: true,
    state: { kind: "terminal", outcome: { kind: "proposed", proposals: [PROPOSAL] } },
  });
  assert.equal(lookup.status, "finished");
  const parsed = parseYayaRunLookupResponse(lookup);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.status, "finished");
});

check("恢复：stopped.detail 统一套用安全文案，不回传内部标记", () => {
  const marker = "REVIEW_INTERNAL_STACK_MARKER at /srv/private/review.ts";
  const lookup = classifyYayaRunLookup({
    kind: "found",
    run_id: RUN_ID,
    owner_verified: true,
    state: {
      kind: "terminal",
      outcome: { kind: "stopped", reason: "model_failed", detail: marker },
    },
  });
  assert.equal(lookup.status, "finished");
  assert.equal(JSON.stringify(lookup).includes("REVIEW_INTERNAL_STACK_MARKER"), false);
  if (lookup.status === "finished" && lookup.outcome.kind === "stopped") {
    assert.equal(lookup.outcome.detail, safeYayaStopDetail("model_failed"));
  }
  const parsed = parseYayaRunLookupResponse(lookup);
  assert.equal(parsed.ok, true);
});

check("提案一致性：同 proposal_id 不同业务内容判矛盾", () => {
  const changed = {
    ...PROPOSAL,
    batch_id: "different-batch",
    items: [
      {
        ...PROPOSAL.items[0],
        target_id: "child-b",
        content_digest: "b".repeat(64),
        payload: {
          ...PROPOSAL.items[0].payload,
          child_id: "child-b",
          raw_text: "阿依搭了六层积木。",
        },
      },
    ],
  };
  const verdict = validateYayaRunEventStream([
    STARTED,
    { ...envelope(2), type: "proposal_prepared", proposal: PROPOSAL },
    { ...envelope(3), type: "run_end", outcome: { kind: "proposed", proposals: [changed] } },
  ]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "contradictory_terminal"));
  }
});

check("提案一致性：键顺序不同但语义一致不误拒", () => {
  const reordered = {
    prepared_at: PROPOSAL.prepared_at,
    items: PROPOSAL.items.map((item) => ({
      payload: { ...item.payload },
      attachment_associations: item.attachment_associations,
      content_digest: item.content_digest,
      target_id: item.target_id,
      item_key: item.item_key,
    })),
    auth: PROPOSAL.auth,
    proposal_origin: PROPOSAL.proposal_origin,
    batch_id: PROPOSAL.batch_id,
    proposal_id: PROPOSAL.proposal_id,
  };
  const verdict = validateYayaRunEventStream([
    STARTED,
    { ...envelope(2), type: "proposal_prepared", proposal: PROPOSAL },
    { ...envelope(3), type: "run_end", outcome: { kind: "proposed", proposals: [reordered] } },
  ]);
  assert.equal(verdict.ok, true);
});

check("提案一致性：同 id 的重复 / 歧义提案不得折叠", () => {
  const changed = { ...PROPOSAL, batch_id: "different-batch" };
  const verdict = validateYayaRunEventStream([
    STARTED,
    { ...envelope(2), type: "proposal_prepared", proposal: PROPOSAL },
    { ...envelope(3), type: "proposal_prepared", proposal: changed },
    {
      ...envelope(4),
      type: "run_end",
      outcome: { kind: "proposed", proposals: [PROPOSAL, changed] },
    },
  ]);
  assert.equal(verdict.ok, false);
});

/* ------------------------------- R1：执行响应语义核验 ------------------------------- */

const EXEC_PLAN = [PLANNED];

check("执行：结构合法但未证明成功不得判保存", () => {
  const fake = {
    ...SAVED_RECEIPT,
    effect: "unknown",
    business_object_id: null,
    business_revision: null,
  };
  const shape = parseYayaOperationsExecuteResponse({ receipts: [fake] });
  assert.equal(shape.ok, true);
  const verdict = assessYayaOperationsExecutionResponse(EXEC_PLAN, { receipts: [fake] });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "unverified_success"));
  }
});

check("执行：完整成功 / unchanged / 合法失败与执行中都不丢失", () => {
  const saved = assessYayaOperationsExecutionResponse(EXEC_PLAN, {
    receipts: [SAVED_RECEIPT],
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.equal(saved.value.comparison.all_saved, true);
    assert.equal(saved.value.outcomes[0]?.outcome.kind, "saved");
    assert.deepEqual(saved.value.explicit_resend_candidates, []);
  }
  const unchanged = { ...SAVED_RECEIPT, status: "unchanged", business_revision: null };
  const unchangedVerdict = assessYayaOperationsExecutionResponse(EXEC_PLAN, {
    receipts: [unchanged],
  });
  assert.equal(unchangedVerdict.ok, true);
  if (unchangedVerdict.ok) assert.equal(unchangedVerdict.value.comparison.all_saved, true);
  const failed = {
    ...SAVED_RECEIPT,
    status: "failed",
    effect: "none",
    business_object_id: null,
    business_revision: null,
  };
  const failedVerdict = assessYayaOperationsExecutionResponse(EXEC_PLAN, {
    receipts: [failed],
  });
  assert.equal(failedVerdict.ok, true);
  if (failedVerdict.ok) {
    assert.equal(failedVerdict.value.comparison.all_saved, false);
    assert.equal(failedVerdict.value.outcomes[0]?.outcome.kind, "failed");
    assert.equal(failedVerdict.value.explicit_resend_candidates.length, 1);
  }
  const inProgress = { ...failed, status: "in_progress", effect: "unknown" };
  const inProgressVerdict = assessYayaOperationsExecutionResponse(EXEC_PLAN, {
    receipts: [inProgress],
  });
  assert.equal(inProgressVerdict.ok, true);
  if (inProgressVerdict.ok) {
    assert.equal(inProgressVerdict.value.outcomes[0]?.outcome.kind, "in_progress");
  }
});

check("执行：缺项 / 错身份 / 矛盾回执不得渲染成功", () => {
  const wrongOperation = assessYayaOperationsExecutionResponse(EXEC_PLAN, {
    receipts: [{ ...SAVED_RECEIPT, operation_id: "op-other" }],
  });
  assert.equal(wrongOperation.ok, false);
  if (!wrongOperation.ok) {
    const codes = wrongOperation.violations.map((entry) => entry.code);
    assert.ok(codes.includes("response_identity_mismatch"));
    assert.ok(codes.includes("response_incomplete"));
  }
  for (const wrong of [
    { ...SAVED_RECEIPT, actor_account_id: "teacher-other" },
    { ...SAVED_RECEIPT, target_id: "child-other" },
    { ...SAVED_RECEIPT, batch_id: "batch-other" },
  ]) {
    const verdict = assessYayaOperationsExecutionResponse(EXEC_PLAN, { receipts: [wrong] });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.violations.some((entry) => entry.code === "response_identity_mismatch"));
    }
  }
  const contradictory = assessYayaOperationsExecutionResponse(EXEC_PLAN, {
    receipts: [
      SAVED_RECEIPT,
      {
        ...SAVED_RECEIPT,
        status: "failed",
        effect: "none",
        business_object_id: null,
        business_revision: null,
      },
    ],
  });
  assert.equal(contradictory.ok, false);
  if (!contradictory.ok) {
    assert.ok(contradictory.violations.some((entry) => entry.code === "contradictory_receipt"));
  }
});

check("执行：合法幂等重复回执保留，不误判矛盾", () => {
  const verdict = assessYayaOperationsExecutionResponse(EXEC_PLAN, {
    receipts: [SAVED_RECEIPT, SAVED_RECEIPT],
  });
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.ok(verdict.value.comparison.duplicate_operation_ids.includes("op-1"));
    assert.equal(verdict.value.comparison.saved, 1);
  }
});

check("流回执：effect=unknown 的 saved 不算成功", () => {
  const fake = {
    ...SAVED_RECEIPT,
    effect: "unknown",
    business_object_id: null,
    business_revision: null,
  };
  const verdict = validateYayaRunEventStream([
    STARTED,
    {
      ...envelope(2),
      type: "receipt",
      operation_id: "op-1",
      outcome: { kind: "saved", receipt: fake },
    },
    {
      ...envelope(3),
      type: "stopped",
      reason: "cancelled",
      detail: safeYayaStopDetail("cancelled"),
    },
    {
      ...envelope(4),
      type: "run_end",
      outcome: { kind: "stopped", reason: "cancelled", detail: safeYayaStopDetail("cancelled") },
    },
  ]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.violations.some((entry) => entry.code === "unverified_success"));
  }
});

/* ------------------------------- 停止详情与失败投递 ------------------------------- */

check("停止详情：内部异常文本不进入线协议", () => {
  const projected = projectYayaAgentEvent(
    { type: "stopped", reason: "model_failed", detail: "Error: stack at /srv/app/secret.ts" },
    { run_id: RUN_ID, seq: 2 },
  );
  assert.equal(projected.type, "stopped");
  if (projected.type === "stopped") {
    assert.equal(projected.detail, safeYayaStopDetail("model_failed"));
    assert.equal(projected.detail?.includes("stack"), false);
  }
  const end = projectYayaRunEnd(
    { kind: "stopped", reason: "tool_failed", detail: "raw internal" },
    { run_id: RUN_ID, seq: 3 },
  );
  assert.equal(end.outcome.kind, "stopped");
  if (end.outcome.kind === "stopped") {
    assert.equal(end.outcome.detail, safeYayaStopDetail("tool_failed"));
  }
});

check("停止详情：冻结停止原因全部有协议文案", () => {
  for (const reason of YAYA_AGENT_STOP_REASONS) {
    assert.ok(safeYayaStopDetail(reason).length > 0);
  }
});

check("失败投递：头未发用 HTTP 错误，流已开始用终态事件", () => {
  assert.equal(selectYayaRunFailureMode(false), "http_error");
  assert.equal(selectYayaRunFailureMode(true), "terminal_event");
});

check("投影类型：running 中间事件可序列化", () => {
  const events: YayaAgentEvent[] = [
    { type: "run_started", run_id: RUN_ID },
    { type: "model_attempted", attempt: 1 },
    { type: "action_parsed", action: "read", tool: "query.children" },
    { type: "tool_result", tool: "query.children", outcome: "ok", source_kind: "tool_result" },
  ];
  events.forEach((event, index) => {
    const line = encodeYayaRunEventLine(
      projectYayaAgentEvent(event, { run_id: RUN_ID, seq: index + 1 }),
    );
    const parsed = parseYayaRunWireLine(line.trim());
    assert.equal(parsed.ok, true);
  });
});

/* ------------------------------- 静态边界 ------------------------------- */

check("路径表与冻结 owner 口径一致", () => {
  assert.equal(YAYA_API_PATHS.operations_execute, "/api/yaya/operations");
  assert.equal(YAYA_API_PATHS.approval, "/api/yaya/proposals/{proposal_id}/approval");
  assert.equal(YAYA_API_PATHS.run_start, "/api/yaya/conversations/{conversation_id}/runs");
});

check("协议模块无 Next / 数据库 / 模型 / node:crypto 依赖链，纯校验", () => {
  const source = readFileSync(
    new URL("../../src/lib/yaya/api-contract.ts", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "next/server",
    "pg-client",
    "invokeChatLlm",
    "fetch(",
    "zod/v4",
    'from "./storage-types"',
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `api-contract.ts 不应包含 ${forbidden}`,
    );
  }
  assert.equal(
    /from\s+["']node:/.test(source),
    false,
    "api-contract.ts 不得导入 node: 内置模块（浏览器打包边界）",
  );
  assert.ok(source.includes(YAYA_RUN_EVENT_PROTOCOL));
});

check("浏览器：协议层可被 browser-target 真实打包（esbuild）", () => {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const requireFromHere = createRequire(import.meta.url);
  const tsupPath = requireFromHere.resolve("tsup");
  const esbuild = createRequire(tsupPath)("esbuild") as {
    buildSync(options: Record<string, unknown>): unknown;
  };
  esbuild.buildSync({
    stdin: {
      contents:
        "import { parseYayaRunWireLine, classifyYayaRunLookup, assessYayaOperationsExecutionResponse } from './src/lib/yaya/api-contract'; console.log(parseYayaRunWireLine('{}'), classifyYayaRunLookup({ kind: 'not_found' }), assessYayaOperationsExecutionResponse);",
      resolveDir: projectRoot,
      sourcefile: "api-contract-browser-check.ts",
    },
    bundle: true,
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
});

console.log(
  JSON.stringify({
    passed,
    total: passed + failures.length,
    failures,
    reference_only: true,
  }),
);
assert.equal(failures.length, 0);
