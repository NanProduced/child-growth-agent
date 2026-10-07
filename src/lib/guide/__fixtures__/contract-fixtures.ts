import type { ClassStage, Observation, ObservationDraft, ObservationStatus } from "@/lib/types";
import type {
  GuideCatalog,
  GuideEducationSuggestion,
  GuideEvidenceBasis,
  GuideEvidenceLink,
  GuideEvidenceLinkOrigin,
  GuideEvidenceLinkStatus,
  GuideEvidencePeriodNote,
  GuideEvidenceQuoteField,
  GuideEvidenceQuoteSource,
  GuideEvidenceSupportKind,
  GuideSourceLocation,
  ObservationClassContextSnapshot,
  ObservationGuideEvidence,
  SemesterPeriod,
} from "../types";
import type {
  EvidenceAudience,
  EvidenceChildRef,
  EvidenceExclusionReason,
  EvidenceReliability,
  GuideEvidenceConfirmRequest,
  GuideItemEvidenceStatus,
  ObservationConfirmGuideExtension,
} from "../view-types";

/**
 * G0-R1 契约 fixture：先放反例，再对应修正后的规则。
 * - 只用于离线类型与参考算法检查；不写数据库、不调用模型、不代表真实 LLM 结果；
 * - 目录内容是最小示意，不是《指南》正式目录（正式目录由 G1 提供）；
 * - 全部姓名为合成示例，child_id 以 fixture- 前缀标明；
 * - 反例覆盖：学段三分、依据全有效、跨儿童、跨期持续、目录版本、未来建议引用、
 *   手动关联、成人帮助、NULL 与损坏 JSON、撤回一致性、去重。
 */

export const CONTRACT_FIXTURE_CATALOG_VERSION = "contract-fixture.v1";

const FIXTURE_SOURCE: GuideSourceLocation = {
  document: "《3—6岁儿童学习与发展指南》（契约 fixture 摘要，非正式目录）",
  publisher: "教育部",
  published_year: 2012,
  section: "fixture · 目录摘要",
};

export const FIXTURE_ITEM_ID = {
  listening34: "item.fixture.language.listening.1.3-4",
  listening45: "item.fixture.language.listening.1.4-5",
  speaking34: "item.fixture.language.speaking.2.3-4",
  healthHabit34: "item.fixture.health.habit.1.3-4",
} as const;

export const FIXTURE_GOAL_ID = {
  listening: "goal.fixture.language.1",
  speaking: "goal.fixture.language.2",
  healthHabit: "goal.fixture.health.1",
} as const;

