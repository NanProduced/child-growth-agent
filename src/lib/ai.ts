import { COZE_ORGANIZE_MODEL, getLlmProvider, invokeLlm } from "./llm";
import type { LlmMessage, LlmResult, LlmResponseType } from "./llm";
import type {
  ActivitySupportDraft,
  AgentContext,
  FollowUpDecision,
  GrowthProfileDraft,
  GrowthProfile,
  Observation,
  ObservationDraft,
  TeacherEditContent,
  TeacherEditReviewOutput,
} from "./types";
import {
  followUpDecisionSchema,
  activitySupportDraftSchema,
  observationDraftSchema,
  teacherEditReviewSchema,
  growthProfileSchema,
} from "./validation";
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

export const TEACHER_EDIT_REVIEW_SYSTEM_PROMPT = `你是幼儿园教师观察记录的修改审核助手。
你的任务是理解教师为什么修改 AI 草稿，并核对修改内容是否能从原始观察或教师补充信息中找到依据。你不是重新评价幼儿，也不能替教师下结论。

硬性要求：
1. raw_text 和教师补充信息是事实依据；原始 AI 草稿只是被修改的旧版本，不能把 AI 草稿本身当成新的事实。
2. 只核对事实一致性与修改意图；禁止诊断、评分、排名、等级或优劣判断。
3. decision=accept 仅表示修改有依据或属于表达调整；decision=clarify 表示存在不清楚、部分依据或缺少依据的地方。
4. fact_check 必须为 supported、partially_supported、unsupported 之一。
5. decision=clarify 时 question 必须具体说明需要教师确认什么；decision=accept 时 question 输出空字符串。
6. 只输出 JSON 对象，不要解释文字或代码块：{"decision":"accept|clarify","summary":"string","change_summary":[],"fact_check":"supported|partially_supported|unsupported","question":"string"}。`;

export const GROWTH_PROFILE_SYSTEM_PROMPT = `你是幼儿园教师的成长档案整理助手，熟悉《3-6岁儿童学习与发展指南》。
你的任务是根据同一个幼儿已经由教师确认的观察记录，形成阶段性的成长档案小结，帮助教师回顾变化并决定下一次观察关注什么。

硬性要求：
1. 只能使用输入中明确标记为 status=confirmed 的观察记录；绝不使用 draft、needs_input、ai_organized 或任何未经教师确认的 AI 草稿，也不能把教师尚未提交的编辑内容当作依据。
2. 只能依据输入中的原始观察与 confirmed_content，不得虚构观察中没有出现的事实、动机、情绪或结果。
3. 不进行医疗、心理或教育诊断，不评分，不排名，不做同龄比较，不输出等级或优劣判断。
4. 不使用“发展落后、能力差、注意力不集中”等定性词，也不要换用含义相同的评判性表达。
5. summary 关注一段时间内已经确认的具体行为线索；recent_change 只描述最近一次或最近一组观察中可见的变化；development_clues 列出具体且可追溯的观察线索；next_support 给出温和、可操作且不带干预色彩的教师支持；next_focus 写下一次可以继续观察的具体现象。
6. 全部使用中文，只输出一个 JSON 对象，不要解释文字或代码块标记。不要输出 source_observation_ids、ai_model、updated_at 等元数据。

输出结构：
{"summary":"string","recent_change":"string","development_clues":["string"],"next_support":"string","next_focus":"string"}`;

export const ACTIVITY_SUPPORT_SYSTEM_PROMPT = `你是幼儿园教师的活动支持建议助手，熟悉《3-6岁儿童学习与发展指南》。
你的任务是根据同一个幼儿已经由教师确认的观察证据和已确认的成长档案小结，给教师提供少量、具体、可执行的活动支持建议。

硬性要求：
1. 只使用输入中 status=confirmed 且有 confirmed_content 的观察，以及明确标记为已确认来源的成长档案小结；不得使用 draft、needs_input、ai_organized、ai_draft 或教师未确认的内容。
2. 只生成 2 到 3 条建议。每条 steps 必须是 2 到 4 个教师可以直接照做的简单步骤。
3. materials 没有特别材料时输出空数组；不要为了凑内容添加复杂或昂贵材料。
4. observe 必须写教师可以继续观察的具体行为、语言或互动；adaptation 必须写根据幼儿当下反应如何降低难度、增加选择或改变支持方式。
5. evidence 至少包含一条证据线索，并以输入中出现的观察领域开头（例如“科学：……”）；证据应来自已确认观察中的具体行为或语言，不得虚构。
6. 不生成医疗诊断、心理诊断、能力评分、排名、等级、同龄比较或优劣判断，不使用含义相同的评判性表达。
7. 全部使用中文，只输出一个 JSON 对象，不要解释文字或代码块标记。

输出结构：
{"suggestions":[{"title":"string","purpose":"string","steps":["string"],"materials":["string"],"observe":"string","adaptation":"string","evidence":["string"]}]}`;

