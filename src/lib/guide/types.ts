import type { ClassStage } from "@/lib/types";

/**
 * 《3—6岁儿童学习与发展指南》结构化证据链共享类型（G0-R1 契约冻结）。
 * 本文件只定义结构与口径，不包含正式目录数据；正式目录由 G1 按本文件类型提供。
 * 证据关联与发生班级快照是 observations 表上的可选 JSONB 形状：G2 负责落库，
 * G5 负责读写与状态计算；并行期间任何模块不得自行改动本文件。
 */

/** 目录版本：item_id / goal_id 在同一版本内稳定；升版不得改变已发布 id 的含义 */
export const GUIDE_CATALOG_VERSION = "moe-3-6-2012.v1";

export const GUIDE_DOMAIN_CODES = ["health", "language", "social", "science", "arts"] as const;
export type GuideDomainCode = (typeof GUIDE_DOMAIN_CODES)[number];

export const GUIDE_DOMAIN_LABELS: Record<GuideDomainCode, string> = {
  health: "健康",
  language: "语言",
  social: "社会",
  science: "科学",
  arts: "艺术",
};

/** 年龄段只用于参考阅读与筛选，不是达标期限，也不构成统一门槛 */
export const GUIDE_AGE_BANDS = ["3-4", "4-5", "5-6"] as const;
export type GuideAgeBand = (typeof GUIDE_AGE_BANDS)[number];

export const GUIDE_AGE_BAND_LABELS: Record<GuideAgeBand, string> = {
  "3-4": "3～4岁",
  "4-5": "4～5岁",
  "5-6": "5～6岁",
};

/** 目录元素在指南原文中的位置，用于核对与“来源位置”展示 */
export interface GuideSourceLocation {
  /** 依据文件全名，例如《3—6岁儿童学习与发展指南》 */
  document: string;
  publisher: string;
  published_year: number;
  /** 章节路径，例如：健康领域 · 动作发展 · 目标1 · 5～6岁 */
  section: string;
  url?: string;
}

/*
 * 产品规则元数据（芽芽观察自建的展示/统计口径标注，不是《指南》官方新增标准）。
 * 只表达“如何呈现与统计证据”，不改写、不补充指南原文。
 */

export const GUIDE_ITEM_EVIDENCE_TYPES = ["behavior", "sustained", "health_reference"] as const;
export type GuideItemEvidenceType = (typeof GUIDE_ITEM_EVIDENCE_TYPES)[number];

/**
 * 成人帮助条件：
 * - allowed：说明帮助方式后，可以帮助下的充分证据确认表现；
 * - requires_independence：该条目要求独立完成，有成人帮助时只能确认线索。
 */
export const GUIDE_ADULT_HELP_POLICIES = ["allowed", "requires_independence"] as const;
export type GuideAdultHelpPolicy = (typeof GUIDE_ADULT_HELP_POLICIES)[number];

export interface GuideItemProductRules {
  evidence_type: GuideItemEvidenceType;
  /** 是否参与行为类正式统计；保健参考类条目为 false */
  counts_in_behavior_stats: boolean;
  adult_help: GuideAdultHelpPolicy;
}

/**
 * 指南目录：领域 → 子领域 → 目标 → 年龄段 → 具体表现条目。
 * 综合目标与具体表现条目是两级不同粒度：全指南共 32 个综合目标，
 * 具体表现条目按三个年龄段分别列出、数量远多于 32，禁止把两者等价换算。
 */
export interface GuideCatalog {
  version: string;
  source: GuideSourceLocation;
  domains: GuideDomain[];
}

export interface GuideDomain {
  id: string;
  code: GuideDomainCode;
  name: string;
  source: GuideSourceLocation;
  sub_domains: GuideSubDomain[];
}

export interface GuideSubDomain {
  id: string;
  domain_id: string;
  name: string;
  source: GuideSourceLocation;
  goals: GuideGoal[];
}

export interface GuideGoal {
  id: string;
  domain_id: string;
  sub_domain_id: string;
  /** 指南内序号（1 起），仅用于展示与定位 */
  index: number;
  title: string;
  source: GuideSourceLocation;
  items: GuidePerformanceItem[];
}

/** 具体表现条目：证据关联的最小对象，不对应整个目标或领域 */
export interface GuidePerformanceItem {
  id: string;
  domain_id: string;
  sub_domain_id: string;
  goal_id: string;
  age_band: GuideAgeBand;
  /** 完整原文，逐字保存，不做改写 */
  text: string;
  source: GuideSourceLocation;
  product_rules: GuideItemProductRules;
}

