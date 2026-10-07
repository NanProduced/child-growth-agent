import {
  getChild, getClass, getClassChildren, getObservation, listEnrollments,
  mapChild, mapClass, mapObservation,
} from "@/lib/queries";
import { query } from "@/storage/database/pg-client";
import type { Child, Observation, SchoolClass } from "@/lib/types";
import type { HeaderCarrier } from "./guards";
import type { AccessProjection, Principal } from "./types";
import { withBusinessRead, withScopedRead } from "./access";
import { AccountsError } from "./errors";

export type ScopedObservation = Observation & { access_projection: AccessProjection; can_write: boolean };
type Row = Record<string, unknown>;
function classIds(principal: Principal): string[] | null {
  return principal.scope.kind === "school" ? null : principal.scope.kind === "classes" ? principal.scope.class_ids : [];
}

/** Historical projection contains only this observation; child/profile/guide context is removed. */
export function projectObservation(observation: Observation, projection: AccessProjection, principal: Principal): ScopedObservation {
  return {
    ...observation,
    ...(projection === "full" ? {} : { guide_evidence: null, agent_context: null, ai_draft: null, ai_model: null, ai_organized_at: null }),
    access_projection: projection,
    can_write: projection === "full" && principal.role === "teacher",
  };
}

export function scopedListClasses(options: { catalog?: boolean } = {}, request?: HeaderCarrier): Promise<SchoolClass[]> {
  return withScopedRead(request, async (principal) => {
    const ids = classIds(principal);
    const rows = await query<{ data: Row }>(
      `SELECT to_jsonb(k.*) AS data FROM classes k
       ${options.catalog || ids === null ? "" : "WHERE k.id = ANY($1::text[])"}
       ORDER BY k.is_active DESC, k.created_at ASC`, options.catalog || ids === null ? [] : [ids],
    );
    // Base directory only: no members, counts, assignments or observations.
    return rows.map((row) => mapClass(row.data));
  });
}

export function scopedListChildren(request?: HeaderCarrier): Promise<Child[]> {
  return withScopedRead(request, async (principal) => {
    const ids = classIds(principal);
    const rows = await query<{ data: Row }>(
      `SELECT to_jsonb(c.*) || jsonb_build_object('current_class', (
         SELECT to_jsonb(k.*) FROM child_class_enrollments e JOIN classes k ON k.id = e.class_id
          WHERE e.child_id = c.id AND e.end_date IS NULL ORDER BY e.start_date DESC LIMIT 1
       )) AS data FROM children c
       ${ids === null ? "" : "WHERE EXISTS (SELECT 1 FROM child_class_enrollments e WHERE e.child_id = c.id AND e.end_date IS NULL AND e.class_id = ANY($1::text[]))"}
       ORDER BY c.created_at ASC LIMIT 1000`, ids === null ? [] : [ids],
    );
    return rows.map((row) => mapChild(row.data));
  });
}

export function scopedListObservations(
  filters: { childId?: string; status?: string; limit?: number } = {}, request?: HeaderCarrier,
): Promise<ScopedObservation[]> {
  return withScopedRead(request, async (principal) => {
    const ids = classIds(principal);
    const params: unknown[] = [ids];
    const current = "EXISTS (SELECT 1 FROM child_class_enrollments e WHERE e.child_id = o.child_id AND e.end_date IS NULL AND e.class_id = ANY($1::text[]))";
    const full = ids === null ? "$1::text[] IS NULL" : current;
    const conditions = ids === null ? [] : [`(${current} OR o.class_id = ANY($1::text[]))`];
    if (filters.childId) {
      const access = await query<{ visible: boolean }>(
        `SELECT (EXISTS (SELECT 1 FROM child_class_enrollments e WHERE e.child_id = $2 AND e.end_date IS NULL AND ($1::text[] IS NULL OR e.class_id = ANY($1::text[])))
          OR EXISTS (SELECT 1 FROM observations o WHERE o.child_id = $2 AND ($1::text[] IS NULL OR o.class_id = ANY($1::text[])))) AS visible`, [ids, filters.childId],
      );
      if (!access[0]?.visible && ids !== null) throw new AccountsError("out_of_scope", "无权读取该幼儿的观察。");
      params.push(filters.childId); conditions.push(`o.child_id = $${params.length}`);
    }
    if (filters.status) { params.push(filters.status); conditions.push(`o.status = $${params.length}`); }
    params.push(filters.limit ?? 1000);
    const rows = await query<{ data: Row; full: boolean }>(
      `SELECT (${full}) AS full, to_jsonb(o.*) || jsonb_build_object('observed_class',
        (SELECT to_jsonb(k.*) FROM classes k WHERE k.id = o.class_id)) AS data FROM observations o
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY o.created_at DESC LIMIT $${params.length}`, params,
    );
    return rows.map((row) => projectObservation(mapObservation(row.data), row.full ? "full" : "historical_read_only", principal));
  });
}

export function scopedGetChild(id: string, request?: HeaderCarrier): Promise<Child | null> {
  return withBusinessRead(request, "child.read", { kind: "child", child_id: id }, () => getChild(id));
}
export function scopedGetClass(id: string, request?: HeaderCarrier): Promise<SchoolClass | null> {
  return withBusinessRead(request, "class.read", { kind: "class", class_id: id }, () => getClass(id));
}
export function scopedGetClassChildren(id: string, request?: HeaderCarrier): Promise<Child[]> {
  return withBusinessRead(request, "class.read", { kind: "class", class_id: id }, () => getClassChildren(id));
}
export function scopedListEnrollments(id: string, request?: HeaderCarrier) {
  return withBusinessRead(request, "child.read", { kind: "child", child_id: id }, () => listEnrollments(id));
}
export function scopedGetObservation(id: string, request?: HeaderCarrier): Promise<ScopedObservation | null> {
  return withBusinessRead(request, "observation.read", { kind: "observation", observation_id: id }, async (principal) => {
    const observation = await getObservation(id);
    if (!observation) return null;
    const ids = classIds(principal);
    const current = await query<{ class_id: string }>(
      "SELECT class_id FROM child_class_enrollments WHERE child_id = $1 AND end_date IS NULL", [observation.child_id],
    );
    const full = ids === null || current.some((row) => ids.includes(row.class_id));
    return projectObservation(observation, full ? "full" : "historical_read_only", principal);
  });
}
