import { CONTRACT_FIXTURE_SEMESTERS } from "@/lib/guide/__fixtures__/contract-fixtures";
import type {
  GuideCatalog,
  GuideDomain,
  GuideGoal,
  GuideItemProductRules,
  GuidePerformanceItem,
  GuideSourceLocation,
  GuideSubDomain,
  SemesterPeriod,
} from "@/lib/guide/types";
import type {
  ChildEvidenceBook,
  ChildEvidenceGoalView,
  ChildGuideItemView,
  EvidenceBasisInvalidReason,
  EvidenceBasisView,
  EvidenceChildRef,
  EvidenceExclusionReason,
  EvidenceLinkView,
  EvidenceReliability,
  GuideStatusCounts,
} from "@/lib/guide/view-types";
import type {
  GuideEvidenceLinkOrigin,
  GuideEvidenceLinkStatus,
  GuideEvidencePeriodNote,
  GuideEvidenceQuoteField,
  GuideEvidenceQuoteSource,
  GuideEvidenceSupportKind,
  ObservationClassContextSnapshot,
} from "@/lib/guide/types";
import type { GuideItemEvidenceStatus } from "@/lib/guide/view-types";

/**
 * G3 个人证据册 UI fixture（纯数据）。
 * - 只用于组件与浏览器 fixture 验收，不写数据库、不调用模型，也不进入生产数据读取链路；
 * - 目录内容均为“fixture 示意”，不是《指南》正式目录（正式目录由 G1 提供）；
 * - 姓名、班级、观察片段全部为合成示例，child_id 以 fixture- 前缀标明；
 * - 覆盖：三种正式状态、AI 待核对、成人帮助条件、历史班级未知、撤回、失效依据、
 *   partial/unavailable 可靠性、无记录、大目录、长文本与只读身份。
 */

const UI_FIXTURE_SOURCE: GuideSourceLocation = {
  document: "《3—6岁儿童学习与发展指南》（UI fixture 示意，非正式目录）",
  publisher: "教育部",
  published_year: 2012,
  section: "fixture · UI 示意",
};

const UI_CATALOG_VERSION = "ui-fixture.v1";

function rules(
  evidence_type: GuideItemProductRules["evidence_type"],
  adult_help: GuideItemProductRules["adult_help"],
): GuideItemProductRules {
  return { evidence_type, counts_in_behavior_stats: evidence_type !== "health_reference", adult_help };
}

function item(input: {
  id: string;
  domain_id: string;
  sub_domain_id: string;
  goal_id: string;
  age_band: GuidePerformanceItem["age_band"];
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
  code: GuideDomain["code"];
  name: string;
  sub_domains: GuideSubDomain[];
}): GuideDomain {
  return { ...input, source: UI_FIXTURE_SOURCE };
}

/* ---------------------------------------------------------------- 目录 fixture */

const LANGUAGE_DOMAIN = domain({
  id: "dom.ui.language",
  code: "language",
  name: "语言",
  sub_domains: [
    subDomain({
      id: "sub.ui.language.listen_speak",
      domain_id: "dom.ui.language",
      name: "倾听与表达",
      goals: [
        goal({
          id: "goal.ui.language.1",
          domain_id: "dom.ui.language",
          sub_domain_id: "sub.ui.language.listen_speak",
          index: 1,
          title: "认真听并能听懂常用语言（fixture 示意）",
          items: [
            item({
              id: "item.ui.language.1.3-4",
              domain_id: "dom.ui.language",
              sub_domain_id: "sub.ui.language.listen_speak",
              goal_id: "goal.ui.language.1",
              age_band: "3-4",
              text: "别人对自己说话时能注意听并做出回应（fixture 示意）。",
              product_rules: rules("behavior", "requires_independence"),
            }),
            item({
              id: "item.ui.language.1.4-5",
              domain_id: "dom.ui.language",
              sub_domain_id: "sub.ui.language.listen_speak",
              goal_id: "goal.ui.language.1",
              age_band: "4-5",
              text: "能听懂并愿意回应日常交谈中的问题（fixture 示意）。",
              product_rules: rules("sustained", "allowed"),
            }),
          ],
        }),
        goal({
          id: "goal.ui.language.2",
          domain_id: "dom.ui.language",
          sub_domain_id: "sub.ui.language.listen_speak",
          index: 2,
          title: "愿意讲话并能清楚地表达（fixture 示意）",
          items: [
            item({
              id: "item.ui.language.2.3-4",
              domain_id: "dom.ui.language",
              sub_domain_id: "sub.ui.language.listen_speak",
              goal_id: "goal.ui.language.2",
              age_band: "3-4",
              text: "愿意在熟悉的人面前说话，能大方地与人打招呼（fixture 示意）。",
              product_rules: rules("behavior", "allowed"),
            }),
          ],
        }),
      ],
    }),
  ],
});

