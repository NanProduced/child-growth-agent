import assert from "node:assert/strict";

import {
  CLASS_20_FIXTURE,
  CONTRACT_FIXTURE_CATALOG,
  CONTRACT_FIXTURE_CATALOG_VERSION,
  CONTRACT_FIXTURE_CONFIRM_OBSERVATION_EXTENSION,
  CONTRACT_FIXTURE_CONFIRM_REQUEST,
  CONTRACT_FIXTURE_EDUCATION_SUGGESTIONS,
  CONTRACT_FIXTURE_NEIGHBOR,
  CONTRACT_FIXTURE_SCENARIOS,
  CONTRACT_FIXTURE_SEMESTERS,
  CONTRACT_FIXTURE_STALE_OPERATION,
  CORRUPTED_CHILD_FIXTURE,
  CORRUPTED_EVIDENCE_RAW,
  FIXTURE_GOAL_ID,
  FIXTURE_ITEM_ID,
  UNREADABLE_CHILD_FIXTURE,
  type FixtureChildEvidence,
  type FixtureObservation,
  type FixtureScope,
} from "../src/lib/guide/__fixtures__/contract-fixtures";
import {
  GUIDE_EVIDENCE_LINK_STATUSES,
  GUIDE_ITEM_EVIDENCE_TYPES,
  GUIDE_EVIDENCE_QUOTE_FIELDS,
  type GuideEvidenceBasis,
  type GuideEvidenceLink,
  type GuideEvidenceLinkStatus,
  type GuideEvidencePeriodNote,
  type GuideEvidenceSupportKind,
  type GuidePerformanceItem,
} from "../src/lib/guide/types";
import {
  GUIDE_ITEM_EVIDENCE_STATUS_LABELS,
  type EvidenceAudience,
  type EvidenceBasisInvalidReason,
  type EvidenceExclusionReason,
  type EvidenceReliability,
  type EvidenceNoticeCode,
  type GuideItemEvidenceStatus,
} from "../src/lib/guide/view-types";
import type { ClassStage } from "../src/lib/types";

/**
 * G0-R1 契约最小检查：只读 fixture，不写数据库、不调用模型。
 * 运行：pnpm tsx scripts/check-guide-contract.ts
 *
 * 本文件的参考算法忠实于契约，用于验证 fixture 与规则一致性；
 * 它不是生产实现，不能替代 G5 的运行时验证（服务端核对、事务与并发保护）。
 */

/* ------------------------------ 参考算法 ------------------------------ */

interface ResolvedScope {
  kind: "semester" | "all_history" | "custom_range";
  start_date: string | null;
  end_date: string | null;
}

interface LinkEvaluation {
  link: GuideEvidenceLink;
  counts_toward_status: boolean;
  excluded_reason: EvidenceExclusionReason | null;
  /** 是否属于数据完整性/可读性问题（影响 reliability） */
  integrity_issue: boolean;
}

interface BasisCheck {
  valid: boolean;
  reason: EvidenceBasisInvalidReason | null;
}

function resolveScope(scope: FixtureScope): ResolvedScope {
  return { kind: scope.kind, start_date: scope.start_date, end_date: scope.end_date };
}

function inPeriod(date: string, scope: ResolvedScope): boolean {
  if (scope.kind === "all_history") return true;
  if (scope.start_date === null || scope.end_date === null) return false;
  return date >= scope.start_date && date <= scope.end_date;
}

const stripWhitespace = (value: string) => value.replace(/\s+/g, "");

function containsQuote(text: string, quote: string): boolean {
  const normalized = quote.trim();
  if (!normalized) return false;
  return stripWhitespace(text).includes(stripWhitespace(normalized));
}

/** 只允许 raw_text、confirmed_content.highlight_quote、confirmed_content.highlights 三个事实位置 */
function quoteVerifiable(observation: FixtureObservation, basis: GuideEvidenceBasis): boolean {
  if (basis.quote_source === "raw_text") {
    return basis.quote_field === null && containsQuote(observation.raw_text, basis.quote);
  }
  const content = observation.confirmed_content;
  if (!content) return false;
  if (basis.quote_field === "highlight_quote") {
    return containsQuote(content.highlight_quote, basis.quote);
  }
  if (basis.quote_field === "highlights") {
    return content.highlights.some((highlight) => containsQuote(highlight, basis.quote));
  }
  return false;
}

