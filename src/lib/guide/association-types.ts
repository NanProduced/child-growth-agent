import type {
  GuideAdultHelpPolicy,
  GuideAgeBand,
  GuideEvidenceQuoteField,
  GuideEvidenceQuoteSource,
  GuideItemEvidenceType,
} from "./types";

/**
 * 指南关联操作的共享视图类型与纯展示助手（G6-WRITE1）。
 * 客户端组件只消费服务端构建的白名单字段；本文件不引入数据库或服务端模块。
 */

/** 目录条目的紧凑视图：只带展示与规则字段，不带完整来源路径 */
export interface GuideItemOption {
  id: string;
  text: string;
  age_band: GuideAgeBand;
  evidence_type: GuideItemEvidenceType;
  adult_help: GuideAdultHelpPolicy;
  counts_in_behavior_stats: boolean;
  goal_id: string;
}

/** 依据来源：一条已归档观察（或即将归档的宿主观察） */
export interface BasisSourceOption {
  id: string;
  observed_at: string;
  context: string | null;
  /** 发生时班级（快照）；未知为 null，不回填 */
  class_label: string | null;
  /** 是否为当前正在确认的宿主观察（依据在归档事务中核对于提交内容） */
  is_host: boolean;
  raw_text: string;
  /** 已归档确认稿中的事实位置；宿主观察以客户端当前表单内容为准，服务端此处为 null */
  confirmed: { highlight_quote: string; highlights: string[] } | null;
  /** 来源当前状态（historical read-only 等场景由服务端裁剪，不由此处声明权限） */
  status: "confirmed" | "pending";
}

export interface BasisQuoteChoice {
  label: string;
  quote: string;
  quote_source: GuideEvidenceQuoteSource;
  quote_field: GuideEvidenceQuoteField | null;
}

const MAX_QUOTE = 500;
const MAX_CHIPS = 24;

function splitSentences(text: string): string[] {
  const pieces = text
    .split(/(?<=[。！？!?；;\n])/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 2 && piece.length <= MAX_QUOTE);
  return pieces.slice(0, MAX_CHIPS);
}

function trimToQuote(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_QUOTE ? trimmed : null;
}

/**
 * 可选引用片段：原文句子、确认稿事实位置；全部逐字来自来源，不做改写。
 * 宿主观察的确认稿位置由客户端把当前表单内容传入 liveConfirmed 后生成。
 */
export function basisQuoteChoices(
  source: BasisSourceOption,
  liveConfirmed?: { highlight_quote: string; highlights: string[] } | null,
): BasisQuoteChoice[] {
  const choices: BasisQuoteChoice[] = [];
  const seen = new Set<string>();
  const push = (choice: BasisQuoteChoice) => {
    if (!choice.quote || seen.has(choice.quote)) return;
    seen.add(choice.quote);
    choices.push(choice);
  };
  const whole = trimToQuote(source.raw_text);
  if (whole && whole.length <= 160) {
    push({ label: "整段原文", quote: whole, quote_source: "raw_text", quote_field: null });
  }
  for (const sentence of splitSentences(source.raw_text)) {
    push({ label: "原文片段", quote: sentence, quote_source: "raw_text", quote_field: null });
  }
  const confirmed = source.confirmed ?? liveConfirmed ?? null;
  if (confirmed) {
    const highlightQuote = trimToQuote(confirmed.highlight_quote);
    if (highlightQuote) {
      push({
        label: "确认稿 · 原文金句",
        quote: highlightQuote,
        quote_source: "confirmed_content",
        quote_field: "highlight_quote",
      });
    }
    for (const highlight of confirmed.highlights) {
      const quote = trimToQuote(highlight);
      if (quote) {
        push({
          label: "确认稿 · 发展亮点",
          quote,
          quote_source: "confirmed_content",
          quote_field: "highlights",
        });
      }
    }
  }
  return choices;
}

/** 服务端解析出的写权限（UI 可见性）；服务端授权始终独立执行 */
export interface GuideWriteAccessView {
  can_record: boolean;
  can_decide: boolean;
  can_organize: boolean;
  /** 展示来源：账号教师 / 只读（无写控件） */
  mode: "account_teacher" | "read_only";
  /** 无权限时可读原因（如管理员无教学操作权、原班历史只读） */
  read_only_reason: string | null;
}

export const READ_ONLY_ACCESS: GuideWriteAccessView = {
  can_record: false,
  can_decide: false,
  can_organize: false,
  mode: "read_only",
  read_only_reason: null,
};

/** 班级证据页按幼儿的可操作性（当前名单内逐人判定，不用教师角色一刀切） */
export type ChildRecordAccess = Record<string, boolean>;
