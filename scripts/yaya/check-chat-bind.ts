/**
 * YAYA-CHAT-BIND0 离线参考检查（reference_only）。
 *
 * 只做纯检查：不连数据库、不调用模型 / 搜索 / 对象存储、不发真实 HTTP、
 * 不写任何业务数据，通过也不证明真实认证 / 真实事务 / 生产可用。
 *
 * 覆盖两条最小接口的反例：
 * 私域答案丢来源、只给模型引用但漏依赖、一般问答正向对照、错 owner / 会话 / run / 内容、
 * 历史恢复不执行、错回执身份、终态撤权、旧无绑定消息、重复持久化、未知只查原身份。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-chat-bind.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  YAYA_ASSISTANT_MESSAGE_WRITER,
  YAYA_CHAT_BIND_VERSION,
  YAYA_RECOVERY_PATHS,
  authorizeYayaMessageWrite,
  buildYayaRunSourceBinding,
  parseYayaChatRecoveryMark,
  restrictYayaAssistantProjection,
  resolveYayaAssistantFragmentPolicy,
  verifyYayaRecoveryIdentity,
  yayaRecoveryLookupRequests,
  type YayaChatRecoveryMark,
  type YayaRecoveryFacts,
} from "../../src/lib/yaya/chat-bind-contract";
import {
  YAYA_API_PATHS,
  classifyYayaRunLookup,
  parseYayaRunLookupResponse,
} from "../../src/lib/yaya/api-contract";
import {
  projectChatMessage,
  projectConversationTitle,
  queryOperationOutcome,
  type YayaChatMessageRef,
  type YayaMessageSourceRef,
  type YayaOperationReceipt,
  type YayaPlannedOperation,
} from "../../src/lib/yaya/types";
import { projectStoredMessageText } from "../../src/lib/yaya/data/invariants";

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

/* ------------------------------- 固定样例 ------------------------------- */

const OWNER = "acc-owner";
const OTHER = "acc-other";
const DIGEST = "ab".repeat(32);
const CHILD_SOURCE: YayaMessageSourceRef = {
  kind: "child",
  child_id: "child-1",
  current_class_id: "class-1",
};

const PLANNED: YayaPlannedOperation = {
  batch_id: "batch-1",
  proposal_id: "prop-1",
  item_key: "item-1",
  operation_id: "op-1",
  target_id: "obs-1",
  actor_account_id: "acc-teacher",
};

const RECEIPT: YayaOperationReceipt = {
  batch_id: PLANNED.batch_id,
  proposal_id: PLANNED.proposal_id,
  item_key: PLANNED.item_key,
  operation_id: PLANNED.operation_id,
  target_id: PLANNED.target_id,
  actor_account_id: PLANNED.actor_account_id,
  status: "saved",
  effect: "committed",
  business_object_id: "obs-1",
  business_revision: "3",
  recorded_at: "2026-10-07T00:00:00.000Z",
};

const MARK: YayaChatRecoveryMark = {
  mark: "yaya-recovery-v1",
  conversation_id: "conv-1",
  owner_account_id: OWNER,
  actor_account_id: "acc-teacher",
  run: { run_id: "run-1", client_request_id: "req-1" },
  proposal: { proposal_id: "prop-1", batch_id: "batch-1" },
  operations: [
    { operation_id: "op-1", item_key: "item-1", target_id: "obs-1", content_digest: DIGEST },
  ],
};

const FACTS: YayaRecoveryFacts = {
  conversation_id: "conv-1",
  owner_account_id: OWNER,
  run: { run_id: "run-1", client_request_id: "req-1" },
  operations: [
    { planned: PLANNED, content_digest: DIGEST, outcome: { kind: "saved", receipt: RECEIPT } },
  ],
};

