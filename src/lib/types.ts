export type ObservationStatus = "draft" | "ai_organized" | "confirmed";

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
  ai_draft: ObservationDraft | null;
  ai_model: string | null;
  ai_organized_at: string | null;
  confirmed_content: ObservationDraft | null;
  confirmed_at: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string | null;
}
