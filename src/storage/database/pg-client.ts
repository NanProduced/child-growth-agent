import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function pool(): Pool {
  // Local development uses DATABASE_URL; Coze Programming injects PGDATABASE_URL
  // for its managed PostgreSQL resource in production.
  const url = process.env.DATABASE_URL?.trim() || process.env.PGDATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL or PGDATABASE_URL is not set");
  }
  if (!global.__pgPool) {
    global.__pgPool = new Pool({ connectionString: url, max: 5 });
  }
  return global.__pgPool;
}

/** 行以 to_jsonb(table.*) 返回，时间戳/jsonb 的序列化行为与 PostgREST 一致 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool().query(sql, params as never[]);
  return res.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}
