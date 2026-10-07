import { Config, LLMClient } from 'coze-coding-dev-sdk';
import type { ContentPart, Message } from 'coze-coding-dev-sdk';

import { FIVE_DOMAINS } from './types';
import { assertCozeEndpoint, platformWorkloadHeaders } from './coze-runtime';

export type LlmProvider = 'coze' | 'stepfun';
export type LlmResponseType =
  | 'follow_up_decision'
  | 'observation_draft'
  | 'teacher_edit_review'
  | 'growth_profile'
  | 'activity_support'
  | 'guide_evidence_suggestion';

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type LlmResult = {
  content: string;
  provider: LlmProvider;
  model: string;
  usage?: LlmUsage;
};

export type LlmOptions = {
  temperature?: number;
  thinking?: 'enabled' | 'disabled';
  forwardHeaders?: Record<string, string>;
  responseType?: LlmResponseType;
};

/**
 * 聊天图片输入：只接受服务端已授权、已处理的图片字节。
 * 该类型没有 URL 字段，签名 URL / 公有链接不能进入模型调用。
 */
export type LlmChatImage = {
  media_type: 'image/jpeg' | 'image/png' | 'image/webp';
  data_base64: string;
};

export type LlmChatMessage = {
  role: LlmMessage['role'];
  content: string;
  images?: readonly LlmChatImage[];
};

/** 应用自有结构化动作格式（如芽芽 answer/read/clarify/propose_write） */
export type LlmChatResponseFormat = {
  name: string;
  schema: object;
};

export type LlmChatOptions = {
  temperature?: number;
  thinking?: 'enabled' | 'disabled';
  forwardHeaders?: Record<string, string>;
  /** 原 6 类 strict json_schema 之一 */
  responseType?: LlmResponseType;
  /** 应用自有 strict json_schema；与 responseType 同时给出时优先本项 */
  responseFormat?: LlmChatResponseFormat;
  /** 调用方取消传播；上游物理取消效果另记 NOT_RUN */
  signal?: AbortSignal;
};

export type LlmChatResult = {
  content: string;
  provider: LlmProvider;
  model: string;
  /** 未知 usage 记 null，不填 0 */
  usage: LlmUsage | null;
};

/** provider 不具备所需能力（如图片输入）时显式抛出；不静默切换 provider */
export class LlmUnsupportedCapabilityError extends Error {
  readonly code = 'unsupported_capability' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnsupportedCapabilityError';
  }
}

/** 调用方取消（AbortSignal） */
export class LlmAbortedError extends Error {
  readonly code = 'aborted' as const;
  constructor(message = '模型请求已取消') {
    super(message);
    this.name = 'LlmAbortedError';
  }
}

export const COZE_ORGANIZE_MODEL = 'doubao-seed-2-0-lite-260215';
const DEFAULT_STEPFUN_BASE_URL = 'https://api.stepfun.com/step_plan/v1';
const DEFAULT_STEPFUN_MODEL = 'step-5-preview';
export const DEFAULT_STEPFUN_TIMEOUT_MS = 60_000;
const MIN_STEPFUN_TIMEOUT_MS = 1_000;
const MAX_STEPFUN_TIMEOUT_MS = 120_000;

