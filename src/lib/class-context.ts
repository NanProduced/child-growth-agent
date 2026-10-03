import type { ObservationClassContextSnapshot } from "@/lib/guide/types";
import { parseIsoDateStrict } from "@/lib/format";
import { mapClass } from "@/lib/queries";
import type { ClassStage, SchoolClass } from "@/lib/types";
import { query, queryOne } from "@/storage/database/pg-client";

/**
 * 观察发生时班级解析（G2）。
 *
 * 规则（契约第 4 节与任务约束）：
 * - 按 observed_at 查当时的分班历史（start_date ≤ observed_at ≤ end_date，含首尾），
 *   不套用儿童当前班级；
 * - 恰好命中一条有效归属 → enrollment_lookup；
 * - 无归属、同日/重叠归属、分班历史异常 → 不猜默认班级，要求教师确认当时班级（teacher_confirmed）；
 * - 快照的班级名称/阶段/学年一律由服务端按 classes 行核实写入，不信任客户端提交的快照内容；
 * - 旧记录快照保持 NULL=历史未知，不用动态 classes.stage 回填。
 */

export type ClassContextConfirmationReason =
  | "no_attribution"
  | "overlapping_attribution"
  | "unreliable_history";

export const CLASS_CONTEXT_REASON_MESSAGES: Record<ClassContextConfirmationReason, string> = {
  no_attribution: "分班历史中没有覆盖这条观察日期的班级归属，请选择当时幼儿所在的班级。",
  overlapping_attribution: "这条观察日期同时落在多条分班记录中，无法自动确定当时班级，请选择。",
  unreliable_history: "这名幼儿的分班历史存在异常记录，无法自动确定当时班级，请选择。",
};

/** 重叠命中时的候选归属（供教师确认参考；教师也可选择其他班级） */
export interface ClassContextCandidate {
  enrollment_id: string;
  class_id: string;
  class_name: string;
  stage: ClassStage;
  school_year: string;
  start_date: string;
  end_date: string | null;
}

export type ClassContextLookup =
  | {
      status: "resolved";
      reason: null;
      enrollment_id: string;
      class: SchoolClass;
      candidates: [];
    }
  | {
      status: "needs_confirmation";
      reason: ClassContextConfirmationReason;
      enrollment_id: null;
      class: null;
      candidates: ClassContextCandidate[];
    };

type Row = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function mapCandidate(row: {
  enrollment_data: Row;
  class_data: Row;
}): ClassContextCandidate {
  const klass = mapClass(row.class_data);
  const enrollment = row.enrollment_data;
  return {
    enrollment_id: str(enrollment.id),
    class_id: klass.id,
    class_name: klass.name,
    stage: klass.stage,
    school_year: klass.school_year,
    start_date: str(enrollment.start_date),
    end_date: strOrNull(enrollment.end_date),
  };
}

/**
 * 按观察发生日期解析当时班级。调用方负责日期格式校验（本函数也会拒收非法日期）。
 */
export async function resolveClassContextAt(
  childId: string,
  observedAt: string,
): Promise<ClassContextLookup> {
  if (!parseIsoDateStrict(observedAt)) {
    throw new Error("观察日期必须是真实存在的日历日期（YYYY-MM-DD）");
  }

  const broken = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM child_class_enrollments
      WHERE child_id = $1
        AND end_date IS NOT NULL
        AND end_date < start_date`,
    [childId],
  );
  if ((broken?.count ?? 0) > 0) {
    return {
      status: "needs_confirmation",
      reason: "unreliable_history",
      enrollment_id: null,
      class: null,
      candidates: [],
    };
  }

  const rows = await query<{
    enrollment_data: Row;
    class_data: Row;
  }>(
    `SELECT to_jsonb(e.*) AS enrollment_data, to_jsonb(k.*) AS class_data
       FROM child_class_enrollments e
       JOIN classes k ON k.id = e.class_id
      WHERE e.child_id = $1
        AND e.start_date <= $2::date
        AND (e.end_date IS NULL OR e.end_date >= $2::date)
      ORDER BY e.start_date ASC, e.id ASC`,
    [childId, observedAt],
  );

  if (rows.length === 1) {
    return {
      status: "resolved",
      reason: null,
      enrollment_id: str(rows[0].enrollment_data.id),
      class: mapClass(rows[0].class_data),
      candidates: [],
    };
  }

  if (rows.length === 0) {
    return {
      status: "needs_confirmation",
      reason: "no_attribution",
      enrollment_id: null,
      class: null,
      candidates: [],
    };
  }

  return {
    status: "needs_confirmation",
    reason: "overlapping_attribution",
    enrollment_id: null,
    class: null,
    candidates: rows.map(mapCandidate),
  };
}

/** 由分班历史解析结果构造快照（source=enrollment_lookup，记录依据的归属 id） */
export function buildEnrollmentSnapshot(
  klass: SchoolClass,
  enrollmentId: string,
  capturedAt: string = new Date().toISOString(),
): ObservationClassContextSnapshot {
  return {
    class_id: klass.id,
    class_name: klass.name,
    stage: klass.stage,
    school_year: klass.school_year,
    captured_at: capturedAt,
    source: "enrollment_lookup",
    enrollment_id: enrollmentId,
    confirmed_at: null,
  };
}

/** 由教师确认的班级构造快照（source=teacher_confirmed；名称/阶段/学年以服务端 classes 行为准） */
export function buildTeacherConfirmedSnapshot(
  klass: SchoolClass,
  confirmedAt: string = new Date().toISOString(),
): ObservationClassContextSnapshot {
  return {
    class_id: klass.id,
    class_name: klass.name,
    stage: klass.stage,
    school_year: klass.school_year,
    captured_at: confirmedAt,
    source: "teacher_confirmed",
    enrollment_id: null,
    confirmed_at: confirmedAt,
  };
}

/** 班级是否有使用历史（分班归属或观察引用）；用于阻止直接改学段/学年“升班” */
export interface ClassHistoryCounts {
  enrollment_count: number;
  observation_count: number;
}

export async function getClassHistoryCounts(classId: string): Promise<ClassHistoryCounts> {
  const row = await queryOne<{ enrollment_count: number; observation_count: number }>(
    `SELECT
      (SELECT count(*) FROM child_class_enrollments WHERE class_id = $1)::int AS enrollment_count,
      (SELECT count(*) FROM observations WHERE class_id = $1)::int AS observation_count`,
    [classId],
  );
  return {
    enrollment_count: row?.enrollment_count ?? 0,
    observation_count: row?.observation_count ?? 0,
  };
}

export function classHasHistory(counts: ClassHistoryCounts): boolean {
  return counts.enrollment_count > 0 || counts.observation_count > 0;
}