/** 3 个目标、4 个表现条目：用于证明“综合目标数 ≠ 表现条目数” */
export const CONTRACT_FIXTURE_CATALOG: GuideCatalog = {
  version: CONTRACT_FIXTURE_CATALOG_VERSION,
  source: FIXTURE_SOURCE,
  domains: [
    {
      id: "dom.fixture.language",
      code: "language",
      name: "语言",
      source: FIXTURE_SOURCE,
      sub_domains: [
        {
          id: "sub.fixture.language.listen_speak",
          domain_id: "dom.fixture.language",
          name: "倾听与表达",
          source: FIXTURE_SOURCE,
          goals: [
            {
              id: FIXTURE_GOAL_ID.listening,
              domain_id: "dom.fixture.language",
              sub_domain_id: "sub.fixture.language.listen_speak",
              index: 1,
              title: "认真听并能听懂常用语言（fixture 摘要）",
              source: FIXTURE_SOURCE,
              items: [
                {
                  id: FIXTURE_ITEM_ID.listening34,
                  domain_id: "dom.fixture.language",
                  sub_domain_id: "sub.fixture.language.listen_speak",
                  goal_id: FIXTURE_GOAL_ID.listening,
                  age_band: "3-4",
                  text: "别人对自己说话时能注意听并做出回应（fixture 摘要）。",
                  source: FIXTURE_SOURCE,
                  product_rules: {
                    evidence_type: "behavior",
                    counts_in_behavior_stats: true,
                    adult_help: "requires_independence",
                  },
                },
                {
                  id: FIXTURE_ITEM_ID.listening45,
                  domain_id: "dom.fixture.language",
                  sub_domain_id: "sub.fixture.language.listen_speak",
                  goal_id: FIXTURE_GOAL_ID.listening,
                  age_band: "4-5",
                  text: "能听懂并愿意回应日常交谈中的问题（fixture 摘要）。",
                  source: FIXTURE_SOURCE,
                  product_rules: {
                    evidence_type: "sustained",
                    counts_in_behavior_stats: true,
                    adult_help: "allowed",
                  },
                },
              ],
            },
            {
              id: FIXTURE_GOAL_ID.speaking,
              domain_id: "dom.fixture.language",
              sub_domain_id: "sub.fixture.language.listen_speak",
              index: 2,
              title: "愿意讲话并能清楚地表达（fixture 摘要）",
              source: FIXTURE_SOURCE,
              items: [
                {
                  id: FIXTURE_ITEM_ID.speaking34,
                  domain_id: "dom.fixture.language",
                  sub_domain_id: "sub.fixture.language.listen_speak",
                  goal_id: FIXTURE_GOAL_ID.speaking,
                  age_band: "3-4",
                  text: "愿意在熟悉的人面前说话，能大方地与人打招呼（fixture 摘要）。",
                  source: FIXTURE_SOURCE,
                  product_rules: {
                    evidence_type: "behavior",
                    counts_in_behavior_stats: true,
                    adult_help: "allowed",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "dom.fixture.health",
      code: "health",
      name: "健康",
      source: FIXTURE_SOURCE,
      sub_domains: [
        {
          id: "sub.fixture.health.self_care",
          domain_id: "dom.fixture.health",
          name: "生活习惯与生活能力",
          source: FIXTURE_SOURCE,
          goals: [
            {
              id: FIXTURE_GOAL_ID.healthHabit,
              domain_id: "dom.fixture.health",
              sub_domain_id: "sub.fixture.health.self_care",
              index: 1,
              title: "具有良好的生活与卫生习惯（fixture 摘要）",
              source: FIXTURE_SOURCE,
              items: [
                {
                  id: FIXTURE_ITEM_ID.healthHabit34,
                  domain_id: "dom.fixture.health",
                  sub_domain_id: "sub.fixture.health.self_care",
                  goal_id: FIXTURE_GOAL_ID.healthHabit,
                  age_band: "3-4",
                  text: "在提醒下按时午睡、饭前便后洗手（fixture 摘要）。",
                  source: FIXTURE_SOURCE,
                  product_rules: {
                    evidence_type: "health_reference",
                    counts_in_behavior_stats: false,
                    adult_help: "allowed",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export const CONTRACT_FIXTURE_EDUCATION_SUGGESTIONS: GuideEducationSuggestion[] = [
  {
    id: "sug.fixture.language.1.1",
    goal_id: FIXTURE_GOAL_ID.listening,
    text: "创设轻松的交谈情境，耐心倾听并回应幼儿的表达（fixture 摘要）。",
    source: FIXTURE_SOURCE,
  },
  {
    id: "sug.fixture.health.1.1",
    goal_id: FIXTURE_GOAL_ID.healthHabit,
    text: "在日常生活中用稳定的作息提示帮助幼儿养成卫生习惯（fixture 摘要）。",
    source: FIXTURE_SOURCE,
  },
];

/** 学期显式配置示意；正式配置由 G2 提供 */
export const CONTRACT_FIXTURE_SEMESTERS: SemesterPeriod[] = [
  {
    id: "2025-2026-1",
    school_year: "2025-2026",
    term: 1,
    label: "2025-2026学年第一学期",
    start_date: "2025-09-01",
    end_date: "2026-01-31",
  },
  {
    id: "2025-2026-2",
    school_year: "2025-2026",
    term: 2,
    label: "2025-2026学年第二学期",
    start_date: "2026-02-01",
    end_date: "2026-07-15",
  },
  {
    id: "2026-2027-1",
    school_year: "2026-2027",
    term: 1,
    label: "2026-2027学年第一学期",
    start_date: "2026-09-01",
    end_date: "2027-01-31",
  },
];

export const FIXTURE_CLASS_CONTEXT: ObservationClassContextSnapshot = {
  class_id: "fixture-class-1",
  class_name: "示例中一班",
  stage: "middle",
  school_year: "2026-2027",
  captured_at: "2026-09-01T00:00:00.000Z",
  source: "enrollment_lookup",
  enrollment_id: "fixture-enrollment-1",
};

export const FIXTURE_SMALL_CLASS_CONTEXT: ObservationClassContextSnapshot = {
  class_id: "fixture-class-small-1",
  class_name: "示例小一班",
  stage: "small",
  school_year: "2025-2026",
  captured_at: "2025-10-08T00:00:00.000Z",
  source: "teacher_confirmed",
  confirmed_at: "2025-10-08T01:00:00.000Z",
};

const FIXTURE_CONFIRMED_CONTENT: ObservationDraft = {
  domain: "语言",
  sub_domain: "倾听与表达",
  objective_description: "fixture 使用的确认稿占位内容（谨慎理解，不作为事实证据）。",
  highlights: ["fixture 占位亮点：幼儿说出了完整的一句话"],
  support_suggestions: ["fixture 未来支持建议，不得作为事实证据"],
  highlight_quote: "fixture 占位金句",
};

/** 契约检查用观察：confirmed 状态 + 两个新增可选 JSONB 字段 */
export interface FixtureObservation extends Observation {
  class_context_snapshot: ObservationClassContextSnapshot | null;
  guide_evidence: ObservationGuideEvidence | null;
}

export interface FixtureChildEvidence {
  child: EvidenceChildRef;
  observations: FixtureObservation[];
  /** 模拟数据库中的损坏/非法 JSON（不进入类型化字段）；检查脚本按显式异常处理 */
  corrupted_guide_evidence?: { observation_id: string; raw_json: string }[];
}

export interface FixtureScope {
  kind: "semester" | "all_history" | "custom_range";
  semester_id?: string;
  start_date: string | null;
  end_date: string | null;
  label: string;
}

export interface ContractScenarioFixture extends FixtureChildEvidence {
  scenario: string;
  item_id: string;
  audience: EvidenceAudience;
  /** audience=class_current_roster 时的班级阶段 */
  class_stage?: ClassStage;
  scope: FixtureScope;
  expected_status: GuideItemEvidenceStatus;
  expected_reliability: EvidenceReliability;
  /** 唯一相关关联的排除原因；计入状态时为 null */
  expected_excluded_reason: EvidenceExclusionReason | null;
}

function fixtureObservation(input: {
  id: string;
  child_id: string;
  observed_at: string;
  raw_text: string;
  class_context: ObservationClassContextSnapshot | null;
  guide_evidence: ObservationGuideEvidence | null;
  status?: ObservationStatus;
  confirmed_content?: ObservationDraft | null;
}): FixtureObservation {
  const status = input.status ?? "confirmed";
  const confirmedContent =
    input.confirmed_content !== undefined
      ? input.confirmed_content
      : status === "confirmed"
        ? FIXTURE_CONFIRMED_CONTENT
        : null;
  return {
    id: input.id,
    child_id: input.child_id,
    class_id: input.class_context?.class_id ?? null,
    observed_class: null,
    observed_at: input.observed_at,
    context: "区域活动",
    raw_text: input.raw_text,
    status,
    agent_context: null,
    ai_draft: status === "ai_organized" ? FIXTURE_CONFIRMED_CONTENT : null,
    ai_model: "offline-fixture",
    ai_organized_at: `${input.observed_at}T02:00:00.000Z`,
    confirmed_content: confirmedContent,
    confirmed_at: status === "confirmed" ? `${input.observed_at}T03:00:00.000Z` : null,
    is_demo: true,
    created_at: `${input.observed_at}T02:30:00.000Z`,
    updated_at: null,
    class_context_snapshot: input.class_context,
    guide_evidence: input.guide_evidence,
  };
}

function fixtureBasis(
  observation: FixtureObservation,
  quote: string,
  options?: { quote_source?: GuideEvidenceQuoteSource; quote_field?: GuideEvidenceQuoteField | null },
): GuideEvidenceBasis {
  const quoteSource = options?.quote_source ?? "raw_text";
  return {
    observation_id: observation.id,
    observed_at: observation.observed_at,
    quote,
    quote_source: quoteSource,
    quote_field: quoteSource === "raw_text" ? null : (options?.quote_field ?? "highlight_quote"),
    class_context: observation.class_context_snapshot,
    source_confirmed_at: observation.confirmed_at,
  };
}

function fixtureLink(input: {
  id: string;
  item_id: string;
  status: GuideEvidenceLinkStatus;
  support: GuideEvidenceSupportKind | null;
  basis: GuideEvidenceBasis[];
  created_at: string;
  decided_at: string | null;
  origin?: GuideEvidenceLinkOrigin;
  catalog_version?: string;
  adult_help_used?: boolean;
  sustained_note?: GuideEvidencePeriodNote | null;
  ai_reason?: string | null;
  teacher_note?: string | null;
  revision?: number;
  withdrawn_at?: string | null;
  withdrawn_reason?: string | null;
}): GuideEvidenceLink {
  return {
    catalog_version: input.catalog_version ?? CONTRACT_FIXTURE_CATALOG_VERSION,
    origin: input.origin ?? "ai",
    adult_help_used: input.adult_help_used ?? false,
    sustained_note: input.sustained_note ?? null,
    ai_reason: input.ai_reason ?? null,
    teacher_note: input.teacher_note ?? null,
    revision: input.revision ?? 1,
    withdrawn_at: input.withdrawn_at ?? null,
    withdrawn_reason: input.withdrawn_reason ?? null,
    ...input,
  };
}

function fixtureChild(id: string, name: string, stage: ClassStage = "middle"): EvidenceChildRef {
  return {
    id,
    name,
    birth_date: "2021-05-01",
    class_id: stage === "middle" ? FIXTURE_CLASS_CONTEXT.class_id : FIXTURE_SMALL_CLASS_CONTEXT.class_id,
    class_name: stage === "middle" ? FIXTURE_CLASS_CONTEXT.class_name : FIXTURE_SMALL_CLASS_CONTEXT.class_name,
    stage,
  };
}

const ITEM = FIXTURE_ITEM_ID;

const SEMESTER_2026_1: FixtureScope = {
  kind: "semester",
  semester_id: "2026-2027-1",
  start_date: "2026-09-01",
  end_date: "2027-01-31",
  label: "2026-2027学年第一学期",
};
const ALL_HISTORY: FixtureScope = {
  kind: "all_history",
  start_date: null,
  end_date: null,
  label: "全部历史",
};
const SMALL_PERIOD: FixtureScope = {
  kind: "custom_range",
  start_date: "2025-09-01",
  end_date: "2026-01-31",
  label: "小班时期（自定义范围）",
};

/* 反例 1：中班儿童查看小班历史；同时用于验证“当前班级改学段不改变旧证据” */
const middleHistoryChild = fixtureChild("fixture-child-middle-history", "示例幼儿A");
const middleHistoryObs = fixtureObservation({
  id: "fixture-obs-middle-history",
  child_id: middleHistoryChild.id,
  observed_at: "2025-10-08",
  raw_text: "晨谈时杉杉举手说「我昨天和小猫玩了，它喜欢喝牛奶」。",
  class_context: FIXTURE_SMALL_CLASS_CONTEXT,
  guide_evidence: null,
});
middleHistoryObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-middle-history",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "single_event",
      basis: [fixtureBasis(middleHistoryObs, "杉杉举手说「我昨天和小猫玩了，它喜欢喝牛奶」")],
      created_at: "2025-10-08T04:00:00.000Z",
      decided_at: "2025-10-08T05:00:00.000Z",
    }),
  ],
};

/* 反例 2：持续性证据跨学期，仅一条落在本期 */
const crossPeriodChild = fixtureChild("fixture-child-cross-period", "示例幼儿B");
const crossPeriodObsA = fixtureObservation({
  id: "fixture-obs-cross-period-a",
  child_id: crossPeriodChild.id,
  observed_at: "2026-05-10",
  raw_text: "自由游戏后，果果主动告诉老师自己搭的桥为什么不会倒。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
const crossPeriodObsB = fixtureObservation({
  id: "fixture-obs-cross-period-b",
  child_id: crossPeriodChild.id,
  observed_at: "2026-09-10",
  raw_text: "区域分享时，果果完整讲述了今天搭桥的经过。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
crossPeriodObsA.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-cross-period",
      item_id: ITEM.listening45,
      status: "confirmed_performance",
      support: "sustained",
      basis: [
        fixtureBasis(crossPeriodObsA, "果果主动告诉老师自己搭的桥为什么不会倒"),
        fixtureBasis(crossPeriodObsB, "果果完整讲述了今天搭桥的经过"),
      ],
      created_at: "2026-09-10T04:00:00.000Z",
      decided_at: "2026-09-10T05:00:00.000Z",
    }),
  ],
};

/* 反例 3：一条有效 + 一条虚构引用 */
const mixedBasisChild = fixtureChild("fixture-child-mixed-basis", "示例幼儿C");
const mixedBasisObs = fixtureObservation({
  id: "fixture-obs-mixed-basis",
  child_id: mixedBasisChild.id,
  observed_at: "2026-09-11",
  raw_text: "然然用一句话向同伴要回了自己的水杯。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
mixedBasisObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-mixed-basis",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "sustained",
      basis: [
        fixtureBasis(mixedBasisObs, "用一句话向同伴要回了自己的水杯"),
        fixtureBasis(mixedBasisObs, "还主动帮助同伴收拾了玩具"),
      ],
      created_at: "2026-09-11T04:00:00.000Z",
      decided_at: "2026-09-11T05:00:00.000Z",
    }),
  ],
};

/* 反例 4：一条有效 + 一条未确认来源 */
const unconfirmedBasisChild = fixtureChild("fixture-child-unconfirmed-basis", "示例幼儿D");
const unconfirmedDraftObs = fixtureObservation({
  id: "fixture-obs-unconfirmed-draft",
  child_id: unconfirmedBasisChild.id,
  observed_at: "2026-09-12",
  raw_text: "乐乐在积木区搭了一扇可以开关的门。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
  status: "ai_organized",
  confirmed_content: null,
});
const unconfirmedBasisObs = fixtureObservation({
  id: "fixture-obs-unconfirmed-main",
  child_id: unconfirmedBasisChild.id,
  observed_at: "2026-09-13",
  raw_text: "乐乐举手说出了自己想玩的区域。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
unconfirmedBasisObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-unconfirmed-basis",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "sustained",
      basis: [
        fixtureBasis(unconfirmedBasisObs, "乐乐举手说出了自己想玩的区域"),
        fixtureBasis(unconfirmedDraftObs, "搭了一扇可以开关的门"),
      ],
      created_at: "2026-09-13T04:00:00.000Z",
      decided_at: "2026-09-13T05:00:00.000Z",
    }),
  ],
};

/* 反例 5：跨儿童引用 */
const neighborChild = fixtureChild("fixture-child-neighbor", "示例幼儿E");
const neighborObs = fixtureObservation({
  id: "fixture-obs-neighbor",
  child_id: neighborChild.id,
  observed_at: "2026-09-14",
  raw_text: "邻班幼儿在晨谈中完整讲述了自己的周末。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
const crossChildChild = fixtureChild("fixture-child-cross-child", "示例幼儿F");
const crossChildObs = fixtureObservation({
  id: "fixture-obs-cross-child",
  child_id: crossChildChild.id,
  observed_at: "2026-09-15",
  raw_text: "涵涵主动向老师介绍了自己的画。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
crossChildObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-cross-child",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "sustained",
      basis: [
        fixtureBasis(crossChildObs, "涵涵主动向老师介绍了自己的画"),
        fixtureBasis(neighborObs, "完整讲述了自己的周末"),
      ],
      created_at: "2026-09-15T04:00:00.000Z",
      decided_at: "2026-09-15T05:00:00.000Z",
    }),
  ],
};

/* 反例 6：目录版本不一致 */
const catalogMismatchChild = fixtureChild("fixture-child-catalog-mismatch", "示例幼儿G");
const catalogMismatchObs = fixtureObservation({
  id: "fixture-obs-catalog-mismatch",
  child_id: catalogMismatchChild.id,
  observed_at: "2026-09-16",
  raw_text: "铭铭在集体活动后主动告诉老师自己搭了一个高高的桥。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
catalogMismatchObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-catalog-mismatch",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "single_event",
      catalog_version: "contract-fixture.v0",
      basis: [fixtureBasis(catalogMismatchObs, "主动告诉老师自己搭了一个高高的桥")],
      created_at: "2026-09-16T04:00:00.000Z",
      decided_at: "2026-09-16T05:00:00.000Z",
    }),
  ],
};

/* 反例 7：确认稿中的未来支持建议不能成为事实证据 */
const futureSuggestionChild = fixtureChild("fixture-child-future-suggestion", "示例幼儿H");
const futureSuggestionObs = fixtureObservation({
  id: "fixture-obs-future-suggestion",
  child_id: futureSuggestionChild.id,
  observed_at: "2026-09-17",
  raw_text: "珊珊在娃娃家说了一句话。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
futureSuggestionObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-future-suggestion",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "single_event",
      basis: [
        fixtureBasis(futureSuggestionObs, "fixture 未来支持建议，不得作为事实证据", {
          quote_source: "confirmed_content",
          quote_field: "highlight_quote",
        }),
      ],
      created_at: "2026-09-17T04:00:00.000Z",
      decided_at: "2026-09-17T05:00:00.000Z",
    }),
  ],
};

/* 反例 8：没有 AI 建议仍能表达手动关联 */
const manualChild = fixtureChild("fixture-child-manual", "示例幼儿I");
const manualObs = fixtureObservation({
  id: "fixture-obs-manual",
  child_id: manualChild.id,
  observed_at: "2026-09-18",
  raw_text: "在老师提醒下，涵涵把想说的话说完整：「我想玩红色的积木。」",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
manualObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-manual",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "single_event",
      origin: "manual",
      adult_help_used: true,
      teacher_note: "在教师语言提示下完成；帮助方式：提示幼儿把话说完整。",
      basis: [fixtureBasis(manualObs, "在老师提醒下，涵涵把想说的话说完整")],
      created_at: "2026-09-18T04:00:00.000Z",
      decided_at: "2026-09-18T05:00:00.000Z",
    }),
  ],
};

/* 反例 9：原文允许成人帮助的条目可以确认表现（不因“帮助下完成”一律降为线索） */
const adultHelpAllowedChild = fixtureChild("fixture-child-adult-help-allowed", "示例幼儿J");
const adultHelpAllowedObs = fixtureObservation({
  id: "fixture-obs-adult-help-allowed",
  child_id: adultHelpAllowedChild.id,
  observed_at: "2026-09-19",
  raw_text: "在老师提醒下，杉杉把想说的话说完整：「我想玩红色的积木。」",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
adultHelpAllowedObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-adult-help-allowed",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "single_event",
      adult_help_used: true,
      teacher_note: "帮助方式：教师语言提示，幼儿自行把话说完整。",
      basis: [fixtureBasis(adultHelpAllowedObs, "在老师提醒下，杉杉把想说的话说完整")],
      created_at: "2026-09-19T04:00:00.000Z",
      decided_at: "2026-09-19T05:00:00.000Z",
    }),
  ],
};

/* 反例 10：要求独立完成的条目，有成人帮助只能确认线索 */
const adultHelpRestrictedChild = fixtureChild("fixture-child-adult-help-restricted", "示例幼儿K");
const adultHelpRestrictedObs = fixtureObservation({
  id: "fixture-obs-adult-help-restricted",
  child_id: adultHelpRestrictedChild.id,
  observed_at: "2026-09-20",
  raw_text: "在老师扶着下，乐乐在平衡木上走了一小段。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
adultHelpRestrictedObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-adult-help-restricted",
      item_id: ITEM.listening34,
      status: "confirmed_clue",
      support: "clue_only",
      adult_help_used: true,
      teacher_note: "本次有成人扶助，该条目要求独立完成，只确认线索。",
      basis: [fixtureBasis(adultHelpRestrictedObs, "在老师扶着下，乐乐在平衡木上走了一小段")],
      created_at: "2026-09-20T04:00:00.000Z",
      decided_at: "2026-09-20T05:00:00.000Z",
    }),
  ],
};

