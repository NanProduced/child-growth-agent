"use client";

import { useEffect, useMemo, useState } from "react";

import {
  ChildEvidenceBook,
  type EvidenceScopeIntent,
} from "@/components/guide/child-evidence-book";
import {
  CHILD_EVIDENCE_BOOK_FIXTURE,
  CHILD_EVIDENCE_BOOK_LARGE_FIXTURE,
  CHILD_EVIDENCE_BOOK_SEMESTERS,
  CHILD_EVIDENCE_BOOK_UNAVAILABLE_FIXTURE,
} from "@/components/guide/__fixtures__/child-evidence-book-fixture";
import type { ChildEvidenceBook as BookDto, EvidenceScope, EvidenceViewFilters } from "@/lib/guide/view-types";

/**
 * G3 浏览器验收预览模板（不是正式路由，不参与生产构建）。
 * 由 scripts/check-child-evidence-book-browser.cjs 复制到 src/app/guide-preview/page.tsx，
 * 验收结束后删除；仅用于 fixture 组件验收，不接真实 API、不写数据库。
 *
 * 重要：每次筛选都从完整初始 fixture 重新计算展示子集，不修改原 fixture；
 * 这里的筛选/期间只是验收装置，不是 G5 读模型，也不做真实期间统计。
 */

declare global {
  interface Window {
    __g3events?: Array<{ label: string; payload: unknown }>;
    __g3baseProbe?: () => { goals: number; items: number };
  }
}

type ScenarioKey = "rich" | "large" | "unavailable" | "notes";

// Component-only double: distinguish notes belonging to two different records.
const notesFixture = structuredClone(CHILD_EVIDENCE_BOOK_FIXTURE);
const notesItem = notesFixture.goals.flatMap((goal) => goal.items).find((item) => item.item.id === "item.ui.language.1.3-4");
const latestLink = notesItem?.links.find((link) => link.counts_toward_status);
if (!notesItem || !latestLink) throw new Error("Missing notes fixture prerequisite");
latestLink.teacher_note = "[合成] 新记录的备注";
notesItem.links.push({ ...structuredClone(latestLink), link_id: "link.ui.notes.older", teacher_note: "[合成] 旧记录的备注",
  basis: latestLink.basis.map((basis) => ({ ...basis, observation_id: "obs.ui.notes.older", observed_at: "2026-09-03", quote: "[合成] 这是较早的观察原文。" })) });

const SCENARIOS: Record<ScenarioKey, { label: string; book: BookDto }> = {
  rich: { label: "完整示例", book: CHILD_EVIDENCE_BOOK_FIXTURE },
  large: { label: "大目录", book: CHILD_EVIDENCE_BOOK_LARGE_FIXTURE },
  unavailable: { label: "记录不可读", book: CHILD_EVIDENCE_BOOK_UNAVAILABLE_FIXTURE },
  notes: { label: "备注归属（合成）", book: notesFixture },
};

const GOAL_ID = "goal.ui.language.2";
const EXTERNAL_CUSTOM_RANGE = { from: "2026-09-01", to: "2026-09-30" };

function scopeFromIntent(intent: EvidenceScopeIntent): EvidenceScope {
  if (intent.kind === "all_history") {
    return {
      kind: "all_history",
      semester_id: null,
      label: "全部历史",
      start_date: null,
      end_date: null,
      filter_field: "observed_at",
    };
  }
  if (intent.kind === "custom_range") {
    return {
      kind: "custom_range",
      semester_id: null,
      label: `自定义 ${intent.from} 至 ${intent.to}`,
      start_date: intent.from,
      end_date: intent.to,
      filter_field: "observed_at",
    };
  }
  const semester = CHILD_EVIDENCE_BOOK_SEMESTERS.find((entry) => entry.id === intent.semester_id);
  return {
    kind: "semester",
    semester_id: intent.semester_id,
    label: semester?.label ?? intent.semester_id,
    start_date: semester?.start_date ?? null,
    end_date: semester?.end_date ?? null,
    filter_field: "observed_at",
  };
}

/** 始终以完整初始 fixture 为基准计算展示子集；不修改 base，也不是 G5 读模型。 */
function buildFixtureView(base: BookDto, filters: EvidenceViewFilters, scope: EvidenceScope): BookDto {
  const domainId = filters.domain_code
    ? base.catalog.domains.find((entry) => entry.code === filters.domain_code)?.id
    : null;
  const goals = base.goals
    .filter((goalView) => !domainId || goalView.goal.domain_id === domainId)
    .filter((goalView) => !filters.goal_id || goalView.goal.id === filters.goal_id)
    .map((goalView) => ({
      ...goalView,
      items: goalView.items.filter(
        (itemView) => !filters.age_band || itemView.item.age_band === filters.age_band,
      ),
    }));
  return { ...base, filters, scope, goals };
}

