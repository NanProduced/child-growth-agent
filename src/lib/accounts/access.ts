import {
  withReadClient, withSaveAuthorization, withTransaction, type TransactionClient,
} from "@/storage/database/pg-client";
import { authorizeAction, isLegalAccessCombination } from "./authorize";
import { loadAccountsConfig } from "./config";
import { AccountsError } from "./errors";
import {
  evaluateSameOrigin, resolveRequestAuth, type HeaderCarrier, type ResolvedRequestAuth,
} from "./guards";
import { safeTransaction } from "./pool-safety";
import { buildPrincipal } from "./repository";
import { csrfMatches, hashSessionToken } from "./session";
import { CSRF_HEADER_NAME, type AccessAction, type AccessResource, type Principal } from "./types";
export type { ResolvedRequestAuth } from "./guards";

/** References contain IDs only. Attribution and authorship always come from PostgreSQL. */
export type ResourceRef =
  | { kind: "school" }
  | { kind: "class"; class_id?: string } // missing ID is only legal for class.manage (create)
  | { kind: "child"; child_id: string }
  | { kind: "transfer"; child_id: string; target_class_id: string }
  | { kind: "observation"; observation_id: string };

function legal(action: AccessAction, ref: ResourceRef): void {
  if (!isLegalAccessCombination(action, ref.kind) ||
      (ref.kind === "class" && !ref.class_id && action !== "class.manage")) {
    throw new AccountsError("invalid_request", "动作与资源组合不合法。");
  }
}

export function requireBusinessPrincipal(auth: ResolvedRequestAuth): Principal {
  if (auth.state.kind === "unavailable") {
    throw new AccountsError("identity_unavailable", "身份服务暂时不可用，请稍后重试。");
  }
  if (auth.state.kind !== "authenticated" || !auth.session || !auth.token) {
    throw new AccountsError("unauthenticated", "请先登录园所账号。");
  }
  const principal = auth.state.principal;
  if (principal.account_status !== "active") throw new AccountsError("account_disabled", "账号已停用。");
  if (principal.scope.kind === "none" ||
      (principal.scope.kind === "classes" && principal.scope.class_ids.length === 0)) {
    throw new AccountsError("empty_scope", "尚未分配任教班级，暂不能访问业务资料。");
  }
  return principal;
}

export async function serverRequest(): Promise<HeaderCarrier> {
  const { headers } = await import("next/headers");
  return { headers: await headers() };
}

export async function resolveServerAuth(): Promise<ResolvedRequestAuth> {
  const config = loadAccountsConfig();
  if (!config) return { state: { kind: "unavailable", reason: "identity_service_unavailable" }, session: null, csrf: null, token: null };
  return resolveRequestAuth(await serverRequest(), config);
}

async function demandSessionValid(client: TransactionClient, sessionId: string): Promise<void> {
  try {
    const validity = await client.query<{ valid: boolean }>(
      "SELECT revoked_at IS NULL AND expires_at > clock_timestamp() AS valid FROM app_sessions WHERE id = $1", [sessionId],
    );
    if (!validity.rows[0]?.valid) throw new AccountsError("unauthenticated", "原会话已失效，请重新登录。");
  } catch (error) {
    if (error instanceof AccountsError) throw error;
    throw new AccountsError("identity_unavailable", "无法复核原会话，已拒绝业务访问。");
  }
}

