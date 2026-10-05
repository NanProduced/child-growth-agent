import { parseIsoDateStrict } from "@/lib/format";

import type {
  GuideAdultHelpPolicy,
  GuideEvidencePeriodNote,
  GuideEvidenceQuoteField,
  GuideEvidenceQuoteSource,
  GuideEvidenceSupportKind,
  GuideItemEvidenceType,
} from "./types";
import type { GuideEvidenceDecisionInput } from "./view-types";

/**
 * 指南关联决定草稿（G6-WRITE1 客户端纯逻辑）。
 *
 * - 与服务端校验同口径的最小前置检查：不替代服务端，只为教师提供即时反馈；
 * - 决定只提交服务端需要的字段；本地展示字段（item_text 等）不进入请求；
 * - 成人帮助、持续性纪要、引用位置规则与 `src/lib/guide/decisions.ts` 保持一致。
 */

export interface DecisionBasisDraft {
  observation_id: string;
  quote: string;
  quote_source: GuideEvidenceQuoteSource;
  quote_field: GuideEvidenceQuoteField | null;
}

export interface DecisionDraft {
  /** 已有 AI 建议/link 用 link_id；无建议时用 item_id 手动关联 */
  link_id: string | null;
  item_id: string;
  support: GuideEvidenceSupportKind;
  basis: DecisionBasisDraft[];
  sustained_note: GuideEvidencePeriodNote | null;
  adult_help_used: boolean;
  teacher_note: string;
}

export interface DecisionItemRules {
  evidence_type: GuideItemEvidenceType;
  adult_help: GuideAdultHelpPolicy;
}

/** 决定结果状态：表现/线索由 support 推导，与服务端一致 */
export function decisionStatusOf(support: GuideEvidenceSupportKind): "confirmed_performance" | "confirmed_clue" {
  return support === "clue_only" ? "confirmed_clue" : "confirmed_performance";
}

export function isPerformanceSupport(support: GuideEvidenceSupportKind): boolean {
  return support !== "clue_only";
}

function validDate(value: string): boolean {
  return parseIsoDateStrict(value) !== null;
}

/**
 * 持续性条件：至少两条不同日期依据，或结构化纪要（≥10 字、期间合法且覆盖全部依据）。
 * 返回 null 表示通过，否则为教师可读的原因。
 */
export function sustainedConditionError(
  basis: { observed_at: string }[],
  note: GuideEvidencePeriodNote | null,
): string | null {
  const days = new Set(basis.map((entry) => entry.observed_at));
  if (days.size >= 2) return null;
  if (!note) {
    return "持续表现需要至少两条不同日期的依据，或填写连续观察纪要。";
  }
  if (note.description.trim().length < 10) {
    return "连续观察纪要的事实说明至少 10 个字。";
  }
  if (!validDate(note.period_start) || !validDate(note.period_end)) {
    return "连续观察纪要的起止日期不存在，请重新选择。";
  }
  if (note.period_start > note.period_end) {
    return "连续观察纪要的开始日期不能晚于结束日期。";
  }
  if (
    !basis.every(
      (entry) => entry.observed_at >= note.period_start && entry.observed_at <= note.period_end,
    )
  ) {
    return "连续观察纪要的期间必须覆盖全部依据的观察日期。";
  }
  return null;
}

/** 决定草稿校验；通过返回 null，否则返回第一条教师可读原因 */
export function validateDecisionDraft(
  draft: DecisionDraft,
  item: DecisionItemRules,
  basisDates: Map<string, string>,
): string | null {
  if (draft.basis.length === 0) return "请至少选择一条真实依据。";
  const basisForRules = draft.basis.map((entry) => ({
    observed_at: basisDates.get(entry.observation_id) ?? "",
  }));
  for (const entry of draft.basis) {
    if (entry.quote.trim().length === 0) return "每条依据都需要逐字引用片段。";
    if (entry.quote.trim().length > 500) return "引用片段不能超过 500 字。";
    if (entry.quote_source === "raw_text" && entry.quote_field !== null) {
      return "原文依据不能声明引用位置。";
    }
    if (
      entry.quote_source === "confirmed_content" &&
      entry.quote_field !== "highlight_quote" &&
      entry.quote_field !== "highlights"
    ) {
      return "确认稿依据只能引用原文金句或发展亮点。";
    }
  }
  const performance = isPerformanceSupport(draft.support);
  if (draft.support === "sustained") {
    const error = sustainedConditionError(basisForRules, draft.sustained_note);
    if (error) return error;
  }
  if (performance) {
    if (item.evidence_type === "sustained" && draft.support !== "sustained") {
      return "该条目属于持续性表现，确认表现必须选择持续表现（或改为确认线索）。";
    }
    if (draft.adult_help_used && draft.teacher_note.trim().length === 0) {
      return "本次决定使用了成人帮助，确认表现时必须说明帮助方式。";
    }
    if (draft.adult_help_used && item.adult_help === "requires_independence") {
      return "该条目要求幼儿独立完成，有成人帮助时只能确认相关线索。";
    }
  }
  return null;
}

/** 草稿 → 请求决定：只保留服务端字段；空教师备注不提交 */
export function draftToDecisionInput(draft: DecisionDraft): GuideEvidenceDecisionInput {
  const common = {
    support: draft.support,
    basis: draft.basis.map((entry) => ({
      observation_id: entry.observation_id,
      quote: entry.quote.trim(),
      quote_source: entry.quote_source,
      quote_field: entry.quote_source === "raw_text" ? null : entry.quote_field,
    })),
    ...(draft.support === "sustained" && draft.sustained_note
      ? { sustained_note: draft.sustained_note }
      : {}),
    ...(draft.adult_help_used ? { adult_help_used: true } : {}),
    ...(draft.teacher_note.trim() ? { teacher_note: draft.teacher_note.trim() } : {}),
  };
  return draft.link_id
    ? { link_id: draft.link_id, ...common }
    : { item_id: draft.item_id, ...common };
}

/** 决定草稿是否与请求语义相同（用于确认按钮与保存幂等的本地判断） */
export function decisionDraftKey(draft: DecisionDraft): string {
  return JSON.stringify(draftToDecisionInput(draft));
}

export function emptyDecisionDraft(itemId: string, basis: DecisionBasisDraft[]): DecisionDraft {
  return {
    link_id: null,
    item_id: itemId,
    support: "clue_only",
    basis,
    sustained_note: null,
    adult_help_used: false,
    teacher_note: "",
  };
}

/** 依据来源的一句话定位，用于选择器的可读标签 */
export function basisSourceLabel(input: {
  observed_at: string;
  context: string | null;
  is_host?: boolean;
}): string {
  const context = input.context?.trim() ? input.context.trim() : "未填写情境";
  return `${input.observed_at} · ${context}${input.is_host ? " · 本观察" : ""}`;
}
