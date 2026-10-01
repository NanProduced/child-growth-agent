import type {
  ObservationDraft,
  TeacherEditClarification,
  TeacherEditContent,
  TeacherEditReview,
} from "./types";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .sort();
}

export function normalizeTeacherEditContent(
  content: Partial<TeacherEditContent> | null | undefined,
): TeacherEditContent {
  return {
    domain: text(content?.domain),
    sub_domain: text(content?.sub_domain),
    objective_description: text(content?.objective_description),
    highlights: lines(content?.highlights),
    support_suggestions: lines(content?.support_suggestions),
    highlight_quote: text(content?.highlight_quote),
  };
}

export function sameTeacherEditContent(
  left: Partial<TeacherEditContent> | null | undefined,
  right: Partial<TeacherEditContent> | null | undefined,
): boolean {
  return JSON.stringify(normalizeTeacherEditContent(left)) === JSON.stringify(normalizeTeacherEditContent(right));
}

/** 审核绑定用的澄清问答快照；旧记录没有该字段，按空列表处理 */
export function clarificationSnapshot(clarifications: TeacherEditClarification[]): string[] {
  return clarifications.map((item) => `${item.question.trim()}\n${item.answer.trim()}`);
}

export function sameClarificationSnapshot(
  review: TeacherEditReview | undefined,
  clarifications: TeacherEditClarification[],
): boolean {
  const stored = review?.clarification_snapshot ?? [];
  return JSON.stringify(stored) === JSON.stringify(clarificationSnapshot(clarifications));
}

export type TeacherEditSubmissionAction = "confirm" | "review" | "clarify";

export function teacherEditSubmissionAction(
  originalDraft: ObservationDraft,
  content: TeacherEditContent,
  review: TeacherEditReview | undefined,
  clarifications: TeacherEditClarification[] = [],
): TeacherEditSubmissionAction {
  if (!sameTeacherEditContent(originalDraft, content)) {
    if (!review) return "review";
    if (!sameTeacherEditContent(review.content_snapshot, content)) return "review";
    if (!sameClarificationSnapshot(review, clarifications)) return "review";
    return review.decision === "accept" ? "confirm" : "clarify";
  }
  return "confirm";
}
