"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, PenLine } from "lucide-react";

import { classLabel, formatDateCn, formatDateTimeCn } from "@/lib/format";
import { CLASS_STAGE_LABELS } from "@/lib/types";
import {
  GUIDE_AGE_BAND_LABELS,
  type GuideAgeBand,
  type GuideEvidenceLinkOrigin,
  type GuideEvidenceLinkStatus,
  type GuideEvidenceSupportKind,
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
  /** 领域 / 指南参考年龄段筛选；null 表示不过滤，goal_id 原样透传 */
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

const EVIDENCE_TYPE_LABELS: Record<GuideItemEvidenceType, string> = {
  behavior: "行为表现",
  sustained: "持续表现",
  health_reference: "保健参考",
};

const ORIGIN_LABELS: Record<GuideEvidenceLinkOrigin, string> = {
  ai: "AI 建议",
  manual: "教师手动关联",
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

const AGE_BAND_OPTIONS: Array<{ value: GuideAgeBand | null; label: string }> = [
  { value: null, label: "全部" },
  { value: "3-4", label: GUIDE_AGE_BAND_LABELS["3-4"] },
  { value: "4-5", label: GUIDE_AGE_BAND_LABELS["4-5"] },
  { value: "5-6", label: GUIDE_AGE_BAND_LABELS["5-6"] },
];

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
  return source.quote_field === "highlights" ? "教师确认稿 · 亮点列表" : "教师确认稿 · 金句";
}

function itemRuleLine(item: GuidePerformanceItem): string {
  const age = GUIDE_AGE_BAND_LABELS[item.age_band];
  const type = EVIDENCE_TYPE_LABELS[item.product_rules.evidence_type];
  const help =
    item.product_rules.adult_help === "allowed"
      ? "允许成人帮助（说明帮助方式后可确认表现）"
      : "要求独立完成（有成人帮助只确认线索）";
  return `条目规则：指南参考 ${age} · ${type} · ${help}`;
}

function BasisRow({ source }: { source: EvidenceBasisView }) {
  return (
    <li className={cx("basis-row")}>
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

function LinkBlock({ link }: { link: EvidenceLinkView }) {
  return (
    <li className={cx("link-block")} data-testid="evidence-link" data-counts={link.counts_toward_status}>
      <div className={cx("link-head")}>
        <span className={cx("link-status", LINK_STATUS_CLASS[link.status])}>
          {GUIDE_EVIDENCE_LINK_STATUS_LABELS[link.status]}
        </span>
        <span className={cx("link-meta")}>{ORIGIN_LABELS[link.origin]}</span>
        {link.support ? <span className={cx("link-meta")}>{SUPPORT_LABELS[link.support]}</span> : null}
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
        {link.basis.map((source) => (
          <BasisRow key={`${link.link_id}-${source.observation_id}`} source={source} />
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
      <div className={cx("item-top")}>
        <span className={cx("item-status", STATUS_CLASS[item.status])}>
          {GUIDE_ITEM_EVIDENCE_STATUS_LABELS[item.status]}
        </span>
        <span className={cx("item-chip")}>指南参考 · {GUIDE_AGE_BAND_LABELS[item.item.age_band]}</span>
        {item.item.product_rules.evidence_type === "health_reference" ? (
          <span className={cx("item-chip")}>保健参考</span>
        ) : null}
        <span className={cx("item-meta")}>
          {evidenceCount > 0
            ? `相关证据 ${evidenceCount} 条${
                item.latest_observed_at ? ` · 最近 ${formatDateCn(item.latest_observed_at)}` : ""
              }`
            : "还没有计入状态的观察证据"}
        </span>
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

      {item.reliability !== "reliable" ? (
        <p className={cx("reliability-note")} data-reliability={item.reliability}>
          {item.reliability === "partial"
            ? "部分相关证据未通过核对或不在统计期间，当前状态是可确认的下限。"
            : "该条目的相关记录暂时无法读取，不能按「暂无相关记录」理解。"}
        </p>
      ) : null}

      <p className={cx("item-text")}>{item.item.text}</p>

      {expanded ? (
        <div className={cx("item-panel")} id={panelId}>
          <p className={cx("item-rule")}>{itemRuleLine(item.item)}</p>
          {formalLinks.length > 0 ? (
            <section className={cx("source-group")} aria-label="计入当前状态的依据">
              <h4 className={cx("source-group-title")}>计入当前状态的依据</h4>
              <ul className={cx("link-list")}>
                {formalLinks.map((link) => (
                  <LinkBlock key={link.link_id} link={link} />
                ))}
              </ul>
            </section>
          ) : null}
          {auditLinks.length > 0 ? (
            <section className={cx("source-group")} aria-label="流程与审计记录">
              <h4 className={cx("source-group-title")}>流程与审计记录（不计入状态）</h4>
              <ul className={cx("link-list")}>
                {auditLinks.map((link) => (
                  <LinkBlock key={link.link_id} link={link} />
                ))}
              </ul>
            </section>
          ) : null}
          {item.links.length === 0 ? (
            <p className={cx("source-empty")}>
              还没有与该条目相关的观察记录。记录一次相关观察后，这里会出现可核对的事实片段。
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
  const [customOpen, setCustomOpen] = useState(book.scope.kind === "custom_range");
  const [customFrom, setCustomFrom] = useState(book.scope.kind === "custom_range" ? (book.scope.start_date ?? "") : "");
  const [customTo, setCustomTo] = useState(book.scope.kind === "custom_range" ? (book.scope.end_date ?? "") : "");
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    if (book.scope.kind !== "custom_range") return;
    setCustomOpen(true);
    setCustomFrom(book.scope.start_date ?? "");
    setCustomTo(book.scope.end_date ?? "");
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

  const selectValue: ScopeSelectValue = customOpen ? "custom_range" : scopeSelectValue(book.scope);

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
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
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
    if (!customFrom || !customTo) {
      setRangeError("请选择开始和结束日期。");
      return;
    }
    if (customFrom > customTo) {
      setRangeError("开始日期不能晚于结束日期。");
      return;
    }
    setRangeError(null);
    onScopeChange?.({ kind: "custom_range", from: customFrom, to: customTo });
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
            value={selectValue}
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
          {customOpen ? (
            <div className={cx("custom-range")}>
              <label className={cx("date-field")}>
                从
                <input
                  type="date"
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  data-testid="range-from"
                />
              </label>
              <label className={cx("date-field")}>
                到
                <input
                  type="date"
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                  data-testid="range-to"
                />
              </label>
              <button type="button" className={cx("apply-button")} onClick={applyCustomRange} disabled={!onScopeChange}>
                应用日期
              </button>
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
              onClick={() => onFiltersChange?.({ ...book.filters, domain_code: null })}
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

      {book.goals.length === 0 ? (
        <p className={cx("book-empty")}>当前筛选下没有可展示的表现条目。</p>
      ) : (
        <div className={cx("goals")}>
          {book.goals.map(({ goal, items }) => (
            <section key={goal.id} className={cx("goal-group")} aria-labelledby={`goal-${goal.id}`}>
              <h3 className={cx("goal-title")} id={`goal-${goal.id}`}>
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
