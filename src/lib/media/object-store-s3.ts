import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

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
 * S3 私有对象适配器（真实实现；本任务不调用真实桶，NOT_RUN 由装配验收完成）。
 *
 * - 运行配置只来自部署环境变量（endpoint/bucket/region），凭据由运行环境注入；
 * - putOnce 用 `IfNoneMatch: "*"` 保证写一次；命中已有对象时比较 sha256 元数据；
 *   写入后 HeadObject 回读核对 checksum，不一致则删除本次对象并报错；
 * - 不提供 list/前缀操作；不生成长期 URL；本适配器不内置任何公开读权限。
 */

export interface S3MediaStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
}

interface S3ErrorLike {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

function statusOf(error: unknown): number | undefined {
  return (error as S3ErrorLike).$metadata?.httpStatusCode;
}

function nameOf(error: unknown): string | undefined {
  return (error as S3ErrorLike).name;
}

export class S3MediaObjectStore implements MediaObjectStore {
  private readonly client: S3Client;
  private readonly config: S3MediaStoreConfig;

  constructor(config: S3MediaStoreConfig) {
    this.config = config;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
    });
  }

  private async head(key: string): Promise<{ byte_size: number; checksum: string | null } | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        byte_size: head.ContentLength ?? -1,
        checksum: head.Metadata?.sha256 ?? null,
      };
    } catch (error) {
      if (statusOf(error) === 404 || nameOf(error) === "NotFound") return null;
      throw new MediaError("object_store_unavailable", "对象存储暂时不可用，请稍后重试。");
    }
  }

  async putOnce(input: { key: string; content_type: string; body: Buffer }): Promise<ObjectPutResult> {
    assertSafeObjectKey(input.key);
    const digest = sha256Hex(input.body);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.content_type,
          ContentLength: input.body.length,
          IfNoneMatch: "*",
          Metadata: { sha256: digest },
        }),
      );
    } catch (error) {
      if (statusOf(error) === 412 || nameOf(error) === "PreconditionFailed") {
        const existing = await this.head(input.key);
        if (existing?.checksum === digest) return { outcome: "already_present", checksum_sha256: digest };
        return { outcome: "conflict", checksum_sha256: digest };
      }
      throw new MediaError("object_store_unavailable", "对象存储暂时不可用，请稍后重试。");
    }
    const readBack = await this.head(input.key);
    if (!readBack || readBack.checksum !== digest || readBack.byte_size !== input.body.length) {
      // 不一致的写不能当成功；尽力清掉本次对象后报错（只操作本次 key）。
      await this.delete(input.key).catch(() => undefined);
      throw new MediaError("checksum_mismatch", "对象写入校验失败，已清理本次写入。");
    }
    return { outcome: "created", checksum_sha256: digest };
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    assertSafeObjectKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!response.Body) throw new MediaError("object_store_unavailable", "对象读取失败，请稍后重试。");
      const bytes = await (
        response.Body as { transformToByteArray(): Promise<Uint8Array> }
      ).transformToByteArray();
      return { body: Buffer.from(bytes) };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      if (statusOf(error) === 404 || nameOf(error) === "NoSuchKey") return null;
      throw new MediaError("object_store_unavailable", "对象存储暂时不可用，请稍后重试。");
    }
  }

  async delete(key: string): Promise<ObjectDeleteOutcome> {
    assertSafeObjectKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return "deleted";
    } catch (error) {
      if (statusOf(error) === 404 || nameOf(error) === "NoSuchKey") return "not_found";
      return "unknown";
    }
  }
}
