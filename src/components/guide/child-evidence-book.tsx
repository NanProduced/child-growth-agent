"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { BookOpen, ChevronDown, CircleAlert, PenLine } from "lucide-react";

import { classLabel, formatDateCn, formatDateTimeCn, parseIsoDateStrict } from "@/lib/format";
import { CLASS_STAGE_LABELS } from "@/lib/types";
import {
  GUIDE_AGE_BAND_LABELS,
  type GuideAgeBand,
  type GuideCatalog,
  type GuideEvidenceLinkOrigin,
  type GuideEvidenceLinkStatus,
  type GuideEvidenceSupportKind,
  type GuideGoal,
  type GuideItemEvidenceType,
  type GuidePerformanceItem,
  type SemesterPeriod,
} from "@/lib/guide/types";
import {
  GUIDE_EVIDENCE_LINK_STATUS_LABELS,
  GUIDE_ITEM_EVIDENCE_STATUS_LABELS,
  type ChildEvidenceBook,
  type ChildGuideItemView,
  type EvidenceBasisInvalidReason,
  type EvidenceBasisView,
  type EvidenceChildRef,
  type EvidenceExclusionReason,
  type EvidenceLinkView,
  type EvidenceScope,
  type EvidenceViewFilters,
  type GuideItemEvidenceStatus,
} from "@/lib/guide/view-types";
import styles from "./child-evidence-book.module.css";

/**
 * G3 个人证据册：按《指南》综合目标分组回看儿童观察证据。
 * - 只读展示服务端 DTO（ChildEvidenceBook）；不另算状态、不显示百分比或完成度；
 * - 期间控件以 book.scope 为准；自定义日期只是草稿，明确标注是否已应用；
 * - 筛选与期间只通过 typed callback 发出意图，由 G6 接入正式路由与取数；
 * - “记录相关观察”只带出儿童与条目，不预填内容。
 */

export type EvidenceScopeIntent =
  | { kind: "semester"; semester_id: string }
  | { kind: "all_history" }
  | { kind: "custom_range"; from: string; to: string };

export interface ChildEvidenceBookProps {
  book: ChildEvidenceBook;
  /** G2 显式学期配置（G6 传入）；缺省时仍可查看当前范围、全部历史与自定义日期 */
  semesters?: SemesterPeriod[];
  onScopeChange?: (scope: EvidenceScopeIntent) => void;
  /** 领域 / 指南参考年龄段筛选；null 表示不过滤；切领域（含“全部”）一律清空 goal_id */
  onFiltersChange?: (filters: EvidenceViewFilters) => void;
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  focusedItemId?: string;
  className?: string;
}

const EXCLUSION_REASON_LABELS: Record<EvidenceExclusionReason, string> = {
  workflow_pending: "建议还在等老师确认",
  teacher_rejected: "教师已不采用",
  withdrawn: "已撤回",
  basis_invalid: "相关记录暂时不能核对",
  basis_out_of_period: "依据的观察日期不在所选期间内",
  catalog_mismatch: "指南目录已更新，需要重新核对",
  support_insufficient: "现有记录还不足以支持这项表现",
  history_unknown: "当时的班级没有记录",
  out_of_stage_evidence: "发生阶段不符合班级统计口径",
  unknown_status: "关联状态无法识别",
};

const BASIS_INVALID_LABELS: Record<EvidenceBasisInvalidReason, string> = {
  source_missing: "来源记录不存在",
  cross_child: "来源属于其他幼儿",
  not_confirmed: "来源观察尚未确认",
  quote_not_found: "原记录中未找到这段文字",
  version_mismatch: "来源版本已变化",
};

const SUPPORT_LABELS: Record<GuideEvidenceSupportKind, string> = {
  single_event: "单次表现",
  sustained: "持续表现",
  clue_only: "仅线索",
};

const HEALTH_SUPPORT_LABELS: Record<GuideEvidenceSupportKind, string> = {
  single_event: "单次资料",
  sustained: "连续资料",
  clue_only: "参考线索",
};

