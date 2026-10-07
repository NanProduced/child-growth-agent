import type { AuthState, Principal } from "@/lib/accounts/types";
import { CLASS_STAGE_LABELS, type ClassStage, type ObservationStatus, type SchoolClass } from "@/lib/types";
import type { TransactionClient } from "@/storage/database/pg-client";
import {
  HOME_CLASS_STAGE_ORDER,
  type HomeObservationSummary, type HomePendingCounts, type HomePrimaryAction,
  type HomePrimaryActionCode, type HomeV2Data,
} from "./types";

const RECENT_PREVIEW_LIMIT = 2; // Display bound only; never applied to roster/pending counts.
const EXCERPT_MAX_CHARS = 160;
const PENDING_STATUSES = {
  confirmations: "ai_organized", supplements: "needs_input", organizes: "draft",
} as const;
type PendingCategory = keyof typeof PENDING_STATUSES;
type HomeDataActionCode = Exclude<HomePrimaryActionCode, "create_class">;

export type HomeClassSource = Pick<SchoolClass, "id" | "name" | "stage" | "school_year" | "is_active">;
export interface HomeRosterSource { child_id: string; current_class_id: string }
export interface HomeObservationSource {
  observation_id: string;
  child_id: string;
  child_name: string | null;
  /** Current server-read enrollment, not the occurrence class or author identity. */
  current_class_id: string | null;
  occurrence_snapshot: unknown;
  observed_at: string;
  created_at: string | Date;
  context: string | null;
  excerpt: string;
  status: ObservationStatus;
  is_demo: boolean;
}

/** Already authorized server projections only. null = failed read; [] = verified empty. */
export interface HomeV2Sources {
  classes: readonly HomeClassSource[] | null;
  roster: readonly HomeRosterSource[] | null;
  confirmations: readonly HomeObservationSource[] | null;
  supplements: readonly HomeObservationSource[] | null;
  organizes: readonly HomeObservationSource[] | null;
  recent: readonly HomeObservationSource[] | null;
}

const ACTIONS: Record<HomeDataActionCode, HomePrimaryAction> = {
  login: { code: "login", label: "园所账号登录", href: "/login", helper: "登录后查看你负责的班级与观察记录。" },
  process_confirmations: { code: "process_confirmations", label: "去处理待确认", href: "/observations?status=ai_organized", helper: "整理好的观察，等你核对。" },
  supplement_observation: { code: "supplement_observation", label: "补充观察信息", href: "/observations?status=needs_input", helper: "补充观察中需要核实的信息。" },
  organize_draft: { code: "organize_draft", label: "整理原始观察", href: "/observations?status=draft", helper: "原始观察已保存，可以继续整理。" },
  create_profile: { code: "create_profile", label: "建立第一个成长档案", href: "/children/new", helper: "先为负责班级的幼儿建立成长档案。" },
  start_observation: { code: "start_observation", label: "开始记录", href: "/observations/new", helper: "记下看到的具体行为和语言。" },
  await_class_assignment: { code: "await_class_assignment", label: "等待班级分配", href: "/", helper: "请联系管理员安排任教班级。" },
  manage_school: { code: "manage_school", label: "管理全园", href: "/classes", helper: "管理班级、教师账号与任教分配。" },
  retry: { code: "retry", label: "重新加载", href: "/", helper: "部分信息暂时无法读取，请稍后重试。" },
};

function emptyHome(unavailable: boolean): HomeV2Data {
  return {
    viewer: { kind: unavailable ? "identity_unavailable" : "logged_out" }, scope: null, class_groups: [],
    primary_action: { ...ACTIONS[unavailable ? "retry" : "login"] },
    pending_counts: { availability: unavailable ? "unavailable" : "available",
      confirmations: unavailable ? null : 0, supplements: unavailable ? null : 0, organizes: unavailable ? null : 0 },
    pending: [], recent: [], notices: unavailable ? [{ code: "identity_unavailable", severity: "error",
      message: "身份服务暂时不可用，首页未加载园所资料。" }] : [],
  };
}