const HEALTH_DOMAIN = domain({
  id: "dom.ui.health",
  code: "health",
  name: "健康",
  sub_domains: [
    subDomain({
      id: "sub.ui.health.self_care",
      domain_id: "dom.ui.health",
      name: "生活习惯与生活能力",
      goals: [
        goal({
          id: "goal.ui.health.1",
          domain_id: "dom.ui.health",
          sub_domain_id: "sub.ui.health.self_care",
          index: 1,
          title: "具有良好的生活与卫生习惯（fixture 示意）",
          items: [
            item({
              id: "item.ui.health.1.3-4",
              domain_id: "dom.ui.health",
              sub_domain_id: "sub.ui.health.self_care",
              goal_id: "goal.ui.health.1",
              age_band: "3-4",
              text: "在提醒下按时午睡、饭前便后洗手（fixture 示意）。",
              product_rules: rules("health_reference", "allowed"),
            }),
            item({
              id: "item.ui.health.1.4-5",
              domain_id: "dom.ui.health",
              sub_domain_id: "sub.ui.health.self_care",
              goal_id: "goal.ui.health.1",
              age_band: "4-5",
              text: "能自己穿脱衣服、鞋袜、扣纽扣（fixture 示意）。",
              product_rules: rules("behavior", "allowed"),
            }),
          ],
        }),
      ],
    }),
  ],
});

const SOCIAL_DOMAIN = domain({
  id: "dom.ui.social",
  code: "social",
  name: "社会",
  sub_domains: [
    subDomain({
      id: "sub.ui.social.peers",
      domain_id: "dom.ui.social",
      name: "人际交往",
      goals: [
        goal({
          id: "goal.ui.social.1",
          domain_id: "dom.ui.social",
          sub_domain_id: "sub.ui.social.peers",
          index: 1,
          title: "愿意与人交往（fixture 示意）",
          items: [
            item({
              id: "item.ui.social.1.3-4",
              domain_id: "dom.ui.social",
              sub_domain_id: "sub.ui.social.peers",
              goal_id: "goal.ui.social.1",
              age_band: "3-4",
              text: "愿意和小朋友一起游戏（fixture 示意）。",
              product_rules: rules("behavior", "allowed"),
            }),
            item({
              id: "item.ui.social.1.4-5",
              domain_id: "dom.ui.social",
              sub_domain_id: "sub.ui.social.peers",
              goal_id: "goal.ui.social.1",
              age_band: "4-5",
              text: "能想办法加入同伴的游戏（fixture 示意）。",
              product_rules: rules("behavior", "allowed"),
            }),
          ],
        }),
      ],
    }),
  ],
});

const SCIENCE_DOMAIN = domain({
  id: "dom.ui.science",
  code: "science",
  name: "科学",
  sub_domains: [
    subDomain({
      id: "sub.ui.science.inquiry",
      domain_id: "dom.ui.science",
      name: "科学探究",
      goals: [
        goal({
          id: "goal.ui.science.1",
          domain_id: "dom.ui.science",
          sub_domain_id: "sub.ui.science.inquiry",
          index: 1,
          title: "亲近自然，喜欢探究（fixture 示意）",
          items: [
            item({
              id: "item.ui.science.1.4-5",
              domain_id: "dom.ui.science",
              sub_domain_id: "sub.ui.science.inquiry",
              goal_id: "goal.ui.science.1",
              age_band: "4-5",
              text: "能通过观察、比较与分析，发现并描述不同种类物体的特征（fixture 示意）。",
              product_rules: rules("sustained", "allowed"),
            }),
            item({
              id: "item.ui.science.1.3-4",
              domain_id: "dom.ui.science",
              sub_domain_id: "sub.ui.science.inquiry",
              goal_id: "goal.ui.science.1",
              age_band: "3-4",
              text: "对感兴趣的事物能仔细观察，发现其明显特征（fixture 示意）。",
              product_rules: rules("behavior", "allowed"),
            }),
          ],
        }),
      ],
    }),
  ],
});

