/**
 * 用户名规范化：与密码处理严格分开。
 * 规则：去两端空白 → Unicode NFKC → 转小写；唯一性按规范化结果判断。
 * 密码永远不做 trim 或 Unicode 规范化。
 */
export function normalizeUsername(input: string): string {
  return input.trim().normalize("NFKC").toLowerCase();
}

/** 基础校验：规范化后非空且不超过数据库列长；不做更严格的字符集限制 */
export function isValidNormalizedUsername(value: string): boolean {
  return value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
}
