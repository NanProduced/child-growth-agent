import assert from "node:assert/strict";

import { guideItemById } from "../src/lib/guide/item-index";
import {
  applyGuideDecisions,
  applyGuideTerminalOperation,
  GuideEvidenceCatalogError,
  GuideEvidenceConflictError,
  GuideEvidenceInvalidError,
  GuideEvidenceNotFoundError,
  type ApplyDecisionsContext,
  type DecisionSourceObservation,
} from "../src/lib/guide/decisions";
import {
  buildChildEvidenceBook,
  buildClassEvidenceOverview,
  parseEvidenceFilters,
} from "../src/lib/guide/read-model";
import {
  buildMutationLinkViews,
  checkBasis,
  classifyGuideEvidence,
  evaluateLink,
  parseGuideEvidence,
  rollupChildItem,
  rollupClassItem,
  type EvidenceObservation,
} from "../src/lib/guide/runtime";
import {
  buildGuideSuggestionMessages,
  generateGuideEvidenceSuggestions,
  GUIDE_SUGGESTION_SYSTEM_PROMPT,
} from "../src/lib/guide/suggest";
import {
  GUIDE_CATALOG_VERSION,
  type GuideEvidenceLink,
  type ObservationGuideEvidence,
} from "../src/lib/guide/types";
import type { EvidenceScope, EvidenceViewFilters } from "../src/lib/guide/view-types";
import type { Child, Observation } from "../src/lib/types";
import {
  guideEvidenceMutationSchema,
  guideEvidencePeriodNoteSchema,
} from "../src/lib/validation";

/**
 * G5 运行时离线检查：解析/依据核对/状态计算/教师决定/AI 建议校验/读模型纯构建。
 * 不写数据库、不调用模型（invoke 全部注入替身）。运行：
 *   pnpm tsx scripts/check-guide-evidence-runtime.ts
 */

let passed = 0;
function ok(condition: boolean, message: string): void {
  assert.ok(condition, message);
  passed += 1;
}
function eq<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message);
  passed += 1;
}
function throws(fn: () => unknown, predicate: (error: Error) => boolean, message: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error && predicate(caught), message);
  passed += 1;
}

const CHILD = "c0000000-0000-4000-8000-000000000001";
const OTHER_CHILD = "c0000000-0000-4000-8000-000000000002";
const OBS_A = "o0000000-0000-4000-8000-000000000001";
const OBS_B = "o0000000-0000-4000-8000-000000000002";
const OBS_C = "o0000000-0000-4000-8000-000000000003";
const OBS_OTHER = "o0000000-0000-4000-8000-000000000004";
const NOW = "2026-10-03T08:00:00.000Z";

const ITEM_ALLOWED = "item.moe.language.listening_speaking.1.3-4.1";
const ITEM_REQUIRES_INDEPENDENCE = "item.moe.health.daily_living.1.5-6.2";
const ITEM_SUSTAINED = "item.moe.language.reading_writing.1.4-5.1";
const ITEM_SUSTAINED_INDEPENDENCE = "item.moe.health.daily_living.1.5-6.6";
const ITEM_HEALTH = "item.moe.health.physical.1.3-4.1";

const RAW_A = "他把小汽车递给同伴，说：请你先玩。";
const RAW_B = "她在图书区安静地翻看绘本，一页一页讲给旁边的小朋友听。";
const RAW_C = "他主动把积木分给同伴一起搭桥。";

const CONTENT_A = {
  domain: "语言",
  sub_domain: "倾听与表达",
  objective_description: "这次记录中出现了主动表达。",
  highlights: ["他说：请你先玩。"],
  support_suggestions: ["提供轮流表达的机会。"],
  highlight_quote: "请你先玩。",
};

const SNAPSHOT_MIDDLE = {
  class_id: "k0000000-0000-4000-8000-000000000001",
  class_name: "向日葵班",
  stage: "middle" as const,
  school_year: "2026-2027",
  captured_at: "2026-09-01T00:00:00.000Z",
  source: "enrollment_lookup" as const,
  enrollment_id: "e0000000-0000-4000-8000-000000000001",
  confirmed_at: null,
};

function makeObs(overrides: Partial<EvidenceObservation> & { id: string }): EvidenceObservation {
  return {
    child_id: CHILD,
    observed_at: "2026-09-20",
    raw_text: RAW_A,
    status: "confirmed",
    confirmed_content: { ...CONTENT_A },
    confirmed_at: "2026-09-21T02:00:00.000Z",
    class_context_snapshot: { ...SNAPSHOT_MIDDLE },
    guide_evidence: null,
    ...overrides,
  };
}

function makeLink(overrides: Partial<GuideEvidenceLink> & { id: string; item_id: string }): GuideEvidenceLink {
  return {
    catalog_version: GUIDE_CATALOG_VERSION,
    origin: "manual",
    status: "confirmed_performance",
    support: "single_event",
    adult_help_used: false,
    basis: [
      {
        observation_id: OBS_A,
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: { ...SNAPSHOT_MIDDLE },
        source_confirmed_at: "2026-09-21T02:00:00.000Z",
      },
    ],
    ai_reason: null,
    teacher_note: null,
    revision: 1,
    created_at: "2026-09-22T00:00:00.000Z",
    decided_at: "2026-09-22T00:00:00.000Z",
    withdrawn_at: null,
    withdrawn_reason: null,
    ...overrides,
  };
}

function makeContainer(links: GuideEvidenceLink[], revision = links.length > 0 ? 1 : 0): ObservationGuideEvidence {
  return { revision, links };
}

function decisionContext(sources: EvidenceObservation[]): ApplyDecisionsContext {
  const sourceById = new Map<string, DecisionSourceObservation>();
  for (const source of sources) {
    sourceById.set(source.id, {
      id: source.id,
      child_id: source.child_id,
      observed_at: source.observed_at,
      raw_text: source.raw_text,
      status: source.status,
      confirmed_content: source.confirmed_content,
      confirmed_at: source.confirmed_at,
      class_context_snapshot: source.class_context_snapshot ?? null,
    });
  }
  return { childId: CHILD, itemById: guideItemById, sourceById, now: NOW };
}

