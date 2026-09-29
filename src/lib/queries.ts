import { getSupabaseClient } from "@/storage/database/supabase-client";
import type { Child, Observation, ObservationDraft, ObservationStatus } from "./types";

/** PostgREST 返回行为宽结构，这里做显式映射（snake_case -> camelCase 接口字段保持与表一致语义） */
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
  const db = await getSupabaseClient();
  const { data, error } = await db
    .from("children")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`查询幼儿档案失败：${error.message}`);
  return (data ?? []).map((row) => mapChild(row as Row));
}

export async function getChild(id: string): Promise<Child | null> {
  const db = await getSupabaseClient();
  const { data, error } = await db.from("children").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`查询幼儿档案失败：${error.message}`);
  return data ? mapChild(data as Row) : null;
}

export async function createChild(input: {
  name: string;
  gender: string;
  birth_date: string;
  class_name: string;
  avatar_emoji?: string;
  note?: string;
}): Promise<Child> {
  const db = await getSupabaseClient();
  const { data, error } = await db.from("children").insert(input).select().single();
  if (error) throw new Error(`新增幼儿失败：${error.message}`);
  return mapChild(data as Row);
}

export async function countObservationsByChild(): Promise<Record<string, number>> {
  const db = await getSupabaseClient();
  const { data, error } = await db.from("observations").select("child_id").limit(10000);
  if (error) throw new Error(`统计观察记录失败：${error.message}`);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const key = (row as Row).child_id;
    if (typeof key === "string") counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function listObservations(
  opts: { childId?: string; status?: string; limit?: number } = {}
): Promise<Observation[]> {
  const db = await getSupabaseClient();
  let query = db
    .from("observations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 1000);
  if (opts.childId) query = query.eq("child_id", opts.childId);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error } = await query;
  if (error) throw new Error(`查询观察记录失败：${error.message}`);
  return (data ?? []).map((row) => mapObservation(row as Row));
}

export async function getObservation(id: string): Promise<Observation | null> {
  const db = await getSupabaseClient();
  const { data, error } = await db.from("observations").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`查询观察记录失败：${error.message}`);
  return data ? mapObservation(data as Row) : null;
}

export async function createObservation(input: {
  child_id: string;
  observed_at: string;
  context: string | null;
  raw_text: string;
  is_demo: boolean;
}): Promise<Observation> {
  const db = await getSupabaseClient();
  const { data, error } = await db.from("observations").insert(input).select().single();
  if (error) throw new Error(`保存观察记录失败：${error.message}`);
  return mapObservation(data as Row);
}

/** 写入 AI 整理草稿（原文 raw_text 永不改动） */
export async function updateObservationAiDraft(
  id: string,
  ai_draft: ObservationDraft,
  ai_model: string
): Promise<Observation> {
  const now = new Date().toISOString();
  const db = await getSupabaseClient();
  const { data, error } = await db
    .from("observations")
    .update({
      ai_draft,
      ai_model,
      ai_organized_at: now,
      status: "ai_organized",
      updated_at: now,
    })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`保存 AI 整理结果失败：${error.message}`);
  return mapObservation(data as Row);
}

/** 教师确认：内容进入正册，状态置为 confirmed */
export async function confirmObservation(
  id: string,
  confirmed_content: ObservationDraft
): Promise<Observation> {
  const now = new Date().toISOString();
  const db = await getSupabaseClient();
  const { data, error } = await db
    .from("observations")
    .update({
      confirmed_content,
      confirmed_at: now,
      status: "confirmed",
      updated_at: now,
    })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`确认归档失败：${error.message}`);
  return mapObservation(data as Row);
}