/** 教育建议：独立保存，按 goal_id 关联目标；不随表现条目拆分 */
export interface GuideEducationSuggestion {
  id: string;
  goal_id: string;
  /** 完整原文，逐字保存 */
  text: string;
  source: GuideSourceLocation;
}

export interface GuideDomainRef {
  id: string;
  code: GuideDomainCode;
  name: string;
}

export interface GuideSubDomainRef {
  id: string;
  domain_id: string;
  name: string;
}

export interface GuideGoalRef {
  id: string;
  domain_id: string;
  sub_domain_id: string;
  index: number;
  title: string;
}

/** getGuideItem 的返回：条目 + 定位链 + 目标级教育建议 */
export interface GuideItemDetail {
  item: GuidePerformanceItem;
  goal: GuideGoalRef;
  sub_domain: GuideSubDomainRef;
  domain: GuideDomainRef;
  education_suggestions: GuideEducationSuggestion[];
}

/** listGuideItems 的筛选范围；缺省返回当前目录全部条目 */
export interface GuideItemFilter {
  domain_code?: GuideDomainCode;
  sub_domain_id?: string;
  goal_id?: string;
  age_band?: GuideAgeBand;
}

/**
 * 学期：起止日期必须来自显式配置（G2 提供配置模块），不得从日期或班级学年推断。
 * 统计期间含首尾两天；时区语义统一为亚洲/上海日历日。
 */
export interface SemesterPeriod {
  id: string;
  school_year: string;
  term: 1 | 2;
  label: string;
  /** 含首尾，YYYY-MM-DD */
  start_date: string;
  end_date: string;
}

export const GUIDE_CLASS_SNAPSHOT_SOURCES = [
  "enrollment_lookup",
  "teacher_confirmed",
  "legacy_import",
] as const;
export type GuideClassSnapshotSource = (typeof GUIDE_CLASS_SNAPSHOT_SOURCES)[number];

/**
 * observations.class_context_snapshot（G2 新增可选 JSONB）：
 * 观察发生时班级信息的独立快照，班级改名、停用或当前学段变更后历史来源仍稳定。
 * 旧记录为 null 表示历史班级未知：按未知展示，不得用当前班级或动态 classes.stage 回填。
 * source / enrollment_id / confirmed_at 用于表达快照的解析与确认来源（产品元数据）。
 */
export interface ObservationClassContextSnapshot {
  class_id: string;
  class_name: string;
  stage: ClassStage;
  school_year: string;
  /** 快照写入时间（ISO 时间戳） */
  captured_at: string;
  source: GuideClassSnapshotSource;
  /** 分班历史解析依据的归属记录 id（source=enrollment_lookup 时） */
  enrollment_id?: string | null;
  /** 教师确认时间（source=teacher_confirmed 时） */
  confirmed_at?: string | null;
}

export const GUIDE_EVIDENCE_LINK_STATUSES = [
  "ai_suggested",
  "confirmed_performance",
  "confirmed_clue",
  "rejected",
  "withdrawn",
] as const;
export type GuideEvidenceLinkStatus = (typeof GUIDE_EVIDENCE_LINK_STATUSES)[number];

/** 关联来源：AI 建议或教师手动建立（不依赖先调用模型） */
export const GUIDE_EVIDENCE_LINK_ORIGINS = ["ai", "manual"] as const;
export type GuideEvidenceLinkOrigin = (typeof GUIDE_EVIDENCE_LINK_ORIGINS)[number];

/**
 * 支持条件：
 * - single_event：单次行为，一条充分证据即可确认“表现”；
 * - sustained：持续性表现，需跨日证据或明确期间、事实依据的连续观察纪要；
 * - clue_only：证据只支持“相关线索”，不足以确认具体表现。
 * 不设“满三次自动掌握”等统一门槛，由教师依据证据决定。
 */
export const GUIDE_EVIDENCE_SUPPORT_KINDS = ["single_event", "sustained", "clue_only"] as const;
export type GuideEvidenceSupportKind = (typeof GUIDE_EVIDENCE_SUPPORT_KINDS)[number];