function supportedPrincipal(principal: Principal): boolean {
  return principal.role === "admin" ? principal.scope.kind === "school"
    : principal.role === "teacher" && principal.scope.kind !== "school";
}

function uniqueObservations(rows: readonly HomeObservationSource[]): HomeObservationSource[] {
  return [...new Map(rows.map((row) => [row.observation_id, row])).values()];
}

function responsibleRows(principal: Principal, rows: readonly HomeObservationSource[] | null) {
  if (rows === null) return null;
  const ids = principal.scope.kind === "classes" ? principal.scope.class_ids : [];
  return uniqueObservations(rows.filter((row) => row.current_class_id !== null && ids.includes(row.current_class_id)));
}

function occurrenceClass(snapshot: unknown): Pick<HomeObservationSummary, "class_id" | "class_label" | "stage"> {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return { class_id: null, class_label: null, stage: null };
  }
  const value = snapshot as Record<string, unknown>;
  const stage: ClassStage | null = value.stage === "small" || value.stage === "middle" || value.stage === "large"
    ? value.stage : null;
  const name = typeof value.class_name === "string" && value.class_name.trim() ? value.class_name : null;
  return {
    class_id: typeof value.class_id === "string" && value.class_id.trim() ? value.class_id : null,
    class_label: name === null ? null : stage === null ? name : `${CLASS_STAGE_LABELS[stage]} · ${name}`,
    stage,
  };
}

function summarize(row: HomeObservationSource): HomeObservationSummary {
  // Explicit whitelist: no raw_text, auth context, current enrollment, or full child object reaches the DTO.
  return {
    observation_id: row.observation_id, child_id: row.child_id, child_name: row.child_name,
    ...occurrenceClass(row.occurrence_snapshot), observed_at: row.observed_at,
    created_at: new Date(row.created_at).toISOString(), context: row.context,
    excerpt: Array.from(row.excerpt.replace(/\s+/gu, " ").trim()).slice(0, EXCERPT_MAX_CHARS).join(""),
    status: row.status, is_demo: row.is_demo,
  };
}

function newestFirst(a: HomeObservationSource, b: HomeObservationSource): number {
  return b.observed_at.localeCompare(a.observed_at)
    || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    || a.observation_id.localeCompare(b.observation_id);
}

function teacherAction(counts: HomePendingCounts, classCount: number | null, childCount: number | null): HomeDataActionCode {
  for (const [category, code] of [
    ["confirmations", "process_confirmations"], ["supplements", "supplement_observation"], ["organizes", "organize_draft"],
  ] as const) {
    if (counts[category] === null) return "retry";
    if (counts[category] > 0) return code;
  }
  if (classCount === null || childCount === null) return "retry";
  if (classCount === 0) return "await_class_assignment";
  return childCount === 0 ? "create_profile" : "start_observation";
}

