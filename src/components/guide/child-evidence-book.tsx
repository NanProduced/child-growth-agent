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
  className?: string;
}

const EXCLUSION_REASON_LABELS: Record<EvidenceExclusionReason, string> = {
  workflow_pending: "AI 关联待核对，尚未由教师确认",
  teacher_rejected: "教师已不采用",
  withdrawn: "已撤回",
  basis_invalid: "依据未通过核对",
  basis_out_of_period: "依据的观察日期不在所选期间内",
  catalog_mismatch: "目录版本不一致",
  support_insufficient: "支持条件不足",
  history_unknown: "发生班级历史未知",
  out_of_stage_evidence: "发生阶段不符合班级统计口径",
  unknown_status: "关联状态无法识别",
};

const BASIS_INVALID_LABELS: Record<EvidenceBasisInvalidReason, string> = {
  source_missing: "来源记录不存在",
  cross_child: "来源属于其他幼儿",
  not_confirmed: "来源观察尚未确认",
  quote_not_found: "片段无法在声明位置逐字核对",
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

const EVIDENCE_TYPE_LABELS: Record<GuideItemEvidenceType, string> = {
  behavior: "行为表现",
  sustained: "持续表现",
  health_reference: "保健参考",
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
  partial: "以下呈现只依据已核验的资料；另有部分资料未通过核对，未计入当前状态，可能还有未显示的相关证据。",
  unavailable: "该条目的相关记录暂时无法读取，不能按「暂无相关记录」理解，也不代表没有相关观察。",
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
  if (!snapshot) return "发生班级未知（历史记录未保存）";
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
  const age = GUIDE_AGE_BAND_LABELS[item.age_band];
  if (item.product_rules.evidence_type === "health_reference") {
    return `资料参考：指南参考 ${age} · 保育参考资料；仅作查阅与核对，不构成发展确认。`;
  }
  const type = EVIDENCE_TYPE_LABELS[item.product_rules.evidence_type];
  const help =
    item.product_rules.adult_help === "allowed"
      ? "允许成人帮助（说明帮助方式后可确认表现）"
      : "要求独立完成（有成人帮助只确认线索）";
  return `条目规则：指南参考 ${age} · ${type} · ${help}`;
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
          该依据未通过核对：{BASIS_INVALID_LABELS[source.invalid_reason ?? "quote_not_found"]}
          。不参与正式状态，仅保留审计展示。
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
            未计入当前状态：{EXCLUSION_REASON_LABELS[link.excluded_reason]}
          </span>
        ) : null}
      </div>
      {link.status === "ai_suggested" && link.ai_reason ? (
        <p className={cx("link-note")}>AI 建议理由：{link.ai_reason}</p>
      ) : null}
      {link.adult_help_used ? (
        <p className={cx("link-note")}>
          本次有成人帮助
          {link.teacher_note ? ` · 教师说明：${link.teacher_note}` : "（教师未补充帮助方式）"}
        </p>
      ) : link.teacher_note ? (
        <p className={cx("link-note")}>教师说明：{link.teacher_note}</p>
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
  item,
  child,
  expanded,
  onToggle,
  onRecordObservation,
}: {
  item: ChildGuideItemView;
  child: EvidenceChildRef;
  expanded: boolean;
  onToggle: () => void;
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
}) {
  const panelId = `evidence-panel-${item.item.id}`;
  const unreadable = item.reliability === "unavailable";
  const isReference = item.item.product_rules.evidence_type === "health_reference";
  const countingObservationIds = new Set(
    item.links
      .filter((link) => link.counts_toward_status)
      .flatMap((link) => link.basis.map((source) => source.observation_id)),
  );
  const evidenceCount = countingObservationIds.size;
  const pendingCount = item.links.filter((link) => link.status === "ai_suggested").length;
  const formalLinks = item.links.filter((link) => link.counts_toward_status);
  const auditLinks = item.links.filter((link) => !link.counts_toward_status);

  return (
    <li
      className={cx("evidence-item")}
      data-testid="evidence-item"
      data-item-id={item.item.id}
      data-status={item.status}
      data-reliability={item.reliability}
    >
      {item.reliability !== "reliable" ? (
        <p className={cx("reliability-note")} data-reliability={item.reliability} data-testid="reliability-note">
          {RELIABILITY_NOTICE[item.reliability]}
        </p>
      ) : null}

      <div className={cx("item-top")} data-testid="item-top">
        {unreadable ? (
          <span className={cx("item-unreadable")} data-testid="item-unreadable">
            <CircleAlert className={cx("unreadable-icon")} aria-hidden="true" />
            资料暂不可读
          </span>
        ) : isReference ? (
          <span className={cx("item-reference")} data-testid="item-reference">
            <BookOpen className={cx("reference-icon")} aria-hidden="true" />
            资料参考
          </span>
        ) : (
          <span
            className={cx("item-status", STATUS_CLASS[item.status])}
            data-testid="item-status"
          >
            {GUIDE_ITEM_EVIDENCE_STATUS_LABELS[item.status]}
          </span>
        )}
        <span className={cx("item-chip")}>指南参考 · {GUIDE_AGE_BAND_LABELS[item.item.age_band]}</span>
        {!unreadable ? (
          <span className={cx("item-meta")}>
            {isReference
              ? evidenceCount > 0
                ? `收录 ${evidenceCount} 条参考资料${
                    item.latest_observed_at ? ` · 最近 ${formatDateCn(item.latest_observed_at)}` : ""
                  }`
                : "暂无已核验的参考资料"
              : evidenceCount > 0
                ? `相关证据 ${evidenceCount} 条${
                    item.latest_observed_at ? ` · 最近 ${formatDateCn(item.latest_observed_at)}` : ""
                  }`
                : item.reliability === "partial"
                  ? "暂无计入状态的已核验依据"
                  : "还没有计入状态的观察证据"}
          </span>
        ) : null}
        {pendingCount > 0 ? <span className={cx("item-pending")}>AI 待核对 {pendingCount} 条</span> : null}
        <button
          type="button"
          className={cx("item-disclosure")}
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={onToggle}
          data-testid="item-disclosure"
        >
          {expanded ? "收起证据" : "查看证据"}
          <ChevronDown className={cx("disclosure-icon", expanded && "disclosure-icon-open")} aria-hidden="true" />
        </button>
      </div>

      <p className={cx("item-text")} data-testid="item-text">
        {item.item.text}
      </p>

      {expanded ? (
        <div className={cx("item-panel")} id={panelId}>
          <p className={cx("item-rule")}>{itemRuleLine(item.item)}</p>
          {formalLinks.length > 0 ? (
            <section
              className={cx("source-group")}
              aria-label={isReference ? "可查阅的参考资料" : "计入当前状态的依据"}
            >
              <h4 className={cx("source-group-title")}>
                {isReference ? "可查阅的参考资料" : "计入当前状态的依据"}
              </h4>
              <ul className={cx("link-list")}>
                {formalLinks.map((link) => (
                  <LinkBlock key={link.link_id} link={link} evidenceType={item.item.product_rules.evidence_type} />
                ))}
              </ul>
            </section>
          ) : null}
          {auditLinks.length > 0 ? (
            <section className={cx("source-group")} aria-label="流程与审计记录">
              <h4 className={cx("source-group-title")}>流程与审计记录（不计入状态）</h4>
              <ul className={cx("link-list")}>
                {auditLinks.map((link) => (
                  <LinkBlock key={link.link_id} link={link} evidenceType={item.item.product_rules.evidence_type} />
                ))}
              </ul>
            </section>
          ) : null}
          {item.links.length === 0 ? (
            <p className={cx("source-empty")}>
              {unreadable
                ? "相关记录暂时无法读取，无法核对这个条目是否有观察证据。"
                : item.reliability === "partial"
                  ? "当前没有可计入状态的已核验依据；这不代表没有相关观察，可能有资料尚未核对。"
                  : isReference
                    ? "还没有可查阅的参考资料；记录相关观察后，这里会出现可核对的资料片段。"
                    : "还没有与该条目相关的观察记录。记录一次相关观察后，这里会出现可核对的事实片段。"}
            </p>
          ) : null}
          {onRecordObservation ? (
            <div className={cx("panel-actions")}>
              <button
                type="button"
                className={cx("record-button")}
                onClick={() => onRecordObservation(child, item.item)}
                data-testid="record-observation"
              >
                <PenLine className={cx("record-icon")} aria-hidden="true" />
                记录相关观察
              </button>
              <p className={cx("record-hint")}>带出这个条目，观察内容由你填写。</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ChildEvidenceBook({
  book,
  semesters,
  onScopeChange,
  onFiltersChange,
  onRecordObservation,
  className,
}: ChildEvidenceBookProps) {
  const scopeSelectId = useId();
  const domainGroupId = useId();
  const ageGroupId = useId();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
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
      const next = new Set(previous);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
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
    >
      <header className={cx("book-head")}>
        <h2 className={cx("book-title")}>个人证据册</h2>
        <p className={cx("book-identity")}>
          {book.child.name}
          {identityClass ? ` · ${identityClass}` : " · 当前未分班"}
        </p>
        <p className={cx("book-caption")}>对照《3—6岁儿童学习与发展指南》回看观察证据；指南是参考，观察才是表现证据。</p>
      </header>

      {book.notices.length > 0 ? (
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
      ) : null}

      <div className={cx("controls")}>
        <div className={cx("control-block")}>
          <label className={cx("control-label")} htmlFor={scopeSelectId}>
            统计期间
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
          <p className={cx("control-hint")}>按观察发生日期筛选，含首尾两天；个人历史回看不排除任何学段。</p>
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

        <div className={cx("control-block")}>
          <span className={cx("control-label")} id={ageGroupId}>
            指南参考年龄段
          </span>
          <div className={cx("segmented")} role="group" aria-labelledby={ageGroupId}>
            {AGE_BAND_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className={cx("segment")}
                aria-pressed={book.filters.age_band === option.value}
                disabled={!onFiltersChange}
                onClick={() => onFiltersChange?.({ ...book.filters, age_band: option.value })}
                data-testid="age-band-option"
                data-age-band={option.value ?? "all"}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className={cx("control-hint")}>参考 3～4 岁不等于“确定发生在小班时期”；实际历史以观察日期和发生班级为准。</p>
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
          {book.goals.map(({ goal, items }) => (
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