function messageRef(overrides: {
  sources: readonly YayaMessageSourceRef[];
  independentlyReadable: boolean;
  ownerAccountId?: string;
}): YayaChatMessageRef {
  return {
    message_id: "msg-1",
    owner_account_id: overrides.ownerAccountId ?? OWNER,
    session_id: "conv-1",
    created_at: "2026-10-07T00:00:00.000Z",
    message_kind: "text",
    execution_state: "none",
    fragments: [
      {
        fragment_id: "frag-1",
        sources: overrides.sources,
        independently_readable: overrides.independentlyReadable,
      },
    ],
    attachment_ids: ["att-1"],
  };
}

function firstCode(result: { ok: boolean; violations?: readonly { code: string }[] }): string | null {
  if (result.ok || result.violations === undefined) return null;
  return result.violations[0]?.code ?? null;
}

/* ------------------------------- 一、可信来源绑定 ------------------------------- */

check("私域答案丢来源：客户端自报空来源不改写服务端依赖，撤权后正文受限", () => {
  // 运行依赖含幼儿私域；客户端/旧实现落库时写 sources:[]、independently_readable:true
  const binding = buildYayaRunSourceBinding({
    resource_dependencies: [CHILD_SOURCE],
    unmapped_dependency_count: 0,
    private_dependency_proven_absent: false,
  });
  const policy = resolveYayaAssistantFragmentPolicy(binding);
  assert.deepEqual(policy.sources, [CHILD_SOURCE], "整段答案必须继承服务端已知依赖");
  assert.equal(policy.independently_readable, false, "依赖未清空且未证明独立，不得独立可读");

  const denied = projectChatMessage(
    messageRef({ sources: policy.sources, independentlyReadable: policy.independently_readable }),
    { account_id: OWNER, role: "teacher" },
    [{ fragment_id: "frag-1", source_index: 0, access: "denied" }],
    [{ attachment_id: "att-1", access: "full" }],
  );
  assert.equal(denied.visibility !== "full", true, "撤权后私域正文不得 full");
  assert.equal(denied.fragments[0]?.visibility, "hidden");

  // 落库形状仍是客户端那套空来源：读侧兜底必须按未知绑定限制
  const legacy = projectChatMessage(
    messageRef({ sources: [], independentlyReadable: true }),
    { account_id: OWNER, role: "teacher" },
    [],
    [{ attachment_id: "att-1", access: "full" }],
  );
  const restricted = restrictYayaAssistantProjection(legacy, {
    role: "assistant",
    policy: resolveYayaAssistantFragmentPolicy({ state: "unknown" }),
  });
  assert.equal(restricted.visibility, "unavailable");
  assert.equal(restricted.fragments[0]?.visibility, "hidden");
});

check("只给模型引用但漏依赖：引用不作依赖，依赖不完整核验保持受限", () => {
  // 服务端只拿得到 outcome.sources（模型引用），资源级依赖无法完整核验
  const citationsOnly = buildYayaRunSourceBinding({
    resource_dependencies: null,
    unmapped_dependency_count: 0,
    private_dependency_proven_absent: true,
  });
  assert.equal(citationsOnly.state, "unknown");
  const citationsOnlyPolicy = resolveYayaAssistantFragmentPolicy(citationsOnly);
  assert.equal(citationsOnlyPolicy.independently_readable, false);
  assert.deepEqual(citationsOnlyPolicy.sources, []);

  // 资源级依赖为空，但存在无法映射的依赖条目：仍不构成“无私域依赖”
  const unmapped = buildYayaRunSourceBinding({
    resource_dependencies: [],
    unmapped_dependency_count: 1,
    private_dependency_proven_absent: true,
  });
  assert.equal(unmapped.state, "bound");
  assert.equal(unmapped.state === "bound" && unmapped.general_qa_proven, false);
  const unmappedPolicy = resolveYayaAssistantFragmentPolicy(unmapped);
  assert.equal(unmappedPolicy.independently_readable, false);
  assert.deepEqual(unmappedPolicy.sources, [], "漏依赖不得凭空补成可信来源");

  // 反向：依赖非空但模型没引用，依赖仍必须生效
  const noCitation = resolveYayaAssistantFragmentPolicy(
    buildYayaRunSourceBinding({
      resource_dependencies: [CHILD_SOURCE],
      unmapped_dependency_count: 0,
      private_dependency_proven_absent: false,
    }),
  );
  assert.deepEqual(noCitation.sources, [CHILD_SOURCE]);
  assert.equal(noCitation.independently_readable, false);
});

