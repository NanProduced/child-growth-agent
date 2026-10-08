/**
 * 账号私有读写的服务端守门（DATA1）。
 *
 * 与既有 AUTH 的口径一致但不虚构新 action：
 * - 写：同源 → 有效会话 → 会话绑定 CSRF，然后短事务内重读账号/会话当前事实；
 * - 读：只要求有效会话，不检查 CSRF、不续期、不写库；
 * - 未分配账号允许一般问答（私有聊天），业务资源授权仍在逐来源投影时进行；
 * - 身份服务不可用一律 fail closed（503），不降级匿名。
 */
import { withTransaction, type TransactionClient } from "@/storage/database/pg-client";
import { demandSessionValid } from "../../accounts/access";
import { loadAccountsConfig } from "../../accounts/config";
import { AccountsError } from "../../accounts/errors";
import {
  evaluateSameOrigin,
  resolveRequestAuth,
  type HeaderCarrier,
} from "../../accounts/guards";
import { buildPrincipal } from "../../accounts/repository";
import { csrfMatches, hashSessionToken } from "../../accounts/session";
import { CSRF_HEADER_NAME, type Principal } from "../../accounts/types";

export interface YayaPrivateContext {
  client: TransactionClient;
  principal: Principal;
  sessionId: string;
  schoolId: string;
}

type PrivateMode = { write: boolean };

async function freshPrivateIdentity(
  client: TransactionClient,
  token: string,
  initialAccountId: string,
  sessionId: string,
  schoolId: string,
): Promise<Principal> {
  // 与 AUTH freshIdentity 相同的加锁顺序：先账号、再会话，避免并发死锁。
  const account = await client.query<{
    id: string;
    username: string;
    display_name: string;
    role: string;
    status: string;
  }>("SELECT id, username, display_name, role, status FROM app_accounts WHERE id = $1 FOR SHARE", [
    initialAccountId,
  ]);
  const row = account.rows[0];
  if (!row) throw new AccountsError("unauthenticated", "登录状态已失效，请重新登录。");
  const session = await client.query<{ id: string; account_id: string }>(
    `SELECT id, account_id
       FROM app_sessions WHERE token_hash = $1 FOR SHARE`,
    [hashSessionToken(token)],
  );
  const current = session.rows[0];
  if (!current || current.account_id !== row.id) {
    throw new AccountsError("unauthenticated", "登录状态已失效，请重新登录。");
  }
  if (current.id !== sessionId) {
    throw new AccountsError("state_conflict", "原请求不能由新会话接续。");
  }
  // 在取得会话行锁之后再判定期限（锁等待可能跨过到期时刻）。
  await demandSessionValid(client, current.id);
  if (row.status !== "active") throw new AccountsError("account_disabled", "账号已停用。");
  const assignments = await client.query<{ class_id: string }>(
    "SELECT class_id FROM teacher_class_assignments WHERE account_id = $1 AND removed_at IS NULL ORDER BY class_id",
    [row.id],
  );
  return buildPrincipal({ ...row, class_ids: assignments.rows.map((entry) => entry.class_id) }, schoolId);
}

/**
 * 私有读写统一入口。`write` 时额外要求同源与会话 CSRF；随后在同一个短事务里
 * 重读账号状态/会话有效性/任教关系，Principal 只来自数据库当前值。
 */
export async function withPrivateAuth<T>(
  request: HeaderCarrier,
  mode: PrivateMode,
  work: (context: YayaPrivateContext) => Promise<T>,
): Promise<T> {
  const config = loadAccountsConfig();
  if (!config) {
    throw new AccountsError("identity_unavailable", "认证服务未配置，私有存储访问已关闭。");
  }
  if (mode.write && !evaluateSameOrigin(request, config)) {
    throw new AccountsError("csrf_rejected", "请求来源不可信或缺少同源证明。");
  }
  const auth = await resolveRequestAuth(request, config);
  if (auth.state.kind === "unavailable") {
    throw new AccountsError("identity_unavailable", "身份服务暂时不可用，请稍后重试。");
  }
  if (auth.state.kind !== "authenticated" || !auth.token || !auth.session) {
    throw new AccountsError("unauthenticated", "请先登录园所账号。");
  }
  if (mode.write && !csrfMatches(auth.token, request.headers.get(CSRF_HEADER_NAME))) {
    throw new AccountsError("csrf_rejected", "会话 CSRF 校验失败，请刷新页面后重试。");
  }
  const sessionId = auth.session.session_id;
  const initialAccountId = auth.state.principal.account_id;
  const token = auth.token;
  return withTransaction(
    async (client) => {
      const principal = await freshPrivateIdentity(
        client,
        token,
        initialAccountId,
        sessionId,
        config.schoolId,
      );
      const result = await work({
        client,
        principal,
        sessionId,
        schoolId: config.schoolId,
      });
      // Downstream resource locks may wait past the absolute session deadline.
      // Reject before COMMIT so private/business writes and receipts roll back together.
      await demandSessionValid(client, sessionId);
      return result;
    },
    undefined,
    () => new AccountsError("identity_unavailable", "无法连接当前身份数据库，已拒绝访问。"),
  );
}

export function withPrivateRead<T>(
  request: HeaderCarrier,
  work: (context: YayaPrivateContext) => Promise<T>,
): Promise<T> {
  return withPrivateAuth(request, { write: false }, work);
}

export function withPrivateWrite<T>(
  request: HeaderCarrier,
  work: (context: YayaPrivateContext) => Promise<T>,
): Promise<T> {
  return withPrivateAuth(request, { write: true }, work);
}
