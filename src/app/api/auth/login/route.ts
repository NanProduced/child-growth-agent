import { NextRequest, NextResponse } from "next/server";
import {
  TEACHER_COOKIE,
  createSessionToken,
  isPasscodeConfigured,
  verifyPasscode,
} from "@/lib/auth";

export async function POST(request: NextRequest) {
  if (!isPasscodeConfigured()) {
    return NextResponse.json(
      {
        error: "teacher_auth_disabled",
        message: "教师身份未配置：请在项目环境变量中设置 TEACHER_PASSCODE 后重启服务。",
      },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => null)) as { passcode?: unknown } | null;
  const passcode = typeof body?.passcode === "string" ? body.passcode : "";
  if (!passcode || !verifyPasscode(passcode)) {
    return NextResponse.json(
      { error: "invalid_passcode", message: "通行口令不正确，请重新输入。" },
      { status: 401 }
    );
  }

  const { token, maxAge } = createSessionToken();
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  const response = NextResponse.json({ ok: true, isTeacher: true });
  response.cookies.set(TEACHER_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
    secure: proto === "https",
  });
  return response;
}
