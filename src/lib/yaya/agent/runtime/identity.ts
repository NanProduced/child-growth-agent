/**
 * 芽芽运行期身份重核（AGENT-APP1）。
 *
 * 每次异步边界都用**原请求绑定的会话令牌**从数据库重读当前账号/会话/任教范围与 run 行：
 * - 不缓存 Principal，不把请求体身份当权限；
 * - 会话失效 → session_invalid，账号停用 → account_disabled，身份服务失败 → identity_unavailable；
 * - run 行非 active / replaced_by 非空 / 会话或账号绑定不一致 → 返回不同 run_id，引擎按 run_replaced 停止
 *   （新 session 不能接续旧请求）；
 * - 取消请求持久化后，只 abort 本进程的 AbortController，由引擎在边界停止。
 *
 * R1：同一保存边界可复用 `verifyYayaRunBoundaryIdentity(client, ...)`，用最终落账事务的
 * 同一 client 重核当前身份；失败时返回需要落账的停止终态候选。
 */
import { loadAccountsConfig } from '@/lib/accounts/config';
import { buildPrincipal } from '@/lib/accounts/repository';
import { hashSessionToken } from '@/lib/accounts/session';
import { query, queryOne, type TransactionClient } from '@/storage/database/pg-client';

import type { YayaAgentStopReason, YayaCurrentIdentity } from '../types';

import { abortYayaRunProcess, getYayaRunProcessInstanceId, hasYayaRunProcess } from './registry';
import { loadYayaRun, type YayaRunRecord } from './store';

interface SessionRow {
  id: string;
  account_id: string;
  valid: boolean;
}

interface AccountRow {
  id: string;
  username: string;
  display_name: string;
  role: string;
  status: string;
}

/** 行查询抽象：池查询与事务 client 查询共用同一重核实现 */
type RowQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

const poolQuery: RowQuery = (sql, params) => query(sql, params);

function clientQuery(client: TransactionClient): RowQuery {
  return async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    const result = await client.query(sql, params as never[]);
    return result.rows as T[];
  };
}

async function loadCurrentAccount(runQuery: RowQuery, accountId: string) {
  const account = await runQuery<AccountRow>(
    'SELECT id, username, display_name, role, status FROM app_accounts WHERE id = $1',
    [accountId],
  );
  const row = account[0];
  if (row === undefined) return null;
  const assignments = await runQuery<{ class_id: string }>(
    `SELECT class_id FROM teacher_class_assignments
      WHERE account_id = $1 AND removed_at IS NULL ORDER BY class_id`,
    [accountId],
  );
  return { ...row, class_ids: assignments.map((entry) => entry.class_id) };
}

function replacedMarker(run: { run_id: string; replaced_by: string | null }): string {
  return run.replaced_by ?? `${run.run_id}#closed`;
}

/** 保存边界身份重核所需的 run 事实（YayaRunRecord 结构兼容） */
export interface YayaRunBoundaryFacts {
  run_id: string;
  owner_account_id: string;
  session_id: string;
  replaced_by: string | null;
  state: string;
}

/**
 * 以给定行查询重核当前身份（不缓存任何 Principal）。
 * 返回的 identity.run_id 与原 run 不一致即表示会话/账号绑定或运行状态已不允许继续。
 */
