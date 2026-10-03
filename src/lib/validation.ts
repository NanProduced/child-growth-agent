import { z } from "zod";
import { parseIsoDateStrict } from "./format";
import {
  GUIDE_EVIDENCE_QUOTE_FIELDS,
  GUIDE_EVIDENCE_QUOTE_SOURCES,
  GUIDE_EVIDENCE_SUPPORT_KINDS,
} from "./guide/types";
import { CLASS_STAGES, FIVE_DOMAINS } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHOOL_YEAR_RE = /^\d{4}-\d{4}$/;

/**
 * 发展性内容的最终守门词；raw_text 原文不经过此校验。
 * 只列明确的诊断、评分、排名与能力定性词：普通情绪描述（如“入园焦虑”）不在其中。
 */
export const DEVELOPMENT_FORBIDDEN_TERMS = [
  "自闭症",
  "多动症",
  "注意力缺陷",
  "焦虑症",
  "抑郁症",
  "焦虑障碍",
  "抑郁障碍",
  "情绪障碍",
  "智商",
  "智力低下",
  "智力障碍",
  "诊断",
  "确诊",
  "评分",
  "得分",
  "分数",
  "打分",
  "排名",
  "评级",
  "等级",
  "领先",
  "落后",
  "能力差",
  "注意力不集中",
  "发展落后",
  "发育落后",
  "同龄比较",
  "同龄人比较",
] as const;

/** 诊断性语境：普通情绪词单独出现不拦，形成“诊断为…/患有…症”等结论时拦截 */
const DIAGNOSTIC_CONTEXT_RULES: { label: string; pattern: RegExp }[] = [
  {
    label: "诊断性结论",
    pattern: /(诊断|确诊|患有|疑似|属于)[^。；\n]{0,16}(焦虑|抑郁|障碍|症|缺陷|疾病|异常)/,
  },
  {
    label: "能力定性",
    pattern: /(能力|发展|发育)[^。；\n]{0,6}(不足|迟缓|异常|缺陷|低下)/,
  },
];

export function findDevelopmentForbiddenTerm(value: unknown): string | undefined {
  const text = JSON.stringify(value) ?? "";
  const term = DEVELOPMENT_FORBIDDEN_TERMS.find((item) => text.includes(item));
  if (term) return term;
  return DIAGNOSTIC_CONTEXT_RULES.find((rule) => rule.pattern.test(text))?.label;
}

/** 引文格式处理：只去首尾空白与一层成对引号，不改写其他字符 */
export function normalizeQuoteForEvidence(value: string): string {
  let quote = value.trim();
  const pairs: Array<[string, string]> = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ["‘", "’"],
    ['"', '"'],
    ["'", "'"],
    ["《", "》"],
  ];
  for (const [open, close] of pairs) {
    if (quote.startsWith(open) && quote.endsWith(close) && quote.length > open.length + close.length) {
      quote = quote.slice(open.length, quote.length - close.length).trim();
      break;
    }
  }
  return quote;
}

/**
 * 引文必须真实出现在 raw_text 中。只容忍两种明确差异：一层成对引号与空白差异；
 * 其余字符必须逐字连续一致，不做模糊匹配，也不改写引文。
 */
export function isQuoteInRawText(rawText: string, quote: string): boolean {
  const normalized = normalizeQuoteForEvidence(quote);
  if (!normalized) return false;
  if (rawText.includes(normalized)) return true;
  const stripWhitespace = (value: string) => value.replace(/\s+/g, "");
  return stripWhitespace(rawText).includes(stripWhitespace(normalized));
}

/** 观察整理卡片（AI 草稿与教师确认提交体共用） */
export const observationDraftSchema = z.object({
  domain: z.enum(FIVE_DOMAINS, { message: "发展领域须为：健康、语言、社会、科学、艺术" }),
  sub_domain: z.string().min(1, "请填写子领域").max(50),
  objective_description: z.string().min(1, "请填写目标描述").max(1000),
  highlights: z.array(z.string().min(1).max(300)).min(1, "至少一条发展亮点").max(6),
  support_suggestions: z.array(z.string().min(1).max(300)).min(1, "至少一条支持建议").max(6),
  highlight_quote: z.string().min(1, "请填写原文金句").max(500),
});

