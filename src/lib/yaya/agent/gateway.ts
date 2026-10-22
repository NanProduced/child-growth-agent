/**
 * 芽芽模型网关（AGENT1-CORE）。
 *
 * 正式网关走同一 src/lib/llm.ts 的 invokeChatLlm：文本 + 图片字节 + 取消传播，
 * 并把应用动作协议作为 strict json_schema（StepFun）或原生工具/Prompt 约束（Coze）下发。
 * Step 5 Preview 支持图片字节；未接入的模型由 llm.ts 拒绝，不静默换 provider。
 */
import { invokeChatLlm, type LlmChatTool, type LlmChatToolCall } from '../../llm';
import { extractJson } from '../../ai';

import {
  YAYA_ACTION_WIRE_FORMAT,
  yayaAgentActionSchema,
  type YayaModelGateway,
  type YayaModelMessage,
  type YayaModelRequest,
  type YayaModelResponse,
  type YayaModelToolCall,
  type YayaToolCatalog,
} from './types';

/** Coze fallback has no strict schema mode: only omitted no-op answer fields are defaulted. */
function normalizeCozeAnswer(content: string): string {
  let value: unknown;
  try {
    value = extractJson(content);
  } catch {
    const text = content.trim();
    return text.length > 0
      ? JSON.stringify({ action: 'answer', content: text, tool: '', params_json: '', source_refs: [] })
      : content;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return content;
  const record = value as Record<string, unknown>;
  if (record.action !== 'answer' && record.action !== 'clarify') return content;
  const parsed = yayaAgentActionSchema.safeParse({ tool: '', params_json: '', source_refs: [], ...record });
  return parsed.success ? JSON.stringify(parsed.data) : content;
}

function nativeTools(catalog: YayaToolCatalog | undefined): LlmChatTool[] {
  if (!catalog) return [];
  return [...catalog.read_tools, ...catalog.write_tools].map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.tool,
      description: tool.description,
      parameters: tool.params.describe().json_schema,
    },
  }));
}

function nativeToolCalls(
  calls: readonly LlmChatToolCall[],
  catalog: YayaToolCatalog | undefined,
): YayaModelToolCall[] {
  return calls.map((call) => {
    if (!call.id) throw new Error(`扣子模型工具调用 ${call.name} 缺少 tool_call_id`);
    const registered = catalog?.read_tools.some((tool) => tool.tool === call.name) ||
      catalog?.write_tools.some((tool) => tool.tool === call.name);
    if (!registered) throw new Error(`扣子模型调用了未注册工具：${call.name}`);
    return { id: call.id, type: 'function', name: call.name, arguments: call.arguments };
  });
}

export function createLlmYayaModelGateway(options: { dateAnchor?: string; forwardHeaders?: Record<string, string>; tools?: YayaToolCatalog } = {}): YayaModelGateway {
  return {
    async generate(request: YayaModelRequest): Promise<YayaModelResponse> {
      const modelMessages: YayaModelMessage[] = [
        ...(options.dateAnchor ? [{
          role: 'system' as const,
          text: `服务端本次运行日期（Asia/Shanghai）：${options.dateAnchor}。今天/昨天以此为锚点；教师已明确给出的绝对日期优先，不要因缺少模型自身时钟而追问今天是哪一天。此日期不是幼儿事实，也不改写教师原文。`,
        }] : []),
        ...request.messages,
      ];
      const messages = modelMessages.map((message) => ({
        role: message.role,
        content: message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0
          ? null
          : message.text,
        ...(message.images ? { images: message.images } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      }));
      const result = await invokeChatLlm(
        messages.map((message) => ({
          role: message.role,
          content: message.content,
          images: message.images,
          tool_calls: message.tool_calls,
          tool_call_id: message.tool_call_id,
        })),
        {
          temperature: 0.3,
          signal: request.signal,
          responseFormat: YAYA_ACTION_WIRE_FORMAT,
          forwardHeaders: options.forwardHeaders,
          tools: nativeTools(options.tools),
        },
      );
      const toolCalls = result.toolCalls && result.toolCalls.length > 0
        ? nativeToolCalls(result.toolCalls, options.tools)
        : undefined;
      return {
        content: toolCalls ? '' : result.provider === 'coze' ? normalizeCozeAnswer(result.content) : result.content,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      };
    },
  };
}