check("一般问答正向对照：服务端证明无私域依赖时整段独立可读且投影不被降级", () => {
  const binding = buildYayaRunSourceBinding({
    resource_dependencies: [],
    unmapped_dependency_count: 0,
    private_dependency_proven_absent: true,
  });
  const policy = resolveYayaAssistantFragmentPolicy(binding);
  assert.equal(binding.state, "bound");
  assert.equal(policy.binding_state, "bound");
  assert.equal(policy.independently_readable, true);
  assert.deepEqual(policy.sources, []);

  const projection = projectChatMessage(
    messageRef({ sources: [], independentlyReadable: true }),
    { account_id: OWNER, role: "teacher" },
    [],
    [{ attachment_id: "att-1", access: "full" }],
  );
  assert.equal(projection.visibility, "full", "一般问答对照必须仍可读");
  const after = restrictYayaAssistantProjection(projection, { role: "assistant", policy });
  assert.deepEqual(after, projection, "可信绑定不得被读侧兜底降级");
});

check("错 owner / 会话 / run / 内容：任一不一致保持不可核验", () => {
  assert.deepEqual(verifyYayaRecoveryIdentity(MARK, FACTS), { verifiable: true, outcomes: [{ kind: "saved", receipt: RECEIPT }] });

  const owner = verifyYayaRecoveryIdentity(MARK, { ...FACTS, owner_account_id: OTHER });
  assert.deepEqual(owner, { verifiable: false, reason: "owner_mismatch" });

  const conversation = verifyYayaRecoveryIdentity(MARK, { ...FACTS, conversation_id: "conv-2" });
  assert.deepEqual(conversation, { verifiable: false, reason: "conversation_mismatch" });

  const run = verifyYayaRecoveryIdentity(MARK, {
    ...FACTS,
    run: { run_id: "run-2", client_request_id: "req-1" },
  });
  assert.deepEqual(run, { verifiable: false, reason: "run_mismatch" });

  const content = verifyYayaRecoveryIdentity(MARK, {
    ...FACTS,
    operations: [{ ...FACTS.operations[0], content_digest: "cd".repeat(32) }],
  });
  assert.deepEqual(content, { verifiable: false, reason: "content_mismatch" });

  // owner 先于角色：管理员身份不能读他人私人聊天，投影层同样按 owner 判
  const foreign = projectChatMessage(
    messageRef({ sources: [], independentlyReadable: true }),
    { account_id: OTHER, role: "admin" },
    [],
    [],
  );
  assert.equal(foreign.visibility, "hidden");
  assert.equal(foreign.fragments[0]?.reason, "owner_mismatch");
  assert.equal(foreign.metadata, null);
});

check("历史恢复不执行：标记只派生 GET，且只含身份查询参数", () => {
  // 模板直接引用 API0 冻结常量，不 fork 同名路径
  assert.equal(YAYA_RECOVERY_PATHS.run_lookup, YAYA_API_PATHS.run_lookup);
  assert.equal(YAYA_RECOVERY_PATHS.operations_query, YAYA_API_PATHS.operations_query);

  const requests = yayaRecoveryLookupRequests(MARK);
  assert.ok(requests.length >= 3);
  // operations 的 GET / POST 共用路径，方法是唯一区分：本清单只允许 GET
  const writeOnlyPaths: readonly string[] = [
    YAYA_API_PATHS.run_start,
    YAYA_API_PATHS.approval,
    YAYA_API_PATHS.run_cancel,
  ];
  for (const request of requests) {
    assert.equal(request.method, "GET", "恢复只读：任何一项都不得是写方法");
    assert.equal(request.path.includes("{"), false, "路径占位符必须全部替换");
    assert.equal(writeOnlyPaths.includes(request.path), false, `只读恢复不得派生写路径 ${request.path}`);
    if (request.path === "/api/yaya/operations") {
      assert.deepEqual(Object.keys(request.query), ["operation_id"], "operations 只按原身份查询");
    }
  }
  assert.equal(requests[0]?.path, "/api/yaya/conversations/conv-1/messages");
  assert.deepEqual(requests[1]?.query, { client_request_id: "req-1" });
  assert.deepEqual(requests[2]?.query, { operation_id: "op-1" });
  assert.deepEqual(
    Object.keys(requests[2]?.query ?? {}),
    ["operation_id"],
    "恢复查询只带身份参数，不带批准 / 身份自报字段",
  );
});

