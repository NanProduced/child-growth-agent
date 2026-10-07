/**
 * 芽芽模型网关（AGENT1-CORE）。
 *
 * 正式网关走同一 src/lib/llm.ts 的 invokeChatLlm：文本 + 图片字节 + 取消传播，
 * 并把应用动作协议作为 strict json_schema（StepFun）或 Prompt 约束（Coze）下发。
 * provider 能力不足（如 StepFun 图片输入）由 llm.ts 抛出 unsupported，不静默换 provider。
 */
import { invokeChatLlm } from '../../llm';

import {
  YAYA_ACTION_WIRE_FORMAT,
  type YayaModelGateway,
  type YayaModelRequest,
  type YayaModelResponse,
} from './types';

export function createLlmYayaModelGateway(options: { dateAnchor?: string; forwardHeaders?: Record<string, string> } = {}): YayaModelGateway {
  return {
    async generate(request: YayaModelRequest): Promise<YayaModelResponse> {
      const result = await invokeChatLlm(
        [...(options.dateAnchor ? [{ role: 'system' as const, text: `服务端本次运行日期（Asia/Shanghai）：${options.dateAnchor}。今天/昨天以此为锚点；教师已明确给出的绝对日期优先，不要因缺少模型自身时钟而追问今天是哪一天。此日期不是幼儿事实，也不改写教师原文。` }] : []), ...request.messages].map((message) => ({
          role: message.role,
          content: message.text,
          images: message.images,
        })),
        {
          temperature: 0.3,
          signal: request.signal,
          responseFormat: YAYA_ACTION_WIRE_FORMAT,
          forwardHeaders: options.forwardHeaders,
        },
      );
      return {
        content: result.content,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      };
    },
  };
}
