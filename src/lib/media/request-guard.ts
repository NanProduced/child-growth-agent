import { loadAccountsConfig } from "../accounts/config";
import { AccountsError } from "../accounts/errors";
import { evaluateSameOrigin, resolveRequestAuth } from "../accounts/guards";
import { csrfMatches } from "../accounts/session";
import { CSRF_HEADER_NAME, type Principal } from "../accounts/types";

/**
 * MEDIA1 请求守门（账号私有，不虚构 AUTH action）。
 *
 * - 写：同源 → 有效会话 → 活跃账号 → 会话绑定 CSRF（与 AUTH 登录后写保护同序）；
 * - 读：有效会话 + 活跃账号；不需要业务任教范围（账号私有素材可独立于班级存在）；
 * - 身份服务不可用一律 fail closed（503），不降级匿名。
 */

export interface MediaHeaderCarrier {
  headers: { get(name: string): string | null };
}

async function resolveActivePrincipal(
  request: MediaHeaderCarrier,
): Promise<{ principal: Principal; token: string }> {
  const config = loadAccountsConfig();
  if (!config) {
    throw new AccountsError("identity_unavailable", "认证服务未配置，媒体访问已关闭。");
  }
  const auth = await resolveRequestAuth(request, config);
  if (auth.state.kind === "unavailable") {
    throw new AccountsError("identity_unavailable", "身份服务暂时不可用，请稍后重试。");
  }
  if (auth.state.kind !== "authenticated" || !auth.token) {
    throw new AccountsError("unauthenticated", "请先登录园所账号。");
  }
  if (auth.state.principal.account_status !== "active") {
    throw new AccountsError("account_disabled", "账号已停用。");
  }
  return { principal: auth.state.principal, token: auth.token };
}

export async function requireMediaWritePrincipal(request: MediaHeaderCarrier): Promise<Principal> {
  const config = loadAccountsConfig();
  if (!config) {
    throw new AccountsError("identity_unavailable", "认证服务未配置，媒体写入已关闭。");
  }
  if (!evaluateSameOrigin(request, config)) {
    throw new AccountsError("csrf_rejected", "请求缺少可信同源证明。");
  }
  const { principal, token } = await resolveActivePrincipal(request);
  if (!csrfMatches(token, request.headers.get(CSRF_HEADER_NAME))) {
    throw new AccountsError("csrf_rejected", "CSRF 校验失败，请刷新页面后重试。");
  }
  return principal;
}

export async function requireMediaReadPrincipal(request: MediaHeaderCarrier): Promise<Principal> {
  return (await resolveActivePrincipal(request)).principal;
}
