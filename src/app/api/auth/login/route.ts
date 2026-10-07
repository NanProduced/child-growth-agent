import { NextRequest, NextResponse } from "next/server";

import { loadAccountsConfig } from "@/lib/accounts/config";
import {
  authErrorResponse,
  evaluateLoginGuard,
  loginGuardFailureError,
} from "@/lib/accounts/guards";
import { isValidNormalizedUsername, normalizeUsername } from "@/lib/accounts/normalize";
import { clientAddressOf, loginRateLimiter, rateLimitKey } from "@/lib/accounts/rate-limit";
import { loginWithPassword } from "@/lib/accounts/repository";
import {
  computeCsrfToken,
  legacyCookieClearAttributes,
  sessionCookieAttributes,
  SESSION_COOKIE_NAME,
} from "@/lib/accounts/session";
import {
  AUTH_SESSION_TTL_SECONDS,
  CLIENT_CLEANUP_TARGETS,
  CSRF_HEADER_NAME,
  LEGACY_AUTH_COOKIE,
  type LoginGuardFailure,
  type LoginResponse,
} from "@/lib/accounts/types";

/**
 * 登录（登录前保护）：
 * - 可信 Origin（部署配置）+ 精确 application/json + x-cga-auth-request:1；
 * - 不要求会话绑定 CSRF；失败统一 invalid_credentials，不泄露账号是否存在；
 * - 登录建立全新会话与新 CSRF 令牌；服务端同时清除旧 cga_teacher Cookie。
 */

const LOGIN_GUARD_MESSAGES: Record<LoginGuardFailure, string> = {
  origin_untrusted: "请求来源不可信，已拒绝登录。",
  same_origin_proof_missing: "缺少同源证明，已拒绝登录。",
  auth_request_header_missing: "缺少必要的登录请求头，已拒绝登录。",
  content_type_rejected: "登录请求必须使用 application/json。",
};

export async function POST(request: NextRequest) {
  const config = loadAccountsConfig();
  if (!config) {
    return authErrorResponse(
      "identity_unavailable",
      "认证服务未配置：缺少 AUTH_TRUSTED_ORIGINS，已按 fail closed 处理。",
    );
  }

  const guard = evaluateLoginGuard(request, config);
  if (!guard.ok) {
    return authErrorResponse(loginGuardFailureError(guard.failure), LOGIN_GUARD_MESSAGES[guard.failure]);
  }

  const body = (await request.json().catch(() => null)) as {
    username?: unknown;
    password?: unknown;
  } | null;
  const username = normalizeUsername(typeof body?.username === "string" ? body.username : "");
  const password = typeof body?.password === "string" ? body.password : "";
  if (!isValidNormalizedUsername(username) || password.length === 0) {
    return authErrorResponse("invalid_request", "请输入用户名与密码。");
  }

  const rateLimitKeyValue = rateLimitKey(username, clientAddressOf(request));
  if (loginRateLimiter.isBlocked(rateLimitKeyValue, config.rateLimit)) {
    return authErrorResponse("rate_limited", "登录尝试过于频繁，请稍后再试。");
  }

  let outcome;
  try {
    outcome = await loginWithPassword(username, password, config.schoolId);
  } catch {
    return authErrorResponse("identity_unavailable", "身份服务暂时不可用，请稍后重试。");
  }

  if (outcome.kind === "invalid_credentials") {
    loginRateLimiter.recordFailure(rateLimitKeyValue, config.rateLimit);
    return authErrorResponse("invalid_credentials", "用户名或密码不正确。");
  }
  if (outcome.kind === "account_disabled") {
    return authErrorResponse("account_disabled", "该账号已停用，请联系管理员。");
  }

  loginRateLimiter.reset(rateLimitKeyValue);
  const response = NextResponse.json<LoginResponse>({
    state: { kind: "authenticated", principal: outcome.principal },
    session: outcome.session,
    csrf: { header_name: CSRF_HEADER_NAME, token: computeCsrfToken(outcome.token) },
    cleanup: [...CLIENT_CLEANUP_TARGETS],
  });
  response.cookies.set(
    SESSION_COOKIE_NAME,
    outcome.token,
    sessionCookieAttributes(config.cookieSecure, AUTH_SESSION_TTL_SECONDS),
  );
  response.cookies.set(LEGACY_AUTH_COOKIE, "", legacyCookieClearAttributes());
  return response;
}
