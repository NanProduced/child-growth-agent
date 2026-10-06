import type { MediaEnvironment } from "./config";
import { MediaError } from "./errors";
import type { AttachmentMetadataPort } from "./metadata-port";
import { MemoryAttachmentMetadata } from "./metadata-memory";
import type { MediaObjectStore } from "./object-store";
import { LocalMediaObjectStore } from "./object-store-local";

/**
 * MEDIA1 运行绑定。
 *
 * 路由只通过 mediaRuntimeOrThrow() 取依赖：
 * - 未绑定（DATA1 repository 尚未接入）时 fail closed 503，不返回假成功；
 * - 整合者用 DATA1 的附件 repository + 环境对应的对象存储调用 bindMediaRuntime；
 * - 本地/测试用 createLocalMediaRuntime 组装内存元数据 + 本地对象存储替身。
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
  if (boundRuntime === null) {
    throw new MediaError(
      "media_unavailable",
      "媒体元数据服务尚未接入（等待 DATA1 repository 装配），已拒绝请求。",
    );
  }
  return boundRuntime;
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
