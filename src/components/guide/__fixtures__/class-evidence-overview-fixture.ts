import type {
  GuideAgeBand,
  GuideCatalog,
  GuideDomain,
  GuideDomainCode,
  GuideGoal,
  GuideItemProductRules,
  GuidePerformanceItem,
  GuideSourceLocation,
  GuideSubDomain,
} from "@/lib/guide/types";
import type {
  ClassChildItemStatus,
  ClassEvidenceOverview,
  ClassGuideItemView,
  EvidenceChildRef,
  EvidenceReliability,
  EvidenceScope,
  GuideItemEvidenceStatus,
  GuideStatusCounts,
} from "@/lib/guide/view-types";

/**
 * G4 班级指南证据概览 UI fixture（纯数据）。
 * - 只用于组件与浏览器 fixture 验收，不写数据库、不调用模型，也不进入生产数据读取链路；
 * - 目录内容均为“fixture 示意”，不是《指南》正式目录（正式目录由 G1 提供）；
 * - 班级、姓名、观察片段全部为合成示例，id 以 fixture- / item.ui. 前缀标明；
 * - 覆盖：20 人 6/4/10、0 人名单、全部无记录、多记录按幼儿去重、AI 待核对不计入、
 *   partial / unavailable、保健参考不统计、转班与未知历史、历史期间、长名称。
 */

const UI_FIXTURE_SOURCE: GuideSourceLocation = {
  document: "《3—6岁儿童学习与发展指南》（UI fixture 示意，非正式目录）",
  publisher: "教育部",
  published_year: 2012,
  section: "fixture · UI 示意",
};

export const CLASS_FIXTURE_CATALOG_VERSION = "ui-fixture.v1";

export const CLASS_FIXTURE_CLASS_ID = "fixture-class-sunflower-mid2";

/* ------------------------------------------------------------------ 当前在班名单（20 人，合成示例） */

const CLASS_NAME = "太阳花融合教育实验中二班";

const CHILD_NAMES = [
  "阿依努尔·买买提江",
  "陈子墨",
  "林晓雨",
  "欧阳一诺",
  "张嘉禾",
  "王梓萱",
  "李云帆",
  "赵沐阳",
  "周思齐",
  "吴桐",
  "郑欣怡",
  "孙浩然",
  "马语桐",
  "朱明远",
  "胡雨桐",
  "高子轩",
  "何芷晴",
  "罗一舟",
  "谢安然",
  "唐果果",
];

function rosterChild(index: number): EvidenceChildRef {
  const serial = String(index + 1).padStart(2, "0");
  return {
    id: `fixture-class-mid2-child-${serial}`,
    name: CHILD_NAMES[index],
    birth_date: `2021-${String((index % 9) + 1).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`,
    class_id: CLASS_FIXTURE_CLASS_ID,
    class_name: CLASS_NAME,
    stage: "middle",
  };
}

const ROSTER_CHILDREN: EvidenceChildRef[] = Array.from({ length: 20 }, (_, index) => rosterChild(index));

/* ------------------------------------------------------------------ 目录（fixture 示意） */

function rules(
  evidence_type: GuideItemProductRules["evidence_type"],
  adult_help: GuideItemProductRules["adult_help"] = "allowed",
): GuideItemProductRules {
  return { evidence_type, counts_in_behavior_stats: evidence_type !== "health_reference", adult_help };
}

function item(input: {
  id: string;
  domain_id: string;
  sub_domain_id: string;
  goal_id: string;
  age_band: GuideAgeBand;
  text: string;
  product_rules: GuideItemProductRules;
}): GuidePerformanceItem {
  return { ...input, source: UI_FIXTURE_SOURCE };
}

function goal(input: {
  id: string;
  domain_id: string;
  sub_domain_id: string;
  index: number;
  title: string;
  items: GuidePerformanceItem[];
}): GuideGoal {
  return { ...input, source: UI_FIXTURE_SOURCE };
}