const ARTS_DOMAIN = domain({
  id: "dom.ui.arts",
  code: "arts",
  name: "艺术",
  sub_domains: [
    subDomain({
      id: "sub.ui.arts.expression",
      domain_id: "dom.ui.arts",
      name: "表现与创造",
      goals: [
        goal({
          id: "goal.ui.arts.1",
          domain_id: "dom.ui.arts",
          sub_domain_id: "sub.ui.arts.expression",
          index: 1,
          title: "喜欢进行艺术活动并大胆表现（fixture 示意）",
          items: [
            item({
              id: "item.ui.arts.1.3-4",
              domain_id: "dom.ui.arts",
              sub_domain_id: "sub.ui.arts.expression",
              goal_id: "goal.ui.arts.1",
              age_band: "3-4",
              text: "经常自哼自唱或模仿有趣的动作、表情和声调，并愿意在集体面前展示自己的作品（fixture 示意，本条用于验证长文本换行与完整展示）。",
              product_rules: rules("behavior", "allowed"),
            }),
            item({
              id: "item.ui.arts.1.4-5",
              domain_id: "dom.ui.arts",
              sub_domain_id: "sub.ui.arts.expression",
              goal_id: "goal.ui.arts.1",
              age_band: "4-5",
              text: "能用拍手、踏脚等身体动作或可敲击的物品敲打节拍和基本节奏（fixture 示意）。",
              product_rules: rules("behavior", "allowed"),
            }),
          ],
        }),
      ],
    }),
  ],
});

export const UI_FIXTURE_CATALOG: GuideCatalog = {
  version: UI_CATALOG_VERSION,
  source: UI_FIXTURE_SOURCE,
  domains: [LANGUAGE_DOMAIN, HEALTH_DOMAIN, SOCIAL_DOMAIN, SCIENCE_DOMAIN, ARTS_DOMAIN],
};

/* ---------------------------------------------------------------- 关联与依据 */

const SMALL_CLASS: ObservationClassContextSnapshot = {
  class_id: "fixture-ui-class-small-1",
  class_name: "示例小一班",
  stage: "small",
  school_year: "2025-2026",
  captured_at: "2025-10-08T00:00:00.000Z",
  source: "enrollment_lookup",
  enrollment_id: "fixture-ui-enrollment-1",
};

const MIDDLE_CLASS: ObservationClassContextSnapshot = {
  class_id: "fixture-ui-class-middle-1",
  class_name: "示例中一班",
  stage: "middle",
  school_year: "2026-2027",
  captured_at: "2026-09-01T00:00:00.000Z",
  source: "enrollment_lookup",
  enrollment_id: "fixture-ui-enrollment-2",
};

const LARGE_CLASS: ObservationClassContextSnapshot = {
  class_id: "fixture-ui-class-large-1",
  class_name: "示例大二班",
  stage: "large",
  school_year: "2026-2027",
  captured_at: "2026-09-01T00:00:00.000Z",
  source: "enrollment_lookup",
  enrollment_id: "fixture-ui-enrollment-3",
};

function basis(input: {
  observationId: string;
  observedAt: string;
  quote: string;
  classContext: ObservationClassContextSnapshot | null;
  quoteSource?: GuideEvidenceQuoteSource;
  quoteField?: GuideEvidenceQuoteField | null;
  valid?: boolean;
  invalidReason?: EvidenceBasisInvalidReason | null;
}): EvidenceBasisView {
  const quoteSource = input.quoteSource ?? "raw_text";
  const valid = input.valid ?? true;
  return {
    observation_id: input.observationId,
    observed_at: input.observedAt,
    quote: input.quote,
    quote_source: quoteSource,
    quote_field: quoteSource === "raw_text" ? null : (input.quoteField ?? "highlight_quote"),
    class_context: input.classContext,
    source_confirmed_at: `${input.observedAt}T03:00:00.000Z`,
    valid,
    invalid_reason: valid ? null : (input.invalidReason ?? "quote_not_found"),
    observation_status: valid ? "confirmed" : null,
  };
}

