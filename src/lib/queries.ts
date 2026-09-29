import { query, queryOne } from "@/storage/database/pg-client";
import type {
  AgentContext,
  Child,
  GrowthProfile,
  Observation,
  ObservationDraft,
  ObservationStatus,
} from "./types";

/** 行来自 to_jsonb(table.*)，列名为 snake_case，显式映射为接口字段（与表结构语义一致） */
type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function mapChild(row: Row): Child {
  return {
    id: str(row.id),
    name: str(row.name),
    gender: str(row.gender),
    birth_date: str(row.birth_date),
    class_name: str(row.class_name),
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
    is_demo: Boolean(row.is_demo),
    created_at: str(row.created_at),
    updated_at: strOrNull(row.updated_at),
  };
}

export async function listChildren(): Promise<Child[]> {
  const rows = await query<{ data: Row }>(
    "SELECT to_jsonb(children.*) AS data FROM children ORDER BY created_at ASC LIMIT 1000"
  );
  return rows.map((r) => mapChild(r.data));
}

export async function getChild(id: string): Promise<Child | null> {
  const row = await queryOne<{ data: Row }>(
    "SELECT to_jsonb(children.*) AS data FROM children WHERE id = $1",
    [id]
  );
  return row ? mapChild(row.data) : null;
}

export async function createChild(input: {
  name: string;
  gender: string;
  birth_date: string;
  class_name: string;
  avatar_emoji?: string;
  note?: string;
}): Promise<Child> {
  const row = await queryOne<{ data: Row }>(
    `INSERT INTO children (name, gender, birth_date, class_name, avatar_emoji, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING to_jsonb(children.*) AS data`,
    [input.name, input.gender, input.birth_date, input.class_name, input.avatar_emoji ?? null, input.note ?? null]
  );
  if (!row) throw new Error("新增幼儿失败：写入后未能读取记录");
  return mapChild(row.data);
}

export async function updateChildGrowthProfile(
  id: string,
  growth_profile: GrowthProfile,
): Promise<Child> {
  const now = new Date().toISOString();
  const row = await queryOne<{ data: Row }>(
    `UPDATE children
     SET growth_profile = $2::jsonb, updated_at = $3
     WHERE id = $1
     RETURNING to_jsonb(children.*) AS data`,
    [id, JSON.stringify(growth_profile), now],
  );
  if (!row) throw new Error("保存成长档案失败：幼儿档案不存在");
  return mapChild(row.data);
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
    `SELECT to_jsonb(observations.*) AS data FROM observations ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => mapObservation(r.data));
}

export async function getObservation(id: string): Promise<Observation | null> {
  const row = await queryOne<{ data: Row }>(
    "SELECT to_jsonb(observations.*) AS data FROM observations WHERE id = $1",
    [id]
  );
  return row ? mapObservation(row.data) : null;
}

export async function createObservation(input: {
  child_id: string;
  observed_at: string;
  context: string | null;
  raw_text: string;
  is_demo: boolean;
}): Promise<Observation> {
  const row = await queryOne<{ data: Row }>(
    `INSERT INTO observations (child_id, observed_at, context, raw_text, is_demo)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING to_jsonb(observations.*) AS data`,
    [input.child_id, input.observed_at, input.context, input.raw_text, input.is_demo]
  );
  if (!row) throw new Error("保存观察记录失败：写入后未能读取记录");
  return mapObservation(row.data);
}

/** 写入 AI 整理草稿（原文 raw_text 永不改动） */
export async function updateObservationAiDraft(
  id: string,
  ai_draft: ObservationDraft,
  ai_model: string
): Promise<Observation> {
  const now = new Date().toISOString();
  const row = await queryOne<{ data: Row }>(
    `UPDATE observations
     SET ai_draft = $2::jsonb, ai_model = $3, ai_organized_at = $4, status = 'ai_organized', updated_at = $4
     WHERE id = $1
     RETURNING to_jsonb(observations.*) AS data`,
    [id, JSON.stringify(ai_draft), ai_model, now]
  );
  if (!row) throw new Error("保存 AI 整理结果失败：记录不存在");
  return mapObservation(row.data);
}

/** 保存 Agent 工作流上下文；不修改 raw_text 与 confirmed_content。 */
export async function updateObservationAgentContext(
  id: string,
  agent_context: AgentContext,
  status: ObservationStatus,
): Promise<Observation> {
  const now = new Date().toISOString();
  const row = await queryOne<{ data: Row }>(
    `UPDATE observations
     SET agent_context = $2::jsonb, status = $3, updated_at = $4
     WHERE id = $1
     RETURNING to_jsonb(observations.*) AS data`,
    [id, JSON.stringify(agent_context), status, now],
  );
  if (!row) throw new Error("保存补充信息失败：记录不存在");
  return mapObservation(row.data);
}

/** 教师确认：内容进入正册，状态置为 confirmed */
export async function confirmObservation(
  id: string,
  confirmed_content: ObservationDraft
): Promise<Observation> {
  const now = new Date().toISOString();
  const row = await queryOne<{ data: Row }>(
    `UPDATE observations
     SET confirmed_content = $2::jsonb, confirmed_at = $3, status = 'confirmed', updated_at = $3
     WHERE id = $1
     RETURNING to_jsonb(observations.*) AS data`,
    [id, JSON.stringify(confirmed_content), now]
  );
  if (!row) throw new Error("确认归档失败：记录不存在");
  return mapObservation(row.data);
}
