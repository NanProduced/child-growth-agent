import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, guardAdmin, mapAccountsError } from "@/lib/accounts/guards";
import { setTeacherStatus } from "@/lib/accounts/repository";
import type { TeacherStatusRequest, TeacherStatusResponse } from "@/lib/accounts/types";

/**
 * 启停教师（仅管理员）。路径 ID 与请求体 account_id 必须一致；
 * 传入管理员 ID 会被拒绝（不能通过教师接口修改管理员）；
 * 停用会原子撤销该账号全部会话。
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await guardAdmin(request, { requireCsrf: true });
  if (!guard.ok) return guard.response;
  const { id } = await context.params;
  const payload = (await request.json().catch(() => null)) as TeacherStatusRequest | null;
  if (payload?.account_id !== id) {
    return authErrorResponse("invalid_request", "路径 ID 与请求体 account_id 不一致。");
  }
  const status = payload.status;
  if (status !== "active" && status !== "disabled") {
    return authErrorResponse("invalid_request", "status 只能是 active 或 disabled。");
  }
  try {
    const result = await setTeacherStatus(id, status);
    const body: TeacherStatusResponse = {
      teacher: result.teacher,
      revoked_session_count: result.revokedSessionCount,
    };
    return NextResponse.json(body);
  } catch (error) {
    return mapAccountsError(error);
  }
}
