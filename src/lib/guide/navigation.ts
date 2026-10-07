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

/* --------------------- 记录相关观察的关注点与返回上下文（G6-WRITE1） --------------------- */

const ITEM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const EVIDENCE_RETURN_PATH = /^\/(?:children|classes)\/[A-Za-z0-9._~-]{1,128}\/evidence$/;

/** 条目 id 只允许稳定字符集；未知/非法一律按“没有关注点”处理，不静默带入 */
export function safeGuideItemId(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string" || !ITEM_ID_PATTERN.test(first)) return null;
  return first;
}

/**
 * 合法的证据页返回上下文：只允许站内相对路径，且必须指向个人/班级证据册；
 * 协议相对、外部主机、反斜杠、控制字符与超长输入一律拒绝。
 */
export function safeEvidenceReturnHref(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string" || first.length === 0 || first.length > 2000) return null;
  if (!first.startsWith("/") || first.startsWith("//")) return null;
  if (first.includes("\\") || /[\u0000-\u001f]/.test(first)) return null;
  const url = new URL(first, "http://evidence.invalid");
  if (url.origin !== "http://evidence.invalid" || !EVIDENCE_RETURN_PATH.test(url.pathname)) return null;
  return `${url.pathname}${url.search}`;
}

/** 录入页→Review 的关注点与返回参数；只输出白名单字段 */
export function observationFocusQuery(input: {
  itemId?: string | null;
  returnTo?: string | null;
}): string {
  const query = new URLSearchParams();
  const itemId = safeGuideItemId(input.itemId ?? undefined);
  if (itemId) query.set("item_id", itemId);
  const returnTo = safeEvidenceReturnHref(input.returnTo ?? undefined);
  if (returnTo) query.set("return_to", returnTo);
  return query.toString();
}

export type ObservationFocusSearch = {
  itemId: string | null;
  returnTo: string | null;
};

export function observationFocusFromSearch(search: EvidencePageSearch): ObservationFocusSearch {
  const first = (key: string): string | undefined => {
    const value = search[key];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    itemId: safeGuideItemId(first("item_id")),
    returnTo: safeEvidenceReturnHref(first("return_to")),
  };
}

/** 从证据册进入录入：携带幼儿、关注条目与返回上下文；item_id 只是关注点，不预填内容 */
export function recordObservationHref(input: {
  childId: string;
  itemId: string;
  returnTo: string | null;
}): string {
  const query = new URLSearchParams({ child_id: input.childId });
  const focus = observationFocusQuery({ itemId: input.itemId, returnTo: input.returnTo });
  for (const [key, value] of new URLSearchParams(focus)) query.set(key, value);
  return `/observations/new?${query.toString()}`;
}

/** 归档完成后的返回：在已验证的证据页 href 上强制聚焦原条目（覆盖旧 item_id） */
export function withEvidenceItemFocus(href: string, itemId: string | null): string {
  const safeHref = safeEvidenceReturnHref(href);
  if (!safeHref) return href;
  const url = new URL(safeHref, "http://evidence.invalid");
  url.searchParams.delete("item_id");
  const safeItem = safeGuideItemId(itemId ?? undefined);
  if (safeItem) url.searchParams.set("item_id", safeItem);
  return `${url.pathname}${url.search}`;
}
