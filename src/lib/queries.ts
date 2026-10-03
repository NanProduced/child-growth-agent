import {
  type TransactionClient,
  query,
  queryOne,
  withTransaction,
} from "@/storage/database/pg-client";
import { ObservationStateConflictError, StaleEvidenceError } from "./evidence-snapshot";
import { isoDateInShanghai } from "./format";
import type { ObservationClassContextSnapshot } from "./guide/types";
import type {
  ActivitySupport,
  AgentContext,
  Child,
  ChildClassEnrollment,
  ClassStage,
  GrowthProfile,
  Observation,
  ObservationDraft,
  ObservationStatus,
  SchoolClass,
} from "./types";

/** 行来自 to_jsonb(table.*)，列名为 snake_case，显式映射为接口字段（与表结构语义一致） */
type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * 一条 SQL 取出儿童 + 当前班级：班级信息随行返回，列表页不会出现逐条查班级的 N+1。
 */
const CHILD_SELECT = `SELECT to_jsonb(c.*) || jsonb_build_object(
    'current_class',
    (SELECT to_jsonb(k)
       FROM child_class_enrollments e
       JOIN classes k ON k.id = e.class_id
      WHERE e.child_id = c.id AND e.end_date IS NULL
      ORDER BY e.start_date DESC
      LIMIT 1)
  ) AS data
  FROM children c`;

/** 一条 SQL 取出观察 + 发生时班级（class_id 快照在建观察时写入） */
const OBSERVATION_SELECT = `SELECT to_jsonb(o.*) || jsonb_build_object(
    'observed_class',
    (SELECT to_jsonb(k) FROM classes k WHERE k.id = o.class_id)
  ) AS data
  FROM observations o`;

export function mapClass(row: Row): SchoolClass {
  return {
    id: str(row.id),
    name: str(row.name),
    stage: (str(row.stage) || "small") as ClassStage,
    school_year: str(row.school_year),
    is_active: Boolean(row.is_active),
    is_demo: Boolean(row.is_demo),
    created_at: str(row.created_at),
    updated_at: strOrNull(row.updated_at),
  };
}

export function mapChild(row: Row): Child {
  const currentClass = mapClassOrNull(row.current_class);
  return {
    id: str(row.id),
    name: str(row.name),
    gender: str(row.gender),
    birth_date: str(row.birth_date),
    class_name: currentClass?.name ?? str(row.class_name),
    class_id: currentClass?.id ?? null,
    current_class: currentClass,
    class_stage: currentClass?.stage ?? null,
    class_school_year: currentClass?.school_year ?? null,
    avatar_emoji: strOrNull(row.avatar_emoji),
    note: strOrNull(row.note),
    growth_profile: (row.growth_profile ?? null) as GrowthProfile | null,
    is_demo: Boolean(row.is_demo),
    created_at: str(row.created_at),
    updated_at: strOrNull(row.updated_at),
  };
}

export function mapObservation(row: Row): Observation {
  return {
    id: str(row.id),
    child_id: str(row.child_id),
    class_id: strOrNull(row.class_id),
    observed_class: mapClassOrNull(row.observed_class),
    observed_at: str(row.observed_at),
    context: strOrNull(row.context),
    raw_text: str(row.raw_text),
    status: (str(row.status) || "draft") as ObservationStatus,
    agent_context: (row.agent_context ?? null) as AgentContext | null,
    ai_draft: (row.ai_draft ?? null) as ObservationDraft | null,
    ai_model: strOrNull(row.ai_model),
    ai_organized_at: strOrNull(row.ai_organized_at),
    confirmed_content: (row.confirmed_content ?? null) as ObservationDraft | null,
    confirmed_at: strOrNull(row.confirmed_at),
    class_context_snapshot: (row.class_context_snapshot ?? null) as ObservationClassContextSnapshot | null,
    // 原始透传：NULL 是正常未关联；损坏/未知结构原样保留，由 G5 显式识别，不在此归为 NULL
    guide_evidence: row.guide_evidence ?? null,
    is_demo: Boolean(row.is_demo),
    created_at: str(row.created_at),
    updated_at: strOrNull(row.updated_at),
  };
}

