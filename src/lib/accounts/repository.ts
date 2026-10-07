import { type TransactionClient } from "@/storage/database/pg-client";

import {
  AccountsError,
  AccountNotFoundError,
  AdminAlreadyInitializedError,
  ClassNotFoundError,
  ForbiddenTargetError,
  UsernameTakenError,
} from "./errors";
import { getDummyPasswordHash, verifyPassword } from "./password";
import { safeQuery, safeQueryOne, safeTransaction } from "./pool-safety";
import { createSessionToken, hashSessionToken, toSessionView } from "./session";
import {
  AUTH_SESSION_TTL_SECONDS,
  type AccountRole,
  type AccountStatus,
  type DataScope,
  type InvalidSessionReason,
  type Principal,
  type SessionView,
  type TeacherAccountSummary,
} from "./types";

/**
 * AUTH1 数据访问层：账号、会话、任教关系。
 * - 只读写 app_accounts / app_sessions / teacher_class_assignments；
 * - 不触碰 children / observations / classes 之外的业务数据（任教只引用 classes.id 校验存在）；
 * - 登录在事务内锁账号行后再做 scrypt 校验并写入会话：与重置/停用串行化，
 *   不会签发基于旧密码前提的新会话（重置/停用事务会撤销该账号全部会话）。
 */

type AccountRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string | null;
};

type AccountWithClassesRow = AccountRow & { class_ids: unknown };

type TeacherRow = {
  id: string;
  username: string;
  display_name: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string | null;
  class_ids: unknown;
};

type SessionJoinRow = {
  session_id: string;
  session_created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  id: string;
  username: string;
  display_name: string;
  role: string;
  status: string;
  class_ids: unknown;
};

const CURRENT_CLASS_IDS_SQL = `COALESCE((
  SELECT json_agg(t.class_id ORDER BY t.class_id)
    FROM teacher_class_assignments t
   WHERE t.account_id = a.id AND t.removed_at IS NULL
), '[]'::json) AS class_ids`;

const ADMIN_BOOTSTRAP_ADVISORY_LOCK = 725032101;

function asRole(value: unknown): AccountRole {
  if (value === "admin" || value === "teacher") return value;
  throw new AccountsError("identity_unavailable", "账号角色数据不合法，已拒绝解析身份");
}

function asStatus(value: unknown): AccountStatus {
  if (value === "active" || value === "disabled") return value;
  throw new AccountsError("identity_unavailable", "账号状态数据不合法，已拒绝解析身份");
}

function isoDate(value: Date | string): string {
  return new Date(value).toISOString();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "23505";
}

/** Principal 构造所需的账号事实（不包含密码列，便于会话联表行与账号行共用） */
type PrincipalFactsRow = {
  id: string;
  username: string;
  display_name: string;
  role: string;
  status: string;
  class_ids?: unknown;
};

/** 角色/状态/任教范围全部按数据库当前值构造 Principal；停用账号范围明确为 none */
export function buildPrincipal(row: PrincipalFactsRow, schoolId: string): Principal {
  const role = asRole(row.role);
  const status = asStatus(row.status);
  let scope: DataScope;
  if (status === "disabled") {
    scope = { kind: "none", reason: "account_disabled" };
  } else if (role === "admin") {
    scope = { kind: "school", school_id: schoolId };
  } else {
    scope = { kind: "classes", class_ids: normalizeStringArray(row.class_ids) };
  }
  return {
    account_id: row.id,
    username: row.username,
    display_name: row.display_name,
    role,
    account_status: status,
    scope,
  };
}

function mapTeacherSummary(row: TeacherRow): TeacherAccountSummary {
  return {
    account_id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: "teacher",
    status: asStatus(row.status),
    class_ids: normalizeStringArray(row.class_ids),
    created_at: isoDate(row.created_at),
    updated_at: row.updated_at === null ? null : isoDate(row.updated_at),
  };
}

async function loadPrincipalWithClient(
  client: TransactionClient,
  accountId: string,
  schoolId: string,
): Promise<Principal> {
  const result = await client.query<AccountWithClassesRow>(
    `SELECT a.id, a.username, a.display_name, a.role, a.status, ${CURRENT_CLASS_IDS_SQL}
       FROM app_accounts a WHERE a.id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new AccountNotFoundError();
  return buildPrincipal(row, schoolId);
}

async function loadTeacherSummaryWithClient(
  client: TransactionClient,
  accountId: string,
): Promise<TeacherAccountSummary> {
  const result = await client.query<TeacherRow>(
    `SELECT a.id, a.username, a.display_name, a.status, a.created_at, a.updated_at, ${CURRENT_CLASS_IDS_SQL}
       FROM app_accounts a WHERE a.id = $1 AND a.role = 'teacher'`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new AccountNotFoundError();
  return mapTeacherSummary(row);
}

async function revokeAllSessionsWithClient(
  client: TransactionClient,
  accountId: string,
  reason: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE app_sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE account_id = $1 AND revoked_at IS NULL`,
    [accountId, reason],
  );
  return result.rowCount ?? 0;
}

