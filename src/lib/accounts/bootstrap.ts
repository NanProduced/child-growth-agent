import { DEFAULT_SCHOOL_ID } from "./config";
import { isValidNormalizedUsername, normalizeUsername } from "./normalize";
import { assertPasswordPolicy, hashPassword } from "./password";
import { adminExists, createInitialAdmin } from "./repository";
import type { AdminBootstrapInput, AdminBootstrapResult, AdminBootstrapStatus } from "./types";

/**
 * 首位管理员初始化：只被部署者非公网脚本 `scripts/auth-bootstrap-admin.ts` 调用。
 * 不存在公开 HTTP 入口；并发唯一成功、已有管理员拒绝由 repository.createInitialAdmin
 * 的 advisory lock + 检查保证；密码只在内存中用于哈希，不写日志、不返回。
 */

export function bootstrapSchoolId(): string {
  return process.env.AUTH_SCHOOL_ID?.trim() || DEFAULT_SCHOOL_ID;
}

export async function bootstrapInitialAdmin(
  input: AdminBootstrapInput,
): Promise<AdminBootstrapResult> {
  const username = normalizeUsername(input.username);
  if (!isValidNormalizedUsername(username)) {
    throw new Error("用户名不合法：规范化后需为 1-64 个字符且不含控制字符");
  }
  const displayName = input.display_name.trim();
  if (!displayName || displayName.length > 50) {
    throw new Error("显示名不合法：需为 1-50 个字符");
  }
  assertPasswordPolicy(input.password);
  const passwordHash = await hashPassword(input.password);
  const principal = await createInitialAdmin(
    { username, displayName, passwordHash },
    bootstrapSchoolId(),
  );
  return { principal };
}

export async function bootstrapStatus(): Promise<AdminBootstrapStatus> {
  return { admin_initialized: await adminExists() };
}