const ORIGIN_LABELS: Record<GuideEvidenceLinkOrigin, string> = {
  ai: "AI 建议",
  manual: "教师手动关联",
};

/** 保健参考展示分支：资料参考 / 来源查阅 / 教师核对关联，不套用行为表现确认文案（内部状态保留在 data 属性中用于审计） */
const HEALTH_LINK_STATUS_LABELS: Record<GuideEvidenceLinkStatus, string> = {
  ai_suggested: "AI 建议待核对",
  confirmed_performance: "资料已核对",
  confirmed_clue: "资料线索已核对",
  rejected: "已不采用",
  withdrawn: "已撤回",
};

const HEALTH_ORIGIN_LABELS: Record<GuideEvidenceLinkOrigin, string> = {
  ai: "AI 建议关联",
  manual: "教师核对关联",
};

const NOTICE_SEVERITY_LABELS = {
  info: "提示",
  warning: "需要留意",
  error: "暂时不可用",
} as const;

const STATUS_CLASS: Record<GuideItemEvidenceStatus, string> = {
  no_records: "status-none",
  has_clues: "status-clue",
  confirmed_observed: "status-observed",
};

const LINK_STATUS_CLASS: Record<GuideEvidenceLinkStatus, string> = {
  ai_suggested: "link-pending",
  confirmed_performance: "link-performance",
  confirmed_clue: "link-clue",
  rejected: "link-rejected",
  withdrawn: "link-withdrawn",
};

const HEALTH_LINK_STATUS_CLASS: Record<GuideEvidenceLinkStatus, string> = {
  ai_suggested: "link-pending",
  confirmed_performance: "link-reference",
  confirmed_clue: "link-reference",
  rejected: "link-rejected",
  withdrawn: "link-withdrawn",
};

const AGE_BAND_OPTIONS: Array<{ value: GuideAgeBand | null; label: string }> = [
  { value: null, label: "全部" },
  { value: "3-4", label: GUIDE_AGE_BAND_LABELS["3-4"] },
  { value: "4-5", label: GUIDE_AGE_BAND_LABELS["4-5"] },
  { value: "5-6", label: GUIDE_AGE_BAND_LABELS["5-6"] },
];

const RELIABILITY_NOTICE: Record<"partial" | "unavailable", string> = {
  partial: "有些记录暂时不能核对，以下先显示能读取的内容。",
  unavailable: "暂时读不到这项的相关记录，请重新读取；这不代表没有观察记录。",
};

type ScopeSelectValue = "all_history" | "custom_range" | `semester:${string}`;

function scopeSelectValue(scope: EvidenceScope): ScopeSelectValue {
  if (scope.kind === "all_history") return "all_history";
  if (scope.kind === "custom_range") return "custom_range";
  return `semester:${scope.semester_id ?? ""}`;
}

function cx(...names: Array<string | false | null | undefined>): string {
  return names
    .filter(Boolean)
    .map((name) => styles[name as string] ?? "")
    .join(" ");
}

function classContextLabel(snapshot: EvidenceBasisView["class_context"]): string {
  if (!snapshot) return "当时班级未记录";
  return `${snapshot.class_name} · ${CLASS_STAGE_LABELS[snapshot.stage]}`;
}

function quoteSourceLabel(source: EvidenceBasisView): string {
  if (source.quote_source === "raw_text") return "原始观察原文";
  return source.quote_field === "highlights" ? "教师确认稿 · 证据片段" : "教师确认稿 · 原文引用";
}

function supportLabel(support: GuideEvidenceSupportKind, evidenceType: GuideItemEvidenceType): string {
  return evidenceType === "health_reference" ? HEALTH_SUPPORT_LABELS[support] : SUPPORT_LABELS[support];
}

