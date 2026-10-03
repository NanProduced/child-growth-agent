import { GUIDE_CATALOG } from "@/data/guide";
import { getChild, getClass, getClassChildren, listObservationsForChildren } from "@/lib/queries";
import { resolveEvidenceScope, type EvidenceScopeQuery } from "@/lib/semester";
import type { Child, SchoolClass } from "@/lib/types";

import { guideItemById } from "./item-index";
import {
  classifyGuideEvidence,
  parseGuideEvidence,
  rollupChildItem,
  rollupClassItem,
  buildBasisView,
  type ChildItemRollup,
  type EvidenceObservation,
  type LinkEvaluation,
  type RuntimeLink,
} from "./runtime";
import {
  GUIDE_AGE_BANDS,
  GUIDE_CATALOG_VERSION,
  GUIDE_DOMAIN_CODES,
  type GuideCatalog,
  type GuideGoalRef,
  type GuidePerformanceItem,
} from "./types";
import type {
  ChildEvidenceBook,
  ChildEvidenceGoalView,
  ChildGuideItemView,
  ClassChildItemStatus,
  ClassEvidenceClassRef,
  ClassEvidenceGoalView,
  ClassEvidenceOverview,
  ClassGuideItemView,
  EvidenceChildRef,
  EvidenceLinkView,
  EvidenceNotice,
  EvidenceNoticeCode,
  EvidenceScope,
  EvidenceViewFilters,
} from "./view-types";

/**
 * G5 正式读模型：个人证据册与班级证据概览。
 *
 * - 关联来自该幼儿的全部观察（不按宿主观察日期裁剪，也不受列表 LIMIT 影响）。
 * - 读模型重新核对全部必需依据；失效依据保留审计展示但不计入正式状态。
 * - 可靠性不是第四种状态；期间与阶段口径排除不降可靠性，损坏与版本不一致才降。
 * - GET 路径零模型调用、零写入。
 */

export interface EvidenceFiltersInput {
  domain?: string | null;
  age_band?: string | null;
  goal_id?: string | null;
}

export function parseEvidenceFilters(
  input: EvidenceFiltersInput,
): { ok: true; filters: EvidenceViewFilters } | { ok: false; message: string } {
  const domain = input.domain?.trim() || null;
  if (domain && !(GUIDE_DOMAIN_CODES as readonly string[]).includes(domain)) {
    return { ok: false, message: "domain 只能是 health / language / social / science / arts" };
  }
  const ageBand = input.age_band?.trim() || null;
  if (ageBand && !(GUIDE_AGE_BANDS as readonly string[]).includes(ageBand)) {
    return { ok: false, message: "age_band 只能是 3-4 / 4-5 / 5-6" };
  }
  return {
    ok: true,
    filters: {
      domain_code: domain as EvidenceViewFilters["domain_code"],
      age_band: ageBand as EvidenceViewFilters["age_band"],
      goal_id: input.goal_id?.trim() || null,
    },
  };
}

interface SelectedGoal {
  goal: GuideGoalRef;
  items: GuidePerformanceItem[];
}

function selectGoals(filters: EvidenceViewFilters): SelectedGoal[] {
  const goals: SelectedGoal[] = [];
  for (const domain of GUIDE_CATALOG.domains) {
    if (filters.domain_code && domain.code !== filters.domain_code) continue;
    for (const subDomain of domain.sub_domains) {
      for (const goal of subDomain.goals) {
        if (filters.goal_id && goal.id !== filters.goal_id) continue;
        const items = goal.items.filter(
          (item) => !filters.age_band || item.age_band === filters.age_band,
        );
        if (items.length === 0) continue;
        goals.push({
          goal: {
            id: goal.id,
            domain_id: goal.domain_id,
            sub_domain_id: goal.sub_domain_id,
            index: goal.index,
            title: goal.title,
          },
          items,
        });
      }
    }
  }
  return goals;
}

function notice(
  code: EvidenceNoticeCode,
  severity: EvidenceNotice["severity"],
  message: string,
  refs: { child_id?: string; observation_id?: string; item_id?: string } = {},
): EvidenceNotice {
  return { code, severity, message, ...refs };
}

