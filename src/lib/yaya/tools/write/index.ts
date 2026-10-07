/**
 * TOOLS1 对外工厂：写工具 registry + 准备/执行适配 + 最小工具工厂。
 *
 * 消费方式（AGENT-APP1 / operations 路由）：
 *   const toolkit = createYayaToolkit({ resolveConversationId, verifyRun });
 *   toolkit.tools                      // read_tools（READ1）+ write_tools（本模块）
 *   toolkit.readTool                   // 直接接入 YayaAgentDependencies
 *   toolkit.proposeWrite               // 直接接入 YayaAgentDependencies
 *   await toolkit.executeOperations(request, body); // operations POST
 *
 * 不重新实现 READ1 的读取：read_tools/readTool 直接来自 createYayaReadRegistry()。
 */
import type { HeaderCarrier } from '@/lib/accounts/guards';
import { serverRequest } from '@/lib/accounts/access';
import { AccountsError } from '@/lib/accounts/errors';
import type { Principal } from '@/lib/accounts/types';
import type { invokeLlm } from '@/lib/llm';
import type { MediaObjectStore } from '@/lib/media/object-store';
import { withReadClient, type TransactionClient } from '@/storage/database/pg-client';

import { prepareProposal, withPrivateWrite } from '../../data';
import { YayaDataError } from '../../storage-types';
import type { YayaOperationProposal, YayaProposalItem } from '../../types';
import type {
  YayaProposeWriteFailureCode,
  YayaProposeWriteInput,
  YayaProposeWriteOutcome,
} from '../../agent/types';
import { createYayaReadRegistry, type YayaReadPorts, type YayaReadRegistry } from '../read/index';
import { createYayaOperationsExecutor, type YayaOperationsExecutor } from './execute';
import { createYayaWriteRegistry, toPrepareItemInput, YayaWriteProposeError } from './registry';
import type {
  YayaOperationsExecutionResult,
  YayaToolkit,
  YayaWriteRegistry,
} from './types';

export { createYayaWriteRegistry } from './registry';
export { createYayaOperationsExecutor, type YayaOperationsExecutor } from './execute';
export {
  projectTeacherSecureControlIntent,
  YayaSecureControlError,
  type YayaTeacherSecureControlRequest,
} from './secure-control';
export type {
  YayaOperationsExecutionResult,
  YayaToolkit,
  YayaWriteComputeInput,
  YayaWriteComputeResult,
  YayaWriteExecuteInput,
  YayaWritePreparedItem,
  YayaWritePrepareContext,
  YayaWriteRegistry,
  YayaWriteToolEntry,
} from './types';

export interface YayaToolkitOptions {
  /** 读取端口注入（测试替身）；缺省使用真实 READ1 端口 */
  readPorts?: YayaReadPorts;
  /** 请求载体；缺省回退 Next 服务端 headers（生产路径） */
  request?: HeaderCarrier | (() => Promise<HeaderCarrier>);
  /** run → conversation 绑定（AGENT-APP1 的 run 持久化提供）；缺省准备步骤 fail closed */
  resolveConversationId?: (runId: string) => Promise<string | null>;
  /** 准备事务内的服务端 run 有效性核验（使用同一 client；不信任客户端 run 状态） */
  verifyRun?: (input: {
    client: TransactionClient;
    run_id: string;
    principal: Principal;
    school_id: string;
  }) => Promise<void>;
  /** 模型替身注入点；缺省使用真实 invokeLlm */
  invoke?: typeof invokeLlm;
  /** 媒体对象存储替身；创建/追加附图只使用绑定 client 的元数据端口 */
  mediaStore?: MediaObjectStore;
}

export interface YayaToolkitRuntime {
  toolkit: YayaToolkit;
  readRegistry: YayaReadRegistry;
  writeRegistry: YayaWriteRegistry;
  executor: YayaOperationsExecutor;
  executeOperations(request: HeaderCarrier, body: unknown): Promise<YayaOperationsExecutionResult>;
}

function proposeFailure(
  code: YayaProposeWriteFailureCode,
  message: string,
): YayaProposeWriteOutcome {
  return { ok: false, code, message };
}

function mapProposeError(error: unknown): YayaProposeWriteOutcome {
  if (error instanceof YayaWriteProposeError) return proposeFailure(error.code, error.message);
  if (error instanceof AccountsError) {
    switch (error.code) {
      case 'unauthenticated':
        return proposeFailure('unauthenticated', error.message);
      case 'identity_unavailable':
        return proposeFailure('identity_unavailable', error.message);
      case 'forbidden_role':
        return proposeFailure('forbidden_role', error.message);
      case 'out_of_scope':
        return proposeFailure('out_of_scope', error.message);
      case 'empty_scope':
        return proposeFailure('empty_scope', error.message);
      case 'invalid_request':
        return proposeFailure('invalid_params', error.message);
      case 'csrf_rejected':
      case 'state_conflict':
        return proposeFailure('failed', error.message);
      default:
        return proposeFailure('denied', error.message);
    }
  }
  if (error instanceof YayaDataError) {
    return proposeFailure(
      error.code === 'invalid_request' ? 'invalid_params' : 'failed',
      error.message,
    );
  }
  return proposeFailure('failed', '准备提案失败，请稍后重试。');
}

