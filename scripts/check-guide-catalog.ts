import assert from "node:assert/strict";

import { GUIDE_CATALOG, GUIDE_EDUCATION_SUGGESTIONS } from "../src/data/guide";
import {
  getGuideItem,
  listEducationSuggestions,
  listGuideItems,
} from "../src/lib/guide/catalog";
import {
  GUIDE_AGE_BANDS,
  GUIDE_CATALOG_VERSION,
  GUIDE_DOMAIN_CODES,
  GUIDE_DOMAIN_LABELS,
  GUIDE_ITEM_EVIDENCE_TYPES,
} from "../src/lib/guide/types";
import type { GuideDomainCode, GuideGoal, GuidePerformanceItem } from "../src/lib/guide/types";

const EXPECTED_SUB_DOMAIN_GOALS: Record<string, number> = {
  "sub.moe.health.physical": 3,
  "sub.moe.health.movement": 3,
  "sub.moe.health.daily_living": 3,
  "sub.moe.language.listening_speaking": 3,
  "sub.moe.language.reading_writing": 3,
  "sub.moe.social.interpersonal": 4,
  "sub.moe.social.social_adaptation": 3,
  "sub.moe.science.science_inquiry": 3,
  "sub.moe.science.math_cognition": 3,
  "sub.moe.arts.appreciation": 2,
  "sub.moe.arts.expression_creation": 2,
};

const EXPECTED_DOMAIN_ITEMS: Record<string, number> = {
  health: 99,
  language: 55,
  social: 74,
  science: 58,
  arts: 31,
};

function allGoals(): GuideGoal[] {
  return GUIDE_CATALOG.domains.flatMap((domain) =>
    domain.sub_domains.flatMap((subDomain) => subDomain.goals),
  );
}

function allItems(): GuidePerformanceItem[] {
  return allGoals().flatMap((goal) => goal.items);
}

function itemByText(text: string): GuidePerformanceItem {
  const found = allItems().find((item) => item.text === text);
  assert.ok(found, `条目原文必须存在：${text}`);
  return found;
}