/** 逐条依据核对：来源存在、同一儿童、已确认、版本一致、片段可核对 */
function checkBasis(
  basis: GuideEvidenceBasis,
  childId: string,
  childObservationIds: Set<string>,
  globalObservations: Map<string, FixtureObservation>,
): BasisCheck {
  const observation = globalObservations.get(basis.observation_id);
  if (!observation) return { valid: false, reason: "source_missing" };
  if (observation.child_id !== childId || !childObservationIds.has(observation.id)) {
    return { valid: false, reason: "cross_child" };
  }
  if (observation.status !== "confirmed" || !observation.confirmed_content) {
    return { valid: false, reason: "not_confirmed" };
  }
  if (observation.observed_at !== basis.observed_at) {
    return { valid: false, reason: "version_mismatch" };
  }
  if (basis.source_confirmed_at !== observation.confirmed_at) {
    return { valid: false, reason: "version_mismatch" };
  }
  if (!quoteVerifiable(observation, basis)) return { valid: false, reason: "quote_not_found" };
  return { valid: true, reason: null };
}

function excluded(
  link: GuideEvidenceLink,
  reason: EvidenceExclusionReason,
  integrityIssue: boolean,
): LinkEvaluation {
  return {
    link,
    counts_toward_status: false,
    excluded_reason: reason,
    integrity_issue: integrityIssue,
  };
}

/**
 * 关联评估（个人页与班级页共用；班级页额外应用阶段口径）：
 * 1. 目录版本必须完全一致，不能仅凭 item_id 存在就兼容；
 * 2. 全部必需依据必须有效，任一条失效整条不计（禁止 .some()）；
 * 3. 全部依据必须落在筛选期间内；持续性纪要期间同样必须落在期间内；
 * 4. 班级页：全部依据的发生阶段必须可核对且与班级阶段一致；
 * 5. 支持条件与条目产品规则必须一致。
 */
function evaluateLink(
  link: GuideEvidenceLink,
  item: GuidePerformanceItem,
  childId: string,
  childObservationIds: Set<string>,
  globalObservations: Map<string, FixtureObservation>,
  scope: ResolvedScope,
  audience: EvidenceAudience,
  classStage: ClassStage | null,
): LinkEvaluation {
  if (link.catalog_version !== CONTRACT_FIXTURE_CATALOG_VERSION) {
    return excluded(link, "catalog_mismatch", true);
  }
  if (link.status === "ai_suggested") return excluded(link, "workflow_pending", false);
  if (link.status === "rejected") return excluded(link, "teacher_rejected", false);
  if (link.status === "withdrawn") return excluded(link, "withdrawn", false);
  if (link.status !== "confirmed_performance" && link.status !== "confirmed_clue") {
    return excluded(link, "unknown_status", true);
  }

  const basisChecks = link.basis.map((basis) =>
    checkBasis(basis, childId, childObservationIds, globalObservations),
  );
  if (link.basis.length === 0 || basisChecks.some((check) => !check.valid)) {
    return excluded(link, "basis_invalid", true);
  }

  if (!link.basis.every((basis) => inPeriod(basis.observed_at, scope))) {
    return excluded(link, "basis_out_of_period", false);
  }
  if (
    link.sustained_note &&
    (!inPeriod(link.sustained_note.period_start, scope) ||
      !inPeriod(link.sustained_note.period_end, scope))
  ) {
    return excluded(link, "basis_out_of_period", false);
  }

  if (audience === "class_current_roster") {
    const stages = link.basis.map((basis) => basis.class_context?.stage ?? null);
    if (stages.some((stage) => stage === null)) return excluded(link, "history_unknown", true);
    if (classStage && stages.some((stage) => stage !== classStage)) {
      return excluded(link, "out_of_stage_evidence", false);
    }
  }

  if (link.status === "confirmed_performance") {
    if (item.product_rules.evidence_type === "sustained" && link.support !== "sustained") {
      return excluded(link, "support_insufficient", true);
    }
    if (link.support === "sustained") {
      const days = new Set(link.basis.map((basis) => basis.observed_at));
      const note = link.sustained_note;
      const noteCoversBasis = Boolean(
        note &&
          note.description.trim().length >= 10 &&
          link.basis.every(
            (basis) => basis.observed_at >= note.period_start && basis.observed_at <= note.period_end,
          ),
      );
      if (days.size < 2 && !noteCoversBasis) {
        return excluded(link, "support_insufficient", true);
      }
    }
  }

  return { link, counts_toward_status: true, excluded_reason: null, integrity_issue: false };
}

interface ChildItemRollup {
  status: GuideItemEvidenceStatus;
  reliability: EvidenceReliability;
  evaluations: LinkEvaluation[];
}

