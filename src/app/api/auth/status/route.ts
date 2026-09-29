import { NextRequest, NextResponse } from "next/server";
import { isPasscodeConfigured, isTeacherRequest } from "@/lib/auth";

/** 教师模式状态：configured=服务端是否配置了口令；isTeacher=当前请求是否持有有效教师会话 */
export function GET(request: NextRequest) {
  const configured = isPasscodeConfigured();
  return NextResponse.json({
    configured,
    isTeacher: configured && isTeacherRequest(request),
  });
}