/* --------------------------------- 登录/会话 --------------------------------- */

export type LoginOutcome =
  | { kind: "ok"; token: string; session: SessionView; principal: Principal }
  | { kind: "invalid_credentials" }
  | { kind: "account_disabled" };

/**
 * 登录：事务内 FOR UPDATE 锁定账号行 → 校验密码 → 写入会话。
 * 与并发重置/停用按同一行锁串行化；重置/停用事务会撤销该账号全部会话，
 * 因此不会留下基于旧密码/旧状态前提的新会话。
 */
export async function loginWithPassword(
  normalizedUsername: string,
  password: string,
  schoolId: string,
): Promise<LoginOutcome> {
  return safeTransaction(async (client) => {
    const result = await client.query<AccountRow>(
      `SELECT id, username, display_name, password_hash, role, status, created_at, updated_at
         FROM app_accounts WHERE username = $1 FOR UPDATE`,
      [normalizedUsername],
    );
    const account = result.rows[0];
    if (!account) {
      // 账号不存在也执行等价 scrypt，降低用户名存在性的时序差异
      const dummy = await getDummyPasswordHash();
      await verifyPassword(password, dummy);
      return { kind: "invalid_credentials" } as const;
    }
    asRole(account.role);
    const status = asStatus(account.status);
    const valid = await verifyPassword(password, account.password_hash);
    if (!valid) return { kind: "invalid_credentials" } as const;
    if (status !== "active") return { kind: "account_disabled" } as const;
    const { token, tokenHash } = createSessionToken();
    const inserted = await client.query<{ session_id: string; created_at: Date; expires_at: Date }>(
      `INSERT INTO app_sessions (account_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3::int * interval '1 second'))
       RETURNING id AS session_id, created_at, expires_at`,
      [account.id, tokenHash, AUTH_SESSION_TTL_SECONDS],
    );
    const principal = await loadPrincipalWithClient(client, account.id, schoolId);
    return { kind: "ok", token, session: toSessionView(inserted.rows[0]), principal } as const;
  });
}

export type SessionResolution =
  | { kind: "ok"; principal: Principal; session: SessionView }
  | { kind: "invalid"; reason: InvalidSessionReason };

/**
 * 解析会话：只读查询，不续期、不写库。
 * 未知令牌/已撤销/已过期/账号停用分别映射到冻结的失效原因。
 */
export async function loadSessionByToken(
  token: string,
  schoolId: string,
): Promise<SessionResolution> {
  const row = await safeQueryOne<SessionJoinRow>(
    `SELECT s.id AS session_id, s.created_at AS session_created_at, s.expires_at, s.revoked_at,
            a.id, a.username, a.display_name, a.role, a.status, ${CURRENT_CLASS_IDS_SQL}
       FROM app_sessions s
       JOIN app_accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1`,
    [hashSessionToken(token)],
  );
  if (!row) return { kind: "invalid", reason: "unknown_token" };
  if (row.revoked_at !== null) return { kind: "invalid", reason: "revoked" };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { kind: "invalid", reason: "expired" };
  }
  if (asStatus(row.status) !== "active") return { kind: "invalid", reason: "revoked" };
  return {
    kind: "ok",
    principal: buildPrincipal(row, schoolId),
    session: {
      session_id: row.session_id,
      created_at: isoDate(row.session_created_at),
      expires_at: isoDate(row.expires_at),
    },
  };
}

/** 撤销单个会话；返回实际撤销数量（0 = 已是失效状态，退出幂等） */
export async function revokeSessionToken(token: string, reason: string): Promise<number> {
  const result = await safeQuery<{ id: string }>(
    `UPDATE app_sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id`,
    [hashSessionToken(token), reason],
  );
  return result.length;
}

/** AUTH2 模型等待重核等场景：按账号解析当前 Principal（不存在返回 null） */
export async function resolvePrincipalById(
  accountId: string,
  schoolId: string,
): Promise<Principal | null> {
  const row = await safeQueryOne<AccountWithClassesRow>(
    `SELECT a.id, a.username, a.display_name, a.role, a.status, ${CURRENT_CLASS_IDS_SQL}
       FROM app_accounts a WHERE a.id = $1`,
    [accountId],
  );
  return row ? buildPrincipal(row, schoolId) : null;
}

/* ------------------------------ 首位管理员初始化 ------------------------------ */