const DEVELOPMENT_FORBIDDEN_TERMS = [
  "自闭症",
  "多动症",
  "注意力缺陷",
  "抑郁",
  "焦虑",
  "智商",
  "智力低下",
  "诊断",
  "评分",
  "得分",
  "分数",
  "排名",
  "领先",
  "落后",
  "等级",
  "能力差",
  "注意力不集中",
  "发展落后",
  "同龄比较",
  "同龄人比较",
] as const;

const GROWTH_PROFILE_FORBIDDEN_TERMS = DEVELOPMENT_FORBIDDEN_TERMS;

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

export interface TeacherEditReviewParams {
  rawText: string;
  originalDraft: ObservationDraft;
  content: TeacherEditContent;
  teacherNote?: string;
  agentContext?: AgentContext | null;
  forwardHeaders?: Record<string, string>;
}

export interface GrowthProfileParams {
  childName: string;
  childGender: string;
  observations: Observation[];
  forwardHeaders?: Record<string, string>;
}

export interface ActivitySupportParams {
  childName: string;
  childGender: string;
  observations: Observation[];
  growthProfile?: GrowthProfile | null;
  forwardHeaders?: Record<string, string>;
}

/** 组装教师修改审核消息：事实、旧草稿、修改内容和备注分区传给 Agent。 */
export function buildTeacherEditReviewMessages(params: TeacherEditReviewParams): LlmMessage[] {
  const userPrompt = [
    "原始观察 raw_text（唯一事实依据之一，不可修改）：",
    params.rawText,
    "教师此前补充信息（如有，仅作为事实上下文）：",
    formatAgentAnswers(params.agentContext),
    "原始 AI 草稿 ai_draft（只用于识别修改，不等于事实）：",
    JSON.stringify(params.originalDraft),
    "教师提交的修改 content：",
    JSON.stringify(params.content),
    "教师备注 teacher_note（用于理解修改意图，不属于 AI 内容字段）：",
    params.teacherNote?.trim() || "未填写",
    "请只输出 teacher_edit_review JSON。",
  ].join("\n");

  return [
    { role: "system", content: TEACHER_EDIT_REVIEW_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

/** 只组装教师已经确认的观察；AI 草稿与工作流上下文不会进入成长档案输入。 */
export function buildGrowthProfileMessages(params: GrowthProfileParams): LlmMessage[] {
  const confirmedObservations = params.observations.filter(
    (observation) => observation.status === "confirmed" && observation.confirmed_content,
  );
  const evidence = confirmedObservations.map((observation) => ({
    status: observation.status,
    id: observation.id,
    observed_at: observation.observed_at,
    context: observation.context,
    raw_text: observation.raw_text,
    confirmed_content: observation.confirmed_content,
  }));
  const userPrompt = [
    `幼儿：${params.childName}（${params.childGender}）`,
    "以下是该幼儿的已确认观察证据。每条记录都必须保持 status=confirmed 才能使用：",
    JSON.stringify(evidence),
    "请基于这些已确认观察生成 growth_profile JSON。只输出 JSON 对象。",
  ].join("\n");

  return [
    { role: "system", content: GROWTH_PROFILE_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

function confirmedObservations(observations: Observation[]): Observation[] {
  return observations.filter(
    (observation) => observation.status === "confirmed" && observation.confirmed_content,
  );
}

function supportedGrowthProfile(
  profile: GrowthProfile | null | undefined,
  observations: Observation[],
): GrowthProfile | null {
  if (!profile || !Array.isArray(profile.source_observation_ids) || profile.source_observation_ids.length === 0) {
    return null;
  }
  const confirmedIds = new Set(confirmedObservations(observations).map((observation) => observation.id));
  return profile.source_observation_ids.every((id) => confirmedIds.has(id)) ? profile : null;
}

/** 组装活动支持任务：只携带确认观察和仍有确认来源的成长小结。 */
export function buildActivitySupportMessages(params: ActivitySupportParams): LlmMessage[] {
  const confirmed = confirmedObservations(params.observations);
  const evidence = confirmed.map((observation) => ({
    status: observation.status,
    id: observation.id,
    observed_at: observation.observed_at,
    context: observation.context,
    raw_text: observation.raw_text,
    confirmed_content: observation.confirmed_content,
  }));
  const profile = supportedGrowthProfile(params.growthProfile, params.observations);
  const confirmedProfile = profile
    ? {
        summary: profile.summary,
        recent_change: profile.recent_change,
        development_clues: profile.development_clues,
        next_support: profile.next_support,
        next_focus: profile.next_focus,
      }
    : "暂无可用的已确认成长小结";
  const userPrompt = [
    `幼儿：${params.childName}（${params.childGender}）`,
    "已确认成长档案小结（只可作为已确认观察的归纳，不是新的事实）：",
    JSON.stringify(confirmedProfile),
    "以下是可使用的已确认观察证据。每条记录都必须保持 status=confirmed：",
    JSON.stringify(evidence),
    "请生成 2 到 3 条活动支持建议，只输出 activity_support JSON。",
  ].join("\n");

  return [
    { role: "system", content: ACTIVITY_SUPPORT_SYSTEM_PROMPT },
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
  errorLabel = "AI 整理",
  validate?: (data: T) => string | undefined,
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
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.join(".") || "输出";
        failure = `schema 校验失败（${where}：${issue?.message || "不符合要求"}）`.slice(0, 240);
      } else {
        const validationError = validate?.(parsed.data);
        if (!validationError) return { data: parsed.data, model: response.model };
        failure = validationError;
      }
    } catch {
      failure = "输出不是可解析的 JSON";
    }

    lastError = failure;
    if (attempt === 0) {
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `上一次输出未通过校验：${failure}。${retryInstruction}` });
    }
  }

  throw new Error(`${errorLabel}失败，请重试。原因：${lastError || "模型输出不符合要求"}`);
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
    "Agent 判断",
  );
  return { decision: result.data, model: result.model };
}

export async function reviewTeacherEdit(
  params: TeacherEditReviewParams,
  invoke: typeof invokeLlm = invokeLlm,
): Promise<{ review: TeacherEditReviewOutput; model: string }> {
  const result = await invokeStructured(
    buildTeacherEditReviewMessages(params),
    "teacher_edit_review",
    teacherEditReviewSchema,
    "请严格输出 teacher_edit_review JSON；clarify 时必须填写具体 question，不能自行接受缺少依据的修改。",
    invoke,
    params.forwardHeaders,
    "Agent 修改审核",
  );
  return { review: result.data, model: result.model };
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
    "AI 整理",
  );
  return { draft: result.data, model: result.model };
}