function itemRuleLine(item: GuidePerformanceItem): string {
  if (item.product_rules.evidence_type === "health_reference") {
    return "这类资料仅作保育参考，不参与行为表现统计，也不作正常或异常判断。";
  }
  const help =
    item.product_rules.adult_help === "allowed"
      ? "有成人帮助也可确认表现，请说明当时怎样帮助。"
      : "这项要求独立完成；有成人帮助时，先保留为相关线索。";
  return item.product_rules.evidence_type === "sustained" ? `${help} 需要结合跨日记录或有事实依据的连续观察纪要来看。` : help;
}

function findGoalContext(
  catalog: GuideCatalog,
  goalId: string,
): { domainName: string; subDomainName: string; goal: GuideGoal } | null {
  for (const domain of catalog.domains) {
    for (const subDomain of domain.sub_domains) {
      for (const goal of subDomain.goals) {
        if (goal.id === goalId) {
          return { domainName: domain.name, subDomainName: subDomain.name, goal };
        }
      }
    }
  }
  return null;
}

function BasisRow({ source }: { source: EvidenceBasisView }) {
  return (
    <li className={cx("basis-row")} data-testid="basis-row">
      <p className={cx("basis-meta")}>
        <span>{formatDateCn(source.observed_at)}</span>
        <span aria-hidden="true"> · </span>
        <span>{classContextLabel(source.class_context)}</span>
        <span aria-hidden="true"> · </span>
        <span>{quoteSourceLabel(source)}</span>
      </p>
      <blockquote className={cx("basis-quote")}>{source.quote}</blockquote>
      {!source.valid ? (
        <p className={cx("basis-invalid")}>
          这段记录暂时不能作为依据：{BASIS_INVALID_LABELS[source.invalid_reason ?? "quote_not_found"]}。
        </p>
      ) : null}
    </li>
  );
}

function LinkBlock({ link, evidenceType }: { link: EvidenceLinkView; evidenceType: GuideItemEvidenceType }) {
  const isReference = evidenceType === "health_reference";
  return (
    <li
      className={cx("link-block")}
      data-testid="evidence-link"
      data-counts={link.counts_toward_status}
      data-link-status={link.status}
      data-link-id={link.link_id}
    >
      <div className={cx("link-head")}>
        <span
          className={cx("link-status", isReference ? HEALTH_LINK_STATUS_CLASS[link.status] : LINK_STATUS_CLASS[link.status])}
        >
          {isReference ? HEALTH_LINK_STATUS_LABELS[link.status] : GUIDE_EVIDENCE_LINK_STATUS_LABELS[link.status]}
        </span>
        <span className={cx("link-meta")}>{isReference ? HEALTH_ORIGIN_LABELS[link.origin] : ORIGIN_LABELS[link.origin]}</span>
        {link.support ? (
          <span className={cx("link-meta")}>{supportLabel(link.support, evidenceType)}</span>
        ) : null}
        {!link.counts_toward_status && link.excluded_reason ? (
          <span className={cx("link-excluded")}>
            {EXCLUSION_REASON_LABELS[link.excluded_reason]}
          </span>
        ) : null}
      </div>
      {link.status === "ai_suggested" && link.ai_reason ? (
        <p className={cx("link-note")}>建议说明：{link.ai_reason}</p>
      ) : null}
      {link.adult_help_used ? (
        <p className={cx("link-note")}>
          当时有成人帮助
          {link.teacher_note ? ` · 老师备注：${link.teacher_note}` : "（尚未说明帮助方式）"}
        </p>
      ) : link.teacher_note ? (
        <p className={cx("link-note")}>老师备注：{link.teacher_note}</p>
      ) : null}
      {link.sustained_note ? (
        <p className={cx("link-note")}>
          连续观察纪要（{link.sustained_note.period_start} 至 {link.sustained_note.period_end}）：
          {link.sustained_note.description}
        </p>
      ) : null}
      {link.withdrawn_at ? (
        <p className={cx("link-note")}>
          撤回于 {formatDateTimeCn(link.withdrawn_at)}
          {link.withdrawn_reason ? ` · 撤回原因：${link.withdrawn_reason}` : ""}
        </p>
      ) : null}
      <ul className={cx("basis-list")}>
        {link.basis.map((source, index) => (
          <BasisRow key={`${link.link_id}-${source.observation_id}-${index}`} source={source} />
        ))}
      </ul>
    </li>
  );
}