const ALL_SCOPE: EvidenceScope = {
  kind: "all_history",
  semester_id: null,
  label: "全部历史",
  start_date: null,
  end_date: null,
  filter_field: "observed_at",
};
const SEMESTER_SCOPE: EvidenceScope = {
  kind: "semester",
  semester_id: "2026-2027-1",
  label: "2026—2027学年第一学期",
  start_date: "2026-09-01",
  end_date: "2027-01-29",
  filter_field: "observed_at",
};

function rollupFor(observations: EvidenceObservation[], itemId: string, scope = ALL_SCOPE, audience: "child_history" | "class_current_roster" = "child_history") {
  const item = guideItemById(itemId);
  assert.ok(item, `目录条目必须存在：${itemId}`);
  const observationById = new Map(observations.map((entry) => [entry.id, entry]));
  return rollupChildItem({
    childId: CHILD,
    observations,
    item,
    observationById,
    scope,
    audience,
    classStage: audience === "class_current_roster" ? "middle" : null,
  });
}

/* ---------------- 1) 无 AI 建议也能手动关联 ---------------- */
function testManualWithoutAi(): void {
  const source = makeObs({ id: OBS_A });
  const parsed = parseGuideEvidence(null);
  const result = applyGuideDecisions(
    parsed,
    [
      {
        item_id: ITEM_ALLOWED,
        support: "single_event",
        basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" }],
      },
    ],
    decisionContext([source]),
  );
  ok(result.changed, "手动关联应产生变更");
  eq(result.revision, 1, "首次写入容器 revision=1");
  const link = result.links[0];
  eq(link.origin, "manual", "手动关联 origin=manual");
  eq(link.status, "confirmed_performance", "单次证据可确认表现");
  eq(link.basis[0].observed_at, "2026-09-20", "observed_at 由服务端生成");
  eq(link.basis[0].source_confirmed_at, "2026-09-21T02:00:00.000Z", "依据版本由服务端生成");
  const rollup = rollupFor([makeObs({ id: OBS_A, guide_evidence: result.container })], ITEM_ALLOWED);
  eq(rollup.status, "confirmed_observed", "手动关联计入正式状态");
  eq(rollup.reliability, "reliable", "有效依据不降可靠性");
}

/* ---------------- 2) 无效依据整批失败 ---------------- */
function testInvalidBasisAllOrNothing(): void {
  const source = makeObs({ id: OBS_A });
  const unconfirmed = makeObs({ id: OBS_B, status: "ai_organized", confirmed_content: null, confirmed_at: null });
  const other = makeObs({ id: OBS_OTHER, child_id: OTHER_CHILD });
  const ctx = decisionContext([source, unconfirmed, other]);

  const validBasis = { observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" as const };
  const cases: Array<{ name: string; basis: typeof validBasis }> = [
    { name: "来源缺失", basis: { observation_id: "o9999999-0000-4000-8000-000000000009", quote: "请你先玩。", quote_source: "raw_text" } },
    { name: "来源未确认", basis: { observation_id: OBS_B, quote: "请你先玩。", quote_source: "raw_text" } },
    { name: "跨儿童", basis: { observation_id: OBS_OTHER, quote: "请你先玩。", quote_source: "raw_text" } },
    { name: "虚构片段", basis: { observation_id: OBS_A, quote: "他分享了玩具并且帮助了老师。", quote_source: "raw_text" } },
  ];
  for (const entry of cases) {
    throws(
      () =>
        applyGuideDecisions(
          parseGuideEvidence(null),
          [
            {
              item_id: ITEM_ALLOWED,
              support: "single_event",
              basis: [validBasis, entry.basis],
            },
          ],
          ctx,
        ),
      (error) => error instanceof GuideEvidenceInvalidError,
      `混入${entry.name}时整批必须失败`,
    );
  }
  // 批量中第二条无效：第一条也不得产生写入（函数抛出，调用方不落库）
  const before = parseGuideEvidence(null);
  throws(
    () =>
      applyGuideDecisions(
        before,
        [
          { item_id: ITEM_ALLOWED, support: "single_event", basis: [validBasis] },
          { item_id: ITEM_SUSTAINED, support: "sustained", basis: [cases[3].basis] },
        ],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceInvalidError,
    "批量中任一条失败整批失败",
  );
  eq(before.kind, "none", "失败批次不得修改输入容器");
}

/* ---------------- 3) 真实片段通过；片段+编造拒绝 ---------------- */
function testQuoteExactness(): void {
  const source = makeObs({ id: OBS_A });
  const ctx = decisionContext([source]);
  const good = applyGuideDecisions(
    parseGuideEvidence(null),
    [{ item_id: ITEM_ALLOWED, support: "single_event", basis: [{ observation_id: OBS_A, quote: "把小汽车递给同伴", quote_source: "raw_text" }] }],
    ctx,
  );
  ok(good.changed, "真实连续片段应通过");
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(null),
        [{ item_id: ITEM_ALLOWED, support: "single_event", basis: [{ observation_id: OBS_A, quote: "把小汽车递给同伴，并邀请全班一起玩", quote_source: "raw_text" }] }],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceInvalidError,
    "真实片段拼接编造后续必须拒绝",
  );
}

/* ---------------- 4) confirmed_content 只允许两个位置 ---------------- */
function testConfirmedContentPositions(): void {
  const source = makeObs({
    id: OBS_A,
    confirmed_content: {
      ...CONTENT_A,
      objective_description: "他很有分享意识。",
      support_suggestions: ["继续鼓励分享行为。"],
      teacher_note: "教师备注：在集体活动后补充。",
    },
  });
  const ctx = decisionContext([source]);
  const quoteFrom = (quote: string, field: "highlight_quote" | "highlights") => ({
    observation_id: OBS_A,
    quote,
    quote_source: "confirmed_content" as const,
    quote_field: field,
  });
  const highlight = applyGuideDecisions(
    parseGuideEvidence(null),
    [{ item_id: ITEM_ALLOWED, support: "single_event", basis: [quoteFrom("请你先玩。", "highlight_quote")] }],
    ctx,
  );
  ok(highlight.changed, "highlight_quote 位置应允许");
  const highlights = applyGuideDecisions(
    parseGuideEvidence(null),
    [{ item_id: ITEM_ALLOWED, support: "single_event", basis: [quoteFrom("请你先玩。", "highlights")] }],
    ctx,
  );
  ok(highlights.changed, "highlights 位置应允许");
  for (const [quote, label] of [
    ["他很有分享意识。", "objective_description"],
    ["继续鼓励分享行为。", "support_suggestions"],
    ["教师备注：在集体活动后补充。", "teacher_note"],
  ] as const) {
    throws(
      () =>
        applyGuideDecisions(
          parseGuideEvidence(null),
          [{ item_id: ITEM_ALLOWED, support: "single_event", basis: [quoteFrom(quote, "highlight_quote")] }],
          ctx,
        ),
      (error) => error instanceof GuideEvidenceInvalidError,
      `${label} 不能作为事实依据`,
    );
  }
  // raw_text 引用不能声明 quote_field
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(null),
        [
          {
            item_id: ITEM_ALLOWED,
            support: "single_event",
            basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text", quote_field: "highlight_quote" }],
          },
        ],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceInvalidError,
    "raw_text 引用不得声明 quote_field",
  );
}