/** Account → session order also used by AUTH1 reset/disable/login; assignments lock the account. */
async function freshIdentity(
  client: TransactionClient, auth: ResolvedRequestAuth, schoolId: string,
): Promise<Principal> {
  const original = requireBusinessPrincipal(auth);
  try {
    const account = await client.query<{
      id: string; username: string; display_name: string; role: string; status: string;
    }>("SELECT id, username, display_name, role, status FROM app_accounts WHERE id = $1 FOR SHARE", [original.account_id]);
    const row = account.rows[0];
    if (!row) throw new AccountsError("unauthenticated", "原账号已失效。");
    const session = await client.query<{ id: string; account_id: string }>(
      `SELECT id, account_id
         FROM app_sessions WHERE token_hash = $1 FOR SHARE`, [hashSessionToken(auth.token!)],
    );
    const currentSession = session.rows[0];
    if (!currentSession) throw new AccountsError("unauthenticated", "原会话已失效，请重新登录。");
    // Evaluate expiry AFTER acquiring the session lock (a lock wait may cross its deadline).
    await demandSessionValid(client, currentSession.id);
    if (currentSession.id !== auth.session!.session_id || currentSession.account_id !== original.account_id) {
      throw new AccountsError("state_conflict", "原请求不能由新会话或新账号接续。");
    }
    if (row.status !== "active") throw new AccountsError("account_disabled", "账号已停用。");
    const assignments = await client.query<{ class_id: string }>(
      "SELECT class_id FROM teacher_class_assignments WHERE account_id = $1 AND removed_at IS NULL ORDER BY class_id",
      [row.id],
    );
    const principal = buildPrincipal({ ...row, class_ids: assignments.rows.map((r) => r.class_id) }, schoolId);
    requireBusinessPrincipal({ ...auth, state: { kind: "authenticated", principal } });
    return principal;
  } catch (error) {
    if (error instanceof AccountsError) throw error;
    throw new AccountsError("identity_unavailable", "无法复核当前身份与任教关系，已拒绝业务访问。");
  }
}

async function resourceFacts(
  client: TransactionClient, ref: ResourceRef, schoolId: string, write = false,
): Promise<AccessResource | null> {
  if (ref.kind === "school") return { kind: "school", school_id: schoolId };
  if (ref.kind === "class") {
    if (!ref.class_id) return { kind: "class", class_id: "new-class" };
    const result = await client.query("SELECT id FROM classes WHERE id = $1", [ref.class_id]);
    return result.rowCount ? { kind: "class", class_id: ref.class_id } : null;
  }
  let childId: string;
  let observation: { child_id: string; class_id: string | null; created_by_account_id: string | null } | undefined;
  if (ref.kind === "observation") {
    const found = await client.query<NonNullable<typeof observation>>(
      "SELECT child_id, class_id, to_jsonb(o.*)->>'created_by_account_id' AS created_by_account_id FROM observations o WHERE id = $1", [ref.observation_id],
    );
    observation = found.rows[0];
    if (!observation) return null;
    childId = observation.child_id;
  } else childId = ref.child_id;
  // Same child coordination point as enrollment and G5/R1; observations are locked later.
  const child = await client.query(`SELECT id FROM children WHERE id = $1 FOR ${write ? "UPDATE" : "SHARE"}`, [childId]);
  if (!child.rowCount) return null;
  const enrollment = await client.query<{ class_id: string }>(
    "SELECT class_id FROM child_class_enrollments WHERE child_id = $1 AND end_date IS NULL ORDER BY start_date DESC LIMIT 1", [childId],
  );
  const current_class_id = enrollment.rows[0]?.class_id ?? null;
  if (ref.kind === "observation" && observation) return {
    kind: "observation", observation_id: ref.observation_id, child_id: childId, current_class_id,
    observed_class_id: observation.class_id, author_account_id: observation.created_by_account_id,
  };
  if (ref.kind === "transfer") return { ...ref, current_class_id };
  return { kind: "child", child_id: childId, current_class_id };
}

function demand(principal: Principal, action: AccessAction, facts: AccessResource | null): void {
  // Role/scope denial must precede existence disclosure (especially admin teaching / empty teacher).
  if (!facts) {
    if (principal.role === "teacher") throw new AccountsError("out_of_scope", "无法访问该业务资源。");
    // Use the legal kind, without disclosing any resource facts, to check admin teaching rights.
    if ((action.startsWith("observation.") && action !== "observation.read") ||
        action === "guide.decide" || action === "growth_profile.write" || action === "activity_support.write") {
      throw new AccountsError("forbidden_role", "管理员不能执行教学操作。");
    }
    throw new AccountsError("not_found", "业务资源不存在。");
  }
  const decision = authorizeAction(principal, action, facts);
  if (!decision.allowed) {
    if ("invalid_request" in decision) throw new AccountsError("invalid_request", "动作与资源组合不合法。");
    throw new AccountsError(decision.deny, "当前账号没有该业务资源的操作权限。");
  }
}

