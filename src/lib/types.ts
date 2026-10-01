export const OBSERVATION_STATUSES = ["draft", "needs_input", "ai_organized", "confirmed"] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

export type FollowUpAction = "answer" | "skip" | "stop";

export interface AgentFollowUpAnswer {
  action: FollowUpAction;
  content: string;
  created_at: string;
}

/** 单轮追问：问题、必要性说明与教师回答/跳过行为成对保存 */
export interface AgentFollowUpRound {
  round: number;
  /** 该轮问题；旧上下文无法确定时为空字符串，只按历史补充呈现，不补造问题 */
  question: string;
  reason: string;
  answer: AgentFollowUpAnswer | null;
}

export interface AgentFollowUp {
  round: number;
  question: string;
  reason: string;
  answers: AgentFollowUpAnswer[];
  /** 新记录逐轮保存问答配对；旧记录没有此字段 */
  rounds?: AgentFollowUpRound[];
  stopped: boolean;
}

/** 教师对修改审核 clarify 问题的补充回答，独立于观察追问轮次 */
export interface TeacherEditClarification {
  question: string;
  answer: string;
  created_at: string;
}

export interface AgentContext {
  follow_up?: AgentFollowUp;
  teacher_edit_review?: TeacherEditReview;
  teacher_edit_clarifications?: TeacherEditClarification[];
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

export interface GrowthProfileDraft {
  summary: string;
  recent_change: string;
  development_clues: string[];
  next_support: string;
  next_focus: string;
}

export interface ActivitySupportSuggestion {
  title: string;
  purpose: string;
  steps: string[];
  materials: string[];
  observe: string;
  adaptation: string;
  evidence: string[];
  /** 新生成建议经引用核对后记录匹配到的已确认观察 id；旧建议没有此字段 */
  source_observation_ids?: string[];
}

export interface ActivitySupportDraft {
  suggestions: ActivitySupportSuggestion[];
}

export interface ActivitySupport extends ActivitySupportDraft {
  source_observation_ids: string[];
  ai_model: string;
  generated_at: string;
}

export interface GrowthProfile extends GrowthProfileDraft {
  source_observation_ids: string[];
  ai_model: string;
  updated_at: string;
  activity_support?: ActivitySupport | null;
  /** 保守回退小结（非模型生成）为 true；旧记录没有此字段 */
  is_fallback?: boolean;
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
  /** 审核时使用的澄清问答快照；旧记录没有此字段，按空列表处理 */
  clarification_snapshot?: string[];
  /** 审核时使用的教师备注（服务端规范化）；旧记录没有此字段，需重审一次 */
  note_snapshot?: string;
  reviewed_at: string;
}

export const CLASS_STAGES = ["small", "middle", "large"] as const;
export type ClassStage = (typeof CLASS_STAGES)[number];

export const CLASS_STAGE_LABELS: Record<ClassStage, string> = {
  small: "小班",
  middle: "中班",
  large: "大班",
};

/** 班级实体：停用用 is_active 表示，不做物理删除 */
export interface SchoolClass {
  id: string;
  name: string;
  stage: ClassStage;
  school_year: string;
  is_active: boolean;
  is_demo: boolean;
  created_at: string;
  updated_at: string | null;
}

/** 班级归属历史：end_date 为空表示当前在班 */
export interface ChildClassEnrollment {
  id: string;
  child_id: string;
  class_id: string;
  start_date: string;
  end_date: string | null;
  created_at: string;
}

export interface Child {
  id: string;
  name: string;
  gender: string;
  birth_date: string;
  /** 兼容字段：当前班级名（无归属时为历史遗留文本） */
  class_name: string;
  /** 当前班级 id：无未结束归属时为 null */
  class_id: string | null;
  current_class: SchoolClass | null;
  class_stage: ClassStage | null;
  class_school_year: string | null;
  avatar_emoji: string | null;
  note: string | null;
  growth_profile: GrowthProfile | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface Observation {
  id: string;
  child_id: string;
  /** 发生时班级快照：转班后旧观察仍保留原班级语境 */
  class_id: string | null;
  observed_class: SchoolClass | null;
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