function rollupChildItem(
  entry: FixtureChildEvidence,
  item: GuidePerformanceItem,
  scope: ResolvedScope,
  globalObservations: Map<string, FixtureObservation>,
  audience: EvidenceAudience,
  classStage: ClassStage | null,
): ChildItemRollup {
  const childObservationIds = new Set(entry.observations.map((observation) => observation.id));
  const evaluations: LinkEvaluation[] = [];
  for (const observation of entry.observations) {
    for (const link of observation.guide_evidence?.links ?? []) {
      if (link.item_id !== item.id) continue;
      evaluations.push(
        evaluateLink(link, item, entry.child.id, childObservationIds, globalObservations, scope, audience, classStage),
      );
    }
  }
  const corrupted = entry.corrupted_guide_evidence ?? [];
  let reliability: EvidenceReliability = evaluations.some((evaluation) => evaluation.integrity_issue)
    ? "partial"
    : "reliable";
  if (corrupted.length > 0) {
    reliability = entry.observations.length === 0 ? "unavailable" : "partial";
  }
  const counted = evaluations.filter((evaluation) => evaluation.counts_toward_status);
  const status: GuideItemEvidenceStatus = counted.some(
    (evaluation) => evaluation.link.status === "confirmed_performance",
  )
    ? "confirmed_observed"
    : counted.some((evaluation) => evaluation.link.status === "confirmed_clue")
      ? "has_clues"
      : "no_records";
  return { status, reliability, evaluations };
}

function worstReliability(values: EvidenceReliability[]): EvidenceReliability {
  if (values.includes("unavailable")) return "unavailable";
  if (values.includes("partial")) return "partial";
  return "reliable";
}

interface ClassItemRollup {
  counts: { no_records: number; has_clues: number; confirmed_observed: number };
  total: number;
  reliability: EvidenceReliability;
  confirmed_ratio: number | null;
}

function rollupClassItem(
  children: FixtureChildEvidence[],
  item: GuidePerformanceItem,
  scope: ResolvedScope,
  globalObservations: Map<string, FixtureObservation>,
  classStage: ClassStage,
): ClassItemRollup {
  const counts = { no_records: 0, has_clues: 0, confirmed_observed: 0 };
  const reliabilities: EvidenceReliability[] = [];
  for (const entry of children) {
    const rollup = rollupChildItem(entry, item, scope, globalObservations, "class_current_roster", classStage);
    counts[rollup.status] += 1;
    reliabilities.push(rollup.reliability);
  }
  const reliability = worstReliability(reliabilities);
  const total = children.length;
  const confirmed_ratio =
    reliability === "reliable" && item.product_rules.counts_in_behavior_stats && total > 0
      ? counts.confirmed_observed / total
      : null;
  return { counts, total, reliability, confirmed_ratio };
}

/* --------------------------- 决策写入规则参考 --------------------------- */

interface DecisionCheck {
  ok: boolean;
  error: string | null;
}

/** 与契约 §7 写入规则一致：持续性、条目类型、成人帮助、依据非空 */
function validateDecisionReference(input: {
  item: GuidePerformanceItem;
  support: GuideEvidenceSupportKind;
  basis: { observed_at: string }[];
  sustained_note: GuideEvidencePeriodNote | null;
  adult_help_used: boolean;
  teacher_note: string | null;
}): DecisionCheck {
  if (input.basis.length === 0) return { ok: false, error: "依据至少 1 条" };
  if (input.support === "sustained") {
    const days = new Set(input.basis.map((basis) => basis.observed_at));
    const note = input.sustained_note;
    const noteOk = Boolean(
      note &&
        note.description.trim().length >= 10 &&
        input.basis.every(
          (basis) => basis.observed_at >= note.period_start && basis.observed_at <= note.period_end,
        ),
    );
    if (days.size < 2 && !noteOk) return { ok: false, error: "持续性支持条件不足" };
  }
  const isPerformance = input.support !== "clue_only";
  if (isPerformance) {
    if (input.item.product_rules.evidence_type === "sustained" && input.support !== "sustained") {
      return { ok: false, error: "持续性条目需要持续性证据" };
    }
    if (input.adult_help_used && !input.teacher_note?.trim()) {
      return { ok: false, error: "成人帮助需说明帮助方式" };
    }
    if (input.adult_help_used && input.item.product_rules.adult_help === "requires_independence") {
      return { ok: false, error: "该条目要求独立完成，有成人帮助只能确认线索" };
    }
  }
  return { ok: true, error: null };
}

/* ------------------------------ 辅助 ------------------------------ */

function classifyCorrupted(raw: string): EvidenceNoticeCode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "guide_evidence_unreadable";
  }
  if (!parsed || typeof parsed !== "object") return "guide_evidence_unreadable";
  const links = (parsed as { links?: unknown }).links;
  if (!Array.isArray(links)) return "guide_evidence_unreadable";
  for (const link of links) {
    if (!link || typeof link !== "object") return "guide_evidence_unreadable";
    const status = (link as { status?: unknown }).status;
    if (
      typeof status !== "string" ||
      !GUIDE_EVIDENCE_LINK_STATUSES.includes(status as GuideEvidenceLinkStatus)
    ) {
      return "unknown_link_status";
    }
  }
  return null;
}