/** Pure assembly of authorized sources; never a substitute for server-side source authorization. */
export function buildHomeV2Data(auth: AuthState, sources?: HomeV2Sources): HomeV2Data {
  if (auth.kind === "unavailable") return emptyHome(true);
  if (auth.kind !== "authenticated") return emptyHome(false);
  const principal = auth.principal;
  if (principal.account_status === "disabled") return emptyHome(false);
  if (principal.account_status !== "active" || !supportedPrincipal(principal)) return emptyHome(true);
  const admin = principal.role === "admin";
  const emptyScope = !admin && (principal.scope.kind === "none"
    || (principal.scope.kind === "classes" && principal.scope.class_ids.length === 0));
  if (emptyScope) {
    return {
      ...emptyHome(false), viewer: { kind: "teacher", display_name: principal.display_name },
      scope: { kind: principal.scope.kind === "none" ? "none" : "classes", label: "暂无任教班级", class_count: 0, child_count: 0 },
      primary_action: { ...ACTIONS.await_class_assignment },
      notices: [{ code: "scope_empty", severity: "warning", message: "请联系管理员安排任教班级后，再查看或记录幼儿信息。" }],
    };
  }
  const data: HomeV2Sources = sources ?? {
    classes: null, roster: null, confirmations: null, supplements: null, organizes: null, recent: null,
  };
  const classes = data.classes === null ? null : [...new Map(data.classes.map((row) => [row.id, row])).values()];
  const pendingRows = {
    confirmations: admin ? [] : responsibleRows(principal, data.confirmations)?.filter((row) => row.status === PENDING_STATUSES.confirmations) ?? null,
    supplements: admin ? [] : responsibleRows(principal, data.supplements)?.filter((row) => row.status === PENDING_STATUSES.supplements) ?? null,
    organizes: admin ? [] : responsibleRows(principal, data.organizes)?.filter((row) => row.status === PENDING_STATUSES.organizes) ?? null,
  };
  const counts: HomePendingCounts = {
    availability: Object.values(pendingRows).some((rows) => rows === null) ? "unavailable" : "available",
    confirmations: pendingRows.confirmations?.length ?? null,
    supplements: pendingRows.supplements?.length ?? null,
    organizes: pendingRows.organizes?.length ?? null,
  };
  const classCount = classes?.length ?? null;
  const childCount = data.roster === null ? null : new Set(data.roster.map((row) => row.child_id)).size;
  const currentIds = principal.scope.kind === "classes" ? principal.scope.class_ids : [];
  // Reject a violated source contract rather than trimming a full-school array into a teacher view.
  if (!admin && (classes?.some((row) => !currentIds.includes(row.id))
    || data.roster?.some((row) => !currentIds.includes(row.current_class_id)))) return emptyHome(true);
  const recentRows = admin ? [] : responsibleRows(principal, data.recent);
  const home: HomeV2Data = {
    viewer: admin ? { kind: "admin", display_name: principal.display_name } : { kind: "teacher", display_name: principal.display_name },
    scope: { kind: admin ? "school" : "classes", label: admin ? "全园" : classes?.map((row) => row.name).join("、") || "当前任教班级",
      class_count: classCount, child_count: childCount },
    class_groups: HOME_CLASS_STAGE_ORDER.map((stage) => ({
      stage, stage_label: CLASS_STAGE_LABELS[stage],
      classes: (classes ?? []).filter((row) => row.stage === stage)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id))
        .map((row) => {
          const pendingCount = (category: PendingCategory) => pendingRows[category] === null ? null
            : pendingRows[category].filter((entry) => entry.current_class_id === row.id).length;
          return { class_id: row.id, name: row.name, stage: row.stage, school_year: row.school_year, is_active: row.is_active,
            child_count: data.roster === null ? null
              : new Set(data.roster.filter((entry) => entry.current_class_id === row.id).map((entry) => entry.child_id)).size,
            confirmation_count: pendingCount("confirmations"), supplement_count: pendingCount("supplements"), organize_count: pendingCount("organizes") };
        }),
    })).filter((group) => group.classes.length > 0),
    primary_action: { ...ACTIONS[admin ? "manage_school" : teacherAction(counts, classCount, childCount)] },
    pending_counts: counts,
    pending: Object.values(pendingRows).flatMap((rows) => [...(rows ?? [])].sort(newestFirst).map(summarize)),
    recent: [...(recentRows ?? [])].sort(newestFirst).slice(0, RECENT_PREVIEW_LIMIT).map(summarize),
    notices: [],
  };
  if (data.classes === null || data.roster === null || (!admin && (counts.availability === "unavailable" || data.recent === null))) {
    home.notices.push({ code: "data_unavailable", severity: "error", message: "部分资料未能读取，未知数量未计为零；已知待办仍可继续处理。" });
  }
  if (classCount === 0) home.notices.push({ code: "empty_classes", severity: "info", message: "当前范围还没有班级。" });
  if (classCount !== null && classCount > 0 && childCount === 0) {
    home.notices.push({ code: "empty_children", severity: "info", message: "当前范围还没有幼儿档案。" });
  }
  if (!admin && recentRows !== null && recentRows.length === 0
    && counts.confirmations === 0 && counts.supplements === 0 && counts.organizes === 0) {
    home.notices.push({ code: "empty_observations", severity: "info", message: "还没有当前负责幼儿的观察记录。" });
  }
  return home;
}

