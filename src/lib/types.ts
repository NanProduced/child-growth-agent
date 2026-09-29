export const OBSERVATION_STATUSES = ["draft", "needs_input", "ai_organized", "confirmed"] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

export type FollowUpAction = "answer" | "skip" | "stop";

export interface AgentFollowUpAnswer {
  action: FollowUpAction;
  content: string;
  created_at: string;
}

export interface AgentFollowUp {
  round: number;
  question: string;
  reason: string;
  answers: AgentFollowUpAnswer[];
  stopped: boolean;
}

export interface AgentContext {
  follow_up?: AgentFollowUp;
  teacher_edit_review?: TeacherEditReview;
}

export interface FollowUpDecision {
  decision: "ask" | "proceed";
  question: string;
  reason: string;
}

export const FIVE_DOMAINS = ["健康", "语言", "社会", "科学", "艺术"] as const;

/**
 * 观察整理卡片（AI 草稿 / 教师确认稿共用结构）。
 * 注意：仅描述教师观察到的行为事实，禁止医疗/心理诊断类结论。
 */
export interface ObservationDraft {
  domain: string;
  sub_domain: string;
  objective_description: string;
  highlights: string[];
  support_suggestions: string[];
  highlight_quote: string;
  teacher_note?: string;
}

export type TeacherEditContent = Pick<
  ObservationDraft,
  | "domain"
  | "sub_domain"
  | "objective_description"
  | "highlights"
  | "support_suggestions"
  | "highlight_quote"
>;

export type TeacherEditReviewDecision = "accept" | "clarify";
export type TeacherEditFactCheck = "supported" | "partially_supported" | "unsupported";

export interface TeacherEditReviewOutput {
  decision: TeacherEditReviewDecision;
  summary: string;
  change_summary: string[];
  fact_check: TeacherEditFactCheck;
  question: string;
}

export interface TeacherEditReview extends TeacherEditReviewOutput {
  content_snapshot: TeacherEditContent;
  reviewed_at: string;
}

export interface Child {
  id: string;
  name: string;
  gender: string;
  birth_date: string;
  class_name: string;
  avatar_emoji: string | null;
  note: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface Observation {
  id: string;
  child_id: string;
  observed_at: string;
  context: string | null;
  raw_text: string;
  status: ObservationStatus;
  agent_context: AgentContext | null;
  ai_draft: ObservationDraft | null;
  ai_model: string | null;
  ai_organized_at: string | null;
  confirmed_content: ObservationDraft | null;
  confirmed_at: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string | null;
}
