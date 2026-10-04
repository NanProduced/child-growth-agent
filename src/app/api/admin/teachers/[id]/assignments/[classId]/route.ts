import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, guardAdmin, mapAccountsError } from "@/lib/accounts/guards";
import { unassignTeacherClass } from "@/lib/accounts/repository";
import type { ClassAssignmentResponse, ClassUnassignmentRequest } from "@/lib/accounts/types";

/**
 * 撤销任教（仅管理员）。路径 ID 与请求体 account_id/class_id 必须一致；
 * 只写 removed_at 保留历史，不改变幼儿归属或观察快照；重复撤销幂等。
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; classId: string }> },
) {
  const guard = await guardAdmin(request, { requireCsrf: true });
  if (!guard.ok) return guard.response;
  const { id, classId } = await context.params;
  const payload = (await request.json().catch(() => null)) as ClassUnassignmentRequest | null;
  if (payload?.account_id !== id) {
    return authErrorResponse("invalid_request", "路径 ID 与请求体 account_id 不一致。");
  }
  if (payload?.class_id !== undefined && payload.class_id !== classId) {
    return authErrorResponse("invalid_request", "路径 classId 与请求体 class_id 不一致。");
  }
  try {
    const teacher = await unassignTeacherClass(id, classId, guard.principal.account_id);
    const body: ClassAssignmentResponse = { teacher };
    return NextResponse.json(body);
  } catch (error) {
    return mapAccountsError(error);
  }
}