function validateGrowthProfileOutput(profile: GrowthProfileDraft): string | undefined {
  const text = JSON.stringify(profile);
  const forbidden = GROWTH_PROFILE_FORBIDDEN_TERMS.find((term) => text.includes(term));
  return forbidden ? `成长档案输出包含不允许的定性词「${forbidden}」` : undefined;
}

function validateActivitySupportOutput(
  output: ActivitySupportDraft,
  observations: Observation[],
): string | undefined {
  const text = JSON.stringify(output);
  const forbidden = DEVELOPMENT_FORBIDDEN_TERMS.find((term) => text.includes(term));
  if (forbidden) return `活动支持建议包含不允许的定性词「${forbidden}」`;

  const domains = new Set(
    confirmedObservations(observations)
      .map((observation) => observation.confirmed_content?.domain)
      .filter((domain): domain is string => Boolean(domain)),
  );
  if (domains.size === 0) return "已确认观察缺少可追溯的观察领域";
  if (output.suggestions.some((suggestion) => !suggestion.evidence.some((item) => [...domains].some((domain) => item.includes(domain))))) {
    return "每条活动建议都必须带有对应的已确认观察领域证据";
  }
  return undefined;
}

export async function generateGrowthProfile(
  params: GrowthProfileParams,
  invoke: typeof invokeLlm = invokeLlm,
): Promise<{ profile: GrowthProfileDraft; model: string }> {
  const confirmedObservations = params.observations.filter(
    (observation) => observation.status === "confirmed" && observation.confirmed_content,
  );
  if (confirmedObservations.length === 0) {
    throw new Error("成长档案更新需要至少一条已确认观察");
  }

  const result = await invokeStructured(
    buildGrowthProfileMessages({ ...params, observations: confirmedObservations }),
    "growth_profile",
    growthProfileSchema,
    "请只依据 status=confirmed 的观察重新输出 growth_profile JSON，并移除诊断、评分、排名和同龄比较用语。",
    invoke,
    params.forwardHeaders,
    "成长档案 Agent",
    validateGrowthProfileOutput,
  );
  return { profile: result.data, model: result.model };
}

export async function generateActivitySupport(
  params: ActivitySupportParams,
  invoke: typeof invokeLlm = invokeLlm,
): Promise<{ activitySupport: ActivitySupportDraft; model: string }> {
  const confirmed = confirmedObservations(params.observations);
  if (confirmed.length === 0) {
    throw new Error("活动支持建议需要至少一条已确认观察");
  }

  const result = await invokeStructured(
    buildActivitySupportMessages({ ...params, observations: confirmed }),
    "activity_support",
    activitySupportDraftSchema,
    "请严格输出 2 到 3 条 activity_support 建议；每条必须有 2 到 4 个步骤、观察提示、调整方式和带观察领域的证据线索，并移除诊断、评分、排名和同龄比较用语。",
    invoke,
    params.forwardHeaders,
    "活动支持 Agent",
    (output) => validateActivitySupportOutput(output, confirmed),
  );
  return { activitySupport: result.data, model: result.model };
}
