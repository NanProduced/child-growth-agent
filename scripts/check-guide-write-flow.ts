import assert from "node:assert/strict";

import type { Principal } from "../src/lib/accounts/types";
import { basisQuoteChoices, type BasisSourceOption } from "../src/lib/guide/association-types";
import {
  decisionDraftKey,
  draftToDecisionInput,
  emptyDecisionDraft,
  sustainedConditionError,
  validateDecisionDraft,
  type DecisionDraft,
} from "../src/lib/guide/decision-draft";
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
  guideAccessForObservation,
  guideCanCreateObservation,
  type IdentityFacts,
} from "../src/lib/guide/write-access-rules";
import { isReliableChildShape, loadChildren } from "../src/lib/child-list-client";
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

const legacy: IdentityFacts = { kind: "legacy_teacher" };
const none: IdentityFacts = { kind: "none" };

const observation = (currentClassId: string | null) => ({
  observation_id: "obs-1",
  child_id: "child-1",
  current_class_id: currentClassId,
  observed_class_id: "class-a",
  author_account_id: null,
});

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

  /* ---------------- 写权限规则 ---------------- */
  ok(guideAccessForChild(legacy, { id: "c1", current_class_id: "a" }).can_record, "旧口令教师可记录");
  ok(!guideAccessForChild(none, { id: "c1", current_class_id: "a" }).can_record, "无身份不可记录");
  ok(
    !guideAccessForChild({ kind: "principal", principal: admin }, { id: "c1", current_class_id: "a" }).can_record,
    "管理员不能记录（教学动作）",
  );
  ok(
    guideAccessForChild({ kind: "principal", principal: teacher(["a"]) }, { id: "c1", current_class_id: "a" }).can_record,
    "任教班级内教师可记录",
  );
  ok(
    !guideAccessForChild({ kind: "principal", principal: teacher(["b"]) }, { id: "c1", current_class_id: "a" }).can_record,
    "无权限班级不可记录",
  );
  const emptyScope = guideAccessForChild(
    { kind: "principal", principal: teacher([]) },
    { id: "c1", current_class_id: "a" },
  );
  ok(!emptyScope.can_record && emptyScope.read_only_reason !== null, "空任教范围只读并给出原因");

  const inScopeObservation = guideAccessForObservation(
    { kind: "principal", principal: teacher(["class-a"]) },
    observation("class-a"),
  );
  ok(inScopeObservation.can_decide && inScopeObservation.can_organize, "当前负责教师可决定与整理");
  const historicalReadOnly = guideAccessForObservation(
    { kind: "principal", principal: teacher(["class-a"]) },
    observation("class-b"),
  );
  ok(!historicalReadOnly.can_decide, "原班历史只读时不能写入关联");
  ok(
    historicalReadOnly.read_only_reason?.includes("操作权限") === true,
    "只读原因说明无操作权限",
  );
  const adminObservation = guideAccessForObservation({ kind: "principal", principal: admin }, observation("class-a"));
  ok(!adminObservation.can_decide && !adminObservation.can_organize, "管理员没有教学写权限");
  ok(guideAccessForObservation(legacy, observation("class-a")).can_decide, "旧口令教师可决定关联");

  ok(guideCanCreateObservation(legacy), "旧口令教师可进入录入");
  ok(guideCanCreateObservation({ kind: "principal", principal: teacher(["a"]) }), "有任教范围教师可进入录入");
  ok(!guideCanCreateObservation({ kind: "principal", principal: admin }), "管理员不能进入录入");
  ok(!guideCanCreateObservation({ kind: "principal", principal: teacher([]) }), "空范围不能进入录入");
  ok(!guideCanCreateObservation(none), "无身份不能进入录入");

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

  console.log(
    JSON.stringify({ passed, total: passed, offline: true, db: false, model_requests: 0 }),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
