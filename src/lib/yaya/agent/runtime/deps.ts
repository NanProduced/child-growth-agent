/**
 * 芽芽运行依赖装配（AGENT-APP1）。
 *
 * 把现有内核端口接到真实服务：
 * - 模型：`createLlmYayaModelGateway()`（StepFun/Coze 现有 llm.ts 路径）；
 * - 身份：`resolveYayaRunCurrentIdentity`（原会话令牌 + run 行，每次边界重读）；
 * - 上下文：DATA 当前投影 + MEDIA 授权字节 + run 级依赖重核；
 * - 读取：READ1 registry（citable_source / 完整 recheck_dependencies），参数白名单与校验同源；
 * - 查询：DATA 原 operation 查询；
 * - 公开检索：默认关闭（provider_enabled=false），扫描恒为未知，服务端保守拒绝；
 * - 写入：正式装配缺 TOOLS1 工厂时 fail closed（`unsupported`），不返回假提案/假成功；
 *   TOOLS1 交付后通过 `write` 选项绑定真实工厂（同一 run 持久化与依赖钩子）。
 */
import { withPrivateRead, yayaDataRepository } from '@/lib/yaya/data';
import { createYayaReadRegistry, type YayaReadRegistry } from '@/lib/yaya/tools/read';

import { createLlmYayaModelGateway } from '../gateway';
import type {
  YayaAgentDependencies,
  YayaProposeWriteOutcome,
  YayaToolCatalog,
} from '../types';
import type { YayaSourceRef } from '../../types';

import {
  absorbYayaRunDependencies,
  loadYayaRunProjectedContext,
  revalidateYayaRunContext,
  type YayaRunRuntimeState,
} from './context';
import { resolveYayaRunCurrentIdentity } from './identity';
import type { YayaRunDependency } from './store';

function isSourceRef(value: unknown): value is YayaSourceRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === 'string' &&
    (record.ref_id === null || typeof record.ref_id === 'string') &&
    (record.label === null || typeof record.label === 'string') &&
    (record.derived_from === null || typeof record.derived_from === 'string')
  );
}

function payloadRecord(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * 已装载数据所需的投影等级：READ1 的观察负载带 `access_projection`
 * （get_observation 单条；list_observations 逐条）。完整投影加载过的观察
 * 在重核时必须仍为完整投影，否则不得继续消费旧完整 payload；
 * 只有历史只读加载过的观察保持历史只读可核验。
 */
function projectionRequirements(data: unknown): Map<string, 'full' | 'historical_read_only'> {
  const requirements = new Map<string, 'full' | 'historical_read_only'>();
  const add = (observationId: unknown, projection: unknown): void => {
    if (typeof observationId !== 'string' || observationId.length === 0) return;
    if (projection !== 'full' && projection !== 'historical_read_only') return;
    requirements.set(`observation:${observationId}`, projection);
  };
  const outer = payloadRecord(data);
  // READ1 payload 信封：{ tool, citable_source, recheck_dependencies, data: {...} }；
  // 观察负载在内层 data（get_observation 单条 / list_observations 逐条），两处都查。
  for (const record of [outer, payloadRecord(outer.data)]) {
    const single = record.observation;
    if (typeof single === 'object' && single !== null && !Array.isArray(single)) {
      add(
        (single as Record<string, unknown>).id,
        (single as Record<string, unknown>).access_projection,
      );
    }
    if (Array.isArray(record.observations)) {
      for (const item of record.observations) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const entry = item as Record<string, unknown>;
        add(entry.observation_id, entry.access_projection);
      }
    }
  }
  return requirements;
}

/** 从 READ1 结构化结果提取完整重核依赖（citable_source + recheck_dependencies，只增不覆盖） */
function extractReadDependencies(
  tool: string,
  outcome: Awaited<ReturnType<YayaAgentDependencies['readTool']>>,
): YayaRunDependency[] {
  if (!outcome.ok) return [];
  const data = outcome.data;
  const record = payloadRecord(data);
  const requirements = projectionRequirements(data);
  const candidates: unknown[] = [];
  if (Array.isArray(record.recheck_dependencies)) candidates.push(...record.recheck_dependencies);
  else candidates.push(outcome.source);
  if (isSourceRef(record.citable_source)) candidates.push(record.citable_source);
  const dependencies: YayaRunDependency[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isSourceRef(candidate)) continue;
    const key = `${candidate.kind}\u0000${candidate.ref_id ?? ''}\u0000${candidate.derived_from ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const projection =
      candidate.ref_id !== null && candidate.ref_id.startsWith('observation:')
        ? (requirements.get(candidate.ref_id) ?? 'any')
        : 'any';
    dependencies.push({
      ref: candidate,
      tool,
      image_id: null,
      message_id: null,
      fragment_id: null,
      projection,
    });
  }
  return dependencies;
}

/** TOOLS1 集成接口：写工具目录 + 只准备提案端口（同一 run 持久化/依赖钩子） */
export interface YayaRunWriteBinding {
  write_tools: YayaToolCatalog['write_tools'];
  proposeWrite: YayaAgentDependencies['proposeWrite'];
}

export interface YayaRunDependencyOptions {
  readRegistry?: YayaReadRegistry;
  write?: YayaRunWriteBinding;
}

const failClosedProposeWrite = async (): Promise<YayaProposeWriteOutcome> => ({
  ok: false,
  code: 'unsupported',
  message: '写入工具装配（TOOLS1）尚未交付，已拒绝准备提案。',
});

export function createYayaRunDependencies(
  state: YayaRunRuntimeState,
  options: YayaRunDependencyOptions = {},
): YayaAgentDependencies {
  const readRegistry = options.readRegistry ?? createYayaReadRegistry();
  const write = options.write;
  return {
    model: createLlmYayaModelGateway(),
    resolveCurrentIdentity: ({ run_id }) =>
      resolveYayaRunCurrentIdentity({ runId: run_id, token: state.token }),
    loadProjectedContext: (input) => loadYayaRunProjectedContext(state, input.identity.principal),
    revalidateProjectedContext: (input) =>
      revalidateYayaRunContext(state, input, { principal: input.identity.principal }),
    readTool: async (input) => {
      const outcome = await readRegistry.dispatch(
        { tool: input.tool, params: input.params },
        { request: state.carrier },
      );
      // 来源回报已登记完再进入引擎；依赖持久化失败由重核保守停止。
      await absorbYayaRunDependencies(state, extractReadDependencies(input.tool, outcome));
      return outcome;
    },
    proposeWrite: write?.proposeWrite ?? failClosedProposeWrite,
    queryOperation: async (input) => {
      if (input.identity.principal === null) {
        return { kind: 'unknown', reason: 'identity_mismatch' };
      }
      const accountId = input.identity.principal.account_id;
      if (input.operation.actor_account_id !== accountId) {
        return { kind: 'unknown', reason: 'identity_mismatch' };
      }
      return withPrivateRead(state.carrier, async ({ client, principal }) => {
        if (principal.account_id !== accountId) {
          return { kind: 'unknown' as const, reason: 'identity_mismatch' as const };
        }
        const view = await yayaDataRepository.queryOperation(
          client,
          principal.account_id,
          input.operation.operation_id,
        );
        return view?.outcome ?? { kind: 'unknown' as const, reason: 'no_receipt' as const };
      });
    },
    publicSearchPolicy: {
      provider_enabled: false,
      scanChildIdentifiers: async () => 'unknown',
    },
    tools: {
      read_tools: readRegistry.definitions,
      write_tools: write?.write_tools ?? [],
    },
  };
}