function mapClassOrNull(value: unknown): SchoolClass | null {
  if (!value || typeof value !== "object") return null;
  return mapClass(value as Row);
}

export function mapEnrollment(row: Row): ChildClassEnrollment {
  return {
    id: str(row.id),
    child_id: str(row.child_id),
    class_id: str(row.class_id),
    start_date: str(row.start_date),
    end_date: strOrNull(row.end_date),
    created_at: str(row.created_at),
  };
}

/** 班级列表（含已停用班级，is_active 由调用方决定如何展示） */
export async function listClasses(): Promise<SchoolClass[]> {
  const rows = await query<{ data: Row }>(
    "SELECT to_jsonb(classes.*) AS data FROM classes ORDER BY is_active DESC, created_at ASC"
  );
  return rows.map((r) => mapClass(r.data));
}

export async function getClass(id: string): Promise<SchoolClass | null> {
  const row = await queryOne<{ data: Row }>(
    "SELECT to_jsonb(classes.*) AS data FROM classes WHERE id = $1",
    [id]
  );
  return row ? mapClass(row.data) : null;
}

/** 按名称 + 学年查找班级；同学年重名由校验与唯一索引共同阻止 */
export async function findClassByName(name: string, schoolYear: string): Promise<SchoolClass | null> {
  const row = await queryOne<{ data: Row }>(
    "SELECT to_jsonb(classes.*) AS data FROM classes WHERE name = $1 AND school_year = $2",
    [name, schoolYear]
  );
  return row ? mapClass(row.data) : null;
}

/** 按名称查找班级（最多返回 2 条，供按名称分班时判断是否存在同名歧义） */
export async function findClassesByName(name: string): Promise<SchoolClass[]> {
  const rows = await query<{ data: Row }>(
    `SELECT to_jsonb(classes.*) AS data FROM classes
      WHERE name = $1 ORDER BY is_active DESC, created_at ASC LIMIT 2`,
    [name]
  );
  return rows.map((r) => mapClass(r.data));
}

export async function createClass(input: {
  name: string;
  stage: ClassStage;
  school_year: string;
  is_active?: boolean;
}): Promise<SchoolClass> {
  // 每个参数只出现一次并显式定型，避免 Postgres 对同一参数推导出 varchar / text 两种类型
  const row = await queryOne<{ data: Row }>(
    `WITH input AS (
       SELECT $1::varchar AS name, $2::varchar AS stage, $3::varchar AS school_year, $4::boolean AS is_active
     )
     INSERT INTO classes (name, stage, school_year, is_active)
     SELECT name, stage, school_year, is_active
       FROM input
      WHERE NOT EXISTS (
        SELECT 1 FROM classes c WHERE c.name = input.name AND c.school_year = input.school_year
      )
     RETURNING to_jsonb(classes.*) AS data`,
    [input.name, input.stage, input.school_year, input.is_active ?? true]
  );
  if (!row) throw new Error(`同学年下已存在同名班级「${input.name}」`);
  return mapClass(row.data);
}

export async function updateClass(
  id: string,
  patch: { name?: string; stage?: ClassStage; school_year?: string; is_active?: boolean }
): Promise<SchoolClass | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.stage !== undefined) set("stage", patch.stage);
  if (patch.school_year !== undefined) set("school_year", patch.school_year);
  if (patch.is_active !== undefined) set("is_active", patch.is_active);
  if (sets.length === 0) return getClass(id);
  sets.push("updated_at = now()");
  const row = await queryOne<{ data: Row }>(
    `UPDATE classes SET ${sets.join(", ")} WHERE id = $1 RETURNING to_jsonb(classes.*) AS data`,
    params
  );
  return row ? mapClass(row.data) : null;
}

/** 儿童当前（未结束）班级 id；无归属返回 null */
export async function getCurrentClassId(childId: string): Promise<string | null> {
  const row = await queryOne<{ class_id: string | null }>(
    `SELECT class_id FROM child_class_enrollments
      WHERE child_id = $1 AND end_date IS NULL
      ORDER BY start_date DESC LIMIT 1`,
    [childId]
  );
  return row?.class_id ?? null;
}