function toOperationProposal(prepared: {
  proposal_id: string;
  batch_id: string;
  proposal_origin: 'teacher_card' | 'model_suggestion';
  auth: YayaOperationProposal['auth'];
  prepared_at: string;
  items: readonly {
    item_key: string;
    target_id: string;
    content_digest: string;
    attachment_associations: YayaProposalItem['attachment_associations'];
    payload: YayaProposalItem['payload'];
  }[];
}): YayaOperationProposal {
  return {
    proposal_id: prepared.proposal_id,
    batch_id: prepared.batch_id,
    proposal_origin: prepared.proposal_origin,
    auth: prepared.auth,
    items: prepared.items.map((item) => ({
      item_key: item.item_key,
      target_id: item.target_id,
      content_digest: item.content_digest,
      attachment_associations: item.attachment_associations,
      payload: item.payload,
    })),
    prepared_at: prepared.prepared_at,
  };
}

export function createYayaToolkit(options: YayaToolkitOptions = {}): YayaToolkitRuntime {
  const readRegistry = createYayaReadRegistry(
    options.readPorts ? { ports: options.readPorts } : undefined,
  );
  const writeRegistry = createYayaWriteRegistry();
  const executor = createYayaOperationsExecutor({
    registry: writeRegistry,
    media_store: options.mediaStore,
    invoke: options.invoke,
  });

  const resolveRequest = async (): Promise<HeaderCarrier> => {
    if (!options.request) return serverRequest();
    return typeof options.request === 'function' ? options.request() : options.request;
  };

  const proposeWrite = async (input: YayaProposeWriteInput): Promise<YayaProposeWriteOutcome> => {
    if (input.proposal_origin !== 'model_suggestion') {
      return proposeFailure('unsupported', '写工具只接受模型提案来源标记。');
    }
    const identity = input.identity;
    if (identity.identity_state === 'unavailable') {
      return proposeFailure('identity_unavailable', '身份服务暂时不可用，请稍后重试。');
    }
    if (identity.identity_state !== 'authenticated' || identity.principal === null) {
      return proposeFailure('unauthenticated', '请先登录园所账号。');
    }
    if (!identity.session_valid) {
      return proposeFailure('unauthenticated', '登录状态已失效，请重新登录。');
    }
    if (identity.principal.account_status !== 'active') {
      return proposeFailure('denied', '账号已停用。');
    }
    const entry = writeRegistry.find(input.tool);
    if (!entry) return proposeFailure('unsupported', `未注册的写工具：${input.tool}`);
    const validated = entry.definition.params.validate(input.params);
    if (!validated.ok) return proposeFailure('invalid_params', `${input.tool}: ${validated.error}`);
    if (!options.resolveConversationId) {
      return proposeFailure('failed', '运行未绑定会话，无法准备提案。');
    }
    const conversationId = await options.resolveConversationId(input.run_id);
    if (!conversationId) return proposeFailure('failed', '运行未绑定会话，无法准备提案。');
    try {
      const request = await resolveRequest();
      const prepared = await withPrivateWrite(request, async (context) => {
        if (options.verifyRun) {
          await options.verifyRun({
            client: context.client,
            run_id: input.run_id,
            principal: context.principal,
            school_id: context.schoolId,
          });
        }
        return withReadClient(context.client, async () => {
          const item = await entry.prepare({
            params: validated.params,
            context: {
              client: context.client,
              principal: context.principal,
              school_id: context.schoolId,
            },
          });
          return prepareProposal(context.client, {
            conversation_id: conversationId,
            proposal_origin: 'model_suggestion',
            auth: entry.definition.auth,
            items: [toPrepareItemInput(item)],
            owner_account_id: context.principal.account_id,
          });
        });
      });
      return { ok: true, proposals: [toOperationProposal(prepared)] };
    } catch (error) {
      return mapProposeError(error);
    }
  };

  return {
    toolkit: {
      tools: {
        read_tools: readRegistry.definitions,
        write_tools: writeRegistry.definitions,
      },
      readTool: readRegistry.readTool,
      proposeWrite,
    },
    readRegistry,
    writeRegistry,
    executor,
    executeOperations: (request, body) => executor.execute(request, body),
  };
}

export type { YayaReadRegistry };
