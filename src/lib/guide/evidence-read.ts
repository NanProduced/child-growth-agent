import { z } from "zod";
import { parseIsoDateStrict } from "@/lib/format";
import { CLASS_STAGES, type ClassStage } from "@/lib/types";
import { GUIDE_AGE_BANDS, GUIDE_DOMAIN_CODES } from "./types";
import { evidenceLinkViewSchema } from "./mutation-response";
import {
  EVIDENCE_RELIABILITIES,
  type EvidenceBasisView,
  type EvidenceScope,
  type EvidenceViewFilters,
} from "./view-types";

const scopeSchema = z.object({
  kind: z.enum(["semester", "all_history", "custom_range"]),
  semester_id: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  filter_field: z.literal("observed_at"),
});

// Read only the fields this view consumes; use the existing frozen link parser.
const bookSchema = z.object({
  audience: z.literal("child_history"),
  child: z.object({ id: z.string().min(1), class_id: z.string().nullable(), stage: z.enum(CLASS_STAGES).nullable() }),
  catalog_version: z.string().min(1),
  scope: scopeSchema,
  filters: z.object({
    domain_code: z.enum(GUIDE_DOMAIN_CODES).nullable(),
    age_band: z.enum(GUIDE_AGE_BANDS).nullable(),
    goal_id: z.string().nullable(),
  }),
  goals: z.array(z.object({
    items: z.array(z.object({
      item: z.object({ id: z.string().min(1) }),
      reliability: z.enum(EVIDENCE_RELIABILITIES),
      links: z.array(evidenceLinkViewSchema),
    })),
  })),
});

export interface ClassQuoteTarget {
  childId: string;
  itemId: string;
  catalogVersion: string;
  classStage: ClassStage;
  classId: string;
  scope: EvidenceScope;
  filters: EvidenceViewFilters;
}

export type EvidenceQuoteRead =
  | { kind: "ready"; sources: EvidenceBasisView[]; partial: boolean }
  | { kind: "empty"; partial: boolean }
  | { kind: "unauthenticated" | "forbidden" | "unavailable" | "invalid" };

function sameScope(actual: z.infer<typeof scopeSchema>, expected: EvidenceScope): boolean {
  return actual.kind === expected.kind && actual.semester_id === expected.semester_id &&
    actual.start_date === expected.start_date && actual.end_date === expected.end_date;
}

function inScope(date: string, scope: EvidenceScope): boolean {
  if (!parseIsoDateStrict(date)) return false;
  return scope.kind === "all_history" || Boolean(
    scope.start_date && scope.end_date && date >= scope.start_date && date <= scope.end_date,
  );
}

/** A personal book includes historical stages; the class inspector must not use them as class evidence. */
export function parseClassEvidenceQuotes(value: unknown, target: ClassQuoteTarget): EvidenceQuoteRead {
  const parsed = bookSchema.safeParse(value);
  if (!parsed.success) return { kind: "invalid" };
  const book = parsed.data;
  if (book.child.id !== target.childId || book.child.class_id !== target.classId || book.child.stage !== target.classStage ||
      book.catalog_version !== target.catalogVersion ||
      !sameScope(book.scope, target.scope) ||
      book.filters.domain_code !== target.filters.domain_code ||
      book.filters.age_band !== target.filters.age_band ||
      book.filters.goal_id !== target.filters.goal_id) return { kind: "invalid" };

  const matches = book.goals.flatMap((goal) => goal.items).filter((item) => item.item.id === target.itemId);
  if (matches.length !== 1) return { kind: "invalid" };
  const item = matches[0];
  if (item.reliability === "unavailable") return { kind: "unavailable" };
  const sources: EvidenceBasisView[] = [];
  const seen = new Set<string>();
  for (const link of item.links) {
    if (!link.counts_toward_status || link.excluded_reason !== null ||
        link.item_id !== target.itemId || link.catalog_version !== target.catalogVersion ||
        (link.status !== "confirmed_performance" && link.status !== "confirmed_clue")) continue;
    if (link.basis.length === 0 || !link.basis.every((basis) =>
      basis.valid && basis.invalid_reason === null && basis.observation_status === "confirmed" &&
      basis.quote.trim().length > 0 &&
      basis.class_context?.stage === target.classStage && inScope(basis.observed_at, target.scope) &&
      (basis.quote_source === "raw_text" ? basis.quote_field === null : basis.quote_field !== null),
    )) continue;
    if (link.sustained_note && (!inScope(link.sustained_note.period_start, target.scope) ||
        !inScope(link.sustained_note.period_end, target.scope))) continue;
    for (const basis of link.basis) {
      const key = JSON.stringify([basis.observation_id, basis.quote_source, basis.quote_field, basis.quote]);
      if (!seen.has(key)) { seen.add(key); sources.push(basis); }
    }
  }
  sources.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  const partial = item.reliability === "partial";
  return sources.length ? { kind: "ready", sources, partial } : { kind: "empty", partial };
}

export async function readClassEvidenceQuotes(response: Response, target: ClassQuoteTarget): Promise<EvidenceQuoteRead> {
  if (response.status === 401) return { kind: "unauthenticated" };
  if (response.status === 403) return { kind: "forbidden" };
  if (!response.ok) return { kind: "unavailable" };
  try { return parseClassEvidenceQuotes(await response.json(), target); }
  catch { return { kind: "invalid" }; }
}

/** Integer people ticks, never a hard-coded 20-person class or a percentage score. */
export function peopleTicks(total: number): number[] {
  if (!Number.isSafeInteger(total) || total <= 0) return [];
  const step = Math.max(1, Math.ceil(total / 4));
  const ticks: number[] = [];
  for (let value = 0; value < total; value += step) ticks.push(value);
  ticks.push(total);
  return ticks;
}

export function evidenceSourceLabel(source: EvidenceBasisView): string {
  if (source.quote_source === "raw_text") return "原始观察";
  return source.quote_field === "highlights" ? "教师确认稿 · 证据片段" : "教师确认稿 · 原文引用";
}