export const createChildSchema = z
  .object({
    name: z.string().min(1, "请填写姓名").max(50),
    gender: z.enum(["男", "女", "其他"], { message: "请选择性别" }),
    birth_date: z
      .string()
      .min(1, "请选择出生日期")
      .regex(DATE_RE, "出生日期格式应为 YYYY-MM-DD"),
    /** 优先用 class_id 分班；class_name 只用于按名称匹配已存在的班级，不再作为唯一来源 */
    class_id: z.string().regex(UUID_RE, "班级标识不合法").optional(),
    class_name: z.string().min(1, "班级名称不能为空").max(50).optional(),
    avatar_emoji: z.string().max(16).optional(),
    note: z.string().max(2000).optional(),
  })
  .refine((value) => Boolean(value.class_id || value.class_name), {
    message: "请选择班级：提交 class_id，或填写已存在的班级名称",
  });

export const createClassSchema = z.object({
  name: z.string().min(1, "请填写班级名称").max(50, "班级名称最长 50 字"),
  stage: z.enum(CLASS_STAGES, { message: "学段须为 small（小班）/ middle（中班）/ large（大班）" }),
  school_year: z
    .string()
    .min(1, "请填写学年")
    .regex(SCHOOL_YEAR_RE, "学年格式应为 2026-2027"),
  is_active: z.boolean().optional().default(true),
});

export const updateClassSchema = createClassSchema.partial();

export const enrollChildSchema = z.object({
  child_id: z.string().regex(UUID_RE, "幼儿标识不合法"),
  start_date: z
    .string()
    .regex(DATE_RE, "分班日期格式应为 YYYY-MM-DD")
    .optional(),
});

export const createObservationSchema = z.object({
  child_id: z.string().regex(UUID_RE, "幼儿标识不合法"),
  observed_at: z
    .string()
    .regex(DATE_RE, "观察日期格式应为 YYYY-MM-DD")
    .refine((value) => parseIsoDateStrict(value) !== null, "观察日期不是真实存在的日历日期"),
  context: z.string().max(200).nullish(),
  raw_text: z.string().min(10, "观察原文至少 10 个字").max(5000, "观察原文最长 5000 字"),
  /** 分班历史无法确定发生时班级时，教师在此确认当时班级 id；快照由服务端核实生成 */
  confirmed_class_id: z.string().regex(UUID_RE, "班级标识不合法").optional(),
});

export const followUpDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("ask"),
    question: z.string().min(1, "追问内容不能为空").max(300),
    reason: z.string().min(1, "追问原因不能为空").max(500),
  }),
  z.object({
    decision: z.literal("proceed"),
    question: z.string().max(300),
    reason: z.string().min(1, "判断原因不能为空").max(500),
  }),
]);

export const followUpActionSchema = z
  .object({
    action: z.enum(["answer", "skip", "stop"]),
    content: z.string().max(2000).optional().default(""),
  })
  .superRefine((value, ctx) => {
    if (value.action === "answer" && !value.content.trim()) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "请填写补充信息，或选择跳过/停止追问" });
    }
  });

export const teacherEditReviewSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("accept"),
    summary: z.string().min(1, "审核说明不能为空").max(500),
    change_summary: z.array(z.string().min(1).max(300)).max(6),
    fact_check: z.enum(["supported", "partially_supported"]),
    question: z.literal(""),
  }),
  z.object({
    decision: z.literal("clarify"),
    summary: z.string().min(1, "审核说明不能为空").max(500),
    change_summary: z.array(z.string().min(1).max(300)).max(6),
    fact_check: z.enum(["supported", "partially_supported", "unsupported"]),
    question: z.string().min(1, "澄清问题不能为空").max(500),
  }),
]);

export const growthProfileSchema = z
  .object({
    summary: z.string().min(1, "成长小结不能为空").max(1200),
    recent_change: z.string().min(1, "最近变化不能为空").max(800),
    development_clues: z.array(z.string().min(1).max(300)).min(1).max(6),
    next_support: z.string().min(1, "下一步支持不能为空").max(800),
    next_focus: z.string().min(1, "下一次观察重点不能为空").max(500),
  })
  .strict();

