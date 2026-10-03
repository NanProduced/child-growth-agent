"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, Leaf, PenLine } from "lucide-react";

import { classLabel, formatDateCn } from "@/lib/format";
import {
  GUIDE_AGE_BAND_LABELS,
  type GuideAgeBand,
  type GuideItemEvidenceType,
  type GuidePerformanceItem,
  type SemesterPeriod,
} from "@/lib/guide/types";
import {
  GUIDE_ITEM_EVIDENCE_STATUS_LABELS,
  type ClassChildItemStatus,
  type ClassEvidenceOverview,
  type ClassGuideItemView,
  type EvidenceChildRef,
  type EvidenceReliability,
  type EvidenceScope,
  type EvidenceViewFilters,
  type GuideItemEvidenceStatus,
} from "@/lib/guide/view-types";
import styles from "./class-evidence-overview.module.css";

/**
 * G4 班级指南证据概览：按当前在班名单回看五大领域的观察证据分布。
 * - 只读展示服务端 DTO（ClassEvidenceOverview）；人数、分母与占比全部读取 DTO，不从名单重算；
 * - 占比按班级页唯一例外口径展示，且同时给出“X/N 人 + 统计期间”；
 * - 期间与筛选只通过 typed callback 发出意图，正式取数与路由由 G6 接入；
 * - 班级页不展开来源细节，钻取到个人证据册核对来源。
 */

export type ClassEvidenceScopeIntent =
  | { kind: "semester"; semester_id: string }
  | { kind: "all_history" }
  | { kind: "custom_range"; from: string; to: string };

/** 钻取到个人证据册：同一筛选范围与对应条目原样带出，由 G6 组装路由 */
export interface ClassEvidenceDrilldown {
  child_id: string;
  item_id: string;
  child_status: GuideItemEvidenceStatus;
  scope: EvidenceScope;
  filters: EvidenceViewFilters;
}

export interface ClassEvidenceOverviewProps {
  overview: ClassEvidenceOverview;
  /** G2 显式学期配置（G6 传入）；缺省时仍可切“全部历史/自定义日期” */
  semesters?: SemesterPeriod[];
  onScopeChange?: (scope: ClassEvidenceScopeIntent) => void;
  /** 领域 / 指南参考年龄段筛选；null 表示不过滤，goal_id 原样透传 */
  onFiltersChange?: (filters: EvidenceViewFilters) => void;
  /** 进入该幼儿在同一筛选范围下的对应表现条目 */
  onOpenChildItem?: (target: ClassEvidenceDrilldown) => void;
  /** 复用现有记录流程；不预填内容 */
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  /** 现有活动支持入口（成长档案内） */
  onOpenActivitySupport?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  className?: string;
}

const STATUS_ORDER: readonly GuideItemEvidenceStatus[] = [
  "confirmed_observed",
  "has_clues",
  "no_records",
];

const STATUS_CLASS: Record<GuideItemEvidenceStatus, string> = {
  confirmed_observed: "status-observed",
  has_clues: "status-clue",
  no_records: "status-none",
};

const EVIDENCE_TYPE_LABELS: Record<GuideItemEvidenceType, string> = {
  behavior: "行为表现",
  sustained: "持续性表现",
  health_reference: "保健参考",
};

const NOTICE_SEVERITY_LABELS = {
  info: "提示",
  warning: "需要留意",
  error: "暂时不可用",
} as const;

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