function link(input: {
  id: string;
  itemId: string;
  status: GuideEvidenceLinkStatus;
  support: GuideEvidenceSupportKind | null;
  basis: EvidenceBasisView[];
  countsTowardStatus: boolean;
  excludedReason?: EvidenceExclusionReason | null;
  origin?: GuideEvidenceLinkOrigin;
  adultHelpUsed?: boolean;
  teacherNote?: string | null;
  aiReason?: string | null;
  sustainedNote?: GuideEvidencePeriodNote | null;
  withdrawnAt?: string | null;
  withdrawnReason?: string | null;
  decidedAt?: string | null;
  createdAt?: string;
}): EvidenceLinkView {
  return {
    link_id: input.id,
    item_id: input.itemId,
    catalog_version: UI_CATALOG_VERSION,
    origin: input.origin ?? "ai",
    status: input.status,
    support: input.support,
    sustained_note: input.sustainedNote ?? null,
    adult_help_used: input.adultHelpUsed ?? false,
    basis: input.basis,
    ai_reason: input.aiReason ?? null,
    teacher_note: input.teacherNote ?? null,
    revision: 1,
    created_at: input.createdAt ?? `${input.basis[0]?.observed_at ?? "2026-09-01"}T04:00:00.000Z`,
    decided_at: input.decidedAt ?? null,
    withdrawn_at: input.withdrawnAt ?? null,
    withdrawn_reason: input.withdrawnReason ?? null,
    counts_toward_status: input.countsTowardStatus,
    excluded_reason: input.countsTowardStatus ? null : (input.excludedReason ?? null),
  };
}

/* 正式状态与最早/最近日期只读取服务端字段；fixture 里按同一规则生成示例值。 */
function itemView(
  guideItem: GuidePerformanceItem,
  links: EvidenceLinkView[],
  overrides?: { status?: GuideItemEvidenceStatus; reliability?: EvidenceReliability },
): ChildGuideItemView {
  const counting = links.filter((entry) => entry.counts_toward_status);
  const dates = counting
    .flatMap((entry) => entry.basis.map((source) => source.observed_at))
    .sort((a, b) => a.localeCompare(b));
  const status: GuideItemEvidenceStatus =
    overrides?.status ??
    (counting.some((entry) => entry.status === "confirmed_performance")
      ? "confirmed_observed"
      : counting.some((entry) => entry.status === "confirmed_clue")
        ? "has_clues"
        : "no_records");
  const reliability: EvidenceReliability =
    overrides?.reliability ??
    (links.some((entry) => entry.basis.some((source) => !source.valid)) ||
    links.some(
      (entry) =>
        !entry.counts_toward_status &&
        (entry.excluded_reason === "basis_invalid" || entry.excluded_reason === "catalog_mismatch"),
    )
      ? "partial"
      : "reliable");
  return {
    item: guideItem,
    status,
    reliability,
    links,
    first_observed_at: dates[0] ?? null,
    latest_observed_at: dates.at(-1) ?? null,
  };
}

function goalRef(guideGoal: GuideGoal) {
  return {
    id: guideGoal.id,
    domain_id: guideGoal.domain_id,
    sub_domain_id: guideGoal.sub_domain_id,
    index: guideGoal.index,
    title: guideGoal.title,
  };
}

function buildGoals(
  catalog: GuideCatalog,
  linksByItem: Record<string, EvidenceLinkView[]>,
  overridesByItem?: Record<string, { status?: GuideItemEvidenceStatus; reliability?: EvidenceReliability }>,
): ChildEvidenceGoalView[] {
  return catalog.domains.flatMap((entry) =>
    entry.sub_domains.flatMap((sub) =>
      sub.goals.map((guideGoal) => ({
        goal: goalRef(guideGoal),
        items: guideGoal.items.map((guideItem) =>
          itemView(guideItem, linksByItem[guideItem.id] ?? [], overridesByItem?.[guideItem.id]),
        ),
      })),
    ),
  );
}

function countStatuses(goals: ChildEvidenceGoalView[]): GuideStatusCounts {
  const counts: GuideStatusCounts = { no_records: 0, has_clues: 0, confirmed_observed: 0 };
  for (const goal of goals) {
    for (const entry of goal.items) counts[entry.status] += 1;
  }
  return counts;
}