function PreviewInner({ initialBook }: { initialBook: BookDto }) {
  const [filters, setFilters] = useState<EvidenceViewFilters>(initialBook.filters);
  const [scope, setScope] = useState<EvidenceScope>(initialBook.scope);
  const [events, setEvents] = useState<string[]>([]);
  const [rejectScope, setRejectScope] = useState(false);

  const book = useMemo(() => buildFixtureView(initialBook, filters, scope), [initialBook, filters, scope]);

  useEffect(() => {
    window.__g3baseProbe = () => ({
      goals: initialBook.goals.length,
      items: initialBook.goals.flatMap((goalView) => goalView.items).length,
    });
  }, [initialBook]);

  function record(label: string, payload: unknown) {
    window.__g3events = [...(window.__g3events ?? []), { label, payload }];
    setEvents((previous) => [JSON.stringify({ label, payload }), ...previous].slice(0, 14));
  }

  return (
    <div style={{ display: "grid", gap: 20, maxWidth: 1120, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
        <span style={{ fontWeight: 600 }}>验收控制：</span>
        <button
          type="button"
          data-testid="external-scope"
          data-scope="all_history"
          onClick={() => {
            record("external-scope", { kind: "all_history" });
            setScope(scopeFromIntent({ kind: "all_history" }));
          }}
        >
          外部切换：全部历史
        </button>
        <button
          type="button"
          data-testid="external-scope"
          data-scope="semester"
          onClick={() => {
            record("external-scope", { kind: "semester", semester_id: "2026-2027-1" });
            setScope(scopeFromIntent({ kind: "semester", semester_id: "2026-2027-1" }));
          }}
        >
          外部切换：当前学期
        </button>
        <button
          type="button"
          data-testid="external-scope"
          data-scope="custom"
          onClick={() => {
            record("external-scope", { kind: "custom_range" });
            setScope(scopeFromIntent({ kind: "custom_range", ...EXTERNAL_CUSTOM_RANGE }));
          }}
        >
          外部切换：自定义 9 月
        </button>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            data-testid="reject-scope"
            checked={rejectScope}
            onChange={(event) => setRejectScope(event.target.checked)}
          />
          父级拒绝期间变更
        </label>
        <button
          type="button"
          data-testid="inject-goal"
          onClick={() => {
            record("external-goal", { goal_id: GOAL_ID });
            setFilters((previous) => ({ ...previous, goal_id: GOAL_ID }));
          }}
        >
          带目标进入
        </button>
        <button
          type="button"
          data-testid="clear-goal"
          onClick={() => {
            record("external-goal", { goal_id: null });
            setFilters((previous) => ({ ...previous, goal_id: null }));
          }}
        >
          清除目标
        </button>
      </div>

      <ChildEvidenceBook
        book={book}
        semesters={CHILD_EVIDENCE_BOOK_SEMESTERS}
        onFiltersChange={(next) => {
          record("filters", next);
          setFilters(next);
        }}
        onScopeChange={(next) => {
          record("scope", next);
          if (!rejectScope) setScope(scopeFromIntent(next));
        }}
        onRecordObservation={(child, item) => {
          record("record", { child_id: child.id, item_id: item.id });
        }}
      />

      <section aria-label="回调事件记录" style={{ border: "1px dashed #bbb", borderRadius: 12, padding: 12 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>回调事件（仅验收用）</h2>
        <ul data-testid="event-log" style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
          {events.map((event, index) => (
            <li key={index} data-event={event}>
              {event}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function GuidePreviewPage() {
  const [scenario, setScenario] = useState<ScenarioKey>("rich");

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p
        data-testid="preview-disclaimer"
        style={{
          margin: 0,
          padding: "8px 12px",
          borderRadius: 8,
          background: "#fff7e6",
          border: "1px solid #e8d5a8",
          fontSize: 12,
          lineHeight: 1.7,
        }}
      >
        预览说明：筛选与期间仅在此完整 fixture 上计算展示子集，不代表 G5 读模型或真实期间统计；期间选择不会重算证据。
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="fixture 场景">
        {(Object.keys(SCENARIOS) as ScenarioKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setScenario(key)}
            aria-pressed={scenario === key}
            style={{
              minHeight: 44,
              padding: "0 16px",
              borderRadius: 999,
              border: "1px solid #ccc",
              background: scenario === key ? "#e5f4ea" : "#fff",
            }}
          >
            {SCENARIOS[key].label}
          </button>
        ))}
      </div>
      <PreviewInner key={scenario} initialBook={SCENARIOS[scenario].book} />
    </div>
  );
}
