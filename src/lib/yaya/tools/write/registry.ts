/**
 * TOOLS1 真实写工具注册表：prepare（当前授权 + 服务端资源解析 + 提案）→ compute（事务外
 * 模型/依据计算）→ execute（同一 TransactionClient 业务落账）。
 *
 * 覆盖现有平台真实入口：
 * - 建档、录入观察、整理、回答/跳过/停止追问；
 * - 确认归档（含教师修改复核准备态）、指南建议/关联/拒绝/撤回；
 * - 成长小结刷新、活动支持刷新；
 * - 班级新建/修改、转班；
 * - 教师启停、分配/撤销任教（教师创建/密码重置只走安全控件入口，不注册）；
 * - 观察创建附图、归档后追加资料图片。
 *
 * 工具结果是提案与回执，不是权限：每个 prepare/execute 都复用 AUTH `authorizeAction`
 * 与服务端资源事实；参数 schema 与服务端校验同源，模型不能自报身份/批准/SQL。
 */
import { randomUUID } from 'node:crypto';

import { HeaderUtils } from 'coze-coding-dev-sdk';

import { authorizeAction } from '@/lib/accounts/authorize';
import type { AccessAction, AccessResource, AccessResourceKind, Principal } from '@/lib/accounts/types';
import {
  assignTeacherClassWithClient,
  getTeacherAccountRevisionWithClient,
  setTeacherStatusWithClient,
  unassignTeacherClassWithClient,
} from '@/lib/accounts/repository';
import { generateActivitySupportUpdate } from '@/lib/activity-support';
import {
  CLASS_CONTEXT_REASON_MESSAGES,
  buildEnrollmentSnapshot,
  buildTeacherConfirmedSnapshot,
  getReliableClass,
  resolveClassContextAt,
} from '@/lib/class-context';
import { generateGrowthProfileUpdate, StaleEvidenceError } from '@/lib/growth-profile';
import {
  generateGuideEvidenceSuggestions,
  selectSuggestionCandidates,
} from '@/lib/guide/suggest';
import { parseGuideEvidence } from '@/lib/guide/runtime';
import {
  appendFollowUpAction,
  computeObservationAgent,
  observationWriteGuard,
  type ObservationAgentComputation,
} from '@/lib/observation-agent';
import {
  ClassHistoryProtectedError,
  applyGuideEvidenceMutationWithClient,
  confirmObservationWithClient,
  createChildWithClient,
  createClassWithClient,
  createObservationWithClient,
  enrollChildInClassWithClient,
  findClassByNameWithClient,
  getChild,
  getChildWithClient,
  getClassWithClient,
  getObservation,
  getObservationWithClient,
  listObservations,
  saveGuideEvidenceSuggestionResultWithClient,
  updateChildActivitySupportWithClient,
  updateChildGrowthProfileSummaryWithClient,
  updateClassWithClient,
  updateObservationAgentContext,
  updateObservationAgentContextWithClient,
  updateObservationAiDraftWithClient,
} from '@/lib/queries';
import {
  appendObservationImages,
  associateObservationImagesOnCreate,
  type HostObservationFacts,
} from '@/lib/media/attachment-service';
import { bindDataAttachmentMetadataPort } from '@/lib/media/data-adapter';
import type { MediaObjectStore } from '@/lib/media/object-store';
import type { MediaServiceDeps } from '@/lib/media/runtime';
import { reviewTeacherEdit } from '@/lib/ai';
import type { invokeLlm } from '@/lib/llm';
import {
  clarificationSnapshot,
  normalizeTeacherEditContent,
  normalizeTeacherNote,
  sameClarificationSnapshot,
  sameTeacherEditContent,
  sameTeacherEditNote,
  teacherEditSubmissionAction,
} from '@/lib/teacher-edit-review';
import {
  findDevelopmentForbiddenTerm,
  isQuoteInRawText,
} from '@/lib/validation';
import type { AgentContext, ObservationDraft, ObservationStatus } from '@/lib/types';
import type { TransactionClient } from '@/storage/database/pg-client';

import { readAccessResourceFacts } from '../../data/access-facts';
import { YayaDataError } from '../../storage-types';
import type { YayaDomainPayload, YayaProposalItem } from '../../types';
import { zodToolParams, type YayaProposeWriteFailureCode } from '../../agent/types';
import type {
  YayaWriteComputeInput,
  YayaWritePreparedItem,
  YayaWritePrepareContext,
  YayaWriteRegistry,
  YayaWriteToolEntry,
} from './types';
import {
  attachObservationImagesParamsSchema,
  confirmObservationParamsSchema,
  createChildParamsSchema,
  createObservationParamsSchema,
  followUpObservationParamsSchema,
  guideDecisionParamsSchema,
  manageClassParamsSchema,
  manageTeacherParamsSchema,
  organizeObservationParamsSchema,
  refreshActivitySupportParamsSchema,
  refreshGrowthProfileParamsSchema,
  transferChildParamsSchema,
  type CreateObservationParams,
} from './schemas';

/* ------------------------------- 准备错误与映射 ------------------------------- */

export class YayaWriteProposeError extends Error {
  constructor(
    public readonly code: YayaProposeWriteFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'YayaWriteProposeError';
  }
}

function denyCode(deny: string): YayaProposeWriteFailureCode {
  switch (deny) {
    case 'unauthenticated':
      return 'unauthenticated';
    case 'identity_unavailable':
      return 'identity_unavailable';
    case 'forbidden_role':
      return 'forbidden_role';
    case 'out_of_scope':
      return 'out_of_scope';
    case 'empty_scope':
      return 'empty_scope';
    default:
      return 'denied';
  }
}

const DENY_MESSAGES: Record<string, string> = {
  unauthenticated: '请先登录园所账号。',
  identity_unavailable: '身份服务暂时不可用，请稍后重试。',
  forbidden_role: '当前账号没有该操作的权限。',
  out_of_scope: '目标业务资源不在当前任教范围内。',
  empty_scope: '尚未分配任教班级，暂不能执行该操作。',
  account_disabled: '账号已停用。',
};

export function authorizeOrThrow(
  principal: Principal,
  action: AccessAction,
  facts: AccessResource,
): void {
  const decision = authorizeAction(principal, action, facts);
  if (decision.allowed) return;
  if ('invalid_request' in decision) {
    throw new YayaWriteProposeError('invalid_params', '动作与资源组合不合法。');
  }
  throw new YayaWriteProposeError(
    denyCode(decision.deny),
    DENY_MESSAGES[decision.deny] ?? '当前账号没有该操作的权限。',
  );
}

async function readFactsOrThrow(
  client: TransactionClient,
  ref: Parameters<typeof readAccessResourceFacts>[1],
  schoolId: string,
): Promise<AccessResource> {
  const facts = await readAccessResourceFacts(client, ref, schoolId);
  if (facts === null) {
    throw new YayaWriteProposeError('failed', '目标业务资源不存在或已被移除。');
  }
  return facts;
}

/* ------------------------------- 媒体依赖 ------------------------------- */

/** `associateObservationImagesOnCreate` / `appendObservationImages` 只使用 metadata 端口；对象存储不参与。 */
export function createUnavailableMediaStore(): MediaObjectStore {
  const unavailable = (): never => {
    throw new Error('写工具执行不使用对象存储直连');
  };
  return {
    putOnce: async () => unavailable(),
    get: async () => unavailable(),
    delete: async () => unavailable(),
  };
}