async function resolveBoundaryIdentity(
  runQuery: RowQuery,
  token: string,
  run: YayaRunBoundaryFacts,
): Promise<YayaCurrentIdentity> {
  const config = loadAccountsConfig();
  if (config === null) {
    return { run_id: run.run_id, identity_state: 'unavailable', principal: null, session_valid: false };
  }
  let session: SessionRow | null;
  try {
    const rows = await runQuery<SessionRow>(
      `SELECT id, account_id, revoked_at IS NULL AND expires_at > clock_timestamp() AS valid
         FROM app_sessions WHERE token_hash = $1`,
      [hashSessionToken(token)],
    );
    session = rows[0] ?? null;
  } catch {
    return { run_id: run.run_id, identity_state: 'unavailable', principal: null, session_valid: false };
  }
  if (session === null) {
    return { run_id: run.run_id, identity_state: 'unauthenticated', principal: null, session_valid: false };
  }
  if (run.state !== 'active' || run.replaced_by !== null) {
    return {
      run_id: replacedMarker(run),
      identity_state: 'authenticated',
      principal: null,
      session_valid: false,
    };
  }
  if (session.id !== run.session_id) {
    // 原请求不能由新 session 接续。
    return {
      run_id: `${run.run_id}#session-changed`,
      identity_state: 'authenticated',
      principal: null,
      session_valid: false,
    };
  }
  let account: Awaited<ReturnType<typeof loadCurrentAccount>>;
  try {
    account = await loadCurrentAccount(runQuery, session.account_id);
  } catch {
    return { run_id: run.run_id, identity_state: 'unavailable', principal: null, session_valid: false };
  }
  if (account === null) {
    return { run_id: run.run_id, identity_state: 'unauthenticated', principal: null, session_valid: false };
  }
  return {
    run_id: run.run_id,
    identity_state: 'authenticated',
    principal: buildPrincipal(account, config.schoolId),
    session_valid: session.valid === true,
  };
}

/**
 * 供引擎 `resolveCurrentIdentity` 使用的正式实现。
 * `token` 是发起该 run 的原始会话令牌，只存在于服务端运行上下文。
 */
export async function resolveYayaRunCurrentIdentity(input: {
  runId: string;
  token: string;
}): Promise<YayaCurrentIdentity> {
  let run: YayaRunRecord | null;
  try {
    run = await loadYayaRun(input.runId);
  } catch {
    return { run_id: input.runId, identity_state: 'unavailable', principal: null, session_valid: false };
  }
  if (run === null) {
    return {
      run_id: `${input.runId}#missing`,
      identity_state: 'unauthenticated',
      principal: null,
      session_valid: false,
    };
  }
  if (run.cancel_requested_at !== null && run.state === 'active') {
    abortYayaRunProcess(run.run_id);
  }
  return resolveBoundaryIdentity(poolQuery, input.token, run);
}

export interface YayaRunBoundaryStop {
  kind: 'stopped';
  reason: YayaAgentStopReason;
  detail: null;
}

function boundaryStop(reason: YayaAgentStopReason): YayaRunBoundaryStop {
  return { kind: 'stopped', reason, detail: null };
}

/**
 * 最后保存边界的身份重核（与终态 UPDATE 同一事务、同一 client）：
 * 返回 null 表示身份/会话/账号/运行绑定均允许落账；否则返回应落账的停止终态候选。
 */
export async function verifyYayaRunBoundaryIdentity(
  client: TransactionClient,
  input: { run: YayaRunBoundaryFacts; token: string },
): Promise<YayaRunBoundaryStop | null> {
  const identity = await resolveBoundaryIdentity(clientQuery(client), input.token, input.run);
  if (identity.identity_state === 'unavailable') return boundaryStop('identity_unavailable');
  if (identity.identity_state !== 'authenticated' || identity.principal === null) {
    return boundaryStop('unauthenticated');
  }
  if (!identity.session_valid) return boundaryStop('session_invalid');
  if (identity.principal.account_status !== 'active') return boundaryStop('account_disabled');
  if (identity.run_id !== input.run.run_id) return boundaryStop('run_replaced');
  return null;
}

/** 本进程是否是该 run 的活跃派发者（查询五态判定用；与注册表一致，不冒充恢复存储） */
export function isYayaRunOwnedByThisProcess(run: YayaRunRecord): boolean {
  return (
    run.state === 'active' &&
    run.owner_instance === getYayaRunProcessInstanceId() &&
    hasYayaRunProcess(run.run_id)
  );
}
