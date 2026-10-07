/**
 * UI1 客户端数据访问：只消费已批准协议。
 *
 * - 先判断 HTTP 状态，再解析响应体；坏 JSON / 空对象 / 校验失败都不是成功；
 * - 写请求经 `fetchWithAccountAuth`（同源 + CSRF；身份不可用时合成 401/503）；
 * - 所有错误统一为 `YayaApiError`，UI 不做本地权限判断；
 * - 不抓取任意远程 URL：图片只走授权内容接口 `…/content?variant=`。
 */
import type { z } from "zod";

import { readAccountStatus, fetchWithAccountAuth } from "@/lib/accounts/client";
import { CSRF_HEADER_NAME } from "@/lib/accounts/types";

import { uploadBatchResponseSchema, type UploadFileResult } from "./schemas";
import type { YayaRunErrorPartData } from "./parts";

export const YAYA_UPLOADS_PATH = "/api/yaya/uploads";
export const YAYA_CONVERSATIONS_PATH = "/api/yaya/conversations";
export const YAYA_PROPOSALS_PATH = "/api/yaya/proposals";
export const YAYA_OPERATIONS_PATH = "/api/yaya/operations";

export class YayaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "YayaApiError";
  }
}

export async function yayaHttpError(response: Response): Promise<YayaApiError> {
  const { code, message } = await readErrorBody(response);
  return new YayaApiError(response.status, code, message);
}

async function readErrorBody(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const code = typeof record.error === "string" ? record.error : `http_${response.status}`;
      const message =
        typeof record.message === "string" && record.message.trim() !== ""
          ? record.message
          : "请求未完成，请稍后重试。";
      return { code, message };
    }
  } catch {
    // 保持通用文案；不展示原始响应体
  }
  return { code: `http_${response.status}`, message: "请求未完成，请稍后重试。" };
}

async function parseOrThrow<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    throw await yayaHttpError(response);
  }
  const body: unknown = await response.json().catch(() => null);
  if (body === null) {
    throw new YayaApiError(response.status, "malformed_response", "响应无法解析，未显示成功。");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new YayaApiError(response.status, "malformed_response", "响应不符合协议，未显示成功。");
  }
  return parsed.data;
}

export async function yayaGetJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new YayaApiError(0, "network_error", "网络连接异常，请重试。");
  }
  return parseOrThrow(response, schema);
}

export async function yayaWriteJson<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown | null,
  schema: z.ZodType<T>
): Promise<T> {
  const response = await fetchWithAccountAuth(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === null ? undefined : JSON.stringify(body),
  });
  return parseOrThrow(response, schema);
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadSingleOptions {
  clientUploadId: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/** 每张图片独立请求（避免总请求体超过托管 16MB 限制）；client_upload_id 稳定、可重试。 */
export async function yayaUploadImage(file: File, options: UploadSingleOptions): Promise<UploadFileResult> {
  const status = await readAccountStatus();
  if (status.state.kind !== "authenticated" || !status.csrf) {
    throw new YayaApiError(
      status.state.kind === "unavailable" ? 503 : 401,
      status.state.kind === "unavailable" ? "identity_unavailable" : "unauthenticated",
      status.state.kind === "unavailable" ? "身份服务暂时不可用，请稍后重试。" : "请先登录园所账号。"
    );
  }
  const form = new FormData();
  form.append("files", file);
  form.append("client_batch_id", options.clientUploadId);
  const csrfToken = status.csrf.token;
  const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", YAYA_UPLOADS_PATH);
    xhr.responseType = "json";
    xhr.withCredentials = true;
    xhr.setRequestHeader(CSRF_HEADER_NAME, csrfToken);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.({ loaded: event.loaded, total: event.total });
    };
    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    xhr.onload = () => {
      cleanup();
      resolve({ status: xhr.status, body: xhr.response ?? null });
    };
    xhr.onerror = () => {
      cleanup();
      reject(new YayaApiError(0, "network_error", "网络连接异常，请重试。"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    xhr.send(form);
  });
  if (response.status === 401 || response.status === 403 || response.status === 503) {
    window.dispatchEvent(new Event("cga:auth-changed"));
  }
  if (response.status < 200 || response.status >= 300) {
    const record =
      typeof response.body === "object" && response.body !== null
        ? (response.body as Record<string, unknown>)
        : {};
    const code = typeof record.error === "string" ? record.error : `http_${response.status}`;
    const message =
      typeof record.message === "string" && record.message.trim() !== ""
        ? record.message
        : "上传未完成，请稍后重试。";
    throw new YayaApiError(response.status, code, message);
  }
  const parsed = uploadBatchResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    throw new YayaApiError(502, "malformed_response", "上传响应不符合协议，未显示成功。");
  }
  const first = parsed.data.uploads[0];
  if (first === undefined) {
    throw new YayaApiError(502, "malformed_response", "上传响应缺少结果，未显示成功。");
  }
  return first;
}

/** 错误 → 运行错误卡数据；文案按层固定，不冒充成功、不外泄内部细节。 */
export function yayaApiErrorToPart(error: YayaApiError): YayaRunErrorPartData {
  const stage: YayaRunErrorPartData["stage"] =
    error.status === 0 ? "network" : error.status === 404 ? "not_wired" : "http";
  let message: string;
  switch (error.status) {
    case 401:
      message = "请先登录园所账号。";
      break;
    case 403:
      message = error.message || "当前账号不能执行这项操作。";
      break;
    case 404:
      message = "AI 整理服务尚未接通，或会话不存在；没有开始任何业务写入。";
      break;
    case 409:
      message = "会话前提已变化，需要重新核对。";
      break;
    case 503:
      message = "服务暂时不可用，请稍后重试。";
      break;
    default:
      message = error.message || "请求未完成，请稍后重试。";
  }
  return { stage, status: error.status === 0 ? null : error.status, code: error.code, message, detail: null };
}

export function yayaAttachmentContentUrl(
  attachmentId: string,
  variant: "original" | "thumbnail" | "model" = "thumbnail"
): string {
  return `${YAYA_UPLOADS_PATH}/${encodeURIComponent(attachmentId)}/content?variant=${variant}`;
}

const ATTACHMENT_URL_PATTERN = /^\/api\/yaya\/uploads\/([^/]+)\/content\?variant=/;

/** 历史消息附件只回投影 id；受权图片 URL 由 id 重建（不持久化外部 URL）。 */
export function yayaAttachmentIdFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = ATTACHMENT_URL_PATTERN.exec(url);
  if (!match || match[1] === undefined) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