check("错回执身份：actor 不一致或回执身份与预期不符都不算成功", () => {
  const markActor = verifyYayaRecoveryIdentity(MARK, {
    ...FACTS,
    operations: [{ ...FACTS.operations[0], planned: { ...PLANNED, actor_account_id: "acc-other" } }],
  });
  assert.deepEqual(markActor, { verifiable: false, reason: "actor_mismatch" });

  const wrongTarget = verifyYayaRecoveryIdentity(MARK, {
    ...FACTS,
    operations: [{ ...FACTS.operations[0], planned: { ...PLANNED, target_id: "obs-2" } }],
  });
  assert.deepEqual(wrongTarget, { verifiable: false, reason: "target_mismatch" });

  const foreignReceipt: YayaOperationReceipt = { ...RECEIPT, actor_account_id: "acc-other" };
  const outcome = queryOperationOutcome([foreignReceipt], PLANNED);
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.kind === "unknown" && outcome.reason, "identity_mismatch");

  // 回执矛盾：同一原操作的回执结果互相矛盾
  const contradictory = verifyYayaRecoveryIdentity(MARK, {
    ...FACTS,
    operations: [
      {
        ...FACTS.operations[0],
        outcome: { kind: "unknown", reason: "contradictory_receipts" },
      },
    ],
  });
  assert.deepEqual(contradictory, { verifiable: false, reason: "contradictory_receipt" });
});

check("终态撤权：终态不可读返回不可核验，正文与派生标题同时受限", () => {
  // APP1 撤权后不返回旧终态正文（outcome 为空），协议层不得折叠成 missing
  const revoked = classifyYayaRunLookup({
    kind: "found",
    run_id: "run-1",
    owner_verified: true,
    state: { kind: "terminal", outcome: null },
  });
  assert.equal(revoked.status === "missing", false, "撤权不得冒充缺失");
  assert.deepEqual(revoked, { status: "unverifiable", reason: "terminal_unreadable" });

  // 消息侧：来源撤权后正文受限，派生标题回退通用标题
  const projection = projectChatMessage(
    messageRef({ sources: [CHILD_SOURCE], independentlyReadable: false }),
    { account_id: OWNER, role: "teacher" },
    [{ fragment_id: "frag-1", source_index: 0, access: "denied" }],
    [{ attachment_id: "att-1", access: "full" }],
  );
  const title = projectConversationTitle(
    { title: "小满今天搭积木很专注", derived_from_fragment_ids: ["frag-1"] },
    projection.fragments,
    "受限会话",
  );
  assert.equal(title.restricted, true);
  assert.equal(title.title, "受限会话");
});

