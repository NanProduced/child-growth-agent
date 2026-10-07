import crypto from "node:crypto";

import { LEGACY_AUTH_COOKIE, LEGACY_COOKIE_CLEAR_PATH, type SessionView } from "./types";

/**
 * 会话与 CSRF 基础原语（AUTH1）。
 * - 会话令牌：32 字节随机熵，数据库只存 SHA-256 哈希；
 * - CSRF：由会话令牌做 HMAC 派生（`computeCsrfToken`），与当前会话绑定且不落库；
 *   只有服务端能从 HttpOnly Cookie 中的令牌派生出它，响应体只返回派生值，不返回会话令牌。
 * - 读取（status/鉴权）不写数据库，不续期。
 */

export const SESSION_COOKIE_NAME = "cga_session";

const SESSION_TOKEN_BYTES = 32;
const CSRF_DERIVATION_MESSAGE = "cga-auth-v1:csrf";

export interface SessionToken {
  /** 明文令牌：只放入 HttpOnly Cookie，绝不写日志或响应体 */
  token: string;
  /** 数据库存储的 SHA-256 十六进制哈希 */
  tokenHash: string;
}

export function createSessionToken(): SessionToken {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** 会话绑定 CSRF 令牌：HMAC(session_token, "cga-auth-v1:csrf") */
export function computeCsrfToken(sessionToken: string): string {
  return crypto
    .createHmac("sha256", sessionToken)
    .update(CSRF_DERIVATION_MESSAGE)
    .digest("base64url");
}

export function csrfMatches(sessionToken: string, provided: string | null): boolean {
  if (!provided) return false;
  const expected = Buffer.from(computeCsrfToken(sessionToken));
  const actual = Buffer.from(provided);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** 解析 Cookie 请求头；重复同名取第一个 */
export function parseCookieHeader(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator);
    if (cookies.has(name)) continue;
    const raw = trimmed.slice(separator + 1);
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      cookies.set(name, raw);
    }
  }
  return cookies;
}

export interface CookieAttributes {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
}

/** 会话 Cookie 属性：由部署配置决定 Secure，不读取任何代理请求头 */
export function sessionCookieAttributes(secure: boolean, maxAgeSeconds: number): CookieAttributes {
  return { httpOnly: true, sameSite: "lax", path: "/", secure, maxAge: maxAgeSeconds };
}

/** 旧口令 Cookie 由服务端按原有路径清除（不能只依赖客户端 cleanup） */
export function legacyCookieClearAttributes(): CookieAttributes {
  return { httpOnly: true, sameSite: "lax", path: LEGACY_COOKIE_CLEAR_PATH, secure: false, maxAge: 0 };
}

export function legacyCookieName(): string {
  return LEGACY_AUTH_COOKIE;
}

export function toSessionView(row: {
  session_id: string;
  created_at: Date | string;
  expires_at: Date | string;
}): SessionView {
  return {
    session_id: row.session_id,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  };
}