const UI_SCOPE = {
  kind: "semester",
  semester_id: "2026-2027-1",
  label: "2026-2027学年第一学期",
  start_date: "2026-09-01",
  end_date: "2027-01-31",
  filter_field: "observed_at",
} as const;

const UI_FILTERS = { domain_code: null, age_band: null, goal_id: null } as const;

const UI_CHILD: EvidenceChildRef = {
  id: "fixture-ui-child-xiaoyu",
  name: "小雨",
  birth_date: "2021-03-12",
  class_id: MIDDLE_CLASS.class_id,
  class_name: MIDDLE_CLASS.class_name,
  stage: "middle",
};

/* ---------------------------------------------------------------- 场景一：完整示例（默认预览） */

const RICH_LINKS: Record<string, EvidenceLinkView[]> = {
  "item.ui.language.1.3-4": [
    link({
      id: "link.ui.language.1.3-4.performance",
      itemId: "item.ui.language.1.3-4",
      status: "confirmed_performance",
      support: "single_event",
      origin: "manual",
      basis: [
        basis({
          observationId: "obs.ui.language.1.3-4.a",
          observedAt: "2026-09-05",
          quote: "晨谈时，小雨举手说「我昨天和小猫玩了，它喜欢喝牛奶」，并等同伴说完才接着说。",
          classContext: MIDDLE_CLASS,
        }),
      ],
      countsTowardStatus: true,
      decidedAt: "2026-09-05T05:00:00.000Z",
    }),
    link({
      id: "link.ui.language.1.3-4.withdrawn",
      itemId: "item.ui.language.1.3-4",
      status: "withdrawn",
      support: "single_event",
      basis: [
        basis({
          observationId: "obs.ui.language.1.3-4.b",
          observedAt: "2025-11-02",
          quote: "在提醒下，小雨和同伴打了招呼。",
          classContext: SMALL_CLASS,
        }),
      ],
      countsTowardStatus: false,
      excludedReason: "withdrawn",
      decidedAt: "2025-11-02T05:00:00.000Z",
      withdrawnAt: "2025-11-10T01:00:00.000Z",
      withdrawnReason: "复核后发现该片段指向另一条表现。",
    }),
  ],
  "item.ui.language.1.4-5": [
    link({
      id: "link.ui.language.1.4-5.clue",
      itemId: "item.ui.language.1.4-5",
      status: "confirmed_clue",
      support: "clue_only",
      adultHelpUsed: true,
      teacherNote: "帮助方式：教师重复问题并等待幼儿回应。",
      /* 同一观察的两个不同片段：验证 React key 不与 observation_id 冲突 */
      basis: [
        basis({
          observationId: "obs.ui.language.1.4-5.a",
          observedAt: "2026-09-10",
          quote: "晨谈时，小雨听完问题后想了想说「是不是周末下雨了？」",
          classContext: MIDDLE_CLASS,
        }),
        basis({
          observationId: "obs.ui.language.1.4-5.a",
          observedAt: "2026-09-10",
          quote: "随后她又补充说「我妈妈说下雨要带伞」。",
          classContext: MIDDLE_CLASS,
        }),
      ],
      countsTowardStatus: true,
      decidedAt: "2026-09-10T05:00:00.000Z",
    }),
  ],
  "item.ui.language.2.3-4": [
    link({
      id: "link.ui.language.2.3-4.pending",
      itemId: "item.ui.language.2.3-4",
      status: "ai_suggested",
      support: null,
      aiReason: "本次出现了主动问候同伴的表达，可能与该表现相关，待教师核对。",
      basis: [
        basis({
          observationId: "obs.ui.language.2.3-4.a",
          observedAt: "2026-09-23",
          quote: "早上来园时，小雨主动对同伴说「早上好，一起搭积木吧」。",
          classContext: MIDDLE_CLASS,
        }),
      ],
      countsTowardStatus: false,
      excludedReason: "workflow_pending",
    }),
  ],
  "item.ui.health.1.3-4": [
    link({
      id: "link.ui.health.1.3-4.performance",
      itemId: "item.ui.health.1.3-4",
      status: "confirmed_performance",
      support: "single_event",
      origin: "manual",
      adultHelpUsed: true,
      teacherNote: "帮助方式：午睡前教师轻声提醒并示范。",
      basis: [
        basis({
          observationId: "obs.ui.health.1.3-4.a",
          observedAt: "2026-09-12",
          quote: "午睡前，小雨听到提醒后自己脱好鞋子摆整齐，然后上床躺好。",
          classContext: MIDDLE_CLASS,
        }),
      ],
      countsTowardStatus: true,
      decidedAt: "2026-09-12T05:00:00.000Z",
    }),
  ],
  "item.ui.social.1.3-4": [
    link({
      id: "link.ui.social.1.3-4.invalid",
      itemId: "item.ui.social.1.3-4",
      status: "confirmed_performance",
      support: "sustained",
      basis: [
        basis({
          observationId: "obs.ui.social.1.3-4.a",
          observedAt: "2026-09-14",
          quote: "小雨主动把积木分给了同桌。",
          classContext: MIDDLE_CLASS,
          valid: false,
          invalidReason: "quote_not_found",
        }),
        basis({
          observationId: "obs.ui.social.1.3-4.b",
          observedAt: "2026-09-18",
          quote: "游戏结束后，小雨和同伴一起把积木收进筐里。",
          classContext: MIDDLE_CLASS,
        }),
      ],
      countsTowardStatus: false,
      excludedReason: "basis_invalid",
      decidedAt: "2026-09-18T05:00:00.000Z",
    }),
  ],
  "item.ui.social.1.4-5": [
    link({
      id: "link.ui.social.1.4-5.out-of-period",
      itemId: "item.ui.social.1.4-5",
      status: "confirmed_performance",
      support: "sustained",
      basis: [
        basis({
          observationId: "obs.ui.social.1.4-5.a",
          observedAt: "2025-12-05",
          quote: "小雨拿着自己的小车问同伴「可以一起玩吗？」",
          classContext: SMALL_CLASS,
        }),
        basis({
          observationId: "obs.ui.social.1.4-5.b",
          observedAt: "2026-03-08",
          quote: "小雨看到同伴在搭桥，说「我来帮你递积木吧」。",
          classContext: SMALL_CLASS,
        }),
      ],
      countsTowardStatus: false,
      excludedReason: "basis_out_of_period",
      decidedAt: "2026-03-08T05:00:00.000Z",
    }),
  ],
  "item.ui.science.1.4-5": [
    link({
      id: "link.ui.science.1.4-5.performance",
      itemId: "item.ui.science.1.4-5",
      status: "confirmed_performance",
      support: "sustained",
      sustainedNote: {
        period_start: "2026-09-15",
        period_end: "2026-09-20",
        description: "连续一周在自然角观察豆苗，每天记录高度并比较叶片数量的变化。",
      },
      basis: [
        basis({
          observationId: "obs.ui.science.1.4-5.a",
          observedAt: "2026-09-15",
          quote: "小雨指着豆苗说「今天的叶子比昨天多了一片」。",
          classContext: null,
        }),
        basis({
          observationId: "obs.ui.science.1.4-5.b",
          observedAt: "2026-09-20",
          quote: "小雨把两盆豆苗并排比较后说「这盆长得高，因为阳光多」。",
          classContext: null,
        }),
      ],
      countsTowardStatus: true,
      decidedAt: "2026-09-20T05:00:00.000Z",
    }),
  ],
  "item.ui.arts.1.3-4": [
    link({
      id: "link.ui.arts.1.3-4.performance",
      itemId: "item.ui.arts.1.3-4",
      status: "confirmed_performance",
      support: "single_event",
      origin: "manual",
      basis: [
        basis({
          observationId: "obs.ui.arts.1.3-4.a",
          observedAt: "2026-09-21",
          quote:
            "区域活动时，小雨先用蓝色画了一条弯弯的河，又用棉签蘸黄色颜料点了一排小灯。她举着画对同伴说：「这是晚上的河，灯一亮，小船就不会迷路了。」随后她把画贴到展示墙上，向全班介绍了自己画里的故事。",
          classContext: MIDDLE_CLASS,
        }),
      ],
      countsTowardStatus: true,
      decidedAt: "2026-09-21T05:00:00.000Z",
    }),
  ],
};

