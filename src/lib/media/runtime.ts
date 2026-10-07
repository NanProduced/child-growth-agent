import { createObjectStore, loadMediaStorageConfig, type MediaEnvironment } from "./config";
import { createDataAttachmentMetadataPort } from "./data-adapter";
import { MediaError } from "./errors";
import type { AttachmentMetadataPort } from "./metadata-port";
import { MemoryAttachmentMetadata } from "./metadata-memory";
import type { MediaObjectStore } from "./object-store";
import { LocalMediaObjectStore } from "./object-store-local";

/**
 * MEDIA1 运行绑定。
 *
 * 路由只通过 mediaRuntimeOrThrow() 取依赖：
 * - 显式 bindMediaRuntime 优先（检查/开发注入内存替身或受控依赖）；
 * - 未显式绑定：按部署环境变量组装**真实** DATA1 附件 repository 元数据端口 +
 *   环境对应对象存储（MEDIA_STORAGE_MODE=local/s3）；缺少存储配置时 fail closed 503，
 *   不自动回退内存 repository、不返回假成功；
 * - 本地/测试可用 createLocalMediaRuntime 组装内存元数据 + 本地对象存储替身。
 */

export interface MediaServiceDeps {
  metadata: AttachmentMetadataPort;
  store: MediaObjectStore;
  environment: MediaEnvironment;
}

let boundRuntime: MediaServiceDeps | null = null;

export function bindMediaRuntime(runtime: MediaServiceDeps | null): void {
  boundRuntime = runtime;
}

export function mediaRuntimeOrThrow(): MediaServiceDeps {
  if (boundRuntime !== null) return boundRuntime;
  const config = loadMediaStorageConfig();
  if (config === null) {
    throw new MediaError(
      "media_unavailable",
      "媒体存储未配置（需要 MEDIA_ENVIRONMENT/MEDIA_STORAGE_MODE 等），已拒绝请求。",
    );
  }
  return {
    metadata: createDataAttachmentMetadataPort(),
    store: createObjectStore(config),
    environment: config.environment,
  };
}

/** 开发/测试替身组合：内存元数据 + 本地文件对象存储（真实本地 I/O） */
export function createLocalMediaRuntime(input: {
  root: string;
  environment: MediaEnvironment;
}): MediaServiceDeps {
  return {
    metadata: new MemoryAttachmentMetadata(),
    store: new LocalMediaObjectStore(input.root),
    environment: input.environment,
  };
}
