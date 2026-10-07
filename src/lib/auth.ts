import type { NextResponse } from "next/server";
import { AccountsError } from "./accounts/errors";
import { loadAccountsConfig } from "./accounts/config";
import { authErrorResponse, resolveRequestAuth } from "./accounts/guards";
import { LEGACY_AUTH_COOKIE } from "./accounts/types";

export { resolveServerAuth, requireServerAccess, runBusinessWrite, withBusinessRead } from "./accounts/access";
export { mapAccountsError } from "./accounts/guards";
export { AccountsError };

/** Old checks still compile. Legacy passcode sessions never grant access. */
export const TEACHER_COOKIE = LEGACY_AUTH_COOKIE;
export function isPasscodeConfigured(): boolean { return false; }
export function verifyPasscode(_input: string): boolean { return false; }
export function verifySessionToken(_token: string | undefined | null): boolean { return false; }
export function createSessionToken(): { token: string; maxAge: number } {
  throw new AccountsError("unauthenticated", "旧口令会话已退役，请使用园所账号登录。");
}
export async function isTeacherRequest(request: Request): Promise<boolean> {
  const config = loadAccountsConfig();
  if (!config) return false;
  const auth = await resolveRequestAuth(request, config);
  return auth.state.kind === "authenticated" && auth.state.principal.role === "teacher" && auth.state.principal.account_status === "active";
}

/** Retired synchronous entrypoint fails closed. New routes must use runBusinessWrite. */
export function requireTeacher(_request: Request): NextResponse {
  const config = loadAccountsConfig();
  if (!config) return authErrorResponse("identity_unavailable", "认证服务未配置。");
  return authErrorResponse("unauthenticated", "旧教师口令入口已退役，请使用园所账号登录。");
}
