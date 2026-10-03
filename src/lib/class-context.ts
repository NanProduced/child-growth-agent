import type { ObservationClassContextSnapshot } from "@/lib/guide/types";
import { parseIsoDateStrict } from "@/lib/format";
import {
  BROKEN_ENROLLMENTS_SQL,
  ENROLLMENT_MATCHES_SQL,
  parseReliableClass,
} from "@/lib/queries";
import {
  CLASS_STAGES,
  type ClassStage,
  type SchoolClass,
} from "@/lib/types";
import { query, queryOne } from "@/storage/database/pg-client";

export { parseReliableClass };

/**
 * 观察发生时班级解析（G2）。
 *
 * 规则（契约第 4 节与任务约束）：
 * - 按 observed_at 查当时的分班历史（start_date ≤ observed_at ≤ end_date，含首尾），
 *   不套用儿童当前班级；
 * - 恰好命中一条有效归属 → enrollment_lookup；
 * - 无归属、同日/重叠归属、分班历史异常、班级资料无法核实 → 不猜默认班级，
 *   要求教师确认当时班级（teacher_confirmed）；
 * - 快照的班级名称/阶段/学年一律由服务端按 classes 行核实写入，不信任客户端提交的快照内容；
 * - 班级资料校验必须发生在解析与教师确认的共同来源边界：空/缺失/非法 stage 不得
 *   经过任何“默认小班”映射进入快照（reliable class 边界，而不是最后补一层检查）；
 * - 旧记录快照保持 NULL=历史未知，不用动态 classes.stage 回填。
 */

export type ClassContextConfirmationReason =
  | "no_attribution"
  | "overlapping_attribution"
  | "unreliable_history"
  | "unreliable_class_record";

export const CLASS_CONTEXT_REASON_MESSAGES: Record<ClassContextConfirmationReason, string> = {
  no_attribution: "分班历史中没有覆盖这条观察日期的班级归属，请选择当时幼儿所在的班级。",
  overlapping_attribution: "这条观察日期同时落在多条分班记录中，无法自动确定当时班级，请选择。",
  unreliable_history: "这名幼儿的分班历史存在异常记录，无法自动确定当时班级，请选择。",
  unreliable_class_record:
    "分班历史指向的班级资料无法核实（班级名称、学段或学年缺失/异常），请选择当时所在班级或先补全班级资料。",
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

/** 运行时校验一个已构造的 SchoolClass 是否可核实（供快照构造器与教师确认共用） */
export function isReliableClass(klass: SchoolClass): boolean {
  return Boolean(
    klass.id &&
      klass.name &&
      klass.school_year &&
      (CLASS_STAGES as readonly string[]).includes(klass.stage),
  );
}

/** 从数据库读取并严格核实的班级；资料无效时返回 null（不返回默认小班） */
export async function getReliableClass(classId: string): Promise<SchoolClass | null> {
  const row = await queryOne<{ data: Row }>(
    "SELECT to_jsonb(classes.*) AS data FROM classes WHERE id = $1",
    [classId],
  );
  return row ? parseReliableClass(row.data) : null;
}

function assertReliableSnapshotInput(klass: SchoolClass): void {
  if (!isReliableClass(klass)) {
    throw new Error("班级资料无法核实（名称、学段或学年缺失/异常），不写入发生时班级快照");
  }
}

function mapCandidate(
  row: { enrollment_data: Row; class_data: Row },
  klass: SchoolClass,
): ClassContextCandidate {
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

  const broken = await queryOne<{ count: number }>(BROKEN_ENROLLMENTS_SQL, [childId]);
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
  }>(ENROLLMENT_MATCHES_SQL, [childId, observedAt]);

  // 共同来源边界：先核实全部命中的班级资料，任何一条无法核实都不生成快照
  const parsed = rows.map((row) => parseReliableClass(row.class_data));
  if (parsed.some((klass) => klass === null)) {
    return {
      status: "needs_confirmation",
      reason: "unreliable_class_record",
      enrollment_id: null,
      class: null,
      candidates: [],
    };
  }

  if (rows.length === 1) {
    return {
      status: "resolved",
      reason: null,
      enrollment_id: str(rows[0].enrollment_data.id),
      class: parsed[0] as SchoolClass,
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
    candidates: rows.map((row, index) => mapCandidate(row, parsed[index] as SchoolClass)),
  };
}

/** 由分班历史解析结果构造快照（source=enrollment_lookup，记录依据的归属 id） */
export function buildEnrollmentSnapshot(
  klass: SchoolClass,
  enrollmentId: string,
  capturedAt: string = new Date().toISOString(),
): ObservationClassContextSnapshot {
  assertReliableSnapshotInput(klass);
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
  assertReliableSnapshotInput(klass);
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