function boundMediaDeps(client: TransactionClient, store: MediaObjectStore): MediaServiceDeps {
  return {
    metadata: bindDataAttachmentMetadataPort(client),
    store,
    environment: 'development',
  };
}

function hostFacts(
  observation: { id: string; child_id: string; status: ObservationStatus; confirmed_at: string | null; class_id: string | null },
  child: { class_id: string | null },
): HostObservationFacts {
  return {
    observation_id: observation.id,
    child_id: observation.child_id,
    status: observation.status,
    confirmed_at: observation.confirmed_at,
    current_class_id: child.class_id,
    observed_class_id: observation.class_id,
  };
}

/* ------------------------------- 回执结果 ------------------------------- */

function successReceipt(
  businessObjectId: string,
  businessRevision: string | null,
): { status: 'saved'; effect: 'committed'; business_object_id: string; business_revision: string | null } {
  return {
    status: 'saved',
    effect: 'committed',
    business_object_id: businessObjectId,
    business_revision: businessRevision,
  };
}

/* ------------------------------- 通用工具 ------------------------------- */

function defineEntry(entry: YayaWriteToolEntry): YayaWriteToolEntry {
  return entry;
}

/* =============================== 写工具定义 =============================== */

function observationPreparation(
  input: { params: unknown; context: YayaWritePrepareContext },
  action: AccessAction,
): Promise<{ observation: NonNullable<Awaited<ReturnType<typeof getObservationWithClient>>>; revision: string | null }> {
  const params = input.params as { observation_id: string };
  return (async () => {
    const observation = await getObservationWithClient(input.context.client, params.observation_id);
    if (!observation) throw new YayaWriteProposeError('failed', '观察记录不存在或不可访问。');
    const facts = await readFactsOrThrow(
      input.context.client,
      { kind: 'observation', observation_id: observation.id },
      input.context.school_id,
    );
    authorizeOrThrow(input.context.principal, action, facts);
    return { observation, revision: observation.updated_at };
  })();
}

function defineObservationExecute(
  payloadOf: (payload: YayaDomainPayload) => string,
): Pick<YayaWriteToolEntry, 'resolveBusinessRevision'> {
  return {
    resolveBusinessRevision: async (client, context) => {
      const observation = await getObservationWithClient(client, payloadOf(context.proposal_item.payload));
      return observation?.updated_at ?? null;
    },
  };
}

/* -------------------------------- 录入观察 -------------------------------- */

const createObservationEntry = defineEntry({
  definition: {
    tool: 'create_observation',
    description:
      '为指定幼儿录入一条观察原始记录（raw_text 保存后永不改写）。需要幼儿当前归属在任教范围内；' +
      '观察日期对应班级归属无法唯一确定时，必须先在参数中给出 confirmed_class_id，否则准备失败。' +
      '可携带已上传图片的 image_ids，图片关联与观察保存在同一事务内。',
    auth: { kind: 'action', action: 'observation.write', resource: 'child' },
    params: zodToolParams(createObservationParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const input = params as CreateObservationParams;
    const child = await getChildWithClient(context.client, input.child_id);
    if (!child) throw new YayaWriteProposeError('failed', '幼儿不存在或不可访问。');
    const facts = await readFactsOrThrow(
      context.client,
      { kind: 'child', child_id: child.id },
      context.school_id,
    );
    authorizeOrThrow(context.principal, 'observation.write', facts);
    if (input.confirmed_class_id) {
      const confirmed = await getReliableClass(input.confirmed_class_id);
      if (!confirmed || !confirmed.is_active) {
        throw new YayaWriteProposeError(
          'invalid_params',
          '确认的班级不存在或已停用，不能写入发生时班级快照。',
        );
      }
    } else {
      const lookup = await resolveClassContextAt(child.id, input.observed_at);
      if (lookup.status !== 'resolved') {
        throw new YayaWriteProposeError('failed', CLASS_CONTEXT_REASON_MESSAGES[lookup.reason]);
      }
    }
    const payload: YayaDomainPayload = {
      kind: 'create_observation',
      child_id: child.id,
      observed_at: input.observed_at,
      raw_text: input.raw_text.trim(),
      context: input.context?.trim() ? input.context.trim() : null,
      confirmed_class_id: input.confirmed_class_id ?? null,
      image_ids: [...input.image_ids],
      source_input: null,
    };
    return {
      item_key: '',
      target_id: child.id,
      action: 'observation.write',
      resource: 'child',
      resource_ref: { kind: 'child', child_id: child.id },
      payload,
      attachment_associations: input.image_ids.map((imageId) => ({
        attachment_id: imageId,
        target_id: child.id,
      })),
      business_revision: child.updated_at,
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'create_observation' }>;
    const child = await getChildWithClient(input.client, payload.child_id);
    if (!child) throw new YayaDataError('not_found', '幼儿不存在。');
    let snapshot;
    let premise;
    if (payload.confirmed_class_id) {
      const confirmed = await getReliableClass(payload.confirmed_class_id);
      if (!confirmed) throw new YayaDataError('invalid_request', '确认班级资料无法核实。');
      if (!confirmed.is_active) throw new YayaDataError('source_conflict', '确认班级已停用。');
      snapshot = buildTeacherConfirmedSnapshot(confirmed);
      premise = {
        class_id: confirmed.id,
        class_name: confirmed.name,
        stage: confirmed.stage,
        school_year: confirmed.school_year,
        enrollment_id: null,
        observed_at: payload.observed_at,
      };
    } else {
      const lookup = await resolveClassContextAt(child.id, payload.observed_at);
      if (lookup.status !== 'resolved') {
        throw new YayaDataError(
          'source_conflict',
          CLASS_CONTEXT_REASON_MESSAGES[lookup.reason],
        );
      }
      snapshot = buildEnrollmentSnapshot(lookup.class, lookup.enrollment_id);
      premise = {
        class_id: lookup.class.id,
        class_name: lookup.class.name,
        stage: lookup.class.stage,
        school_year: lookup.class.school_year,
        enrollment_id: lookup.enrollment_id,
        observed_at: payload.observed_at,
      };
    }
    const observation = await createObservationWithClient(input.client, {
      child_id: child.id,
      observed_at: payload.observed_at,
      context: payload.context,
      raw_text: payload.raw_text,
      is_demo: false,
      class_context_snapshot: snapshot,
      premise,
    });
    if (payload.image_ids.length > 0) {
      await associateObservationImagesOnCreate(boundMediaDeps(input.client, input.store), {
        host: hostFacts(observation, child),
        principal: input.principal,
        image_ids: payload.image_ids,
        request_id: input.request_id,
      });
    }
    return successReceipt(observation.id, observation.updated_at);
  },
  resolveBusinessRevision: async (client, context) => {
    const payload = context.proposal_item.payload as Extract<
      YayaDomainPayload,
      { kind: 'create_observation' }
    >;
    const child = await getChildWithClient(client, payload.child_id);
    return child?.updated_at ?? null;
  },
});

/* -------------------------------- AI 整理 -------------------------------- */

const organizeObservationEntry = defineEntry({
  definition: {
    tool: 'organize_observation',
    description:
      '对未归档观察触发 AI 整理：模型在事务外生成 ai_draft（或补充追问进入 needs_input），' +
      '保存前必须仍匹配服务端读取时的状态/上下文/原草稿。已确认归档的记录会被拒绝。',
    auth: { kind: 'action', action: 'observation.organize', resource: 'observation' },
    params: zodToolParams(organizeObservationParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const { observation, revision } = await observationPreparation(
      { params, context },
      'observation.organize',
    );
    return {
      item_key: '',
      target_id: observation.id,
      action: 'observation.organize',
      resource: 'observation',
      resource_ref: { kind: 'observation', observation_id: observation.id },
      payload: { kind: 'organize_observation', observation_id: observation.id },
      attachment_associations: [],
      business_revision: revision,
    };
  },
  load: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'organize_observation' }>;
    const observation = await getObservation(payload.observation_id);
    if (!observation) throw new YayaDataError('not_found', '观察记录不存在。');
    const child = await getChild(observation.child_id);
    if (!child) throw new YayaDataError('not_found', '关联幼儿档案不存在。');
    return { observation, child };
  },
  compute: async (input) => {
    const { observation, child } = input.loaded as {
      observation: NonNullable<Awaited<ReturnType<typeof getObservation>>>;
      child: NonNullable<Awaited<ReturnType<typeof getChild>>>;
    };
    if (observation.status === 'confirmed') {
      throw new YayaDataError('source_conflict', '该记录已由教师确认归档，不能再重新进行 AI 整理。');
    }
    const computed = await computeObservationAgent({
      observation,
      child,
      forwardHeaders: forwardHeadersOf(input),
      invoke: input.invoke,
    });
    return { kind: 'proceed', data: { guard: observationWriteGuard(observation), computed } };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'organize_observation' }>;
    const data = input.computed as {
      guard: ReturnType<typeof observationWriteGuard>;
      computed: ObservationAgentComputation;
    };
    const saved =
      data.computed.kind === 'needs_input'
        ? await updateObservationAgentContextWithClient(
            input.client,
            payload.observation_id,
            data.computed.agent_context,
            'needs_input',
            data.guard,
          )
        : await updateObservationAiDraftWithClient(
            input.client,
            payload.observation_id,
            data.computed.ai_draft,
            data.computed.model,
            data.guard,
          );
    return successReceipt(saved.id, saved.updated_at);
  },
  ...defineObservationExecute((payload) =>
    (payload as Extract<YayaDomainPayload, { kind: 'organize_observation' }>).observation_id,
  ),
});

