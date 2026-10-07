import { MediaError } from "./errors";
import type { MediaVariant } from "./limits";
import { LocalMediaObjectStore } from "./object-store-local";
import { S3MediaObjectStore } from "./object-store-s3";
import type { MediaObjectStore } from "./object-store";

/**
 * MEDIA1 存储身份与对象键（所有值来自部署环境变量；不写入仓库）。
 *
 * 冻结口径：
 * - 开发环境与生产环境的对象存储是**物理隔离**的不同桶（平台按环境各注入一个），
 *   对象前缀（media/<env>/…）只作命名管理，**不是权限边界**；
 * - 本模块在能同时看到两套身份时拒绝同桶/同身份配置；
 * - 读取/删除/补偿只按记录中的精确 object key 操作，不接受前缀授权。
 */

export const MEDIA_ENVIRONMENTS = ["development", "production"] as const;
export type MediaEnvironment = (typeof MEDIA_ENVIRONMENTS)[number];

export const MEDIA_STORAGE_MODES = ["local", "s3"] as const;
export type MediaStorageMode = (typeof MEDIA_STORAGE_MODES)[number];

export interface MediaStorageConfig {
  mode: MediaStorageMode;
  environment: MediaEnvironment;
  bucket: string;
  endpoint: string;
  region: string;
  /** 仅 mode=local 使用：自有本地目标目录（开发/测试替身） */
  local_root: string | null;
}

export interface MediaBucketIdentity {
  environment: MediaEnvironment;
  endpoint: string;
  bucket: string;
}

/** 开发/生产桶身份隔离：同 endpoint+桶即视为未隔离（前缀不同不算隔离） */
export function assertBucketIdentityIsolated(
  development: MediaBucketIdentity,
  production: MediaBucketIdentity,
): void {
  const same =
    development.bucket === production.bucket && development.endpoint === production.endpoint;
  if (same) {
    throw new MediaError(
      "bucket_identity_not_isolated",
      "开发与生产对象存储身份相同：前缀不是权限，必须先配置物理隔离的桶。",
    );
  }
}

function isEnvironment(value: string | undefined): value is MediaEnvironment {
  return value !== undefined && (MEDIA_ENVIRONMENTS as readonly string[]).includes(value);
}

function isMode(value: string | undefined): value is MediaStorageMode {
  return value !== undefined && (MEDIA_STORAGE_MODES as readonly string[]).includes(value);
}

/**
 * 从环境读取存储配置；缺少必要变量返回 null（调用方必须 fail closed，不得默认放行）。
 * 不读取 .env 文件，只接受显式传入的 env 对象。
 */
export function loadMediaStorageConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MediaStorageConfig | null {
  const platform = env.YAYA_PLATFORM_AUTH === 'workload';
  const environment = platform ? env.COZE_PROJECT_ENV === 'PROD' ? 'production' : env.COZE_PROJECT_ENV === 'DEV' ? 'development' : undefined : env.MEDIA_ENVIRONMENT?.trim();
  const mode = env.MEDIA_STORAGE_MODE?.trim() || (platform ? 's3' : undefined);
  if (!isEnvironment(environment) || !isMode(mode)) return null;
  if (mode === "local") {
    if (environment === 'production') return null;
    const root = env.MEDIA_LOCAL_ROOT?.trim();
    if (!root) return null;
    return {
      mode,
      environment,
      bucket: "",
      endpoint: "",
      region: "",
      local_root: root,
    };
  }
  const bucket = (platform ? env.COZE_BUCKET_NAME : env.MEDIA_BUCKET_NAME)?.trim();
  const endpoint = (platform ? env.COZE_BUCKET_ENDPOINT_URL : env.MEDIA_BUCKET_ENDPOINT)?.trim();
  const region = env.MEDIA_BUCKET_REGION?.trim() || (platform ? 'cn-beijing' : 'auto');
  if (!bucket || !endpoint) return null;
  return { mode, environment, bucket, endpoint, region, local_root: null };
}

export function createObjectStore(config: MediaStorageConfig): MediaObjectStore {
  if (config.mode === "local") {
    if (!config.local_root) throw new MediaError("media_unavailable", "本地对象存储缺少 root 配置。");
    return new LocalMediaObjectStore(config.local_root);
  }
  return new S3MediaObjectStore({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
  });
}

const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 对象键：media/<env>/<owner>/<attachment>/<variant>。
 * env 参与命名只为可运维区分；授权永远来自元数据记录与业务记录，不看前缀。
 */
export function buildObjectKey(input: {
  environment: MediaEnvironment;
  owner_account_id: string;
  attachment_id: string;
  variant: MediaVariant;
  checksum_sha256?: string;
}): string {
  if (!KEY_SEGMENT.test(input.owner_account_id) || !KEY_SEGMENT.test(input.attachment_id)) {
    throw new MediaError("invalid_request", "对象键身份不合法。");
  }
  if (input.checksum_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.checksum_sha256)) throw new MediaError('invalid_request', '对象内容摘要不合法。');
  return `${input.environment === "production" ? "media/prod" : "media/dev"}/${input.owner_account_id}/${input.attachment_id}/${input.variant}${input.checksum_sha256 ? '/' + input.checksum_sha256 : ''}`;
}