check("旧无绑定消息：缺可信绑定保持 unknown / 受限，正文与 provenance 不外泄", () => {
  const legacy = projectChatMessage(
    messageRef({ sources: [], independentlyReadable: true }),
    { account_id: OWNER, role: "teacher" },
    [],
    [{ attachment_id: "att-1", access: "full" }],
  );
  assert.equal(legacy.visibility, "full", "兜底前的旧投影确实会 full（这就是缺口）");

  const restricted = restrictYayaAssistantProjection(legacy, {
    role: "assistant",
    policy: resolveYayaAssistantFragmentPolicy({ state: "unknown" }),
  });
  assert.equal(restricted.visibility, "unavailable");
  assert.equal(restricted.fragments[0]?.reason, "source_unavailable");
  assert.deepEqual(restricted.attachments, legacy.attachments, "附件继续走 MEDIA / DATA 边界");
  assert.deepEqual(restricted.metadata, legacy.metadata, "元数据白名单不变");

  const text = projectStoredMessageText(
    [
      {
        fragment_id: "frag-1",
        text: "私域答案正文",
        sources: [],
        independently_readable: true,
        provenance: { kind: "model_text", ref_id: null, label: null, derived_from: null },
      },
    ],
    restricted.fragments,
  );
  assert.equal(text[0]?.text, null, "受限片段不得返回正文");

  assert.deepEqual(restrictYayaAssistantProjection(restricted, {
    role: "assistant",
    policy: resolveYayaAssistantFragmentPolicy({ state: "unknown" }),
  }), restricted, "读侧兜底必须幂等");

  // user 消息（教师原输入）不适用 run 绑定，不被误伤
  assert.deepEqual(
    restrictYayaAssistantProjection(legacy, {
      role: "user",
      policy: resolveYayaAssistantFragmentPolicy({ state: "unknown" }),
    }),
    legacy,
    "user 消息不因 run 绑定缺失被降级",
  );
});

check("重复持久化：助手 / 工具消息只有一个通道放行，UI 不再 append", () => {
  assert.deepEqual(authorizeYayaMessageWrite({ channel: "http", role: "user" }), {
    accepted: true,
    writer: "UI1",
  });
  assert.deepEqual(authorizeYayaMessageWrite({ channel: "http", role: "assistant" }), {
    accepted: false,
    reason: "assistant_write_requires_server_channel",
  });
  assert.deepEqual(authorizeYayaMessageWrite({ channel: "http", role: "tool" }), {
    accepted: false,
    reason: "assistant_write_requires_server_channel",
  });
  assert.deepEqual(authorizeYayaMessageWrite({ channel: "run_terminal", role: "assistant" }), {
    accepted: true,
    writer: YAYA_ASSISTANT_MESSAGE_WRITER,
  });
  assert.deepEqual(authorizeYayaMessageWrite({ channel: "run_terminal", role: "user" }), {
    accepted: false,
    reason: "user_write_requires_client_channel",
  });

  // 同一角色不可能被两个通道同时放行 ⇒ 重复落账在协议层不可能
  for (const role of ["user", "assistant", "tool"] as const) {
    const accepted = (["http", "run_terminal"] as const).filter(
      (channel) => authorizeYayaMessageWrite({ channel, role }).accepted,
    );
    assert.equal(accepted.length <= 1, true, `role=${role} 只能有一个写入 owner`);
  }
});

check("未知只查原身份：查无 / 未知不产生新操作身份，也不自动重发", () => {
  const missing = verifyYayaRecoveryIdentity(MARK, { ...FACTS, operations: [] });
  assert.deepEqual(missing, { verifiable: false, reason: "operation_missing" }, "查无 / 未知不折中");

  const noReceipt = queryOperationOutcome([], PLANNED);
  assert.equal(noReceipt.kind === "saved", false, "查无回执不得显示成功");
  assert.deepEqual(noReceipt, { kind: "unknown", reason: "no_receipt" });

  const requests = yayaRecoveryLookupRequests(MARK);
  const operationRequests = requests.filter((request) => request.path === "/api/yaya/operations");
  assert.equal(operationRequests.length, 1, "只按原 operation_id 查询");
  assert.deepEqual(operationRequests[0]?.query, { operation_id: "op-1" });
  assert.equal(
    operationRequests.some((request) => request.method !== "GET"),
    false,
    "未知结果只查询，不派发 POST",
  );
});