function scopePeriodText(scope: EvidenceScope): string {
  if (scope.start_date && scope.end_date) {
    return `${scope.label}（${formatDateCn(scope.start_date)} 至 ${formatDateCn(scope.end_date)}，含首尾）`;
  }
  return `${scope.label}（不限日期）`;
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

interface RatioState {
  available: boolean;
  text: string;
}

function ratioState(item: ClassGuideItemView, scope: EvidenceScope): RatioState {
  if (item.confirmed_ratio !== null) {
    const percent = Math.round(item.confirmed_ratio * 100);
    return {
      available: true,
      text: `已确认观察到占比 ${percent}%（${item.counts.confirmed_observed}/${item.total} 人 · ${scope.label}）`,
    };
  }
  if (item.total === 0) {
    return { available: false, text: "占比暂不可用：当前在班名单为 0 人。" };
  }
  if (!item.item.product_rules.counts_in_behavior_stats) {
    return { available: false, text: "占比暂不可用：该条目为保健参考，不参与行为统计。" };
  }
  if (item.reliability === "unavailable") {
    return { available: false, text: "占比暂不可用：相关记录暂时无法读取。" };
  }
  if (item.reliability === "partial") {
    return { available: false, text: "占比暂不可用：部分记录未通过核对，人数为可确认下限。" };
  }
  return { available: false, text: "占比暂不可用：统计不可用。" };
}

function reliabilityHint(reliability: EvidenceReliability): string | null {
  if (reliability === "partial") {
    return "部分相关记录未通过核对或不在统计期间，人数是可确认的下限。";
  }
  if (reliability === "unavailable") {
    return "该条目的相关记录暂时无法读取，不能按「暂无相关记录」理解；仍显示当前名单分母。";
  }
  return null;
}

function ItemDistribution({ item }: { item: ClassGuideItemView }) {
  if (item.total === 0) {
    return <p className={cx("dist-empty")}>当前在班名单为 0 人，暂不统计该项。</p>;
  }
  if (item.reliability === "unavailable") {
    return (
      <div className={cx("dist-unavailable")} data-testid="item-unavailable">
        <strong>相关记录暂时无法读取</strong>
        <span>不能按「暂无相关记录」理解；当前名单 {item.total} 人仍作为分母保留。</span>
      </div>
    );
  }
  const lowerBound = item.reliability === "partial";
  const total = item.counts.confirmed_observed + item.counts.has_clues + item.counts.no_records;
  return (
    <div className={cx("dist")} data-testid="item-distribution" data-lower-bound={lowerBound}>
      <div className={cx("bar", lowerBound && "bar-lower")} aria-hidden="true">
        {STATUS_ORDER.map((status) => {
          const count = item.counts[status];
          if (count <= 0) return null;
          return (
            <span
              key={status}
              className={cx("seg", STATUS_CLASS[status])}
              style={{ flexGrow: count / (total || 1) }}
              data-testid="distribution-segment"
            />
          );
        })}
      </div>
      <ul className={cx("legend")}>
        {STATUS_ORDER.map((status) => (
          <li key={status} className={cx("legend-item")} data-status={status}>
            <span className={cx("legend-dot", STATUS_CLASS[status])} aria-hidden="true" />
            {GUIDE_ITEM_EVIDENCE_STATUS_LABELS[status]}
            <strong className={cx("legend-count")}>{item.counts[status]}</strong> 人
          </li>
        ))}
      </ul>
      {lowerBound ? <p className={cx("dist-lower")}>部分记录未通过核对，以上人数为可核验下限。</p> : null}
    </div>
  );
}

function ChildRow({
  entry,
  child,
  item,
  drilldown,
  onOpenChildItem,
  onRecordObservation,
  onOpenActivitySupport,
}: {
  entry: ClassChildItemStatus;
  child: EvidenceChildRef | undefined;
  item: GuidePerformanceItem;
  drilldown: ClassEvidenceDrilldown;
  onOpenChildItem?: (target: ClassEvidenceDrilldown) => void;
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  onOpenActivitySupport?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
}) {
  const childReliabilityHint = reliabilityHint(entry.reliability);
  return (
    <li
      className={cx("child-row")}
      data-testid="child-row"
      data-child-id={entry.child_id}
      data-status={entry.status}
      data-reliability={entry.reliability}
    >
      <div className={cx("child-line")}>
        <span className={cx("child-name")}>{child ? child.name : `名单幼儿（${entry.child_id}）`}</span>
        <span className={cx("child-status", STATUS_CLASS[entry.status])}>
          {GUIDE_ITEM_EVIDENCE_STATUS_LABELS[entry.status]}
        </span>
      </div>
      <p className={cx("child-meta")}>
        {entry.confirmed_link_count > 0 ? (
          <span>计入证据 {entry.confirmed_link_count} 条</span>
        ) : (
          <span>还没有计入状态的证据</span>
        )}
        {entry.latest_observed_at ? (
          <>
            <span aria-hidden="true"> · </span>
            <span>最近 {formatDateCn(entry.latest_observed_at)}</span>
          </>
        ) : null}
        {entry.pending_suggestion_count > 0 ? (
          <>
            <span aria-hidden="true"> · </span>
            <span className={cx("child-pending")}>
              AI 关联待核对 {entry.pending_suggestion_count} 条（不计入人数）
            </span>
          </>
        ) : null}
      </p>
      {childReliabilityHint ? (
        <p
          className={cx("child-reliability", entry.reliability === "unavailable" && "child-reliability-strong")}
        >
          {childReliabilityHint}
        </p>
      ) : null}
      <div className={cx("child-actions")}>
        <button
          type="button"
          className={cx("child-action", "child-action-primary")}
          disabled={!onOpenChildItem}
          onClick={() => onOpenChildItem?.(drilldown)}
          data-testid="open-child-item"
        >
          <ArrowUpRight className={cx("action-icon")} aria-hidden="true" />
          查看个人证据
        </button>
        <button
          type="button"
          className={cx("child-action")}
          disabled={!child || !onRecordObservation}
          onClick={() => {
            if (child && onRecordObservation) onRecordObservation(child, item);
          }}
          data-testid="record-observation"
        >
          <PenLine className={cx("action-icon")} aria-hidden="true" />
          记录观察
        </button>
        <button
          type="button"
          className={cx("child-action")}
          disabled={!child || !onOpenActivitySupport}
          onClick={() => {
            if (child && onOpenActivitySupport) onOpenActivitySupport(child, item);
          }}
          data-testid="open-activity-support"
        >
          <Leaf className={cx("action-icon")} aria-hidden="true" />
          活动支持
        </button>
      </div>
    </li>
  );
}

function ItemRow({
  item,
  scope,
  filters,
  rosterById,
  expanded,
  onToggle,
  onOpenChildItem,
  onRecordObservation,
  onOpenActivitySupport,
}: {
  item: ClassGuideItemView;
  scope: EvidenceScope;
  filters: EvidenceViewFilters;
  rosterById: ReadonlyMap<string, EvidenceChildRef>;
  expanded: boolean;
  onToggle: () => void;
  onOpenChildItem?: (target: ClassEvidenceDrilldown) => void;
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  onOpenActivitySupport?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
}) {
  const panelId = `class-evidence-panel-${item.item.id}`;
  const pendingCount = item.children.reduce((sum, entry) => sum + entry.pending_suggestion_count, 0);
  const ratio = ratioState(item, scope);
  const groups = STATUS_ORDER.map((status) => ({
    status,
    entries: item.children.filter((entry) => entry.status === status),
  })).filter((group) => group.entries.length > 0);

  return (
    <li
      className={cx("item")}
      data-testid="class-evidence-item"
      data-item-id={item.item.id}
      data-reliability={item.reliability}
      data-ratio={item.confirmed_ratio === null ? "null" : String(item.confirmed_ratio)}
    >
      <div className={cx("item-top")}>
        <span className={cx("item-chip")}>指南参考 · {GUIDE_AGE_BAND_LABELS[item.item.age_band]}</span>
        {item.item.product_rules.evidence_type !== "behavior" ? (
          <span className={cx("item-chip", "item-chip-muted")}>
            {EVIDENCE_TYPE_LABELS[item.item.product_rules.evidence_type]}
            {!item.item.product_rules.counts_in_behavior_stats ? " · 不参与行为统计" : ""}
          </span>
        ) : null}
        {pendingCount > 0 ? (
          <span className={cx("item-pending")}>AI 关联待核对 {pendingCount} 条（不计入人数）</span>
        ) : null}
        <button
          type="button"
          className={cx("disclosure")}
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={onToggle}
          data-testid="item-disclosure"
        >
          {expanded ? "收起名单" : "查看名单"}
          <ChevronDown className={cx("disclosure-icon", expanded && "disclosure-icon-open")} aria-hidden="true" />
        </button>
      </div>

      <div className={cx("item-body")}>
        <div className={cx("item-text-block")}>
          <p className={cx("item-text")}>{item.item.text}</p>
          {item.reliability !== "reliable" ? (
            <p className={cx("reliability-note")} data-reliability={item.reliability}>
              {reliabilityHint(item.reliability)}
            </p>
          ) : null}
        </div>
        <div className={cx("item-stats")}>
          <ItemDistribution item={item} />
          <p className={cx("ratio")} data-testid="item-ratio" data-available={ratio.available}>
            {ratio.text}
          </p>
        </div>
      </div>

      {expanded ? (
        <div className={cx("panel")} id={panelId}>
          <p className={cx("panel-rule")}>{itemRuleLine(item.item)}</p>
          <p className={cx("panel-hint")}>
            班级页只按幼儿汇总人数，不展开来源；进入个人证据册可核对每条来源、观察日期与发生班级。
          </p>
          {item.children.length === 0 ? (
            <p className={cx("panel-empty")}>当前在班名单为 0 人，暂无幼儿名单可展开。</p>
          ) : (
            groups.map((group) => (
              <section
                key={group.status}
                className={cx("status-group")}
                aria-label={`${GUIDE_ITEM_EVIDENCE_STATUS_LABELS[group.status]}的幼儿名单`}
                data-testid="status-group"
                data-status={group.status}
              >
                <h4 className={cx("status-group-title")}>
                  <span className={cx("legend-dot", STATUS_CLASS[group.status])} aria-hidden="true" />
                  {GUIDE_ITEM_EVIDENCE_STATUS_LABELS[group.status]}
                  <span className={cx("status-group-count")}>{group.entries.length} 人</span>
                </h4>
                <ul className={cx("child-list")}>
                  {group.entries.map((entry) => (
                    <ChildRow
                      key={entry.child_id}
                      entry={entry}
                      child={rosterById.get(entry.child_id)}
                      item={item.item}
                      drilldown={{
                        child_id: entry.child_id,
                        item_id: item.item.id,
                        child_status: entry.status,
                        scope,
                        filters,
                      }}
                      onOpenChildItem={onOpenChildItem}
                      onRecordObservation={onRecordObservation}
                      onOpenActivitySupport={onOpenActivitySupport}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      ) : null}
    </li>
  );
}

export function ClassEvidenceOverview({
  overview,
  semesters,
  onScopeChange,
  onFiltersChange,
  onOpenChildItem,
  onRecordObservation,
  onOpenActivitySupport,
  className,
}: ClassEvidenceOverviewProps) {
  const scopeSelectId = useId();
  const domainGroupId = useId();
  const ageGroupId = useId();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [customOpen, setCustomOpen] = useState(overview.scope.kind === "custom_range");
  const [customFrom, setCustomFrom] = useState(
    overview.scope.kind === "custom_range" ? (overview.scope.start_date ?? "") : "",
  );
  const [customTo, setCustomTo] = useState(
    overview.scope.kind === "custom_range" ? (overview.scope.end_date ?? "") : "",
  );
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    if (overview.scope.kind !== "custom_range") return;
    setCustomOpen(true);
    setCustomFrom(overview.scope.start_date ?? "");
    setCustomTo(overview.scope.end_date ?? "");
  }, [overview.scope.kind, overview.scope.start_date, overview.scope.end_date]);

  const rosterById = useMemo(
    () => new Map(overview.roster.children.map((child) => [child.id, child])),
    [overview.roster.children],
  );

  const semesterOptions = useMemo(() => {
    const options = (semesters ?? []).map((semester) => ({
      value: `semester:${semester.id}` as ScopeSelectValue,
      label: semester.label,
    }));
    if (overview.scope.kind === "semester") {
      const currentValue = `semester:${overview.scope.semester_id ?? ""}` as ScopeSelectValue;
      if (!options.some((option) => option.value === currentValue)) {
        options.unshift({ value: currentValue, label: `${overview.scope.label}（当前）` });
      }
    }
    return options;
  }, [semesters, overview.scope]);

  const selectValue: ScopeSelectValue = customOpen ? "custom_range" : scopeSelectValue(overview.scope);

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

  const referenceAgeText = overview.filters.age_band
    ? `指南参考 ${GUIDE_AGE_BAND_LABELS[overview.filters.age_band]}（不是达标期限）`
    : "全部年龄段（按条目各自的参考年龄阅读）";

  return (
    <section
      className={[styles.overview, className].filter(Boolean).join(" ")}
      aria-label={`${overview.class.name}的班级指南证据概览`}
      data-testid="class-evidence-overview"
    >
      <header className={cx("head")}>
        <h2 className={cx("title")}>班级指南证据概览</h2>
        <p className={cx("identity")}>
          {classLabel(overview.class.stage, overview.class.name)} · {overview.class.school_year}学年
          {overview.class.is_active ? null : <span className={cx("identity-flag")}>已停用</span>}
        </p>
        <p className={cx("caption")}>
          对照《3—6岁儿童学习与发展指南》查看当前在班幼儿的观察证据；指南是参考，观察才是表现证据。
        </p>
      </header>

      <dl className={cx("summary")} data-testid="class-summary">
        <div className={cx("summary-item")}>
          <dt>当前在班名单</dt>
          <dd>{overview.roster.child_count} 人</dd>
        </div>
        <div className={cx("summary-item")}>
          <dt>统计期间</dt>
          <dd>{scopePeriodText(overview.scope)}</dd>
        </div>
        <div className={cx("summary-item")}>
          <dt>指南参考年龄</dt>
          <dd>{referenceAgeText}</dd>
        </div>
        <div className={cx("summary-item")}>
          <dt>统计方式</dt>
          <dd>按观察发生日期筛选，按幼儿去重</dd>
        </div>
      </dl>

      <p className={cx("scope-note")}>
        期间与名单口径：所有期间都按当前在班名单（{overview.roster.child_count} 人）统计；切换历史期间只回看这些幼儿当时的证据，
        不能还原当时的班级名册，也不代表本班教学成效。
      </p>

      {overview.notices.length > 0 ? (
        <ul className={cx("notice-list")}>
          {overview.notices.map((notice, index) => (
            <li
              key={`${notice.code}-${index}`}
              className={cx("notice", `notice-${notice.severity}`)}
              data-testid="class-notice"
              data-code={notice.code}
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
              <button
                type="button"
                className={cx("apply-button")}
                onClick={applyCustomRange}
                disabled={!onScopeChange}
              >
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
              aria-pressed={overview.filters.domain_code === null}
              disabled={!onFiltersChange}
              onClick={() => onFiltersChange?.({ ...overview.filters, domain_code: null, goal_id: null })}
              data-testid="domain-tab"
              data-domain="all"
            >
              全部
            </button>
            {overview.catalog.domains.map((entry) => (
              <button
                key={entry.code}
                type="button"
                className={cx("segment")}
                aria-pressed={overview.filters.domain_code === entry.code}
                disabled={!onFiltersChange}
                onClick={() => onFiltersChange?.({ ...overview.filters, domain_code: entry.code, goal_id: null })}
                data-testid="domain-tab"
                data-domain={entry.code}
              >
                {entry.name}
              </button>
            ))}
          </div>
          <p className={cx("control-hint")}>切换领域只改变阅读范围，不改变人数统计口径。</p>
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
                aria-pressed={overview.filters.age_band === option.value}
                disabled={!onFiltersChange}
                onClick={() => onFiltersChange?.({ ...overview.filters, age_band: option.value })}
                data-testid="age-band-option"
                data-age-band={option.value ?? "all"}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className={cx("control-hint")}>
            参考年龄只用于阅读条目，不代表达标期限，也不回填证据发生时的班级或学段。
          </p>
        </div>
      </div>

      {overview.goals.length === 0 ? (
        <p className={cx("overview-empty")}>当前筛选下没有可展示的表现条目。</p>
      ) : (
        <div className={cx("goals")}>
          {overview.goals.map(({ goal, items }) => (
            <section key={goal.id} className={cx("goal-group")} aria-labelledby={`class-goal-${goal.id}`}>
              <h3 className={cx("goal-title")} id={`class-goal-${goal.id}`}>
                <span className={cx("goal-index")}>{goal.index}</span>
                {goal.title}
              </h3>
              <ul className={cx("item-list")}>
                {items.map((item) => (
                  <ItemRow
                    key={item.item.id}
                    item={item}
                    scope={overview.scope}
                    filters={overview.filters}
                    rosterById={rosterById}
                    expanded={expandedIds.has(item.item.id)}
                    onToggle={() => toggleItem(item.item.id)}
                    onOpenChildItem={onOpenChildItem}
                    onRecordObservation={onRecordObservation}
                    onOpenActivitySupport={onOpenActivitySupport}
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
