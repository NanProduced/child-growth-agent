/**
 * AUTH1 运行配置：全部来自部署环境变量，不读取请求头推导可信源。
 *
 * - AUTH_TRUSTED_ORIGINS：可信公开源（逗号分隔，含协议与端口）。未配置时登录与
 *   登录后写保护一律 fail closed（503 identity_unavailable），不信任 Host / X-Forwarded-*。
 * - AUTH_SCHOOL_ID：单园所标识（可选，默认 single-school）。
 * - AUTH_COOKIE_SECURE：会话 Cookie 是否强制 Secure；留空时按可信源是否全为 https 自动判断。
 * - AUTH_LOGIN_RATE_LIMIT_MAX / AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS：进程内固定窗口限流。
 */

export interface AccountsConfig {
  trustedOrigins: string[];
  schoolId: string;
  cookieSecure: boolean;
  rateLimit: {
    maxFailures: number;
    windowMs: number;
  };
}

export const DEFAULT_SCHOOL_ID = "single-school";
export const DEFAULT_RATE_LIMIT_MAX = 10;
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 300;

function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.origin === "null") continue;
      if (url.origin !== value.replace(/\/$/, "")) continue;
      origins.push(url.origin);
    } catch {
      // 非法来源直接忽略，不以任何形式放行
    }
  }
  return [...new Set(origins)];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseCookieSecure(raw: string | undefined, trustedOrigins: string[]): boolean {
  if (raw !== undefined && raw.trim() !== "") {
    return raw.trim().toLowerCase() === "true";
  }
  return trustedOrigins.length > 0 && trustedOrigins.every((origin) => origin.startsWith("https://"));
}

/**
 * 读取配置。未配置可信源时返回 null，调用方必须 fail closed（503），
 * 不得回退到匿名、默认全园或请求头推导的来源。
 */
export function loadAccountsConfig(env: NodeJS.ProcessEnv = process.env): AccountsConfig | null {
  const trustedOrigins = parseOriginList(env.AUTH_TRUSTED_ORIGINS);
  if (trustedOrigins.length === 0) return null;
  const schoolId = env.AUTH_SCHOOL_ID?.trim() || DEFAULT_SCHOOL_ID;
  return {
    trustedOrigins,
    schoolId,
    cookieSecure: parseCookieSecure(env.AUTH_COOKIE_SECURE, trustedOrigins),
    rateLimit: {
      maxFailures: parsePositiveInt(env.AUTH_LOGIN_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
      windowMs:
        parsePositiveInt(env.AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_RATE_LIMIT_WINDOW_SECONDS) *
        1000,
    },
  };
}
