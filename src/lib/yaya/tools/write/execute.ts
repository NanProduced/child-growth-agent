/**
 * TOOLS1 operations POST 执行适配（`/api/yaya/operations`）。
 *
 * 流程：
 * 1. `parseYayaOperationsExecuteRequest` 只取 approval_id/operation_ids（自报批准/身份被净身拒绝）；
 * 2. 私有读预检：owner 绑定、批准匹配、取回服务端已存 payload（客户端不能自报内容）；
 * 3. 事务外 compute：模型/依据计算与当前授权读取（withBusinessRead 读事务，不消费批准）；
 *    `needs_prepare` 停在准备态（可选准备态写入经 runBusinessWrite），不消耗批准；
 * 4. 同一 `withPrivateWrite` 事务内：DATA `executeApprovedOperations` 消费批准 +
 *    业务 callback + 回执，全部使用同一个 TransactionClient；
 * 5. 重复执行只返回原回执；未知/执行中由 DATA 语义拒绝，客户端按原 operation_id 查询。
 */
import type { HeaderCarrier } from '@/lib/accounts/guards';
import { withBusinessRead, type ResourceRef } from '@/lib/accounts/access';
import { AccountsError } from '@/lib/accounts/errors';
import { runBusinessWrite } from '@/lib/auth';
import { ObservationStateConflictError, StaleEvidenceError } from '@/lib/evidence-snapshot';
import {
  GuideEvidenceBasisExpiredError,
  GuideEvidenceCatalogError,
  GuideEvidenceConflictError,
  GuideEvidenceInvalidError,
  GuideEvidenceNotFoundError,
} from '@/lib/guide/decisions';
import { MediaError } from '@/lib/media/errors';
import type { MediaObjectStore } from '@/lib/media/object-store';
import { ClassHistoryProtectedError, ObservationContextConflictError } from '@/lib/queries';
import type { invokeLlm } from '@/lib/llm';
import { withReadClient } from '@/storage/database/pg-client';

import { parseYayaOperationsExecuteRequest } from '../../api-contract';
import { yayaDataRepository, withPrivateRead, withPrivateWrite } from '../../data';
import { YAYA_MAX_BATCH_ITEMS, YayaDataError, type YayaPreparedItemView } from '../../storage-types';
import type { YayaPlannedOperation } from '../../types';
import { createUnavailableMediaStore } from './registry';
import type {
  YayaOperationsExecutionResult,
  YayaWriteComputeResult,
  YayaWriteRegistry,
  YayaWriteToolEntry,
} from './types';

interface LoadedOperation {
  planned: YayaPlannedOperation;
  item: YayaPreparedItemView;
  entry: YayaWriteToolEntry;
  proposal_id: string;
  has_receipt: boolean;
  started: boolean;
}

export interface YayaOperationsExecutor {
  execute(request: HeaderCarrier, body: unknown): Promise<YayaOperationsExecutionResult>;
}

function toAuthResourceRef(item: YayaPreparedItemView): ResourceRef {
  const ref = item.resource_ref;
  switch (ref.kind) {
    case 'school':
      return { kind: 'school' };
    case 'class':
      return ref.class_id === null ? { kind: 'class' } : { kind: 'class', class_id: ref.class_id };
    case 'child':
      return { kind: 'child', child_id: ref.child_id };
    case 'transfer':
      return { kind: 'transfer', child_id: ref.child_id, target_class_id: ref.target_class_id };
    case 'observation':
      return { kind: 'observation', observation_id: ref.observation_id };
  }
}

function mapMediaFailure(error: MediaError): YayaDataError {
  switch (error.code) {
    case 'observation_not_confirmed':
      return new YayaDataError('observation_not_confirmed', error.message);
    case 'source_conflict':
      return new YayaDataError('source_conflict', error.message);
    case 'revision_conflict':
      return new YayaDataError('revision_conflict', error.message);
    case 'attachment_not_found':
      return new YayaDataError('attachment_missing', error.message);
    case 'attachment_referenced':
      return new YayaDataError('attachment_referenced', error.message);
    case 'reference_query_incomplete':
      return new YayaDataError('reference_incomplete', error.message);
    case 'invalid_request':
    case 'too_many_images':
      return new YayaDataError('invalid_request', error.message);
    case 'not_owner':
    case 'forbidden':
    case 'metadata_only':
    case 'attachment_gone':
    case 'attachment_deleting':
    case 'attachment_conflict':
    case 'idempotency_conflict':
      return new YayaDataError('attachment_conflict', error.message);
    default:
      return new YayaDataError('server_error', '媒体/附件服务暂时不可用，请稍后重试。');
  }
}