/* ---------------- 5) 来源日期/版本变化后关联失效 ---------------- */
function testVersionInvalidation(): void {
  const link = makeLink({ id: "link-version", item_id: ITEM_ALLOWED });
  const container = makeContainer([link]);
  const changedConfirmedAt = makeObs({
    id: OBS_A,
    guide_evidence: container,
    confirmed_at: "2026-09-30T02:00:00.000Z",
  });
  const rollup = rollupFor([changedConfirmedAt], ITEM_ALLOWED);
  eq(rollup.status, "no_records", "来源确认时间变化后不计入正式状态");
  eq(rollup.reliability, "partial", "版本不一致降为 partial");
  eq(rollup.evaluations[0].excluded_reason, "basis_invalid", "版本不一致按依据失效处理");
  eq(rollup.evaluations[0].basis_checks[0].reason, "version_mismatch", "细分原因为 version_mismatch");

  const changedDate = makeObs({ id: OBS_A, guide_evidence: container, observed_at: "2026-09-25" });
  const rollupDate = rollupFor([changedDate], ITEM_ALLOWED);
  eq(rollupDate.status, "no_records", "来源日期变化后不计入正式状态");

  const stillValid = makeObs({ id: OBS_A, guide_evidence: container });
  eq(rollupFor([stillValid], ITEM_ALLOWED).status, "confirmed_observed", "未变化时正常计入");
}

/* ---------------- 6) 持续性跨期：全部历史计入，本期排除 ---------------- */
function testSustainedCrossPeriod(): void {
  const obsA = makeObs({ id: OBS_A, observed_at: "2026-08-20", raw_text: "他连续几天主动和同伴打招呼。" });
  const obsB = makeObs({ id: OBS_B, observed_at: "2026-09-20", raw_text: "他主动和同伴打招呼并询问名字。" });
  const link = makeLink({
    id: "link-sustained",
    item_id: ITEM_SUSTAINED,
    support: "sustained",
    basis: [
      { observation_id: OBS_A, observed_at: "2026-08-20", quote: "主动和同伴打招呼", quote_source: "raw_text", quote_field: null, class_context: { ...SNAPSHOT_MIDDLE }, source_confirmed_at: "2026-09-21T02:00:00.000Z" },
      { observation_id: OBS_B, observed_at: "2026-09-20", quote: "主动和同伴打招呼", quote_source: "raw_text", quote_field: null, class_context: { ...SNAPSHOT_MIDDLE }, source_confirmed_at: "2026-09-21T02:00:00.000Z" },
    ],
  });
  const container = makeContainer([link]);
  obsA.guide_evidence = container;
  obsB.guide_evidence = container;

  const all = rollupFor([obsA, obsB], ITEM_SUSTAINED, ALL_SCOPE);
  eq(all.status, "confirmed_observed", "全部历史口径计入跨期持续证据");
  const semester = rollupFor([obsA, obsB], ITEM_SUSTAINED, SEMESTER_SCOPE);
  eq(semester.status, "no_records", "本期只有一条依据时不计入");
  eq(semester.evaluations[0].excluded_reason, "basis_out_of_period", "期间不足显式排除");
  eq(semester.reliability, "reliable", "期间排除属于正常口径，不降可靠性");
}

/* ---------------- 7) 成人帮助 allowed / requires_independence ---------------- */
function testAdultHelp(): void {
  const source = makeObs({ id: OBS_A });
  const ctx = decisionContext([source]);
  const basis = [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" as const }];

  const allowed = applyGuideDecisions(
    parseGuideEvidence(null),
    [{ item_id: ITEM_ALLOWED, support: "single_event", basis, adult_help_used: true, teacher_note: "帮助方式：教师语言提示。" }],
    ctx,
  );
  eq(allowed.links[0].status, "confirmed_performance", "allowed 条目说明帮助方式后可确认表现");
  eq(allowed.links[0].adult_help_used, true, "如实记录成人帮助");

  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(null),
        [{ item_id: ITEM_ALLOWED, support: "single_event", basis, adult_help_used: true }],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceInvalidError,
    "成人帮助确认表现必须说明帮助方式",
  );
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(null),
        [{ item_id: ITEM_REQUIRES_INDEPENDENCE, support: "single_event", basis, adult_help_used: true, teacher_note: "扶助完成。" }],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceInvalidError,
    "要求独立完成的条目有成人帮助只能确认线索",
  );
  const clue = applyGuideDecisions(
    parseGuideEvidence(null),
    [{ item_id: ITEM_REQUIRES_INDEPENDENCE, support: "clue_only", basis, adult_help_used: true, teacher_note: "扶助完成。" }],
    ctx,
  );
  eq(clue.links[0].status, "confirmed_clue", "限制条目仍可确认线索");
}

