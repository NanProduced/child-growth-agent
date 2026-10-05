import assert from "node:assert/strict";

import type { Principal } from "../src/lib/accounts/types";
import {
  basisQuoteChoices,
  guideDecisionChoiceLabels,
  guideItemRuleLine,
  guideLinkStatusLabel,
  guideSupportLabel,
  isHealthReference,
  type BasisSourceOption,
} from "../src/lib/guide/association-types";
import {
  decisionBasisFingerprint,
  decisionDraftKey,
  draftToDecisionInput,
  emptyDecisionDraft,
  pendingStaleReason,
  sustainedConditionError,
  validateDecisionDraft,
  type DecisionDraft,
  type PendingDecisionDraft,
} from "../src/lib/guide/decision-draft";
import {
  confirmAppliedIsDecisive,
  mutationTargetOutcome,
  parseGuideMutationResponse,
  parseHostObservationResponse,
  parseReviewConfirmResponse,
  rawTargetOutcome,
  readRawGuideLinks,
  readRawRevision,
} from "../src/lib/guide/mutation-response";
import {
  observationFocusFromSearch,
  observationFocusQuery,
  recordObservationHref,
  safeEvidenceReturnHref,
  safeGuideItemId,
  withEvidenceItemFocus,
} from "../src/lib/guide/navigation";
import {
  guideAccessForChild,
  guideCanCreateObservation,
  type IdentityFacts,
} from "../src/lib/guide/write-access-rules";
import { isReliableChildShape, loadChildren } from "../src/lib/child-list-client";
import type { EvidenceLinkView } from "../src/lib/guide/view-types";
import type { Child } from "../src/lib/types";

/**
 * G6-WRITE1 离线检查：关注点/返回上下文白名单、决定草稿校验（与服务端同口径的最小前置）、
 * 写权限规则（管理员/原班历史只读/无权限）、幼儿列表加载状态与引用片段候选。
 * 纯断言，不写数据库、不调用模型、不启动服务。
 * 运行：pnpm tsx scripts/check-guide-write-flow.ts
 */

const teacher = (classIds: string[]): Principal => ({
  account_id: "acct-teacher",
  username: "teacher",
  display_name: "教师",
  role: "teacher",
  account_status: "active",
  scope: { kind: "classes", class_ids: classIds },
});

const admin: Principal = {
  account_id: "acct-admin",
  username: "admin",
  display_name: "管理员",
  role: "admin",
  account_status: "active",
  scope: { kind: "school", school_id: "school-1" },
};

const none: IdentityFacts = { kind: "none" };

