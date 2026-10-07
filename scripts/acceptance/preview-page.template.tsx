"use client";

import { useMemo, useState } from "react";

import {
  ClassEvidenceOverview,
  type ClassEvidenceScopeIntent,
} from "@/components/guide/class-evidence-overview";
import {
  CLASS_FIXTURE_HISTORY_SCOPE,
  CLASS_FIXTURE_SEMESTER_SCOPE,
  CLASS_REFERENCE_FIXTURE_OVERRIDES,
  buildClassEvidenceOverview,
  buildEmptyRosterOverview,
} from "@/components/guide/__fixtures__/class-evidence-overview-fixture";
import { CONTRACT_FIXTURE_SEMESTERS } from "@/lib/guide/__fixtures__/contract-fixtures";
import type { SemesterPeriod } from "@/lib/guide/types";
import type { EvidenceScope, EvidenceViewFilters } from "@/lib/guide/view-types";

type Scenario = "main" | "empty" | "reference-unavailable" | "reference-partial" | "reference-pending";

interface PreviewEvent {
  label: string;
  payload: unknown;
}

declare global {
  interface Window {
    __g4events?: PreviewEvent[];
  }
}

function push(label: string, payload: unknown) {
  if (typeof window === "undefined") return;
  const list = (window.__g4events ??= []);
  list.push({ label, payload });
}

function scopeFromSemester(semester: SemesterPeriod): EvidenceScope {
  return {
    kind: "semester",
    semester_id: semester.id,
    label: semester.label,
    start_date: semester.start_date,
    end_date: semester.end_date,
    filter_field: "observed_at",
  };
}

const SEMESTERS = CONTRACT_FIXTURE_SEMESTERS;

const NO_FILTERS: EvidenceViewFilters = { domain_code: null, age_band: null, goal_id: null };

const GOAL_FILTERS: EvidenceViewFilters = {
  domain_code: "language",
  age_band: null,
  goal_id: "goal.ui.language.1",
};

export default function GuidePreviewClassPage() {
  const [scenario, setScenario] = useState<Scenario>("main");
  const [filters, setFilters] = useState<EvidenceViewFilters>(NO_FILTERS);
  const [scope, setScope] = useState<EvidenceScope>(CLASS_FIXTURE_SEMESTER_SCOPE);
  const [acceptIntent, setAcceptIntent] = useState(true);

  const overview = useMemo(() => {
    if (scenario === "empty") return buildEmptyRosterOverview();
    if (scenario === "reference-unavailable") {
      return buildClassEvidenceOverview({
        domain_code: "health",
        age_band: "4-5",
        distributions: CLASS_REFERENCE_FIXTURE_OVERRIDES.unavailable,
      });
    }
    if (scenario === "reference-partial") {
      return buildClassEvidenceOverview({
        domain_code: "health",
        age_band: "4-5",
        distributions: CLASS_REFERENCE_FIXTURE_OVERRIDES.partial,
      });
    }
    if (scenario === "reference-pending") {
      return buildClassEvidenceOverview({
        domain_code: "health",
        age_band: "4-5",
        distributions: CLASS_REFERENCE_FIXTURE_OVERRIDES.pending,
      });
    }
    return buildClassEvidenceOverview({
      domain_code: filters.domain_code,
      age_band: filters.age_band,
      goal_id: filters.goal_id,
      scope,
    });
  }, [scenario, filters, scope]);

  function handleScopeChange(intent: ClassEvidenceScopeIntent) {
    push("scope", intent);
    if (!acceptIntent) return;
    setScenario("main");
    if (intent.kind === "all_history") {
      setScope({
        kind: "all_history",
        semester_id: null,
        label: "全部历史",
        start_date: null,
        end_date: null,
        filter_field: "observed_at",
      });
      return;
    }
    if (intent.kind === "custom_range") {
      setScope({
        kind: "custom_range",
        semester_id: null,
        label: `自定义期间（${intent.from} 至 ${intent.to}）`,
        start_date: intent.from,
        end_date: intent.to,
        filter_field: "observed_at",
      });
      return;
    }
    const semester = SEMESTERS.find((entry) => entry.id === intent.semester_id);
    setScope(
      semester
        ? scopeFromSemester(semester)
        : {
            kind: "semester",
            semester_id: intent.semester_id,
            label: "指定学期",
            start_date: null,
            end_date: null,
            filter_field: "observed_at",
          },
    );
  }

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          style={{ minHeight: 44, padding: "0 14px" }}
          onClick={() => {
            push("scenario", "main");
            setScenario("main");
            setScope(CLASS_FIXTURE_SEMESTER_SCOPE);
            setFilters(NO_FILTERS);
          }}
        >
          20 人班级
        </button>
        <button
          type="button"
          style={{ minHeight: 44, padding: "0 14px" }}
          onClick={() => {
            push("scenario", "empty");
            setScenario("empty");
          }}
        >
          空名单
        </button>
        <button
          type="button"
          style={{ minHeight: 44, padding: "0 14px" }}
          onClick={() => {
            push("scenario", "history");
            setScenario("main");
            setScope(CLASS_FIXTURE_HISTORY_SCOPE);
          }}
        >
          历史期间
        </button>
        <button
          type="button"
          style={{ minHeight: 44, padding: "0 14px" }}
          onClick={() => {
            push("scenario", "goal");
            setScenario("main");
            setScope(CLASS_FIXTURE_SEMESTER_SCOPE);
            setFilters(GOAL_FILTERS);
          }}
        >
          目标筛选
        </button>
        <button
          type="button"
          style={{ minHeight: 44, padding: "0 14px" }}
          onClick={() => {
            push("scenario", "reference-unavailable");
            setScenario("reference-unavailable");
          }}
        >
          参考不可读
        </button>
        <button
          type="button"
          style={{ minHeight: 44, padding: "0 14px" }}
          onClick={() => {
            push("scenario", "reference-partial");
            setScenario("reference-partial");
          }}
        >
          参考核验受限
        </button>
        <button
          type="button"
          style={{ minHeight: 44, padding: "0 14px" }}
          onClick={() => {
            push("scenario", "reference-pending");
            setScenario("reference-pending");
          }}
        >
          参考待核对
        </button>
        <button
          type="button"
          data-testid="accept-intent-toggle"
          aria-pressed={acceptIntent}
          style={{ minHeight: 44, padding: "0 14px" }}
          onClick={() => {
            const next = !acceptIntent;
            setAcceptIntent(next);
            push("accept-intent", next);
          }}
        >
          接受期间意图：{acceptIntent ? "开" : "关"}
        </button>
      </div>

      <ClassEvidenceOverview
        overview={overview}
        semesters={SEMESTERS}
        onScopeChange={handleScopeChange}
        onFiltersChange={(nextFilters) => {
          setFilters(nextFilters);
          push("filters", nextFilters);
        }}
        onOpenChildItem={(target) => push("drilldown", target)}
        onRecordObservation={(child, item) => push("record", { child_id: child.id, item_id: item.id })}
        onOpenActivitySupport={(child, item) => push("activity", { child_id: child.id, item_id: item.id })}
      />
    </main>
  );
}
