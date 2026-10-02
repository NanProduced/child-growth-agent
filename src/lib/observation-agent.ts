import { judgeFollowUp, organizeObservation } from "./ai";
import { followUpRounds } from "./follow-up";
import { invokeLlm } from "./llm";
import {
  type ObservationWriteGuard,
  updateObservationAgentContext,
  updateObservationAiDraft,
} from "./queries";
import type {
  AgentContext,
  Child,
  FollowUpAction,
  FollowUpDecision,
  Observation,
} from "./types";

/**
 * 模型调用前捕获服务端快照；模型返回后的 UPDATE 必须仍匹配该快照，
 * 否则迟到的 ask/整理结果会覆盖较新的上下文。
 */
export function observationWriteGuard(observation: Observation): ObservationWriteGuard {
  return {
    expectedStatus: observation.status,
    expectedAgentContext: observation.agent_context,
    expectedAiDraft: observation.ai_draft,
  };
}

export function appendFollowUpAction(
  context: AgentContext,
  action: FollowUpAction,
  content: string,
  createdAt = new Date().toISOString(),
): AgentContext {
  const followUp = context.follow_up;
  if (!followUp) throw new Error("当前没有待补充问题");
  const answer = { action, content: content.trim(), created_at: createdAt };
  // 同一当前轮次的重试替换为该轮有效回答；只有新轮次才追加
  const rounds = followUpRounds(followUp).map((round) =>
    round.round === followUp.round ? { ...round, answer } : round,
  );
  const answers =
    followUp.answers.length >= followUp.round
      ? [...followUp.answers.slice(0, -1), answer]
      : [...followUp.answers, answer];
  return {
    ...context,
    follow_up: {
      ...followUp,
      answers,
      rounds,
      stopped: followUp.stopped || action === "stop",
    },
  };
}

export function nextFollowUpContext(
  context: AgentContext | null,
  decision: FollowUpDecision,
): AgentContext {
  const previous = context?.follow_up;
  const round = (previous?.round ?? 0) + 1;
  return {
    ...(context ?? {}),
    follow_up: {
      round,
      question: decision.question,
      reason: decision.reason,
      answers: previous?.answers ?? [],
      rounds: [
        ...(previous ? followUpRounds(previous) : []),
        { round, question: decision.question, reason: decision.reason, answer: null },
      ],
      stopped: false,
    },
  };
}

/** 已跳过、停止或完成两轮后，禁止再次追问，直接进入草稿整理。 */
export function shouldProceedToDraft(context: AgentContext | null): boolean {
  const followUp = context?.follow_up;
  if (!followUp) return false;
  const lastAction = followUp.answers.at(-1)?.action;
  return followUp.stopped || followUp.round >= 2 || lastAction === "skip";
}

type ObservationAgentInput = {
  observation: Observation;
  child: Child;
  /** 服务端当前日期；测试与评测可注入固定日期 */
  currentDate?: string;
  forwardHeaders?: Record<string, string>;
  invoke?: typeof invokeLlm;
};

export async function processObservationAgent({
  observation,
  child,
  currentDate,
  forwardHeaders,
  invoke = invokeLlm,
}: ObservationAgentInput): Promise<Observation> {
  const baseParams = {
    childName: child.name,
    childGender: child.gender,
    childBirthDate: child.birth_date,
    observedAt: observation.observed_at,
    context: observation.context,
    rawText: observation.raw_text,
    currentDate,
    childNote: child.note,
    forwardHeaders,
  };
  const context = observation.agent_context;
  // 服务端快照：模型返回后的写入必须仍匹配它
  const writeGuard = observationWriteGuard(observation);

  if (!shouldProceedToDraft(context)) {
    const judged = await judgeFollowUp({ ...baseParams, agentContext: context }, invoke);
    if (judged.decision.decision === "ask" && (context?.follow_up?.round ?? 0) < 2) {
      return updateObservationAgentContext(
        observation.id,
        nextFollowUpContext(context, judged.decision),
        "needs_input",
        writeGuard,
      );
    }
  }

  const { draft, model } = await organizeObservation(
    { ...baseParams, agentContext: context },
    invoke,
  );
  return updateObservationAiDraft(observation.id, draft, model, writeGuard);
}
