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
 *
 * 配置边界：显式配置在校验通过前不参与查询；查询函数只返回配置的副本，
 * 调用方修改返回值不会污染后续查询。
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

function cloneSemester(period: SemesterPeriod): SemesterPeriod {
  return { ...period };
}

/**
 * 校验一份学期配置：真实日期、起止顺序、id 重复、term 取值与日期重叠。
 * 返回问题列表；空列表表示有效。
 */
export function findSemesterConfigProblems(semesters: readonly SemesterPeriod[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const period of semesters) {
    if (!period.id) problems.push("存在缺少 id 的学期");
    else if (seen.has(period.id)) problems.push(`学期 id 重复：${period.id}`);
    seen.add(period.id);
    if (period.term !== 1 && period.term !== 2) {
      problems.push(`学期 ${period.id} 的 term 只能是 1 或 2`);
    }
    const startValid = parseIsoDateStrict(period.start_date) !== null;
    const endValid = parseIsoDateStrict(period.end_date) !== null;
    if (!startValid || !endValid) {
      problems.push(`学期 ${period.id} 的起止不是真实存在的日历日期`);
      continue;
    }
    if (period.start_date > period.end_date) {
      problems.push(`学期 ${period.id} 的开始日期晚于结束日期`);
    }
  }
  const sorted = semesters
    .filter(
      (period) =>
        parseIsoDateStrict(period.start_date) !== null &&
        parseIsoDateStrict(period.end_date) !== null,
    )
    .slice()
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start_date <= sorted[i - 1].end_date) {
      problems.push(`学期 ${sorted[i - 1].id} 与 ${sorted[i].id} 的日期重叠`);
    }
  }
  return problems;
}

const configuredProblems = findSemesterConfigProblems(CONFIGURED_SEMESTERS);
if (configuredProblems.length > 0) {
  throw new Error(`学期显式配置无效：${configuredProblems.join("；")}`);
}

/** 显式配置的全部学期（副本；修改返回值不影响后续查询） */
export function listSemesters(): SemesterPeriod[] {
  return CONFIGURED_SEMESTERS.map(cloneSemester);
}

/** 按 id 取学期（副本）；不存在返回 null */
export function getSemester(id: string): SemesterPeriod | null {
  const found = CONFIGURED_SEMESTERS.find((period) => period.id === id);
  return found ? cloneSemester(found) : null;
}

/** 日期（含首尾）落在哪个学期（副本）；日期非法或无学期覆盖时返回 null */
export function findSemesterForDate(
  date: string,
  semesters: readonly SemesterPeriod[] = CONFIGURED_SEMESTERS,
): SemesterPeriod | null {
  if (!parseIsoDateStrict(date)) return null;
  const found = semesters.find(
    (period) => period.start_date <= date && date <= period.end_date,
  );
  return found ? cloneSemester(found) : null;
}

/** 当前学期（副本）：按亚洲/上海日历日解析；没有覆盖今天的学期时返回 null */
export function getCurrentSemester(
  today: string = isoDateInShanghai(),
  semesters: readonly SemesterPeriod[] = CONFIGURED_SEMESTERS,
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
  options: { semesters?: readonly SemesterPeriod[]; today?: string } = {},
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
