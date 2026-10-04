"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChildEvidenceBook } from "./child-evidence-book";
import { ClassEvidenceOverview } from "./class-evidence-overview";
import { evidenceQueryString, type EvidencePeriodIntent } from "@/lib/guide/navigation";
import type { ChildEvidenceBook as ChildBook, ClassEvidenceOverview as ClassOverview, EvidenceViewFilters } from "@/lib/guide/view-types";
import type { SemesterPeriod } from "@/lib/guide/types";

type Props = {
  semesters: SemesterPeriod[];
  focusedItemId?: string;
} & ({ audience: "child"; data: ChildBook } | { audience: "class"; data: ClassOverview });

/** Read-only G3/G4 assembly. Decisions and model calls remain outside this adapter. */
export function EvidenceRouteClient(props: Props) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [pending, startTransition] = useTransition();
  const path = props.audience === "child"
    ? `/children/${encodeURIComponent(props.data.child.id)}/evidence`
    : `/classes/${encodeURIComponent(props.data.class.id)}/evidence`;

  useEffect(() => {
    if (props.audience !== "child" || !props.focusedItemId) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(props.focusedItemId)}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLButtonElement>('[data-testid="item-disclosure"]')?.focus({ preventScroll: true });
  }, [props.audience, props.focusedItemId, props.data]);

  function navigate(scope: EvidencePeriodIntent | typeof props.data.scope, filters: EvidenceViewFilters) {
    const query = evidenceQueryString(scope, filters);
    startTransition(() => router.push(`${path}${query ? `?${query}` : ""}`, { scroll: false }));
  }

  return (
    <div ref={root} aria-busy={pending} className="min-w-0">
      {pending ? <p role="status" className="mb-3 text-sm text-emerald-800">正在读取所选范围…</p> : null}
      {props.audience === "child" ? (
        <ChildEvidenceBook
          book={props.data}
          semesters={props.semesters}
          onScopeChange={(scope) => navigate(scope, props.data.filters)}
          onFiltersChange={(filters) => navigate(props.data.scope, filters)}
        />
      ) : (
        <ClassEvidenceOverview
          overview={props.data}
          semesters={props.semesters}
          onScopeChange={(scope) => navigate(scope, props.data.filters)}
          onFiltersChange={(filters) => navigate(props.data.scope, filters)}
          onOpenChildItem={(target) => {
            const goal = props.data.catalog.domains.flatMap((domain) => domain.sub_domains)
              .flatMap((subDomain) => subDomain.goals)
              .find((entry) => entry.items.some((item) => item.id === target.item_id));
            const query = new URLSearchParams(evidenceQueryString(target.scope, {
              ...target.filters, goal_id: goal?.id ?? target.filters.goal_id,
            }));
            query.set("item_id", target.item_id);
            router.push(`/children/${encodeURIComponent(target.child_id)}/evidence?${query}`);
          }}
        />
      )}
    </div>
  );
}
