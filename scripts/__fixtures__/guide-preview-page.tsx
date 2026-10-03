"use client";

import { useState } from "react";

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
 */

declare global {
  interface Window {
    __g3events?: Array<{ label: string; payload: unknown }>;
  }
}

type ScenarioKey = "rich" | "large" | "unavailable";

const SCENARIOS: Record<ScenarioKey, { label: string; book: BookDto }> = {
  rich: { label: "完整示例", book: CHILD_EVIDENCE_BOOK_FIXTURE },
  large: { label: "大目录", book: CHILD_EVIDENCE_BOOK_LARGE_FIXTURE },
  unavailable: { label: "记录不可读", book: CHILD_EVIDENCE_BOOK_UNAVAILABLE_FIXTURE },
};

const GOAL_ID = "goal.ui.language.2";

function applyFilters(book: BookDto, filters: EvidenceViewFilters): BookDto {
  const domainId = filters.domain_code
    ? book.catalog.domains.find((entry) => entry.code === filters.domain_code)?.id
    : null;
  const goals = book.goals
    .filter((goalView) => !domainId || goalView.goal.domain_id === domainId)
    .filter((goalView) => !filters.goal_id || goalView.goal.id === filters.goal_id)
    .map((goalView) => ({
      ...goalView,
      items: goalView.items.filter(
        (itemView) => !filters.age_band || itemView.item.age_band === filters.age_band,
      ),
    }));
  return { ...book, filters, goals };
}

function applyScope(book: BookDto, intent: EvidenceScopeIntent): BookDto {
  let scope: EvidenceScope;
  if (intent.kind === "all_history") {
    scope = {
      kind: "all_history",
      semester_id: null,
      label: "全部历史",
      start_date: null,
      end_date: null,
      filter_field: "observed_at",
    };
  } else if (intent.kind === "custom_range") {
    scope = {
      kind: "custom_range",
      semester_id: null,
      label: `自定义 ${intent.from} 至 ${intent.to}`,
      start_date: intent.from,
      end_date: intent.to,
      filter_field: "observed_at",
    };
  } else {
    const semester = CHILD_EVIDENCE_BOOK_SEMESTERS.find((entry) => entry.id === intent.semester_id);
    scope = {
      kind: "semester",
      semester_id: intent.semester_id,
      label: semester?.label ?? intent.semester_id,
      start_date: semester?.start_date ?? null,
      end_date: semester?.end_date ?? null,
      filter_field: "observed_at",
    };
  }
  return { ...book, scope };
}

function PreviewInner({ initialBook }: { initialBook: BookDto }) {
  const [book, setBook] = useState<BookDto>(initialBook);
  const [events, setEvents] = useState<string[]>([]);
  const [rejectScope, setRejectScope] = useState(false);

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
            setBook((previous) => applyScope(previous, { kind: "all_history" }));
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
            setBook((previous) => applyScope(previous, { kind: "semester", semester_id: "2026-2027-1" }));
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
            setBook((previous) =>
              applyScope(previous, { kind: "custom_range", from: "2026-09-01", to: "2026-09-30" }),
            );
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
            setBook((previous) => applyFilters(previous, { ...previous.filters, goal_id: GOAL_ID }));
          }}
        >
          带目标进入
        </button>
        <button
          type="button"
          data-testid="clear-goal"
          onClick={() => {
            record("external-goal", { goal_id: null });
            setBook((previous) => applyFilters(previous, { ...previous.filters, goal_id: null }));
          }}
        >
          清除目标
        </button>
      </div>

      <ChildEvidenceBook
        book={book}
        semesters={CHILD_EVIDENCE_BOOK_SEMESTERS}
        onFiltersChange={(filters) => {
          record("filters", filters);
          setBook((previous) => applyFilters(previous, filters));
        }}
        onScopeChange={(scope) => {
          record("scope", scope);
          if (!rejectScope) setBook((previous) => applyScope(previous, scope));
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