// StepFun 原生 JSON Schema 结构化输出；Zod 仍作为最终校验，不把非法输出静默映射成合法值。
const STEPFUN_RESPONSE_FORMATS: Record<LlmResponseType, object> = {
  observation_draft: {
    type: 'json_schema',
    json_schema: {
      name: 'observation_draft',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'domain',
          'sub_domain',
          'objective_description',
          'highlights',
          'support_suggestions',
          'highlight_quote',
        ],
        properties: {
          domain: { type: 'string', enum: [...FIVE_DOMAINS] },
          sub_domain: { type: 'string' },
          objective_description: { type: 'string' },
          highlights: { type: 'array', items: { type: 'string' } },
          support_suggestions: { type: 'array', items: { type: 'string' } },
          highlight_quote: { type: 'string' },
        },
      },
    },
  },
  follow_up_decision: {
    type: 'json_schema',
    json_schema: {
      name: 'follow_up_decision',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'question', 'reason'],
        properties: {
          decision: { type: 'string', enum: ['ask', 'proceed'] },
          question: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
  teacher_edit_review: {
    type: 'json_schema',
    json_schema: {
      name: 'teacher_edit_review',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'summary', 'change_summary', 'fact_check', 'question'],
        properties: {
          decision: { type: 'string', enum: ['accept', 'clarify'] },
          summary: { type: 'string' },
          change_summary: { type: 'array', items: { type: 'string' } },
          fact_check: {
            type: 'string',
            enum: ['supported', 'partially_supported', 'unsupported'],
          },
          question: { type: 'string' },
        },
      },
    },
  },
  growth_profile: {
    type: 'json_schema',
    json_schema: {
      name: 'growth_profile',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'recent_change', 'development_clues', 'next_support', 'next_focus'],
        properties: {
          summary: { type: 'string' },
          recent_change: { type: 'string' },
          development_clues: { type: 'array', items: { type: 'string' } },
          next_support: { type: 'string' },
          next_focus: { type: 'string' },
        },
      },
    },
  },
  activity_support: {
    type: 'json_schema',
    json_schema: {
      name: 'activity_support',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['suggestions'],
        properties: {
          suggestions: {
            type: 'array',
            minItems: 2,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'title',
                'purpose',
                'steps',
                'materials',
                'observe',
                'adaptation',
                'evidence',
              ],
              properties: {
                title: { type: 'string' },
                purpose: { type: 'string' },
                steps: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' } },
                materials: { type: 'array', items: { type: 'string' } },
                observe: { type: 'string' },
                adaptation: { type: 'string' },
                evidence: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  // 指南证据关联建议：只输出候选条目、理由与可核对引用；quote_field 用 "" 表示 raw_text（null）；
  // quote_source_id 必须来自服务端提供的观察 id，避免同句多来源时绑定错误
  guide_evidence_suggestion: {
    type: 'json_schema',
    json_schema: {
      name: 'guide_evidence_suggestion',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['suggestions'],
        properties: {
          suggestions: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['item_id', 'reason', 'quote', 'quote_source', 'quote_field', 'quote_source_id'],
              properties: {
                item_id: { type: 'string' },
                reason: { type: 'string' },
                quote: { type: 'string' },
                quote_source: { type: 'string', enum: ['raw_text', 'confirmed_content'] },
                quote_field: { type: 'string', enum: ['highlight_quote', 'highlights', ''] },
                quote_source_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function redact(value: string, secret: string): string {
  return secret ? value.split(secret).join('[redacted]') : value;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(value: unknown): LlmUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberValue(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = numberValue(value.output_tokens ?? value.completion_tokens);
  const totalTokens = numberValue(value.total_tokens);
  const usage: LlmUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function errorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = payload.error;
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  return null;
}

class StepFunTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`StepFun 请求超时（${timeoutMs}ms）`);
    this.name = 'StepFunTimeoutError';
  }
}

function timeoutRace(signal: AbortSignal, timeoutMs: number): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let onAbort: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new StepFunTimeoutError(timeoutMs));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    cancel: () => signal.removeEventListener('abort', onAbort),
  };
}

async function readJsonWithSignal(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const timeout = timeoutRace(signal, timeoutMs);
  try {
    const text = await Promise.race([response.text(), timeout.promise]);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  } finally {
    timeout.cancel();
  }
}

function isStepFunTimeout(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

function getStepFunModel(): string {
  return process.env.STEPFUN_MODEL?.trim() || DEFAULT_STEPFUN_MODEL;
}

export function getStepFunTimeoutMs(): number {
  const raw = process.env.STEPFUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_STEPFUN_TIMEOUT_MS;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < MIN_STEPFUN_TIMEOUT_MS ||
    value > MAX_STEPFUN_TIMEOUT_MS
  ) {
    return DEFAULT_STEPFUN_TIMEOUT_MS;
  }
  return value;
}

export function getLlmProvider(): LlmProvider {
  const provider = process.env.LLM_PROVIDER?.trim().toLowerCase() || 'coze';
  if (provider !== 'coze' && provider !== 'stepfun') {
    throw new Error(`不支持的 LLM_PROVIDER：${provider}`);
  }
  return provider;
}

export function getLlmModel(provider = getLlmProvider()): string {
  return provider === 'stepfun' ? getStepFunModel() : COZE_ORGANIZE_MODEL;
}

async function invokeCoze(messages: LlmMessage[], options: LlmOptions): Promise<LlmResult> {
  const response = await new LLMClient(new Config(), options.forwardHeaders).invoke(messages, {
    model: COZE_ORGANIZE_MODEL,
    temperature: options.temperature ?? 0.3,
    thinking: options.thinking ?? 'disabled',
  });
  if (!response.content.trim()) throw new Error('Coze 返回空内容');
  return {
    content: response.content,
    provider: 'coze',
    model: COZE_ORGANIZE_MODEL,
  };
}

/**
 * StepFun HTTP 请求公共路径：超时 + 可选调用方取消；错误文案与旧实现一致。
 * callerSignal 存在时与超时信号合并；调用方取消与超时分别报告。
 */
async function postStepFun(
  body: Record<string, unknown>,
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  const apiKey = requiredEnv('STEPFUN_API_KEY');
  const baseUrl = (process.env.STEPFUN_BASE_URL?.trim() || DEFAULT_STEPFUN_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const timeoutMs = getStepFunTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([timeoutSignal, callerSignal])
    : timeoutSignal;
  const requestUrl = `${baseUrl}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (callerSignal?.aborted) throw new LlmAbortedError();
    if (isStepFunTimeout(error, signal)) {
      throw new Error(`StepFun 请求超时（${timeoutMs}ms），请稍后重试`);
    }
    const message = error instanceof Error ? error.message : '网络请求失败';
    throw new Error(`StepFun 请求失败：${redact(message, apiKey)}`);
  }

  let payload: unknown;
  try {
    payload = await readJsonWithSignal(response, signal, timeoutMs);
  } catch (error) {
    if (callerSignal?.aborted) throw new LlmAbortedError();
    if (isStepFunTimeout(error, signal)) {
      throw new Error(`StepFun 请求超时（${timeoutMs}ms），请稍后重试`);
    }
    throw error;
  }
  if (!response.ok) {
    const message = errorMessage(payload) ?? `HTTP ${response.status}`;
    throw new Error(`StepFun 请求失败：${redact(message, apiKey)}`);
  }
  return payload;
}

function stepFunContent(payload: unknown): string {
  const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  const message = isRecord(firstChoice) ? firstChoice.message : null;
  const content = isRecord(message) && typeof message.content === 'string'
    ? message.content
    : '';
  if (!content.trim()) {
    throw new Error('StepFun 响应缺少 choices[0].message.content');
  }
  return content;
}

async function invokeStepFun(messages: LlmMessage[], options: LlmOptions): Promise<LlmResult> {
  const model = getStepFunModel();
  const payload = await postStepFun(
    {
      model,
      messages,
      temperature: options.temperature ?? 0.3,
      response_format: STEPFUN_RESPONSE_FORMATS[options.responseType ?? 'observation_draft'],
    },
    undefined,
  );

  return {
    content: stepFunContent(payload),
    provider: 'stepfun',
    model,
    usage: isRecord(payload) ? normalizeUsage(payload.usage) : undefined,
  };
}

export async function invokeLlm(
  messages: LlmMessage[],
  options: LlmOptions = {},
): Promise<LlmResult> {
  return getLlmProvider() === 'stepfun'
    ? invokeStepFun(messages, options)
    : invokeCoze(messages, options);
}

/* ----------------------------- 聊天 / 多模态调用 ----------------------------- */

export function imageDataUri(image: LlmChatImage): string {
  return `data:${image.media_type};base64,${image.data_base64}`;
}

/** Coze 聊天消息映射：图片只以 base64 data URI 进入 ContentPart，不接受 URL */
export function buildCozeChatMessages(messages: readonly LlmChatMessage[]): Message[] {
  return messages.map((message) => {
    const images = message.images ?? [];
    if (images.length === 0) return { role: message.role, content: message.content };
    const parts: ContentPart[] = [
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: imageDataUri(image) },
      })),
      { type: 'text' as const, text: message.content },
    ];
    return { role: message.role, content: parts };
  });
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new LlmAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LlmAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function stepFunChatResponseFormat(options: LlmChatOptions): object | undefined {
  if (options.responseFormat) {
    return {
      type: 'json_schema',
      json_schema: {
        name: options.responseFormat.name,
        strict: true,
        schema: options.responseFormat.schema,
      },
    };
  }
  return options.responseType ? STEPFUN_RESPONSE_FORMATS[options.responseType] : undefined;
}

/** The platform may return SSE even when stream=false. Never accept HTML or
 * incomplete streams as a successful model response; reasoning is not emitted.
 */
export function parseCozeModelWire(body: string, contentType: string): unknown {
  const text = body.trim();
  if (text.startsWith('{')) return JSON.parse(text) as unknown;
  if (!contentType.includes('text/event-stream') && !text.startsWith('data:')) throw Error('扣子网关没有返回模型 JSON 或合法事件流。');
  let content = '', usage: unknown = null, model: string | null = null, done = false, ended = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (ended) throw Error('扣子事件流终态后仍有数据。');
    if (data === '[DONE]') { done = true; ended = true; continue; }
    const value: unknown = JSON.parse(data);
    if (!isRecord(value) || value.error) throw Error('扣子事件流包含错误。');
    if (typeof value.model === 'string') {
      if (model !== null && model !== value.model) throw Error('扣子事件流模型身份矛盾。');
      model = value.model;
    }
    if (value.usage) usage = value.usage;
    if (!Array.isArray(value.choices)) continue;
    for (const choice of value.choices) {
      if (!isRecord(choice)) throw Error('扣子事件流形状错误。');
      if (isRecord(choice.delta) && typeof choice.delta.content === 'string') content += choice.delta.content;
      if (choice.finish_reason === 'stop') done = true;
      if (choice.finish_reason === 'length') throw Error('扣子模型回答被截断。');
    }
  }
  if (!done || !content.trim()) throw Error('扣子事件流没有完整回答。');
  return { model, choices: [{ message: { content } }], usage };
}

async function invokeCozeChat(
  messages: readonly LlmChatMessage[],
  options: LlmChatOptions,
): Promise<LlmChatResult> {
  const model = process.env.YAYA_COZE_MODEL?.trim() || COZE_ORGANIZE_MODEL;
  if (process.env.YAYA_PLATFORM_AUTH === 'workload') {
    const headers = platformWorkloadHeaders('model', options.forwardHeaders);
    const endpoint = assertCozeEndpoint(process.env.COZE_INTEGRATION_MODEL_BASE_URL || 'https://integration.coze.cn/api/v3');
    const timeout = AbortSignal.timeout(getStepFunTimeoutMs());
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await fetch(endpoint + '/chat/completions', { method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json', 'X-Client-Sdk': 'coze-coding-dev-sdk-typescript/0.3.0' }, body: JSON.stringify({ model, messages: buildCozeChatMessages(messages), temperature: options.temperature ?? 0.3, thinking: { type: options.thinking ?? 'disabled' }, stream: true, stream_options: { include_usage: true } }), signal });
    } catch {
      if (options.signal?.aborted) throw new LlmAbortedError();
      throw Error('扣子平台代理请求未完成。');
    }
    if (!response.ok) throw Error('扣子平台代理请求失败（HTTP ' + response.status + '）。');
    const timing = timeoutRace(signal, getStepFunTimeoutMs());
    let wire: string;
    try { wire = await Promise.race([response.text(), timing.promise]); } finally { timing.cancel(); }
    const value = parseCozeModelWire(wire, response.headers.get('content-type') ?? '');
    return { content: stepFunContent(value), provider: 'coze', model: isRecord(value) && typeof value.model === 'string' && value.model ? value.model : model, usage: isRecord(value) ? normalizeUsage(value.usage) ?? null : null };
  }
  // Coze 已安装 SDK 没有 response_format/tools 参数：结构化动作由 Prompt 承载，Zod 校验在应用层。
  const response = await raceWithAbort(
    new LLMClient(new Config(), options.forwardHeaders).invoke(buildCozeChatMessages(messages), {
      model,
      temperature: options.temperature ?? 0.3,
      thinking: options.thinking ?? 'disabled',
    }),
    options.signal,
  );
  if (!response.content.trim()) throw new Error('Coze 返回空内容');
  return {
    content: response.content,
    provider: 'coze',
    model,
    usage: null,
  };
}

async function invokeStepFunChat(
  messages: readonly LlmChatMessage[],
  options: LlmChatOptions,
): Promise<LlmChatResult> {
  if (messages.some((message) => (message.images?.length ?? 0) > 0)) {
    throw new LlmUnsupportedCapabilityError(
      'StepFun 当前路径不支持图片输入；不会静默切换 provider',
    );
  }
  const model = getStepFunModel();
  const responseFormat = stepFunChatResponseFormat(options);
  const payload = await postStepFun(
    {
      model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: options.temperature ?? 0.3,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    },
    options.signal,
  );
  return {
    content: stepFunContent(payload),
    provider: 'stepfun',
    model,
    usage: isRecord(payload) ? (normalizeUsage(payload.usage) ?? null) : null,
  };
}

/**
 * 聊天/多模态调用入口：复用同一 llm.ts 的 provider 选择、超时、错误文案与
 * 调用方取消传播；保留 invokeLlm 旧文本调用与原 6 类 strict schema 不变。
 */
export async function invokeChatLlm(
  messages: readonly LlmChatMessage[],
  options: LlmChatOptions = {},
): Promise<LlmChatResult> {
  const key = messages.some(message => (message.images?.length ?? 0) > 0) ? 'YAYA_CHAT_IMAGE_PROVIDER' : 'YAYA_CHAT_TEXT_PROVIDER';
  const provider = process.env[key]?.trim() || getLlmProvider();
  if (provider !== 'coze' && provider !== 'stepfun') throw Error('不支持的聊天 provider。');
  return provider === 'stepfun'
    ? invokeStepFunChat(messages, options)
    : invokeCozeChat(messages, options);
}
