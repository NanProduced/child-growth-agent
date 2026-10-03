import type { Observation, ObservationDraft } from "@/lib/types";
import type {
  GuideCatalog,
  GuideEducationSuggestion,
  GuideEvidenceBasis,
  GuideEvidenceLink,
  GuideEvidenceLinkStatus,
  GuideEvidenceSupportKind,
  GuideSourceLocation,
  ObservationClassContextSnapshot,
  ObservationGuideEvidence,
} from "../types";
import type { EvidenceChildRef, GuideItemEvidenceStatus } from "../view-types";

/**
 * G0 契约 fixture：只用于离线类型与状态规则检查。
 * - 不写数据库、不调用模型、不代表真实 LLM 结果；
 * - 目录内容是最小示意，不是《指南》正式目录（正式目录由 G1 提供）；
 * - 全部姓名为合成示例，child_id 以 fixture- 前缀标明。
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
} as const;

export const FIXTURE_GOAL_ID = {
  listening: "goal.fixture.language.1",
  speaking: "goal.fixture.language.2",
} as const;

/** 两个目标、三个表现条目：用于证明“综合目标数 ≠ 表现条目数” */
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
                },
                {
                  id: FIXTURE_ITEM_ID.listening45,
                  domain_id: "dom.fixture.language",
                  sub_domain_id: "sub.fixture.language.listen_speak",
                  goal_id: FIXTURE_GOAL_ID.listening,
                  age_band: "4-5",
                  text: "能听懂并愿意回应日常交谈中的问题（fixture 摘要）。",
                  source: FIXTURE_SOURCE,
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
];

export const FIXTURE_CLASS_CONTEXT: ObservationClassContextSnapshot = {
  class_id: "fixture-class-1",
  class_name: "示例中一班",
  stage: "middle",
  school_year: "2026-2027",
  captured_at: "2026-09-01T00:00:00.000Z",
};

const FIXTURE_CONFIRMED_CONTENT: ObservationDraft = {
  domain: "语言",
  sub_domain: "倾听与表达",
  objective_description: "fixture 使用的确认稿占位内容。",
  highlights: ["fixture 占位亮点"],
  support_suggestions: ["fixture 占位支持建议"],
  highlight_quote: "fixture 占位",
};

/** 契约检查用观察：confirmed 状态 + 两个新增可选 JSONB 字段 */
export interface FixtureObservation extends Observation {
  class_context_snapshot: ObservationClassContextSnapshot | null;
  guide_evidence: ObservationGuideEvidence | null;
}

export interface FixtureChildEvidence {
  child: EvidenceChildRef;
  observations: FixtureObservation[];
}

export interface ContractScenarioFixture extends FixtureChildEvidence {
  /** 场景针对的目录条目 id */
  item_id: string;
  /** 契约要求的状态计算结果（由 check 脚本按冻结规则核对） */
  expected_status: GuideItemEvidenceStatus;
}

function fixtureObservation(input: {
  id: string;
  child_id: string;
  observed_at: string;
  raw_text: string;
  class_context: ObservationClassContextSnapshot | null;
  guide_evidence: ObservationGuideEvidence | null;
}): FixtureObservation {
  return {
    id: input.id,
    child_id: input.child_id,
    class_id: input.class_context?.class_id ?? null,
    observed_class: null,
    observed_at: input.observed_at,
    context: "区域活动",
    raw_text: input.raw_text,
    status: "confirmed",
    agent_context: null,
    ai_draft: null,
    ai_model: "offline-fixture",
    ai_organized_at: `${input.observed_at}T02:00:00.000Z`,
    confirmed_content: FIXTURE_CONFIRMED_CONTENT,
    confirmed_at: `${input.observed_at}T03:00:00.000Z`,
    is_demo: true,
    created_at: `${input.observed_at}T02:30:00.000Z`,
    updated_at: null,
    class_context_snapshot: input.class_context,
    guide_evidence: input.guide_evidence,
  };
}

function fixtureBasis(observation: FixtureObservation, quote: string): GuideEvidenceBasis {
  return {
    observation_id: observation.id,
    observed_at: observation.observed_at,
    quote,
    quote_source: "raw_text",
    class_context: observation.class_context_snapshot,
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
  ai_reason?: string | null;
  teacher_note?: string | null;
  withdrawn_at?: string | null;
  withdrawn_reason?: string | null;
}): GuideEvidenceLink {
  return {
    catalog_version: CONTRACT_FIXTURE_CATALOG_VERSION,
    ai_reason: input.ai_reason ?? null,
    teacher_note: input.teacher_note ?? null,
    withdrawn_at: input.withdrawn_at ?? null,
    withdrawn_reason: input.withdrawn_reason ?? null,
    ...input,
  };
}

function fixtureChild(id: string, name: string): EvidenceChildRef {
  return {
    id,
    name,
    birth_date: "2021-05-01",
    class_id: FIXTURE_CLASS_CONTEXT.class_id,
    class_name: FIXTURE_CLASS_CONTEXT.class_name,
    stage: "middle",
  };
}

