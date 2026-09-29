import { COZE_ORGANIZE_MODEL, getLlmProvider, invokeLlm } from "./llm";
import type { LlmMessage, LlmResult, LlmResponseType } from "./llm";
import type { AgentContext, FollowUpDecision, ObservationDraft } from "./types";
import { followUpDecisionSchema, observationDraftSchema } from "./validation";
import { z } from "zod";

/**
 * 观察整理 AI 任务：真实调用国产大模型（豆包 Seed），把教师白描式观察记录
 * 整理为结构化观察分析卡片。仅产出草稿，最终内容以教师确认为准。
 */

export const ORGANIZE_MODEL = COZE_ORGANIZE_MODEL;

export const SYSTEM_PROMPT = `你是幼儿园教师的观察记录整理助手，熟悉《3-6岁儿童学习与发展指南》。
任务：把教师记录的白描式观察原文，整理成一张结构化的观察分析卡片。

硬性要求：
1. 只使用教师原文和教师明确补充的信息，不得虚构、夸大或补充没有证据的细节；补充信息不能改写原文。
2. 只做发展性描述；禁止医疗与心理诊断词汇（如：自闭症、多动症、注意力缺陷、抑郁、焦虑、智商、智力低下等），禁止打分数、评等级或做任何优劣评价。
3. domain 必须严格等于以下五个精确值之一：健康、语言、社会、科学、艺术。禁止使用任何其他领域名称或旧标签（包括但不限于：社会与情感、认知与探究、身体动作、美感、情感与社会性）；不确定时选择最贴近的一个，不得自造词。
4. sub_domain 用简短的领域子方向词（如：同伴交往、大肌肉动作、表达与交流、科学观察、艺术表现等）。
5. objective_description：一两句客观说明这次观察反映的发展点。
6. highlights：最多 3 条，每条引用或概括原文中的一个具体行为，用白描语气。
7. support_suggestions：2-3 条教师可直接操作的支持建议，具体、可执行、贴合情境。
8. highlight_quote：必须从原文中逐字摘录一句最能代表幼儿发展亮点的话（不要改写，也不要摘录教师补充信息）。
9. 全部使用中文。

输出格式：只输出一个 JSON 对象，不要输出任何解释文字或代码块标记。结构：
{"domain": string, "sub_domain": string, "objective_description": string, "highlights": string[], "support_suggestions": string[], "highlight_quote": string}
再次强调：domain 字段的值必须逐字为「健康」「语言」「社会」「科学」「艺术」五个词之一，不得输出其他任何领域名称或旧标签。`;

export const FOLLOW_UP_SYSTEM_PROMPT = `你是幼儿园教师的观察记录补充判断助手，熟悉《3-6岁儿童学习与发展指南》。
你的任务不是评价幼儿，而是判断现有观察证据是否已经足以整理发展性观察草稿。

只有以下情况才可以 decision=ask：缺少关键行为事实、幼儿原话或互动对象、观察情境导致发展线索无法判断、教师支持行为导致支持建议无法贴合。若已有事实可以合理整理，必须 decision=proceed，不要为了完整而追问。

硬性要求：
1. 每次最多提出一个问题，并在 reason 中说明补充它的必要性。
2. 最多追问两轮；当前已到第二轮时必须 decision=proceed。
3. 禁止输出诊断、评分、等级、优劣判断或任何医疗心理结论。
4. 只输出 JSON 对象，不要解释文字或代码块：{"decision":"ask|proceed","question":"string","reason":"string"}。
5. decision=ask 时 question 与 reason 都必须具体有内容；decision=proceed 时 question 输出空字符串，reason 说明为什么现有证据足够。`;

function ageMonths(birthDate: string, observedAt: string): number {
  const b = new Date(`${birthDate}T00:00:00`);
  const o = new Date(`${observedAt}T00:00:00`);
  if (Number.isNaN(b.getTime()) || Number.isNaN(o.getTime())) return 0;
  let months = (o.getFullYear() - b.getFullYear()) * 12 + (o.getMonth() - b.getMonth());
  if (o.getDate() < b.getDate()) months -= 1;
  return Math.max(0, months);
}

/** 容错提取模型输出中的 JSON（兼容代码块包裹、前后缀文本） */
function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

