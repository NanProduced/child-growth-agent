import { Config, LLMClient } from 'coze-coding-dev-sdk';

import { FIVE_DOMAINS } from './types';

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
  // 指南证据关联建议：只输出候选条目、理由与可核对引用；quote_field 用 "" 表示 raw_text（null）
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
              required: ['item_id', 'reason', 'quote', 'quote_source', 'quote_field'],
              properties: {
                item_id: { type: 'string' },
                reason: { type: 'string' },
                quote: { type: 'string' },
                quote_source: { type: 'string', enum: ['raw_text', 'confirmed_content'] },
                quote_field: { type: 'string', enum: ['highlight_quote', 'highlights', ''] },
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

async function invokeStepFun(messages: LlmMessage[], options: LlmOptions): Promise<LlmResult> {
  const apiKey = requiredEnv('STEPFUN_API_KEY');
  const baseUrl = (process.env.STEPFUN_BASE_URL?.trim() || DEFAULT_STEPFUN_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const model = getStepFunModel();
  const timeoutMs = getStepFunTimeoutMs();
  const signal = AbortSignal.timeout(timeoutMs);
  const requestUrl = `${baseUrl}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.3,
        response_format: STEPFUN_RESPONSE_FORMATS[options.responseType ?? 'observation_draft'],
      }),
      signal,
    });
  } catch (error) {
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
    if (isStepFunTimeout(error, signal)) {
      throw new Error(`StepFun 请求超时（${timeoutMs}ms），请稍后重试`);
    }
    throw error;
  }
  if (!response.ok) {
    const message = errorMessage(payload) ?? `HTTP ${response.status}`;
    throw new Error(`StepFun 请求失败：${redact(message, apiKey)}`);
  }

  const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  const message = isRecord(firstChoice) ? firstChoice.message : null;
  const content = isRecord(message) && typeof message.content === 'string'
    ? message.content
    : '';
  if (!content.trim()) {
    throw new Error('StepFun 响应缺少 choices[0].message.content');
  }

  return {
    content,
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
