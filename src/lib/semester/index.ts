import { isoDateInShanghai, parseIsoDateStrict } from "@/lib/format";
import type { SemesterPeriod } from "@/lib/guide/types";
import type { EvidenceScope } from "@/lib/guide/view-types";

import { CONFIGURED_SEMESTERS } from "./config";

/**
 * 学期范围解析（G2）。
 *
 * 契约（docs/guide-evidence-v1/contract.md 第 7.2 / 8 节）：
 * - 学期起止只来自显式配置，不建表、不从日期或班级学年推断；
 * - 查询优先级：semester_id > from/to（必须同时给出，否则 400）> scope；缺省当前学期；
 * - custom_range 含首尾；日期必须是真实存在的 YYYY-MM-DD；服务端“今天”统一 isoDateInShanghai()；
 * - 默认学期无法解析且未显式指定范围时返回 semester_config_missing（409）。
 */

export interface EvidenceScopeQuery {
  scope?: string | null;
  semester_id?: string | null;
  from?: string | null;
  to?: string | null;
}

export type SemesterScopeResolution =
  | { ok: true; scope: EvidenceScope }
  | { ok: false; error: "invalid_request" | "semester_config_missing"; message: string };

const ALL_HISTORY_LABEL = "全部历史";

/** 显式配置的全部学期（只读副本） */
export function listSemesters(): SemesterPeriod[] {
  return CONFIGURED_SEMESTERS.map((period) => ({ ...period }));
}

/** 按 id 取学期；不存在返回 null */
export function getSemester(id: string): SemesterPeriod | null {
  return CONFIGURED_SEMESTERS.find((period) => period.id === id) ?? null;
}

/** 日期（含首尾）落在哪个学期；日期非法或无学期覆盖时返回 null */
export function findSemesterForDate(
  date: string,
  semesters: SemesterPeriod[] = CONFIGURED_SEMESTERS,
): SemesterPeriod | null {
  if (!parseIsoDateStrict(date)) return null;
  return (
    semesters.find((period) => period.start_date <= date && date <= period.end_date) ?? null
  );
}

/** 当前学期：按亚洲/上海日历日解析；没有覆盖今天的学期时返回 null */
export function getCurrentSemester(
  today: string = isoDateInShanghai(),
  semesters: SemesterPeriod[] = CONFIGURED_SEMESTERS,
): SemesterPeriod | null {
  return findSemesterForDate(today, semesters);
}

function semesterScope(period: SemesterPeriod): EvidenceScope {
  return {
    kind: "semester",
    semester_id: period.id,
    label: period.label,
    start_date: period.start_date,
    end_date: period.end_date,
    filter_field: "observed_at",
  };
}

/**
 * 解析读模型查询参数为 EvidenceScope。
 * options 仅用于测试（注入替代校历/“今天”），业务调用不传。
 */
export function resolveEvidenceScope(
  query: EvidenceScopeQuery = {},
  options: { semesters?: SemesterPeriod[]; today?: string } = {},
): SemesterScopeResolution {
  const semesters = options.semesters ?? CONFIGURED_SEMESTERS;
  const semesterId = query.semester_id?.trim() || null;
  const from = query.from?.trim() || null;
  const to = query.to?.trim() || null;

  if (semesterId) {
    const period = semesters.find((item) => item.id === semesterId);
    if (!period) {
      return {
        ok: false,
        error: "invalid_request",
        message: `未找到学期「${semesterId}」，请检查 semester_id，或改用 from/to 指定范围`,
      };
    }
    return { ok: true, scope: semesterScope(period) };
  }

  if (from || to) {
    if (!from || !to) {
      return {
        ok: false,
        error: "invalid_request",
        message: "自定义范围必须同时提供 from 与 to（YYYY-MM-DD）",
      };
    }
    if (!parseIsoDateStrict(from) || !parseIsoDateStrict(to)) {
      return {
        ok: false,
        error: "invalid_request",
        message: "日期必须是真实存在的日历日期（YYYY-MM-DD），如 2024-02-29 合法、2025-02-29 非法",
      };
    }
    if (from > to) {
      return { ok: false, error: "invalid_request", message: "范围起点不能晚于终点" };
    }
    return {
      ok: true,
      scope: {
        kind: "custom_range",
        semester_id: null,
        label: `${from} 至 ${to}`,
        start_date: from,
        end_date: to,
        filter_field: "observed_at",
      },
    };
  }

  const requested = query.scope?.trim() || "current_semester";
  if (requested === "all_history") {
    return {
      ok: true,
      scope: {
        kind: "all_history",
        semester_id: null,
        label: ALL_HISTORY_LABEL,
        start_date: null,
        end_date: null,
        filter_field: "observed_at",
      },
    };
  }
  if (requested === "custom_range") {
    return {
      ok: false,
      error: "invalid_request",
      message: "custom_range 必须同时提供 from 与 to（YYYY-MM-DD）",
    };
  }
  if (requested !== "current_semester") {
    return {
      ok: false,
      error: "invalid_request",
      message: "scope 只能是 current_semester / all_history / custom_range",
    };
  }

  const today = options.today ?? isoDateInShanghai();
  const current = findSemesterForDate(today, semesters);
  if (!current) {
    return {
      ok: false,
      error: "semester_config_missing",
      message: `显式学期配置中没有覆盖 ${today} 的学期，请显式指定 semester_id、from/to 或 all_history`,
    };
  }
  return { ok: true, scope: semesterScope(current) };
}