export interface OrganizeParams {
  childName: string;
  childGender: string;
  childBirthDate: string;
  observedAt: string;
  context: string | null;
  rawText: string;
  agentContext?: AgentContext | null;
  forwardHeaders?: Record<string, string>;
}

function formatAgentAnswers(agentContext: AgentContext | null | undefined): string {
  const answers = agentContext?.follow_up?.answers ?? [];
  if (answers.length === 0) return "暂无";
  return answers
    .map((answer, index) => `${index + 1}. ${answer.action}：${answer.content || "（未填写）"}`)
    .join("\n");
}

/** 组装整理任务的对话消息（App 与 StepFun smoke test 共用同一条 prompt 路径） */
export function buildOrganizeMessages(params: OrganizeParams): LlmMessage[] {
  const months = ageMonths(params.childBirthDate, params.observedAt);
  const userPrompt = [
    `幼儿：${params.childName}（${params.childGender}，月龄约 ${months} 个月）`,
    `观察日期：${params.observedAt}`,
    `观察情境：${params.context?.trim() ? params.context.trim() : "未填写"}`,
    "教师原始观察记录（不可增删事实）：",
    params.rawText,
    "教师补充信息（仅作为整理上下文，不得改写原始观察）：",
    formatAgentAnswers(params.agentContext),
    "",
    "请整理为观察分析卡片，只输出 JSON 对象。",
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

/** 组装 Agent 判断消息：原文保持独立，教师补充仅作为工作流上下文。 */
export function buildFollowUpMessages(params: OrganizeParams): LlmMessage[] {
  const round = params.agentContext?.follow_up?.round ?? 0;
  const userPrompt = [
    `幼儿：${params.childName}（${params.childGender}）`,
    `观察日期：${params.observedAt}`,
    `观察情境：${params.context?.trim() ? params.context.trim() : "未填写"}`,
    `当前已完成追问轮次：${round}（达到 2 轮时必须 proceed）`,
    "教师原始观察记录（不可修改）：",
    params.rawText,
    "此前教师补充信息（只是上下文，不是对原文的改写）：",
    formatAgentAnswers(params.agentContext),
    "请只输出 follow_up_decision JSON。",
  ].join("\n");

  return [
    { role: "system", content: FOLLOW_UP_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

async function invokeStructured<T>(
  messages: LlmMessage[],
  responseType: LlmResponseType,
  schema: z.ZodType<T>,
  retryInstruction: string,
  invoke: typeof invokeLlm,
  forwardHeaders?: Record<string, string>,
): Promise<{ data: T; model: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: LlmResult;
    try {
      response = await invoke(messages, {
        temperature: 0.3,
        responseType,
        forwardHeaders: getLlmProvider() === "coze" ? forwardHeaders : undefined,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }

    let failure = "";
    try {
      const parsed = schema.safeParse(extractJson(response.content));
      if (parsed.success) return { data: parsed.data, model: response.model };
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "输出";
      failure = `schema 校验失败（${where}：${issue?.message || "不符合要求"}）`.slice(0, 240);
    } catch {
      failure = "输出不是可解析的 JSON";
    }

    lastError = failure;
    if (attempt === 0) {
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `上一次输出未通过校验：${failure}。${retryInstruction}` });
    }
  }

  throw new Error(`AI 整理失败，请重试。原因：${lastError || "模型输出不符合要求"}`);
}

export async function judgeFollowUp(
  params: OrganizeParams,
  invoke: typeof invokeLlm = invokeLlm,
): Promise<{ decision: FollowUpDecision; model: string }> {
  const result = await invokeStructured(
    buildFollowUpMessages(params),
    "follow_up_decision",
    followUpDecisionSchema,
    "请严格输出 decision=ask 或 decision=proceed；ask 必须同时填写具体 question 和 reason。",
    invoke,
    params.forwardHeaders,
  );
  return { decision: result.data, model: result.model };
}

export async function organizeObservation(
  params: OrganizeParams,
  invoke: typeof invokeLlm = invokeLlm,
): Promise<{
  draft: ObservationDraft;
  model: string;
}> {
  const result = await invokeStructured(
    buildOrganizeMessages(params),
    "observation_draft",
    observationDraftSchema,
    "请严格按要求重新整理，只输出一个 JSON 对象；domain 只能取：健康、语言、社会、科学、艺术。",
    invoke,
    params.forwardHeaders,
  );
  return { draft: result.data, model: result.model };
}