/* ------------------------------ 追问（回答/跳过/停止） ------------------------------ */

const followUpObservationEntry = defineEntry({
  definition: {
    tool: 'follow_up_observation',
    description:
      '对 needs_input 的观察提交一次追问动作（answer/skip/stop），随后重新运行 AI 整理。' +
      '仅当记录当前处于等待补充信息状态且存在补充问题时准备成功；回答内容会先原子保存再整理。',
    auth: { kind: 'action', action: 'observation.organize', resource: 'observation' },
    params: zodToolParams(followUpObservationParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const { observation, revision } = await observationPreparation(
      { params, context },
      'observation.organize',
    );
    const parsed = params as { action: 'answer' | 'skip' | 'stop'; content?: string };
    return {
      item_key: '',
      target_id: observation.id,
      action: 'observation.organize',
      resource: 'observation',
      resource_ref: { kind: 'observation', observation_id: observation.id },
      payload: {
        kind: 'follow_up_observation',
        observation_id: observation.id,
        action: parsed.action,
        content: (parsed.content ?? '').trim(),
      },
      attachment_associations: [],
      business_revision: revision,
    };
  },
  load: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'follow_up_observation' }>;
    const observation = await getObservation(payload.observation_id);
    if (!observation) throw new YayaDataError('not_found', '观察记录不存在。');
    const child = await getChild(observation.child_id);
    if (!child) throw new YayaDataError('not_found', '关联幼儿档案不存在。');
    return { observation, child };
  },
  compute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'follow_up_observation' }>;
    const { observation, child } = input.loaded as {
      observation: NonNullable<Awaited<ReturnType<typeof getObservation>>>;
      child: NonNullable<Awaited<ReturnType<typeof getChild>>>;
    };
    if (observation.status !== 'needs_input') {
      throw new YayaDataError('source_conflict', '当前记录不在等待补充信息状态，不能提交追问操作。');
    }
    if (!observation.agent_context?.follow_up) {
      throw new YayaDataError('source_conflict', '当前记录缺少有效的补充问题，请重新进入 Agent 判断。');
    }
    const followUpContext = appendFollowUpAction(
      observation.agent_context,
      payload.action,
      payload.content,
    );
    const prospective = { ...observation, agent_context: followUpContext } as typeof observation;
    const computed = await computeObservationAgent({
      observation: prospective,
      child,
      forwardHeaders: forwardHeadersOf(input),
      invoke: input.invoke,
    });
    return {
      kind: 'proceed',
      data: {
        guard: observationWriteGuard(observation),
        follow_up_context: followUpContext,
        computed,
      },
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'follow_up_observation' }>;
    const data = input.computed as {
      guard: ReturnType<typeof observationWriteGuard>;
      follow_up_context: AgentContext;
      computed: ObservationAgentComputation;
    };
    const saved = await updateObservationAgentContextWithClient(
      input.client,
      payload.observation_id,
      data.follow_up_context,
      'needs_input',
      data.guard,
    );
    const result =
      data.computed.kind === 'needs_input'
        ? await updateObservationAgentContextWithClient(
            input.client,
            saved.id,
            data.computed.agent_context,
            'needs_input',
            observationWriteGuard(saved),
          )
        : await updateObservationAiDraftWithClient(
            input.client,
            saved.id,
            data.computed.ai_draft,
            data.computed.model,
            observationWriteGuard(saved),
          );
    return successReceipt(result.id, result.updated_at);
  },
  ...defineObservationExecute((payload) =>
    (payload as Extract<YayaDomainPayload, { kind: 'follow_up_observation' }>).observation_id,
  ),
});

/* -------------------------------- 确认归档 -------------------------------- */

function withoutTeacherEditReview(context: AgentContext): AgentContext {
  const next = { ...context };
  delete next.teacher_edit_review;
  return next;
}

