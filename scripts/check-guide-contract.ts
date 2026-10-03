import assert from "node:assert/strict";

import {
  CLASS_20_FIXTURE,
  CONTRACT_FIXTURE_CATALOG,
  CONTRACT_FIXTURE_CATALOG_VERSION,
  CONTRACT_FIXTURE_EDUCATION_SUGGESTIONS,
  CONTRACT_FIXTURE_SCENARIOS,
  FIXTURE_GOAL_ID,
  FIXTURE_ITEM_ID,
  type FixtureObservation,
} from "../src/lib/guide/__fixtures__/contract-fixtures";
import {
  GUIDE_ITEM_EVIDENCE_STATUS_LABELS,
  type GuideItemEvidenceStatus,
} from "../src/lib/guide/view-types";

/**
 * G0 契约最小检查：只读 fixture，不写数据库、不调用模型。
 * 运行：pnpm tsx scripts/check-guide-contract.ts
 */

/**
 * 冻结的正式状态计算规则（个人页与班级页共用）：
 * 只统计 confirmed 观察上、引用已确认观察为依据、状态为 confirmed_performance /
 * confirmed_clue 的关联；表现优先于线索；ai_suggested / rejected / withdrawn 不进入统计。
 */
function rollupStatus(observations: FixtureObservation[], itemId: string): GuideItemEvidenceStatus {
  const confirmedIds = new Set(
    observations
      .filter((observation) => observation.status === "confirmed" && observation.confirmed_content)
      .map((observation) => observation.id),
  );
  let hasClue = false;
  for (const observation of observations) {
    for (const link of observation.guide_evidence?.links ?? []) {
      if (link.item_id !== itemId) continue;
      if (link.status !== "confirmed_performance" && link.status !== "confirmed_clue") continue;
      const anchored = link.basis.some((basis) => confirmedIds.has(basis.observation_id));
      if (!anchored) continue;
      if (link.status === "confirmed_performance") return "confirmed_observed";
      hasClue = true;
    }
  }
  return hasClue ? "has_clues" : "no_records";
}

function allItems() {
  return CONTRACT_FIXTURE_CATALOG.domains.flatMap((domain) =>
    domain.sub_domains.flatMap((subDomain) => subDomain.goals.flatMap((goal) => goal.items)),
  );
}

function allGoals() {
  return CONTRACT_FIXTURE_CATALOG.domains.flatMap((domain) =>
    domain.sub_domains.flatMap((subDomain) => subDomain.goals),
  );
}