/** 容器级通知：损坏、未知状态、目录版本、条目缺失、AI 失败；每容器/链接只提示一次 */
function collectContainerNotices(
  observations: EvidenceObservation[],
  childId: string | undefined,
  notices: EvidenceNotice[],
): { totalLinks: number; unreadableContainers: number } {
  let totalLinks = 0;
  let unreadableContainers = 0;
  for (const observation of observations) {
    const classification = classifyGuideEvidence(observation.guide_evidence);
    if (classification === "unreadable") {
      unreadableContainers += 1;
      notices.push(
        notice("guide_evidence_unreadable", "error", "这条观察的指南证据结构无法读取，相关统计按不可用处理。", {
          child_id: childId,
          observation_id: observation.id,
        }),
      );
      continue;
    }
    if (classification === "unknown_status") {
      notices.push(
        notice("unknown_link_status", "warning", "这条观察存在无法识别的关联状态，相关条目按部分可靠处理。", {
          child_id: childId,
          observation_id: observation.id,
        }),
      );
    }
    const parsed = parseGuideEvidence(observation.guide_evidence);
    if (parsed.kind !== "ok") continue;
    totalLinks += parsed.links.length;
    for (const link of parsed.links) {
      if (!guideItemById(link.item_id)) {
        notices.push(
          notice("item_not_in_catalog", "warning", "存在不在当前目录版本的关联条目，未计入正式状态。", {
            child_id: childId,
            observation_id: observation.id,
            item_id: link.item_id,
          }),
        );
      } else if (link.status !== "unknown" && link.catalog_version !== GUIDE_CATALOG_VERSION) {
        notices.push(
          notice("catalog_version_mismatch", "warning", "存在目录版本不一致的关联，未计入正式状态。", {
            child_id: childId,
            observation_id: observation.id,
            item_id: link.item_id,
          }),
        );
      }
    }
    const lastAttempt = parsed.raw.last_attempt;
    if (
      lastAttempt &&
      typeof lastAttempt === "object" &&
      (lastAttempt as { ok?: unknown }).ok === false
    ) {
      notices.push(
        notice("ai_link_failed", "warning", "最近一次 AI 关联建议没有成功，既有教师决定不受影响。", {
          child_id: childId,
          observation_id: observation.id,
        }),
      );
    }
  }
  return { totalLinks, unreadableContainers };
}

function collectEvaluationNotices(
  evaluation: LinkEvaluation,
  itemId: string,
  childId: string | undefined,
  audience: "child_history" | "class_current_roster",
  notices: EvidenceNotice[],
): void {
  if (evaluation.excluded_reason === "history_unknown" && audience === "class_current_roster") {
    notices.push(
      notice("history_unknown", "warning", "存在发生时班级未知的证据，未计入班级统计。", {
        child_id: childId,
        item_id: itemId,
      }),
    );
  }
  if (evaluation.excluded_reason === "out_of_stage_evidence") {
    notices.push(
      notice("out_of_stage_evidence", "info", "存在与当前班级学段不同的证据，按口径排除并保留来源。", {
        child_id: childId,
        item_id: itemId,
      }),
    );
  }
  evaluation.basis_checks.forEach((check, index) => {
    if (check.valid) return;
    const basis = evaluation.link.basis[index];
    if (!basis) return;
    notices.push(
      notice(
        check.reason === "version_mismatch" ? "basis_expired" : "basis_invalid",
        "warning",
        check.reason === "version_mismatch"
          ? "依据来源在决定后已变化，关联不再支持正式状态（保留审计）。"
          : "关联存在无法核对的依据，整条未计入正式状态（保留审计）。",
        { child_id: childId, observation_id: basis.observation_id, item_id: itemId },
      ),
    );
  });
}

function linkView(evaluation: LinkEvaluation, observationById: Map<string, EvidenceObservation>): EvidenceLinkView {
  const link: RuntimeLink = evaluation.link;
  return {
    link_id: link.id,
    item_id: link.item_id,
    catalog_version: link.catalog_version,
    origin: link.origin,
    // unknown 状态不进入 DTO（由 unknown_link_status 通知显式提示）；此处仅处理已知状态
    status: link.status as Exclude<RuntimeLink["status"], "unknown">,
    support: link.support,
    sustained_note: link.sustained_note,
    adult_help_used: link.adult_help_used,
    basis: link.basis.map((basis, index) =>
      buildBasisView(
        basis,
        evaluation.basis_checks[index] ?? { valid: false, reason: null },
        observationById,
      ),
    ),
    ai_reason: link.ai_reason,
    teacher_note: link.teacher_note,
    revision: link.revision,
    created_at: link.created_at,
    decided_at: link.decided_at,
    withdrawn_at: link.withdrawn_at,
    withdrawn_reason: link.withdrawn_reason,
    counts_toward_status: evaluation.counts_toward_status,
    excluded_reason: evaluation.excluded_reason,
  };
}

function countedObservedAt(evaluations: LinkEvaluation[]): string[] {
  return evaluations
    .filter((entry) => entry.counts_toward_status)
    .flatMap((entry) => entry.link.basis.map((basis) => basis.observed_at))
    .filter((value) => Boolean(value))
    .sort();
}