const RICH_GOALS = buildGoals(UI_FIXTURE_CATALOG, RICH_LINKS);

export const CHILD_EVIDENCE_BOOK_FIXTURE: ChildEvidenceBook = {
  audience: "child_history",
  child: UI_CHILD,
  catalog_version: UI_CATALOG_VERSION,
  catalog: UI_FIXTURE_CATALOG,
  scope: UI_SCOPE,
  filters: UI_FILTERS,
  status_counts: countStatuses(RICH_GOALS),
  goals: RICH_GOALS,
  notices: [],
};

/* ---------------------------------------------------------------- 场景二：大目录 */

const LARGE_DOMAIN_NAMES: Array<{ code: GuideDomain["code"]; name: string; sub: string }> = [
  { code: "health", name: "健康", sub: "fixture 大目录 · 健康" },
  { code: "language", name: "语言", sub: "fixture 大目录 · 语言" },
  { code: "social", name: "社会", sub: "fixture 大目录 · 社会" },
  { code: "science", name: "科学", sub: "fixture 大目录 · 科学" },
  { code: "arts", name: "艺术", sub: "fixture 大目录 · 艺术" },
];

function buildLargeCatalog(): GuideCatalog {
  const domains = LARGE_DOMAIN_NAMES.map((entry, domainIndex) => {
    const domainId = `dom.ui.large.${entry.code}`;
    const subId = `sub.ui.large.${entry.code}`;
    const goals = Array.from({ length: 4 }, (_, goalIndex) => {
      const goalId = `goal.ui.large.${entry.code}.${goalIndex + 1}`;
      const itemCount = 3 + ((goalIndex + domainIndex) % 4);
      return goal({
        id: goalId,
        domain_id: domainId,
        sub_domain_id: subId,
        index: goalIndex + 1,
        title: `${entry.name}领域第 ${goalIndex + 1} 个综合目标（fixture 大目录示意）`,
        items: Array.from({ length: itemCount }, (_, itemIndex) =>
          item({
            id: `item.ui.large.${entry.code}.${goalIndex + 1}.${itemIndex + 1}`,
            domain_id: domainId,
            sub_domain_id: subId,
            goal_id: goalId,
            age_band: (["3-4", "4-5", "5-6"] as const)[itemIndex % 3],
            text: `大目录示例表现 ${entry.name} ${goalIndex + 1}-${itemIndex + 1}：在日常生活与游戏中持续表现出与该目标相关的行为（fixture 示意文本，用于检验长列表的扫读、展开与键盘操作）。`,
            product_rules: rules(itemIndex % 5 === 0 ? "sustained" : "behavior", itemIndex % 4 === 0 ? "requires_independence" : "allowed"),
          }),
        ),
      });
    });
    return domain({
      id: domainId,
      code: entry.code,
      name: entry.name,
      sub_domains: [subDomain({ id: subId, domain_id: domainId, name: entry.sub, goals })],
    });
  });
  return { version: UI_CATALOG_VERSION, source: UI_FIXTURE_SOURCE, domains };
}

