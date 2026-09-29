import { Config, LLMClient } from 'coze-coding-dev-sdk';

export type LlmProvider = 'coze' | 'stepfun';

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
};

export const COZE_ORGANIZE_MODEL = 'doubao-seed-2-0-lite-260215';
const DEFAULT_STEPFUN_BASE_URL = 'https://api.stepfun.com/step_plan/v1';
const DEFAULT_STEPFUN_MODEL = 'step-5-preview';

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

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function getStepFunModel(): string {
  return process.env.STEPFUN_MODEL?.trim() || DEFAULT_STEPFUN_MODEL;
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
        response_format: { type: 'json_object' },
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '网络请求失败';
    throw new Error(`StepFun 请求失败：${redact(message, apiKey)}`);
  }

  const payload = await readJson(response);
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