/* 反例 11：撤回保留 support 与撤回信息，不再计入正式状态 */
const withdrawnChild = fixtureChild("fixture-child-withdrawn", "示例幼儿L");
const withdrawnObs = fixtureObservation({
  id: "fixture-obs-withdrawn",
  child_id: withdrawnChild.id,
  observed_at: "2026-09-21",
  raw_text: "然然用一句话向同伴要回了自己的水杯。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
withdrawnObs.guide_evidence = {
  revision: 3,
  links: [
    fixtureLink({
      id: "fixture-link-withdrawn",
      item_id: ITEM.speaking34,
      status: "withdrawn",
      support: "single_event",
      revision: 2,
      basis: [fixtureBasis(withdrawnObs, "用一句话向同伴要回了自己的水杯")],
      created_at: "2026-09-21T04:00:00.000Z",
      decided_at: "2026-09-21T05:00:00.000Z",
      withdrawn_at: "2026-09-24T01:00:00.000Z",
      withdrawn_reason: "复核后发现该片段无法确认指向本条表现。",
    }),
  ],
};

/* 反例 12：NULL 旧记录正常显示未关联（不是损坏） */
const nullEvidenceChild = fixtureChild("fixture-child-null-evidence", "示例幼儿M");
const nullEvidenceObs = fixtureObservation({
  id: "fixture-obs-null-evidence",
  child_id: nullEvidenceChild.id,
  observed_at: "2026-09-22",
  raw_text: "在户外活动中反复练习双脚跳。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});

/* 反例 13：AI 建议待核对（工作流状态，不进入正式状态） */
const pendingChild = fixtureChild("fixture-child-pending", "示例幼儿N");
const pendingObs = fixtureObservation({
  id: "fixture-obs-pending",
  child_id: pendingChild.id,
  observed_at: "2026-09-23",
  raw_text: "楠楠在娃娃家对同伴说「你先做饭，我来喂娃娃」。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
pendingObs.guide_evidence = {
  revision: 1,
  links: [
    fixtureLink({
      id: "fixture-link-pending",
      item_id: ITEM.speaking34,
      status: "ai_suggested",
      support: null,
      basis: [fixtureBasis(pendingObs, "对同伴说「你先做饭，我来喂娃娃」")],
      ai_reason: "本次出现了面向同伴的完整表达，可能与该表现相关，待教师核对。",
      created_at: "2026-09-23T04:00:00.000Z",
      decided_at: null,
    }),
  ],
};

/* 反例 14：教师不采用 AI 建议（终态，support 保持 null） */
const rejectedChild = fixtureChild("fixture-child-rejected", "示例幼儿O");
const rejectedObs = fixtureObservation({
  id: "fixture-obs-rejected",
  child_id: rejectedChild.id,
  observed_at: "2026-09-24",
  raw_text: "乐乐用手指了指窗外的雨。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
rejectedObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-rejected",
      item_id: ITEM.speaking34,
      status: "rejected",
      support: null,
      basis: [fixtureBasis(rejectedObs, "用手指了指窗外的雨")],
      ai_reason: "动作指向可能是表达意图，待核对。",
      created_at: "2026-09-24T04:00:00.000Z",
      decided_at: "2026-09-24T05:00:00.000Z",
    }),
  ],
};

/* 反例 15：历史班级未知；个人历史回看仍纳入，班级统计按未知显式排除 */
const unknownStageChild = fixtureChild("fixture-child-unknown-stage", "示例幼儿P");
const unknownStageObs = fixtureObservation({
  id: "fixture-obs-unknown-stage",
  child_id: unknownStageChild.id,
  observed_at: "2026-09-25",
  raw_text: "铭铭在集体活动后主动告诉老师自己搭了一个高高的桥。",
  class_context: null,
  guide_evidence: null,
});
unknownStageObs.guide_evidence = {
  revision: 2,
  links: [
    fixtureLink({
      id: "fixture-link-unknown-stage",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "single_event",
      basis: [fixtureBasis(unknownStageObs, "主动告诉老师自己搭了一个高高的桥")],
      created_at: "2026-09-25T04:00:00.000Z",
      decided_at: "2026-09-25T05:00:00.000Z",
    }),
  ],
};

export const CONTRACT_FIXTURE_SCENARIOS: ContractScenarioFixture[] = [
  {
    scenario: "middle-views-small-history",
    child: middleHistoryChild,
    observations: [middleHistoryObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: SMALL_PERIOD,
    expected_status: "confirmed_observed",
    expected_reliability: "reliable",
    expected_excluded_reason: null,
  },
  {
    scenario: "sustained-cross-period",
    child: crossPeriodChild,
    observations: [crossPeriodObsA, crossPeriodObsB],
    item_id: ITEM.listening45,
    audience: "child_history",
    scope: SEMESTER_2026_1,
    expected_status: "no_records",
    expected_reliability: "reliable",
    expected_excluded_reason: "basis_out_of_period",
  },
  {
    scenario: "mixed-basis-valid-and-fabricated",
    child: mixedBasisChild,
    observations: [mixedBasisObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "partial",
    expected_excluded_reason: "basis_invalid",
  },
  {
    scenario: "valid-and-unconfirmed-basis",
    child: unconfirmedBasisChild,
    observations: [unconfirmedDraftObs, unconfirmedBasisObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "partial",
    expected_excluded_reason: "basis_invalid",
  },
  {
    scenario: "cross-child-basis",
    child: crossChildChild,
    observations: [crossChildObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "partial",
    expected_excluded_reason: "basis_invalid",
  },
  {
    scenario: "catalog-version-mismatch",
    child: catalogMismatchChild,
    observations: [catalogMismatchObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "partial",
    expected_excluded_reason: "catalog_mismatch",
  },
  {
    scenario: "future-suggestion-not-evidence",
    child: futureSuggestionChild,
    observations: [futureSuggestionObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "partial",
    expected_excluded_reason: "basis_invalid",
  },
  {
    scenario: "manual-link-without-ai",
    child: manualChild,
    observations: [manualObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "confirmed_observed",
    expected_reliability: "reliable",
    expected_excluded_reason: null,
  },
  {
    scenario: "adult-help-allowed-confirms-performance",
    child: adultHelpAllowedChild,
    observations: [adultHelpAllowedObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "confirmed_observed",
    expected_reliability: "reliable",
    expected_excluded_reason: null,
  },
  {
    scenario: "adult-help-requires-independence-clue-only",
    child: adultHelpRestrictedChild,
    observations: [adultHelpRestrictedObs],
    item_id: ITEM.listening34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "has_clues",
    expected_reliability: "reliable",
    expected_excluded_reason: null,
  },
  {
    scenario: "withdrawn-keeps-history",
    child: withdrawnChild,
    observations: [withdrawnObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "reliable",
    expected_excluded_reason: "withdrawn",
  },
  {
    scenario: "null-evidence-is-normal",
    child: nullEvidenceChild,
    observations: [nullEvidenceObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "reliable",
    expected_excluded_reason: null,
  },
  {
    scenario: "pending-suggestion-not-counted",
    child: pendingChild,
    observations: [pendingObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "reliable",
    expected_excluded_reason: "workflow_pending",
  },
  {
    scenario: "rejected-not-counted",
    child: rejectedChild,
    observations: [rejectedObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "no_records",
    expected_reliability: "reliable",
    expected_excluded_reason: "teacher_rejected",
  },
  {
    scenario: "unknown-stage-personal-history",
    child: unknownStageChild,
    observations: [unknownStageObs],
    item_id: ITEM.speaking34,
    audience: "child_history",
    scope: ALL_HISTORY,
    expected_status: "confirmed_observed",
    expected_reliability: "reliable",
    expected_excluded_reason: null,
  },
];

/** 反例 5 的全局观察：跨儿童引用目标 */
export const CONTRACT_FIXTURE_NEIGHBOR: FixtureChildEvidence = {
  child: neighborChild,
  observations: [neighborObs],
};

/* 反例 16：NULL 与损坏 JSON 不混为一谈 */
export const CORRUPTED_EVIDENCE_RAW = {
  invalid_json: '{"revision": 1, "links": [',
  unknown_status:
    '{"revision": 1, "links": [{"id": "fixture-link-mystery", "item_id": "item.fixture.language.speaking.2.3-4", "status": "mystery"}]}',
} as const;

const corruptedChild = fixtureChild("fixture-child-corrupted", "示例幼儿Q");
const corruptedChildObs = fixtureObservation({
  id: "fixture-obs-corrupted-readable",
  child_id: corruptedChild.id,
  observed_at: "2026-09-26",
  raw_text: "在阅读区安静翻看了图画书。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
export const CORRUPTED_CHILD_FIXTURE: FixtureChildEvidence = {
  child: corruptedChild,
  observations: [corruptedChildObs],
  corrupted_guide_evidence: [
    { observation_id: "fixture-obs-corrupted-json", raw_json: CORRUPTED_EVIDENCE_RAW.invalid_json },
    {
      observation_id: "fixture-obs-corrupted-status",
      raw_json: CORRUPTED_EVIDENCE_RAW.unknown_status,
    },
  ],
};

const unreadableChild = fixtureChild("fixture-child-unreadable", "示例幼儿R");
export const UNREADABLE_CHILD_FIXTURE: FixtureChildEvidence = {
  child: unreadableChild,
  observations: [],
  corrupted_guide_evidence: [
    { observation_id: "fixture-obs-unreadable", raw_json: CORRUPTED_EVIDENCE_RAW.invalid_json },
  ],
};

export interface Class20Fixture {
  klass: {
    id: string;
    name: string;
    stage: "middle";
    school_year: string;
    is_active: boolean;
  };
  item_id: string;
  children: FixtureChildEvidence[];
  /** 期望分布：6 人已确认观察到、4 人已有相关线索、10 人暂无相关记录 */
  expected_counts: { confirmed_observed: number; has_clues: number; no_records: number };
}

const CLASS_20_SIZE = 20;

/**
 * 班级 20 人 fixture：同一目标条目上 6 表现 / 4 线索 / 10 无记录。
 * - 第 1 位儿童跨两条观察各有一条表现关联，用于验证按儿童去重；
 * - 第 20 位儿童带一条 AI 待核对建议，不计入任何正式人数，也不改变“无记录”判定；
 * - 第 19 位儿童为 NULL 旧记录（正常未关联，不是损坏）。
 */
export const CLASS_20_FIXTURE: Class20Fixture = {
  klass: {
    id: "fixture-class-20",
    name: "示例中二班",
    stage: "middle",
    school_year: "2026-2027",
    is_active: true,
  },
  item_id: ITEM.speaking34,
  children: Array.from({ length: CLASS_20_SIZE }, (_, index) => {
    const serial = String(index + 1).padStart(2, "0");
    const child = fixtureChild(`fixture-class20-child-${serial}`, `示例幼儿${serial}`);
    const observedAt = `2026-09-${String(index + 1).padStart(2, "0")}`;
    const quote = `示例观察 ${serial}：幼儿在游戏后向教师描述自己刚才的活动`;
    const observation = fixtureObservation({
      id: `fixture-class20-obs-${serial}`,
      child_id: child.id,
      observed_at: observedAt,
      raw_text: `${quote}。`,
      class_context: FIXTURE_CLASS_CONTEXT,
      guide_evidence: null,
    });
    const extraObservation =
      index === 0
        ? fixtureObservation({
            id: `fixture-class20-obs-${serial}-b`,
            child_id: child.id,
            observed_at: `2026-09-${String(index + 2).padStart(2, "0")}`,
            raw_text: `示例观察 ${serial}B：幼儿再次向教师描述自己的活动。`,
            class_context: FIXTURE_CLASS_CONTEXT,
            guide_evidence: null,
          })
        : null;
    if (index < 6) {
      observation.guide_evidence = {
        revision: 2,
        links: [
          fixtureLink({
            id: `fixture-class20-link-${serial}`,
            item_id: ITEM.speaking34,
            status: "confirmed_performance",
            support: "single_event",
            basis: [fixtureBasis(observation, quote)],
            created_at: `${observedAt}T04:00:00.000Z`,
            decided_at: `${observedAt}T05:00:00.000Z`,
          }),
        ],
      };
      if (extraObservation) {
        extraObservation.guide_evidence = {
          revision: 2,
          links: [
            fixtureLink({
              id: `fixture-class20-link-${serial}-b`,
              item_id: ITEM.speaking34,
              status: "confirmed_performance",
              support: "single_event",
              basis: [fixtureBasis(extraObservation, `示例观察 ${serial}B：幼儿再次向教师描述自己的活动`)],
              created_at: `${extraObservation.observed_at}T04:00:00.000Z`,
              decided_at: `${extraObservation.observed_at}T05:00:00.000Z`,
            }),
          ],
        };
      }
    } else if (index < 10) {
      observation.guide_evidence = {
        revision: 2,
        links: [
          fixtureLink({
            id: `fixture-class20-link-${serial}`,
            item_id: ITEM.speaking34,
            status: "confirmed_clue",
            support: "clue_only",
            basis: [fixtureBasis(observation, quote)],
            created_at: `${observedAt}T04:00:00.000Z`,
            decided_at: `${observedAt}T05:00:00.000Z`,
          }),
        ],
      };
    } else if (index === CLASS_20_SIZE - 1) {
      observation.guide_evidence = {
        revision: 1,
        links: [
          fixtureLink({
            id: `fixture-class20-link-${serial}`,
            item_id: ITEM.speaking34,
            status: "ai_suggested",
            support: null,
            basis: [fixtureBasis(observation, quote)],
            ai_reason: "契约 fixture：待核对建议不影响正式状态。",
            created_at: `${observedAt}T04:00:00.000Z`,
            decided_at: null,
          }),
        ],
      };
    }
    return {
      child,
      observations: extraObservation ? [observation, extraObservation] : [observation],
    };
  }),
  expected_counts: { confirmed_observed: 6, has_clues: 4, no_records: 10 },
};

/* 操作契约 fixture：一次归档 + 选中关联（结构示意，不调用任何接口） */
export const CONTRACT_FIXTURE_CONFIRM_REQUEST: GuideEvidenceConfirmRequest = {
  action: "confirm",
  expected_guide_revision: 1,
  decisions: [
    {
      link_id: "fixture-link-pending",
      support: "single_event",
      basis: [
        {
          observation_id: "fixture-obs-pending",
          quote: "对同伴说「你先做饭，我来喂娃娃」",
          quote_source: "raw_text",
          quote_field: null,
        },
      ],
      teacher_note: "教师核对后确认。",
    },
    {
      item_id: ITEM.speaking34,
      support: "clue_only",
      basis: [
        {
          observation_id: "fixture-obs-null-evidence",
          quote: "在户外活动中反复练习双脚跳",
          quote_source: "raw_text",
        },
      ],
      teacher_note: "手动补关联。",
    },
  ],
};

export const CONTRACT_FIXTURE_CONFIRM_OBSERVATION_EXTENSION: ObservationConfirmGuideExtension = {
  guide_decisions: {
    expected_guide_revision: 1,
    decisions: [
      {
        item_id: ITEM.speaking34,
        support: "single_event",
        basis: [
          {
            observation_id: "fixture-obs-pending",
            quote: "对同伴说「你先做饭，我来喂娃娃」",
            quote_source: "raw_text",
          },
        ],
      },
    ],
  },
};

export const CONTRACT_FIXTURE_STALE_OPERATION = {
  expected_guide_revision: 1,
  current_guide_revision: 2,
} as const;