async function main(): Promise<void> {
  let passed = 0;

  // 1) 冻结版本与五领域结构：5 领域 / 11 子领域 / 32 目标
  assert.equal(GUIDE_CATALOG.version, GUIDE_CATALOG_VERSION);
  assert.deepEqual(
    GUIDE_CATALOG.domains.map((domain) => domain.code),
    [...GUIDE_DOMAIN_CODES],
  );
  for (const domain of GUIDE_CATALOG.domains) {
    assert.equal(domain.name, GUIDE_DOMAIN_LABELS[domain.code]);
  }
  const subDomains = GUIDE_CATALOG.domains.flatMap((domain) => domain.sub_domains);
  const goals = allGoals();
  assert.equal(GUIDE_CATALOG.domains.length, 5);
  assert.equal(subDomains.length, 11);
  assert.equal(goals.length, 32);
  passed += 1;

  // 2) 每个子领域的目标数量与官方目录一致
  for (const subDomain of subDomains) {
    assert.equal(
      subDomain.goals.length,
      EXPECTED_SUB_DOMAIN_GOALS[subDomain.id],
      `子领域目标数不符：${subDomain.id}`,
    );
  }
  assert.equal(Object.keys(EXPECTED_SUB_DOMAIN_GOALS).length, subDomains.length);
  passed += 1;

  // 3) 稳定 ID：全局唯一、层级引用一致
  const ids = new Set<string>();
  const register = (id: string, label: string) => {
    assert.ok(id.length > 0, `${label} 必须有稳定 id`);
    assert.ok(!ids.has(id), `id 重复：${id}`);
    ids.add(id);
  };
  for (const domain of GUIDE_CATALOG.domains) {
    register(domain.id, "领域");
    assert.ok(domain.id.startsWith("dom.moe."));
    for (const subDomain of domain.sub_domains) {
      register(subDomain.id, "子领域");
      assert.equal(subDomain.domain_id, domain.id);
      for (const goal of subDomain.goals) {
        register(goal.id, "目标");
        assert.equal(goal.domain_id, domain.id);
        assert.equal(goal.sub_domain_id, subDomain.id);
        assert.ok(goal.index >= 1);
        for (const item of goal.items) {
          register(item.id, "条目");
          assert.equal(item.domain_id, domain.id);
          assert.equal(item.sub_domain_id, subDomain.id);
          assert.equal(item.goal_id, goal.id);
        }
      }
    }
  }
  for (const suggestion of GUIDE_EDUCATION_SUGGESTIONS) {
    register(suggestion.id, "教育建议");
  }
  passed += 1;

  // 4) 年龄段覆盖：每个目标三个年龄段都有表现条目；条目编号连续
  const items = allItems();
  assert.equal(items.length, 317, "正式目录实际条目数");
  for (const goal of goals) {
    for (const band of GUIDE_AGE_BANDS) {
      const bandItems = goal.items.filter((item) => item.age_band === band);
      assert.ok(bandItems.length >= 1, `目标缺少年龄段条目：${goal.id} ${band}`);
      bandItems.forEach((item, index) => {
        assert.ok(item.text.startsWith(`${index + 1}．`), `条目编号必须从 1 连续：${item.id}`);
      });
    }
    assert.equal(
      new Set(goal.items.map((item) => item.age_band)).size,
      GUIDE_AGE_BANDS.length,
      `目标必须覆盖三个年龄段：${goal.id}`,
    );
  }
  for (const item of items) {
    assert.ok(GUIDE_AGE_BANDS.includes(item.age_band));
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item.text), `条目含控制字符：${item.id}`);
    assert.equal(item.text, item.text.trim(), `条目首尾不得有空白：${item.id}`);
    assert.ok(!item.text.includes("  "), `条目不得有连续空格：${item.id}`);
  }
  passed += 1;

  // 5) 来源位置：每级目录与条目/建议都有可核对的来源
  for (const domain of GUIDE_CATALOG.domains) {
    for (const source of [
      domain.source,
      ...domain.sub_domains.flatMap((subDomain) => [
        subDomain.source,
        ...subDomain.goals.flatMap((goal) => [goal.source, ...goal.items.map((item) => item.source)]),
      ]),
      ...GUIDE_EDUCATION_SUGGESTIONS.map((suggestion) => suggestion.source),
    ]) {
      assert.equal(source.document, "《3—6岁儿童学习与发展指南》");
      assert.equal(source.publisher, "教育部");
      assert.equal(source.published_year, 2012);
      assert.ok(source.section.length > 0);
      assert.ok(source.url?.includes("moe.gov.cn"));
    }
  }
  passed += 1;

  // 6) 原文抽查：关键条件、数值与 2012 年正式颁发稿一致（含“左右”等条件）
  assert.ok(itemByText("1．身高和体重适宜。参考标准：\n男孩：\n身高：94.9-111.7厘米\n体重：12.7-21.2公斤\n女孩：\n身高：94.1-111.3厘米\n体重：12.3-21.5公斤"));
  itemByText("2．在提醒下能自然坐直、站直。");
  itemByText("2．经常保持正确的站、坐和行走姿势。");
  itemByText("5．能连续行走1.5公里以上（途中可适当停歇）。");
  itemByText("2．能单手将沙包向前投掷5米左右。");
  itemByText("5．主动保护眼睛。不在光线过强或过暗的地方看书，连续看电视等不超过30分钟。");
  itemByText("1．能双手抓杠悬空吊起10秒左右。");
  itemByText("4．能快跑25米左右。");
  itemByText("3．能辨别自己的左右。");
  itemByText("3．在帮助下能较快适应集体生活。");
  itemByText("6．在提醒下，每天早晚刷牙、饭前便后洗手。");
  itemByText("3．能用剪刀沿直线剪，边线基本吻合。");
  assert.equal(items.filter((item) => item.text.includes("左右")).length, 16, "“左右”条件条目数");
  passed += 1;

  // 7) 产品规则：保健参考不进入行为统计；成人帮助分类有原文依据
  for (const item of items) {
    assert.ok(GUIDE_ITEM_EVIDENCE_TYPES.includes(item.product_rules.evidence_type));
    assert.equal(
      item.product_rules.counts_in_behavior_stats,
      item.product_rules.evidence_type !== "health_reference",
    );
  }
  const healthReferences = items.filter((item) => item.product_rules.evidence_type === "health_reference");
  assert.equal(healthReferences.length, 3, "保健参考条目仅身高体重参考标准");
  for (const item of healthReferences) {
    assert.ok(item.text.includes("参考标准"));
    assert.equal(item.product_rules.adult_help, "allowed");
  }
  assert.equal(items.filter((item) => item.product_rules.evidence_type === "sustained").length, 22);
  assert.equal(
    items.filter((item) => item.product_rules.adult_help === "requires_independence").length,
    18,
  );
  const independenceItem = itemByText("1．能自己穿脱衣服、鞋袜、扣钮扣。");
  assert.equal(independenceItem.product_rules.adult_help, "requires_independence");
  const assistedItem = itemByText("2．在提醒下能自然坐直、站直。");
  assert.equal(assistedItem.product_rules.adult_help, "allowed");
  const sustainedItem = itemByText("1．经常保持愉快的情绪，不高兴时能较快缓解。");
  assert.equal(sustainedItem.product_rules.evidence_type, "sustained");
  passed += 1;

  // 8) 教育建议：独立保存、按目标关联、完整覆盖 32 个目标
  assert.equal(GUIDE_EDUCATION_SUGGESTIONS.length, 87, "官方教育建议实际条数");
  const goalIds = new Set(goals.map((goal) => goal.id));
  const suggestionsByGoal = new Map<string, number>();
  for (const suggestion of GUIDE_EDUCATION_SUGGESTIONS) {
    assert.ok(goalIds.has(suggestion.goal_id), `建议必须关联目标：${suggestion.id}`);
    assert.ok(suggestion.text.length > 0);
    assert.ok(/^\d+．/.test(suggestion.text), `建议编号：${suggestion.id}`);
    suggestionsByGoal.set(suggestion.goal_id, (suggestionsByGoal.get(suggestion.goal_id) ?? 0) + 1);
  }
  for (const goal of goals) {
    assert.ok((suggestionsByGoal.get(goal.id) ?? 0) >= 1, `目标缺少教育建议：${goal.id}`);
  }
  const firstSuggestion = GUIDE_EDUCATION_SUGGESTIONS[0];
  assert.ok(firstSuggestion.text.includes("·参照《中国孕期、哺乳期妇女和0～6岁儿童膳食指南》"));
  passed += 1;

  // 9) 目录查询：过滤、详情与教育建议接口行为
  const listed = await listGuideItems();
  assert.equal(listed.length, items.length);
  for (const [code, count] of Object.entries(EXPECTED_DOMAIN_ITEMS)) {
    assert.equal(
      (await listGuideItems({ domain_code: code as GuideDomainCode })).length,
      count,
      `领域条目数：${code}`,
    );
  }
  assert.equal((await listGuideItems({ age_band: "3-4" })).length, items.filter((item) => item.age_band === "3-4").length);
  const sampleGoal = goals[0];
  assert.equal(
    (await listGuideItems({ goal_id: sampleGoal.id })).length,
    sampleGoal.items.length,
  );
  assert.equal(
    (await listGuideItems({ goal_id: sampleGoal.id, age_band: "5-6" })).length,
    sampleGoal.items.filter((item) => item.age_band === "5-6").length,
  );
  assert.deepEqual(await listGuideItems({ sub_domain_id: "sub.moe.unknown" }), []);
  assert.deepEqual(await listGuideItems({ goal_id: "goal.moe.unknown.1" }), []);
  assert.equal(await getGuideItem("item.moe.unknown.1.3-4.1"), null);
  const detail = await getGuideItem(sampleGoal.items[0].id);
  assert.ok(detail);
  assert.equal(detail.goal.id, sampleGoal.id);
  assert.equal(detail.sub_domain.id, sampleGoal.sub_domain_id);
  assert.equal(detail.domain.code, "health");
  assert.equal(detail.item.id, sampleGoal.items[0].id);
  assert.equal(detail.education_suggestions.length, suggestionsByGoal.get(sampleGoal.id));
  const goalSuggestions = await listEducationSuggestions(sampleGoal.id);
  assert.equal(goalSuggestions.length, suggestionsByGoal.get(sampleGoal.id));
  assert.deepEqual(await listEducationSuggestions("goal.moe.unknown.1"), []);
  passed += 1;

  console.log(
    JSON.stringify({
      passed,
      total: 9,
      version: GUIDE_CATALOG_VERSION,
      domains: GUIDE_CATALOG.domains.length,
      sub_domains: subDomains.length,
      goals: goals.length,
      items: items.length,
      education_suggestions: GUIDE_EDUCATION_SUGGESTIONS.length,
      health_reference_items: healthReferences.length,
      sustained_items: items.filter((item) => item.product_rules.evidence_type === "sustained").length,
      requires_independence_items: items.filter(
        (item) => item.product_rules.adult_help === "requires_independence",
      ).length,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