function subDomain(input: {
  id: string;
  domain_id: string;
  name: string;
  goals: GuideGoal[];
}): GuideSubDomain {
  return { ...input, source: UI_FIXTURE_SOURCE };
}

function domain(input: {
  id: string;
  code: GuideDomainCode;
  name: string;
  sub_domains: GuideSubDomain[];
}): GuideDomain {
  return { ...input, source: UI_FIXTURE_SOURCE };
}

export const ITEM_UI_HEALTH_SELF_CARE_34 = "item.ui.health.h1.3-4";
export const ITEM_UI_HEALTH_SELF_CARE_56 = "item.ui.health.h1.5-6";
export const ITEM_UI_HEALTH_POSTURE_45 = "item.ui.health.h2.4-5";
export const ITEM_UI_LANGUAGE_SPEAK_34 = "item.ui.language.l1.3-4";
export const ITEM_UI_LANGUAGE_TELL_45 = "item.ui.language.l1.4-5";
export const ITEM_UI_SOCIAL_PEER_45 = "item.ui.social.s1.4-5";
export const ITEM_UI_SCIENCE_EXPLORE_56 = "item.ui.science.sc1.5-6";
export const ITEM_UI_ARTS_EXPRESS_34 = "item.ui.arts.a1.3-4";

const DOMAIN_DEFS: GuideDomain[] = [
  domain({
    id: "dom.ui.health",
    code: "health",
    name: "健康",
    sub_domains: [
      subDomain({
        id: "sub.ui.health.life",
        domain_id: "dom.ui.health",
        name: "生活习惯与生活能力（fixture 示意）",
        goals: [
          goal({
            id: "goal.ui.health.1",
            domain_id: "dom.ui.health",
            sub_domain_id: "sub.ui.health.life",
            index: 1,
            title: "具有基本的生活自理能力（fixture 示意）",
            items: [
              item({
                id: ITEM_UI_HEALTH_SELF_CARE_34,
                domain_id: "dom.ui.health",
                sub_domain_id: "sub.ui.health.life",
                goal_id: "goal.ui.health.1",
                age_band: "3-4",
                text: "在提醒下，能自己穿脱衣服、鞋袜、扣纽扣（fixture 示意）。",
                product_rules: rules("behavior"),
              }),
              item({
                id: ITEM_UI_HEALTH_SELF_CARE_56,
                domain_id: "dom.ui.health",
                sub_domain_id: "sub.ui.health.life",
                goal_id: "goal.ui.health.1",
                age_band: "5-6",
                text: "能根据冷热感觉主动增减衣服（fixture 示意）。",
                product_rules: rules("behavior"),
              }),
            ],
          }),
          goal({
            id: "goal.ui.health.2",
            domain_id: "dom.ui.health",
            sub_domain_id: "sub.ui.health.life",
            index: 2,
            title: "具有健康的体态（fixture 示意）",
            items: [
              item({
                id: ITEM_UI_HEALTH_POSTURE_45,
                domain_id: "dom.ui.health",
                sub_domain_id: "sub.ui.health.life",
                goal_id: "goal.ui.health.2",
                age_band: "4-5",
                text: "身高和体重适宜，参考该年龄段参考标准（fixture 示意·保健参考；只作日常保育对照阅读，不作正常／异常判定）。",
                product_rules: rules("health_reference"),
              }),
            ],
          }),
        ],
      }),
    ],
  }),
  domain({
    id: "dom.ui.language",
    code: "language",
    name: "语言",
    sub_domains: [
      subDomain({
        id: "sub.ui.language.speak",
        domain_id: "dom.ui.language",
        name: "倾听与表达（fixture 示意）",
        goals: [
          goal({
            id: "goal.ui.language.1",
            domain_id: "dom.ui.language",
            sub_domain_id: "sub.ui.language.speak",
            index: 1,
            title: "愿意讲话并能清楚地表达（fixture 示意）",
            items: [
              item({
                id: ITEM_UI_LANGUAGE_SPEAK_34,
                domain_id: "dom.ui.language",
                sub_domain_id: "sub.ui.language.speak",
                goal_id: "goal.ui.language.1",
                age_band: "3-4",
                text: "愿意在熟悉的人面前说话，能大方地与人打招呼（fixture 示意）。",
                product_rules: rules("behavior"),
              }),
              item({
                id: ITEM_UI_LANGUAGE_TELL_45,
                domain_id: "dom.ui.language",
                sub_domain_id: "sub.ui.language.speak",
                goal_id: "goal.ui.language.1",
                age_band: "4-5",
                text: "能基本完整地讲述自己的所见所闻和经历的事情（fixture 示意）。",
                product_rules: rules("behavior"),
              }),
            ],
          }),
        ],
      }),
    ],
  }),
  domain({
    id: "dom.ui.social",
    code: "social",
    name: "社会",
    sub_domains: [
      subDomain({
        id: "sub.ui.social.peer",
        domain_id: "dom.ui.social",
        name: "人际交往（fixture 示意）",
        goals: [
          goal({
            id: "goal.ui.social.1",
            domain_id: "dom.ui.social",
            sub_domain_id: "sub.ui.social.peer",
            index: 1,
            title: "能与同伴友好相处（fixture 示意）",
            items: [
              item({
                id: ITEM_UI_SOCIAL_PEER_45,
                domain_id: "dom.ui.social",
                sub_domain_id: "sub.ui.social.peer",
                goal_id: "goal.ui.social.1",
                age_band: "4-5",
                text: "想加入同伴的游戏时，能友好地提出请求（fixture 示意）。",
                product_rules: rules("behavior"),
              }),
            ],
          }),
        ],
      }),
    ],
  }),
  domain({
    id: "dom.ui.science",
    code: "science",
    name: "科学",
    sub_domains: [
      subDomain({
        id: "sub.ui.science.nature",
        domain_id: "dom.ui.science",
        name: "科学探究（fixture 示意）",
        goals: [
          goal({
            id: "goal.ui.science.1",
            domain_id: "dom.ui.science",
            sub_domain_id: "sub.ui.science.nature",
            index: 1,
            title: "亲近自然，喜欢探究（fixture 示意）",
            items: [
              item({
                id: ITEM_UI_SCIENCE_EXPLORE_56,
                domain_id: "dom.ui.science",
                sub_domain_id: "sub.ui.science.nature",
                goal_id: "goal.ui.science.1",
                age_band: "5-6",
                text: "经常问各种问题，或好奇地摆弄物品，并持续观察变化（fixture 示意·持续性表现）。",
                product_rules: rules("sustained"),
              }),
            ],
          }),
        ],
      }),
    ],
  }),
  domain({
    id: "dom.ui.arts",
    code: "arts",
    name: "艺术",
    sub_domains: [
      subDomain({
        id: "sub.ui.arts.express",
        domain_id: "dom.ui.arts",
        name: "表现与创造（fixture 示意）",
        goals: [
          goal({
            id: "goal.ui.arts.1",
            domain_id: "dom.ui.arts",
            sub_domain_id: "sub.ui.arts.express",
            index: 1,
            title: "喜欢进行艺术活动并大胆表现（fixture 示意）",
            items: [
              item({
                id: ITEM_UI_ARTS_EXPRESS_34,
                domain_id: "dom.ui.arts",
                sub_domain_id: "sub.ui.arts.express",
                goal_id: "goal.ui.arts.1",
                age_band: "3-4",
                text: "经常自哼自唱或模仿有趣的动作、表情和声调，愿意在集体面前讲述自己画里的故事（fixture 示意·这是一段特意拉长的条目原文，用来验证窄屏下长文本换行与横向不溢出）。",
                product_rules: rules("behavior"),
              }),
            ],
          }),
        ],
      }),
    ],
  }),
];