const confirmObservationEntry = defineEntry({
  definition: {
    tool: 'confirm_observation',
    description:
      '教师确认归档观察：把确认内容写入 confirmed_content（可同事务应用 guide_decisions 指南决定）。' +
      '内容与 AI 草稿一致时直接归档；教师修改过内容时必须已有匹配的 Agent 复核 accept，' +
      '否则本次执行停在准备态并先保存复核结果，不消耗批准、不谎称已归档。' +
      '原文金句必须逐字来自 raw_text，raw_text 永不被改写。',
    auth: { kind: 'action', action: 'observation.confirm', resource: 'observation' },
    params: zodToolParams(confirmObservationParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const input = params as {
      observation_id: string;
      input: { content: { highlight_quote: string }; [key: string]: unknown };
    };
    const { observation, revision } = await observationPreparation(
      { params, context },
      'observation.confirm',
    );
    const forbidden = findDevelopmentForbiddenTerm(input.input.content);
    if (forbidden) {
      throw new YayaWriteProposeError(
        'invalid_params',
        `确认内容包含不适合写入成长记录的表述「${forbidden}」，请改为具体行为和语言。`,
      );
    }
    if (!isQuoteInRawText(observation.raw_text, input.input.content.highlight_quote)) {
      throw new YayaWriteProposeError(
        'invalid_params',
        '原文金句必须逐字来自观察原文的连续片段，不能改写或引用教师补充信息。',
      );
    }
    return {
      item_key: '',
      target_id: observation.id,
      action: 'observation.confirm',
      resource: 'observation',
      resource_ref: { kind: 'observation', observation_id: observation.id },
      payload: {
        kind: 'confirm_observation',
        observation_id: observation.id,
        input: input.input as Extract<
          YayaDomainPayload,
          { kind: 'confirm_observation' }
        >['input'],
      },
      attachment_associations: [],
      business_revision: revision,
    };
  },
  load: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'confirm_observation' }>;
    const observation = await getObservation(payload.observation_id);
    if (!observation) throw new YayaDataError('not_found', '观察记录不存在。');
    return { observation };
  },
  compute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'confirm_observation' }>;
    const { observation } = input.loaded as {
      observation: NonNullable<Awaited<ReturnType<typeof getObservation>>>;
    };
    if (observation.status === 'confirmed') {
      throw new YayaDataError('source_conflict', '该记录已确认归档，无需重复确认。');
    }
    if (observation.status !== 'ai_organized') {
      throw new YayaDataError('source_conflict', '请先生成并核对 AI 整理草稿，再进行确认归档。');
    }
    if (!observation.ai_draft) {
      throw new YayaDataError('source_conflict', '当前记录缺少 AI 原始草稿，不能进行教师修改审核。');
    }
    const submitted = payload.input.content;
    const forbidden = findDevelopmentForbiddenTerm(submitted);
    if (forbidden) {
      throw new YayaDataError(
        'invalid_request',
        `确认内容包含不适合写入成长记录的表述「${forbidden}」，请改为具体行为和语言。`,
      );
    }
    if (!isQuoteInRawText(observation.raw_text, submitted.highlight_quote)) {
      throw new YayaDataError(
        'invalid_request',
        '原文金句必须逐字来自观察原文的连续片段，不能改写或引用教师补充信息。',
      );
    }
    const normalizedContent = normalizeTeacherEditContent(submitted);
    const clarification = payload.input.clarification?.trim() || undefined;
    const clarifications = observation.agent_context?.teacher_edit_clarifications ?? [];
    const currentReview = observation.agent_context?.teacher_edit_review;
    const teacherNote = payload.input.teacher_note?.trim() || undefined;
    const normalizedNote = normalizeTeacherNote(teacherNote);
    const reviewMatches = Boolean(
      currentReview &&
        sameTeacherEditContent(currentReview.content_snapshot, submitted) &&
        sameClarificationSnapshot(currentReview, clarifications) &&
        sameTeacherEditNote(currentReview, normalizedNote),
    );
    const submissionAction = teacherEditSubmissionAction(
      observation.ai_draft,
      normalizedContent,
      currentReview,
      clarifications,
      normalizedNote,
    );
    const forwardHeaders = forwardHeadersOf(input);

    if (clarification) {
      if (!currentReview || currentReview.decision !== 'clarify' || !reviewMatches) {
        throw new YayaDataError(
          'invalid_request',
          '当前没有等待澄清的修改审核，请先提交修改或重新生成审核。',
        );
      }
      const nextClarifications = [
        ...clarifications,
        {
          question: currentReview.question,
          answer: clarification,
          created_at: new Date().toISOString(),
        },
      ];
      const reviewContext = withoutTeacherEditReview({
        ...(observation.agent_context ?? {}),
        teacher_edit_clarifications: nextClarifications,
      });
      const { review } = await reviewTeacherEdit(
        {
          rawText: observation.raw_text,
          originalDraft: observation.ai_draft,
          content: normalizedContent,
          teacherNote,
          agentContext: reviewContext,
          clarifications: nextClarifications,
          forwardHeaders,
        },
        input.invoke,
      );
      const savedContext: AgentContext = {
        ...reviewContext,
        teacher_edit_review: {
          ...review,
          content_snapshot: normalizedContent,
          clarification_snapshot: clarificationSnapshot(nextClarifications),
          note_snapshot: normalizedNote,
          reviewed_at: new Date().toISOString(),
        },
      };
      return {
        kind: 'needs_prepare',
        message: '已重新复核教师修改，请再次确认后归档。',
        notice: { agentReview: review, requires_agent_confirmation: true },
        prepare_write: async () => {
          await updateObservationAgentContext(
            observation.id,
            savedContext,
            'ai_organized',
            observationWriteGuard(observation),
          );
        },
      };
    }

    if (submissionAction === 'confirm') {
      const clearStaleReview = Boolean(currentReview && !reviewMatches);
      const premiseAgentContext = clearStaleReview
        ? withoutTeacherEditReview(observation.agent_context ?? {})
        : observation.agent_context ?? null;
      return {
        kind: 'proceed',
        data: {
          observationId: observation.id,
          childId: observation.child_id,
          aiDraft: observation.ai_draft,
          normalizedContent,
          teacherNote,
          premiseAgentContext,
          clearStaleReview,
          clearedContext: clearStaleReview ? premiseAgentContext : null,
          guard: observationWriteGuard(observation),
        },
      };
    }

    if (submissionAction === 'clarify' && currentReview) {
      return {
        kind: 'needs_prepare',
        message: '教师修改需要先回答 Agent 的澄清问题，请补充后再确认归档。',
        notice: { agentReview: currentReview, requires_agent_confirmation: true },
      };
    }

    const reviewContext = observation.agent_context
      ? withoutTeacherEditReview(observation.agent_context)
      : {};
    const { review } = await reviewTeacherEdit(
      {
        rawText: observation.raw_text,
        originalDraft: observation.ai_draft,
        content: normalizedContent,
        teacherNote,
        agentContext: reviewContext,
        clarifications,
        forwardHeaders,
      },
      input.invoke,
    );
    const savedContext: AgentContext = {
      ...reviewContext,
      teacher_edit_review: {
        ...review,
        content_snapshot: normalizedContent,
        clarification_snapshot: clarificationSnapshot(clarifications),
        note_snapshot: normalizedNote,
        reviewed_at: new Date().toISOString(),
      },
    };
    return {
      kind: 'needs_prepare',
      message:
        review.decision === 'accept'
          ? '已复核教师修改，请再次确认后归档。'
          : '教师修改未通过复核，请先澄清或调整内容。',
      notice: { agentReview: review, requires_agent_confirmation: true },
      prepare_write: async () => {
        if (currentReview) {
          await updateObservationAgentContext(
            observation.id,
            reviewContext,
            'ai_organized',
            observationWriteGuard(observation),
          );
          await updateObservationAgentContext(observation.id, savedContext, 'ai_organized', {
            expectedStatus: 'ai_organized',
            expectedAgentContext: reviewContext,
            expectedAiDraft: observation.ai_draft ?? null,
          });
          return;
        }
        await updateObservationAgentContext(
          observation.id,
          savedContext,
          'ai_organized',
          observationWriteGuard(observation),
        );
      },
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'confirm_observation' }>;
    const data = input.computed as {
      observationId: string;
      childId: string;
      aiDraft: ObservationDraft | null;
      clearStaleReview: boolean;
      premiseAgentContext: AgentContext | null;
      guard: ReturnType<typeof observationWriteGuard>;
    };
    if (data.clearStaleReview && data.premiseAgentContext) {
      await updateObservationAgentContextWithClient(
        input.client,
        data.observationId,
        data.premiseAgentContext,
        'ai_organized',
        data.guard,
      );
    }
    const guide = payload.input.guide_decisions
      ? {
          expectedRevision: payload.input.guide_decisions.expected_guide_revision,
          decisions: payload.input.guide_decisions.decisions,
        }
      : undefined;
    const confirmed = await confirmObservationWithClient(
      input.client,
      payload.observation_id,
      data.childId,
      { ...payload.input.content, teacher_note: payload.input.teacher_note },
      {
        status: 'ai_organized',
        agentContext: data.premiseAgentContext,
        aiDraft: data.aiDraft,
      },
      guide,
    );
    return successReceipt(confirmed.id, confirmed.updated_at);
  },
  ...defineObservationExecute((payload) =>
    (payload as Extract<YayaDomainPayload, { kind: 'confirm_observation' }>).observation_id,
  ),
});