function allItems(): GuidePerformanceItem[] {
  return CONTRACT_FIXTURE_CATALOG.domains.flatMap((domain) =>
    domain.sub_domains.flatMap((subDomain) => subDomain.goals.flatMap((goal) => goal.items)),
  );
}

function allGoals() {
  return CONTRACT_FIXTURE_CATALOG.domains.flatMap((domain) =>
    domain.sub_domains.flatMap((subDomain) => subDomain.goals),
  );
}

function itemById(id: string): GuidePerformanceItem {
  const found = allItems().find((item) => item.id === id);
  assert.ok(found, `fixture 条目必须存在：${id}`);
  return found;
}

function globalObservationMap(fixtures: FixtureChildEvidence[]): Map<string, FixtureObservation> {
  const map = new Map<string, FixtureObservation>();
  for (const fixture of fixtures) {
    for (const observation of fixture.observations) map.set(observation.id, observation);
  }
  return map;
}

const ALL_FIXTURES: FixtureChildEvidence[] = [
  ...CONTRACT_FIXTURE_SCENARIOS,
  CONTRACT_FIXTURE_NEIGHBOR,
  CORRUPTED_CHILD_FIXTURE,
  UNREADABLE_CHILD_FIXTURE,
  ...CLASS_20_FIXTURE.children,
];