const draft = (overrides: Partial<DecisionDraft> = {}): DecisionDraft => ({
  ...emptyDecisionDraft("item-1", [
    { observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text", quote_field: null },
  ]),
  support: "single_event",
  ...overrides,
});

let passed = 0;
const ok = (condition: boolean, message: string) => {
  assert.ok(condition, message);
  passed += 1;
};

async function main(): Promise<void> {
  /* ---------------- 关注点与返回上下文白名单 ---------------- */
  ok(safeGuideItemId("item.moe.health.1.3-4.1") === "item.moe.health.1.3-4.1", "合法条目 id 保留");
  ok(safeGuideItemId("../../etc/passwd") === null, "路径样式条目 id 拒绝");
  ok(safeGuideItemId("a b") === null, "含空白条目 id 拒绝");

  ok(
    safeEvidenceReturnHref("/children/abc/evidence?domain=health&age_band=3-4") ===
      "/children/abc/evidence?domain=health&age_band=3-4",
    "合法证据页返回地址保留查询",
  );
  ok(safeEvidenceReturnHref("/classes/klass-1/evidence") === "/classes/klass-1/evidence", "班级证据页接受");
  ok(safeEvidenceReturnHref("https://evil.example/children/a/evidence") === null, "外部地址拒绝");
  ok(safeEvidenceReturnHref("//evil.example/children/a/evidence") === null, "协议相对地址拒绝");
  ok(safeEvidenceReturnHref("/children/a/other") === null, "非证据页路径拒绝");
  ok(safeEvidenceReturnHref("/children/a/evidence\\x") === null, "反斜杠拒绝");
  ok(safeEvidenceReturnHref(`/children/a/evidence?q=${"x".repeat(2100)}`) === null, "超长返回地址拒绝");

  const focusQuery = observationFocusQuery({
    itemId: "item.moe.language.1.3-4.1",
    returnTo: "/children/c1/evidence?semester_id=s1",
  });
  ok(
    focusQuery ===
      `item_id=${encodeURIComponent("item.moe.language.1.3-4.1")}&return_to=${encodeURIComponent("/children/c1/evidence?semester_id=s1")}`,
    "关注点查询只输出白名单字段",
  );
  const parsedFocus = observationFocusFromSearch({
    item_id: "item.moe.language.1.3-4.1",
    return_to: ["/classes/k1/evidence", "https://evil.example"],
  });
  ok(parsedFocus.itemId === "item.moe.language.1.3-4.1", "数组查询取第一个合法值");
  ok(parsedFocus.returnTo === "/classes/k1/evidence", "返回地址取第一个合法值");
  ok(observationFocusFromSearch({ item_id: "bad id", return_to: "https://evil" }).returnTo === null, "非法返回被丢弃");

  const recordHref = recordObservationHref({
    childId: "child-1",
    itemId: "item.moe.health.1.3-4.1",
    returnTo: "/children/child-1/evidence?scope=all_history",
  });
  ok(recordHref.startsWith("/observations/new?"), "录入链接指向正式录入页");
  ok(recordHref.includes("child_id=child-1"), "携带 child_id");
  ok(recordHref.includes("item_id=item.moe.health.1.3-4.1"), "携带 item_id");
  ok(recordHref.includes("return_to="), "携带合法返回上下文");
  ok(
    withEvidenceItemFocus("/children/c1/evidence?domain=health&item_id=old", "item-new") ===
      "/children/c1/evidence?domain=health&item_id=item-new",
    "返回时覆盖旧 item_id 并保留筛选",
  );
  ok(
    withEvidenceItemFocus("/children/c1/evidence?domain=health", "bad id") ===
      "/children/c1/evidence?domain=health",
    "非法关注条目不会写入返回地址",
  );

  /* ---------------- 写权限规则（B0：只认园所账号） ---------------- */
  ok(!guideAccessForChild(none, { id: "c1", current_class_id: "a" }).can_record, "无身份不可记录");
  ok(
    !guideAccessForChild({ kind: "principal", principal: admin }, { id: "c1", current_class_id: "a" }).can_record,
    "管理员不能记录（教学动作）",
  );
  const adminChild = guideAccessForChild({ kind: "principal", principal: admin }, { id: "c1", current_class_id: "a" });
  ok(adminChild.read_only_reason?.includes("管理员") === true, "管理员只读原因说明无教学操作权限");
  ok(
    guideAccessForChild({ kind: "principal", principal: teacher(["a"]) }, { id: "c1", current_class_id: "a" }).can_record,
    "任教班级内教师可记录",
  );
  const outOfScope = guideAccessForChild(
    { kind: "principal", principal: teacher(["b"]) },
    { id: "c1", current_class_id: "a" },
  );
  ok(!outOfScope.can_record, "无权限班级不可记录");
  const emptyScope = guideAccessForChild(
    { kind: "principal", principal: teacher([]) },
    { id: "c1", current_class_id: "a" },
  );
  ok(!emptyScope.can_record && emptyScope.read_only_reason !== null, "空任教范围只读并给出原因");
  ok(!guideAccessForChild({ kind: "unavailable" }, { id: "c1", current_class_id: "a" }).can_record, "身份不可用 fail closed");
  const disabledTeacher = guideAccessForChild(
    { kind: "principal", principal: { ...teacher(["a"]), account_status: "disabled" } },
    { id: "c1", current_class_id: "a" },
  );
  ok(!disabledTeacher.can_record, "停用账号不可记录");

  ok(guideCanCreateObservation({ kind: "principal", principal: teacher(["a"]) }), "有任教范围教师可进入录入");
  ok(!guideCanCreateObservation({ kind: "principal", principal: admin }), "管理员不能进入录入");
  ok(!guideCanCreateObservation({ kind: "principal", principal: teacher([]) }), "空范围不能进入录入");
  ok(!guideCanCreateObservation(none), "无身份不能进入录入");
  ok(!guideCanCreateObservation({ kind: "unavailable" }), "身份不可用不能进入录入");

  /* ---------------- 决定草稿校验 ---------------- */
  const basisDates = new Map([
    ["obs-1", "2026-09-20"],
    ["obs-2", "2026-09-21"],
  ]);
  const behaviorItem = { evidence_type: "behavior" as const, adult_help: "allowed" as const };

  ok(
    validateDecisionDraft(draft({ basis: [] }), behaviorItem, basisDates) === "请至少选择一条真实依据。",
    "空依据拒绝",
  );
  const rawWithField = draft({
    basis: [
      { observation_id: "obs-1", quote: "请你先玩。", quote_source: "raw_text", quote_field: "highlights" },
    ],
  });
  ok(
    validateDecisionDraft(rawWithField, behaviorItem, basisDates) === "原文依据不能声明引用位置。",
    "raw_text 带 quote_field 拒绝",
  );
  const contentWithoutField = draft({
    basis: [
      { observation_id: "obs-1", quote: "请你先玩。", quote_source: "confirmed_content", quote_field: null },
    ],
  });
  ok(
    validateDecisionDraft(contentWithoutField, behaviorItem, basisDates) === "确认稿依据只能引用原文金句或发展亮点。",
    "确认稿缺引用位置拒绝",
  );
  ok(
    validateDecisionDraft(
      draft({ support: "clue_only" }),
      behaviorItem,
      basisDates,
    ) === null,
    "线索决定允许单条依据",
  );

  const sustainedItem = { evidence_type: "sustained" as const, adult_help: "allowed" as const };
  ok(
    validateDecisionDraft(draft({ support: "single_event" }), sustainedItem, basisDates) ===
      "该条目属于持续性表现，确认表现必须选择持续表现（或改为确认线索）。",
    "持续条目缺持续支持拒绝",
  );
  ok(
    sustainedConditionError([{ observed_at: "2026-09-20" }], null) !== null,
    "单日无纪要时持续条件不满足",
  );
  ok(
    sustainedConditionError(
      [{ observed_at: "2026-09-20" }, { observed_at: "2026-09-21" }],
      null,
    ) === null,
    "跨日依据满足持续条件",
  );
  const note = { period_start: "2026-09-19", period_end: "2026-09-22", description: "连续四天都能主动轮流表达。" };
  ok(
    validateDecisionDraft(
      draft({ support: "sustained", sustained_note: note }),
      sustainedItem,
      basisDates,
    ) === null,
    "结构化纪要通过持续校验",
  );
  ok(
    sustainedConditionError(
      [{ observed_at: "2026-09-20" }],
      { ...note, period_start: "2026-09-21" },
    ) !== null,
    "纪要期间未覆盖依据时拒绝",
  );
  ok(
    sustainedConditionError(
      [{ observed_at: "2026-09-20" }],
      { ...note, description: "太短" },
    ) !== null,
    "纪要说明少于 10 字拒绝",
  );

  ok(
    validateDecisionDraft(
      draft({ adult_help_used: true, teacher_note: "" }),
      behaviorItem,
      basisDates,
    ) === "本次决定使用了成人帮助，确认表现时必须说明帮助方式。",
    "成人帮助确认表现必须说明方式",
  );
  ok(
    validateDecisionDraft(
      draft({ adult_help_used: true, teacher_note: "老师示范后一起完成。" }),
      behaviorItem,
      basisDates,
    ) === null,
    "说明帮助方式后允许确认表现",
  );
  ok(
    validateDecisionDraft(
      draft({ adult_help_used: true, teacher_note: "老师牵手完成。" }),
      { evidence_type: "behavior", adult_help: "requires_independence" },
      basisDates,
    ) === "该条目要求幼儿独立完成，有成人帮助时只能确认相关线索。",
    "要求独立条目有成人帮助只能确认线索",
  );
  ok(
    validateDecisionDraft(
      draft({ support: "clue_only", adult_help_used: true }),
      { evidence_type: "behavior", adult_help: "requires_independence" },
      basisDates,
    ) === null,
    "要求独立条目仍可确认线索",
  );

  const manualInput = draftToDecisionInput(draft({ teacher_note: "  " }));
  ok("item_id" in manualInput && !("link_id" in manualInput), "手动关联使用 item_id");
  ok(!("teacher_note" in manualInput), "空白教师备注不提交");
  const linkInput = draftToDecisionInput(draft({ link_id: "link-1", support: "clue_only" }));
  ok("link_id" in linkInput && !("item_id" in linkInput), "已有建议使用 link_id");
  const rawInput = draftToDecisionInput(rawWithField);
  ok(
    rawInput.basis[0].quote_field === null,
    "raw_text 依据提交时强制 quote_field=null",
  );
  ok(
    decisionDraftKey(draft()) === decisionDraftKey(draft()),
    "相同决定的键一致",
  );

  /* ---------------- 引用片段候选 ---------------- */
  const source: BasisSourceOption = {
    id: "obs-1",
    observed_at: "2026-09-20",
    context: "区域活动",
    class_label: "向日葵班 · 中班",
    is_host: false,
    raw_text: "他把小汽车递给同伴，说：请你先玩。随后他退后一步等待。",
    confirmed: { highlight_quote: "请你先玩。", highlights: ["他主动把玩具递给同伴。"] },
    status: "confirmed",
  };
  const choices = basisQuoteChoices(source);
  ok(choices.some((choice) => choice.quote_source === "raw_text" && choice.quote.includes("请你先玩")), "原文片段可选");
  ok(
    choices.some((choice) => choice.quote_field === "highlight_quote" && choice.quote === "请你先玩。"),
    "确认稿金句可选",
  );
  ok(
    choices.some((choice) => choice.quote_field === "highlights" && choice.quote.includes("主动把玩具递给同伴")),
    "确认稿亮点可选",
  );
  const dedup = new Set(choices.map((choice) => choice.quote));
  ok(dedup.size === choices.length, "引用候选不重复");
  const hostChoices = basisQuoteChoices(
    { ...source, is_host: true, confirmed: null },
    { highlight_quote: "请你先玩。", highlights: [] },
  );
  ok(
    hostChoices.some((choice) => choice.quote_field === "highlight_quote"),
    "宿主观察使用当前表单内容生成确认稿候选",
  );

  /* ---------------- 幼儿列表加载状态 ---------------- */
  const fakeResponse = (status: number, raw: string): Response =>
    ({ ok: status >= 200 && status < 300, status, text: async () => raw }) as Response;
  const withFetch = async (status: number, raw: string) =>
    loadChildren(new AbortController().signal, (async () => fakeResponse(status, raw)) as typeof fetch);

  await assert.rejects(() => withFetch(401, "{}"), /教师身份/, "401 不得变成暂无幼儿");
  await assert.rejects(() => withFetch(403, "{}"), /权限/, "403 明确提示无权限");
  await assert.rejects(() => withFetch(503, "{}"), /暂时不可用/, "503 明确提示服务不可用");
  passed += 3;
  await assert.rejects(() => withFetch(200, "<html>"), /无法解析/, "非法 JSON 拒绝");
  passed += 1;
  await assert.rejects(() => withFetch(200, "{}"), /无法识别/, "缺少 children 数组拒绝");
  passed += 1;
  await assert.rejects(
    () => withFetch(200, JSON.stringify({ children: [{ id: "c1" }] })),
    /无法识别/,
    "形状不可信的幼儿项拒绝",
  );
  passed += 1;
  const list = await withFetch(200, JSON.stringify({ children: [{ id: "c1", name: "糖糖" }] }));
  ok(list.length === 1 && list[0].id === "c1", "合法列表通过");
  ok(isReliableChildShape({ id: "c1", name: "糖糖" }), "可信形状断言");
  ok(!isReliableChildShape({ id: "", name: "糖糖" }), "空 id 不可信");
  await assert.rejects(
    () =>
      loadChildren(
        new AbortController().signal,
        (async () => {
          throw new TypeError("network down");
        }) as typeof fetch,
      ),
    TypeError,
    "网络失败原样抛出",
  );
  passed += 1;

  const children: Child[] = [];
  void children;

  /* ---------------- R1：写入结果响应核对（反例不是只看 HTTP 状态） ---------------- */
  const validLink: EvidenceLinkView = {
    link_id: "link-1",
    item_id: "item-1",
    catalog_version: "moe-3-6-2012.v1",
    origin: "manual",
    status: "confirmed_performance",
    support: "single_event",
    sustained_note: null,
    adult_help_used: false,
    basis: [
      {
        observation_id: "obs-1",
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: null,
        source_confirmed_at: "2026-09-20T01:00:00.000Z",
        valid: true,
        invalid_reason: null,
        observation_status: "confirmed",
      },
    ],
    ai_reason: null,
    teacher_note: null,
    revision: 1,
    created_at: "2026-09-20T01:00:00.000Z",
    decided_at: "2026-09-20T01:00:00.000Z",
    withdrawn_at: null,
    withdrawn_reason: null,
    counts_toward_status: true,
    excluded_reason: null,
  };

  const mutationRaw = (payload: unknown) => JSON.stringify(payload);
  const okMutation = parseGuideMutationResponse(
    200,
    mutationRaw({ observation_id: "obs-host", revision: 1, links: [validLink] }),
    "obs-host",
  );
  ok(okMutation.ok && okMutation.value.links.length === 1 && okMutation.value.notice === null, "指南操作合法响应通过");
  const idempotent = parseGuideMutationResponse(
    200,
    mutationRaw({ observation_id: "obs-host", revision: 0, links: [validLink] }),
    "obs-host",
  );
  ok(idempotent.ok && idempotent.value.revision === 0, "幂等结果允许 revision 不递增");
  const emptyObject = parseGuideMutationResponse(200, "{}", "obs-host");
  ok(!emptyObject.ok && emptyObject.failure.kind === "invalid_shape", "200 {} 不得当作成功");
  const invalidJson = parseGuideMutationResponse(200, "<html>", "obs-host");
  ok(!invalidJson.ok && invalidJson.failure.kind === "invalid_json", "非法 JSON 不得当作成功");
  const wrongHost = parseGuideMutationResponse(
    200,
    mutationRaw({ observation_id: "obs-other", revision: 2, links: [validLink] }),
    "obs-host",
  );
  ok(!wrongHost.ok && wrongHost.failure.kind === "invalid_shape", "错误宿主不得当作成功");
  const invalidLinks = parseGuideMutationResponse(
    200,
    mutationRaw({ observation_id: "obs-host", revision: 2, links: [{ link_id: "x" }] }),
    "obs-host",
  );
  ok(!invalidLinks.ok && invalidLinks.failure.kind === "invalid_shape", "非法 links 不得当作成功");
  const withNotice = parseGuideMutationResponse(
    200,
    mutationRaw({
      observation_id: "obs-host",
      revision: 3,
      links: [validLink],
      notice: { code: "ai_link_failed", severity: "warning", message: "引用未通过核对" },
    }),
    "obs-host",
  );
  ok(withNotice.ok && withNotice.value.notice?.code === "ai_link_failed", "AI 失败 notice 原样保留");
  const conflict = parseGuideMutationResponse(
    409,
    mutationRaw({ error: "state_conflict", message: "revision 过期" }),
    "obs-host",
  );
  ok(!conflict.ok && conflict.failure.kind === "http" && conflict.failure.error === "state_conflict", "409 映射为明确失败");

  /* 本次目标结果 */
  ok(mutationTargetOutcome([validLink], { action: "confirm", link_id: "link-1", item_id: "item-1" }) === "applied", "确认目标已生效");
  ok(
    mutationTargetOutcome(
      [{ ...validLink, status: "rejected" }],
      { action: "confirm", link_id: "link-1", item_id: "item-1" },
    ) === "not_applied",
    "确认目标被拒绝时不算成功",
  );
  ok(mutationTargetOutcome([], { action: "confirm", link_id: "link-1", item_id: "item-1" }) === "unconfirmed", "目标缺失需要读回");
  ok(
    mutationTargetOutcome([validLink], { action: "confirm", link_id: null, item_id: "item-1" }) === "applied",
    "手动关联目标按 manual 条目核对",
  );
  ok(
    mutationTargetOutcome(
      [{ ...validLink, status: "rejected" }],
      { action: "reject", link_id: "link-1" },
    ) === "applied",
    "不采用目标已终态",
  );
  ok(
    mutationTargetOutcome([validLink], { action: "reject", link_id: "link-1" }) === "not_applied",
    "不采用未生效不算成功",
  );
  ok(
    mutationTargetOutcome(
      [{ ...validLink, status: "withdrawn" }],
      { action: "withdraw", link_id: "link-1" },
    ) === "applied",
    "撤回目标已终态",
  );

  /* 已授权读回 */
  const readOk = parseHostObservationResponse(
    200,
    mutationRaw({
      observations: [
        { id: "obs-host", child_id: "child-1", status: "confirmed", guide_evidence: { revision: 4, links: [] } },
      ],
    }),
    "obs-host",
  );
  ok(readOk.ok && readOk.observation.status === "confirmed", "读回找到宿主并通过形状核对");
  const readMissing = parseHostObservationResponse(
    200,
    mutationRaw({ observations: [] }),
    "obs-host",
  );
  ok(!readMissing.ok && readMissing.kind === "not_found", "列表未找到宿主是 not_found（不能证明未写入）");
  const readDenied = parseHostObservationResponse(401, mutationRaw({ message: "需要登录" }), "obs-host");
  ok(!readDenied.ok && readDenied.kind === "http" && readDenied.status === 401, "读回 401 不视为未保存");
  const readBroken = parseHostObservationResponse(200, JSON.stringify({ observations: [{ id: "obs-host" }] }), "obs-host");
  ok(!readBroken.ok && readBroken.kind === "invalid_shape", "读回形状不可核对");

  /* 原始容器核对 */
  ok(readRawRevision({ revision: 3, links: [] }) === 3, "原始容器修订可读");
  ok(readRawRevision({ links: [] }) === null, "修订缺失不当作 0");
  ok(readRawGuideLinks(null)?.length === 0, "NULL 容器是正常未关联");
  ok(readRawGuideLinks({ links: [{ foo: 1 }] }) === null, "损坏容器不可当作无关联");
  ok(
    rawTargetOutcome(
      { revision: 2, links: [{ id: "link-1", item_id: "item-1", status: "confirmed_performance", origin: "manual" }] },
      { action: "confirm", link_id: "link-1", item_id: "item-1" },
    ) === "applied",
    "读回原始容器确认目标已生效",
  );
  ok(
    rawTargetOutcome({ revision: 2, links: [] }, { action: "reject", link_id: "link-1" }) === "not_applied",
    "读回权威事实下目标缺失即未写入",
  );
  ok(
    rawTargetOutcome({ revision: 2, links: [{ id: "l", item_id: "i", status: "whatever", origin: "manual" }] }, { action: "confirm", link_id: null, item_id: "i" }) === "not_applied",
    "读回手动目标状态不符即未生效",
  );
  ok(
    rawTargetOutcome({ links: "broken" }, { action: "confirm", link_id: null, item_id: "i" }) === "unconfirmed",
    "读回容器不可读时仍需待核对",
  );

  /* Review 确认响应 */
  const reviewOk = parseReviewConfirmResponse(
    200,
    mutationRaw({
      observation: {
        id: "obs-host",
        child_id: "child-1",
        status: "confirmed",
        agent_context: null,
        ai_draft: null,
        ai_model: null,
        ai_organized_at: null,
        confirmed_content: null,
        confirmed_at: "2026-09-20T02:00:00.000Z",
        updated_at: "2026-09-20T02:00:00.000Z",
      },
      guideEvidence: { status: "applied", revision: 5, links: [validLink] },
      profileUpdateStatus: "updated",
    }),
    "obs-host",
    "child-1",
  );
  ok(
    reviewOk.ok && confirmAppliedIsDecisive(reviewOk.value.guideEvidence) === "saved_with_links",
    "归档+关联响应核对为已保存",
  );
  const detailUnavailable = parseReviewConfirmResponse(
    200,
    mutationRaw({
      observation: {
        id: "obs-host",
        child_id: "child-1",
        status: "confirmed",
        agent_context: null,
        ai_draft: null,
        ai_model: null,
        ai_organized_at: null,
        confirmed_content: null,
        confirmed_at: "2026-09-20T02:00:00.000Z",
      },
      guideEvidence: { status: "applied", detail_unavailable: true, message: "详情暂不可读" },
    }),
    "obs-host",
    "child-1",
  );
  ok(
    detailUnavailable.ok &&
      confirmAppliedIsDecisive(detailUnavailable.value.guideEvidence) === "saved_detail_unavailable",
    "applied+detail_unavailable 是已保存的充分事实",
  );
  const deferredResponse = parseReviewConfirmResponse(
    200,
    mutationRaw({
      observation: {
        id: "obs-host",
        child_id: "child-1",
        status: "ai_organized",
        agent_context: null,
        ai_draft: null,
        ai_model: null,
        ai_organized_at: null,
        confirmed_content: null,
        confirmed_at: null,
      },
      requiresAgentConfirmation: true,
      guideEvidence: { status: "deferred" },
    }),
    "obs-host",
    "child-1",
  );
  ok(
    deferredResponse.ok && confirmAppliedIsDecisive(deferredResponse.value.guideEvidence) === "deferred",
    "未归档 deferred 不当作已生效",
  );
  const reviewEmpty = parseReviewConfirmResponse(200, "{}", "obs-host", "child-1");
  ok(!reviewEmpty.ok && reviewEmpty.failure.kind === "invalid_shape", "200 {} 的确认响应不得当作成功");
  const reviewWrongChild = parseReviewConfirmResponse(
    200,
    mutationRaw({
      observation: {
        id: "obs-host",
        child_id: "child-2",
        status: "confirmed",
        agent_context: null,
        ai_draft: null,
        ai_model: null,
        ai_organized_at: null,
        confirmed_content: null,
        confirmed_at: "2026-09-20T02:00:00.000Z",
      },
    }),
    "obs-host",
    "child-1",
  );
  ok(!reviewWrongChild.ok, "确认响应幼儿不一致拒绝");
  const reviewInvalidLinks = parseReviewConfirmResponse(
    200,
    mutationRaw({
      observation: {
        id: "obs-host",
        child_id: "child-1",
        status: "confirmed",
        agent_context: null,
        ai_draft: null,
        ai_model: null,
        ai_organized_at: null,
        confirmed_content: null,
        confirmed_at: "2026-09-20T02:00:00.000Z",
      },
      guideEvidence: { status: "applied", revision: 5, links: [{ link_id: "x" }] },
    }),
    "obs-host",
    "child-1",
  );
  ok(!reviewInvalidLinks.ok, "确认响应非法 links 拒绝");

  /* ---------------- R1：未提交草稿的修订/依据失效 ---------------- */
  const staleSources: BasisSourceOption[] = [
    {
      id: "obs-1",
      observed_at: "2026-09-20",
      context: "区域活动",
      class_label: null,
      is_host: false,
      raw_text: "他把小汽车递给同伴，说：请你先玩。",
      confirmed: { highlight_quote: "请你先玩。", highlights: [] },
      status: "confirmed",
    },
  ];
  const pendingDraft = draft({ support: "clue_only" });
  const fingerprint = decisionBasisFingerprint(pendingDraft.basis, staleSources);
  ok(fingerprint !== null, "依据指纹可计算");
  const pendingRow: PendingDecisionDraft = {
    draft: pendingDraft,
    basedOnRevision: 2,
    basisFingerprint: fingerprint ?? "",
  };
  ok(pendingStaleReason(pendingRow, 2, staleSources) === null, "同修订同依据的草稿有效");
  ok(
    pendingStaleReason(pendingRow, 3, staleSources)?.includes("修订") === true,
    "服务端修订变化后草稿必须重新核对",
  );
  ok(
    decisionBasisFingerprint(pendingDraft.basis, []) === null,
    "依据来源缺失时无法核验",
  );
  const changedSource: BasisSourceOption[] = [
    { ...staleSources[0], confirmed: { highlight_quote: "请你先玩。", highlights: ["后来补充的亮点"] } },
  ];
  ok(
    pendingStaleReason({ ...pendingRow, basedOnRevision: 3 }, 3, changedSource)?.includes("依据") === true,
    "依据来源内容变化后草稿必须重新核对",
  );

  /* ---------------- R1：保健参考语义 ---------------- */
  ok(isHealthReference("health_reference") && !isHealthReference("behavior"), "保健参考判定");
  ok(guideLinkStatusLabel("health_reference", "confirmed_performance") === "资料已核对", "保健参考不套行为确认文案");
  ok(guideLinkStatusLabel("behavior", "confirmed_performance") === "已确认观察到", "行为条目保持原状态文案");
  ok(guideSupportLabel("health_reference", "single_event") === "单次资料", "保健参考使用资料语义");
  ok(
    guideDecisionChoiceLabels("health_reference").performance === "资料已核对" &&
      guideDecisionChoiceLabels("behavior").performance === "已确认观察到",
    "编辑器决定文案按条目类型区分",
  );
  const healthRule = guideItemRuleLine({ evidence_type: "health_reference", age_band: "3-4", adult_help: "allowed" });
  ok(
    healthRule.includes("不参与行为统计") && healthRule.includes("不构成发展确认") && !healthRule.includes("成人帮助"),
    "保健参考规则不出现成人帮助/能力判断",
  );
  ok(
    guideItemRuleLine({ evidence_type: "behavior", age_band: "3-4", adult_help: "allowed" }).includes("成人帮助"),
    "行为条目保留成人帮助规则",
  );

  console.log(
    JSON.stringify({ passed, total: passed, offline: true, db: false, model_requests: 0 }),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
