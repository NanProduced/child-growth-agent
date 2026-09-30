import { z } from "zod";
import { FIVE_DOMAINS } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 观察整理卡片（AI 草稿与教师确认提交体共用） */
export const observationDraftSchema = z.object({
  domain: z.enum(FIVE_DOMAINS, { message: "发展领域须为：健康、语言、社会、科学、艺术" }),
  sub_domain: z.string().min(1, "请填写子领域").max(50),
  objective_description: z.string().min(1, "请填写目标描述").max(1000),
  highlights: z.array(z.string().min(1).max(300)).min(1, "至少一条发展亮点").max(6),
  support_suggestions: z.array(z.string().min(1).max(300)).min(1, "至少一条支持建议").max(6),
  highlight_quote: z.string().min(1, "请填写原文金句").max(500),
});

export const createChildSchema = z.object({
  name: z.string().min(1, "请填写姓名").max(50),
  gender: z.enum(["男", "女", "其他"], { message: "请选择性别" }),
  birth_date: z
    .string()
    .min(1, "请选择出生日期")
    .regex(DATE_RE, "出生日期格式应为 YYYY-MM-DD"),
  class_name: z.string().min(1).max(50).default("向日葵班"),
  avatar_emoji: z.string().max(16).optional(),
  note: z.string().max(2000).optional(),
});

export const createObservationSchema = z.object({
  child_id: z.string().regex(UUID_RE, "幼儿标识不合法"),
  observed_at: z.string().regex(DATE_RE, "观察日期格式应为 YYYY-MM-DD"),
  context: z.string().max(200).nullish(),
  raw_text: z.string().min(10, "观察原文至少 10 个字").max(5000, "观察原文最长 5000 字"),
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

export const confirmObservationSchema = z.object({
  content: observationDraftSchema,
  teacher_note: z.string().max(500).optional(),
});

export type ConfirmObservationInput = z.infer<typeof confirmObservationSchema>;
