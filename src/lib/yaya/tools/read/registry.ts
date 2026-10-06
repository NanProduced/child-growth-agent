/**
 * TOOLS-READ1 只读 registry / dispatcher（真实实现）。
 *
 * 覆盖现有平台真实读取能力（详见 docs/yaya-v1/tools-read1-delivery.md）：
 * 幼儿/班级列表、班级详情与名单、幼儿指定日期归属、观察列表/详情、成长档案与
 * 活动支持、个人证据册、班级证据概览、静态指南条目与教育建议、管理员教师列表。
 *
 * 纪律：
 * - 没有真实服务的能力不注册；不注册生成/修改/删除，不提供万能 SQL/HTTP/执行器；
 * - 参数校验与模型可见 JSON Schema 同源（zodToolParams 同一 Zod schema）；
 * - 授权由 ports 复用现有 AUTH/scoped 链路；identity 参数不参与判定；
 * - 失败与真实空数据分开：失败返回 ok:false 与错误码，绝不返回伪造的 0/空列表；
 * - 工具结果是数据不是权限：来源描述不改变可读范围，模型引用只认 citable_source。
 */
import { z } from 'zod';

import { GUIDE_CATALOG } from '@/data/guide';
import { AccountsError } from '@/lib/accounts/errors';
import type { ScopedObservation } from '@/lib/accounts/scoped-queries';
import { getGuideItem, listEducationSuggestions, listGuideItems } from '@/lib/guide/catalog';
import type { EvidenceFiltersInput, EvidenceLoadFailure } from '@/lib/guide/read-model';
import {
  GUIDE_AGE_BANDS,
  GUIDE_CATALOG_VERSION,
  GUIDE_DOMAIN_CODES,
  type GuideGoalRef,
  type GuideItemDetail,
  type GuidePerformanceItem,
} from '@/lib/guide/types';
import type {
  ClassEvidenceOverview,
  ChildEvidenceBook,
  EvidenceBasisView,
} from '@/lib/guide/view-types';
import { parseIsoDateStrict } from '@/lib/format';
import type { EvidenceScopeQuery } from '@/lib/semester';
import { OBSERVATION_STATUSES, type Child, type SchoolClass } from '@/lib/types';

import {
  zodToolParams,
  type YayaReadToolDefinition,
  type YayaReadToolInput,
  type YayaReadToolOutcome,
} from '../../agent/types';
import {
  basisIsFormalEvidence,
  type YayaProvenanceKind,
  type YayaSourceRef,
  type YayaToolAuth,
  type YayaToolScopePolicy,
} from '../../types';

import { createYayaReadPorts } from './ports';
import type {
  YayaChildClassContext,
  YayaChildProfileRecord,
  YayaReadPayload,
  YayaReadPorts,
  YayaReadRegistry,
  YayaReadToolContext,
} from './types';

/* --------------------------------- 来源与投影 --------------------------------- */

function ref(
  kind: YayaProvenanceKind,
  refId: string | null,
  label: string | null,
  derivedFrom: string | null = null,
): YayaSourceRef {
  return { kind, ref_id: refId, label, derived_from: derivedFrom };
}

/** 列表/目录/管理员列表的稳定主来源：非空、可重复、无隐私，模型可安全引用 */
const scopeSource = (refId: string, label: string): YayaSourceRef =>
  ref('tool_result', refId, label);
const childRef = (child: Child): YayaSourceRef =>
  ref('tool_result', `child:${child.id}`, `幼儿档案 ${child.name}`);
const classRef = (klass: SchoolClass): YayaSourceRef =>
  ref('tool_result', `class:${klass.id}`, `班级 ${klass.name}`);
const guideItemRef = (item: GuidePerformanceItem): YayaSourceRef =>
  ref('guide_catalog', `guide_item:${item.id}`, `指南条目 ${item.id}`);
const guideGoalRef = (goal: GuideGoalRef): YayaSourceRef =>
  ref('guide_catalog', `guide_goal:${goal.id}`, `指南目标 ${goal.title}`);

/**
 * 观察依赖来源：混合内容（原文/确认稿/AI 草稿/工作流）不整份冒充 child_fact，
 * 统一按平台记录 tool_result 表达；正式事实语义在结果内部按内容分别标注。
 */
