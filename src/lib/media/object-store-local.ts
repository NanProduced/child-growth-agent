import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { MediaError } from "./errors";
import {
  assertSafeObjectKey,
  sha256Hex,
  type MediaObjectStore,
  type ObjectDeleteOutcome,
  type ObjectPutResult,
  type StoredObjectBody,
} from "./object-store";

/**
 * 本地文件系统对象存储（开发/测试替身；真实桶操作需另获授权）。
 *
 * 所有访问都必须落在构造时指定的 root 内；越界 key 直接拒绝。
 * 这是真实文件 I/O（不是内存假象），check-media 用它验证写一次、checksum 回读、
 * 半上传补偿与精确删除；生产由 S3 适配器替换。
 */
export class LocalMediaObjectStore implements MediaObjectStore {
  private readonly root: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error("本地对象存储 root 不能为空");
    this.root = path.resolve(root);
  }

  private pathFor(key: string): string {
    assertSafeObjectKey(key);
    const resolved = path.resolve(this.root, ...key.split("/"));
    const prefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new Error(`对象键越界：${key}`);
    return resolved;
  }

  async putOnce(input: { key: string; content_type: string; body: Buffer }): Promise<ObjectPutResult> {
    const filePath = this.pathFor(input.key);
    const digest = sha256Hex(input.body);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await writeFile(filePath, input.body, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await readFile(filePath);
        return {
          outcome: sha256Hex(existing) === digest ? "already_present" : "conflict",
          checksum_sha256: digest,
        };
      }
      throw new MediaError("object_store_unavailable", "对象存储暂时不可用，请稍后重试。");
    }
    // 回读核对：写入的对象必须与本次 checksum 一致，否则不把损坏对象当成功。
    const readBack = await readFile(filePath).catch(() => null);
    if (!readBack || sha256Hex(readBack) !== digest) {
      await unlink(filePath).catch(() => undefined);
      throw new MediaError("checksum_mismatch", "对象写入校验失败，已清理本次写入。");
    }
    return { outcome: "created", checksum_sha256: digest };
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    const filePath = this.pathFor(key);
    try {
      return { body: await readFile(filePath) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new MediaError("object_store_unavailable", "对象存储暂时不可用，请稍后重试。");
    }
  }

  async delete(key: string): Promise<ObjectDeleteOutcome> {
    const filePath = this.pathFor(key);
    try {
      await unlink(filePath);
      return "deleted";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not_found";
      // 外部删除结果未知：保留可核验状态，不伪装成功。
      return "unknown";
    }
  }
}