function main(): void {
  let passed = 0;

  // 1) 三种正式状态的展示文案（已批准口径，实现不得改写）
  assert.equal(GUIDE_ITEM_EVIDENCE_STATUS_LABELS.no_records, "暂无相关记录");
  assert.equal(GUIDE_ITEM_EVIDENCE_STATUS_LABELS.has_clues, "已有相关线索");
  assert.equal(GUIDE_ITEM_EVIDENCE_STATUS_LABELS.confirmed_observed, "已确认观察到");
  passed += 1;

  // 2) 目录层级：目标数 ≠ 表现条目数；条目 id 稳定唯一且字段完整
  const goals = allGoals();
  const items = allItems();
  assert.ok(goals.length > 0 && items.length > 0);
  assert.notEqual(goals.length, items.length, "综合目标数与表现条目数不是同一概念");
  assert.equal(new Set(items.map((item) => item.id)).size, items.length, "条目 id 必须唯一");
  assert.ok(items.some((item) => item.age_band === "3-4"));
  assert.ok(items.some((item) => item.age_band === "4-5"));
  for (const item of items) {
    assert.ok(item.text.length > 0, "条目必须有完整原文");
    assert.ok(goals.some((goal) => goal.id === item.goal_id), "条目必须能定位到目标");
    assert.equal(item.domain_id, "dom.fixture.language");
  }
  passed += 1;

  // 3) 教育建议独立保存并关联目标
  for (const suggestion of CONTRACT_FIXTURE_EDUCATION_SUGGESTIONS) {
    assert.ok(goals.some((goal) => goal.id === suggestion.goal_id));
    assert.ok(suggestion.text.length > 0);
  }
  passed += 1;

  // 4) 所有 fixture 关联都指向当前目录版本的合法条目
  const itemIds = new Set(items.map((item) => item.id));
  const everyLink = CONTRACT_FIXTURE_SCENARIOS.flatMap((scenario) =>
    scenario.observations.flatMap((observation) => observation.guide_evidence?.links ?? []),
  ).concat(
    CLASS_20_FIXTURE.children.flatMap((child) =>
      child.observations.flatMap((observation) => observation.guide_evidence?.links ?? []),
    ),
  );
  assert.ok(everyLink.length > 0);
  for (const link of everyLink) {
    assert.equal(link.catalog_version, CONTRACT_FIXTURE_CATALOG_VERSION);
    assert.ok(itemIds.has(link.item_id), `关联条目必须存在于目录：${link.item_id}`);
  }
  passed += 1;

  // 5) 场景状态：三种正式状态 + 待核对 / 成人帮助 / 历史未知 / 撤回 / 不采用
  const scenarioByName = new Map(
    CONTRACT_FIXTURE_SCENARIOS.map((scenario) => [scenario.child.name, scenario]),
  );
  for (const scenario of CONTRACT_FIXTURE_SCENARIOS) {
    const status = rollupStatus(scenario.observations, scenario.item_id);
    assert.equal(status, scenario.expected_status, `${scenario.child.name} 状态不符`);
  }
  const statusSet = new Set(CONTRACT_FIXTURE_SCENARIOS.map((scenario) => scenario.expected_status));
  assert.ok(statusSet.has("no_records") && statusSet.has("has_clues") && statusSet.has("confirmed_observed"));
  passed += 1;

  // 6) 待核对属于工作流状态：不计入正式状态
  const pendingScenario = scenarioByName.get("示例幼儿D");
  assert.ok(pendingScenario);
  const pendingLinks = pendingScenario.observations.flatMap(
    (observation) => observation.guide_evidence?.links ?? [],
  );
  assert.equal(pendingLinks.length, 1);
  assert.equal(pendingLinks[0].status, "ai_suggested");
  assert.equal(pendingScenario.expected_status, "no_records");
  passed += 1;

  // 7) 成人帮助：只确认线索，备注说明帮助方式
  const adultHelpScenario = scenarioByName.get("示例幼儿E");
  assert.ok(adultHelpScenario);
  const adultHelpLink = adultHelpScenario.observations[0].guide_evidence?.links[0];
  assert.ok(adultHelpLink);
  assert.equal(adultHelpLink.status, "confirmed_clue");
  assert.equal(adultHelpLink.support, "clue_only");
  assert.ok(adultHelpLink.teacher_note?.includes("教师提醒"));
  assert.ok(adultHelpLink.basis[0].quote.includes("在老师提醒下"));
  passed += 1;

  // 8) 历史未知：旧记录没有班级快照时按未知保留，不补造
  const historyScenario = scenarioByName.get("示例幼儿F");
  assert.ok(historyScenario);
  assert.equal(historyScenario.observations[0].class_context_snapshot, null);
  const historyLink = historyScenario.observations[0].guide_evidence?.links[0];
  assert.ok(historyLink);
  assert.equal(historyLink.basis[0].class_context, null);
  assert.equal(historyScenario.expected_status, "confirmed_observed");
  passed += 1;

  // 9) 撤回：保留撤回时间与原因，不再进入正式状态
  const withdrawnScenario = scenarioByName.get("示例幼儿G");
  assert.ok(withdrawnScenario);
  const withdrawnLink = withdrawnScenario.observations[0].guide_evidence?.links[0];
  assert.ok(withdrawnLink);
  assert.equal(withdrawnLink.status, "withdrawn");
  assert.ok(withdrawnLink.withdrawn_at);
  assert.ok(withdrawnLink.withdrawn_reason);
  assert.equal(withdrawnScenario.expected_status, "no_records");
  passed += 1;

  // 10) 持续性表现：跨日两条依据；单次行为只需一条充分证据
  const sustainedScenario = scenarioByName.get("示例幼儿A");
  assert.ok(sustainedScenario);
  const sustainedLink = sustainedScenario.observations[0].guide_evidence?.links[0];
  assert.ok(sustainedLink);
  assert.equal(sustainedLink.support, "sustained");
  const days = new Set(sustainedLink.basis.map((basis) => basis.observed_at));
  assert.ok(days.size >= 2, "持续性表现需要跨日证据");
  passed += 1;

  // 11) 班级 20 人：6 表现 / 4 线索 / 10 无记录，三类人数之和等于分母
  const classCounts = { confirmed_observed: 0, has_clues: 0, no_records: 0 };
  const childIds = new Set<string>();
  for (const entry of CLASS_20_FIXTURE.children) {
    assert.ok(!childIds.has(entry.child.id), "名单必须按儿童去重");
    childIds.add(entry.child.id);
    classCounts[rollupStatus(entry.observations, CLASS_20_FIXTURE.item_id)] += 1;
  }
  assert.equal(childIds.size, 20);
  assert.deepEqual(classCounts, CLASS_20_FIXTURE.expected_counts);
  assert.equal(
    classCounts.confirmed_observed + classCounts.has_clues + classCounts.no_records,
    CLASS_20_FIXTURE.children.length,
    "三类人数之和必须等于名单人数（分母）",
  );
  assert.equal(classCounts.confirmed_observed / CLASS_20_FIXTURE.children.length, 0.3);
  passed += 1;

  // 12) fixture 自身不得引用数据库/模型：全部条目来自契约定义的纯数据
  assert.equal(CONTRACT_FIXTURE_CATALOG.version, CONTRACT_FIXTURE_CATALOG_VERSION);
  assert.ok(FIXTURE_ITEM_ID.speaking34.endsWith("speaking.2.3-4"));
  assert.ok(FIXTURE_GOAL_ID.speaking.endsWith(".2"));
  passed += 1;

  console.log(JSON.stringify({ passed, total: 12 }));
}

main();