export async function adminExists(): Promise<boolean> {
  const row = await safeQueryOne<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM app_accounts WHERE role = 'admin') AS exists`,
  );
  return row?.exists === true;
}

/**
 * 部署者脚本专用：事务内取固定 advisory lock，再检查是否已有管理员。
 * 并发初始化只有一个成功；已存在管理员时抛 AdminAlreadyInitializedError，
 * 不覆盖、不重置、不重复创建。
 */
export async function createInitialAdmin(
  input: { username: string; displayName: string; passwordHash: string },
  schoolId: string,
): Promise<Principal> {
  return safeTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [ADMIN_BOOTSTRAP_ADVISORY_LOCK]);
    const existing = await client.query(`SELECT 1 FROM app_accounts WHERE role = 'admin' LIMIT 1`);
    if ((existing.rowCount ?? 0) > 0) throw new AdminAlreadyInitializedError();
    let inserted;
    try {
      inserted = await client.query<AccountRow>(
        `INSERT INTO app_accounts (username, display_name, password_hash, role, status)
         VALUES ($1, $2, $3, 'admin', 'active')
         RETURNING id, username, display_name, password_hash, role, status, created_at, updated_at`,
        [input.username, input.displayName, input.passwordHash],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new UsernameTakenError();
      throw error;
    }
    return buildPrincipal(inserted.rows[0], schoolId);
  });
}

/* --------------------------------- 教师管理 --------------------------------- */

export interface CreateTeacherInput {
  username: string;
  displayName: string;
  passwordHash: string;
  classIds: string[];
  assignedBy: string;
}

/** 创建教师与初始任教分配：同一事务，全有或全无 */
export async function createTeacherWithAssignments(
  input: CreateTeacherInput,
): Promise<TeacherAccountSummary> {
  return safeTransaction(async (client) => {
    const classIds = [...new Set(input.classIds)];
    if (classIds.length > 0) {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM classes WHERE id = ANY($1::text[])`,
        [classIds],
      );
      if (found.rows.length !== classIds.length) {
        throw new ClassNotFoundError("创建教师失败：指定的班级不存在");
      }
    }
    let accountId: string;
    try {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO app_accounts (username, display_name, password_hash, role, status)
         VALUES ($1, $2, $3, 'teacher', 'active')
         RETURNING id`,
        [input.username, input.displayName, input.passwordHash],
      );
      accountId = inserted.rows[0].id;
    } catch (error) {
      if (isUniqueViolation(error)) throw new UsernameTakenError();
      throw error;
    }
    for (const classId of classIds) {
      await client.query(
        `INSERT INTO teacher_class_assignments (account_id, class_id, assigned_by_account_id)
         VALUES ($1, $2, $3)`,
        [accountId, classId, input.assignedBy],
      );
    }
    return loadTeacherSummaryWithClient(client, accountId);
  });
}

export async function listTeachers(): Promise<TeacherAccountSummary[]> {
  const rows = await safeQuery<TeacherRow>(
    `SELECT a.id, a.username, a.display_name, a.status, a.created_at, a.updated_at, ${CURRENT_CLASS_IDS_SQL}
       FROM app_accounts a
      WHERE a.role = 'teacher'
      ORDER BY a.created_at ASC, a.id ASC`,
  );
  return rows.map(mapTeacherSummary);
}

async function lockTeacherAccount(
  client: TransactionClient,
  accountId: string,
): Promise<void> {
  const locked = await client.query<{ role: string; status: string }>(
    `SELECT role, status FROM app_accounts WHERE id = $1 FOR UPDATE`,
    [accountId],
  );
  const row = locked.rows[0];
  if (!row) throw new AccountNotFoundError();
  asStatus(row.status);
  if (asRole(row.role) !== "teacher") {
    throw new ForbiddenTargetError();
  }
}

/**
 * 目标账号资格预检（不取锁）：与 `lockTeacherAccount` 同一判定口径，
 * 供 TOOLS 共享绑定边界在取得业务目标锁之前提前拒绝不存在/非教师目标；
 * `lockTeacherAccount` 的锁后复核保留（锁后角色/状态可能被并发修改，两处缺一不可）。
 */
export async function assertTeacherTargetEligibleWithClient(
  client: TransactionClient,
  accountId: string,
): Promise<void> {
  const found = await client.query<{ role: string; status: string }>(
    `SELECT role, status FROM app_accounts WHERE id = $1`,
    [accountId],
  );
  const row = found.rows[0];
  if (!row) throw new AccountNotFoundError();
  asStatus(row.status);
  if (asRole(row.role) !== "teacher") {
    throw new ForbiddenTargetError();
  }
}

/**
 * 启停教师的显式 client 原语（TOOLS1 批准执行同一事务内使用）：
 * 停用原子撤销该账号全部会话；响应不包含任何密码/哈希/令牌。
 */
export async function setTeacherStatusWithClient(
  client: TransactionClient,
  accountId: string,
  status: AccountStatus,
): Promise<{ teacher: TeacherAccountSummary; revokedSessionCount: number }> {
  asStatus(status);
  await lockTeacherAccount(client, accountId);
  // $2 只出现一次并显式定型，避免同一参数被推导出 varchar/text 两种类型
  await client.query(
    `WITH target AS (SELECT $2::varchar AS status)
     UPDATE app_accounts a
        SET status = t.status,
            disabled_at = CASE WHEN t.status = 'disabled' THEN now() ELSE NULL END,
            updated_at = now()
       FROM target t
      WHERE a.id = $1`,
    [accountId, status],
  );
  const revoked = status === "disabled" ? await revokeAllSessionsWithClient(client, accountId, "disabled") : 0;
  const teacher = await loadTeacherSummaryWithClient(client, accountId);
  return { teacher, revokedSessionCount: revoked };
}

export async function setTeacherStatus(
  accountId: string,
  status: AccountStatus,
): Promise<{ teacher: TeacherAccountSummary; revokedSessionCount: number }> {
  return safeTransaction((client) => setTeacherStatusWithClient(client, accountId, status));
}

/** 重置密码：原子更新哈希并撤销全部会话（哈希在事务外计算，避免长时间持锁） */
export async function resetTeacherPassword(
  accountId: string,
  passwordHash: string,
): Promise<{ teacher: TeacherAccountSummary; revokedSessionCount: number }> {
  return safeTransaction(async (client) => {
    await lockTeacherAccount(client, accountId);
    await client.query(
      `UPDATE app_accounts
          SET password_hash = $2, password_changed_at = now(), updated_at = now()
        WHERE id = $1`,
      [accountId, passwordHash],
    );
    const revoked = await revokeAllSessionsWithClient(client, accountId, "password_reset");
    const teacher = await loadTeacherSummaryWithClient(client, accountId);
    return { teacher, revokedSessionCount: revoked };
  });
}

/** 分配任教的显式 client 原语：幂等；撤销后重新分配会新增一条当前关系，历史行保留 */
export async function assignTeacherClassWithClient(
  client: TransactionClient,
  accountId: string,
  classId: string,
  actorId: string,
): Promise<TeacherAccountSummary> {
  await lockTeacherAccount(client, accountId);
  const klass = await client.query<{ id: string }>(`SELECT id FROM classes WHERE id = $1`, [classId]);
  if (klass.rowCount === 0) throw new ClassNotFoundError();
  await client.query(
    `WITH active AS (
       SELECT id FROM teacher_class_assignments
        WHERE account_id = $1 AND class_id = $2 AND removed_at IS NULL
     )
     INSERT INTO teacher_class_assignments (account_id, class_id, assigned_by_account_id)
     SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM active)`,
    [accountId, classId, actorId],
  );
  return loadTeacherSummaryWithClient(client, accountId);
}

/** 分配任教：幂等；撤销后重新分配会新增一条当前关系，历史行保留 */
export async function assignTeacherClass(
  accountId: string,
  classId: string,
  actorId: string,
): Promise<TeacherAccountSummary> {
  return safeTransaction((client) => assignTeacherClassWithClient(client, accountId, classId, actorId));
}

/** 撤销任教的显式 client 原语：只写 removed_at，保留历史；重复撤销幂等 */
export async function unassignTeacherClassWithClient(
  client: TransactionClient,
  accountId: string,
  classId: string,
  actorId: string,
): Promise<TeacherAccountSummary> {
  await lockTeacherAccount(client, accountId);
  await client.query(
    `UPDATE teacher_class_assignments
        SET removed_at = now(), removed_by_account_id = $3
      WHERE account_id = $1 AND class_id = $2 AND removed_at IS NULL`,
    [accountId, classId, actorId],
  );
  return loadTeacherSummaryWithClient(client, accountId);
}

/** 撤销任教：只写 removed_at，保留历史；不改变幼儿归属或观察快照；重复撤销幂等 */
export async function unassignTeacherClass(
  accountId: string,
  classId: string,
  actorId: string,
): Promise<TeacherAccountSummary> {
  return safeTransaction((client) => unassignTeacherClassWithClient(client, accountId, classId, actorId));
}

/**
 * 教师账号当前修订（批准业务版本比较用）：`COALESCE(updated_at, created_at)::text`。
 * 既有 schema 的 updated_at 可空；账号不存在返回 null，不伪造版本。
 */
export async function getTeacherAccountRevisionWithClient(
  client: TransactionClient,
  accountId: string,
): Promise<string | null> {
  const result = await client.query<{ revision: string | null }>(
    `SELECT COALESCE(updated_at, created_at)::text AS revision
       FROM app_accounts WHERE id = $1 AND role = 'teacher'`,
    [accountId],
  );
  return result.rows[0]?.revision ?? null;
}
