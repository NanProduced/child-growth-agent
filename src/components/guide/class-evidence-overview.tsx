"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, BookOpen, ChevronDown, HelpCircle, Leaf, PenLine } from "lucide-react";

import { classLabel, formatDateCn, parseIsoDateStrict } from "@/lib/format";
import type { ClassStage } from "@/lib/types";
import { evidenceQueryString } from "@/lib/guide/navigation";
import { evidenceSourceLabel, peopleTicks, readClassEvidenceQuotes, type EvidenceQuoteRead } from "@/lib/guide/evidence-read";
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
 * G4-R1 / CLASS-EVIDENCE-UI2 班级指南证据概览：证据下钻工作台。
 * - 桌面双栏：左侧指南条目分布（实际班级人数坐标），右侧选中条目的原文、条件、三态名单与真实证据；
 * - 纯读服务端 DTO（ClassEvidenceOverview）；人数、分母与占比读取 DTO，不从名单重算；
 * - 可靠性优先于普通状态展示：不可读取的幼儿不归入普通三类名单，完全不可用时不画三类分布；
 * - partial 只展示可核验人数下限与“数据待核验”，不把余数推断为暂无记录；
 * - 保健参考条目单列查阅，不参与行为统计（不计占比），不做正常／异常判断；
 * - 统计说明集中在模态对话框，不在每行重复长警告段落；
 * - 依据片段异步复用 GET /api/children/[id]/evidence-book，真实数据展示，绝不捏造示例正文。
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
  /** 按幼儿当前可操作性决定“记录观察”入口；缺省时回调存在即可用 */
  canRecordChild?: (child: EvidenceChildRef) => boolean;
  /** 现有活动支持入口（成长档案内） */
  onOpenActivitySupport?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  /** Projection invalidation only; the GET route remains the authorization boundary. */
  readerIdentityKey?: string | null;
  onRevalidateIdentity?: () => void;
  onRefreshOverview?: () => void;
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

function isReferenceItem(item: ClassGuideItemView): boolean {
  return !item.item.product_rules.counts_in_behavior_stats;
}

function referenceNote(item: GuidePerformanceItem): string {
  if (item.product_rules.evidence_type === "health_reference") {
    return "身高、体重等体态参考只用于日常保育对照阅读，不参与行为表现统计（不计占比），也不作正常／异常判定；相关观察可在展开后查阅。";
  }
  return "该条目不参与行为表现统计（不计占比）；相关观察可在展开后查阅。";
}

/** 记录不可读取或核验受限的幼儿：可靠性优先于普通状态展示 */
function isRestrictedChild(entry: ClassChildItemStatus): boolean {
  if (entry.reliability === "unavailable") return true;
  return entry.reliability === "partial" && entry.status === "no_records";
}