/** Recover one failed dataset without treating an aborted transaction's later reads as empty. */
async function optionalRead<T>(client: TransactionClient, read: () => Promise<T>): Promise<T | null> {
  await client.query("SAVEPOINT home_v2_dataset");
  try {
    const result = await read();
    await client.query("RELEASE SAVEPOINT home_v2_dataset");
    return result;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT home_v2_dataset");
    await client.query("RELEASE SAVEPOINT home_v2_dataset");
    return null;
  }
}

const OBSERVATION_SQL = `SELECT o.id AS observation_id, o.child_id, c.name AS child_name,
  e.class_id AS current_class_id, o.class_context_snapshot AS occurrence_snapshot,
  o.observed_at::text AS observed_at, o.created_at, o.context,
  LEFT(o.raw_text, ${EXCERPT_MAX_CHARS}) AS excerpt, o.status, o.is_demo
  FROM observations o JOIN children c ON c.id = o.child_id
  JOIN child_class_enrollments e ON e.child_id = o.child_id AND e.end_date IS NULL
  WHERE e.class_id = ANY($1::text[])`;

/** Server entry point. Auth and narrow reads are fresh on every invocation; no page/client filtering or scope cache. */
export async function loadHomeV2Data(): Promise<HomeV2Data> {
  const unavailable: AuthState = { kind: "unavailable", reason: "identity_service_unavailable" };
  try {
    const { resolveServerAuth, withScopedRead } = await import("@/lib/accounts/access");
    const auth = await resolveServerAuth();
    if (auth.state.kind !== "authenticated") return buildHomeV2Data(auth.state);
    const principal = auth.state.principal;
    if (principal.account_status !== "active" || !supportedPrincipal(principal)
      || principal.scope.kind === "none" || (principal.scope.kind === "classes" && principal.scope.class_ids.length === 0)) {
      return buildHomeV2Data(auth.state);
    }
    try {
      return await withScopedRead(undefined, async (fresh, client) => {
        if (!supportedPrincipal(fresh)) return buildHomeV2Data(unavailable);
        const admin = fresh.role === "admin";
        const ids = fresh.scope.kind === "classes" ? fresh.scope.class_ids : null;
        const classes = await optionalRead(client, async () => (await client.query<HomeClassSource>(
          `SELECT id, name, stage, school_year, is_active FROM classes
           WHERE $1::text[] IS NULL OR id = ANY($1::text[]) ORDER BY name, id`, [ids],
        )).rows);
        const roster = await optionalRead(client, async () => (await client.query<HomeRosterSource>(
          `SELECT DISTINCT e.child_id, e.class_id AS current_class_id FROM child_class_enrollments e
           JOIN children c ON c.id = e.child_id WHERE e.end_date IS NULL
           AND ($1::text[] IS NULL OR e.class_id = ANY($1::text[]))`, [ids],
        )).rows);
        const pendingRead = (status: ObservationStatus) => admin ? Promise.resolve([])
          : optionalRead(client, async () => (await client.query<HomeObservationSource>(
            `${OBSERVATION_SQL} AND o.status = $2 ORDER BY o.observed_at DESC, o.created_at DESC, o.id`, [ids, status],
          )).rows);
        const confirmations = await pendingRead(PENDING_STATUSES.confirmations);
        const supplements = await pendingRead(PENDING_STATUSES.supplements);
        const organizes = await pendingRead(PENDING_STATUSES.organizes);
        const recent = admin ? [] : await optionalRead(client, async () => (await client.query<HomeObservationSource>(
          `${OBSERVATION_SQL} ORDER BY o.observed_at DESC, o.created_at DESC, o.id LIMIT $2`, [ids, RECENT_PREVIEW_LIMIT],
        )).rows);
        return buildHomeV2Data({ kind: "authenticated", principal: fresh }, {
          classes, roster, confirmations, supplements, organizes, recent,
        });
      });
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
      if (code === "unauthenticated" || code === "account_disabled") return buildHomeV2Data({ kind: "anonymous" });
      if (code === "empty_scope") return buildHomeV2Data((await resolveServerAuth()).state);
      return buildHomeV2Data(unavailable);
    }
  } catch { return buildHomeV2Data(unavailable); }
}
