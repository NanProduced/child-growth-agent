import { NextRequest, NextResponse } from "next/server";

import { loadAccountsConfig } from "@/lib/accounts/config";
import { resolveRequestAuth } from "@/lib/accounts/guards";
import { legacyCookieClearAttributes, parseCookieHeader } from "@/lib/accounts/session";
import { LEGACY_AUTH_COOKIE, type AuthStatusResponse } from "@/lib/accounts/types";

/**
 * 会话状态：只读解析数据库当前账号状态/角色/任教范围。
 * - GET 不续期、不写数据库；获取 CSRF（响应中的派生令牌）也不更新会期；
 * - 身份服务不可用 → 503 + state: unavailable，不降级匿名；
 * - 旧 cga_teacher 由服务端按原路径清除，不作为授权。
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const hasLegacy = cookies.has(LEGACY_AUTH_COOKIE);
  const config = loadAccountsConfig();
  if (!config) {
    const body: AuthStatusResponse = {
      state: { kind: "unavailable", reason: "identity_service_unavailable" },
      session: null,
      csrf: null,
    };
    const response = NextResponse.json(body, { status: 503 });
    if (hasLegacy) response.cookies.set(LEGACY_AUTH_COOKIE, "", legacyCookieClearAttributes());
    return response;
  }

  const resolved = await resolveRequestAuth(request, config);
  const body: AuthStatusResponse = {
    state: resolved.state,
    session: resolved.session,
    csrf: resolved.csrf,
  };
  const response = NextResponse.json(
    body,
    resolved.state.kind === "unavailable" ? { status: 503 } : undefined,
  );
  if (hasLegacy) response.cookies.set(LEGACY_AUTH_COOKIE, "", legacyCookieClearAttributes());
  return response;
}
