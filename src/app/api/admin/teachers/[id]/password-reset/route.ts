import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, guardAdmin, mapAccountsError } from "@/lib/accounts/guards";
import { hashPassword } from "@/lib/accounts/password";
import { resetTeacherPassword } from "@/lib/accounts/repository";
import type { PasswordResetRequest, PasswordResetResponse } from "@/lib/accounts/types";

/**
 * 重置教师密码（仅管理员）。路径 ID 与请求体 account_id 必须一致；
 * 重置后原子撤销该账号全部会话；响应不返回任何密码或哈希信息。
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await guardAdmin(request, { requireCsrf: true });
  if (!guard.ok) return guard.response;
  const { id } = await context.params;
  const payload = (await request.json().catch(() => null)) as PasswordResetRequest | null;
  if (payload?.account_id !== id) {
    return authErrorResponse("invalid_request", "路径 ID 与请求体 account_id 不一致。");
  }
  const newPassword = typeof payload.new_password === "string" ? payload.new_password : "";
  if (newPassword.length === 0) {
    return authErrorResponse("invalid_request", "必须提供新密码。");
  }
  try {
    const passwordHash = await hashPassword(newPassword);
    const result = await resetTeacherPassword(id, passwordHash);
    const body: PasswordResetResponse = {
      teacher: result.teacher,
      revoked_session_count: result.revokedSessionCount,
    };
    return NextResponse.json(body);
  } catch (error) {
    return mapAccountsError(error);
  }
}
