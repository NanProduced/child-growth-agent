import type { ClassStage } from "@/lib/types";
import type { EvidenceFiltersInput } from "./read-model";
import type { EvidenceScopeQuery } from "@/lib/semester";
import type { EvidenceScope, EvidenceViewFilters } from "./view-types";

export type EvidencePageSearch = Record<string, string | string[] | undefined>;
export type EvidencePeriodIntent =
  | { kind: "semester"; semester_id: string }
  | { kind: "all_history" }
  | { kind: "custom_range"; from: string; to: string };

/** Retry preserves the requested range and item focus, including repeated query parameters. */
export function evidencePageHref(path: string, search: EvidencePageSearch): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, item);
    }
  }
  const serialized = query.toString();
  return `${path}${serialized ? `?${serialized}` : ""}`;
}

export function evidencePageQuery(search: EvidencePageSearch): EvidenceScopeQuery & EvidenceFiltersInput {
  const first = (key: string): string | null => {
    const value = search[key];
    return (Array.isArray(value) ? value[0] : value) ?? null;
  };
  return {
    scope: first("scope"), semester_id: first("semester_id"),
    from: first("from"), to: first("to"),
    domain: first("domain"), age_band: first("age_band"), goal_id: first("goal_id"),
  };
}

/** Scope and filters are taken from the applied server DTO, never from date drafts. */
export function evidenceQueryString(
  scope: EvidenceScope | EvidencePeriodIntent,
  filters: EvidenceViewFilters,
): string {
  const query = new URLSearchParams();
  if (scope.kind === "semester" && scope.semester_id) query.set("semester_id", scope.semester_id);
  else if (scope.kind === "all_history") query.set("scope", "all_history");
  else if (scope.kind === "custom_range") {
    query.set("scope", "custom_range");
    const from = "from" in scope ? scope.from : scope.start_date;
    const to = "to" in scope ? scope.to : scope.end_date;
    if (from) query.set("from", from);
    if (to) query.set("to", to);
  }
  if (filters.domain_code) query.set("domain", filters.domain_code);
  if (filters.age_band) query.set("age_band", filters.age_band);
  if (filters.goal_id) query.set("goal_id", filters.goal_id);
  return query.toString();
}

export function evidenceEntryQuery(stage: ClassStage | null | undefined): string {
  const query = new URLSearchParams({ domain: "health" });
  if (stage) query.set("age_band", { small: "3-4", middle: "4-5", large: "5-6" }[stage]);
  return query.toString();
}