function EvidenceItemRow({
  item, child, expanded, onToggle, onRecordObservation,
}: {
  item: ChildGuideItemView;
  child: EvidenceChildRef;
  expanded: boolean;
  onToggle: () => void;
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
}) {
  const panelId = `evidence-panel-${item.item.id}`;
  const unreadable = item.reliability === "unavailable";
  const reference = item.item.product_rules.evidence_type === "health_reference";
  const formalLinks = item.links.filter((link) => link.counts_toward_status &&
    link.basis.length > 0 && link.basis.every((source) => source.valid && source.observation_status === "confirmed"));
  const auditLinks = item.links.filter((link) => !formalLinks.includes(link));
  const byObservation = new Map<string, EvidenceBasisView[]>();
  for (const link of formalLinks) {
    for (const source of link.basis) {
      const sources = byObservation.get(source.observation_id) ?? [];
      if (!sources.some((other) => other.quote === source.quote && other.quote_source === source.quote_source && other.quote_field === source.quote_field)) sources.push(source);
      byObservation.set(source.observation_id, sources);
    }
  }
  const records = [...byObservation.values()].sort((a, b) => b[0].observed_at.localeCompare(a[0].observed_at));
  const pendingCount = item.links.filter((link) => link.status === "ai_suggested").length;
  function renderRecord(sources: EvidenceBasisView[]) {
    const recordLinks = formalLinks.filter((link) => link.basis.every((basis) => basis.observation_id === sources[0].observation_id));
    return <div key={sources[0].observation_id} data-observation-id={sources[0].observation_id}><ul className={cx("basis-list")}>
      {sources.map((source, index) => <BasisRow key={source.observation_id + ":" + index} source={source} />)}
    </ul>{recordLinks.map((link) => <div key={link.link_id}>
      {link.teacher_note ? <p className={cx("link-note")}>老师备注：{link.teacher_note}</p> : null}
      {link.sustained_note ? <p className={cx("link-note")}>连续观察纪要（{link.sustained_note.period_start} 至 {link.sustained_note.period_end}）：{link.sustained_note.description}</p> : null}
    </div>)}</div>;
  }
  return (
    <li className={cx("evidence-item", expanded && "evidence-item-open")} data-testid="evidence-item"
      data-item-id={item.item.id} data-status={item.status} data-reliability={item.reliability}>
      {item.reliability !== "reliable" ? <p className={cx("reliability-note")} data-reliability={item.reliability} data-testid="reliability-note">{RELIABILITY_NOTICE[item.reliability]}</p> : null}
      <div className={cx("item-heading")}>
        <p className={cx("item-text")} data-testid="item-text">{item.item.text}</p>
        <button type="button" className={cx("item-disclosure")} aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined} onClick={onToggle} data-testid="item-disclosure">
          {expanded ? "收起记录" : "查看记录"}<ChevronDown className={cx("disclosure-icon", expanded && "disclosure-icon-open")} aria-hidden="true" />
        </button>
      </div>
      <div className={cx("item-top")} data-testid="item-top">
        {unreadable ? <span className={cx("item-unreadable")} data-testid="item-unreadable"><CircleAlert className={cx("unreadable-icon")} aria-hidden="true" />资料暂不可读</span> :
          reference ? <span className={cx("item-reference")} data-testid="item-reference"><BookOpen className={cx("reference-icon")} aria-hidden="true" />资料参考</span> :
            item.reliability === "partial" && item.status === "no_records" ? <span className={cx("item-pending")}>还有记录待核对</span> :
            <span className={cx("item-status", STATUS_CLASS[item.status])} data-testid="item-status">{GUIDE_ITEM_EVIDENCE_STATUS_LABELS[item.status]}</span>}
        <span className={cx("item-chip")}>指南参考 · {GUIDE_AGE_BAND_LABELS[item.item.age_band]}</span>
        {!unreadable && records.length > 0 ? <span className={cx("item-meta")}>{records.length} 条{reference ? "参考资料" : "相关记录"}{item.latest_observed_at ? ` · 最近 ${formatDateCn(item.latest_observed_at)}` : ""}</span> : null}
        {pendingCount > 0 ? <span className={cx("item-pending")}>AI 待核对 {pendingCount} 条</span> : null}
      </div>
      {expanded ? <div className={cx("item-panel")} id={panelId}>
        {records.length > 0 && !unreadable ? <section className={cx("source-group")} aria-label={reference ? "可查阅的参考资料" : "支持这项表现的记录"}>
          {renderRecord(records[0])}
          {records.length > 1 ? <details className={cx("more-records")}><summary>查看另 {records.length - 1} 条记录</summary>{records.slice(1).map(renderRecord)}</details> : null}
        </section> : <p className={cx("source-empty")}>{unreadable ? "暂时读不到相关记录，请重新读取页面。" : item.reliability === "partial" ? "有些记录还不能核对，可先查看其他关联记录。" : reference ? "本次查看范围还没有已核对的参考资料。" : "这项目前还没有对应的观察记录。"}</p>}
        <details className={cx("item-explanation")}><summary>查看这项的说明</summary><p className={cx("item-rule")}>{itemRuleLine(item.item)}</p></details>
        {auditLinks.length > 0 ? <details className={cx("source-group")} aria-label="其他关联记录">
          <summary className={cx("source-group-title")}>其他关联记录 · {auditLinks.length} 条</summary>
          <ul className={cx("link-list")}>{auditLinks.map((link) => <LinkBlock key={link.link_id} link={link} evidenceType={item.item.product_rules.evidence_type} />)}</ul>
        </details> : null}
        {formalLinks.length > 0 ? <details className={cx("source-group")}><summary>查看关联详情</summary><ul className={cx("link-list")}>{formalLinks.map((link) => <LinkBlock key={link.link_id} link={link} evidenceType={item.item.product_rules.evidence_type} />)}</ul></details> : null}
        {onRecordObservation ? <div className={cx("panel-actions")}><button type="button" className={cx("record-button")} onClick={() => onRecordObservation(child, item.item)} data-testid="record-observation"><PenLine className={cx("record-icon")} aria-hidden="true" />记录相关观察</button></div> : null}
      </div> : null}
    </li>
  );
}