function childCaveat(entry: ClassChildItemStatus): string | null {
  if (entry.reliability === "unavailable") {
    return "该幼儿的相关记录暂时无法读取，不能按「暂无相关记录」理解。";
  }
  if (entry.reliability === "partial") {
    return entry.status === "no_records"
      ? "该幼儿是否有相关记录暂无法确认：部分记录未通过核对。"
      : "该幼儿另有部分记录未通过核对，当前状态是可确认下限。";
  }
  return null;
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
  if (item.reliability === "unavailable") {
    return { available: false, text: "占比暂不可用：相关记录暂时无法读取。" };
  }
  if (item.reliability === "partial") {
    return { available: false, text: "占比暂不可用：部分记录未通过核对或无法读取，人数为可确认下限。" };
  }
  return { available: false, text: "占比暂不可用：统计不可用。" };
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
  return (
    <div className={cx("dist")} data-testid="item-distribution">
      <div className={cx("bar")} aria-hidden="true">
        {STATUS_ORDER.map((status) => {
          const count = item.counts[status];
          if (count <= 0) return null;
          return (
            <span
              key={status}
              className={cx("seg", STATUS_CLASS[status])}
              style={{ flexGrow: count, flexBasis: 0 }}
              title={`${GUIDE_ITEM_EVIDENCE_STATUS_LABELS[status]} ${count} 人`}
              data-testid="distribution-segment"
            >
              {count}
            </span>
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
    </div>
  );
}

/** partial：不画完整三类分布，只展示可核验依据摘要与核验限制 */
function PartialVerifiedSummary({ item }: { item: ClassGuideItemView }) {
  return (
    <div className={cx("dist-verified")} data-testid="partial-verified-summary">
      <p className={cx("verified-total")}>
        在班名单 <strong className={cx("legend-count")}>{item.total}</strong> 人
      </p>
      <ul className={cx("verified-list")}>
        <li className={cx("legend-item")} data-status="confirmed_observed">
          <span className={cx("legend-dot", STATUS_CLASS.confirmed_observed)} aria-hidden="true" />
          已确认观察到 <strong className={cx("legend-count")}>{item.counts.confirmed_observed}</strong> 人
        </li>
        <li className={cx("legend-item")} data-status="has_clues">
          <span className={cx("legend-dot", STATUS_CLASS.has_clues)} aria-hidden="true" />
          已有相关线索 <strong className={cx("legend-count")}>{item.counts.has_clues}</strong> 人
        </li>
      </ul>
      <p className={cx("verified-note")}>
        以上为服务端提供的可确认下限；其余幼儿是否暂无相关记录，因部分记录未通过核对或无法读取，暂无法确认。
      </p>
    </div>
  );
}

function referenceReliabilityNote(reliability: EvidenceReliability): string | null {
  if (reliability === "unavailable") {
    return "该条目的相关资料暂时无法读取，不能按「暂无相关资料」理解；仍保留当前名单与个人证据入口。";
  }
  if (reliability === "partial") {
    return "部分资料未通过核对或无法读取，以下只反映已读取并核对的资料范围。";
  }
  return null;
}

function ItemStats({ item, scope }: { item: ClassGuideItemView; scope: EvidenceScope }) {
  if (isReferenceItem(item)) {
    const caveat = referenceReliabilityNote(item.reliability);
    return (
      <div className={cx("dist-reference")} data-testid="reference-note" data-reliability={item.reliability}>
        <div className={cx("dist-reference-head")}>
          <BookOpen className={cx("dist-reference-icon")} aria-hidden="true" />
          <strong>{EVIDENCE_TYPE_LABELS[item.item.product_rules.evidence_type]}</strong>
        </div>
        <span>{referenceNote(item.item)}</span>
        {caveat ? (
          <span className={cx("reference-caveat")} data-testid="reference-caveat">
            {caveat}
          </span>
        ) : null}
      </div>
    );
  }
  const ratio = ratioState(item, scope);
  return (
    <>
      {item.reliability === "partial" ? <PartialVerifiedSummary item={item} /> : <ItemDistribution item={item} />}
      <p className={cx("ratio")} data-testid="item-ratio" data-available={ratio.available}>
        {ratio.available ? <>
          <span aria-hidden="true">{item.counts.confirmed_observed}/{item.total} 人 · {Math.round((item.confirmed_ratio ?? 0) * 100)}% 已确认</span>
          <span className={cx("visually-hidden")}>{ratio.text}</span>
        </> : ratio.text}
      </p>
    </>
  );
}

type ChildRowVariant = "status" | "restricted" | "reference" | "pending";

function ChildRow({
  entry,
  child,
  item,
  variant,
  drilldown,
  isActive,
  onSelect,
  onOpenChildItem,
  onRecordObservation,
  canRecordChild,
  onOpenActivitySupport,
}: {
  entry: ClassChildItemStatus;
  child: EvidenceChildRef | undefined;
  item: GuidePerformanceItem;
  variant: ChildRowVariant;
  drilldown: ClassEvidenceDrilldown;
  isActive?: boolean;
  onSelect?: () => void;
  onOpenChildItem?: (target: ClassEvidenceDrilldown) => void;
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  canRecordChild?: (child: EvidenceChildRef) => boolean;
  onOpenActivitySupport?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
}) {
  const caveat = childCaveat(entry);
  const showStatusBadge = variant === "status";
  const childName = child ? child.name : `名单幼儿（${entry.child_id}）`;
  const monogram = [...childName][0] ?? "";

  return (
    <li
      className={cx("child-row", isActive && "child-row-active")}
      data-testid="child-row"
      data-child-id={entry.child_id}
      data-status={entry.status}
      data-reliability={entry.reliability}
      data-variant={variant}
    >
      <div className={cx("child-line")}>
        <button type="button" className={cx("child-select")} onClick={onSelect}
          disabled={!onSelect} aria-pressed={Boolean(isActive)} data-testid="select-child-record"
          aria-label={`查看${childName}的相关记录`}>
          <span className={cx("child-avatar")} aria-hidden="true">{monogram}</span>
          <span className={cx("child-name")}>{childName}</span>
        </button>
        {showStatusBadge ? (
          <span className={cx("child-status", STATUS_CLASS[entry.status])} data-testid="child-status-badge">
            {GUIDE_ITEM_EVIDENCE_STATUS_LABELS[entry.status]}
          </span>
        ) : null}
        {variant === "restricted" ? (
          <span
            className={cx(
              "child-restricted-chip",
              entry.reliability === "unavailable" && "child-restricted-chip-strong",
            )}
            data-testid="child-restricted-chip"
          >
            {entry.reliability === "unavailable" ? "记录不可读取" : "核验受限"}
          </span>
        ) : null}
        {variant === "reference" ? (
          <span className={cx("child-reference-chip")} data-testid="child-reference-chip">
            有相关观察记录
          </span>
        ) : null}
        {variant === "pending" ? (
          <span className={cx("child-pending-chip")} data-testid="child-pending-chip">
            AI 关联待核对
          </span>
        ) : null}
      </div>
      <p className={cx("child-meta")}>
        {variant === "pending" ? (
          <span>待核对建议 {entry.pending_suggestion_count} 条 · 尚未成为已核验资料（不计入人数）</span>
        ) : variant === "reference" ? (
          entry.confirmed_link_count > 0 ? (
            <span>相关记录 {entry.confirmed_link_count} 条</span>
          ) : (
            <span>有相关观察记录</span>
          )
        ) : variant === "restricted" ? null : entry.confirmed_link_count > 0 ? (
          <span>计入证据 {entry.confirmed_link_count} 条</span>
        ) : (
          <span>还没有计入状态的证据</span>
        )}
        {(variant === "reference" || variant === "restricted") && entry.latest_observed_at ? (
          <>
            {variant === "reference" ? <span aria-hidden="true"> · </span> : null}
            <span>最近 {formatDateCn(entry.latest_observed_at)}</span>
          </>
        ) : variant === "status" && entry.latest_observed_at ? (
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
      {caveat && variant !== "restricted" ? (
        <p
          className={cx(
            "child-reliability",
            entry.reliability === "unavailable" && "child-reliability-strong",
          )}
        >
          {caveat}
        </p>
      ) : null}
      <div className={cx("child-actions")}>
        <button
          type="button"
          className={cx("child-action", "child-action-primary")}
          disabled={!onOpenChildItem}
          onClick={(event) => {
            event.stopPropagation();
            onOpenChildItem?.(drilldown);
          }}
          data-testid="open-child-item"
        >
          <ArrowUpRight className={cx("action-icon")} aria-hidden="true" />
          查看个人证据
        </button>
        {child && onRecordObservation && (!canRecordChild || canRecordChild(child)) ? <button
          type="button"
          className={cx("child-action")}
          disabled={!child || !onRecordObservation || (child && canRecordChild ? !canRecordChild(child) : false)}
          onClick={(event) => {
            event.stopPropagation();
            if (child && onRecordObservation) onRecordObservation(child, item);
          }}
          data-testid="record-observation"
        >
          <PenLine className={cx("action-icon")} aria-hidden="true" />
          记录观察
        </button> : null}
        {child && onOpenActivitySupport ? <button
          type="button"
          className={cx("child-action")}
          disabled={!child || !onOpenActivitySupport}
          onClick={(event) => {
            event.stopPropagation();
            if (child && onOpenActivitySupport) onOpenActivitySupport(child, item);
          }}
          data-testid="open-activity-support"
        >
          <Leaf className={cx("action-icon")} aria-hidden="true" />
          活动支持
        </button> : null}
      </div>
    </li>
  );
}

function ItemRow({
  item,
  index,
  scope,
  filters,
  rosterById,
  expanded,
  onToggle,
  onOpenChildItem,
  onRecordObservation,
  canRecordChild,
  onOpenActivitySupport,
  classStage,
  classId,
  catalogVersion,
  readerIdentityKey,
  onRevalidateIdentity,
  onRefreshOverview,
  panelOutlet,
}: {
  item: ClassGuideItemView;
  index: number;
  scope: EvidenceScope;
  filters: EvidenceViewFilters;
  rosterById: ReadonlyMap<string, EvidenceChildRef>;
  expanded: boolean;
  onToggle: () => void;
  onOpenChildItem?: (target: ClassEvidenceDrilldown) => void;
  onRecordObservation?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  canRecordChild?: (child: EvidenceChildRef) => boolean;
  onOpenActivitySupport?: (child: EvidenceChildRef, item: GuidePerformanceItem) => void;
  classStage: ClassStage;
  classId: string;
  catalogVersion: string;
  readerIdentityKey?: string | null;
  onRevalidateIdentity?: () => void;
  onRefreshOverview?: () => void;
  panelOutlet?: HTMLElement | null;
}) {
  const panelId = `class-evidence-panel-${item.item.id}`;
  const pendingCount = item.children.reduce((sum, entry) => sum + entry.pending_suggestion_count, 0);
  const reference = isReferenceItem(item);
  const referenceRelated = item.children.filter(
    (entry) => entry.status !== "no_records" && !isRestrictedChild(entry),
  );
  const referencePending = item.children.filter(
    (entry) => entry.pending_suggestion_count > 0 && entry.status === "no_records" && !isRestrictedChild(entry),
  );
  const normalGroups = STATUS_ORDER.map((status) => ({
    status,
    entries: item.children.filter((entry) => !isRestrictedChild(entry) && entry.status === status),
  })).filter((group) => group.entries.length > 0);
  const restrictedEntries = item.children.filter(isRestrictedChild);

  const [selectedChildId, setActiveChildId] = useState<string | null>(() => {
    return item.children[0]?.child_id ?? null;
  });
  const activeChildId = item.children.some((child) => child.child_id === selectedChildId)
    ? selectedChildId : item.children[0]?.child_id ?? null;
  const queryString = evidenceQueryString(scope, filters);
  const readKey = JSON.stringify([readerIdentityKey ?? null, activeChildId, item.item.id, classId, classStage, catalogVersion, queryString]);
  const [quoteRead, setQuoteRead] = useState<{ key: string; projection: ClassGuideItemView; value: EvidenceQuoteRead | { kind: "loading" } } | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  // A new target cannot render the previous target's quote, even before effects run.
  const currentRead = quoteRead?.key === readKey && quoteRead.projection === item ? quoteRead.value : null;
  const quoteInfo = currentRead?.kind === "ready" ? currentRead.sources[0] : null;
  const quoteLoading = Boolean(readerIdentityKey) && (!currentRead || currentRead.kind === "loading");

  useEffect(() => {
    if (!expanded || !activeChildId || !readerIdentityKey) { setQuoteRead(null); return; }
    const controller = new AbortController();
    setQuoteRead({ key: readKey, projection: item, value: { kind: "loading" } });
    void (async () => {
      try {
        const response = await fetch(`/api/children/${encodeURIComponent(activeChildId)}/evidence-book?${queryString}`, {
          signal: controller.signal, cache: "no-store", credentials: "same-origin",
        });
        const value = await readClassEvidenceQuotes(response, {
          childId: activeChildId, itemId: item.item.id, classStage, classId, catalogVersion, scope, filters,
        });
        if (controller.signal.aborted) return;
        setQuoteRead({ key: readKey, projection: item, value });
        if (value.kind === "unauthenticated") onRevalidateIdentity?.();
      } catch {
        if (!controller.signal.aborted) setQuoteRead({ key: readKey, projection: item, value: { kind: "unavailable" } });
      }
    })();
    return () => controller.abort();
    // Resource values are bound in readKey; objects themselves do not trigger duplicate reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, readKey, readAttempt, item]);

  function renderChild(entry: ClassChildItemStatus, variant: ChildRowVariant) {
    return (
      <ChildRow
        key={entry.child_id}
        entry={entry}
        child={rosterById.get(entry.child_id)}
        item={item.item}
        variant={variant}
        isActive={activeChildId === entry.child_id}
        onSelect={() => setActiveChildId(entry.child_id)}
        drilldown={{
          child_id: entry.child_id,
          item_id: item.item.id,
          child_status: entry.status,
          scope,
          filters,
        }}
        onOpenChildItem={onOpenChildItem}
        onRecordObservation={onRecordObservation}
        canRecordChild={canRecordChild}
        onOpenActivitySupport={onOpenActivitySupport}
      />
    );
  }

  const activeChildRef = activeChildId ? rosterById.get(activeChildId) : undefined;
  const activeChildStatus = item.children.find((c) => c.child_id === activeChildId);

  useEffect(() => {
    if (!expanded || !panelOutlet) return;
    const panel = document.getElementById(panelId);
    panel?.querySelector<HTMLElement>("[data-testid=select-child-record]")?.focus({ preventScroll: true });
  }, [expanded, panelOutlet, panelId]);

  function closePanel() {
    onToggle();
    requestAnimationFrame(() => document.getElementById(`class-trigger-${item.item.id}`)?.focus());
  }

  const inspector = expanded ? (
        <div className={cx("panel")} id={panelId} data-current-item-id={item.item.id}>
          <button type="button" className={cx("detail-back")} onClick={closePanel}>返回指南条目</button>
          <div className={cx("inspector-header")}>
            <h4 className={cx("inspector-title")}>指南条目详情</h4>
            <p className={cx("inspector-item-text")}>{item.item.text}</p>
            <div className={cx("inspector-tags")}>
              <span className={cx("inspector-tag")}>指南参考 · {GUIDE_AGE_BAND_LABELS[item.item.age_band]}</span>
              {!reference ? <span className={cx("inspector-tag", "inspector-tag-rule")}>{item.item.product_rules.adult_help === "allowed" ? "允许成人帮助" : "要求独立完成"}</span> : null}
            </div>
          </div>
          {activeChildRef && activeChildStatus ? <div className={cx("inspector-quote-card")}>
            <div className={cx("quote-card-head")}><span className={cx("quote-card-title")}>{activeChildRef.name}的观察证据</span>{quoteInfo ? <><span className={cx("quote-card-date")}>{formatDateCn(quoteInfo.observed_at)}</span><span className={cx("quote-card-badge")}>{evidenceSourceLabel(quoteInfo)}</span></> : null}</div>
            {quoteLoading ? <p role="status" className={cx("quote-card-loading")}>正在读取相关记录…</p> : quoteInfo ? <><p className={cx("panel-hint")}>当时班级：{quoteInfo.class_context?.class_name ?? "未记录"}</p><blockquote className={cx("quote-card-text")}>{quoteInfo.quote}</blockquote>{currentRead?.kind === "ready" && currentRead.partial ? <p className={cx("panel-hint")}>还有部分记录暂时不能核对。</p> : null}</> : currentRead && currentRead.kind !== "empty" ? <div role="status" className={cx("quote-card-empty")}><p>{currentRead.kind === "unauthenticated" ? "登录状态已变化，请重新核验账号。" : currentRead.kind === "forbidden" ? "当前账号不能读取这些记录。" : currentRead.kind === "invalid" ? "数据或所属范围已变化，请重新读取页面。" : "暂时读不到引用，请重新读取。"}</p><button type="button" className={cx("quote-card-btn")} onClick={() => { if (currentRead.kind === "invalid" && onRefreshOverview) onRefreshOverview(); else setReadAttempt((value) => value + 1); }}>重新读取</button></div> : <p className={cx("quote-card-empty")}>{readerIdentityKey ? "本次班级统计范围内没有可展示的引用。" : "可进入个人证据册核对相关记录。"}</p>}
            <div className={cx("quote-card-actions")}><button type="button" className={cx("quote-card-btn")} disabled={!onOpenChildItem} onClick={() => onOpenChildItem?.({ child_id: activeChildRef.id, item_id: item.item.id, child_status: activeChildStatus.status, scope, filters })}>查看{activeChildRef.name}证据册<ArrowUpRight className={cx("action-icon")} aria-hidden="true" /></button></div>
          </div> : null}
          <div className={cx("inspector-content")}>
            {reference ? (
              <>
                {item.reliability === "unavailable" ? <p className={cx("panel-warning")} data-testid="reference-unavailable">相关资料暂时读不到，以下保留名单与个人证据入口。</p> : <p className={cx("panel-hint")}>{item.reliability === "partial" ? "只显示能核对的资料，不代表不存在其他资料。" : "资料仅供查阅，不参与行为统计。"}</p>}
                {referenceRelated.length > 0 && item.reliability !== "unavailable" ? <section data-testid="reference-records" aria-label="已核验的相关观察记录"><h4 className={cx("status-group-title")}>已核验的相关观察记录 <span>{referenceRelated.length} 人</span></h4><ul className={cx("child-list")}>{referenceRelated.map((entry) => renderChild(entry, "reference"))}</ul></section> : null}
                {referencePending.length > 0 && item.reliability !== "unavailable" ? <section data-testid="reference-pending" aria-label="AI 关联待核对建议"><h4 className={cx("status-group-title")}>AI 关联待核对 <span>{referencePending.reduce((sum, entry) => sum + entry.pending_suggestion_count, 0)} 条（不计入已核验资料）</span></h4><ul className={cx("child-list")}>{referencePending.map((entry) => renderChild(entry, "pending"))}</ul></section> : null}
                {referenceRelated.length === 0 && referencePending.length === 0 && restrictedEntries.length === 0 && item.reliability !== "unavailable" ? <p className={cx("panel-empty")} data-testid="reference-empty">已读取范围内还没有可供查阅的相关观察记录。</p> : null}
              </>
            ) : item.reliability !== "unavailable" ? (
              <>
                {item.reliability === "partial" ? <p className={cx("panel-hint")} data-testid="partial-list-limit">名单只覆盖已读取记录；其余幼儿见核验受限名单。</p> : null}
                {normalGroups.map((group) => <section key={group.status} className={cx("status-group")} data-testid="status-group" data-status={group.status} aria-label={`${GUIDE_ITEM_EVIDENCE_STATUS_LABELS[group.status]}的幼儿名单`}><h4 className={cx("status-group-title")}><span className={cx("legend-dot", STATUS_CLASS[group.status])} aria-hidden="true" />{GUIDE_ITEM_EVIDENCE_STATUS_LABELS[group.status]}{item.reliability === "partial" && group.status === "no_records" ? "（已读取范围）" : ""}<span>{group.entries.length} 人</span></h4><ul className={cx("child-list")}>{group.entries.map((entry) => renderChild(entry, "status"))}</ul></section>)}
              </>
            ) : <p className={cx("panel-warning")}>相关记录暂时读不到，以下保留名单与个人证据入口。</p>}
            {(restrictedEntries.length > 0 || item.reliability === "unavailable") ? <section className={cx("restricted-group")} data-testid="restricted-group" data-group="restricted" aria-label="核验受限的幼儿"><h4 className={cx("status-group-title")}>核验受限，未计入{reference ? "已核验资料" : "普通名单"}<span>{item.reliability === "unavailable" ? item.children.length : restrictedEntries.length} 人</span></h4><ul className={cx("child-list")}>{(item.reliability === "unavailable" ? item.children : restrictedEntries).map((entry) => renderChild(entry, "restricted"))}</ul></section> : null}
          </div>

        </div>
      ) : null;

  return (
    <li
      className={cx("item", expanded && "item-expanded")}
      data-testid="class-evidence-item"
      data-item-id={item.item.id}
      data-reliability={item.reliability}
      data-ratio={item.confirmed_ratio === null ? "null" : String(item.confirmed_ratio)}
    >
      <div className={cx("item-row-main")}>
        <div className={cx("item-index")} aria-hidden="true">
          {index}
        </div>

        <div className={cx("item-content")}>
          <div className={cx("item-top")}>
            {!filters.age_band || reference ? <span className={cx("item-chip")}>指南参考 · {GUIDE_AGE_BAND_LABELS[item.item.age_band]}</span> : null}
            {item.item.product_rules.evidence_type !== "behavior" ? (
              <span className={cx("item-chip", "item-chip-muted")}>
                {EVIDENCE_TYPE_LABELS[item.item.product_rules.evidence_type]}
                {!item.item.product_rules.counts_in_behavior_stats ? " · 不参与行为统计" : ""}
              </span>
            ) : null}
            {pendingCount > 0 ? (
              <span className={cx("item-pending")}>AI 关联待核对 {pendingCount} 条（不计入人数）</span>
            ) : null}

          </div>

          <div className={cx("item-body")}>
            <div className={cx("item-text-block")}>
              <p className={cx("item-text")}>{item.item.text}</p>
            </div>
            <div className={cx("item-stats")}>
              <ItemStats item={item} scope={scope} />
            </div>
            <button
              id={`class-trigger-${item.item.id}`}
              type="button"
              className={cx("disclosure")}
              aria-expanded={expanded}
              aria-controls={expanded ? panelId : undefined}
              onClick={onToggle}
              data-testid="item-disclosure"
            >
              {expanded ? (reference ? "收起相关记录" : "收起名单") : reference ? "查阅相关记录" : "查看名单"}
              <ChevronDown className={cx("disclosure-icon", expanded && "disclosure-icon-open")} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {inspector ? (panelOutlet ? createPortal(inspector, panelOutlet) : inspector) : null}
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
  canRecordChild,
  onOpenActivitySupport,
  readerIdentityKey,
  onRevalidateIdentity,
  onRefreshOverview,
  className,
}: ClassEvidenceOverviewProps) {
  const scopeSelectId = useId();
  const domainGroupId = useId();
  const ageGroupId = useId();
  const noticeListId = useId();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [statsHelpOpen, setStatsHelpOpen] = useState(false);
  const statsHelpId = useId();
  const [panelOutlet, setPanelOutlet] = useState<HTMLDivElement | null>(null);
  const [clientReady, setClientReady] = useState(false);
  useEffect(() => { setClientReady(true); }, []);

  useEffect(() => {
    setDraft(null);
    setRangeError(null);
  }, [overview.scope.kind, overview.scope.semester_id, overview.scope.start_date, overview.scope.end_date]);

  const rosterById = useMemo(
    () => new Map(overview.roster.children.map((child) => [child.id, child])),
    [overview.roster.children],
  );

  const catalogIndex = useMemo(() => {
    const goals = new Map<
      string,
      { title: string; index: number; domainName: string; subDomainName: string }
    >();
    const domains = new Map<string, string>();
    const subDomains = new Map<string, string>();
    for (const domain of overview.catalog.domains) {
      domains.set(domain.id, domain.name);
      for (const sub of domain.sub_domains) {
        subDomains.set(sub.id, sub.name);
        for (const goal of sub.goals) {
          goals.set(goal.id, {
            title: goal.title,
            index: goal.index,
            domainName: domain.name,
            subDomainName: sub.name,
          });
        }
      }
    }
    return { goals, domains, subDomains };
  }, [overview.catalog]);

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

  const severeNotices = overview.notices.filter((notice) => notice.severity !== "info");
  const infoNotices = overview.notices.filter((notice) => notice.severity === "info");
  const activeGoal = overview.filters.goal_id ? catalogIndex.goals.get(overview.filters.goal_id) : undefined;

  function toggleItem(itemId: string) {
    setExpandedIds((previous) => {
      return previous.has(itemId) ? new Set() : new Set([itemId]);
    });
  }

  function openCustomDraft() {
    setDraft({
      from: overview.scope.start_date ?? "",
      to: overview.scope.end_date ?? "",
    });
    setRangeError(null);
  }

  function cancelCustomDraft() {
    setDraft(null);
    setRangeError(null);
  }

  function handleScopeSelect(value: string) {
    if (value === "custom_range") {
      openCustomDraft();
      return;
    }
    cancelCustomDraft();
    if (value === "all_history") {
      onScopeChange?.({ kind: "all_history" });
      return;
    }
    if (value.startsWith("semester:")) {
      onScopeChange?.({ kind: "semester", semester_id: value.slice("semester:".length) });
    }
  }

  function applyCustomDraft() {
    if (!draft) return;
    if (!draft.from || !draft.to) {
      setRangeError("请选择开始和结束日期。");
      return;
    }
    if (!parseIsoDateStrict(draft.from) || !parseIsoDateStrict(draft.to)) {
      setRangeError("日期格式不正确，请重新选择真实存在的日期。");
      return;
    }
    if (draft.from > draft.to) {
      setRangeError("开始日期不能晚于结束日期。");
      return;
    }
    setRangeError(null);
    onScopeChange?.({ kind: "custom_range", from: draft.from, to: draft.to });
  }

  const referenceAgeText = overview.filters.age_band
    ? `指南参考 ${GUIDE_AGE_BAND_LABELS[overview.filters.age_band]}（不是达标期限）`
    : "全部年龄段（按条目各自的参考年龄阅读）";

  const itemIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    let seq = 0;
    for (const group of overview.goals) {
      for (const item of group.items) {
        seq += 1;
        map.set(item.item.id, seq);
      }
    }
    return map;
  }, [overview.goals]);

  const referenceItems = overview.goals.flatMap((group) => group.items).filter(isReferenceItem);
  function renderItem(item: ClassGuideItemView) {
    return <ItemRow key={item.item.id} item={item} index={itemIndexMap.get(item.item.id) ?? 1}
      scope={overview.scope} filters={overview.filters} rosterById={rosterById}
      expanded={expandedIds.has(item.item.id)} onToggle={() => toggleItem(item.item.id)}
      onOpenChildItem={onOpenChildItem} onRecordObservation={onRecordObservation}
      canRecordChild={canRecordChild} onOpenActivitySupport={onOpenActivitySupport}
      classStage={overview.class.stage} classId={overview.class.id} catalogVersion={overview.catalog_version}
      readerIdentityKey={readerIdentityKey} onRevalidateIdentity={onRevalidateIdentity}
      onRefreshOverview={onRefreshOverview} panelOutlet={panelOutlet} />;
  }

  return (
    <section
      className={[styles.overview, className].filter(Boolean).join(" ")}
      aria-label={`${overview.class.name}的班级指南证据概览`}
      data-testid="class-evidence-overview"
      data-client-ready={clientReady}
    >
      <header className={cx("head")}>
        <div className={cx("title-row")}>
          <div>
            <h2 className={cx("title")}>班级指南证据概览</h2>
            <p className={cx("identity")} data-testid="class-summary">
              {classLabel(overview.class.stage, overview.class.name)} · {overview.class.school_year}学年
              <span> · 当前在班名单 {overview.roster.child_count} 人</span>
              {overview.class.is_active ? null : <span className={cx("identity-flag")}>已停用</span>}
            </p>
          </div>
        </div>
      </header>


      {severeNotices.length > 0 ? (
        <details className={cx("reading-notices")}>
          <summary>有些记录暂时无法核对 · 查看说明</summary>
        <ul className={cx("notice-list")}>
          {severeNotices.map((notice, index) => (
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
        </details>
      ) : null}

      {infoNotices.length > 0 ? (
        <div className={cx("notice-info-block")}>
          <button
            type="button"
            className={cx("notice-toggle")}
            aria-expanded={infoExpanded}
            aria-controls={noticeListId}
            onClick={() => setInfoExpanded((previous) => !previous)}
            data-testid="info-notice-toggle"
          >
            其他提示 {infoNotices.length} 条
            <ChevronDown
              className={cx("disclosure-icon", infoExpanded && "disclosure-icon-open")}
              aria-hidden="true"
            />
          </button>
          <ul
            id={noticeListId}
            className={cx("notice-list", "notice-info-list")}
            data-expanded={infoExpanded}
          >
            {infoNotices.map((notice, index) => (
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
        </div>
      ) : null}

      <div className={cx("controls")}>
        <div className={cx("control-block")}>
          <label className={cx("control-label")} htmlFor={scopeSelectId}>
            统计期间
          </label>
          <select
            id={scopeSelectId}
            className={cx("select")}
            value={scopeSelectValue(overview.scope)}
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
          {draft ? (
            <div className={cx("custom-range")} data-testid="custom-range-editor">
              <p className={cx("range-pending")} data-testid="range-pending">
                尚未应用：当前统计期间仍是「{overview.scope.label}」。填写日期后点击“应用日期”。
              </p>
              <div className={cx("custom-fields")}>
                <label className={cx("date-field")}>
                  从
                  <input
                    type="date"
                    value={draft.from}
                    onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                    data-testid="range-from"
                  />
                </label>
                <label className={cx("date-field")}>
                  到
                  <input
                    type="date"
                    value={draft.to}
                    onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                    data-testid="range-to"
                  />
                </label>
                <button
                  type="button"
                  className={cx("apply-button")}
                  onClick={applyCustomDraft}
                  disabled={!onScopeChange}
                  data-testid="apply-range"
                >
                  应用日期
                </button>
                <button
                  type="button"
                  className={cx("edit-range-button")}
                  onClick={cancelCustomDraft}
                  data-testid="cancel-range"
                >
                  取消编辑
                </button>
              </div>
              {rangeError ? (
                <p className={cx("range-error")} role="alert">
                  {rangeError}
                </p>
              ) : null}
            </div>
          ) : overview.scope.kind === "custom_range" && onScopeChange ? (
            <button
              type="button"
              className={cx("edit-range-button")}
              onClick={openCustomDraft}
              data-testid="edit-range"
            >
              修改自定义日期
            </button>
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
        </div>

        <div className={cx("control-block", "control-block-help")}>
              <button
                type="button"
                className={cx("help-button")}
                data-testid="stats-help-button"
                aria-expanded={statsHelpOpen}
                aria-controls={statsHelpId}
                onClick={() => setStatsHelpOpen((value) => !value)}
                aria-label="查看统计说明与方法"
              >
                <HelpCircle className={cx("help-icon")} aria-hidden="true" />
                统计说明
              </button>
        </div>
      </div>

      {statsHelpOpen ? <section id={statsHelpId} className={cx("stats-details")} aria-label="统计说明" data-testid="stats-help-content">
        <h3>统计说明</h3>
        <p>本次查看：{scopePeriodText(overview.scope)} · {referenceAgeText}</p>
        <p>以当前在班名单（{overview.roster.child_count} 人）为分母，同一个幼儿在同一条目只计一次。切换历史期间只回看这些幼儿当时的记录，不能还原历史名册，也不代表班级教学成效。</p>
        <p>所选期间之外的证据不计入本次统计，可切换时间查阅，不属于数据问题。</p>
        <ul>
          <li><strong>已确认观察到</strong>：有老师确认的观察记录支持这项表现。</li>
          <li><strong>已有相关线索</strong>：有相关记录，还不足以确认这项表现；指南允许的成人帮助不自动降为线索。</li>
          <li><strong>暂无相关记录</strong>：所选范围还没有关联记录，不代表幼儿“不会”或未掌握。</li>
        </ul>
        <p>资料完整时显示三类人数。还有资料待核对时，只显示已能确认的人数；暂时读不到时不画分布，仍可进入个人证据册查阅。读不到不等于没有记录。</p>
        <p>身高、体重等保健参考仅供日常保育查阅，不参与行为统计，也不作正常或异常判断。</p>
      </section> : null}

      {overview.filters.goal_id ? (
        <div className={cx("goal-filter")} data-testid="goal-filter" data-goal-id={overview.filters.goal_id}>
          <span className={cx("goal-filter-label")}>当前目标筛选</span>
          <span className={cx("goal-filter-title")}>
            {activeGoal
              ? `${activeGoal.index}. ${activeGoal.title}（${activeGoal.domainName} · ${activeGoal.subDomainName}）`
              : overview.filters.goal_id}
          </span>
          <button
            type="button"
            className={cx("goal-filter-clear")}
            disabled={!onFiltersChange}
            onClick={() => onFiltersChange?.({ ...overview.filters, goal_id: null })}
            data-testid="clear-goal-filter"
          >
            清除
          </button>
        </div>
      ) : null}

      {overview.goals.length === 0 ? (
        <p className={cx("overview-empty")}>当前筛选下没有可展示的表现条目。</p>
      ) : (
        <div className={cx("workspace")}>
          <div className={cx("workspace-master")}>
            <div className={cx("workspace-head")}>
              <div className={cx("workspace-head-title")}>
                <h3 className={cx("workspace-heading")}>指南条目分布</h3>
                <span className={cx("workspace-roster-tag")}>
                  当前在班 {overview.roster.child_count} 人
                </span>
              </div>
              <div className={cx("workspace-legend-row")}>
                <span className={cx("shared-legend-item")}>
                  <span className={cx("legend-dot", STATUS_CLASS.confirmed_observed)} aria-hidden="true" />
                  已确认观察到
                </span>
                <span className={cx("shared-legend-item")}>
                  <span className={cx("legend-dot", STATUS_CLASS.has_clues)} aria-hidden="true" />
                  已有相关线索
                </span>
                <span className={cx("shared-legend-item")}>
                  <span className={cx("legend-dot", STATUS_CLASS.no_records)} aria-hidden="true" />
                  暂无相关记录
                </span>
                <span className={cx("shared-legend-caption")}>
                  按当前在班幼儿去重，不代表发展评分。
                </span>
              </div>
            </div>

            <div className={cx("workspace-ruler")} aria-hidden="true">
              <span className={cx("ruler-label-left")}>指南条目</span>
              <div className={cx("ruler-axis")}>
                <span className={cx("ruler-axis-title")}>人数分布（人）</span>
                <div className={cx("ruler-ticks")}>
                  {peopleTicks(overview.roster.child_count).map((value) => <span key={value} style={{ insetInlineStart: `${value / overview.roster.child_count * 100}%` }}>{value}</span>)}
                </div>
              </div>
            </div>

            <div className={cx("goals")}>
              {overview.goals.map(({ goal, items }) => {
                const behaviorItems = items.filter((item) => !isReferenceItem(item));
                if (behaviorItems.length === 0) return null;
                const domainName = catalogIndex.domains.get(goal.domain_id);
                const subDomainName = catalogIndex.subDomains.get(goal.sub_domain_id);
                const pathText =
                  [overview.filters.domain_code === null ? domainName : null, subDomainName]
                    .filter(Boolean)
                    .join(" · ") || "指南目标";
                return (
                  <section
                    key={goal.id}
                    className={cx("goal-group")}
                    aria-labelledby={`class-goal-${goal.id}`}
                    data-testid="goal-group"
                  >
                    <h3 className={cx("goal-title")} id={`class-goal-${goal.id}`}>
                      <span className={cx("goal-path")} data-testid="goal-path">
                        {pathText}
                      </span>
                      <span className={cx("goal-heading")}>
                        <span className={cx("goal-index")}>{goal.index}</span>
                        {goal.title}
                      </span>
                    </h3>
                    <ul className={cx("item-list")}>
                      {behaviorItems.map(renderItem)}
                    </ul>
                  </section>
                );
              })}
            </div>
            {referenceItems.length > 0 ? <details className={cx("reference-library")} data-testid="reference-library" onToggle={(event) => {
              if (!event.currentTarget.open && referenceItems.some((item) => expandedIds.has(item.item.id))) setExpandedIds(new Set());
            }}>
              <summary><BookOpen aria-hidden="true" />保健参考资料 · {referenceItems.length} 项</summary>
              <p>仅供日常保育查阅，不参与行为统计，也不作正常或异常判断。</p>
              <ul className={cx("item-list")}>{referenceItems.map(renderItem)}</ul>
            </details> : null}
          </div>
          <div className={cx("workspace-detail")} ref={setPanelOutlet} aria-label="选中条目详情" />
        </div>
      )}
    </section>
  );
}