/** 儿童的全部班级归属历史（转班后旧归属保留，不回改） */
export async function listEnrollments(childId: string): Promise<ChildClassEnrollment[]> {
  const rows = await query<{ data: Row }>(
    `SELECT to_jsonb(child_class_enrollments.*) AS data FROM child_class_enrollments
      WHERE child_id = $1 ORDER BY start_date ASC, created_at ASC`,
    [childId]
  );
  return rows.map((r) => mapEnrollment(r.data));
}

/**
 * 分班 / 转班：单条语句内结束旧归属、建立新归属并同步兼容字段 class_name（原子执行）。
 * 旧归属只写 end_date，历史关系不删除。
 */
export async function enrollChildInClass(input: {
  child_id: string;
  class_id: string;
  start_date?: string;
}): Promise<{ closed: number; opened: number }> {
  // 默认分班日期按服务端统一口径取亚洲/上海日历日，避免 UTC 跨日导致归属日期错位
  const startDate = input.start_date ?? isoDateInShanghai();
  const row = await queryOne<{ closed: number; opened: number }>(
    `WITH closed AS (
       UPDATE child_class_enrollments
          SET end_date = GREATEST(start_date, ($2::date - 1))
        WHERE child_id = $1::text AND end_date IS NULL
        RETURNING id
     ), opened AS (
       INSERT INTO child_class_enrollments (child_id, class_id, start_date)
       VALUES ($1::text, $3::text, $2::date)
       RETURNING id
     ), synced AS (
       UPDATE children
          SET class_name = (SELECT name FROM classes WHERE id = $3::text), updated_at = now()
        WHERE id = $1::text
     )
     SELECT (SELECT count(*) FROM closed)::int AS closed,
            (SELECT count(*) FROM opened)::int AS opened`,
    [input.child_id, startDate, input.class_id]
  );
  return { closed: row?.closed ?? 0, opened: row?.opened ?? 0 };
}

export async function listChildren(): Promise<Child[]> {
  const rows = await query<{ data: Row }>(
    `${CHILD_SELECT} ORDER BY c.created_at ASC LIMIT 1000`
  );
  return rows.map((r) => mapChild(r.data));
}

export async function getChild(id: string): Promise<Child | null> {
  const row = await queryOne<{ data: Row }>(`${CHILD_SELECT} WHERE c.id = $1`, [id]);
  return row ? mapChild(row.data) : null;
}

/** 某班级当前在班儿童（一次查询，不逐条查班级） */
export async function getClassChildren(classId: string): Promise<Child[]> {
  const rows = await query<{ data: Row }>(
    `${CHILD_SELECT}
     WHERE c.id IN (
       SELECT e.child_id FROM child_class_enrollments e
        WHERE e.class_id = $1 AND e.end_date IS NULL
     )
     ORDER BY c.created_at ASC`,
    [classId]
  );
  return rows.map((r) => mapChild(r.data));
}

export async function createChild(input: {
  name: string;
  gender: string;
  birth_date: string;
  class_id: string;
  avatar_emoji?: string;
  note?: string;
}): Promise<Child> {
  const row = await queryOne<{ data: Row }>(
    `WITH klass AS (
       SELECT id, name FROM classes WHERE id = $4
     ), new_child AS (
       INSERT INTO children (name, gender, birth_date, class_name, avatar_emoji, note)
       SELECT $1, $2, $3, klass.name, $5, $6 FROM klass
       RETURNING children.*
     ), new_enrollment AS (
       INSERT INTO child_class_enrollments (child_id, class_id, start_date)
       SELECT new_child.id, klass.id, CURRENT_DATE FROM new_child CROSS JOIN klass
       RETURNING id
     )
     SELECT to_jsonb(new_child.*) AS data FROM new_child`,
    [
      input.name,
      input.gender,
      input.birth_date,
      input.class_id,
      input.avatar_emoji ?? null,
      input.note ?? null,
    ]
  );
  if (!row) throw new Error("新增幼儿失败：班级不存在或写入后未能读取记录");
  const created = str(row.data.id);
  return (await getChild(created)) ?? mapChild(row.data);
}

/**
 * 原子条件：保存时数据库中的“已确认观察 id 集合”必须仍等于模型生成时使用的快照。
 * 作为短事务内锁后重读比较的补充防线，不作为唯一并发保障。
 */