function main(): void {
  let passed = 0;

  // 1) 三种正式状态的展示文案（已批准口径，实现不得改写）
  assert.equal(GUIDE_ITEM_EVIDENCE_STATUS_LABELS.no_records, "暂无相关记录");
  assert.equal(GUIDE_ITEM_EVIDENCE_STATUS_LABELS.has_clues, "已有相关线索");
  assert.equal(GUIDE_ITEM_EVIDENCE_STATUS_LABELS.confirmed_observed, "已确认观察到");
  passed += 1;

  // 2) 目录层级：目标数 ≠ 表现条目数；条目唯一且带产品规则元数据
  const goals = allGoals();
  const items = allItems();
  assert.ok(goals.length > 0 && items.length > 0);
  assert.notEqual(goals.length, items.length, "综合目标数与表现条目数不是同一概念");
  assert.equal(new Set(items.map((item) => item.id)).size, items.length, "条目 id 必须唯一");
  for (const item of items) {
    assert.ok(item.text.length > 0, "条目必须有完整原文");
    assert.ok(goals.some((goal) => goal.id === item.goal_id), "条目必须能定位到目标");
    assert.ok(GUIDE_ITEM_EVIDENCE_TYPES.includes(item.product_rules.evidence_type));
    assert.equal(typeof item.product_rules.counts_in_behavior_stats, "boolean");
  }
  const healthItem = itemById(FIXTURE_ITEM_ID.healthHabit34);
  assert.equal(healthItem.product_rules.evidence_type, "health_reference");
  assert.equal(healthItem.product_rules.counts_in_behavior_stats, false, "保健参考不参与行为统计");
  passed += 1;

  // 3) 教育建议独立保存并关联目标
  for (const suggestion of CONTRACT_FIXTURE_EDUCATION_SUGGESTIONS) {
    assert.ok(goals.some((goal) => goal.id === suggestion.goal_id));
    assert.ok(suggestion.text.length > 0);
  }
  passed += 1;

  // 4) 关联结构一致性：来源、revision、support 与状态机一致
  const everyLink = ALL_FIXTURES.flatMap((fixture) =>
    fixture.observations.flatMap((observation) => observation.guide_evidence?.links ?? []),
  );
  assert.ok(everyLink.length > 0);
  const itemIds = new Set(items.map((item) => item.id));
  for (const link of everyLink) {
    assert.ok(itemIds.has(link.item_id), `关联条目必须存在于目录：${link.item_id}`);
    assert.ok(link.revision >= 1);
    assert.ok(["ai", "manual"].includes(link.origin));
    if (link.status === "withdrawn") {
      assert.notEqual(link.support, null, "撤回保留撤回前的 support（审计）");
      assert.ok(link.withdrawn_at, "撤回必须记录撤回时间");
    }
    if (link.status === "rejected" || link.status === "ai_suggested") {
      assert.equal(link.support, null, "拒绝/待核对的 support 必须为 null");
    }
  }
  passed += 1;

  // 5) 反例场景：状态、可靠性与排除原因逐一核对
  const globalObservations = globalObservationMap(ALL_FIXTURES);
  for (const scenario of CONTRACT_FIXTURE_SCENARIOS) {
    const scope = resolveScope(scenario.scope);
    const rollup = rollupChildItem(
      scenario,
      itemById(scenario.item_id),
      scope,
      globalObservations,
      scenario.audience,
      scenario.class_stage ?? null,
    );
    assert.equal(rollup.status, scenario.expected_status, `${scenario.scenario} 状态不符`);
    assert.equal(rollup.reliability, scenario.expected_reliability, `${scenario.scenario} 可靠性不符`);
    if (scenario.expected_excluded_reason === null) {
      assert.ok(
        rollup.evaluations.every((evaluation) => evaluation.counts_toward_status),
        `${scenario.scenario} 应计入状态`,
      );
    } else {
      assert.ok(
        rollup.evaluations.some(
          (evaluation) => evaluation.excluded_reason === scenario.expected_excluded_reason,
        ),
        `${scenario.scenario} 排除原因应为 ${scenario.expected_excluded_reason}`,
      );
    }
  }
  const statusSet = new Set(CONTRACT_FIXTURE_SCENARIOS.map((scenario) => scenario.expected_status));
  assert.ok(statusSet.has("no_records") && statusSet.has("has_clues") && statusSet.has("confirmed_observed"));
  passed += 1;

  // 6) 反例 1：中班儿童查看小班历史；学段来自快照，班级统计才做阶段排除
  const historyScenario = CONTRACT_FIXTURE_SCENARIOS.find(
    (scenario) => scenario.scenario === "middle-views-small-history",
  );
  assert.ok(historyScenario);
  assert.equal(historyScenario.child.stage, "middle", "儿童当前已升中班");
  const historyLink = historyScenario.observations[0].guide_evidence?.links[0];
  assert.ok(historyLink);
  assert.equal(historyLink.basis[0].class_context?.stage, "small", "证据发生时阶段来自快照");
  const historyForClass = evaluateLink(
    historyLink,
    itemById(historyScenario.item_id),
    historyScenario.child.id,
    new Set(historyScenario.observations.map((observation) => observation.id)),
    globalObservations,
    resolveScope(historyScenario.scope),
    "class_current_roster",
    "middle",
  );
  assert.equal(historyForClass.excluded_reason, "out_of_stage_evidence");
  assert.equal(historyForClass.integrity_issue, false, "阶段不同是口径排除，不是数据不可靠");
  passed += 1;

  // 7) 反例 2：持续性证据跨期，仅一条在本期 → 本期不计入，全部历史计入
  const crossPeriodScenario = CONTRACT_FIXTURE_SCENARIOS.find(
    (scenario) => scenario.scenario === "sustained-cross-period",
  );
  assert.ok(crossPeriodScenario);
  const crossPeriodLink = crossPeriodScenario.observations[0].guide_evidence?.links[0];
  assert.ok(crossPeriodLink);
  const crossPeriodSemester = evaluateLink(
    crossPeriodLink,
    itemById(crossPeriodScenario.item_id),
    crossPeriodScenario.child.id,
    new Set(crossPeriodScenario.observations.map((observation) => observation.id)),
    globalObservations,
    resolveScope(crossPeriodScenario.scope),
    "child_history",
    null,
  );
  assert.equal(crossPeriodSemester.excluded_reason, "basis_out_of_period");
  const crossPeriodAll = evaluateLink(
    crossPeriodLink,
    itemById(crossPeriodScenario.item_id),
    crossPeriodScenario.child.id,
    new Set(crossPeriodScenario.observations.map((observation) => observation.id)),
    globalObservations,
    resolveScope({ kind: "all_history", start_date: null, end_date: null, label: "全部历史" }),
    "child_history",
    null,
  );
  assert.equal(crossPeriodAll.counts_toward_status, true, "全部历史口径应计入跨期持续证据");
  passed += 1;

  // 8) 反例 3/4/5/7：任一条依据失效整条不计（禁止 .some()）
  function firstEvaluation(scenarioName: string): LinkEvaluation {
    const scenario = CONTRACT_FIXTURE_SCENARIOS.find((entry) => entry.scenario === scenarioName);
    assert.ok(scenario);
    const rollup = rollupChildItem(
      scenario,
      itemById(scenario.item_id),
      resolveScope(scenario.scope),
      globalObservations,
      scenario.audience,
      scenario.class_stage ?? null,
    );
    assert.equal(rollup.evaluations.length, 1);
    return rollup.evaluations[0];
  }
  assert.equal(firstEvaluation("mixed-basis-valid-and-fabricated").excluded_reason, "basis_invalid");
  assert.equal(firstEvaluation("valid-and-unconfirmed-basis").excluded_reason, "basis_invalid");
  assert.equal(firstEvaluation("cross-child-basis").excluded_reason, "basis_invalid");
  assert.equal(firstEvaluation("future-suggestion-not-evidence").excluded_reason, "basis_invalid");
  passed += 1;

  // 9) 依据失效原因细分：虚构片段 / 未确认 / 跨儿童 / 未来建议位置
  function basisInvalidReasons(scenarioName: string): EvidenceBasisInvalidReason[] {
    const scenario = CONTRACT_FIXTURE_SCENARIOS.find((entry) => entry.scenario === scenarioName);
    assert.ok(scenario);
    const link = scenario.observations
      .flatMap((observation) => observation.guide_evidence?.links ?? [])
      .find((candidate) => candidate.item_id === scenario.item_id);
    assert.ok(link);
    const childObservationIds = new Set(scenario.observations.map((observation) => observation.id));
    return link.basis
      .map((basis) => checkBasis(basis, scenario.child.id, childObservationIds, globalObservations))
      .filter((check) => !check.valid)
      .map((check) => check.reason as EvidenceBasisInvalidReason);
  }
  assert.deepEqual(basisInvalidReasons("mixed-basis-valid-and-fabricated"), ["quote_not_found"]);
  assert.deepEqual(basisInvalidReasons("valid-and-unconfirmed-basis"), ["not_confirmed"]);
  assert.deepEqual(basisInvalidReasons("cross-child-basis"), ["cross_child"]);
  assert.deepEqual(basisInvalidReasons("future-suggestion-not-evidence"), ["quote_not_found"]);
  passed += 1;

  // 10) 反例 6：目录版本不一致 → 保守排除，不因 item_id 存在而兼容
  assert.equal(firstEvaluation("catalog-version-mismatch").excluded_reason, "catalog_mismatch");
  passed += 1;

  // 11) 反例 8/9/10：手动关联与成人帮助条件
  const manualEvaluation = firstEvaluation("manual-link-without-ai");
  assert.equal(manualEvaluation.link.origin, "manual");
  assert.equal(manualEvaluation.counts_toward_status, true);
  const allowedEvaluation = firstEvaluation("adult-help-allowed-confirms-performance");
  assert.equal(allowedEvaluation.counts_toward_status, true, "成人帮助 allowed 条目可确认表现");
  const restrictedEvaluation = firstEvaluation("adult-help-requires-independence-clue-only");
  assert.equal(restrictedEvaluation.counts_toward_status, true, "限制条目仍可确认线索");
  assert.equal(restrictedEvaluation.link.status, "confirmed_clue");
  const restrictedItem = itemById(FIXTURE_ITEM_ID.listening34);
  const performanceAttempt = validateDecisionReference({
    item: restrictedItem,
    support: "single_event",
    basis: [{ observed_at: "2026-09-20" }],
    sustained_note: null,
    adult_help_used: true,
    teacher_note: "在教师扶助下完成。",
  });
  assert.equal(performanceAttempt.ok, false, "要求独立完成的条目不能带成人帮助确认表现");
  const allowedItem = itemById(FIXTURE_ITEM_ID.speaking34);
  assert.equal(
    validateDecisionReference({
      item: allowedItem,
      support: "single_event",
      basis: [{ observed_at: "2026-09-19" }],
      sustained_note: null,
      adult_help_used: true,
      teacher_note: "帮助方式：教师语言提示。",
    }).ok,
    true,
    "成人帮助 allowed 且说明帮助方式时可确认表现",
  );
  assert.equal(
    validateDecisionReference({
      item: allowedItem,
      support: "single_event",
      basis: [{ observed_at: "2026-09-19" }],
      sustained_note: null,
      adult_help_used: true,
      teacher_note: null,
    }).ok,
    false,
    "成人帮助确认表现必须说明帮助方式",
  );
  passed += 1;

  // 12) 持续性写入规则：跨日、明确期间纪要、不足拦截
  const sustainedItem = itemById(FIXTURE_ITEM_ID.listening45);
  assert.equal(
    validateDecisionReference({
      item: sustainedItem,
      support: "sustained",
      basis: [{ observed_at: "2026-09-10" }, { observed_at: "2026-09-12" }],
      sustained_note: null,
      adult_help_used: false,
      teacher_note: null,
    }).ok,
    true,
    "跨日证据支持持续性",
  );
  assert.equal(
    validateDecisionReference({
      item: sustainedItem,
      support: "sustained",
      basis: [{ observed_at: "2026-09-10" }],
      sustained_note: null,
      adult_help_used: false,
      teacher_note: null,
    }).ok,
    false,
    "单条依据不能仅凭备注字符串通过持续性",
  );
  assert.equal(
    validateDecisionReference({
      item: sustainedItem,
      support: "sustained",
      basis: [{ observed_at: "2026-09-10" }, { observed_at: "2026-09-12" }],
      sustained_note: {
        period_start: "2026-09-09",
        period_end: "2026-09-13",
        description: "连续一周观察到幼儿主动回应同伴提问。",
      },
      adult_help_used: false,
      teacher_note: null,
    }).ok,
    true,
    "明确期间与事实说明的连续观察纪要可通过",
  );
  assert.equal(
    validateDecisionReference({
      item: sustainedItem,
      support: "sustained",
      basis: [{ observed_at: "2026-09-10" }],
      sustained_note: { period_start: "2026-09-10", period_end: "2026-09-10", description: "无" },
      adult_help_used: false,
      teacher_note: null,
    }).ok,
    false,
    "说明过短或期间不覆盖依据不能通过",
  );
  assert.equal(
    validateDecisionReference({
      item: sustainedItem,
      support: "single_event",
      basis: [{ observed_at: "2026-09-10" }],
      sustained_note: null,
      adult_help_used: false,
      teacher_note: null,
    }).ok,
    false,
    "持续性条目不能用单次证据确认表现",
  );
  passed += 1;

  // 13) 反例 11/13/14：撤回、待核对、拒绝的审计一致性
  const withdrawnEvaluation = firstEvaluation("withdrawn-keeps-history");
  assert.equal(withdrawnEvaluation.excluded_reason, "withdrawn");
  assert.notEqual(withdrawnEvaluation.link.support, null, "撤回保留 support 供审计");
  assert.ok(withdrawnEvaluation.link.withdrawn_reason);
  assert.equal(firstEvaluation("pending-suggestion-not-counted").excluded_reason, "workflow_pending");
  assert.equal(firstEvaluation("rejected-not-counted").excluded_reason, "teacher_rejected");
  passed += 1;

  // 14) 反例 12：NULL 正常未关联；损坏 JSON 与未知状态显式区分
  const nullScenario = CONTRACT_FIXTURE_SCENARIOS.find(
    (scenario) => scenario.scenario === "null-evidence-is-normal",
  );
  assert.ok(nullScenario);
  const nullRollup = rollupChildItem(
    nullScenario,
    itemById(nullScenario.item_id),
    resolveScope(nullScenario.scope),
    globalObservations,
    "child_history",
    null,
  );
  assert.equal(nullRollup.evaluations.length, 0, "NULL 是正常未关联，不产生关联记录");
  assert.equal(nullRollup.reliability, "reliable", "NULL 不降低可靠性");
  assert.equal(classifyCorrupted(CORRUPTED_EVIDENCE_RAW.invalid_json), "guide_evidence_unreadable");
  assert.equal(classifyCorrupted(CORRUPTED_EVIDENCE_RAW.unknown_status), "unknown_link_status");
  const corruptedRollup = rollupChildItem(
    CORRUPTED_CHILD_FIXTURE,
    itemById(FIXTURE_ITEM_ID.speaking34),
    resolveScope({ kind: "all_history", start_date: null, end_date: null, label: "全部历史" }),
    globalObservations,
    "child_history",
    null,
  );
  assert.equal(corruptedRollup.reliability, "partial", "部分损坏按部分可靠展示");
  const unreadableRollup = rollupChildItem(
    UNREADABLE_CHILD_FIXTURE,
    itemById(FIXTURE_ITEM_ID.speaking34),
    resolveScope({ kind: "all_history", start_date: null, end_date: null, label: "全部历史" }),
    globalObservations,
    "child_history",
    null,
  );
  assert.equal(unreadableRollup.reliability, "unavailable", "全部不可读不能显示为正常 0");
  passed += 1;

  // 15) 反例 15：历史班级未知；个人纳入，班级统计显式排除并标记部分可靠
  const unknownStageScenario = CONTRACT_FIXTURE_SCENARIOS.find(
    (scenario) => scenario.scenario === "unknown-stage-personal-history",
  );
  assert.ok(unknownStageScenario);
  const unknownStageLink = unknownStageScenario.observations[0].guide_evidence?.links[0];
  assert.ok(unknownStageLink);
  assert.equal(unknownStageLink.basis[0].class_context, null);
  const unknownStageClass = evaluateLink(
    unknownStageLink,
    itemById(unknownStageScenario.item_id),
    unknownStageScenario.child.id,
    new Set(unknownStageScenario.observations.map((observation) => observation.id)),
    globalObservations,
    resolveScope({ kind: "all_history", start_date: null, end_date: null, label: "全部历史" }),
    "class_current_roster",
    "middle",
  );
  assert.equal(unknownStageClass.excluded_reason, "history_unknown");
  assert.equal(unknownStageClass.integrity_issue, true);
  passed += 1;

  // 16) 操作契约：批量决定、过期令牌、归档同事务扩展
  assert.equal(CONTRACT_FIXTURE_CONFIRM_REQUEST.action, "confirm");
  assert.equal(CONTRACT_FIXTURE_CONFIRM_REQUEST.decisions.length, 2, "批量决定支持建议关联与手动关联");
  assert.ok(CONTRACT_FIXTURE_CONFIRM_REQUEST.decisions.some((decision) => "link_id" in decision));
  assert.ok(CONTRACT_FIXTURE_CONFIRM_REQUEST.decisions.some((decision) => "item_id" in decision));
  assert.ok(
    CONTRACT_FIXTURE_CONFIRM_OBSERVATION_EXTENSION.guide_decisions &&
      CONTRACT_FIXTURE_CONFIRM_OBSERVATION_EXTENSION.guide_decisions.decisions.length > 0,
    "观察确认扩展必须表达选中关联",
  );
  assert.notEqual(
    CONTRACT_FIXTURE_STALE_OPERATION.expected_guide_revision,
    CONTRACT_FIXTURE_STALE_OPERATION.current_guide_revision,
    "过期令牌必须可识别（409 语义）",
  );
  passed += 1;

  // 17) 班级 20 人：6/4/10、去重、分母、待核对不计入
  const classItem = itemById(CLASS_20_FIXTURE.item_id);
  const classScope = resolveScope({
    kind: "semester",
    semester_id: "2026-2027-1",
    start_date: "2026-09-01",
    end_date: "2027-01-31",
    label: "2026-2027学年第一学期",
  });
  const classRollup = rollupClassItem(
    CLASS_20_FIXTURE.children,
    classItem,
    classScope,
    globalObservations,
    "middle",
  );
  assert.deepEqual(classRollup.counts, CLASS_20_FIXTURE.expected_counts);
  assert.equal(classRollup.total, 20);
  assert.equal(
    classRollup.counts.confirmed_observed + classRollup.counts.has_clues + classRollup.counts.no_records,
    classRollup.total,
    "三类人数之和必须等于名单人数（分母）",
  );
  assert.equal(classRollup.reliability, "reliable");
  assert.equal(classRollup.confirmed_ratio, 0.3);
  const firstChild = CLASS_20_FIXTURE.children[0];
  const firstChildLinks = firstChild.observations.flatMap(
    (observation) => observation.guide_evidence?.links ?? [],
  );
  assert.equal(firstChildLinks.length, 2, "同一儿童可有跨观察的多条关联");
  const firstChildRollup = rollupChildItem(
    firstChild,
    classItem,
    classScope,
    globalObservations,
    "class_current_roster",
    "middle",
  );
  assert.equal(firstChildRollup.status, "confirmed_observed");
  assert.equal(
    firstChildRollup.evaluations.filter((evaluation) => evaluation.counts_toward_status).length,
    2,
    "两条关联都计入该儿童，但儿童状态只算一次",
  );
  assert.equal(
    CLASS_20_FIXTURE.children.filter(
      (entry) =>
        rollupChildItem(entry, classItem, classScope, globalObservations, "class_current_roster", "middle")
          .status === "confirmed_observed",
    ).length,
    CLASS_20_FIXTURE.expected_counts.confirmed_observed,
  );
  passed += 1;

  // 18) 可靠性规则：不可靠或非行为统计条目不显示正常占比
  const healthRollup = rollupClassItem(
    CLASS_20_FIXTURE.children,
    healthItem,
    classScope,
    globalObservations,
    "middle",
  );
  assert.equal(healthRollup.confirmed_ratio, null, "保健参考条目不显示行为统计占比");
  const partialRollup = rollupClassItem(
    [CONTRACT_FIXTURE_SCENARIOS[2]],
    classItem,
    resolveScope({ kind: "all_history", start_date: null, end_date: null, label: "全部历史" }),
    globalObservations,
    "middle",
  );
  assert.equal(partialRollup.reliability, "partial");
  assert.equal(partialRollup.confirmed_ratio, null, "统计不可靠时不显示正常 0% 或占比");
  assert.equal(partialRollup.total, 1, "仍说明原名单分母");
  passed += 1;

  // 19) 学期配置显式且与 fixture 期间一致
  for (const scenario of CONTRACT_FIXTURE_SCENARIOS) {
    if (scenario.scope.kind !== "semester") continue;
    const semester = CONTRACT_FIXTURE_SEMESTERS.find(
      (entry) => entry.id === scenario.scope.semester_id,
    );
    assert.ok(semester, "学期筛选必须来自显式配置");
    assert.equal(scenario.scope.start_date, semester.start_date);
    assert.equal(scenario.scope.end_date, semester.end_date);
  }
  assert.equal(FIXTURE_ITEM_ID.speaking34.endsWith("speaking.2.3-4"), true);
  assert.equal(FIXTURE_GOAL_ID.speaking.endsWith(".2"), true);
  assert.deepEqual([...GUIDE_EVIDENCE_QUOTE_FIELDS], ["highlight_quote", "highlights"]);
  passed += 1;

  console.log(JSON.stringify({ passed, total: 19, reference_only: true }));
}

main();
