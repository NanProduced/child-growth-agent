import { createHash, randomUUID } from "node:crypto";

/**
 * MEDIA1 私有对象存储端口。
 *
 * 冻结语义：
 * - **只按精确 key 操作**：没有 list/prefix 批量接口。补偿与回收只能操作本轮确实
 *   创建/记录过的对象，禁止按前缀整段清空（prefix 不是所有权，也不是权限）。
 * - **对象只写一次**：putOnce 以 key 为唯一身份；同 key 已存在时只比较 checksum，
 *   相同视为幂等命中，不同判冲突；写入后必须回读核对 checksum。
 * - 存储内容不含任何公开/长期签名 URL；对象 key 只是引用标识。
 * - delete 结果未知不得伪造成成功：返回 "unknown"，由上层保留可核验状态。
 */

export type ObjectPutOutcome = "created" | "already_present" | "conflict";

export interface ObjectPutResult {
  outcome: ObjectPutOutcome;
  checksum_sha256: string;
}

export interface StoredObjectBody {
  body: Buffer;
}

export type ObjectDeleteOutcome = "deleted" | "not_found" | "unknown";

export interface MediaObjectStore {
  putOnce(input: {
    key: string;
    content_type: string;
    body: Buffer;
  }): Promise<ObjectPutResult>;
  get(key: string): Promise<StoredObjectBody | null>;
  delete(key: string): Promise<ObjectDeleteOutcome>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function newLeaseToken(): string {
  return randomUUID();
}

const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

/** key 只能是相对对象键：不接受绝对路径、反斜杠、`..`、控制字符或空段 */
export function assertSafeObjectKey(key: string): void {
  if (key.length === 0 || key.length > 512) throw new Error(`非法对象键：${key.slice(0, 32)}`);
  if (!SAFE_KEY_PATTERN.test(key) || key.includes("//") || key.includes("..") || key.includes("\\")) {
    throw new Error(`非法对象键：${key.slice(0, 64)}`);
  }
}