/* -------------------------------- 指南决定 -------------------------------- */

const guideDecisionEntry = defineEntry({
  definition: {
    tool: 'guide_decision',
    description:
      '指南证据操作：suggest 触发 AI 关联建议并保存（事务外生成、事务内落账）；' +
      'confirm/reject/withdraw 提交教师决定，必须携带当前 expected_guide_revision，' +
      '全部决定先校验后写入（同一观察全有或全无）。',
    auth: { kind: 'action', action: 'guide.decide', resource: 'observation' },
    params: zodToolParams(guideDecisionParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const { observation, revision } = await observationPreparation(
      { params, context },
      'guide.decide',
    );
    const input = params as { mutation: Extract<YayaDomainPayload, { kind: 'guide_decision' }>['mutation'] };
    return {
      item_key: '',
      target_id: observation.id,
      action: 'guide.decide',
      resource: 'observation',
      resource_ref: { kind: 'observation', observation_id: observation.id },
      payload: {
        kind: 'guide_decision',
        observation_id: observation.id,
        mutation: input.mutation,
      },
      attachment_associations: [],
      business_revision: revision,
    };
  },
  load: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'guide_decision' }>;
    if (payload.mutation.action !== 'suggest') return null;
    const observation = await getObservation(payload.observation_id);
    if (!observation) throw new YayaDataError('not_found', '观察记录不存在。');
    const selected = await selectSuggestionCandidates(observation);
    const confirmedSources = await listObservations({
      childId: observation.child_id,
      status: 'confirmed',
    });
    const parsed = parseGuideEvidence(observation.guide_evidence);
    return {
      observation,
      candidates: selected.candidates,
      confirmedSources,
      expectedRevision: parsed.kind === 'ok' ? parsed.revision : 0,
    };
  },
  compute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'guide_decision' }>;
    if (payload.mutation.action !== 'suggest') return { kind: 'proceed', data: null };
    const data = input.loaded as {
      observation: NonNullable<Awaited<ReturnType<typeof getObservation>>>;
      candidates: Awaited<ReturnType<typeof selectSuggestionCandidates>>['candidates'];
      confirmedSources: Awaited<ReturnType<typeof listObservations>>;
      expectedRevision: number;
    };
    const generated = await generateGuideEvidenceSuggestions(data.observation, {
      forwardHeaders: forwardHeadersOf(input),
      invoke: input.invoke,
      candidates: data.candidates,
      confirmedSources: data.confirmedSources,
    });
    return {
      kind: 'proceed',
      data: {
        expectedRevision: data.expectedRevision,
        expectedStatus: data.observation.status,
        expectedRawText: data.observation.raw_text,
        expectedAiDraft: data.observation.ai_draft,
        expectedConfirmedContent: data.observation.confirmed_content,
        generated,
      },
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'guide_decision' }>;
    if (payload.mutation.action === 'suggest') {
      const data = input.computed as {
        expectedRevision: number;
        expectedStatus: ObservationStatus;
        expectedRawText: string;
        expectedAiDraft: unknown;
        expectedConfirmedContent: unknown;
        generated: Awaited<ReturnType<typeof generateGuideEvidenceSuggestions>>;
      };
      const saved = await saveGuideEvidenceSuggestionResultWithClient(
        input.client,
        payload.observation_id,
        {
          expectedRevision: data.expectedRevision,
          expectedStatus: data.expectedStatus,
          expectedRawText: data.expectedRawText,
          expectedAiDraft: data.expectedAiDraft as never,
          expectedConfirmedContent: data.expectedConfirmedContent as never,
          ok: data.generated.ok,
          model: data.generated.model,
          error: data.generated.ok ? undefined : data.generated.error,
          suggestions: data.generated.ok ? data.generated.suggestions : [],
        },
      );
      return successReceipt(saved.observation.id, saved.observation.updated_at);
    }
    const result = await applyGuideEvidenceMutationWithClient(
      input.client,
      payload.observation_id,
      payload.mutation,
    );
    return successReceipt(result.observation.id, result.observation.updated_at);
  },
  ...defineObservationExecute((payload) =>
    (payload as Extract<YayaDomainPayload, { kind: 'guide_decision' }>).observation_id,
  ),
});

/* -------------------------------- 建立档案 -------------------------------- */