export function ChildEvidenceBook({
  book,
  semesters,
  onScopeChange,
  onFiltersChange,
  onRecordObservation,
  focusedItemId,
  className,
}: ChildEvidenceBookProps) {
  const scopeSelectId = useId();
  const domainGroupId = useId();
  const ageGroupId = useId();
  const moreFiltersId = useId();
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const preferredGoal = book.goals.find((group) => group.items.some((item) =>
    item.item.product_rules.evidence_type !== "health_reference" && item.links.some((link) => link.counts_toward_status),
  )) ?? book.goals[0];
  const focusedGoal = focusedItemId ? book.goals.find((group) => group.items.some((item) => item.item.id === focusedItemId)) : undefined;
  const preferredItemId = focusedItemId ?? preferredGoal?.items.find((item) =>
    item.item.product_rules.evidence_type !== "health_reference" && item.links.some((link) => link.counts_toward_status),
  )?.item.id;
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set(preferredItemId ? [preferredItemId] : []));
  const [readingGoalId, setReadingGoalId] = useState(() => focusedGoal?.goal.id ?? book.filters.goal_id ?? preferredGoal?.goal.id ?? "all");
  const goalReadingId = book.filters.goal_id ?? (readingGoalId === "all" || book.goals.some((group) => group.goal.id === readingGoalId)
    ? readingGoalId : preferredGoal?.goal.id ?? "all");
  const visibleGoals = goalReadingId === "all" ? book.goals : book.goals.filter((group) => group.goal.id === goalReadingId);
  const readingGoalSelectId = useId();
  const [clientReady, setClientReady] = useState(false);
  useEffect(() => { setClientReady(true); }, []);
  useEffect(() => {
    if (!focusedItemId || !focusedGoal) return;
    setReadingGoalId(focusedGoal.goal.id);
    setExpandedIds(new Set([focusedItemId]));
  }, [focusedItemId, focusedGoal]);
  const [draft, setDraft] = useState(() => ({
    open: book.scope.kind === "custom_range",
    from: book.scope.kind === "custom_range" ? (book.scope.start_date ?? "") : "",
    to: book.scope.kind === "custom_range" ? (book.scope.end_date ?? "") : "",
  }));
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    if (book.scope.kind !== "custom_range") return;
    setDraft({
      open: true,
      from: book.scope.start_date ?? "",
      to: book.scope.end_date ?? "",
    });
  }, [book.scope.kind, book.scope.start_date, book.scope.end_date]);

  const semesterOptions = useMemo(() => {
    const options = (semesters ?? []).map((semester) => ({
      value: `semester:${semester.id}` as ScopeSelectValue,
      label: semester.label,
    }));
    if (book.scope.kind === "semester") {
      const currentValue = `semester:${book.scope.semester_id ?? ""}` as ScopeSelectValue;
      if (!options.some((option) => option.value === currentValue)) {
        options.unshift({ value: currentValue, label: `${book.scope.label}（当前）` });
      }
    }
    return options;
  }, [semesters, book.scope]);

  const domainLabelBySubDomainId = useMemo(() => {
    const map = new Map<string, string>();
    for (const domain of book.catalog.domains) {
      for (const subDomain of domain.sub_domains) {
        map.set(subDomain.id, `${domain.name} · ${subDomain.name}`);
      }
    }
    return map;
  }, [book.catalog]);

  const goalContext = book.filters.goal_id ? findGoalContext(book.catalog, book.filters.goal_id) : null;
  const draftApplied =
    book.scope.kind === "custom_range" &&
    draft.from === (book.scope.start_date ?? "") &&
    draft.to === (book.scope.end_date ?? "");
  /* 生效范围是 custom_range 时编辑区始终可达；其余范围按草稿开关显示 */
  const draftOpen = draft.open || book.scope.kind === "custom_range";

  function toggleItem(itemId: string) {
    setExpandedIds((previous) => {
      return previous.has(itemId) ? new Set() : new Set([itemId]);
    });
  }

  function handleScopeSelect(value: string) {
    if (value === "custom_range") {
      setDraft((previous) => ({ ...previous, open: true }));
      return;
    }
    /* 不关闭日期草稿：book.scope 仍是 custom_range 时（父级拒绝/请求失败），编辑区必须保持可达 */
    setRangeError(null);
    if (value === "all_history") {
      onScopeChange?.({ kind: "all_history" });
      return;
    }
    if (value.startsWith("semester:")) {
      onScopeChange?.({ kind: "semester", semester_id: value.slice("semester:".length) });
    }
  }

  function applyCustomRange() {
    if (!draft.from || !draft.to) {
      setRangeError("请选择开始和结束日期。");
      return;
    }
    const parsedFrom = parseIsoDateStrict(draft.from);
    const parsedTo = parseIsoDateStrict(draft.to);
    if (!parsedFrom || !parsedTo) {
      setRangeError("日期不存在，请重新选择。");
      return;
    }
    if (parsedFrom.getTime() > parsedTo.getTime()) {
      setRangeError("开始日期不能晚于结束日期。");
      return;
    }
    setRangeError(null);
    onScopeChange?.({ kind: "custom_range", from: draft.from, to: draft.to });
  }

  const identityClass = classLabel(book.child.stage, book.child.class_name);

  return (
    <section
      className={[styles.book, className].filter(Boolean).join(" ")}
      aria-label={`${book.child.name}的个人证据册`}
      data-testid="child-evidence-book"
      data-client-ready={clientReady}
    >
      <header className={cx("book-head")}>
        <h2 className={cx("book-title")}>{book.child.name}的观察证据</h2>
        <p className={cx("book-identity")}>
          {identityClass || "当前未分班"}
        </p>
      </header>

      {book.notices.length > 0 ? (
        <details className={cx("book-notices")}>
          <summary>{book.notices.some((notice) => notice.severity !== "info") ? "有些记录需要核对 · 查看说明" : "查看记录说明"}</summary>
        <ul className={cx("notice-list")}>
          {book.notices.map((notice, index) => (
            <li
              key={`${notice.code}-${index}`}
              className={cx("notice", `notice-${notice.severity}`)}
              data-testid="book-notice"
            >
              <span className={cx("notice-severity")}>{NOTICE_SEVERITY_LABELS[notice.severity]}</span>
              {notice.message}
            </li>
          ))}
        </ul>
        </details>
      ) : null}

      <div className={cx("controls")}>
        <div className={cx("control-block")}>
          <label className={cx("control-label")} htmlFor={scopeSelectId}>
            查看时间
          </label>
          <select
            id={scopeSelectId}
            className={cx("select")}
            value={scopeSelectValue(book.scope)}
            onChange={(event) => handleScopeSelect(event.target.value)}
            disabled={!onScopeChange}
            data-testid="scope-select"
          >
            {semesterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value="all_history">全部历史</option>
            <option value="custom_range">自定义日期…</option>
          </select>
          {draftOpen ? (
            <div className={cx("custom-range")} data-testid="custom-range-draft" data-applied={draftApplied}>
              <p className={cx("draft-status")} data-testid="draft-status">
                自定义日期{draftApplied ? "（已应用）" : "（尚未应用）"}
              </p>
              <div className={cx("date-row")}>
                <label className={cx("date-field")}>
                  从
                  <input
                    type="date"
                    value={draft.from}
                    onChange={(event) => setDraft((previous) => ({ ...previous, from: event.target.value }))}
                    data-testid="range-from"
                  />
                </label>
                <label className={cx("date-field")}>
                  到
                  <input
                    type="date"
                    value={draft.to}
                    onChange={(event) => setDraft((previous) => ({ ...previous, to: event.target.value }))}
                    data-testid="range-to"
                  />
                </label>
                <button
                  type="button"
                  className={cx("apply-button")}
                  onClick={applyCustomRange}
                  disabled={!onScopeChange}
                >
                  应用日期
                </button>
              </div>
              {rangeError ? (
                <p className={cx("range-error")} role="alert">
                  {rangeError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={cx("control-block")}>
          <span className={cx("control-label")} id={domainGroupId}>
            领域
          </span>
          <div className={cx("segmented")} role="group" aria-labelledby={domainGroupId}>
            <button
              type="button"
              className={cx("segment")}
              aria-pressed={book.filters.domain_code === null}
              disabled={!onFiltersChange}
              onClick={() => onFiltersChange?.({ ...book.filters, domain_code: null, goal_id: null })}
              data-testid="domain-tab"
              data-domain="all"
            >
              全部
            </button>
            {book.catalog.domains.map((entry) => (
              <button
                key={entry.code}
                type="button"
                className={cx("segment")}
                aria-pressed={book.filters.domain_code === entry.code}
                disabled={!onFiltersChange}
                onClick={() => onFiltersChange?.({ ...book.filters, domain_code: entry.code, goal_id: null })}
                data-testid="domain-tab"
                data-domain={entry.code}
              >
                {entry.name}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className={cx("more-filters-toggle")} aria-expanded={moreFiltersOpen}
          aria-controls={moreFiltersId} data-testid="more-filters-toggle" onClick={() => setMoreFiltersOpen((value) => !value)}>
          筛选与说明 · {book.filters.age_band ? GUIDE_AGE_BAND_LABELS[book.filters.age_band] : "全部参考年龄"}<ChevronDown aria-hidden="true" />
        </button>
        <div id={moreFiltersId} className={cx("more-filters")} data-open={moreFiltersOpen}>
        <div className={cx("control-block", "age-filter")}>
          <span className={cx("control-label")} id={ageGroupId}>
            参考年龄
          </span>
          <select className={cx("select")} aria-labelledby={ageGroupId} value={book.filters.age_band ?? "all"}
            disabled={!onFiltersChange} data-testid="age-select" onChange={(event) => {
              const option = AGE_BAND_OPTIONS.find((entry) => (entry.value ?? "all") === event.target.value);
              if (option) onFiltersChange?.({ ...book.filters, age_band: option.value });
            }}>
            {AGE_BAND_OPTIONS.map((option) => <option key={option.label} value={option.value ?? "all"}>{option.label}</option>)}
          </select>
        </div>
        <div className={cx("control-block", "goal-filter")}>
          <label className={cx("control-label")} htmlFor={readingGoalSelectId}>查看目标</label>
          <select id={readingGoalSelectId} className={cx("select")} value={goalReadingId}
            onChange={(event) => setReadingGoalId(event.target.value)} disabled={Boolean(book.filters.goal_id)} data-testid="reading-goal-select">
            <option value="all">全部目标</option>
            {book.goals.map((group) => <option key={group.goal.id} value={group.goal.id}>{group.goal.title}</option>)}
          </select>
        </div>
        <details className={cx("book-help")}>
          <summary>指南说明</summary>
          <p>这些记录对应具体的指南条目。暂无相关记录不代表孩子不会；参考年龄也不是达标期限。</p>
          <p>时间按观察发生日期查看，个人历史不会因为当前学段而被排除。成人帮助是否允许，以具体条目的要求为准。</p>
        </details>
        </div>
      </div>

      {book.filters.goal_id ? (
        <div className={cx("goal-scope")} data-testid="goal-scope-banner">
          <p className={cx("goal-scope-text")}>
            当前只查看目标：
            {goalContext
              ? `${goalContext.domainName} · ${goalContext.subDomainName} · ${goalContext.goal.index} ${goalContext.goal.title}`
              : book.filters.goal_id}
          </p>
          <button
            type="button"
            className={cx("goal-scope-release")}
            disabled={!onFiltersChange}
            onClick={() => onFiltersChange?.({ ...book.filters, goal_id: null })}
            data-testid="goal-scope-release"
          >
            查看全部目标
          </button>
        </div>
      ) : null}

      {book.goals.length === 0 ? (
        <p className={cx("book-empty")}>当前筛选下没有可展示的表现条目。</p>
      ) : (
        <div className={cx("goals")}>
          {visibleGoals.map(({ goal, items }) => (
            <section key={goal.id} className={cx("goal-group")} aria-labelledby={`goal-${goal.id}`}>
              <h3 className={cx("goal-title")} id={`goal-${goal.id}`}>
                {book.filters.domain_code === null ? (
                  <span className={cx("goal-domain")}>
                    {domainLabelBySubDomainId.get(goal.sub_domain_id) ?? "未定位领域"}
                  </span>
                ) : null}
                <span className={cx("goal-index")}>{goal.index}</span>
                {goal.title}
              </h3>
              <ul className={cx("item-list")}>
                {items.map((item) => (
                  <EvidenceItemRow
                    key={item.item.id}
                    item={item}
                    child={book.child}
                    expanded={expandedIds.has(item.item.id)}
                    onToggle={() => toggleItem(item.item.id)}
                    onRecordObservation={onRecordObservation}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