const activitySupportSuggestionSchema = z
  .object({
    title: z.string().min(1, "活动名称不能为空").max(120),
    purpose: z.string().min(1, "支持意图不能为空").max(500),
    steps: z.array(z.string().min(1).max(300)).min(2).max(4),
    materials: z.array(z.string().min(1).max(100)).max(8),
    observe: z.string().min(1, "观察提示不能为空").max(500),
    adaptation: z.string().min(1, "调整方式不能为空").max(500),
    evidence: z.array(z.string().min(1).max(300)).min(1).max(4),
    /** 服务端引用核对后写入的已确认观察 id；旧建议没有此字段 */
    source_observation_ids: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const activitySupportDraftSchema = z
  .object({
    suggestions: z.array(activitySupportSuggestionSchema).min(2).max(3),
  })
  .strict();

export const activitySupportSchema = activitySupportDraftSchema
  .extend({
    source_observation_ids: z.array(z.string().min(1)).min(1),
    ai_model: z.string().min(1).max(100),
    generated_at: z.string().min(1).max(100),
  })
  .strict();

/* ------------------------- 指南证据关联（G5） ------------------------- */

const evidenceDate = z
  .string()
  .regex(DATE_RE, "日期格式应为 YYYY-MM-DD")
  .refine((value) => parseIsoDateStrict(value) !== null, "日期不是真实存在的日历日期");

/** 依据输入：只提交来源定位与片段；observed_at / 班级快照 / 版本一律由服务端读取生成 */
export const guideEvidenceBasisInputSchema = z.object({
  observation_id: z.string().min(1).max(64),
  quote: z.string().min(1).max(500),
  quote_source: z.enum(GUIDE_EVIDENCE_QUOTE_SOURCES),
  quote_field: z.enum(GUIDE_EVIDENCE_QUOTE_FIELDS).nullish(),
});

export const guideEvidencePeriodNoteSchema = z.object({
  period_start: evidenceDate,
  period_end: evidenceDate,
  description: z.string().min(10, "连续观察纪要说明至少 10 字").max(500),
});

const guideDecisionCommon = {
  support: z.enum(GUIDE_EVIDENCE_SUPPORT_KINDS),
  basis: z.array(guideEvidenceBasisInputSchema).min(1, "教师决定至少需要一条依据").max(10),
  sustained_note: guideEvidencePeriodNoteSchema.nullish(),
  adult_help_used: z.boolean().optional(),
  teacher_note: z.string().max(500).optional(),
};

export const guideEvidenceLinkDecisionSchema = z
  .object({
    link_id: z.string().min(1).max(64),
    ...guideDecisionCommon,
  })
  .strict();

export const guideEvidenceManualDecisionSchema = z
  .object({
    item_id: z.string().min(1).max(200),
    ...guideDecisionCommon,
  })
  .strict();

export const guideEvidenceDecisionSchema = z.union([
  guideEvidenceLinkDecisionSchema,
  guideEvidenceManualDecisionSchema,
]);

export const guideEvidenceMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("suggest") }),
  z.object({
    action: z.literal("confirm"),
    expected_guide_revision: z.number().int().min(0),
    decisions: z.array(guideEvidenceDecisionSchema).min(1).max(20),
  }),
  z.object({
    action: z.literal("reject"),
    link_id: z.string().min(1).max(64),
    expected_guide_revision: z.number().int().min(0),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal("withdraw"),
    link_id: z.string().min(1).max(64),
    expected_guide_revision: z.number().int().min(0),
    reason: z.string().max(500).optional(),
  }),
]);

export const confirmObservationSchema = z.object({
  content: observationDraftSchema,
  teacher_note: z.string().max(500).optional(),
  /** 教师对审核 clarify 问题的补充回答；只在存在待澄清审核时使用 */
  clarification: z.string().max(2000).optional(),
  /** 指南证据关联决定：与归档在同一事务协调生效（G5，可选） */
  guide_decisions: z
    .object({
      expected_guide_revision: z.number().int().min(0),
      decisions: z.array(guideEvidenceDecisionSchema).min(1).max(20),
    })
    .optional(),
});

export type ConfirmObservationInput = z.infer<typeof confirmObservationSchema>;

export type GuideEvidenceBasisInputParsed = z.infer<typeof guideEvidenceBasisInputSchema>;
export type GuideEvidencePeriodNoteParsed = z.infer<typeof guideEvidencePeriodNoteSchema>;
export type GuideEvidenceDecisionParsed = z.infer<typeof guideEvidenceDecisionSchema>;
export type GuideEvidenceMutationParsed = z.infer<typeof guideEvidenceMutationSchema>;
export type GuideDecisionsParsed = z.infer<
  NonNullable<ConfirmObservationInput["guide_decisions"]>
>;
