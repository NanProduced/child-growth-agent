/**
 * 芽芽 v1 真实只读工具（TOOLS-READ1）共享类型。
 *
 * 本模块只封装现有平台**读取**能力，不新增业务表、不执行写入、不调用模型：
 * - 每个工具的参数校验与模型可见 JSON Schema 由同一 Zod schema 导出（zodToolParams）；
 * - 业务范围读取全部复用现有服务端身份与 scoped 读取边界（withScopedRead /
 *   withBusinessRead / 现有 scoped 查询），不缓存 Principal，不接受调用方自报身份；
 * - 静态教育参考（指南目录/条目/教育建议）按 authenticated_reference 边界，
 *   仅要求登录且账号有效，未分配任教也可以读取；空任教绝不等于全园；
 * - 结果以结构化 payload 返回，并携带具体业务来源依赖（source_refs），供 APP 侧
 *   按当前授权逐项重核；聚合结果不因一个泛泛 tool_result 标签丢失底层依赖。
 */
import type { HeaderCarrier } from '@/lib/accounts/guards';
import type { ScopedObservation } from '@/lib/accounts/scoped-queries';
import type { Principal, TeacherAccountSummary } from '@/lib/accounts/types';
import type { ClassContextLookup, ClassHistoryCounts } from '@/lib/class-context';
import type { EvidenceFiltersInput, EvidenceLoadResult } from '@/lib/guide/read-model';
import type { ClassEvidenceOverview, ChildEvidenceBook } from '@/lib/guide/view-types';
import type { EvidenceScopeQuery } from '@/lib/semester';
import type {
  ActivitySupport,
  Child,
  GrowthProfile,
  ObservationStatus,
  SchoolClass,
} from '@/lib/types';

import type { YayaReadToolDefinition, YayaReadToolInput, YayaReadToolOutcome } from '../../agent/types';
import type { YayaSourceRef, YayaToolAuth, YayaToolScopePolicy } from '../../types';

/** 执行上下文：request 缺省时各读取入口回退到 Next 服务端 headers（生产路径） */
export interface YayaReadToolContext {
  request?: HeaderCarrier;
}

export interface YayaClassBundle {
  klass: SchoolClass;
  children: Child[];
  history: ClassHistoryCounts;
}

export interface YayaChildClassContext {
  child: Child;
  lookup: ClassContextLookup;
}

export interface YayaChildProfileRecord {
  child: Child;
  growth_profile: GrowthProfile | null;
  activity_support: ActivitySupport | null;
}

export interface YayaObservationFilters {
  childId?: string;
  status?: ObservationStatus;
  limit?: number;
  from?: string;
  to?: string;
}

/**
 * 数据与授权边界端口：默认实现（ports.ts）直接复用现有 AUTH/scoped 读取服务；
 * 测试可用替身注入。端口只返回真实服务结果或抛出 AccountsError，
 * 不允许返回 0/空列表来伪装失败。
 */
export interface YayaReadPorts {
  listChildren(request?: HeaderCarrier): Promise<Child[]>;
  listClasses(input: { catalog: boolean }, request?: HeaderCarrier): Promise<SchoolClass[]>;
  getClassBundle(classId: string, request?: HeaderCarrier): Promise<YayaClassBundle | null>;
  resolveChildClass(
    input: { childId: string; observedAt: string },
    request?: HeaderCarrier,
  ): Promise<YayaChildClassContext | null>;
  listObservations(
    filters: YayaObservationFilters,
    request?: HeaderCarrier,
  ): Promise<ScopedObservation[]>;
  getObservation(observationId: string, request?: HeaderCarrier): Promise<ScopedObservation | null>;
  getChildProfile(childId: string, request?: HeaderCarrier): Promise<YayaChildProfileRecord | null>;
  loadChildEvidenceBook(
    childId: string,
    query: EvidenceScopeQuery & EvidenceFiltersInput,
    request?: HeaderCarrier,
  ): Promise<EvidenceLoadResult<ChildEvidenceBook>>;
  loadClassEvidenceOverview(
    classId: string,
    query: EvidenceScopeQuery & EvidenceFiltersInput,
    request?: HeaderCarrier,
  ): Promise<EvidenceLoadResult<ClassEvidenceOverview>>;
  listTeacherAccounts(request?: HeaderCarrier): Promise<TeacherAccountSummary[]>;
  /** authenticated_reference 身份边界：登录且账号有效即可（空任教允许）；失败必须抛出，不返回空目录 */
  requireReferenceAccess(request?: HeaderCarrier): Promise<Principal>;
}

/**
 * 工具结构化结果（R1 来源协议）：
 * - `citable_source`：唯一可引用来源，ref_id 非空、稳定、无隐私；与
 *   `YayaReadToolOutcome.source` 相同，是引擎登记进 knownSources 的唯一 id。
 *   列表/目录/管理员列表也有自己的稳定主来源（如 `children:current_scope`），
 *   模型引用它不会落空；底层对象 ID 不冒充可引用来源。
 * - `recheck_dependencies`：结果依赖的全部业务对象（含 citable_source，去重），
 *   仅供 APP 按当前授权逐项重核；不是模型可引用来源，模型引用其中未被引擎登记的
 *   ID 会被 source_mismatch 保守拦截。
 * 两者都不是权限来源，也不能由模型引用决定权限。
 */
export interface YayaReadPayload<T> {
  tool: string;
  scope_policy: YayaToolScopePolicy;
  citable_source: YayaSourceRef;
  recheck_dependencies: readonly YayaSourceRef[];
  data: T;
}

export interface YayaReadToolRegistration {
  definition: YayaReadToolDefinition;
  /** 授权依赖：scope_query 或复用 AUTH 的动作/资源组合（本表不是权限来源） */
  auth: YayaToolAuth;
}

export interface YayaReadRegistry {
  registrations: readonly YayaReadToolRegistration[];
  definitions: readonly YayaReadToolDefinition[];
  /** 独立可运行的只读 dispatcher：白名单 → 同源参数校验 → 现有授权链读取 → 结构化来源 */
  dispatch(
    input: { tool: string; params: unknown },
    context?: YayaReadToolContext,
  ): Promise<YayaReadToolOutcome>;
  /** 与 YayaAgentDependencies['readTool'] 同签名的适配；identity 只作运行上下文，不参与授权判定 */
  readTool(input: YayaReadToolInput): Promise<YayaReadToolOutcome>;
}
