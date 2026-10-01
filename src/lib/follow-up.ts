import type { AgentFollowUp, AgentFollowUpAnswer, AgentFollowUpRound } from "./types";

/**
 * 兼容旧上下文：旧记录只保存最新一轮的 question/reason 和扁平的 answers。
 * 能确定配对关系时保留原问题；无法确定问题的旧回答标为历史补充，不推测、不补造问题。
 */
export function followUpRounds(followUp: AgentFollowUp): AgentFollowUpRound[] {
  if (Array.isArray(followUp.rounds)) return followUp.rounds;

  const answers = followUp.answers ?? [];
  const rounds: AgentFollowUpRound[] = answers.map((answer, index) => {
    const round = index + 1;
    const isCurrentQuestion = round === followUp.round && answers.length === followUp.round;
    return {
      round,
      question: isCurrentQuestion ? followUp.question : "",
      reason: isCurrentQuestion ? followUp.reason : "",
      answer,
    };
  });

  if (followUp.question && answers.length < followUp.round) {
    rounds.push({
      round: followUp.round,
      question: followUp.question,
      reason: followUp.reason,
      answer: null,
    });
  }
  return rounds;
}

function answerText(answer: AgentFollowUpAnswer | null): string {
  if (!answer) return "（尚未回答）";
  if (answer.action === "skip") return "教师选择跳过本轮（直接进入整理）";
  if (answer.action === "stop") return "教师选择不再追问";
  return answer.content || "（未填写内容）";
}

/** 把逐轮问答格式化为 Prompt 文本；无法确定问题的旧回答只标为历史补充 */
export function formatFollowUpRounds(followUp: AgentFollowUp | null | undefined): string {
  if (!followUp) return "暂无";
  const rounds = followUpRounds(followUp);
  if (rounds.length === 0) return "暂无";
  return rounds
    .map((round) => {
      if (!round.question) {
        return `历史补充（原追问问题未保存）：${answerText(round.answer)}`;
      }
      return [
        `第${round.round}轮问题：${round.question}`,
        `补充必要性：${round.reason || "未保存"}`,
        `教师回应：${answerText(round.answer)}`,
      ].join("\n");
    })
    .join("\n\n");
}