function childItemView(
  item: GuidePerformanceItem,
  rollup: ChildItemRollup,
  observationById: Map<string, EvidenceObservation>,
): ChildGuideItemView {
  const dates = countedObservedAt(rollup.evaluations);
  return {
    item,
    status: rollup.status,
    reliability: rollup.reliability,
    links: rollup.evaluations
      // 未知状态关联无法在冻结 DTO 中诚实表达，由 unknown_link_status 通知承担显式提示
      .filter((evaluation) => evaluation.link.status !== "unknown")
      .map((evaluation) => linkView(evaluation, observationById)),
    first_observed_at: dates[0] ?? null,
    latest_observed_at: dates[dates.length - 1] ?? null,
  };
}

export function buildChildEvidenceBook(input: {
  child: Child;
  observations: EvidenceObservation[];
  scope: EvidenceScope;
  filters: EvidenceViewFilters;
}): ChildEvidenceBook {
  const observationById = new Map(input.observations.map((observation) => [observation.id, observation]));
  const notices: EvidenceNotice[] = [];
  const { totalLinks, unreadableContainers } = collectContainerNotices(
    input.observations,
    input.child.id,
    notices,
  );

  const goals: ChildEvidenceGoalView[] = selectGoals(input.filters).map(({ goal, items }) => ({
    goal,
    items: items.map((item) => {
      const rollup = rollupChildItem({
        childId: input.child.id,
        observations: input.observations,
        item,
        observationById,
        scope: input.scope,
        audience: "child_history",
        classStage: null,
      });
      for (const evaluation of rollup.evaluations) {
        collectEvaluationNotices(evaluation, item.id, input.child.id, "child_history", notices);
      }
      return childItemView(item, rollup, observationById);
    }),
  }));

  const status_counts = { no_records: 0, has_clues: 0, confirmed_observed: 0 };
  for (const goal of goals) {
    for (const item of goal.items) status_counts[item.status] += 1;
  }
  if (totalLinks === 0 && unreadableContainers === 0) {
    notices.push(
      notice("empty_evidence", "info", "这名幼儿还没有指南证据关联；可以从观察记录中建立关联。", {
        child_id: input.child.id,
      }),
    );
  }

  const childRef: EvidenceChildRef = {
    id: input.child.id,
    name: input.child.name,
    birth_date: input.child.birth_date,
    class_id: input.child.class_id,
    class_name: input.child.current_class?.name ?? (input.child.class_name || null),
    stage: input.child.current_class?.stage ?? null,
  };

  return {
    audience: "child_history",
    child: childRef,
    catalog_version: GUIDE_CATALOG_VERSION,
    catalog: GUIDE_CATALOG as GuideCatalog,
    scope: input.scope,
    filters: input.filters,
    status_counts,
    goals,
    notices,
  };
}

function rosterChildRef(child: Child, klass: SchoolClass): EvidenceChildRef {
  return {
    id: child.id,
    name: child.name,
    birth_date: child.birth_date,
    class_id: klass.id,
    class_name: klass.name,
    stage: klass.stage,
  };
}

function pendingSuggestionCount(linkRollup: ChildItemRollup): number {
  return linkRollup.evaluations.filter((entry) => entry.link.status === "ai_suggested").length;
}