export const CLASS_EVIDENCE_CATALOG: GuideCatalog = {
  version: CLASS_FIXTURE_CATALOG_VERSION,
  source: UI_FIXTURE_SOURCE,
  domains: DOMAIN_DEFS,
};

/* ------------------------------------------------------------------ 条目分布（20 人 roster） */

interface DistributionInput {
  counts: GuideStatusCounts;
  /** 第 1 位幼儿跨两条证据，用于验证按幼儿去重后仍只计 1 人 */
  dedup_first?: boolean;
  /** 待核对建议所在幼儿（处于 no_records 段），不应计入任何正式人数 */
  pending_index?: number;
  /** 存在未通过核对的依据，条目计数降为下限 */
  partial_indices?: number[];
  /** 单名幼儿的相关记录不可读取（混合可靠性） */
  unavailable_indices?: number[];
  /** 整个条目的相关证据完全无法读取：不得展示为正常的 0 */
  unavailable?: boolean;
}

const DISTRIBUTIONS: Record<string, DistributionInput> = {
  [ITEM_UI_HEALTH_SELF_CARE_34]: { counts: { no_records: 5, has_clues: 3, confirmed_observed: 12 } },
  [ITEM_UI_HEALTH_SELF_CARE_56]: { counts: { no_records: 12, has_clues: 6, confirmed_observed: 2 } },
  [ITEM_UI_HEALTH_POSTURE_45]: { counts: { no_records: 10, has_clues: 2, confirmed_observed: 8 } },
  [ITEM_UI_LANGUAGE_SPEAK_34]: {
    counts: { no_records: 10, has_clues: 4, confirmed_observed: 6 },
    dedup_first: true,
    pending_index: 19,
  },
  [ITEM_UI_LANGUAGE_TELL_45]: { counts: { no_records: 20, has_clues: 0, confirmed_observed: 0 } },
  [ITEM_UI_SOCIAL_PEER_45]: {
    counts: { no_records: 15, has_clues: 2, confirmed_observed: 3 },
    partial_indices: [2],
    unavailable_indices: [10],
  },
  [ITEM_UI_SCIENCE_EXPLORE_56]: {
    counts: { no_records: 20, has_clues: 0, confirmed_observed: 0 },
    unavailable: true,
  },
  [ITEM_UI_ARTS_EXPRESS_34]: { counts: { no_records: 6, has_clues: 5, confirmed_observed: 9 } },
};

