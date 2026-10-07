import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, guardAdmin, mapAccountsError } from "@/lib/accounts/guards";
import { assignTeacherClass } from "@/lib/accounts/repository";
import type { ClassAssignmentRequest, ClassAssignmentResponse } from "@/lib/accounts/types";

/**
 * 分配任教（仅管理员）。路径 ID 与请求体 account_id 必须一致；
 * 同一班级可有多名教师，同一教师可任教多个班级；重复分配幂等。
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await guardAdmin(request, { requireCsrf: true });
  if (!guard.ok) return guard.response;
  const { id } = await context.params;
  const payload = (await request.json().catch(() => null)) as ClassAssignmentRequest | null;
  if (payload?.account_id !== id) {
    return authErrorResponse("invalid_request", "路径 ID 与请求体 account_id 不一致。");
  }
  if (typeof payload.class_id !== "string" || payload.class_id.length === 0) {
    return authErrorResponse("invalid_request", "必须提供 class_id。");
  }
  try {
    const teacher = await assignTeacherClass(id, payload.class_id, guard.principal.account_id);
    const body: ClassAssignmentResponse = { teacher };
    return NextResponse.json(body);
  } catch (error) {
    return mapAccountsError(error);
  }
}
