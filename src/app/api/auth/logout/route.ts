import { NextRequest, NextResponse } from "next/server";

import { loadAccountsConfig } from "@/lib/accounts/config";
import { authErrorResponse, evaluateSameOrigin, resolveRequestAuth } from "@/lib/accounts/guards";
import { revokeSessionToken } from "@/lib/accounts/repository";
import {
  csrfMatches,
  legacyCookieClearAttributes,
  sessionCookieAttributes,
  SESSION_COOKIE_NAME,
} from "@/lib/accounts/session";
import {
  CLIENT_CLEANUP_TARGETS,
  CSRF_HEADER_NAME,
  LEGACY_AUTH_COOKIE,
  type LogoutResponse,
} from "@/lib/accounts/types";

/**
 * 退出：
 * - 有效会话：要求同源 + 会话绑定 CSRF，撤销当前会话并清除新旧 Cookie；
 * - 失效/缺失会话：幂等成功，仅做 Cookie 清理；
 * - 身份服务不可用时返回 503，不假装已成功撤销。
 */
export async function POST(request: NextRequest) {
  const config = loadAccountsConfig();
  if (!config) {
    return authErrorResponse(
      "identity_unavailable",
      "认证服务未配置：缺少 AUTH_TRUSTED_ORIGINS，已按 fail closed 处理。",
    );
  }
  if (!evaluateSameOrigin(request, config)) {
    return authErrorResponse("csrf_rejected", "请求来源不可信或缺少同源证明。");
  }

  const resolved = await resolveRequestAuth(request, config);
  if (resolved.state.kind === "unavailable") {
    return authErrorResponse("identity_unavailable", "身份服务暂时不可用，未执行退出，请稍后重试。");
  }

  if (resolved.state.kind === "authenticated" && resolved.token) {
    if (!csrfMatches(resolved.token, request.headers.get(CSRF_HEADER_NAME))) {
      return authErrorResponse("csrf_rejected", "CSRF 校验失败，未执行退出。");
    }
    try {
      await revokeSessionToken(resolved.token, "logout");
    } catch {
      return authErrorResponse("identity_unavailable", "身份服务暂时不可用，未执行退出，请稍后重试。");
    }
  }

  const response = NextResponse.json<LogoutResponse>({
    state: { kind: "anonymous" },
    session: null,
    csrf: null,
    cleanup: [...CLIENT_CLEANUP_TARGETS],
  });
  response.cookies.set(SESSION_COOKIE_NAME, "", sessionCookieAttributes(config.cookieSecure, 0));
  response.cookies.set(LEGACY_AUTH_COOKIE, "", legacyCookieClearAttributes());
  return response;
}
