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

export function createLlmYayaModelGateway(): YayaModelGateway {
  return {
    async generate(request: YayaModelRequest): Promise<YayaModelResponse> {
      const result = await invokeChatLlm(
        request.messages.map((message) => ({
          role: message.role,
          content: message.text,
          images: message.images,
        })),
        {
          temperature: 0.3,
          signal: request.signal,
          responseFormat: YAYA_ACTION_WIRE_FORMAT,
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
