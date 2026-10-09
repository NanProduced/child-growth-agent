import { z } from "zod";
import { parseIsoDateStrict } from "./format";
import { CONFIGURED_SEMESTERS } from "./semester/config";

export const MAX_COMMUNICATION_SOURCES = 60;
const id = z.string().uuid();
const date = z.string().refine((value) => parseIsoDateStrict(value) !== null, "日期不正确");
export const communicationPeriodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("month"), value: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict(),
  z.object({ kind: z.literal("semester"), value: z.string().min(1).max(40) }).strict(),
  z.object({ kind: z.literal("year") }).strict(),
]);
export type CommunicationPeriod = z.infer<typeof communicationPeriodSchema>;
export type CommunicationRange = { from: string; to: string; label: string };

export function resolveCommunicationRange(period: CommunicationPeriod, today: string): CommunicationRange {
  if (!parseIsoDateStrict(today)) throw new Error("当前日期无法核对");
  let from: string, to: string, label: string;
  if (period.kind === "month") {
    from = `${period.value}-01`;
    const [year, month] = period.value.split("-").map(Number);
    to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    label = `${year}年${month}月`;
  } else if (period.kind === "semester") {
    const semester = CONFIGURED_SEMESTERS.find((item) => item.id === period.value);
    if (!semester) throw new Error("没有找到这个学期，请重新选择");
    from = semester.start_date; to = semester.end_date; label = semester.label;
  } else {
    const [year, month, day] = today.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
    const start = new Date(Date.UTC(year - 1, month - 1, Math.min(day, lastDay)));
    start.setUTCDate(start.getUTCDate() + 1);
    from = start.toISOString().slice(0, 10); to = today; label = "近一年";
  }
  if (from > today || !parseIsoDateStrict(from)) throw new Error("请选择已经开始的时间段");
  if (to > today) { to = today; label += "（截至今天）"; }
  return { from, to, label };
}

export function previousCommunicationMonth(today: string): string {
  const [year, month] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

export const createCommunicationSchema = z.object({
  client_request_id: id, child_id: id, period: communicationPeriodSchema,
  observation_ids: z.array(id).min(1).max(MAX_COMMUNICATION_SOURCES)
    .refine((ids) => new Set(ids).size === ids.length, "不能重复选择同一条记录"),
  note: z.string().trim().max(800).default(""),
}).strict();
export const updateCommunicationSchema = z.object({
  expected_revision: z.number().int().min(1).max(2147483647), action: z.enum(["save", "review"]),
  text: z.string().trim().min(30, "请保留完整的分享文字").max(5000),
}).strict();
export type CreateCommunicationInput = z.infer<typeof createCommunicationSchema>;
export type UpdateCommunicationInput = z.infer<typeof updateCommunicationSchema>;

export const communicationSourceSchema = z.object({
  id, observed_at: date, context: z.string(), raw_text: z.string(),
  description: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CommunicationSource = z.infer<typeof communicationSourceSchema>;
export const communicationViewSchema = z.object({
  id, owner_account_id: id, child_id: id, client_request_id: id,
  period: communicationPeriodSchema,
  range: z.object({ from: date, to: date, label: z.string() }),
  source_ids: z.array(id).min(1).max(MAX_COMMUNICATION_SOURCES),
  text: z.string(), note: z.string(), author_name: z.string(),
  status: z.enum(["generating", "draft", "reviewed", "failed", "stale"]),
  revision: z.number().int().min(1), updated_at: z.string(),
}).superRefine((value, context) => {
  if (["draft", "reviewed"].includes(value.status) && value.text.trim().length < 30) {
    context.addIssue({ code: "custom", path: ["text"], message: "可用草稿必须包含完整分享文字" });
  }
});
export type CommunicationView = z.infer<typeof communicationViewSchema>;
export const communicationWorkspaceSchema = z.object({
  child: z.object({ id, name: z.string(), class_name: z.string() }),
  range: z.object({ from: date, to: date, label: z.string() }),
  sources: z.array(communicationSourceSchema),
  communication: communicationViewSchema.nullable(),
});
export type CommunicationWorkspace = z.infer<typeof communicationWorkspaceSchema>;

export const communicationModelSchema = z.object({
  stories: z.array(z.object({
    observation_id: id,
    text: z.string().trim().min(12).max(800).describe('只写这条观察的具体事例，不写日期或月份；日期由服务端添加'),
    quote: z.string().trim().min(4).max(300),
  }).strict()).min(1).max(3),
  suggestion: z.string().trim().max(500).describe('可选的家庭陪伴建议；不作事实回顾，不写日期，没有合适建议可填空字符串'),
}).strict();