const DATE_BASE_CURRENT = "2026-09-01";

function addDaysIso(base: string, days: number): string {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 证据日期与所选期间保持自洽：从期间起点顺延，并夹在期间结束日之内 */
function observationDates(scope: EvidenceScope, index: number): { first: string; latest: string } {
  const base = scope.start_date ?? DATE_BASE_CURRENT;
  const clamp = (iso: string) => (scope.end_date && iso > scope.end_date ? scope.end_date : iso);
  const first = clamp(addDaysIso(base, 1 + (index % 8)));
  let latest = clamp(addDaysIso(base, 8 + (index % 8)));
  if (latest < first) latest = first;
  return { first, latest };
}

function buildChildren(input: DistributionInput, scope: EvidenceScope): ClassChildItemStatus[] {
  const { counts, dedup_first, pending_index, partial_indices, unavailable_indices, unavailable } = input;
  const cluesEnd = counts.confirmed_observed + counts.has_clues;
  return ROSTER_CHILDREN.map((child, index) => {
    let status: GuideItemEvidenceStatus = "no_records";
    if (index < counts.confirmed_observed) status = "confirmed_observed";
    else if (index < cluesEnd) status = "has_clues";

    let reliability: EvidenceReliability = "reliable";
    if (unavailable || unavailable_indices?.includes(index)) reliability = "unavailable";
    else if (partial_indices?.includes(index)) reliability = "partial";

    const hasEvidence = status !== "no_records";
    const dates = hasEvidence ? observationDates(scope, index) : { first: null, latest: null };
    return {
      child_id: child.id,
      status,
      reliability,
      confirmed_link_count: hasEvidence ? (dedup_first && index === 0 ? 2 : 1) : 0,
      pending_suggestion_count: pending_index === index ? 1 : 0,
      first_observed_at: dates.first,
      latest_observed_at: dates.latest,
    };
  });
}

/* ------------------------------------------------------------------ 读模型构建（fixture 内的离线替身） */

export const CLASS_FIXTURE_SEMESTER_SCOPE: EvidenceScope = {
  kind: "semester",
  semester_id: "2026-2027-1",
  label: "2026-2027学年第一学期",
  start_date: "2026-09-01",
  end_date: "2027-01-31",
  filter_field: "observed_at",
};

export const CLASS_FIXTURE_HISTORY_SCOPE: EvidenceScope = {
  kind: "semester",
  semester_id: "2025-2026-1",
  label: "2025-2026学年第一学期（历史期间）",
  start_date: "2025-09-01",
  end_date: "2026-01-31",
  filter_field: "observed_at",
};

export interface ClassOverviewFixtureOptions {
  domain_code?: GuideDomainCode | null;
  age_band?: GuideAgeBand | null;
  goal_id?: string | null;
  scope?: EvidenceScope;
}

function toClassItem(catalogItem: GuidePerformanceItem, scope: EvidenceScope): ClassGuideItemView {
  const input = DISTRIBUTIONS[catalogItem.id] ?? { counts: { no_records: 20, has_clues: 0, confirmed_observed: 0 } };
  const children = buildChildren(input, scope);
  const total = ROSTER_CHILDREN.length;
  const reliability: EvidenceReliability = input.unavailable
    ? "unavailable"
    : (input.partial_indices?.length ?? 0) > 0 || (input.unavailable_indices?.length ?? 0) > 0
      ? "partial"
      : "reliable";
  const countsSum = input.counts.confirmed_observed + input.counts.has_clues + input.counts.no_records;
  return {
    item: catalogItem,
    counts: input.counts,
    total,
    reliability,
    confirmed_ratio:
      reliability === "reliable" && catalogItem.product_rules.counts_in_behavior_stats && countsSum > 0
        ? input.counts.confirmed_observed / total
        : null,
    children,
  };
}

export function buildClassEvidenceOverview(
  options: ClassOverviewFixtureOptions = {},
): ClassEvidenceOverview {
  const scope = options.scope ?? CLASS_FIXTURE_SEMESTER_SCOPE;
  const domainCode = options.domain_code ?? null;
  const ageBand = options.age_band ?? null;
  const goalId = options.goal_id ?? null;

  const goals = DOMAIN_DEFS.filter((entry) => domainCode === null || entry.code === domainCode).flatMap(
    (entry) =>
      entry.sub_domains.flatMap((sub) =>
        sub.goals
          .filter((entryGoal) => goalId === null || entryGoal.id === goalId)
          .map((entryGoal) => ({
            goal: {
              id: entryGoal.id,
              domain_id: entryGoal.domain_id,
              sub_domain_id: entryGoal.sub_domain_id,
              index: entryGoal.index,
              title: entryGoal.title,
            },
            items: entryGoal.items
              .filter((entryItem) => ageBand === null || entryItem.age_band === ageBand)
              .map((entryItem) => toClassItem(entryItem, scope)),
          })),
      ),
  ).filter((entry) => entry.items.length > 0);

  return {
    audience: "class_current_roster",
    class: {
      id: CLASS_FIXTURE_CLASS_ID,
      name: CLASS_NAME,
      stage: "middle",
      school_year: "2026-2027",
      is_active: true,
    },
    catalog_version: CLASS_FIXTURE_CATALOG_VERSION,
    catalog: CLASS_EVIDENCE_CATALOG,
    scope,
    filters: { domain_code: domainCode, age_band: ageBand, goal_id: goalId },
    roster: { child_count: ROSTER_CHILDREN.length, children: ROSTER_CHILDREN },
    goals,
    notices: [
      {
        code: "out_of_stage_evidence",
        severity: "info",
        message:
          "有 2 条关联证据发生在幼儿转入前的小班班级，与当前中班阶段不同，未纳入本次统计；转入前的同阶段证据会按发生班级保留并计入。",
      },
      {
        code: "history_unknown",
        severity: "info",
        message: "有 1 名幼儿的 1 条关联证据发生班级快照缺失，按未知保留，未纳入本次统计。",
      },
      {
        code: "basis_invalid",
        severity: "warning",
        item_id: ITEM_UI_SOCIAL_PEER_45,
        message: "“能与同伴友好相处”下有 1 条关联因部分依据未通过核对，人数按可确认下限统计。",
      },
      {
        code: "ai_link_failed",
        severity: "info",
        message: "上次 AI 关联建议未生成；教师仍可以在观察记录中手动关联表现条目。",
      },
      {
        code: "guide_evidence_unreadable",
        severity: "error",
        item_id: ITEM_UI_SCIENCE_EXPLORE_56,
        message: "“亲近自然，喜欢探究”下有幼儿的相关记录暂时无法读取，不能按「暂无相关记录」理解。",
      },
    ],
  };
}

/* ------------------------------------------------------------------ 0 人名单 fixture */

const EMPTY_SCOPE: EvidenceScope = {
  kind: "semester",
  semester_id: "2026-2027-1",
  label: "2026-2027学年第一学期",
  start_date: "2026-09-01",
  end_date: "2027-01-31",
  filter_field: "observed_at",
};

function emptyItem(catalogItem: GuidePerformanceItem): ClassGuideItemView {
  return {
    item: catalogItem,
    counts: { no_records: 0, has_clues: 0, confirmed_observed: 0 },
    total: 0,
    reliability: "reliable",
    confirmed_ratio: null,
    children: [],
  };
}

export function buildEmptyRosterOverview(): ClassEvidenceOverview {
  const sourceDomain = DOMAIN_DEFS.find((entry) => entry.code === "language");
  const sourceGoal = sourceDomain?.sub_domains[0]?.goals[0];
  return {
    audience: "class_current_roster",
    class: {
      id: "fixture-class-star-small",
      name: "满天星小一班（fixture 示意）",
      stage: "small",
      school_year: "2026-2027",
      is_active: true,
    },
    catalog_version: CLASS_FIXTURE_CATALOG_VERSION,
    catalog: CLASS_EVIDENCE_CATALOG,
    scope: EMPTY_SCOPE,
    filters: { domain_code: null, age_band: null, goal_id: null },
    roster: { child_count: 0, children: [] },
    goals:
      sourceDomain && sourceGoal
        ? [
            {
              goal: {
                id: sourceGoal.id,
                domain_id: sourceGoal.domain_id,
                sub_domain_id: sourceGoal.sub_domain_id,
                index: sourceGoal.index,
                title: sourceGoal.title,
              },
              items: sourceGoal.items.map(emptyItem),
            },
          ]
        : [],
    notices: [
      {
        code: "empty_roster",
        severity: "info",
        message: "当前在班名单为 0 人，暂不统计各条目的幼儿人数；建立成长档案后即可按名单回看证据。",
      },
    ],
  };
}

export const CLASS_FIXTURE_OVERVIEW_MAIN = buildClassEvidenceOverview();
export const CLASS_FIXTURE_OVERVIEW_EMPTY_ROSTER = buildEmptyRosterOverview();
export const CLASS_FIXTURE_OVERVIEW_HISTORY = buildClassEvidenceOverview({
  scope: CLASS_FIXTURE_HISTORY_SCOPE,
});