const LARGE_CATALOG = buildLargeCatalog();

const LARGE_LINKS: Record<string, EvidenceLinkView[]> = {
  "item.ui.large.language.1.1": [
    link({
      id: "link.ui.large.language.1.1.performance",
      itemId: "item.ui.large.language.1.1",
      status: "confirmed_performance",
      support: "single_event",
      origin: "manual",
      basis: [
        basis({
          observationId: "obs.ui.large.language.1.1.a",
          observedAt: "2026-09-25",
          quote: "禾禾在小组分享时完整讲述了自己搭建的作品。",
          classContext: LARGE_CLASS,
        }),
      ],
      countsTowardStatus: true,
      decidedAt: "2026-09-25T05:00:00.000Z",
    }),
  ],
  "item.ui.large.social.2.1": [
    link({
      id: "link.ui.large.social.2.1.clue",
      itemId: "item.ui.large.social.2.1",
      status: "confirmed_clue",
      support: "clue_only",
      basis: [
        basis({
          observationId: "obs.ui.large.social.2.1.a",
          observedAt: "2026-09-26",
          quote: "禾禾在同伴邀请后加入了角色游戏。",
          classContext: LARGE_CLASS,
        }),
      ],
      countsTowardStatus: true,
      decidedAt: "2026-09-26T05:00:00.000Z",
    }),
  ],
  "item.ui.large.arts.1.1": [
    link({
      id: "link.ui.large.arts.1.1.pending",
      itemId: "item.ui.large.arts.1.1",
      status: "ai_suggested",
      support: null,
      aiReason: "fixture 大目录：待核对建议不计入正式状态。",
      basis: [
        basis({
          observationId: "obs.ui.large.arts.1.1.a",
          observedAt: "2026-09-27",
          quote: "禾禾在音乐区跟着节奏拍手。",
          classContext: LARGE_CLASS,
        }),
      ],
      countsTowardStatus: false,
      excludedReason: "workflow_pending",
    }),
  ],
};

