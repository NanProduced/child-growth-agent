/**
 * TOOLS1 写工具共享类型：参数校验 → 当前授权 → 提案 → 教师批准 → 同事务业务执行 → 原操作回执。
 *
 * 纪律：
 * - 每个写工具的参数校验与模型可见 JSON Schema 同源（复用引擎既有 zodToolParams）；
 * - prepare 只产生准备态提案（预分配 proposal/batch/operation 身份），不构成业务写；
 * - compute 是事务外的模型/依据计算（整理、复核、摘要、支持、指南建议），
 *   返回后重核原 session/归属/版本/依据集，再短事务保存；
 * - execute 必须在 `executeApprovedOperations` 的同一个 TransactionClient 内执行，
 *   不另开连接、不自行提交；模型调用不得进入事务；
 * - 密码不进参数、payload、事件或日志；教师创建/重置只经现有安全控件入口。
 */
import type { HeaderCarrier } from '@/lib/accounts/guards';
import type { AccessAction, AccessResourceKind, Principal } from '@/lib/accounts/types';
import type { invokeLlm } from '@/lib/llm';
import type { MediaObjectStore } from '@/lib/media/object-store';
import type { TransactionClient } from '@/storage/database/pg-client';

import type { YayaReadToolDefinition, YayaReadToolInput, YayaReadToolOutcome, YayaWriteToolDefinition } from '../../agent/types';
import type {
  YayaAttachmentAssociation,
  YayaDomainPayload,
  YayaOperationReceipt,
  YayaProposalItem,
} from '../../types';
import type {
  YayaBusinessWriteResult,
  YayaExecutionItemContext,
  YayaItemResourceRef,
  YayaPreparedProposalView,
} from '../../storage-types';

/** prepare 上下文：调用方已开启短事务并传入同一个 client */
export interface YayaWritePrepareContext {
  client: TransactionClient;
  principal: Principal;
  school_id: string;
}

/** prepare 的服务端解析结果：目标/资源引用/版本/附件关联全部由服务端读取生成 */
export interface YayaWritePreparedItem {
  item_key: string;
  target_id: string;
  action: AccessAction;
  resource: AccessResourceKind;
  resource_ref: YayaItemResourceRef;
  payload: YayaDomainPayload;
  attachment_associations: readonly YayaAttachmentAssociation[];
  business_revision: string | null;
}

/**
 * load 上下文：在读事务（withBusinessRead → withReadClient）内按当前授权读取
 * compute 所需的业务快照；读事务在模型调用前关闭，模型等待不持事务/行锁。
 */
export interface YayaWriteLoadInput {
  request: HeaderCarrier;
  principal: Principal;
  proposal_item: YayaProposalItem;
  payload: YayaDomainPayload;
}

/**
 * compute 上下文：**任何数据库事务之外**运行（模型/依据计算）；
 * 一切读取已在 load 阶段完成或由 loaded 提供，compute 不得再访问数据库。
 */
export interface YayaWriteComputeInput {
  request: HeaderCarrier;
  principal: Principal;
  proposal_item: YayaProposalItem;
  payload: YayaDomainPayload;
  /** load 阶段返回的快照（未声明 load 时为 null） */
  loaded: unknown;
  /** 模型替身注入点；缺省使用真实 invokeLlm */
  invoke?: typeof invokeLlm;
}

export type YayaWriteComputeResult =
  | { kind: 'proceed'; data: unknown }
  | {
      kind: 'needs_prepare';
      message: string;
      notice?: Readonly<Record<string, unknown>>;
      /**
       * 准备态写入（如教师修改复核结果）：在批准不被消费的前提下，
       * 经现有业务写守门（runBusinessWrite）在同一观察上原子保存。
       */
      prepare_write?: () => Promise<void>;
    };

/** execute 上下文：批准已消费判定通过后，在同一 TransactionClient 内落业务 */
export interface YayaWriteExecuteInput {
  client: TransactionClient;
  principal: Principal;
  school_id: string;
  approval_id: string;
  submission: YayaExecutionItemContext;
  payload: YayaDomainPayload;
  computed: unknown;
  request_id: string | null;
  /** 媒体对象存储（创建/追加附图只使用绑定到 client 的元数据端口；本字段供注入替身） */
  store: MediaObjectStore;
}

export interface YayaWriteToolEntry {
  definition: YayaWriteToolDefinition;
  /** 参数已通过 definition.params 校验后进入；返回服务端权威 prepare 结果 */
  prepare(input: { params: unknown; context: YayaWritePrepareContext }): Promise<YayaWritePreparedItem>;
  /** 短读事务内的业务快照读取（当前授权已核验）；不存在表示 compute 无需读取 */
  load?(input: YayaWriteLoadInput): Promise<unknown>;
  /** 事务外计算；不存在表示无需模型/依据预计算 */
  compute?(input: YayaWriteComputeInput): Promise<YayaWriteComputeResult>;
  /** 同 client 业务执行；抛错即整单回滚（批准不消费、无部分写入） */
  execute(input: YayaWriteExecuteInput): Promise<YayaBusinessWriteResult>;
  /** 批准快照 business_revision 非 null 时的当前版本解析（同 client） */
  resolveBusinessRevision?(
    client: TransactionClient,
    context: YayaExecutionItemContext,
  ): Promise<string | null>;
}

export interface YayaWriteRegistry {
  readonly entries: readonly YayaWriteToolEntry[];
  readonly definitions: readonly YayaWriteToolDefinition[];
  find(tool: string): YayaWriteToolEntry | undefined;
}

/** 准备态不等于业务已保存：结果显式区分提案身份与业务回执 */
export interface YayaPreparedWrite {
  proposal: YayaPreparedProposalView;
}

/**
 * 最小工具工厂：三个字段与 `YayaAgentDependencies` 对应字段同签名，
 * 不维护第二套协议；读取直接复用 READ1 注册表。
 */
export interface YayaToolkit {
  tools: {
    read_tools: readonly YayaReadToolDefinition[];
    write_tools: readonly YayaWriteToolDefinition[];
  };
  readTool(input: YayaReadToolInput): Promise<YayaReadToolOutcome>;
  proposeWrite(
    input: import('../../agent/types').YayaProposeWriteInput,
  ): Promise<import('../../agent/types').YayaProposeWriteOutcome>;
}

export type YayaOperationsExecutionResult =
  | { kind: 'receipts'; receipts: readonly YayaOperationReceipt[] }
  | {
      kind: 'needs_prepare';
      operation_id: string;
      message: string;
      notice: Readonly<Record<string, unknown>> | null;
    };