export function buildClassEvidenceOverview(input: {
  klass: SchoolClass;
  roster: Child[];
  observationsByChild: Map<string, EvidenceObservation[]>;
  scope: EvidenceScope;
  filters: EvidenceViewFilters;
}): ClassEvidenceOverview {
  const seen = new Set<string>();
  const roster = input.roster.filter((child) => {
    if (seen.has(child.id)) return false;
    seen.add(child.id);
    return true;
  });
  const allObservations = roster.flatMap(
    (child) => input.observationsByChild.get(child.id) ?? [],
  );
  const observationById = new Map(allObservations.map((observation) => [observation.id, observation]));
  const notices: EvidenceNotice[] = [];
  const { totalLinks, unreadableContainers } = collectContainerNotices(allObservations, undefined, notices);
  const childrenForRollup = roster.map((child) => ({
    childId: child.id,
    observations: input.observationsByChild.get(child.id) ?? [],
  }));

  const goals: ClassEvidenceGoalView[] = selectGoals(input.filters).map(({ goal, items }) => ({
    goal,
    items: items.map((item) => {
      const rollup = rollupClassItem({
        children: childrenForRollup,
        item,
        observationById,
        scope: input.scope,
        classStage: input.klass.stage,
      });
      const childStatuses: ClassChildItemStatus[] = childrenForRollup.map((child) => {
        const childRollup = rollupChildItem({
          childId: child.childId,
          observations: child.observations,
          item,
          observationById,
          scope: input.scope,
          audience: "class_current_roster",
          classStage: input.klass.stage,
        });
        for (const evaluation of childRollup.evaluations) {
          collectEvaluationNotices(evaluation, item.id, child.childId, "class_current_roster", notices);
        }
        const counted = childRollup.evaluations.filter((entry) => entry.counts_toward_status);
        const dates = counted
          .flatMap((entry) => entry.link.basis.map((basis) => basis.observed_at))
          .filter(Boolean)
          .sort();
        return {
          child_id: child.childId,
          status: childRollup.status,
          reliability: childRollup.reliability,
          confirmed_link_count: counted.filter(
            (entry) =>
              entry.link.status === "confirmed_performance" || entry.link.status === "confirmed_clue",
          ).length,
          pending_suggestion_count: pendingSuggestionCount(childRollup),
          first_observed_at: dates[0] ?? null,
          latest_observed_at: dates[dates.length - 1] ?? null,
        };
      });
      const view: ClassGuideItemView = {
        item,
        counts: rollup.counts,
        total: rollup.total,
        reliability: rollup.reliability,
        confirmed_ratio: rollup.confirmed_ratio,
        children: childStatuses,
      };
      return view;
    }),
  }));

  const classRef: ClassEvidenceClassRef = {
    id: input.klass.id,
    name: input.klass.name,
    stage: input.klass.stage,
    school_year: input.klass.school_year,
    is_active: input.klass.is_active,
  };
  if (roster.length === 0) {
    notices.push(notice("empty_roster", "info", "当前班级还没有在班幼儿，无法统计。"));
  } else if (totalLinks === 0 && unreadableContainers === 0) {
    notices.push(notice("empty_evidence", "info", "当前名单还没有指南证据关联。"));
  }

  return {
    audience: "class_current_roster",
    class: classRef,
    catalog_version: GUIDE_CATALOG_VERSION,
    catalog: GUIDE_CATALOG as GuideCatalog,
    scope: input.scope,
    filters: input.filters,
    roster: {
      child_count: roster.length,
      children: roster.map((child) => rosterChildRef(child, input.klass)),
    },
    goals,
    notices,
  };
}

export type EvidenceLoadFailure = {
  status: 400 | 404 | 409 | 500;
  error: string;
  message: string;
};

export type EvidenceLoadResult<T> = { ok: true; value: T } | { ok: false; failure: EvidenceLoadFailure };

function resolveScopeOrFailure(
  query: EvidenceScopeQuery,
): { ok: true; scope: EvidenceScope } | { ok: false; failure: EvidenceLoadFailure } {
  const resolved = resolveEvidenceScope(query);
  if (resolved.ok) return { ok: true, scope: resolved.scope };
  return {
    ok: false,
    failure: {
      status: resolved.error === "semester_config_missing" ? 409 : 400,
      error: resolved.error,
      message: resolved.message,
    },
  };
}

export async function loadChildEvidenceBook(
  childId: string,
  query: EvidenceScopeQuery & EvidenceFiltersInput,
): Promise<EvidenceLoadResult<ChildEvidenceBook>> {
  const child = await getChild(childId);
  if (!child) {
    return { ok: false, failure: { status: 404, error: "not_found", message: "幼儿不存在" } };
  }
  const scope = resolveScopeOrFailure(query);
  if (!scope.ok) return scope;
  const filters = parseEvidenceFilters(query);
  if (!filters.ok) {
    return { ok: false, failure: { status: 400, error: "invalid_request", message: filters.message } };
  }
  const observations = await listObservationsForChildren([childId]);
  return {
    ok: true,
    value: buildChildEvidenceBook({
      child,
      observations,
      scope: scope.scope,
      filters: filters.filters,
    }),
  };
}

export async function loadClassEvidenceOverview(
  classId: string,
  query: EvidenceScopeQuery & EvidenceFiltersInput,
): Promise<EvidenceLoadResult<ClassEvidenceOverview>> {
  const klass = await getClass(classId);
  if (!klass) {
    return { ok: false, failure: { status: 404, error: "not_found", message: "班级不存在" } };
  }
  const scope = resolveScopeOrFailure(query);
  if (!scope.ok) return scope;
  const filters = parseEvidenceFilters(query);
  if (!filters.ok) {
    return { ok: false, failure: { status: 400, error: "invalid_request", message: filters.message } };
  }
  const roster = await getClassChildren(classId);
  const observations = await listObservationsForChildren(roster.map((child) => child.id));
  const observationsByChild = new Map<string, EvidenceObservation[]>();
  for (const child of roster) observationsByChild.set(child.id, []);
  for (const observation of observations) {
    const list = observationsByChild.get(observation.child_id);
    if (list) list.push(observation);
  }
  return {
    ok: true,
    value: buildClassEvidenceOverview({
      klass,
      roster,
      observationsByChild,
      scope: scope.scope,
      filters: filters.filters,
    }),
  };
}
