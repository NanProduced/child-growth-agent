import {
  query,
  queryOne,
  withTransaction,
  type TransactionClient,
  type TransactionConnect,
} from "@/storage/database/pg-client";

/**
 * 数据库连接失效的安全处理（AUTH1）。
 *
 * pg 连接池在后端连接被终止（数据库不可用/容器停止）时会发出 'error' 事件；
 * 没有监听器时 Node 进程会因未处理的 'error' 直接崩溃。这里只负责挂上监听器，
 * 让进程存活并把失败交给具体查询路径返回 identity_unavailable（fail closed），
 * 不修改共享的 pg-client，也不吞掉任何查询错误。
 */

function ensurePoolErrorListener(): void {
  const pool = globalThis.__pgPool;
  if (pool && pool.listenerCount("error") === 0) {
    pool.on("error", () => {
      // 连接失效由查询调用方处理（identity_unavailable）；此处仅阻止进程崩溃
    });
  }
}

export async function safeQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    return await query<T>(sql, params);
  } finally {
    ensurePoolErrorListener();
  }
}

export async function safeQueryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  try {
    return await queryOne<T>(sql, params);
  } finally {
    ensurePoolErrorListener();
  }
}

export async function safeTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>,
  connect?: TransactionConnect,
): Promise<T> {
  try {
    return await withTransaction(fn, connect);
  } finally {
    ensurePoolErrorListener();
  }
}
