import type { NextResponse } from "next/server";

import { loadAccountsConfig, type AccountsConfig } from "./config";
import { AccountsError } from "./errors";
import { PasswordPolicyError } from "./password";
import { loadSessionByToken } from "./repository";
import { computeCsrfToken, csrfMatches, parseCookieHeader, SESSION_COOKIE_NAME } from "./session";
import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_HTTP_STATUS,
  AUTH_LOGIN_CONTENT_TYPE,
  AUTH_LOGIN_HEADER_NAME,
  AUTH_LOGIN_HEADER_VALUE,
  CSRF_HEADER_NAME,
  LEGACY_AUTH_COOKIE,
  type AuthApiError,
  type AuthErrorCode,
  type AuthState,
  type CsrfTokenView,
  type LoginGuardFailure,
  type Principal,
  type SessionView,
} from "./types";

/**
 * AUTH1 请求守门：
 * - 登录前：可信 Origin（部署配置）+ 精确 application/json + 自定义请求头，不要求会话 CSRF；
 * - 登录后写操作：同源 + 有效会话 + 会话绑定 CSRF；
 * - 所有解析都从数据库读取当前账号状态与任教范围；数据库不可用 → identity_unavailable（fail closed）。
 */

export interface HeaderCarrier {
  headers: { get(name: string): string | null };
}

export type LoginGuardResult = { ok: true } | { ok: false; failure: LoginGuardFailure };

export function evaluateLoginGuard(
  request: HeaderCarrier,
  config: AccountsConfig,
): LoginGuardResult {
  const origin = request.headers.get("origin");
  if (origin === null) return { ok: false, failure: "same_origin_proof_missing" };
  if (origin === "null" || !config.trustedOrigins.includes(origin)) {
    return { ok: false, failure: "origin_untrusted" };
  }
  if (request.headers.get(AUTH_LOGIN_HEADER_NAME) !== AUTH_LOGIN_HEADER_VALUE) {
    return { ok: false, failure: "auth_request_header_missing" };
  }
  const contentType = request.headers.get("content-type");
  const essence = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (essence !== AUTH_LOGIN_CONTENT_TYPE) {
    return { ok: false, failure: "content_type_rejected" };
  }
  return { ok: true };
}

/** 登录前保护失败的错误码映射：来源类 → 403 csrf_rejected；请求形状类 → 400 invalid_request */
export function loginGuardFailureError(failure: LoginGuardFailure): AuthErrorCode {
  switch (failure) {
    case "origin_untrusted":
    case "same_origin_proof_missing":
      return "csrf_rejected";
    case "auth_request_header_missing":
    case "content_type_rejected":
      return "invalid_request";
  }
}

export function evaluateSameOrigin(request: HeaderCarrier, config: AccountsConfig): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== "null" && config.trustedOrigins.includes(origin);
}

export interface ResolvedRequestAuth {
  state: AuthState;
  session: SessionView | null;
  csrf: CsrfTokenView | null;
  /** 明文会话令牌仅存在于服务端内存，用于派生 CSRF 与撤销，绝不进入响应体 */
  token: string | null;
}

export async function resolveRequestAuth(
  request: HeaderCarrier,
  config: AccountsConfig,
): Promise<ResolvedRequestAuth> {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const token = cookies.get(SESSION_COOKIE_NAME) ?? null;
  const hasLegacy = cookies.has(LEGACY_AUTH_COOKIE);

  if (!token) {
    if (hasLegacy) {
      return {
        state: { kind: "invalid_session", reason: "legacy_cookie_not_accepted" },
        session: null,
        csrf: null,
        token: null,
      };
    }
    return { state: { kind: "anonymous" }, session: null, csrf: null, token: null };
  }

  try {
    const resolution = await loadSessionByToken(token, config.schoolId);
    if (resolution.kind === "invalid") {
      return {
        state: { kind: "invalid_session", reason: resolution.reason },
        session: null,
        csrf: null,
        token: null,
      };
    }
    return {
      state: { kind: "authenticated", principal: resolution.principal },
      session: resolution.session,
      csrf: { header_name: CSRF_HEADER_NAME, token: computeCsrfToken(token) },
      token,
    };
  } catch {
    // 数据库/身份服务不可用：fail closed，不降级匿名
    return {
      state: { kind: "unavailable", reason: "identity_service_unavailable" },
      session: null,
      csrf: null,
      token: null,
    };
  }
}

export function authErrorResponse(code: AuthErrorCode, message: string): NextResponse<AuthApiError> {
  if (!AUTH_ERROR_CODES.includes(code)) throw new Error(`未知错误码：${code}`);
  return Response.json({ error: code, message }, { status: AUTH_ERROR_HTTP_STATUS[code] }) as NextResponse<AuthApiError>;
}

/** 领域错误 → 冻结错误体；未知错误统一 500，不泄露内部细节 */
export function mapAccountsError(error: unknown): NextResponse<AuthApiError> {
  if (error instanceof AccountsError) return authErrorResponse(error.code, error.message);
  if (error instanceof PasswordPolicyError) return authErrorResponse("invalid_request", error.message);
  return authErrorResponse("server_error", "服务器暂时无法处理该请求，请稍后重试。");
}

export type AdminGuardResult =
  | { ok: true; principal: Principal; token: string; config: AccountsConfig }
  | { ok: false; response: NextResponse<AuthApiError> };

/**
 * 管理员接口守门。requireCsrf=true 用于变更请求：
 * 顺序为同源 → 有效会话 → 管理员角色 → 会话绑定 CSRF。
 */
export async function guardAdmin(
  request: HeaderCarrier,
  options: { requireCsrf: boolean },
): Promise<AdminGuardResult> {
  const config = loadAccountsConfig();
  if (!config) {
    return {
      ok: false,
      response: authErrorResponse("identity_unavailable", "认证服务未配置：缺少 AUTH_TRUSTED_ORIGINS，已按 fail closed 处理。"),
    };
  }
  if (options.requireCsrf && !evaluateSameOrigin(request, config)) {
    return {
      ok: false,
      response: authErrorResponse("csrf_rejected", "请求来源不可信或缺少同源证明。"),
    };
  }
  const resolved = await resolveRequestAuth(request, config);
  if (resolved.state.kind === "unavailable") {
    return {
      ok: false,
      response: authErrorResponse("identity_unavailable", "身份服务暂时不可用，请稍后重试。"),
    };
  }
  if (resolved.state.kind !== "authenticated" || !resolved.token) {
    return {
      ok: false,
      response: authErrorResponse("unauthenticated", "需要先登录园所账号。"),
    };
  }
  if (resolved.state.principal.role !== "admin") {
    return {
      ok: false,
      response: authErrorResponse("forbidden_role", "该接口仅限管理员使用。"),
    };
  }
  if (
    options.requireCsrf &&
    !csrfMatches(resolved.token, request.headers.get(CSRF_HEADER_NAME))
  ) {
    return {
      ok: false,
      response: authErrorResponse("csrf_rejected", "CSRF 校验失败，请刷新页面后重试。"),
    };
  }
  return { ok: true, principal: resolved.state.principal, token: resolved.token, config };
}