const LARGE_GOALS = buildGoals(LARGE_CATALOG, LARGE_LINKS);

export const CHILD_EVIDENCE_BOOK_LARGE_FIXTURE: ChildEvidenceBook = {
  audience: "child_history",
  child: {
    id: "fixture-ui-child-hehe",
    name: "禾禾",
    birth_date: "2020-11-02",
    class_id: "fixture-ui-class-large-1",
    class_name: "示例大二班",
    stage: "large",
  },
  catalog_version: UI_CATALOG_VERSION,
  catalog: LARGE_CATALOG,
  scope: {
    kind: "all_history",
    semester_id: null,
    label: "全部历史",
    start_date: null,
    end_date: null,
    filter_field: "observed_at",
  },
  filters: UI_FILTERS,
  status_counts: countStatuses(LARGE_GOALS),
  goals: LARGE_GOALS,
  notices: [],
};

/* ---------------------------------------------------------------- 场景三：记录不可读（unavailable） */

const UNAVAILABLE_CATALOG: GuideCatalog = {
  version: UI_CATALOG_VERSION,
  source: UI_FIXTURE_SOURCE,
  domains: [
    domain({
      id: "dom.ui.unavailable.language",
      code: "language",
      name: "语言",
      sub_domains: [
        subDomain({
          id: "sub.ui.unavailable.language",
          domain_id: "dom.ui.unavailable.language",
          name: "fixture · 不可读示例",
          goals: [
            goal({
              id: "goal.ui.unavailable.language.1",
              domain_id: "dom.ui.unavailable.language",
              sub_domain_id: "sub.ui.unavailable.language",
              index: 1,
              title: "认真听并能听懂常用语言（fixture 示意）",
              items: [
                item({
                  id: "item.ui.unavailable.language.1.3-4",
                  domain_id: "dom.ui.unavailable.language",
                  sub_domain_id: "sub.ui.unavailable.language",
                  goal_id: "goal.ui.unavailable.language.1",
                  age_band: "3-4",
                  text: "别人对自己说话时能注意听并做出回应（fixture 示意）。",
                  product_rules: rules("behavior", "requires_independence"),
                }),
                item({
                  id: "item.ui.unavailable.language.1.4-5",
                  domain_id: "dom.ui.unavailable.language",
                  sub_domain_id: "sub.ui.unavailable.language",
                  goal_id: "goal.ui.unavailable.language.1",
                  age_band: "4-5",
                  text: "能听懂并愿意回应日常交谈中的问题（fixture 示意）。",
                  product_rules: rules("sustained", "allowed"),
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ],
};

const UNAVAILABLE_GOALS = buildGoals(UNAVAILABLE_CATALOG, {}, {
  "item.ui.unavailable.language.1.3-4": { reliability: "unavailable" },
});

export const CHILD_EVIDENCE_BOOK_UNAVAILABLE_FIXTURE: ChildEvidenceBook = {
  audience: "child_history",
  child: {
    id: "fixture-ui-child-xiaohe",
    name: "小禾",
    birth_date: "2022-01-20",
    class_id: null,
    class_name: null,
    stage: null,
  },
  catalog_version: UI_CATALOG_VERSION,
  catalog: UNAVAILABLE_CATALOG,
  scope: UI_SCOPE,
  filters: UI_FILTERS,
  status_counts: countStatuses(UNAVAILABLE_GOALS),
  goals: UNAVAILABLE_GOALS,
  notices: [
    {
      code: "guide_evidence_unreadable",
      severity: "warning",
      message: "部分观察的指南关联暂时无法读取，本页状态可能不完整；请稍后刷新。",
    },
  ],
};

/* ---------------------------------------------------------------- 学期配置（引用 G0 纯数据） */

export const CHILD_EVIDENCE_BOOK_SEMESTERS: SemesterPeriod[] = CONTRACT_FIXTURE_SEMESTERS;