const createChildEntry = defineEntry({
  definition: {
    tool: 'create_child',
    description:
      '在指定班级建立幼儿成长档案（管理员可全园建档；教师需目标班级在任教范围内）。' +
      '班级必须存在且未停用；姓名、性别、出生日期必填。',
    auth: { kind: 'action', action: 'child.create_profile', resource: 'class' },
    params: zodToolParams(createChildParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const input = params as {
      name: string;
      gender: '男' | '女' | '其他';
      birth_date: string;
      target_class_id: string;
      note?: string | null;
    };
    const klass = await getClassWithClient(context.client, input.target_class_id);
    if (!klass) throw new YayaWriteProposeError('failed', '目标班级不存在。');
    if (!klass.is_active) throw new YayaWriteProposeError('failed', `班级「${klass.name}」已停用，无法新增幼儿。`);
    const facts = await readFactsOrThrow(
      context.client,
      { kind: 'class', class_id: klass.id },
      context.school_id,
    );
    authorizeOrThrow(context.principal, 'child.create_profile', facts);
    return {
      item_key: '',
      target_id: klass.id,
      action: 'child.create_profile',
      resource: 'class',
      resource_ref: { kind: 'class', class_id: klass.id },
      payload: {
        kind: 'create_child',
        name: input.name,
        gender: input.gender,
        birth_date: input.birth_date,
        target_class_id: klass.id,
        note: input.note ?? null,
      },
      attachment_associations: [],
      business_revision: klass.updated_at,
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'create_child' }>;
    const klass = await getClassWithClient(input.client, payload.target_class_id);
    if (!klass) throw new YayaDataError('not_found', '目标班级不存在。');
    if (!klass.is_active) throw new YayaDataError('source_conflict', `班级「${klass.name}」已停用，无法新增幼儿。`);
    const child = await createChildWithClient(input.client, {
      name: payload.name,
      gender: payload.gender,
      birth_date: payload.birth_date,
      class_id: payload.target_class_id,
      note: payload.note ?? undefined,
    });
    return successReceipt(child.id, child.updated_at);
  },
  resolveBusinessRevision: async (client, context) => {
    const payload = context.proposal_item.payload as Extract<YayaDomainPayload, { kind: 'create_child' }>;
    const klass = await getClassWithClient(client, payload.target_class_id);
    return klass?.updated_at ?? null;
  },
});

/* -------------------------------- 幼儿转班 -------------------------------- */

const transferChildEntry = defineEntry({
  definition: {
    tool: 'transfer_child',
    description:
      '管理员把幼儿转入目标班级：结束旧归属并建立新归属，旧关系保留为历史。' +
      '目标班级必须存在且未停用；幼儿已在目标班时返回 unchanged（合法幂等）。',
    auth: { kind: 'action', action: 'child.transfer', resource: 'transfer' },
    params: zodToolParams(transferChildParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const input = params as { child_id: string; target_class_id: string; effective_date?: string };
    const facts = await readFactsOrThrow(
      context.client,
      { kind: 'transfer', child_id: input.child_id, target_class_id: input.target_class_id },
      context.school_id,
    );
    authorizeOrThrow(context.principal, 'child.transfer', facts);
    const child = await getChildWithClient(context.client, input.child_id);
    if (!child) throw new YayaWriteProposeError('failed', '幼儿不存在。');
    const klass = await getClassWithClient(context.client, input.target_class_id);
    if (!klass || !klass.is_active) {
      throw new YayaWriteProposeError('failed', '目标班级不存在或已停用。');
    }
    return {
      item_key: '',
      target_id: child.id,
      action: 'child.transfer',
      resource: 'transfer',
      resource_ref: {
        kind: 'transfer',
        child_id: child.id,
        target_class_id: klass.id,
      },
      payload: {
        kind: 'transfer_child',
        child_id: child.id,
        target_class_id: klass.id,
        effective_date: input.effective_date ?? null,
      },
      attachment_associations: [],
      business_revision: child.updated_at,
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'transfer_child' }>;
    const child = await getChildWithClient(input.client, payload.child_id);
    if (!child) throw new YayaDataError('not_found', '幼儿不存在。');
    if (child.class_id === payload.target_class_id) {
      return {
        status: 'unchanged',
        effect: 'committed',
        business_object_id: child.id,
        business_revision: child.updated_at,
      };
    }
    const klass = await getClassWithClient(input.client, payload.target_class_id);
    if (!klass) throw new YayaDataError('not_found', '目标班级不存在。');
    if (!klass.is_active) throw new YayaDataError('source_conflict', `班级「${klass.name}」已停用，无法分班。`);
    await enrollChildInClassWithClient(input.client, {
      child_id: child.id,
      class_id: klass.id,
      start_date: payload.effective_date ?? undefined,
    });
    const updated = await getChildWithClient(input.client, child.id);
    return successReceipt(child.id, updated?.updated_at ?? null);
  },
  resolveBusinessRevision: async (client, context) => {
    const payload = context.proposal_item.payload as Extract<YayaDomainPayload, { kind: 'transfer_child' }>;
    const child = await getChildWithClient(client, payload.child_id);
    return child?.updated_at ?? null;
  },
});

/* -------------------------------- 班级管理 -------------------------------- */

const manageClassEntry = defineEntry({
  definition: {
    tool: 'manage_class',
    description:
      '管理员新建或修改班级（create/update）。update 提交完整的名称/学段/学年与可选启停；' +
      '已有分班或观察历史的班级改学段/学年会被拒绝（请新建学年班级并转班）。',
    auth: { kind: 'action', action: 'class.manage', resource: 'class' },
    params: zodToolParams(manageClassParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const input = params as
      | { operation: 'create'; name: string; stage: 'small' | 'middle' | 'large'; school_year: string; is_active?: boolean }
      | { operation: 'update'; class_id: string; name: string; stage: 'small' | 'middle' | 'large'; school_year: string; is_active?: boolean };
    if (input.operation === 'create') {
      const facts = await readFactsOrThrow(
        context.client,
        { kind: 'class', class_id: null },
        context.school_id,
      );
      authorizeOrThrow(context.principal, 'class.manage', facts);
      return {
        item_key: '',
        target_id: 'new-class',
        action: 'class.manage',
        resource: 'class',
        resource_ref: { kind: 'class', class_id: null },
        payload: {
          kind: 'manage_class',
          operation: 'create',
          class_id: null,
          name: input.name,
          stage: input.stage,
          school_year: input.school_year,
          is_active: input.is_active ?? true,
        },
        attachment_associations: [],
        business_revision: null,
      };
    }
    const klass = await getClassWithClient(context.client, input.class_id);
    if (!klass) throw new YayaWriteProposeError('failed', '班级不存在。');
    const facts = await readFactsOrThrow(
      context.client,
      { kind: 'class', class_id: klass.id },
      context.school_id,
    );
    authorizeOrThrow(context.principal, 'class.manage', facts);
    return {
      item_key: '',
      target_id: klass.id,
      action: 'class.manage',
      resource: 'class',
      resource_ref: { kind: 'class', class_id: klass.id },
      payload: {
        kind: 'manage_class',
        operation: 'update',
        class_id: klass.id,
        name: input.name,
        stage: input.stage,
        school_year: input.school_year,
        is_active: input.is_active ?? klass.is_active,
      },
      attachment_associations: [],
      business_revision: klass.updated_at,
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'manage_class' }>;
    if (payload.operation === 'create') {
      const existing = await findClassByNameWithClient(input.client, payload.name, payload.school_year);
      if (existing) {
        throw new YayaDataError('source_conflict', `同学年下已存在同名班级「${payload.name}」。`);
      }
      const created = await createClassWithClient(input.client, {
        name: payload.name,
        stage: payload.stage,
        school_year: payload.school_year,
        is_active: payload.is_active ?? true,
      });
      return successReceipt(created.id, created.updated_at);
    }
    if (!payload.class_id) throw new YayaDataError('invalid_request', '缺少班级标识。');
    const existing = await findClassByNameWithClient(input.client, payload.name, payload.school_year);
    if (existing && existing.id !== payload.class_id) {
      throw new YayaDataError('source_conflict', `同学年下已存在同名班级「${payload.name}」。`);
    }
    let updated;
    try {
      updated = await updateClassWithClient(input.client, payload.class_id, {
        name: payload.name,
        stage: payload.stage,
        school_year: payload.school_year,
        is_active: payload.is_active ?? undefined,
      });
    } catch (error) {
      if (error instanceof ClassHistoryProtectedError) {
        throw new YayaDataError('source_conflict', error.message);
      }
      throw error;
    }
    if (!updated) throw new YayaDataError('not_found', '班级不存在。');
    return successReceipt(updated.id, updated.updated_at);
  },
  resolveBusinessRevision: async (client, context) => {
    const payload = context.proposal_item.payload as Extract<YayaDomainPayload, { kind: 'manage_class' }>;
    if (payload.operation !== 'update' || !payload.class_id) return null;
    const klass = await getClassWithClient(client, payload.class_id);
    return klass?.updated_at ?? null;
  },
});

/* -------------------------------- 教师管理（无密码动作） -------------------------------- */

const manageTeacherEntry = defineEntry({
  definition: {
    tool: 'manage_teacher',
    description:
      '管理员管理教师账号：启停（set_status）、分配任教（assign_class）、撤销任教（remove_assignment）。' +
      '新建教师账号与重置密码包含口令，必须由管理员在教师管理页的安全控件中直接提交服务端，' +
      '禁止经聊天/模型/本工具；本工具不接受任何密码字段，也不存在对应操作。',
    auth: { kind: 'action', action: 'teacher.manage', resource: 'school' },
    params: zodToolParams(manageTeacherParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const input = params as
      | { operation: 'set_status'; teacher_account_id: string; status: 'active' | 'disabled' }
      | { operation: 'assign_class' | 'remove_assignment'; teacher_account_id: string; class_id: string };
    if (input.operation === 'set_status') {
      const facts = await readFactsOrThrow(context.client, { kind: 'school' }, context.school_id);
      authorizeOrThrow(context.principal, 'teacher.manage', facts);
      const revision = await getTeacherAccountRevisionWithClient(
        context.client,
        input.teacher_account_id,
      );
      return {
        item_key: '',
        target_id: context.school_id,
        action: 'teacher.manage',
        resource: 'school',
        resource_ref: { kind: 'school' },
        payload: {
          kind: 'manage_teacher',
          operation: 'set_status',
          teacher_account_id: input.teacher_account_id,
          username: null,
          display_name: null,
          class_ids: [],
          status: input.status,
          secret_via_secure_control: true,
        },
        attachment_associations: [],
        business_revision: revision,
      };
    }
    const facts = await readFactsOrThrow(
      context.client,
      { kind: 'class', class_id: input.class_id },
      context.school_id,
    );
    authorizeOrThrow(context.principal, 'teacher.assign', facts);
    const klass = await getClassWithClient(context.client, input.class_id);
    return {
      item_key: '',
      target_id: input.class_id,
      action: 'teacher.assign',
      resource: 'class',
      resource_ref: { kind: 'class', class_id: input.class_id },
      payload: {
        kind: 'manage_teacher',
        operation: input.operation,
        teacher_account_id: input.teacher_account_id,
        username: null,
        display_name: null,
        class_ids: [input.class_id],
        status: null,
        secret_via_secure_control: true,
      },
      attachment_associations: [],
      business_revision: klass?.updated_at ?? null,
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'manage_teacher' }>;
    if (
      payload.operation !== 'set_status' &&
      payload.operation !== 'assign_class' &&
      payload.operation !== 'remove_assignment'
    ) {
      throw new YayaDataError(
        'invalid_request',
        '教师创建与密码重置只能通过教师管理页的安全控件完成。',
      );
    }
    if (!payload.teacher_account_id) throw new YayaDataError('invalid_request', '缺少教师账号标识。');
    let teacher;
    if (payload.operation === 'set_status') {
      if (payload.status === null) throw new YayaDataError('invalid_request', '缺少目标状态。');
      teacher = (
        await setTeacherStatusWithClient(input.client, payload.teacher_account_id, payload.status)
      ).teacher;
    } else {
      const classId = payload.class_ids[0];
      if (!classId) throw new YayaDataError('invalid_request', '缺少班级标识。');
      teacher =
        payload.operation === 'assign_class'
          ? await assignTeacherClassWithClient(
              input.client,
              payload.teacher_account_id,
              classId,
              input.principal.account_id,
            )
          : await unassignTeacherClassWithClient(
              input.client,
              payload.teacher_account_id,
              classId,
              input.principal.account_id,
            );
    }
    return successReceipt(teacher.account_id, teacher.updated_at);
  },
  resolveBusinessRevision: async (client, context) => {
    const payload = context.proposal_item.payload as Extract<YayaDomainPayload, { kind: 'manage_teacher' }>;
    if (payload.operation === 'set_status') {
      return payload.teacher_account_id
        ? getTeacherAccountRevisionWithClient(client, payload.teacher_account_id)
        : null;
    }
    const classId = payload.class_ids[0];
    if (!classId) return null;
    const klass = await getClassWithClient(client, classId);
    return klass?.updated_at ?? null;
  },
});

/* -------------------------------- 成长小结 / 活动支持 -------------------------------- */

function childWritePreparation(
  input: { params: unknown; context: YayaWritePrepareContext },
  action: AccessAction,
): Promise<{ child: NonNullable<Awaited<ReturnType<typeof getChildWithClient>>> }> {
  const params = input.params as { child_id: string };
  return (async () => {
    const child = await getChildWithClient(input.context.client, params.child_id);
    if (!child) throw new YayaWriteProposeError('failed', '幼儿档案不存在。');
    const facts = await readFactsOrThrow(
      input.context.client,
      { kind: 'child', child_id: child.id },
      input.context.school_id,
    );
    authorizeOrThrow(input.context.principal, action, facts);
    return { child };
  })();
}

function childBusinessRevision(action: AccessAction) {
  return async (client: TransactionClient, context: { proposal_item: YayaProposalItem }) => {
    const payload = context.proposal_item.payload as { kind: string; child_id?: string };
    if (!payload.child_id) return null;
    const child = await getChildWithClient(client, payload.child_id);
    return child?.updated_at ?? null;
  };
}

const refreshGrowthProfileEntry = defineEntry({
  definition: {
    tool: 'refresh_growth_profile',
    description:
      '按已确认观察重新生成幼儿成长小结（事务外模型生成，保存时核对已确认观察依据集未变化）。' +
      '没有已确认观察时准备失败。',
    auth: { kind: 'action', action: 'growth_profile.write', resource: 'child' },
    params: zodToolParams(refreshGrowthProfileParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const { child } = await childWritePreparation({ params, context }, 'growth_profile.write');
    return {
      item_key: '',
      target_id: child.id,
      action: 'growth_profile.write',
      resource: 'child',
      resource_ref: { kind: 'child', child_id: child.id },
      payload: { kind: 'refresh_growth_profile', child_id: child.id },
      attachment_associations: [],
      business_revision: child.updated_at,
    };
  },
  load: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'refresh_growth_profile' }>;
    const child = await getChild(payload.child_id);
    if (!child) throw new YayaDataError('not_found', '成长档案不存在。');
    const observations = await listObservations({ childId: child.id, status: 'confirmed' });
    return { child, observations };
  },
  compute: async (input) => {
    const { child, observations } = input.loaded as {
      child: NonNullable<Awaited<ReturnType<typeof getChild>>>;
      observations: Awaited<ReturnType<typeof listObservations>>;
    };
    if (!observations.some((observation) => observation.confirmed_content)) {
      throw new YayaDataError('invalid_request', '还没有已确认的观察，暂时不能更新成长小结。');
    }
    const plan = await generateGrowthProfileUpdate(child, observations, {
      forwardHeaders: forwardHeadersOf(input),
      invoke: input.invoke,
    });
    return { kind: 'proceed', data: plan };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'refresh_growth_profile' }>;
    const plan = input.computed as Awaited<ReturnType<typeof generateGrowthProfileUpdate>>;
    let saved;
    try {
      saved = await updateChildGrowthProfileSummaryWithClient(
        input.client,
        payload.child_id,
        plan.growth_profile,
        plan.expected_confirmed_ids,
      );
    } catch (error) {
      if (error instanceof StaleEvidenceError) {
        throw new YayaDataError(
          'approval_invalid',
          '生成期间已有新的已确认观察，成长小结未写入，请重新核对。',
        );
      }
      throw error;
    }
    return successReceipt(saved.id, saved.updated_at);
  },
  resolveBusinessRevision: childBusinessRevision('growth_profile.write'),
});

const refreshActivitySupportEntry = defineEntry({
  definition: {
    tool: 'refresh_activity_support',
    description:
      '按已确认观察生成幼儿活动支持建议（事务外模型生成，保存时核对依据集未变化）。' +
      '没有已确认观察时停在准备态，不消耗批准。',
    auth: { kind: 'action', action: 'activity_support.write', resource: 'child' },
    params: zodToolParams(refreshActivitySupportParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const { child } = await childWritePreparation({ params, context }, 'activity_support.write');
    return {
      item_key: '',
      target_id: child.id,
      action: 'activity_support.write',
      resource: 'child',
      resource_ref: { kind: 'child', child_id: child.id },
      payload: { kind: 'refresh_activity_support', child_id: child.id },
      attachment_associations: [],
      business_revision: child.updated_at,
    };
  },
  load: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'refresh_activity_support' }>;
    const child = await getChild(payload.child_id);
    if (!child) throw new YayaDataError('not_found', '成长档案不存在。');
    const observations = await listObservations({ childId: child.id, status: 'confirmed' });
    return { child, observations };
  },
  compute: async (input) => {
    const { child, observations } = input.loaded as {
      child: NonNullable<Awaited<ReturnType<typeof getChild>>>;
      observations: Awaited<ReturnType<typeof listObservations>>;
    };
    if (
      !observations.some(
        (observation) => observation.status === 'confirmed' && observation.confirmed_content,
      )
    ) {
      return {
        kind: 'needs_prepare',
        message: '还没有已确认的观察，请先确认一条观察后再生成活动支持。',
      };
    }
    const plan = await generateActivitySupportUpdate(child, observations, {
      forwardHeaders: forwardHeadersOf(input),
      invoke: input.invoke,
    });
    return { kind: 'proceed', data: plan };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'refresh_activity_support' }>;
    const plan = input.computed as Awaited<ReturnType<typeof generateActivitySupportUpdate>>;
    let saved;
    try {
      saved = await updateChildActivitySupportWithClient(
        input.client,
        payload.child_id,
        plan.activity_support,
        plan.fallback_profile,
        plan.expected_confirmed_ids,
      );
    } catch (error) {
      if (error instanceof StaleEvidenceError) {
        throw new YayaDataError(
          'approval_invalid',
          '生成期间已有新的已确认观察，活动支持未写入，请重新核对。',
        );
      }
      throw error;
    }
    return successReceipt(saved.id, saved.updated_at);
  },
  resolveBusinessRevision: childBusinessRevision('activity_support.write'),
});