function observationRef(observation: ScopedObservation): YayaSourceRef {
  const historical = observation.access_projection === 'historical_read_only';
  return ref(
    'tool_result',
    `observation:${observation.id}`,
    `${historical ? '原班历史观察（只读）' : '观察记录'} ${observation.observed_at}（${observation.status}）`,
    `child:${observation.child_id}`,
  );
}

/** 证据依据：只有已核验为 confirmed 的来源才以 child_fact 表达，否则不冒充事实 */
function evidenceBasisRef(childId: string, basis: EvidenceBasisView): YayaSourceRef {
  const formal = basis.valid && basis.observation_status === 'confirmed';
  return ref(
    formal ? 'child_fact' : 'tool_result',
    `observation:${basis.observation_id}`,
    `${formal ? '已确认证据依据' : '证据依据（未核验为正式事实）'} ${basis.observed_at}`,
    `child:${childId}`,
  );
}

/** 成长小结/活动支持的依据观察：本工具未核验其状态，不冒充已核验事实 */
function growthBasisRef(childId: string, observationId: string, role: string): YayaSourceRef {
  return ref(
    'tool_result',
    `observation:${observationId}`,
    `${role}依据观察（未经本工具核验，须按当前授权重核）`,
    `child:${childId}`,
  );
}

function dedupeRefs(refs: readonly YayaSourceRef[]): YayaSourceRef[] {
  const seen = new Set<string>();
  const out: YayaSourceRef[] = [];
  for (const entry of refs) {
    const key = `${entry.kind}\u0000${entry.ref_id ?? ''}\u0000${entry.derived_from ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * 来源封装：citable_source 唯一且非空；recheck_dependencies 含主来源并去重，
 * 只供 APP 重核，不作为模型引用。
 */
function payload<T>(
  tool: string,
  scopePolicy: YayaToolScopePolicy,
  citable: YayaSourceRef,
  dependencies: readonly YayaSourceRef[],
  data: T,
): YayaReadPayload<T> {
  return {
    tool,
    scope_policy: scopePolicy,
    citable_source: citable,
    recheck_dependencies: dedupeRefs([citable, ...dependencies]),
    data,
  };
}

function notFound(message: string): AccountsError {
  return new AccountsError('not_found', message);
}

/** 正式证据资格复用冻结口径：仅 confirmed 且带确认时间的 child_fact 才算 */
function formalEvidenceEligible(observation: ScopedObservation): boolean {
  return basisIsFormalEvidence({
    source_kind: 'child_fact',
    observation_status: observation.status,
    source_confirmed_at: observation.confirmed_at,
  });
}

/** 观察详情的内容来源分层：原文/确认稿/AI 草稿/工作流/证据各自真实语义 */
function observationContentSources(observation: ScopedObservation) {
  const derived = `observation:${observation.id}`;
  const historical = observation.access_projection === 'historical_read_only';
  const confirmed = observation.status === 'confirmed' && observation.confirmed_at !== null;
  return {
    raw_text: ref(
      'child_fact',
      null,
      historical
        ? '原班历史观察原文（只读投影）'
        : confirmed
          ? '已确认观察原文'
          : '观察原文（未经确认，不能单独作为正式证据）',
      derived,
    ),
    confirmed_content:
      observation.confirmed_content === null
        ? null
        : ref('child_fact', null, '教师确认内容', derived),
    ai_draft:
      observation.ai_draft === null
        ? null
        : ref('model_text', null, 'AI 整理草稿/建议（不是幼儿事实）', derived),
    workflow:
      observation.agent_context === null
        ? null
        : ref('tool_result', null, '观察工作流上下文（追问与复核，平台数据）', derived),
    guide_evidence:
      observation.guide_evidence === null || observation.guide_evidence === undefined
        ? null
        : ref('tool_result', null, '指南证据关联（正式证据仍需 G5 确认与版本核对）', derived),
  };
}

/** 最小必要字段：列表不转发成长档案/教师备注/统计标记等非必要内容 */
function childSummary(child: Child) {
  return {
    child_id: child.id,
    name: child.name,
    gender: child.gender,
    birth_date: child.birth_date,
    class_id: child.class_id,
    class_name: child.current_class?.name ?? (child.class_name || null),
    class_stage: child.current_class?.stage ?? child.class_stage,
    class_school_year: child.current_class?.school_year ?? child.class_school_year,
  };
}

/** 观察索引：正文与工作流细节留在详情工具；每条显式标注正式证据资格 */
function observationIndex(observation: ScopedObservation) {
  return {
    observation_id: observation.id,
    child_id: observation.child_id,
    observed_at: observation.observed_at,
    status: observation.status,
    class_id: observation.class_id,
    observed_class_name: observation.observed_class?.name ?? null,
    context: observation.context,
    access_projection: observation.access_projection,
    can_write: observation.can_write,
    formal_evidence_eligible: formalEvidenceEligible(observation),
  };
}

/** 证据册去掉内嵌的整份静态目录（目录已有独立工具），保留统计、来源与提示 */
function projectEvidenceBook(book: ChildEvidenceBook) {
  return {
    audience: book.audience,
    child: book.child,
    catalog_version: book.catalog_version,
    catalog_source: book.catalog.source,
    scope: book.scope,
    filters: book.filters,
    status_counts: book.status_counts,
    goals: book.goals,
    notices: book.notices,
  };
}

function projectClassOverview(overview: ClassEvidenceOverview) {
  return {
    audience: overview.audience,
    class: overview.class,
    catalog_version: overview.catalog_version,
    catalog_source: overview.catalog.source,
    scope: overview.scope,
    filters: overview.filters,
    roster: overview.roster,
    goals: overview.goals,
    notices: overview.notices,
  };
}

/** 聚合结果保留底层依赖：证据依据的观察（按核验状态分 kind）+ 引用到的指南条目 */
function evidenceBookRefs(book: ChildEvidenceBook): YayaSourceRef[] {
  const refs: YayaSourceRef[] = [];
  for (const goal of book.goals) {
    for (const view of goal.items) {
      refs.push(guideItemRef(view.item));
      for (const link of view.links) {
        for (const basis of link.basis) {
          refs.push(evidenceBasisRef(book.child.id, basis));
        }
      }
    }
  }
  return refs;
}

function evidenceBookSource(book: ChildEvidenceBook): YayaSourceRef {
  return ref('tool_result', `child:${book.child.id}`, `幼儿证据册 ${book.child.name}`);
}

function classOverviewDependencies(overview: ClassEvidenceOverview): YayaSourceRef[] {
  const refs: YayaSourceRef[] = [];
  for (const child of overview.roster.children) {
    refs.push(ref('tool_result', `child:${child.id}`, `幼儿档案 ${child.name}`));
  }
  for (const goal of overview.goals) {
    for (const view of goal.items) refs.push(guideItemRef(view.item));
  }
  return refs;
}

function classOverviewSource(overview: ClassEvidenceOverview): YayaSourceRef {
  return ref('tool_result', `class:${overview.class.id}`, `班级证据概览 ${overview.class.name}`);
}

/** 成长小结/活动支持的实际依据观察并入重核依赖并去重；本工具未核验其状态 */
function growthProfileDependencies(record: YayaChildProfileRecord): YayaSourceRef[] {
  const refs: YayaSourceRef[] = [];
  const seen = new Set<string>();
  const add = (observationId: string, role: string): void => {
    if (observationId.length === 0 || seen.has(observationId)) return;
    seen.add(observationId);
    refs.push(growthBasisRef(record.child.id, observationId, role));
  };
  for (const observationId of record.growth_profile?.source_observation_ids ?? []) {
    add(observationId, '成长小结');
  }
  for (const observationId of record.activity_support?.source_observation_ids ?? []) {
    add(observationId, '活动支持');
  }
  return refs;
}

/* --------------------------------- 参数 schema --------------------------------- */

const noParams = z.strictObject({});
const classIdParams = z.strictObject({ class_id: z.string().min(1) });
const childIdParams = z.strictObject({ child_id: z.string().min(1) });
const observationIdParams = z.strictObject({ observation_id: z.string().min(1) });
const childClassParams = z.strictObject({
  child_id: z.string().min(1),
  observed_at: z
    .string()
    .min(1)
    .refine((value) => parseIsoDateStrict(value) !== null, {
      message: '必须是真实存在的日历日期（YYYY-MM-DD）',
    }),
});
const listClassesParams = z.strictObject({ catalog: z.boolean().optional() });
const listObservationsParams = z.strictObject({
  child_id: z.string().min(1).optional(),
  status: z.enum(OBSERVATION_STATUSES).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
const evidenceQueryFields = {
  scope: z.enum(['current_semester', 'all_history', 'custom_range']).optional(),
  semester_id: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  domain: z.enum(GUIDE_DOMAIN_CODES).optional(),
  age_band: z.enum(GUIDE_AGE_BANDS).optional(),
  goal_id: z.string().min(1).optional(),
};
const childEvidenceParams = z.strictObject({
  child_id: z.string().min(1),
  ...evidenceQueryFields,
});
const classEvidenceParams = z.strictObject({
  class_id: z.string().min(1),
  ...evidenceQueryFields,
});
const guideItemFilterParams = z.strictObject({
  domain_code: z.enum(GUIDE_DOMAIN_CODES).optional(),
  sub_domain_id: z.string().min(1).optional(),
  goal_id: z.string().min(1).optional(),
  age_band: z.enum(GUIDE_AGE_BANDS).optional(),
});
const guideItemParams = z.strictObject({ item_id: z.string().min(1) });
const guideGoalParams = z.strictObject({ goal_id: z.string().min(1) });

type EvidenceQueryFields = Omit<z.infer<typeof childEvidenceParams>, 'child_id'>;

function evidenceQuery(params: EvidenceQueryFields): EvidenceScopeQuery & EvidenceFiltersInput {
  return {
    scope: params.scope ?? null,
    semester_id: params.semester_id ?? null,
    from: params.from ?? null,
    to: params.to ?? null,
    domain: params.domain ?? null,
    age_band: params.age_band ?? null,
    goal_id: params.goal_id ?? null,
  };
}

function evidenceFailure(failure: EvidenceLoadFailure): AccountsError {
  if (failure.status === 404 || failure.error === 'not_found') {
    return notFound(failure.message);
  }
  return new AccountsError('server_error', failure.message);
}

/* ------------------------------- 指南静态目录索引 ------------------------------- */

function findGuideGoal(goalId: string): GuideGoalRef | null {
  for (const domain of GUIDE_CATALOG.domains) {
    for (const subDomain of domain.sub_domains) {
      for (const goal of subDomain.goals) {
        if (goal.id === goalId) {
          return {
            id: goal.id,
            domain_id: goal.domain_id,
            sub_domain_id: goal.sub_domain_id,
            index: goal.index,
            title: goal.title,
          };
        }
      }
    }
  }
  return null;
}

/* --------------------------------- 工具定义 --------------------------------- */

interface ReadToolSpec<S extends z.ZodType> {
  tool: string;
  description: string;
  scope_policy: YayaToolScopePolicy;
  auth: YayaToolAuth;
  schema: S;
  run: (params: z.infer<S>, context: YayaReadToolContext) => Promise<YayaReadPayload<unknown>>;
}

function defineReadTool<S extends z.ZodType>(spec: ReadToolSpec<S>): ReadToolSpec<S> {
  return spec;
}

/** 模型可见的来源契约：只有 citable_source 可引用；依赖仅供服务端重核 */
const SOURCE_CONTRACT =
  '。结果的可引用来源只有 citable_source，回答引用它；recheck_dependencies 仅供服务端重核，不要引用';

function buildReadTools(ports: YayaReadPorts): ReadToolSpec<z.ZodType>[] {
  return [
    defineReadTool({
      tool: 'list_children',
      description:
        '查询当前账号可读范围内的在班幼儿列表（教师=任教班级当前在班；管理员=全园）。只读；空任教范围返回 empty_scope，绝不等于全园' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'scope_query' },
      schema: noParams,
      run: async (_params, context) => {
        const children = await ports.listChildren(context.request);
        return payload(
          'list_children',
          'business_scope',
          scopeSource('children:current_scope', '当前可读幼儿列表'),
          children.map(childRef),
          { children: children.map(childSummary) },
        );
      },
    }),
    defineReadTool({
      tool: 'list_classes',
      description:
        '查询班级列表。catalog=true 只返回全园班级基础目录（名称/学段/学年/启停，不含名单与统计）；缺省只返回当前任教班级' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'scope_query' },
      schema: listClassesParams,
      run: async (params, context) => {
        const catalog = params.catalog === true;
        const classes = await ports.listClasses({ catalog }, context.request);
        return payload(
          'list_classes',
          'business_scope',
          catalog
            ? scopeSource('classes:catalog', '全园班级基础目录')
            : scopeSource('classes:assigned', '当前任教班级列表'),
          classes.map(classRef),
          { catalog, classes },
        );
      },
    }),
    defineReadTool({
      tool: 'get_class',
      description:
        '查询指定班级详情、当前在班名单与使用历史计数；需要该班级的读取权限（教师=任教班级，管理员=全园）' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'action', action: 'class.read', resource: 'class' },
      schema: classIdParams,
      run: async (params, context) => {
        const bundle = await ports.getClassBundle(params.class_id, context.request);
        if (!bundle) throw notFound('班级不存在或当前不可读。');
        return payload(
          'get_class',
          'business_scope',
          classRef(bundle.klass),
          bundle.children.map(childRef),
          {
            class: bundle.klass,
            children: bundle.children.map(childSummary),
            history: bundle.history,
          },
        );
      },
    }),
    defineReadTool({
      tool: 'resolve_child_class',
      description:
        '按指定日期解析幼儿当时的班级归属；无归属、重叠或历史异常时不猜测，返回 status=needs_confirmation 与当前可读候选' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'action', action: 'child.read', resource: 'child' },
      schema: childClassParams,
      run: async (params, context) => {
        const found: YayaChildClassContext | null = await ports.resolveChildClass(
          { childId: params.child_id, observedAt: params.observed_at },
          context.request,
        );
        if (!found) throw notFound('幼儿不存在或当前不可读。');
        const lookup = found.lookup;
        const dependencies =
          lookup.status === 'resolved' ? [classRef(lookup.class)] : [];
        return payload('resolve_child_class', 'business_scope', childRef(found.child), dependencies, {
          child: { child_id: found.child.id, name: found.child.name },
          observed_at: params.observed_at,
          status: lookup.status,
          reason: lookup.reason,
          class: lookup.status === 'resolved' ? lookup.class : null,
          enrollment_id: lookup.status === 'resolved' ? lookup.enrollment_id : null,
          candidates: lookup.status === 'resolved' ? [] : lookup.candidates,
        });
      },
    }),
    defineReadTool({
      tool: 'list_observations',
      description:
        '查询当前范围内观察记录索引（可按幼儿/状态筛选，limit 最大 1000）；正文与工作流细节请用 get_observation。原班历史只读记录按聊天投影裁剪' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'scope_query' },
      schema: listObservationsParams,
      run: async (params, context) => {
        const observations = await ports.listObservations(
          { childId: params.child_id, status: params.status, limit: params.limit },
          context.request,
        );
        return payload(
          'list_observations',
          'business_scope',
          scopeSource('observations:current_scope', '当前可读观察记录列表'),
          observations.map(observationRef),
          { observations: observations.map(observationIndex) },
        );
      },
    }),
    defineReadTool({
      tool: 'get_observation',
      description:
        '查询单条观察记录详情（原文、确认状态与确认内容、AI 草稿、工作流分别标注来源；只有 confirmed 且带确认时间的原文才可作为正式事实）。原班历史只读投影不含跨班证据、AI 草稿与工作流字段，且不能写入' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'action', action: 'observation.read', resource: 'observation' },
      schema: observationIdParams,
      run: async (params, context) => {
        const observation = await ports.getObservation(params.observation_id, context.request);
        if (!observation) throw notFound('观察记录不存在或当前不可读。');
        return payload('get_observation', 'business_scope', observationRef(observation), [], {
          observation,
          content_sources: observationContentSources(observation),
          formal_evidence_eligible: formalEvidenceEligible(observation),
        });
      },
    }),
    defineReadTool({
      tool: 'get_child_growth_profile',
      description:
        '查询幼儿成长档案与已有活动支持；两者是 AI 生成的摘要/建议，不是已保存幼儿事实，也不自动构成指南证据' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'action', action: 'child.read', resource: 'child' },
      schema: childIdParams,
      run: async (params, context) => {
        const record = await ports.getChildProfile(params.child_id, context.request);
        if (!record) throw notFound('幼儿不存在或当前不可读。');
        const profile = record.growth_profile;
        const support = record.activity_support;
        return payload(
          'get_child_growth_profile',
          'business_scope',
          childRef(record.child),
          growthProfileDependencies(record),
          {
            child: childSummary(record.child),
            growth_profile: profile
              ? {
                  value: profile,
                  source: profile.is_fallback === true ? 'fallback' : 'ai_summary',
                  basis_observation_ids: profile.source_observation_ids,
                }
              : null,
            activity_support: support
              ? {
                  value: support,
                  source: 'ai_summary',
                  basis_observation_ids: support.source_observation_ids,
                }
              : null,
            notes: [
              '成长小结与活动支持是 AI 生成内容，不是已保存幼儿事实，也不自动构成指南证据；引用时须注明来源',
              '依据观察 ID 未经本工具核验，须按当前授权重核后才能引用；坏/缺失来源不得当作已核验事实',
            ],
          },
        );
      },
    }),
    defineReadTool({
      tool: 'get_child_evidence_book',
      description:
        '查询幼儿指南证据册（只读统计，零写入）；默认当前学期，可用 scope/semester_id/from+to/domain/age_band/goal_id 缩小范围' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'action', action: 'child.read', resource: 'child' },
      schema: childEvidenceParams,
      run: async (params, context) => {
        const result = await ports.loadChildEvidenceBook(
          params.child_id,
          evidenceQuery(params),
          context.request,
        );
        if (!result.ok) throw evidenceFailure(result.failure);
        const book = result.value;
        return payload(
          'get_child_evidence_book',
          'business_scope',
          evidenceBookSource(book),
          evidenceBookRefs(book),
          { evidence_book: projectEvidenceBook(book) },
        );
      },
    }),
    defineReadTool({
      tool: 'get_class_evidence_overview',
      description:
        '查询班级当前名单的指南证据概览（只读统计，零写入）；分母为当前在班名单，可靠性不足时不显示正常 0%' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'action', action: 'class.read', resource: 'class' },
      schema: classEvidenceParams,
      run: async (params, context) => {
        const result = await ports.loadClassEvidenceOverview(
          params.class_id,
          evidenceQuery(params),
          context.request,
        );
        if (!result.ok) throw evidenceFailure(result.failure);
        const overview = result.value;
        return payload(
          'get_class_evidence_overview',
          'business_scope',
          classOverviewSource(overview),
          classOverviewDependencies(overview),
          { evidence_overview: projectClassOverview(overview) },
        );
      },
    }),
    defineReadTool({
      tool: 'list_guide_items',
      description:
        '查询《3-6岁儿童学习与发展指南》具体表现条目（静态教育参考，不是幼儿证据）；可按领域/年龄段/目标筛选，含真实出处' +
        SOURCE_CONTRACT,
      scope_policy: 'authenticated_reference',
      auth: { kind: 'scope_query' },
      schema: guideItemFilterParams,
      run: async (params, context) => {
        await ports.requireReferenceAccess(context.request);
        const items = await listGuideItems({
          domain_code: params.domain_code,
          sub_domain_id: params.sub_domain_id,
          goal_id: params.goal_id,
          age_band: params.age_band,
        });
        return payload(
          'list_guide_items',
          'authenticated_reference',
          scopeSource('guide_catalog:items', '指南目录静态参考'),
          items.map(guideItemRef),
          { catalog_version: GUIDE_CATALOG_VERSION, items },
        );
      },
    }),
    defineReadTool({
      tool: 'get_guide_item',
      description:
        '查询单条指南条目详情与所属目标的教育建议（静态教育参考，不是幼儿证据），含定位链与出处' +
        SOURCE_CONTRACT,
      scope_policy: 'authenticated_reference',
      auth: { kind: 'scope_query' },
      schema: guideItemParams,
      run: async (params, context) => {
        await ports.requireReferenceAccess(context.request);
        const detail: GuideItemDetail | null = await getGuideItem(params.item_id);
        if (!detail) throw notFound('指南条目不存在。');
        return payload(
          'get_guide_item',
          'authenticated_reference',
          guideItemRef(detail.item),
          [],
          {
            catalog_version: GUIDE_CATALOG_VERSION,
            item: detail,
          },
        );
      },
    }),
    defineReadTool({
      tool: 'list_education_suggestions',
      description:
        '查询指南目标的教育建议（静态教育参考，不是幼儿证据）；未知目标返回 not_found' +
        SOURCE_CONTRACT,
      scope_policy: 'authenticated_reference',
      auth: { kind: 'scope_query' },
      schema: guideGoalParams,
      run: async (params, context) => {
        await ports.requireReferenceAccess(context.request);
        const goal = findGuideGoal(params.goal_id);
        if (!goal) throw notFound('指南目标不存在。');
        const suggestions = await listEducationSuggestions(params.goal_id);
        return payload(
          'list_education_suggestions',
          'authenticated_reference',
          guideGoalRef(goal),
          suggestions.map((entry) =>
            ref('guide_catalog', `guide_suggestion:${entry.id}`, `教育建议 ${entry.id}`),
          ),
          { catalog_version: GUIDE_CATALOG_VERSION, goal, suggestions },
        );
      },
    }),
    defineReadTool({
      tool: 'list_teacher_accounts',
      description:
        '管理员查询教师账号列表（脱敏，不含密码/哈希/令牌）；教师调用返回 forbidden_role，不伪装空列表' +
        SOURCE_CONTRACT,
      scope_policy: 'business_scope',
      auth: { kind: 'action', action: 'teacher.manage', resource: 'school' },
      schema: noParams,
      run: async (_params, context) => {
        const teachers = await ports.listTeacherAccounts(context.request);
        return payload(
          'list_teacher_accounts',
          'business_scope',
          scopeSource('teacher_accounts:school', '教师账号列表（脱敏）'),
          teachers.map((teacher) =>
            ref('tool_result', `teacher:${teacher.account_id}`, `教师账号 ${teacher.display_name}`),
          ),
          { teachers },
        );
      },
    }),
  ];
}

/* --------------------------------- 失败映射 --------------------------------- */

function failureFromError(error: unknown): YayaReadToolOutcome {
  if (error instanceof AccountsError) {
    switch (error.code) {
      case 'unauthenticated':
      case 'invalid_credentials':
        return { ok: false, code: 'unauthenticated', message: error.message };
      case 'identity_unavailable':
        return { ok: false, code: 'identity_unavailable', message: error.message };
      case 'forbidden_role':
        return { ok: false, code: 'forbidden_role', message: error.message };
      case 'out_of_scope':
        return { ok: false, code: 'out_of_scope', message: error.message };
      case 'empty_scope':
        return { ok: false, code: 'empty_scope', message: error.message };
      case 'not_found':
        return { ok: false, code: 'not_found', message: error.message };
      case 'account_disabled':
      case 'csrf_rejected':
        return { ok: false, code: 'denied', message: error.message };
      default:
        return { ok: false, code: 'failed', message: error.message };
    }
  }
  return {
    ok: false,
    code: 'failed',
    message: error instanceof Error ? error.message : '读取失败',
  };
}

/* --------------------------------- registry --------------------------------- */

export function createYayaReadRegistry(options: { ports?: YayaReadPorts } = {}): YayaReadRegistry {
  const ports = options.ports ?? createYayaReadPorts();
  const entries = buildReadTools(ports).map((tool) => {
    const definition: YayaReadToolDefinition = {
      tool: tool.tool,
      description: tool.description,
      scope_policy: tool.scope_policy,
      params: zodToolParams(tool.schema),
    };
    return { tool, definition, registration: { definition, auth: tool.auth } };
  });

  const dispatch = async (
    input: { tool: string; params: unknown },
    context: YayaReadToolContext = {},
  ): Promise<YayaReadToolOutcome> => {
    const entry = entries.find((candidate) => candidate.tool.tool === input.tool);
    if (!entry) {
      return { ok: false, code: 'denied', message: `未注册的只读工具：${input.tool}` };
    }
    const parsed = entry.tool.schema.safeParse(input.params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? issue.path.join('.') || 'params' : 'params';
      return {
        ok: false,
        code: 'failed',
        message: `参数不合法：${where}: ${issue?.message ?? '不符合参数要求'}`,
      };
    }
    try {
      const result = await entry.tool.run(parsed.data, context);
      const citable = result.citable_source;
      if (citable.ref_id === null || citable.ref_id.length === 0) {
        return { ok: false, code: 'failed', message: `工具 ${input.tool} 未提供可引用主来源` };
      }
      return { ok: true, data: result, source: citable };
    } catch (error) {
      return failureFromError(error);
    }
  };

  return {
    registrations: entries.map((entry) => entry.registration),
    definitions: entries.map((entry) => entry.definition),
    dispatch,
    readTool: (input: YayaReadToolInput) => dispatch({ tool: input.tool, params: input.params }),
  };
}