/** 来源片段出处：raw_text 永不改写；confirmed_content 为教师确认稿 */
export const GUIDE_EVIDENCE_QUOTE_SOURCES = ["raw_text", "confirmed_content"] as const;
export type GuideEvidenceQuoteSource = (typeof GUIDE_EVIDENCE_QUOTE_SOURCES)[number];

/**
 * confirmed_content 中允许作为事实证据的明确位置；
 * objective_description、support_suggestions、teacher_note 等解释或未来建议不可引用。
 */
export const GUIDE_EVIDENCE_QUOTE_FIELDS = ["highlight_quote", "highlights"] as const;
export type GuideEvidenceQuoteField = (typeof GUIDE_EVIDENCE_QUOTE_FIELDS)[number];

/** 连续观察纪要：必须有明确期间与事实说明，不能只靠任意备注字符串 */
export interface GuideEvidencePeriodNote {
  /** 含首尾，YYYY-MM-DD */
  period_start: string;
  period_end: string;
  /** 期间内连续观察到的事实说明（不少于 10 字） */
  description: string;
}

/**
 * 单条依据快照：来源观察、片段与发生时班级。写入后不再随观察后续变化重算。
 * 有效性由服务端逐条核对：来源存在、同一儿童、已确认、片段可核对、版本一致。
 * 任一条必需依据失效，整条关联不得继续支持正式状态（禁止“一条有效即通过”）。
 */
export interface GuideEvidenceBasis {
  observation_id: string;
  /** 观察发生日期（YYYY-MM-DD）；筛选与统计一律以它为时间轴 */
  observed_at: string;
  quote: string;
  quote_source: GuideEvidenceQuoteSource;
  /** confirmed_content 时必须声明事实位置；raw_text 时为 null */
  quote_field: GuideEvidenceQuoteField | null;
  /** 发生时班级快照；历史未知时为 null，不补造、不用动态 classes.stage 回填 */
  class_context: ObservationClassContextSnapshot | null;
  /**
   * 依据版本：决定时来源观察的 confirmed_at；用于检测片段仍在但来源事实已变化。
   * AI 建议可为 null，教师确认时必须写入并与来源当前值一致。
   */
  source_confirmed_at: string | null;
}

/**
 * 证据关联：存放在 observations.guide_evidence.links 中。
 * 状态机（单向；终态需重新手动关联或重新建议产生新关联）：
 * ai_suggested → confirmed_performance | confirmed_clue | rejected
 * confirmed_performance | confirmed_clue → 可互改，或 → withdrawn
 * rejected / withdrawn 为终态。
 * withdrawn 保留撤回前的 support 与依据（审计）；rejected / ai_suggested 的 support 为 null。
 * revision 在每次状态或内容变化时 +1，用于重复提交与过期操作检测。
 */
export interface GuideEvidenceLink {
  id: string;
  item_id: string;
  catalog_version: string;
  origin: GuideEvidenceLinkOrigin;
  status: GuideEvidenceLinkStatus;
  support: GuideEvidenceSupportKind | null;
  /** 持续性表现的连续观察纪要（support=sustained 时可用） */
  sustained_note?: GuideEvidencePeriodNote | null;
  /** 本次决定是否使用了成人帮助；用于成人帮助条件的服务端校验与展示 */
  adult_help_used: boolean;
  basis: GuideEvidenceBasis[];
  /** AI 建议理由（status=ai_suggested 时供教师核对） */
  ai_reason?: string | null;
  /** 教师决定备注（例如说明成人帮助方式） */
  teacher_note?: string | null;
  revision: number;
  created_at: string;
  /** 教师做出确认/拒绝决定的时间；仍在待核对时为 null */
  decided_at: string | null;
  withdrawn_at?: string | null;
  withdrawn_reason?: string | null;
}

/** 最近一次 AI 关联尝试的元数据；不保存模型原始输出 */
export interface GuideEvidenceAiAttempt {
  at: string;
  model: string;
  ok: boolean;
  suggested_count: number;
  error?: string | null;
}

/**
 * observations.guide_evidence（G2 新增可选 JSONB）。
 * revision 为容器修订号：每次写入 +1；旧记录缺失时按 0 处理，不补造。
 * 字段缺失或结构不可解析时按“无关联/损坏”安全处理；NULL 是正常未关联，两者不得混同。
 */
export interface ObservationGuideEvidence {
  revision: number;
  links: GuideEvidenceLink[];
  last_attempt?: GuideEvidenceAiAttempt | null;
}