function confirmedEvidenceMatches(paramIndex: number): string {
  return `(
    SELECT coalesce(jsonb_agg(sub.id ORDER BY sub.id), '[]'::jsonb)
      FROM (
        SELECT o.id::text AS id
          FROM observations o
         WHERE o.child_id = $1
           AND o.status = 'confirmed'
           AND o.confirmed_content IS NOT NULL
      ) sub
  ) = $${paramIndex}::jsonb`;
}

/** 与 JSONB 逐字段比较等价：键顺序无关的稳定序列化 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameIdSet(left: string[], right: string[]): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

/** 同一儿童锁是确认与档案保存的共同协调点；统一先锁 children 行 */
async function lockChild(client: TransactionClient, childId: string): Promise<void> {
  const locked = await client.query("SELECT id FROM children WHERE id = $1 FOR UPDATE", [childId]);
  if (locked.rowCount === 0) throw new Error("幼儿档案不存在");
}

/** 取得儿童锁后重读已确认观察 id 集合 */
async function readConfirmedEvidenceIds(
  client: TransactionClient,
  childId: string,
): Promise<string[]> {
  const result = await client.query<{ ids: string[] }>(
    `SELECT coalesce(jsonb_agg(sub.id ORDER BY sub.id), '[]'::jsonb) AS ids
       FROM (
         SELECT o.id::text AS id
           FROM observations o
          WHERE o.child_id = $1
            AND o.status = 'confirmed'
            AND o.confirmed_content IS NOT NULL
       ) sub`,
    [childId],
  );
  return result.rows[0]?.ids ?? [];
}

/**
 * 成长小结更新：只合并小结字段，保留同一 JSONB 中已有的 activity_support；
 * 同时移除旧的 is_fallback 标记。模型调用在事务外；保存时先锁儿童行，
 * 锁后重读证据集合并与生成快照比较，匹配才做 JSONB 定向更新。
 */
export async function updateChildGrowthProfileSummary(
  id: string,
  growth_profile: GrowthProfile,
  expectedConfirmedIds: string[],
): Promise<Child> {
  const fields: Record<string, unknown> = { ...growth_profile };
  delete fields.activity_support;
  const now = new Date().toISOString();
  const expected = [...expectedConfirmedIds].sort();
  return withTransaction(async (client) => {
    await lockChild(client, id);
    const currentIds = await readConfirmedEvidenceIds(client, id);
    if (!sameIdSet(currentIds, expected)) throw new StaleEvidenceError();
    const row = await client.query<{ data: Row }>(
      `UPDATE children
       SET growth_profile = (coalesce(growth_profile, '{}'::jsonb) - 'is_fallback') || $2::jsonb,
           updated_at = $3
       WHERE id = $1
         AND ${confirmedEvidenceMatches(4)}
       RETURNING to_jsonb(children.*) AS data`,
      [id, JSON.stringify(fields), now, JSON.stringify(expected)],
    );
    if (row.rowCount === 0) throw new StaleEvidenceError();
    return mapChild(row.rows[0].data);
  });
}

/**
 * 活动支持更新：只写入 activity_support 键，不覆盖并发的成长小结字段；
 * 仅在档案为空时用保守 fallback 作为底座。
 * 与小结保存共享同一儿童锁事务与锁后重读比较。
 */
export async function updateChildActivitySupport(
  id: string,
  activitySupport: ActivitySupport,
  fallbackProfile: GrowthProfile | null,
  expectedConfirmedIds: string[],
): Promise<Child> {
  const now = new Date().toISOString();
  const expected = [...expectedConfirmedIds].sort();
  return withTransaction(async (client) => {
    await lockChild(client, id);
    const currentIds = await readConfirmedEvidenceIds(client, id);
    if (!sameIdSet(currentIds, expected)) throw new StaleEvidenceError();
    const row = await client.query<{ data: Row }>(
      `UPDATE children
       SET growth_profile = jsonb_set(
             coalesce(growth_profile, $2::jsonb),
             '{activity_support}',
             $3::jsonb,
             true
           ),
           updated_at = $4
       WHERE id = $1
         AND ${confirmedEvidenceMatches(5)}
       RETURNING to_jsonb(children.*) AS data`,
      [
        id,
        JSON.stringify(fallbackProfile ?? {}),
        JSON.stringify(activitySupport),
        now,
        JSON.stringify(expected),
      ],
    );
    if (row.rowCount === 0) throw new StaleEvidenceError();
    return mapChild(row.rows[0].data);
  });
}

