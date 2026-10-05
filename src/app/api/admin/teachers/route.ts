import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, guardAdmin, mapAccountsError } from "@/lib/accounts/guards";
import { isValidNormalizedUsername, normalizeUsername } from "@/lib/accounts/normalize";
import { hashPassword } from "@/lib/accounts/password";
import { createTeacherWithAssignments, listTeachers } from "@/lib/accounts/repository";
import type {
  TeacherCreateResponse,
  TeacherListResponse,
} from "@/lib/accounts/types";

/** 管理员教师列表（只读）：不返回密码、哈希、盐或会话令牌 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = await guardAdmin(request, { requireCsrf: false });
  if (!guard.ok) return guard.response;
  try {
    const body: TeacherListResponse = { teachers: await listTeachers() };
    return NextResponse.json(body);
  } catch (error) {
    return mapAccountsError(error);
  }
}

/** 创建教师（可选初始分配）：创建与分配同一事务，全有或全无 */
export async function POST(request: NextRequest) {
  const guard = await guardAdmin(request, { requireCsrf: true });
  if (!guard.ok) return guard.response;
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return authErrorResponse("invalid_request", "教师资料必须为 JSON 对象。");
  }
  const payload = body as Record<string, unknown>;
  const username = normalizeUsername(typeof payload?.username === "string" ? payload.username : "");
  const displayName = typeof payload?.display_name === "string" ? payload.display_name.trim() : "";
  const initialPassword =
    typeof payload?.initial_password === "string" ? payload.initial_password : "";
  if (
    "class_ids" in payload &&
    (!Array.isArray(payload.class_ids) ||
      !payload.class_ids.every((value: unknown) => typeof value === "string" && value.trim().length > 0))
  ) {
    return authErrorResponse("invalid_request", "班级分配必须为非空字符串数组。");
  }
  const classIds = (payload.class_ids ?? []) as string[];
  if (!isValidNormalizedUsername(username) || !displayName || displayName.length > 50) {
    return authErrorResponse("invalid_request", "用户名或显示名不合法。");
  }
  if (initialPassword.length === 0) {
    return authErrorResponse("invalid_request", "必须提供初始密码。");
  }
  try {
    const passwordHash = await hashPassword(initialPassword);
    const teacher = await createTeacherWithAssignments({
      username,
      displayName,
      passwordHash,
      classIds,
      assignedBy: guard.principal.account_id,
    });
    const body: TeacherCreateResponse = { teacher };
    return NextResponse.json(body, { status: 201 });
  } catch (error) {
    return mapAccountsError(error);
  }
}