/* ---------------- 8) 结构化纪要：非法日期/短说明/未覆盖 ---------------- */
function testSustainedNote(): void {
  ok(guideEvidencePeriodNoteSchema.safeParse({ period_start: "2026-02-30", period_end: "2026-03-01", description: "连续观察到主动表达的行为。" }).success === false, "非法日历日期被拒绝");
  ok(guideEvidencePeriodNoteSchema.safeParse({ period_start: "2026-03-01", period_end: "2026-03-01", description: "太短" }).success === false, "短说明被拒绝");

  const obsA = makeObs({ id: OBS_A, observed_at: "2026-09-20" });
  const obsB = makeObs({ id: OBS_B, observed_at: "2026-09-28", raw_text: "她主动表达自己的想法。" });
  const ctx = decisionContext([obsA, obsB]);
  const basis = [
    { observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" as const },
    { observation_id: OBS_B, quote: "主动表达自己的想法", quote_source: "raw_text" as const },
  ];
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(null),
        [
          {
            item_id: ITEM_SUSTAINED,
            support: "sustained",
            basis: [basis[0]],
            sustained_note: { period_start: "2026-09-21", period_end: "2026-09-27", description: "这段时间持续观察到主动表达的行为。" },
          },
        ],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceInvalidError,
    "纪要期间未覆盖全部依据必须拒绝",
  );
  const crossDay = applyGuideDecisions(
    parseGuideEvidence(null),
    [{ item_id: ITEM_SUSTAINED, support: "sustained", basis }],
    ctx,
  );
  eq(crossDay.links[0].status, "confirmed_performance", "两条不同日期的依据可支持持续性");
  const singleWithNote = applyGuideDecisions(
    parseGuideEvidence(null),
    [
      {
        item_id: ITEM_SUSTAINED,
        support: "sustained",
        basis: [basis[0]],
        sustained_note: { period_start: "2026-09-19", period_end: "2026-09-21", description: "连续观察到主动表达与轮流等待的行为。" },
      },
    ],
    ctx,
  );
  eq(singleWithNote.links[0].status, "confirmed_performance", "结构化纪要可支持单条依据的持续性");
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(null),
        [{ item_id: ITEM_SUSTAINED, support: "single_event", basis: [basis[0]] }],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceInvalidError,
    "持续性条目不能用单次证据确认表现",
  );
}

