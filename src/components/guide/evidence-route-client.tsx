"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChildEvidenceBook } from "./child-evidence-book";
import { ClassEvidenceOverview } from "./class-evidence-overview";
import styles from "./class-evidence-overview.module.css";
import { useTeacher } from "@/components/teacher-provider";
import { authIdentityKey } from "@/lib/accounts/client";
import {
  evidenceQueryString,
  recordObservationHref,
  type EvidencePeriodIntent,
} from "@/lib/guide/navigation";
import type { ChildEvidenceBook as ChildBook, ClassEvidenceOverview as ClassOverview, EvidenceViewFilters } from "@/lib/guide/view-types";
import type { SemesterPeriod } from "@/lib/guide/types";

type Props = {
  semesters: SemesterPeriod[];
  focusedItemId?: string;
  /**
   * 服务端按当前会话与资源事实解析的写权限；
   * false/缺省时只装配只读视图，不出现记录/活动支持入口（隐藏 UI 不替代服务端授权）。
   */
  canRecordObservation?: boolean;
  /** 班级页按幼儿当前可操作性逐人判定；缺省时不显示记录入口 */
  canRecordByChild?: Record<string, boolean>;
} & ({ audience: "child"; data: ChildBook } | { audience: "class"; data: ClassOverview });

/** 正式页面装配：只读 DTO + 记录相关观察的合法返回上下文；决定与模型调用不在本适配器内。 */
export function EvidenceRouteClient(props: Props) {
  const teacher = useTeacher();
  const readerIdentityKey = !teacher.loading && teacher.auth.state.kind === "authenticated"
    ? authIdentityKey(teacher.auth) : null;
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

  function evidenceReturnHref(): string {
    const query = evidenceQueryString(props.data.scope, props.data.filters);
    return `${path}${query ? `?${query}` : ""}`;
  }

  const recordObservation =
    props.canRecordObservation || props.canRecordByChild
      ? (child: { id: string }, item: { id: string }) =>
          router.push(
            recordObservationHref({
              childId: child.id,
              itemId: item.id,
              returnTo: evidenceReturnHref(),
            }),
          )
      : undefined;
  const anyOperable =
    props.canRecordByChild !== undefined
      ? Object.values(props.canRecordByChild).some(Boolean)
      : props.canRecordObservation === true;

  return (
    <div ref={root} aria-busy={pending} className={`${styles["route-shell"]} min-w-0`}>
      {pending ? <p role="status" className="mb-3 text-sm text-emerald-800">正在读取所选范围…</p> : null}
      {props.audience === "child" ? (
        <ChildEvidenceBook
          book={props.data}
          focusedItemId={props.focusedItemId}
          semesters={props.semesters}
          onScopeChange={(scope) => navigate(scope, props.data.filters)}
          onFiltersChange={(filters) => navigate(props.data.scope, filters)}
          onRecordObservation={props.canRecordObservation ? recordObservation : undefined}
        />
      ) : (
        <ClassEvidenceOverview
          overview={props.data}
          semesters={props.semesters}
          readerIdentityKey={readerIdentityKey}
          onRevalidateIdentity={() => { void teacher.revalidate(); }}
          onRefreshOverview={() => router.refresh()}
          onScopeChange={(scope) => navigate(scope, props.data.filters)}
          onFiltersChange={(filters) => navigate(props.data.scope, filters)}
          onRecordObservation={anyOperable ? recordObservation : undefined}
          canRecordChild={
            props.canRecordByChild
              ? (child) => props.canRecordByChild?.[child.id] === true
              : undefined
          }
          onOpenActivitySupport={
            anyOperable
              ? (child) => router.push(`/children/${encodeURIComponent(child.id)}#activity-support-title`)
              : undefined
          }
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