/* ------------------------------ 归档后追加资料图片 ------------------------------ */

const attachObservationImagesEntry = defineEntry({
  definition: {
    tool: 'attach_observation_images',
    description:
      '向已确认归档的观察追加资料图片：不改写 raw_text/confirmed_content，不自动成为指南依据。' +
      '必须携带当前 expected_attachment_revision 与宿主的 source_confirmed_at；' +
      '只允许关联本人上传且 ready 的图片。',
    auth: { kind: 'action', action: 'observation.write', resource: 'child' },
    params: zodToolParams(attachObservationImagesParamsSchema),
  },
  prepare: async ({ params, context }) => {
    const input = params as {
      observation_id: string;
      image_ids: readonly string[];
      expected_attachment_revision: number;
      source_confirmed_at: string | null;
    };
    const observation = await getObservationWithClient(context.client, input.observation_id);
    if (!observation) throw new YayaWriteProposeError('failed', '观察记录不存在。');
    const child = await getChildWithClient(context.client, observation.child_id);
    if (!child) throw new YayaWriteProposeError('failed', '关联幼儿档案不存在。');
    const facts = await readFactsOrThrow(
      context.client,
      { kind: 'child', child_id: child.id },
      context.school_id,
    );
    authorizeOrThrow(context.principal, 'observation.write', facts);
    if (observation.status !== 'confirmed' || observation.confirmed_at === null) {
      throw new YayaWriteProposeError('failed', '只有已确认归档的观察才能追加资料附件。');
    }
    return {
      item_key: '',
      target_id: child.id,
      action: 'observation.write',
      resource: 'child',
      resource_ref: { kind: 'child', child_id: child.id },
      payload: {
        kind: 'attach_observation_images',
        observation_id: observation.id,
        image_ids: [...input.image_ids],
        expected_attachment_revision: input.expected_attachment_revision,
        source_confirmed_at: input.source_confirmed_at,
      },
      attachment_associations: input.image_ids.map((imageId) => ({
        attachment_id: imageId,
        target_id: observation.id,
      })),
      business_revision: null,
    };
  },
  execute: async (input) => {
    const payload = input.payload as Extract<YayaDomainPayload, { kind: 'attach_observation_images' }>;
    const observation = await getObservationWithClient(input.client, payload.observation_id);
    if (!observation) throw new YayaDataError('not_found', '观察记录不存在。');
    const child = await getChildWithClient(input.client, observation.child_id);
    if (!child) throw new YayaDataError('not_found', '关联幼儿档案不存在。');
    const result = await appendObservationImages(boundMediaDeps(input.client, input.store), {
      host: hostFacts(observation, child),
      principal: input.principal,
      image_ids: payload.image_ids,
      expected_attachment_revision: payload.expected_attachment_revision,
      source_confirmed_at: payload.source_confirmed_at,
      request_id: input.request_id,
      approval_id: input.approval_id,
    });
    return successReceipt(payload.observation_id, String(result.attachment_revision));
  },
});

