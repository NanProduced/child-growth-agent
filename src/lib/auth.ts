import crypto from "crypto";
import { NextResponse } from "next/server";

/**
 * 最小身份验证：教师通行口令 + HMAC 签名会话 Cookie。
 * - 口令来自环境变量 TEACHER_PASSCODE，不落库、不进前端代码。
 * - 所有写操作与实时 AI 调用都在服务端（requireTeacher）校验，不信任前端状态。
 * - 未配置口令时，写接口与 AI 接口一律返回 503（默认禁用）。
 */

export const TEACHER_COOKIE = "cga_teacher";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天

function getConfiguredPasscode(): string | null {
  const passcode = process.env.TEACHER_PASSCODE;
  if (!passcode || passcode.trim().length === 0) return null;
  return passcode.trim();
}

export function isPasscodeConfigured(): boolean {
  return getConfiguredPasscode() !== null;
}

function getSecret(passcode: string): string {
  return crypto
    .createHash("sha256")
    .update(`child-growth-agent::${passcode}`)
    .digest("hex");
}

function sign(exp: number, secret: string): string {
  return crypto.createHmac("sha256", secret).update(String(exp)).digest("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function verifyPasscode(input: string): boolean {
  const passcode = getConfiguredPasscode();
  if (!passcode || !input) return false;
  // 先哈希再做恒时比较，避免长度侧信道
  const a = crypto.createHash("sha256").update(input.trim()).digest("hex");
  const b = crypto.createHash("sha256").update(passcode).digest("hex");
  return timingSafeEqual(a, b);
}

export function createSessionToken(): { token: string; maxAge: number } {
  const passcode = getConfiguredPasscode();
  if (!passcode) throw new Error("TEACHER_PASSCODE is not configured");
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const secret = getSecret(passcode);
  return { token: `${exp}.${sign(exp, secret)}`, maxAge: SESSION_TTL_SECONDS };
}

export function verifySessionToken(token: string | undefined | null): boolean {
  const passcode = getConfiguredPasscode();
  if (!passcode || !token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp <= 0 || exp * 1000 < Date.now()) return false;
  const secret = getSecret(passcode);
  return timingSafeEqual(sig, sign(exp, secret));
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
    }
  }
  return null;
}

export function isTeacherRequest(request: Request): boolean {
  return verifySessionToken(readCookie(request, TEACHER_COOKIE));
}

/**
 * 服务端写操作守卫。返回 null 表示通过；否则直接把该 Response 返回给客户端。
 */
export function requireTeacher(request: Request): NextResponse | null {
  if (!isPasscodeConfigured()) {
    return NextResponse.json(
      {
        error: "teacher_auth_disabled",
        message:
          "教师身份未配置：请在项目环境变量中设置 TEACHER_PASSCODE 并重启服务后，方可进行写入与 AI 调用。",
      },
      { status: 503 }
    );
  }
  if (!isTeacherRequest(request)) {
    return NextResponse.json(
      {
        error: "unauthorized",
        message: "需要教师身份：请先在页面右上角「教师登录」中输入通行口令。",
      },
      { status: 401 }
    );
  }
  return null;
}