/* ---------------- 9) reject/withdraw 保留历史；终态不原地复活 ---------------- */
function testTerminalStates(): void {
  const source = makeObs({ id: OBS_A });
  const aiLink = makeLink({
    id: "link-ai",
    item_id: ITEM_ALLOWED,
    origin: "ai",
    status: "ai_suggested",
    support: null,
    ai_reason: "与表达行为相关",
    decided_at: null,
  });
  const ctx = decisionContext([source]);

  const rejected = applyGuideTerminalOperation(parseGuideEvidence(makeContainer([aiLink])), "reject", "link-ai", "与本次情境不符", ctx);
  ok(rejected.changed, "拒绝待核对建议应产生变更");
  const rejectedLink = rejected.links[0];
  eq(rejectedLink.status, "rejected", "拒绝后状态为 rejected");
  eq(rejectedLink.support, null, "拒绝的 support 必须为 null");
  ok(Boolean(rejectedLink.teacher_note), "拒绝理由保留");
  const rejectedRollup = rollupFor([makeObs({ id: OBS_A, guide_evidence: rejected.container })], ITEM_ALLOWED);
  eq(rejectedRollup.evaluations[0].excluded_reason, "teacher_rejected", "拒绝不计入正式状态");

  const repeat = applyGuideTerminalOperation(parseGuideEvidence(rejected.container), "reject", "link-ai", "与本次情境不符", ctx);
  eq(repeat.changed, false, "完全相同的重复拒绝幂等");
  eq(repeat.revision, rejected.revision, "幂等不增长 revision");
  throws(
    () => applyGuideTerminalOperation(parseGuideEvidence(rejected.container), "reject", "link-ai", "另一个理由", ctx),
    (error) => error instanceof GuideEvidenceConflictError,
    "终态拒绝理由不可改写",
  );
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(rejected.container),
        [{ link_id: "link-ai", support: "single_event", basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" }] }],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceConflictError,
    "被拒绝的关联不能原地复活",
  );

  // 合法重新手动关联：新 link 创建，旧审计保留
  const relinked = applyGuideDecisions(
    parseGuideEvidence(rejected.container),
    [{ item_id: ITEM_ALLOWED, support: "single_event", basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" }] }],
    ctx,
  );
  eq(relinked.links.length, 2, "重新关联保留旧记录并新增 link");
  eq(relinked.links[0].status, "rejected", "旧拒绝记录保留");
  eq(relinked.links[1].status, "confirmed_performance", "新手动关联生效");

  // withdraw：保留 support 与依据
  const confirmed = makeLink({ id: "link-confirmed", item_id: ITEM_ALLOWED });
  const withdrawn = applyGuideTerminalOperation(parseGuideEvidence(makeContainer([confirmed])), "withdraw", "link-confirmed", "教师撤回", ctx);
  const withdrawnLink = withdrawn.links[0];
  eq(withdrawnLink.status, "withdrawn", "撤回后状态为 withdrawn");
  eq(withdrawnLink.support, "single_event", "撤回保留 support 供审计");
  eq(withdrawnLink.basis.length, 1, "撤回保留依据");
  ok(Boolean(withdrawnLink.withdrawn_at), "撤回记录时间");
  const withdrawnRollup = rollupFor([makeObs({ id: OBS_A, guide_evidence: withdrawn.container })], ITEM_ALLOWED);
  eq(withdrawnRollup.evaluations[0].excluded_reason, "withdrawn", "撤回不计入正式状态");
  const withdrawRepeat = applyGuideTerminalOperation(parseGuideEvidence(withdrawn.container), "withdraw", "link-confirmed", "教师撤回", ctx);
  eq(withdrawRepeat.changed, false, "完全相同的重复撤回幂等");
  throws(
    () =>
      applyGuideTerminalOperation(parseGuideEvidence(withdrawn.container), "reject", "link-confirmed", undefined, ctx),
    (error) => error instanceof GuideEvidenceConflictError,
    "已确认关联不能改用拒绝",
  );
  throws(
    () => applyGuideTerminalOperation(parseGuideEvidence(makeContainer([aiLink])), "withdraw", "link-ai", undefined, ctx),
    (error) => error instanceof GuideEvidenceConflictError,
    "待核对建议不能撤回（应拒绝）",
  );
}

/* ---------------- 10) 幂等与内容冲突 ---------------- */
function testIdempotency(): void {
  const source = makeObs({ id: OBS_A });
  const ctx = decisionContext([source]);
  const decision = {
    item_id: ITEM_ALLOWED,
    support: "single_event" as const,
    basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" as const }],
  };
  const first = applyGuideDecisions(parseGuideEvidence(null), [decision], ctx);
  const second = applyGuideDecisions(parseGuideEvidence(first.container), [decision], ctx);
  eq(second.changed, false, "完全相同的重复提交幂等");
  eq(second.revision, first.revision, "幂等不新增 link、不增长 revision");
  eq(second.links.length, 1, "幂等不重复建立关联");

  // 同条目内容不同 → 冲突（不静默覆盖）
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(first.container),
        [
          {
            item_id: ITEM_ALLOWED,
            support: "single_event",
            basis: [{ observation_id: OBS_A, quote: "把小汽车递给同伴", quote_source: "raw_text" }],
          },
        ],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceConflictError,
    "同条目内容不同必须冲突",
  );
  // link_id 改判：线索 ↔ 表现
  const linkId = first.links[0].id;
  const clue = applyGuideDecisions(
    parseGuideEvidence(first.container),
    [{ link_id: linkId, support: "clue_only", basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" }] }],
    ctx,
  );
  eq(clue.links[0].status, "confirmed_clue", "已确认表现可依法改判为线索");
  eq(clue.links[0].revision, 2, "改判使 link revision +1");
  const back = applyGuideDecisions(
    parseGuideEvidence(clue.container),
    [{ link_id: linkId, support: "single_event", basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" }] }],
    ctx,
  );
  eq(back.links[0].status, "confirmed_performance", "线索可改回表现");
  // 不存在的 link_id / item_id
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(null),
        [{ link_id: "link-missing", support: "single_event", basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" }] }],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceNotFoundError,
    "link_id 不属于当前观察返回 not_found",
  );
  throws(
    () =>
      applyGuideDecisions(
        parseGuideEvidence(null),
        [{ item_id: "item.not.in.catalog", support: "single_event", basis: [{ observation_id: OBS_A, quote: "请你先玩。", quote_source: "raw_text" }] }],
        ctx,
      ),
    (error) => error instanceof GuideEvidenceCatalogError,
    "未知 item_id 返回 catalog_version_mismatch",
  );
}

/* ---------------- 16) NULL / 坏 JSON / 未知状态 / 旧版本 ---------------- */
function testCorruptedAndNull(): void {
  eq(parseGuideEvidence(null).kind, "none", "NULL 解析为正常未关联");
  eq(parseGuideEvidence({ revision: 2, links: [] }).kind, "ok", "空 links 是正常结构");
  eq(parseGuideEvidence({ revision: 1 }).kind, "unreadable", "links 缺失是损坏");
  eq(parseGuideEvidence({ revision: 1, links: "nope" }).kind, "unreadable", "links 类型错误是损坏");
  eq(parseGuideEvidence("broken").kind, "unreadable", "非对象是损坏");
  eq(classifyGuideEvidence(null), null, "NULL 不降可靠性");
  eq(classifyGuideEvidence({ revision: 1, links: [{ id: "x", item_id: ITEM_ALLOWED, status: "mystery" }] }), "unknown_status", "未知状态显式识别");
  eq(classifyGuideEvidence({ revision: 1, links: [{ id: "x", item_id: ITEM_ALLOWED, status: "confirmed_performance" }] }), null, "已知状态可读取");

  const readable = makeObs({ id: OBS_A });
  const corrupt = makeObs({ id: OBS_B, guide_evidence: "broken" });
  const partial = rollupFor([readable, corrupt], ITEM_ALLOWED);
  eq(partial.reliability, "partial", "部分损坏按 partial");
  const unavailable = rollupFor([corrupt], ITEM_ALLOWED);
  eq(unavailable.reliability, "unavailable", "全部不可读按 unavailable");
  const nullRollup = rollupFor([readable], ITEM_ALLOWED);
  eq(nullRollup.reliability, "reliable", "NULL 正常未关联保持 reliable");
  eq(nullRollup.status, "no_records", "无关联为真实空态");

  const unknownStatus = makeObs({
    id: OBS_A,
    guide_evidence: { revision: 1, links: [{ id: "x", item_id: ITEM_ALLOWED, status: "mystery" }] },
  });
  const unknownRollup = rollupFor([unknownStatus], ITEM_ALLOWED);
  eq(unknownRollup.reliability, "unavailable", "仅有未知状态容器时按不可用");
  const unknownWithReadable = rollupFor([unknownStatus, makeObs({ id: OBS_C })], ITEM_ALLOWED);
  eq(unknownWithReadable.reliability, "partial", "未知状态 + 可读观察按部分可靠");

  const oldVersion = makeObs({
    id: OBS_A,
    guide_evidence: makeContainer([makeLink({ id: "link-old", item_id: ITEM_ALLOWED, catalog_version: "moe-3-6-2012.v0" })]),
  });
  const oldRollup = rollupFor([oldVersion], ITEM_ALLOWED);
  eq(oldRollup.evaluations[0].excluded_reason, "catalog_mismatch", "旧目录版本保守排除");
  eq(oldRollup.reliability, "partial", "目录版本不一致降可靠性");
}

/* ---------------- 17) 中班回看小班历史 ---------------- */
function testStageAudience(): void {
  const smallSnapshot = { ...SNAPSHOT_MIDDLE, stage: "small" as const, class_name: "芽芽一班" };
  const link = makeLink({
    id: "link-history",
    item_id: ITEM_ALLOWED,
    basis: [
      {
        observation_id: OBS_A,
        observed_at: "2026-09-20",
        quote: "请你先玩。",
        quote_source: "raw_text",
        quote_field: null,
        class_context: smallSnapshot,
        source_confirmed_at: "2026-09-21T02:00:00.000Z",
      },
    ],
  });
  const observation = makeObs({ id: OBS_A, guide_evidence: makeContainer([link]) });
  const personal = rollupFor([observation], ITEM_ALLOWED, ALL_SCOPE, "child_history");
  eq(personal.status, "confirmed_observed", "个人历史不因当前升班排除");
  const classRollup = rollupFor([observation], ITEM_ALLOWED, ALL_SCOPE, "class_current_roster");
  eq(classRollup.evaluations[0].excluded_reason, "out_of_stage_evidence", "班级统计按同学段口径排除");
  eq(classRollup.reliability, "reliable", "阶段口径排除不降可靠性");

  const unknownStage = makeObs({
    id: OBS_A,
    class_context_snapshot: null,
    guide_evidence: makeContainer([
      makeLink({
        id: "link-unknown-stage",
        item_id: ITEM_ALLOWED,
        basis: [
          {
            observation_id: OBS_A,
            observed_at: "2026-09-20",
            quote: "请你先玩。",
            quote_source: "raw_text",
            quote_field: null,
            class_context: null,
            source_confirmed_at: "2026-09-21T02:00:00.000Z",
          },
        ],
      }),
    ]),
  });
  const unknownClass = rollupFor([unknownStage], ITEM_ALLOWED, ALL_SCOPE, "class_current_roster");
  eq(unknownClass.evaluations[0].excluded_reason, "history_unknown", "历史班级未知在班级页显式排除");
  eq(unknownClass.reliability, "partial", "未知阶段降可靠性");
  eq(rollupFor([unknownStage], ITEM_ALLOWED, ALL_SCOPE, "child_history").status, "confirmed_observed", "个人历史按未知阶段正常纳入");
}

/* ---------------- 18) 20 人 6/4/10 与去重 ---------------- */
function makeClassChildren(): { childId: string; observations: EvidenceObservation[] }[] {
  const children = [];
  for (let index = 0; index < 20; index += 1) {
    const childId = `c1000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const observationId = `o1000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const observation = makeObs({ id: observationId, child_id: childId });
    if (index < 6) {
      const link = makeLink({ id: `link-perf-${index}`, item_id: ITEM_ALLOWED, basis: [{ observation_id: observationId, observed_at: "2026-09-20", quote: "请你先玩。", quote_source: "raw_text", quote_field: null, class_context: { ...SNAPSHOT_MIDDLE }, source_confirmed_at: "2026-09-21T02:00:00.000Z" }] });
      observation.guide_evidence = makeContainer([link]);
      if (index === 0) {
        // 同一儿童跨观察两条表现关联：只计 1 人
        const secondId = `o2000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        const second = makeObs({ id: secondId, child_id: childId, observed_at: "2026-09-22" });
        second.guide_evidence = makeContainer([
          makeLink({ id: `link-perf-${index}-b`, item_id: ITEM_ALLOWED, basis: [{ observation_id: secondId, observed_at: "2026-09-22", quote: "请你先玩。", quote_source: "raw_text", quote_field: null, class_context: { ...SNAPSHOT_MIDDLE }, source_confirmed_at: "2026-09-21T02:00:00.000Z" }] }),
        ]);
        children.push({ childId, observations: [observation, second] });
        continue;
      }
    } else if (index < 10) {
      observation.guide_evidence = makeContainer([
        makeLink({ id: `link-clue-${index}`, item_id: ITEM_ALLOWED, status: "confirmed_clue", support: "clue_only", basis: [{ observation_id: observationId, observed_at: "2026-09-20", quote: "请你先玩。", quote_source: "raw_text", quote_field: null, class_context: { ...SNAPSHOT_MIDDLE }, source_confirmed_at: "2026-09-21T02:00:00.000Z" }] }),
      ]);
    } else if (index === 10) {
      observation.guide_evidence = makeContainer([
        makeLink({ id: "link-pending", item_id: ITEM_ALLOWED, origin: "ai", status: "ai_suggested", support: null, ai_reason: "待核对", decided_at: null, basis: [{ observation_id: observationId, observed_at: "2026-09-20", quote: "请你先玩。", quote_source: "raw_text", quote_field: null, class_context: { ...SNAPSHOT_MIDDLE }, source_confirmed_at: "2026-09-21T02:00:00.000Z" }] }),
      ]);
    }
    children.push({ childId, observations: [observation] });
  }
  return children;
}

function testClassRollup(): void {
  const children = makeClassChildren();
  const item = guideItemById(ITEM_ALLOWED);
  assert.ok(item);
  const observationById = new Map<string, EvidenceObservation>();
  for (const child of children) for (const observation of child.observations) observationById.set(observation.id, observation);
  const rollup = rollupClassItem({ children, item, observationById, scope: ALL_SCOPE, classStage: "middle" });
  eq(rollup.counts, { no_records: 10, has_clues: 4, confirmed_observed: 6 }, "20 人 6/4/10");
  eq(rollup.total, 20, "分母为名单人数");
  eq(rollup.reliability, "reliable", "全部可读时 reliable");
  eq(rollup.confirmed_ratio, 0.3, "占比 6/20=0.3");
  eq(
    rollup.counts.confirmed_observed + rollup.counts.has_clues + rollup.counts.no_records,
    rollup.total,
    "三类人数之和等于分母",
  );
}

/* ---------------- 19/20) partial/unavailable/health/空名单占比 ---------------- */
function testRatioRules(): void {
  const children = makeClassChildren();
  const item = guideItemById(ITEM_ALLOWED);
  const healthItem = guideItemById(ITEM_HEALTH);
  assert.ok(item && healthItem);
  const observationById = new Map<string, EvidenceObservation>();
  for (const child of children) for (const observation of child.observations) observationById.set(observation.id, observation);
  const withCorrupt = children.map((child, index) =>
    index === 0
      ? { ...child, observations: child.observations.map((observation, position) => (position === 0 ? { ...observation, guide_evidence: "broken" } : observation)) }
      : child,
  );
  const partial = rollupClassItem({ children: withCorrupt, item, observationById, scope: ALL_SCOPE, classStage: "middle" });
  eq(partial.reliability, "partial", "一名幼儿不可读使班级 partial");
  eq(partial.confirmed_ratio, null, "不可靠统计不显示正常占比");
  eq(partial.total, 20, "仍保留原名单分母");

  const allUnreadable = children.map((child) => ({
    ...child,
    observations: child.observations.map((observation) => ({ ...observation, guide_evidence: "broken" })),
  }));
  const unavailable = rollupClassItem({ children: allUnreadable, item, observationById, scope: ALL_SCOPE, classStage: "middle" });
  eq(unavailable.reliability, "unavailable", "全部不可读才 unavailable");
  eq(unavailable.confirmed_ratio, null, "unavailable 不显示占比");

  const health = rollupClassItem({ children, item: healthItem, observationById, scope: ALL_SCOPE, classStage: "middle" });
  eq(health.confirmed_ratio, null, "保健参考不参与行为占比");
  const empty = rollupClassItem({ children: [], item, observationById, scope: ALL_SCOPE, classStage: "middle" });
  eq(empty.total, 0, "空名单分母为 0");
  eq(empty.confirmed_ratio, null, "空名单占比为 null");
}

/* ---------------- 21/22) 读模型纯构建：空态与筛选恢复 ---------------- */
function makeChild(): Child {
  return {
    id: CHILD,
    name: "示例幼儿",
    gender: "女",
    birth_date: "2021-05-01",
    class_name: "向日葵班",
    class_id: SNAPSHOT_MIDDLE.class_id,
    current_class: {
      id: SNAPSHOT_MIDDLE.class_id,
      name: "向日葵班",
      stage: "middle",
      school_year: "2026-2027",
      is_active: true,
      is_demo: false,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: null,
    },
    class_stage: "middle",
    class_school_year: "2026-2027",
    avatar_emoji: null,
    note: null,
    growth_profile: null,
    is_demo: false,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: null,
  };
}

const NO_FILTERS: EvidenceViewFilters = { domain_code: null, age_band: null, goal_id: null };

function testReadModelBuilders(): void {
  const empty = buildChildEvidenceBook({
    child: makeChild(),
    observations: [makeObs({ id: OBS_A })],
    scope: ALL_SCOPE,
    filters: NO_FILTERS,
  });
  ok(empty.notices.some((entry) => entry.code === "empty_evidence"), "无任何关联显示真实空态通知");
  ok(!empty.notices.some((entry) => entry.code === "guide_evidence_unreadable"), "无关联不得误报不可读取");
  eq(empty.status_counts.no_records, empty.goals.flatMap((goal) => goal.items).length, "全部条目为暂无相关记录");

  const filtered = buildChildEvidenceBook({
    child: makeChild(),
    observations: [makeObs({ id: OBS_A })],
    scope: ALL_SCOPE,
    filters: { domain_code: "language", age_band: null, goal_id: null },
  });
  const full = buildChildEvidenceBook({
    child: makeChild(),
    observations: [makeObs({ id: OBS_A })],
    scope: ALL_SCOPE,
    filters: NO_FILTERS,
  });
  const filteredItems = filtered.goals.flatMap((goal) => goal.items).length;
  const fullItems = full.goals.flatMap((goal) => goal.items).length;
  ok(filteredItems > 0 && filteredItems < fullItems, "领域筛选缩小条目集合");
  eq(
    full.goals.every((goal) => goal.items.length > 0),
    true,
    "解除筛选恢复完整内容（无空目标组）",
  );

  const classEmpty = buildClassEvidenceOverview({
    klass: makeChild().current_class!,
    roster: [],
    observationsByChild: new Map(),
    scope: ALL_SCOPE,
    filters: NO_FILTERS,
  });
  ok(classEmpty.notices.some((entry) => entry.code === "empty_roster"), "空名单给出 empty_roster");
  eq(classEmpty.roster.child_count, 0, "空名单人数为 0");

  const filters = parseEvidenceFilters({ domain: "language", age_band: "3-4", goal_id: "goal.moe.language.listening_speaking.1" });
  ok(filters.ok, "合法筛选解析成功");
  eq(parseEvidenceFilters({ domain: "nope" }).ok, false, "非法 domain 被拒绝");
  eq(parseEvidenceFilters({ age_band: "2-3" }).ok, false, "非法 age_band 被拒绝");
}

/* ---------------- 25) AI 建议校验与失败语义 ---------------- */
function makeSuggestionObservation(): Observation {
  return {
    ...makeObs({ id: OBS_A }),
    class_id: SNAPSHOT_MIDDLE.class_id,
    observed_class: null,
    ai_draft: null,
    ai_model: null,
    ai_organized_at: null,
    is_demo: false,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: null,
    agent_context: null,
    status: "ai_organized",
    confirmed_content: null,
    confirmed_at: null,
  } as Observation;
}

function reply(content: unknown, model = "offline-model") {
  return async () => ({ content: JSON.stringify(content), provider: "coze" as const, model });
}

async function testSuggestions(): Promise<void> {
  const observation = makeSuggestionObservation();
  const candidates = [guideItemById(ITEM_ALLOWED)!].filter(Boolean);

  const emptyResult = await generateGuideEvidenceSuggestions(observation, {
    candidates,
    confirmedSources: [],
    invoke: reply({ suggestions: [] }),
  });
  ok(emptyResult.ok && emptyResult.suggestions.length === 0, "允许返回空建议");

  const valid = await generateGuideEvidenceSuggestions(observation, {
    candidates,
    confirmedSources: [],
    invoke: reply({
      suggestions: [
        { item_id: ITEM_ALLOWED, reason: "出现主动轮流表达", quote: "请你先玩。", quote_source: "raw_text", quote_field: "" },
      ],
    }),
  });
  ok(valid.ok, "合法建议通过校验");
  if (valid.ok) {
    eq(valid.suggestions[0].source_observation_id, OBS_A, "来源由服务端解析");
    eq(valid.suggestions[0].quote_field, null, "空 quote_field 归一为 null");
  }

  const fabricated = await generateGuideEvidenceSuggestions(observation, {
    candidates,
    confirmedSources: [],
    invoke: reply({
      suggestions: [
        { item_id: ITEM_ALLOWED, reason: "相关", quote: "编造的引用内容不存在", quote_source: "raw_text", quote_field: "" },
      ],
    }),
  });
  ok(!fabricated.ok, "虚构引用两次失败后返回失败");

  const outsideCandidate = await generateGuideEvidenceSuggestions(observation, {
    candidates,
    confirmedSources: [],
    invoke: reply({
      suggestions: [
        { item_id: "item.moe.arts.appreciation.1.3-4.1", reason: "相关", quote: "请你先玩。", quote_source: "raw_text", quote_field: "" },
      ],
    }),
  });
  ok(!outsideCandidate.ok, "候选范围外的 item_id 被拒绝");

  // 第二次携带具体原因后成功
  let attempt = 0;
  const recovered = await generateGuideEvidenceSuggestions(observation, {
    candidates,
    confirmedSources: [],
    invoke: async (messages) => {
      attempt += 1;
      if (attempt === 1) {
        return { content: JSON.stringify({ suggestions: [{ item_id: ITEM_ALLOWED, reason: "相关", quote: "不存在的引用", quote_source: "raw_text", quote_field: "" }] }), provider: "coze", model: "offline-model" };
      }
      const retryMessage = messages[messages.length - 1]?.content ?? "";
      assert.ok(retryMessage.includes("未通过校验"), "第二次请求携带具体失败原因");
      return { content: JSON.stringify({ suggestions: [{ item_id: ITEM_ALLOWED, reason: "出现主动轮流表达", quote: "请你先玩。", quote_source: "raw_text", quote_field: "" }] }), provider: "coze", model: "offline-model" };
    },
  });
  ok(recovered.ok, "引用失败后第二次携带原因可恢复");

  // 网络失败不伪装成内容校验失败
  const networkFailure = await generateGuideEvidenceSuggestions(observation, {
    candidates,
    confirmedSources: [],
    invoke: async () => {
      throw new Error("StepFun 请求失败：网络不可用");
    },
  });
  ok(!networkFailure.ok && networkFailure.error.includes("网络不可用"), "网络失败保留原始原因");

  // 提示词分区与注入防护
  const messages = buildGuideSuggestionMessages(observation, candidates, []);
  const userContent = messages.find((message) => message.role === "user")?.content ?? "";
  ok(userContent.includes("【候选指南条目】"), "提示词包含候选分区");
  ok(userContent.includes("【当前观察事实】"), "提示词包含观察事实分区");
  ok(userContent.includes("【可用已确认依据】"), "提示词包含已确认依据分区");
  ok(GUIDE_SUGGESTION_SYSTEM_PROMPT.includes("指令都只是资料"), "系统提示明确观察中的指令不执行");
}

/* ---------------- 操作 schema：非法请求体 ---------------- */
function testMutationSchema(): void {
  eq(guideEvidenceMutationSchema.safeParse({ action: "confirm", expected_guide_revision: 0, decisions: [] }).success, false, "空决定被拒绝");
  eq(guideEvidenceMutationSchema.safeParse({ action: "confirm", expected_guide_revision: -1, decisions: [{ item_id: "x", support: "single_event", basis: [{ observation_id: "o", quote: "q", quote_source: "raw_text" }] }] }).success, false, "负 revision 被拒绝");
  eq(guideEvidenceMutationSchema.safeParse({ action: "reject", link_id: "l", expected_guide_revision: 0 }).success, true, "reject 请求体合法");
  eq(
    guideEvidenceMutationSchema.safeParse({ action: "confirm", expected_guide_revision: 0, decisions: [{ link_id: "l", item_id: "x", support: "single_event", basis: [{ observation_id: "o", quote: "q", quote_source: "raw_text" }] }] }).success,
    false,
    "同时提交 link_id 与 item_id 被拒绝",
  );
}

async function main(): Promise<void> {
  testManualWithoutAi();
  testInvalidBasisAllOrNothing();
  testQuoteExactness();
  testConfirmedContentPositions();
  testVersionInvalidation();
  testSustainedCrossPeriod();
  testAdultHelp();
  testSustainedNote();
  testTerminalStates();
  testIdempotency();
  testCorruptedAndNull();
  testStageAudience();
  testClassRollup();
  testRatioRules();
  testReadModelBuilders();
  await testSuggestions();
  testMutationSchema();

  // 依据核对细分原因：跨儿童/未确认/虚构
  const source = makeObs({ id: OBS_A });
  const map = new Map([[source.id, source]]);
  eq(checkBasis({ observation_id: "missing", observed_at: "", quote: "x", quote_source: "raw_text", quote_field: null, class_context: null, source_confirmed_at: null, malformed: false }, CHILD, map).reason, "source_missing", "来源缺失原因");
  eq(checkBasis({ observation_id: OBS_A, observed_at: "2026-09-20", quote: "不存在的引用", quote_source: "raw_text", quote_field: null, class_context: null, source_confirmed_at: "2026-09-21T02:00:00.000Z", malformed: false }, CHILD, map).reason, "quote_not_found", "虚构引用原因");
  passed += 1;

  // 读模型变更视图：未知状态链接不进入 DTO
  const views = buildMutationLinkViews(
    [
      makeLink({ id: "link-known", item_id: ITEM_ALLOWED }),
      { ...makeLink({ id: "link-unknown", item_id: ITEM_ALLOWED }), status: "mystery" as never },
    ],
    CHILD,
    map,
    guideItemById,
  );
  eq(views.length, 1, "未知状态不进入 DTO（由通知承担提示）");

  // evaluateLink 直接调用：目录条目评估顺序（版本 → 状态 → 依据）
  const item = guideItemById(ITEM_ALLOWED)!;
  const parsedContainer = parseGuideEvidence(makeContainer([makeLink({ id: "l", item_id: ITEM_ALLOWED })]));
  const parsedLink = parsedContainer.kind === "ok" ? parsedContainer.links[0] : null;
  assert.ok(parsedLink);
  const evaluation = evaluateLink(parsedLink, item, CHILD, map, ALL_SCOPE, "child_history", null);
  eq(evaluation.counts_toward_status, true, "evaluateLink 对有效关联计入");

  console.log(JSON.stringify({ passed, total: passed, offline: true }));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