/* ------------------------------- 注册表导出 ------------------------------- */

const ALL_ENTRIES: readonly YayaWriteToolEntry[] = [
  createObservationEntry,
  organizeObservationEntry,
  followUpObservationEntry,
  confirmObservationEntry,
  guideDecisionEntry,
  createChildEntry,
  transferChildEntry,
  manageClassEntry,
  manageTeacherEntry,
  refreshGrowthProfileEntry,
  refreshActivitySupportEntry,
  attachObservationImagesEntry,
];

export function createYayaWriteRegistry(): YayaWriteRegistry {
  const entries = [...ALL_ENTRIES];
  const byTool = new Map(entries.map((entry) => [entry.definition.tool, entry]));
  return {
    entries,
    definitions: entries.map((entry) => entry.definition),
    find: (tool) => byTool.get(tool),
  };
}

export function forwardHeadersOf(input: YayaWriteComputeInput): Record<string, string> {
  // HeaderCarrier.headers 是最小读取接口；生产路径实际为 Next Headers。
  return HeaderUtils.extractForwardHeaders(input.request.headers as unknown as Headers);
}

/* ------------------------------- 准备结果转提案 ------------------------------- */

export function toPrepareItemInput(
  prepared: YayaWritePreparedItem,
): {
  item_key: string;
  target_id: string;
  action: AccessAction;
  resource: AccessResourceKind;
  resource_ref: YayaWritePreparedItem['resource_ref'];
  payload: YayaDomainPayload;
  attachment_associations: YayaWritePreparedItem['attachment_associations'];
  business_revision: string | null;
} {
  return {
    item_key: randomUUID(),
    target_id: prepared.target_id,
    action: prepared.action,
    resource: prepared.resource,
    resource_ref: prepared.resource_ref,
    payload: prepared.payload,
    attachment_associations: prepared.attachment_associations,
    business_revision: prepared.business_revision,
  };
}
