/**
 * TOOLS-READ1：芽芽真实只读工具注册与授权读取。
 *
 * 消费方式（AGENT-APP1 / TOOLS1）：
 *   const registry = createYayaReadRegistry();
 *   const readTool = registry.readTool;              // 直接接入 YayaAgentDependencies
 *   const definitions = registry.definitions;        // 模型可见白名单与参数协议
 *   const outcome = await registry.dispatch({ tool, params }, { request }); // 独立调用
 */
export { createYayaReadPorts } from './ports';
export { createYayaReadRegistry } from './registry';
export type {
  YayaChildClassContext,
  YayaChildProfileRecord,
  YayaClassBundle,
  YayaObservationFilters,
  YayaReadPayload,
  YayaReadPorts,
  YayaReadRegistry,
  YayaReadToolContext,
  YayaReadToolRegistration,
} from './types';