check("保存详情不可读与未保存分离，finished 返回可读终态而非仅提示历史", () => {
  const detailUnavailable = queryOperationOutcome(
    [{ ...RECEIPT, status: "saved_detail_unavailable" }],
    PLANNED,
  );
  assert.equal(detailUnavailable.kind, "saved_detail_unavailable");
  const notSaved = queryOperationOutcome([], PLANNED);
  assert.equal(notSaved.kind === detailUnavailable.kind, false, "详情不可读 ≠ 未保存");

  const finished = classifyYayaRunLookup({
    kind: "found",
    run_id: "run-1",
    owner_verified: true,
    state: {
      kind: "terminal",
      outcome: { kind: "answered", content: "小满今天很专注。", sources: [] },
    },
  });
  assert.equal(finished.status, "finished");
  assert.equal(finished.status === "finished" && finished.outcome.kind, "answered");
  assert.equal(
    finished.status === "finished" && finished.outcome.kind === "answered"
      ? finished.outcome.content.length > 0
      : false,
    true,
    "finished 必须带当前可读终态内容",
  );
  assert.equal(parseYayaRunLookupResponse(finished).ok, true, "finished 往返必须可解析");
});

check("标记不是批准：自报权威 / 秘密 / 角色字段一律拒绝", () => {
  assert.equal(YAYA_CHAT_BIND_VERSION, "yaya-chat-bind-v1");
  assert.equal(parseYayaChatRecoveryMark(MARK).ok, true);

  const withPrincipal = parseYayaChatRecoveryMark({ ...MARK, principal: { account_id: OWNER } });
  assert.equal(withPrincipal.ok, false);
  assert.equal(firstCode(withPrincipal), "malformed_request");

  const withApproval = parseYayaChatRecoveryMark({ ...MARK, approved: true });
  assert.equal(withApproval.ok, false);
  assert.equal(firstCode(withApproval), "malformed_request");

  const withRole = parseYayaChatRecoveryMark({ ...MARK, role: "admin" });
  assert.equal(withRole.ok, false, "标记不含角色：owner 先于角色");

  const withSecret = parseYayaChatRecoveryMark({ ...MARK, token: "session-token" });
  assert.equal(withSecret.ok, false);
  assert.equal(firstCode(withSecret), "secret_field_present");

  const withoutProposal = parseYayaChatRecoveryMark({ ...MARK, proposal: null });
  assert.equal(withoutProposal.ok, false, "带操作身份必须同时带提案身份");

  const badDigest = parseYayaChatRecoveryMark({
    ...MARK,
    operations: [{ ...MARK.operations[0], content_digest: "not-a-digest" }],
  });
  assert.equal(badDigest.ok, false);
});

/* ------------------------------- 协议边界 ------------------------------- */

check("协议模块无 Next / 数据库 / 模型 / node: 依赖（浏览器边界）", () => {
  const source = readFileSync(
    new URL("../../src/lib/yaya/chat-bind-contract.ts", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "next/server",
    "pg-client",
    "invokeLlm",
    "fetch(",
    'from "./storage-types"',
    'from "./data/',
  ]) {
    assert.equal(source.includes(forbidden), false, `chat-bind-contract.ts 不应包含 ${forbidden}`);
  }
  assert.equal(/from\s+["']node:/.test(source), false, "chat-bind-contract.ts 不得引用 node: 模块");
  assert.ok(source.includes("YAYA_API_PATHS"), "恢复路径必须复用 API0 冻结常量");
  assert.equal(
    source.includes("/api/yaya/operations?"),
    false,
    "不得在本模块内 fork operations 路径字面量",
  );
});

check("协议模块可真实 browser-target 打包（esbuild platform=browser）", () => {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const requireFromHere = createRequire(import.meta.url);
  const tsupPath = requireFromHere.resolve("tsup");
  const esbuild = createRequire(tsupPath)("esbuild") as {
    buildSync(options: Record<string, unknown>): unknown;
  };
  esbuild.buildSync({
    stdin: {
      contents:
        "import { parseYayaChatRecoveryMark, verifyYayaRecoveryIdentity, restrictYayaAssistantProjection, yayaRecoveryLookupRequests, buildYayaRunSourceBinding } from './src/lib/yaya/chat-bind-contract'; console.log(parseYayaChatRecoveryMark({}), verifyYayaRecoveryIdentity, restrictYayaAssistantProjection, yayaRecoveryLookupRequests, buildYayaRunSourceBinding);",
      resolveDir: projectRoot,
      sourcefile: "chat-bind-contract-browser-check.ts",
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
