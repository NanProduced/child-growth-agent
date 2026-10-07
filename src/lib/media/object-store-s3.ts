import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import { MediaError } from "./errors";
import { assertCozeEndpoint, platformWorkloadHeaders } from '@/lib/coze-runtime';
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
 * - 普通 S3 使用条件写；扣子代理忽略该条件，因此使用内容地址 + GET 字节核验；
 *   扣子模式仅保证逻辑幂等，不承诺底层 PUT 物理 exactly-once；
 * - 不提供 list/前缀操作；不生成长期 URL；本适配器不内置任何公开读权限。
 */

export interface S3MediaStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  requestHandler?: S3ClientConfig['requestHandler'];
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
  private readonly platform: boolean;

  constructor(config: S3MediaStoreConfig) {
    this.config = config;
    const platform = process.env.YAYA_PLATFORM_AUTH === 'workload';
    this.platform = platform;
    if (platform) { assertCozeEndpoint(config.endpoint); platformWorkloadHeaders('storage'); }
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      ...(config.requestHandler ? { requestHandler: config.requestHandler } : {}),
      ...(platform ? { forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: 'coze-s3-proxy', secretAccessKey: 'unused' } } : {}),
    });
    if (platform) {
      // Same authenticated proxy protocol as the SDK's legacy storage branch.
      // Own client retains exact Key/IfNoneMatch/Metadata; no SDK-private access.
      this.client.middlewareStack.remove('awsAuthMiddleware');
      this.client.middlewareStack.add(next => async args => {
        const request = args.request;
        if (request && typeof request === 'object' && 'headers' in request && typeof request.headers === 'object' && request.headers !== null) Object.assign(request.headers, platformWorkloadHeaders('storage'));
        return next(args);
      }, { step: 'build', name: 'injectPlatformWorkload' });
    }
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
    if (this.platform) {
      // The Coze proxy ignores IfNoneMatch. Content-addressed keys prevent
      // different bytes sharing a key; parallel identical PUTs are harmless.
      // This is logical idempotency, not a claim of physical exactly-once I/O.
      if (input.key.split('/').pop() !== digest) return { outcome: 'conflict', checksum_sha256: digest };
      const existing = await this.get(input.key);
      if (existing) return { outcome: 'already_present', checksum_sha256: digest };
      try {
        await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: input.key, Body: input.body, ContentType: input.content_type, ContentLength: input.body.length, Metadata: { sha256: digest } }));
      } catch { throw new MediaError('object_store_unavailable', '对象写入结果未得到确认。'); }
      const readBack = await this.get(input.key);
      if (!readBack || !readBack.body.equals(input.body)) throw new MediaError('checksum_mismatch', '对象回读未核对一致，未标记上传成功。');
      return { outcome: 'created', checksum_sha256: digest };
    }
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
    if (this.platform) inputDigest(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!response.Body) throw new MediaError("object_store_unavailable", "对象读取失败，请稍后重试。");
      const bytes = await (
        response.Body as { transformToByteArray(): Promise<Uint8Array> }
      ).transformToByteArray();
      const body = Buffer.from(bytes);
      if (this.platform && inputDigest(key) !== sha256Hex(body)) throw new MediaError('checksum_mismatch', '对象内容与固定摘要不一致。');
      return { body };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      if (statusOf(error) === 404 || nameOf(error) === "NoSuchKey") return null;
      throw new MediaError("object_store_unavailable", "对象存储暂时不可用，请稍后重试。");
    }
  }

  async delete(key: string): Promise<ObjectDeleteOutcome> {
    assertSafeObjectKey(key);
    if (this.platform) inputDigest(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return "deleted";
    } catch (error) {
      if (statusOf(error) === 404 || nameOf(error) === "NoSuchKey") return "not_found";
      return "unknown";
    }
  }
}

function inputDigest(key: string): string {
  const digest = key.split('/').pop() ?? '';
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new MediaError('invalid_request', '平台对象缺少内容身份。');
  return digest;
}