/** 业务领域错误 → 冻结 DATA 错误体（同一事务回滚前完成映射） */
export function mapBusinessFailure(error: unknown): never {
  if (error instanceof YayaDataError) throw error;
  if (error instanceof AccountsError) throw error;
  if (error instanceof MediaError) {
    throw mapMediaFailure(error);
  }
  if (error instanceof ObservationStateConflictError) {
    throw new YayaDataError('approval_invalid', error.message, { reasons: ['content_changed'] });
  }
  if (error instanceof ObservationContextConflictError) {
    throw new YayaDataError('approval_invalid', error.message, { reasons: ['attribution_changed'] });
  }
  if (error instanceof StaleEvidenceError) {
    throw new YayaDataError('approval_invalid', error.message, { reasons: ['business_version_changed'] });
  }
  if (
    error instanceof GuideEvidenceConflictError ||
    error instanceof GuideEvidenceBasisExpiredError ||
    error instanceof GuideEvidenceCatalogError
  ) {
    throw new YayaDataError('approval_invalid', error.message);
  }
  if (error instanceof GuideEvidenceInvalidError) {
    throw new YayaDataError('invalid_request', error.message);
  }
  if (error instanceof GuideEvidenceNotFoundError) {
    throw new YayaDataError('not_found', error.message);
  }
  if (error instanceof ClassHistoryProtectedError) {
    throw new YayaDataError('source_conflict', error.message);
  }
  throw error;
}