const ITEM = FIXTURE_ITEM_ID;

/* 场景一：已确认观察到（跨日两条充分证据支持持续性表现） */
const observedChild = fixtureChild("fixture-child-observed", "示例幼儿A");
const observedObsA = fixtureObservation({
  id: "fixture-obs-observed-a",
  child_id: observedChild.id,
  observed_at: "2026-09-08",
  raw_text: "早上入园时，杉杉主动对老师说「老师早上好」，还说了自己梦见了小狗。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
const observedObsB = fixtureObservation({
  id: "fixture-obs-observed-b",
  child_id: observedChild.id,
  observed_at: "2026-09-15",
  raw_text: "晨谈时杉杉举手说「我昨天和小猫玩了，它喜欢喝牛奶」。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
observedObsA.guide_evidence = {
  links: [
    fixtureLink({
      id: "fixture-link-observed",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "sustained",
      basis: [fixtureBasis(observedObsA, "杉杉主动对老师说「老师早上好」"), fixtureBasis(observedObsB, "杉杉举手说「我昨天和小猫玩了，它喜欢喝牛奶」")],
      created_at: "2026-09-08T04:00:00.000Z",
      decided_at: "2026-09-16T01:00:00.000Z",
    }),
  ],
};

/* 场景二：已有相关线索（证据只支持线索，不足以确认表现） */
const cluesChild = fixtureChild("fixture-child-clues", "示例幼儿B");
const cluesObs = fixtureObservation({
  id: "fixture-obs-clues",
  child_id: cluesChild.id,
  observed_at: "2026-09-10",
  raw_text: "珊珊看着同伴的绘本，指着画面小声说了一个词。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
cluesObs.guide_evidence = {
  links: [
    fixtureLink({
      id: "fixture-link-clues",
      item_id: ITEM.speaking34,
      status: "confirmed_clue",
      support: "clue_only",
      basis: [fixtureBasis(cluesObs, "指着画面小声说了一个词")],
      created_at: "2026-09-10T04:00:00.000Z",
      decided_at: "2026-09-10T05:00:00.000Z",
    }),
  ],
};

/* 场景三：暂无相关记录 */
const emptyChild = fixtureChild("fixture-child-empty", "示例幼儿C");
const emptyObs = fixtureObservation({
  id: "fixture-obs-empty",
  child_id: emptyChild.id,
  observed_at: "2026-09-11",
  raw_text: "在户外活动中反复练习双脚跳。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});

/* 场景四：AI 建议待核对（工作流状态，不进入正式状态） */
const pendingChild = fixtureChild("fixture-child-pending", "示例幼儿D");
const pendingObs = fixtureObservation({
  id: "fixture-obs-pending",
  child_id: pendingChild.id,
  observed_at: "2026-09-12",
  raw_text: "楠楠在娃娃家对同伴说「你先做饭，我来喂娃娃」。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
pendingObs.guide_evidence = {
  links: [
    fixtureLink({
      id: "fixture-link-pending",
      item_id: ITEM.speaking34,
      status: "ai_suggested",
      support: null,
      basis: [fixtureBasis(pendingObs, "对同伴说「你先做饭，我来喂娃娃」")],
      ai_reason: "本次出现了面向同伴的完整表达，可能与该表现相关，待教师核对。",
      created_at: "2026-09-12T04:00:00.000Z",
      decided_at: null,
    }),
  ],
};

/* 场景五：成人帮助（有成人帮助的证据只确认线索，不静默当作独立表现） */
const adultHelpChild = fixtureChild("fixture-child-adult-help", "示例幼儿E");
const adultHelpObs = fixtureObservation({
  id: "fixture-obs-adult-help",
  child_id: adultHelpChild.id,
  observed_at: "2026-09-13",
  raw_text: "在老师提醒下，涵涵把想说的话说完整：「我想玩红色的积木。」",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
adultHelpObs.guide_evidence = {
  links: [
    fixtureLink({
      id: "fixture-link-adult-help",
      item_id: ITEM.speaking34,
      status: "confirmed_clue",
      support: "clue_only",
      basis: [fixtureBasis(adultHelpObs, "在老师提醒下，涵涵把想说的话说完整")],
      teacher_note: "本次在教师提醒下完成，尚不能确认独立表现。",
      created_at: "2026-09-13T04:00:00.000Z",
      decided_at: "2026-09-13T05:00:00.000Z",
    }),
  ],
};

/* 场景六：历史班级未知（旧记录缺少班级快照，按未知展示，不补造） */
const unknownHistoryChild = fixtureChild("fixture-child-unknown-history", "示例幼儿F");
const unknownHistoryObs = fixtureObservation({
  id: "fixture-obs-unknown-history",
  child_id: unknownHistoryChild.id,
  observed_at: "2026-09-14",
  raw_text: "铭铭在集体活动后主动告诉老师「我今天搭了一个高高的桥」。",
  class_context: null,
  guide_evidence: null,
});
unknownHistoryObs.guide_evidence = {
  links: [
    fixtureLink({
      id: "fixture-link-unknown-history",
      item_id: ITEM.speaking34,
      status: "confirmed_performance",
      support: "single_event",
      basis: [fixtureBasis(unknownHistoryObs, "主动告诉老师「我今天搭了一个高高的桥」")],
      created_at: "2026-09-14T04:00:00.000Z",
      decided_at: "2026-09-14T05:00:00.000Z",
    }),
  ],
};

/* 场景七：撤回（已确认过后撤回，保留撤回信息，不再进入统计） */
const withdrawnChild = fixtureChild("fixture-child-withdrawn", "示例幼儿G");
const withdrawnObs = fixtureObservation({
  id: "fixture-obs-withdrawn",
  child_id: withdrawnChild.id,
  observed_at: "2026-09-15",
  raw_text: "然然用一句话向同伴要回了自己的水杯。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
withdrawnObs.guide_evidence = {
  links: [
    fixtureLink({
      id: "fixture-link-withdrawn",
      item_id: ITEM.speaking34,
      status: "withdrawn",
      support: "single_event",
      basis: [fixtureBasis(withdrawnObs, "用一句话向同伴要回了自己的水杯")],
      created_at: "2026-09-15T04:00:00.000Z",
      decided_at: "2026-09-15T05:00:00.000Z",
      withdrawn_at: "2026-09-18T01:00:00.000Z",
      withdrawn_reason: "复核后发现该片段无法确认指向本条表现。",
    }),
  ],
};

/* 场景八：教师不采用 AI 建议（终态，不进入统计） */
const rejectedChild = fixtureChild("fixture-child-rejected", "示例幼儿H");
const rejectedObs = fixtureObservation({
  id: "fixture-obs-rejected",
  child_id: rejectedChild.id,
  observed_at: "2026-09-16",
  raw_text: "乐乐用手指了指窗外的雨。",
  class_context: FIXTURE_CLASS_CONTEXT,
  guide_evidence: null,
});
rejectedObs.guide_evidence = {
  links: [
    fixtureLink({
      id: "fixture-link-rejected",
      item_id: ITEM.speaking34,
      status: "rejected",
      support: null,
      basis: [fixtureBasis(rejectedObs, "用手指了指窗外的雨")],
      ai_reason: "动作指向可能是表达意图，待核对。",
      created_at: "2026-09-16T04:00:00.000Z",
      decided_at: "2026-09-16T05:00:00.000Z",
    }),
  ],
};

export const CONTRACT_FIXTURE_SCENARIOS: ContractScenarioFixture[] = [
  {
    child: observedChild,
    observations: [observedObsA, observedObsB],
    item_id: ITEM.speaking34,
    expected_status: "confirmed_observed",
  },
  {
    child: cluesChild,
    observations: [cluesObs],
    item_id: ITEM.speaking34,
    expected_status: "has_clues",
  },
  {
    child: emptyChild,
    observations: [emptyObs],
    item_id: ITEM.speaking34,
    expected_status: "no_records",
  },
  {
    child: pendingChild,
    observations: [pendingObs],
    item_id: ITEM.speaking34,
    expected_status: "no_records",
  },
  {
    child: adultHelpChild,
    observations: [adultHelpObs],
    item_id: ITEM.speaking34,
    expected_status: "has_clues",
  },
  {
    child: unknownHistoryChild,
    observations: [unknownHistoryObs],
    item_id: ITEM.speaking34,
    expected_status: "confirmed_observed",
  },
  {
    child: withdrawnChild,
    observations: [withdrawnObs],
    item_id: ITEM.speaking34,
    expected_status: "no_records",
  },
  {
    child: rejectedChild,
    observations: [rejectedObs],
    item_id: ITEM.speaking34,
    expected_status: "no_records",
  },
];

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
 * 第 20 位儿童带一条 AI 待核对建议，用于证明待核对不计入“无记录”以外任何正式人数，
 * 也不会改变“无记录”判定。
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
    const observation = fixtureObservation({
      id: `fixture-class20-obs-${serial}`,
      child_id: child.id,
      observed_at: observedAt,
      raw_text: `示例观察 ${serial}：幼儿在游戏后向教师描述自己刚才的活动。`,
      class_context: FIXTURE_CLASS_CONTEXT,
      guide_evidence: null,
    });
    const quote = `示例观察 ${serial}：幼儿在游戏后向教师描述自己刚才的活动`;
    if (index < 6) {
      observation.guide_evidence = {
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
    } else if (index < 10) {
      observation.guide_evidence = {
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
    return { child, observations: [observation] };
  }),
  expected_counts: { confirmed_observed: 6, has_clues: 4, no_records: 10 },
};