export async function countObservationsByChild(): Promise<Record<string, number>> {
  const rows = await query<{ child_id: string; count: number }>(
    "SELECT child_id, COUNT(*)::int AS count FROM observations GROUP BY child_id"
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.child_id] = row.count;
  }
  return counts;
}

export async function listObservations(
  opts: { childId?: string; status?: string; limit?: number } = {}
): Promise<Observation[]> {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (opts.childId) {
    params.push(opts.childId);
    conds.push(`child_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    conds.push(`status = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(opts.limit ?? 1000);
  const rows = await query<{ data: Row }>(
    `${OBSERVATION_SELECT} ${where} ORDER BY o.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => mapObservation(r.data));
}

export async function getObservation(id: string): Promise<Observation | null> {
  const row = await queryOne<{ data: Row }>(`${OBSERVATION_SELECT} WHERE o.id = $1`, [id]);
  return row ? mapObservation(row.data) : null;
}

/**
 * 保存观察原文：class_id 与 class_context_snapshot 由创建接口按“发生时班级”解析后传入
 * （分班历史唯一命中或教师确认），转班、改名后快照不变；raw_text 保存后不再改写。
 * guide_evidence 保持 NULL（未关联是正常状态，由 G5 后续读写）。
 */
export async function createObservation(input: {
  child_id: string;
  class_id: string;
  observed_at: string;
  context: string | null;
  raw_text: string;
  is_demo: boolean;
  class_context_snapshot: ObservationClassContextSnapshot | null;
}): Promise<Observation> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO observations
       (child_id, class_id, observed_at, context, raw_text, is_demo, class_context_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [
      input.child_id,
      input.class_id,
      input.observed_at,
      input.context,
      input.raw_text,
      input.is_demo,
      input.class_context_snapshot === null
        ? null
        : JSON.stringify(input.class_context_snapshot),
    ]
  );
  if (!row) throw new Error("保存观察记录失败：写入后未能读取记录");
  const created = await getObservation(str(row.id));
  if (!created) throw new Error("保存观察记录失败：写入后未能读取记录");
  return created;
}

/**
 * 异步写入的期望快照：全部来自服务端读取，不信任客户端标记。
 * 任一字段与当前行不一致即拒绝写入（status/agent_context / ai_draft）。
 */
export type ObservationWriteGuard = {
  expectedStatus?: ObservationStatus;
  expectedAgentContext?: AgentContext | null;
  expectedAiDraft?: ObservationDraft | null;
};

function hasWriteGuard(guard: ObservationWriteGuard | undefined): boolean {
  return Boolean(
    guard &&
      (guard.expectedStatus !== undefined ||
        guard.expectedAgentContext !== undefined ||
        guard.expectedAiDraft !== undefined),
  );
}

function observationWriteConditions(
  guard: ObservationWriteGuard | undefined,
  params: unknown[],
): string {
  if (!guard) return "";
  const conditions: string[] = [];
  if (guard.expectedStatus !== undefined) {
    params.push(guard.expectedStatus);
    conditions.push(`status = $${params.length}`);
  }
  if (guard.expectedAgentContext !== undefined) {
    params.push(
      guard.expectedAgentContext === null ? null : JSON.stringify(guard.expectedAgentContext),
    );
    conditions.push(`agent_context IS NOT DISTINCT FROM $${params.length}::jsonb`);
  }
  if (guard.expectedAiDraft !== undefined) {
    params.push(guard.expectedAiDraft === null ? null : JSON.stringify(guard.expectedAiDraft));
    conditions.push(`ai_draft IS NOT DISTINCT FROM $${params.length}::jsonb`);
  }
  return conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";
}

/**
 * 写入 AI 整理草稿（原文 raw_text 永不改动）。
 * 更新语句自身保护 confirmed 状态并比较原状态/上下文/原草稿：
 * 迟到的整理结果不能覆盖较新的草稿，也不能把已确认记录降级。
 */
export async function updateObservationAiDraft(
  id: string,
  ai_draft: ObservationDraft,
  ai_model: string,
  guard?: ObservationWriteGuard,
): Promise<Observation> {
  const now = new Date().toISOString();
  const params: unknown[] = [id, JSON.stringify(ai_draft), ai_model, now];
  const guardSql = observationWriteConditions(guard, params);
  const row = await queryOne<{ data: Row }>(
    `UPDATE observations
     SET ai_draft = $2::jsonb, ai_model = $3, ai_organized_at = $4, status = 'ai_organized', updated_at = $4
     WHERE id = $1 AND status <> 'confirmed'${guardSql}
     RETURNING to_jsonb(observations.*) AS data`,
    params,
  );
  if (!row) {
    throw new ObservationStateConflictError(
      hasWriteGuard(guard)
        ? "记录已在其他操作中更新，请刷新页面后重新整理。"
        : "该记录已由教师确认归档，迟到的 AI 整理结果不会覆盖确认稿",
    );
  }
  return mapObservation(row.data);
}

/**
 * 保存 Agent 工作流上下文；不修改 raw_text 与 confirmed_content。
 * 更新语句保护 confirmed 状态，并比较原状态/上下文/原草稿快照：
 * 迟到重试不能恢复已结束状态，也不能覆盖另一请求更新的轮次或回答。
 */
export async function updateObservationAgentContext(
  id: string,
  agent_context: AgentContext,
  status: ObservationStatus,
  guard?: ObservationWriteGuard,
): Promise<Observation> {
  const now = new Date().toISOString();
  const params: unknown[] = [id, JSON.stringify(agent_context), status, now];
  const guardSql = observationWriteConditions(guard, params);
  const row = await queryOne<{ data: Row }>(
    `UPDATE observations
     SET agent_context = $2::jsonb, status = $3, updated_at = $4
     WHERE id = $1 AND status <> 'confirmed'${guardSql}
     RETURNING to_jsonb(observations.*) AS data`,
    params,
  );
  if (!row) {
    throw new ObservationStateConflictError(
      hasWriteGuard(guard)
        ? "记录已在其他操作中更新，请刷新页面后继续。"
        : "该记录已由教师确认归档，迟到的补充信息不会改写已确认记录",
    );
  }
  return mapObservation(row.data);
}

export type ConfirmObservationPremise = {
  status: ObservationStatus;
  agentContext: AgentContext | null;
  aiDraft: ObservationDraft | null;
};

/**
 * 教师确认：与其他档案保存共享同一儿童行锁。
 * 事务内先锁 children 行，再核对观察当前状态与前提快照，最后写入 confirmed_content；
 * 成功后的模型生成必须在事务提交之后执行（由调用方负责）。
 */
export async function confirmObservation(
  id: string,
  childId: string,
  confirmed_content: ObservationDraft,
  premise: ConfirmObservationPremise,
): Promise<Observation> {
  const now = new Date().toISOString();
  return withTransaction(async (client) => {
    await lockChild(client, childId);
    const current = await client.query<{
      status: string;
      agent_context: unknown;
      ai_draft: unknown;
    }>(
      `SELECT status, agent_context, ai_draft FROM observations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (current.rowCount === 0) throw new Error("确认归档失败：记录不存在");
    const row = current.rows[0];
    if (
      row.status !== premise.status ||
      canonicalJson(row.agent_context ?? null) !== canonicalJson(premise.agentContext ?? null) ||
      canonicalJson(row.ai_draft ?? null) !== canonicalJson(premise.aiDraft ?? null)
    ) {
      throw new ObservationStateConflictError(
        "记录在核对后已被更新，请刷新最新记录后重新确认。",
      );
    }
    const updated = await client.query<{ data: Row }>(
      `UPDATE observations
       SET confirmed_content = $2::jsonb, confirmed_at = $3, status = 'confirmed', updated_at = $3
       WHERE id = $1
       RETURNING to_jsonb(observations.*) AS data`,
      [id, JSON.stringify(confirmed_content), now],
    );
    if (updated.rowCount === 0) throw new Error("确认归档失败：记录不存在");
    return mapObservation(updated.rows[0].data);
  });
}