export function createYayaOperationsExecutor(options: {
  registry: YayaWriteRegistry;
  media_store?: MediaObjectStore;
  invoke?: typeof invokeLlm;
}): YayaOperationsExecutor {
  const store = options.media_store ?? createUnavailableMediaStore();

  async function loadOperations(
    request: HeaderCarrier,
    parsed: { approval_id: string; operation_ids: readonly string[] },
  ): Promise<{ loaded: LoadedOperation[]; approvalId: string }> {
    if (parsed.operation_ids.length > YAYA_MAX_BATCH_ITEMS) {
      throw new YayaDataError('invalid_request', '一次执行的操作数量超出上限。');
    }
    return withPrivateRead(request, async ({ client, principal }): Promise<{ loaded: LoadedOperation[]; approvalId: string; principal: typeof principal }> => {
      const loaded: LoadedOperation[] = [];
      for (const operationId of parsed.operation_ids) {
        const view = await yayaDataRepository.queryOperation(client, principal.account_id, operationId);
        if (!view) throw new YayaDataError('operation_not_found', '操作不存在。');
        const proposal = await yayaDataRepository.getProposal(
          client,
          principal.account_id,
          view.planned.proposal_id,
        );
        if (!proposal) throw new YayaDataError('operation_not_found', '提案不存在。');
        const item = proposal.items.find(
          (entry) => entry.operation_id === operationId && entry.item_key === view.planned.item_key,
        );
        if (!item) throw new YayaDataError('operation_unknown', '操作条目不完整，无法按原身份执行。');
        const entry = options.registry.find(item.payload.kind);
        if (!entry) {
          throw new YayaDataError('invalid_request', `未注册的写操作：${item.payload.kind}`);
        }
        loaded.push({
          planned: view.planned,
          item,
          entry,
          proposal_id: proposal.proposal_id,
          has_receipt:
            view.outcome.kind === 'saved' || view.outcome.kind === 'saved_detail_unavailable',
          started: view.started,
        });
      }
      const proposalIds = new Set(loaded.map((entry) => entry.proposal_id));
      if (proposalIds.size !== 1) {
        throw new YayaDataError('invalid_request', '一次执行只能属于同一提案。');
      }
      const proposalId = [...proposalIds][0];
      const approval = await yayaDataRepository.getApproval(client, principal.account_id, proposalId);
      if (!approval || approval.approval_id !== parsed.approval_id) {
        throw new YayaDataError('approval_invalid', '批准记录不存在或已被新的批准取代。');
      }
      const bound = new Set(approval.items.map((entry) => entry.operation_id));
      for (const entry of loaded) {
        if (!bound.has(entry.planned.operation_id)) {
          throw new YayaDataError('approval_invalid', '批准未绑定所选操作。');
        }
      }
      return { loaded, approvalId: approval.approval_id, principal };
    });
  }

  async function execute(
    request: HeaderCarrier,
    body: unknown,
  ): Promise<YayaOperationsExecutionResult> {
    const parsed = parseYayaOperationsExecuteRequest(body);
    if (!parsed.ok) {
      throw new YayaDataError('invalid_request', '执行请求不合法。', {
        reasons: parsed.violations.map((violation) => violation.code),
      });
    }
    const parsedRequest = parsed.value;
    const { loaded, approvalId } = await loadOperations(request, parsedRequest);

    // 模型等待不持事务/行锁：先在短读事务内按当前授权读取快照，随后在事务外计算；
    // 已完成或已开始的操作跳过，保证重复执行零副作用。
    const computedByOperation = new Map<string, unknown>();
    for (const operation of loaded) {
      if (operation.has_receipt || operation.started) continue;
      if (!operation.entry.load && !operation.entry.compute) continue;
      const ref = toAuthResourceRef(operation.item);
      const auth = await withBusinessRead(request, operation.item.action, ref, async (readPrincipal) => {
        if (!operation.entry.load) {
          return { principal: readPrincipal, loaded: null as unknown };
        }
        const loadedData = await operation.entry.load({
          request,
          principal: readPrincipal,
          proposal_item: operation.item,
          payload: operation.item.payload,
        });
        return { principal: readPrincipal, loaded: loadedData };
      });
      if (!operation.entry.compute) continue;
      let computed: YayaWriteComputeResult;
      try {
        computed = await operation.entry.compute({
          request,
          principal: auth.principal,
          proposal_item: operation.item,
          payload: operation.item.payload,
          loaded: auth.loaded,
          invoke: options.invoke,
        });
      } catch (error) {
        // 依据集在模型等待期间变化等业务冲突统一映射为冻结错误体（不消费批准、不落账）
        mapBusinessFailure(error);
      }
      if (computed.kind === 'needs_prepare') {
        if (computed.prepare_write) {
          try {
            await runBusinessWrite(request, operation.item.action, ref, computed.prepare_write);
          } catch (error) {
            mapBusinessFailure(error);
          }
        }
        return {
          kind: 'needs_prepare',
          operation_id: operation.planned.operation_id,
          message: computed.message,
          notice: computed.notice ?? null,
        };
      }
      computedByOperation.set(operation.planned.operation_id, computed.data);
    }

    const requestId = request.headers.get('x-request-id');
    const receipts = await withPrivateWrite(request, async (context) =>
      withReadClient(context.client, () =>
        yayaDataRepository.executeApprovedOperations(context.client, {
          approval_id: approvalId,
          operation_ids: parsedRequest.operation_ids,
          school_id: context.schoolId,
          submitter: {
            identity_state: 'authenticated',
            principal: context.principal,
            session_id: context.sessionId,
            session_valid: true,
            csrf_verified: true,
            runtime_approved_state: false,
            execution_at: new Date().toISOString(),
          },
          resolveBusinessRevision: async (executionContext) => {
            const entry = options.registry.find(executionContext.proposal_item.payload.kind);
            if (!entry?.resolveBusinessRevision) return null;
            return entry.resolveBusinessRevision(context.client, executionContext);
          },
          callback: async (client, executionContext) => {
            const entry = options.registry.find(executionContext.proposal_item.payload.kind);
            if (!entry) throw new YayaDataError('invalid_request', '未注册的写操作。');
            try {
              return await entry.execute({
                client,
                principal: context.principal,
                school_id: context.schoolId,
                approval_id: approvalId,
                submission: executionContext,
                payload: executionContext.proposal_item.payload,
                computed: computedByOperation.get(executionContext.operation.operation_id) ?? null,
                request_id: requestId,
                store,
              });
            } catch (error) {
              mapBusinessFailure(error);
            }
          },
        }),
      ),
    );
    return { kind: 'receipts', receipts };
  }

  return { execute };
}