async function requestAuth(request: HeaderCarrier): Promise<{ auth: ResolvedRequestAuth; schoolId: string }> {
  const config = loadAccountsConfig();
  if (!config) throw new AccountsError("identity_unavailable", "认证服务未配置，业务访问已关闭。");
  const auth = await resolveRequestAuth(request, config);
  requireBusinessPrincipal(auth);
  return { auth, schoolId: config.schoolId };
}

/** Short, same-client server read. No cached Principal, no business data before current identity. */
export async function withScopedRead<T>(
  request: HeaderCarrier | undefined,
  read: (principal: Principal, client: TransactionClient) => Promise<T>,
): Promise<T> {
  const { auth, schoolId } = await requestAuth(request ?? await serverRequest());
  return withTransaction(async (client) => {
    const principal = await freshIdentity(client, auth, schoolId);
    const result = await withReadClient(client, () => read(principal, client));
    await demandSessionValid(client, auth.session!.session_id);
    return result;
  }, undefined, () => new AccountsError("identity_unavailable", "无法连接当前身份数据库，已拒绝业务读取。"));
}

export async function withBusinessRead<T>(
  request: HeaderCarrier | undefined, action: AccessAction, ref: ResourceRef, read: (principal: Principal) => Promise<T>,
): Promise<T> {
  legal(action, ref);
  return withScopedRead(request, async (principal, client) => {
    const facts = await resourceFacts(client, ref, loadAccountsConfig()!.schoolId);
    demand(principal, action, facts);
    return read(principal);
  });
}

export function requireServerAccess(action: AccessAction, ref: ResourceRef): Promise<Principal> {
  return withBusinessRead(undefined, action, ref, async (principal) => principal);
}

/** Model awaits stay outside transactions; each downstream save rechecks this original context. */
export async function runBusinessWrite<T>(
  request: HeaderCarrier, action: AccessAction, ref: ResourceRef, work: () => Promise<T>,
): Promise<T> {
  legal(action, ref);
  const config = loadAccountsConfig();
  if (!config) throw new AccountsError("identity_unavailable", "认证服务未配置，业务写入已关闭。");
  if (!evaluateSameOrigin(request, config)) throw new AccountsError("csrf_rejected", "请求缺少可信同源证明。");
  const { auth } = await requestAuth(request);
  if (!csrfMatches(auth.token!, request.headers.get(CSRF_HEADER_NAME))) throw new AccountsError("csrf_rejected", "会话 CSRF 校验失败。");
  const before = await safeTransaction(async (client) => {
    const principal = await freshIdentity(client, auth, config.schoolId);
    const facts = await resourceFacts(client, ref, config.schoolId);
    demand(principal, action, facts);
    await demandSessionValid(client, auth.session!.session_id);
    return facts!;
  });
  return withSaveAuthorization(async (client) => {
    const principal = await freshIdentity(client, auth, config.schoolId);
    const after = await resourceFacts(client, ref, config.schoolId, true);
    demand(principal, action, after); // revocation/out-of-scope keeps its 401/403/503
    if ("current_class_id" in before && after && "current_class_id" in after &&
        (before.current_class_id !== after.current_class_id || before.child_id !== after.child_id)) {
      throw new AccountsError("state_conflict", "幼儿归属在请求期间已变化，请重新核对后再操作。");
    }
    // Automatic expiry is not a row mutation: also check after any child/resource lock wait.
    await demandSessionValid(client, auth.session!.session_id);
  }, work, () => new AccountsError("identity_unavailable", "无法连接保存时的身份数据库，已拒绝写入。"));
}
