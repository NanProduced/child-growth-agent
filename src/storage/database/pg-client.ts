import { Pool, type PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

const readClient = new AsyncLocalStorage<TransactionClient>();
const saveAuthorization = new AsyncLocalStorage<{
  authorize: (client: TransactionClient) => Promise<void>;
  unavailable: () => Error;
}>();

/** Only scoped server reads enter this context; never keep it around a model call. */
export function withReadClient<T>(client: TransactionClient, read: () => Promise<T>): Promise<T> {
  return readClient.run(client, read);
}

/** Business request's original session/resource premise, rechecked in every short save. */
export function withSaveAuthorization<T>(
  authorize: (client: TransactionClient) => Promise<void>,
  work: () => Promise<T>,
  unavailable: () => Error,
): Promise<T> {
  return saveAuthorization.run({ authorize, unavailable }, work);
}

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
  const client = readClient.getStore();
  const res = client ? await client.query(sql, params) : await pool().query(sql, params as never[]);
  return res.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** 事务内使用的 client 最小接口；测试可注入替身 */
export type TransactionClient = Pick<PoolClient, "query" | "release">;
export type TransactionConnect = () => Promise<TransactionClient>;

/**
 * 短事务：BEGIN → 回调（必须使用传入的同一个 client）→ COMMIT；
 * 出错回滚后抛出原错误，finally 释放 client。模型调用不得放在事务内。
 */
export async function withTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>,
  connect: TransactionConnect = () => pool().connect(),
  unavailable?: () => Error,
): Promise<T> {
  const authorization = saveAuthorization.getStore();
  const connectionFailure = unavailable ?? authorization?.unavailable;
  const client = await connect().catch((error: unknown) => { throw connectionFailure ? connectionFailure() : error; });
  try {
    try { await client.query("BEGIN"); }
    catch (error) { throw connectionFailure ? connectionFailure() : error; }
    await authorization?.authorize(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // 回滚失败不覆盖原始错误
    }
    throw error;
  } finally {
    client.release();
  }
}
