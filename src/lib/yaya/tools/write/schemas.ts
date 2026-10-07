/**
 * TOOLS1 写工具参数 schema：与模型可见 JSON Schema 同源（zodToolParams）。
 *
 * - 全部 strict：未知字段（含 principal/role/scope/approved/password 等自报或秘密字段）直接拒绝；
 * - 密码字段不存在：教师创建/重置密码不注册为可执行写工具，只走现有安全控件入口；
 * - 复用既有业务校验：观察/确认/指南决定无损复用 ConfirmObservationInput /
 *   GuideEvidenceMutationRequest 的 Zod 形状，不维护第二套协议。
 */
import { z } from 'zod';

import { MEDIA_MAX_IMAGES_PER_UPLOAD } from '@/lib/media/limits';
import { CLASS_STAGES, FIVE_DOMAINS } from '@/lib/types';
import { parseIsoDateStrict } from '@/lib/format';
import { YayaDataError } from '@/lib/yaya/storage-types';
import type { YayaDomainPayload, YayaPayloadKind } from '@/lib/yaya/types';
import {
  confirmObservationSchema,
  guideEvidenceMutationSchema,
} from '@/lib/validation';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHOOL_YEAR_RE = /^\d{4}-\d{4}$/;

const uuid = (label: string) => z.string().regex(UUID_RE, `${label}标识不合法`);
const calendarDate = (label: string) =>
  z
    .string()
    .regex(DATE_RE, `${label}格式应为 YYYY-MM-DD`)
    .refine((value) => parseIsoDateStrict(value) !== null, `${label}不是真实存在的日历日期`);
const observationId = z.string().min(1).max(64);

export const createObservationParamsSchema = z.strictObject({
  child_id: uuid('幼儿'),
  observed_at: calendarDate('观察日期'),
  raw_text: z.string().min(10, '观察原文至少 10 个字').max(5000, '观察原文最长 5000 字'),
  context: z.string().max(200).nullish(),
  confirmed_class_id: uuid('班级').optional(),
  image_ids: z
    .array(z.string().min(1))
    .max(MEDIA_MAX_IMAGES_PER_UPLOAD)
    .refine((ids) => new Set(ids).size === ids.length, '同一张图片不能重复关联')
    .optional()
    .default([]),
});

export const organizeObservationParamsSchema = z.strictObject({
  observation_id: observationId,
});

export const followUpObservationParamsSchema = z
  .strictObject({
    observation_id: observationId,
    action: z.enum(['answer', 'skip', 'stop']),
    content: z.string().max(2000).optional().default(''),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'answer' && !value.content.trim()) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: '请填写补充信息，或选择跳过/停止追问' });
    }
  });

export const confirmObservationParamsSchema = z.strictObject({
  observation_id: observationId,
  input: confirmObservationSchema.strict(),
});

export const guideDecisionParamsSchema = z.strictObject({
  observation_id: observationId,
  mutation: guideEvidenceMutationSchema,
});

export const createChildParamsSchema = z.strictObject({
  name: z.string().min(1, '请填写姓名').max(50),
  gender: z.enum(['男', '女', '其他'], { message: '请选择性别' }),
  birth_date: calendarDate('出生日期'),
  target_class_id: uuid('班级'),
  note: z.string().max(2000).nullish(),
});

export const transferChildParamsSchema = z.strictObject({
  child_id: uuid('幼儿'),
  target_class_id: uuid('班级'),
  effective_date: calendarDate('生效日期').optional(),
});

export const manageClassParamsSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'),
    name: z.string().min(1, '请填写班级名称').max(50, '班级名称最长 50 字'),
    stage: z.enum(CLASS_STAGES, { message: '学段须为 small（小班）/ middle（中班）/ large（大班）' }),
    school_year: z.string().regex(SCHOOL_YEAR_RE, '学年格式应为 2026-2027'),
    is_active: z.boolean().optional(),
  }),
  z.strictObject({
    operation: z.literal('update'),
    class_id: uuid('班级'),
    name: z.string().min(1, '请填写班级名称').max(50, '班级名称最长 50 字'),
    stage: z.enum(CLASS_STAGES, { message: '学段须为 small（小班）/ middle（中班）/ large（大班）' }),
    school_year: z.string().regex(SCHOOL_YEAR_RE, '学年格式应为 2026-2027'),
    is_active: z.boolean().optional(),
  }),
]);

/**
 * 教师管理可执行动作（仅管理员）；`create` / `reset_password` 不在其中：
 * 密码只进现有安全控件与专门服务端入口，不经聊天/模型/提案 payload。
 */
export const manageTeacherParamsSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('set_status'),
    teacher_account_id: uuid('教师账号'),
    status: z.enum(['active', 'disabled']),
  }),
  z.strictObject({
    operation: z.literal('assign_class'),
    teacher_account_id: uuid('教师账号'),
    class_id: uuid('班级'),
  }),
  z.strictObject({
    operation: z.literal('remove_assignment'),
    teacher_account_id: uuid('教师账号'),
    class_id: uuid('班级'),
  }),
]);

export const refreshGrowthProfileParamsSchema = z.strictObject({
  child_id: uuid('幼儿'),
});

export const refreshActivitySupportParamsSchema = z.strictObject({
  child_id: uuid('幼儿'),
});

export const attachObservationImagesParamsSchema = z.strictObject({
  observation_id: observationId,
  image_ids: z
    .array(z.string().min(1))
    .min(1, '请至少选择一张图片')
    .max(MEDIA_MAX_IMAGES_PER_UPLOAD, `每次最多关联 ${MEDIA_MAX_IMAGES_PER_UPLOAD} 张图片`)
    .refine((ids) => new Set(ids).size === ids.length, '同一张图片不能重复关联'),
  expected_attachment_revision: z.number().int().min(0),
  source_confirmed_at: z.string().min(1).max(64).nullable(),
});

export type CreateObservationParams = z.infer<typeof createObservationParamsSchema>;
export type OrganizeObservationParams = z.infer<typeof organizeObservationParamsSchema>;
export type FollowUpObservationParams = z.infer<typeof followUpObservationParamsSchema>;
export type ConfirmObservationParams = z.infer<typeof confirmObservationParamsSchema>;
export type GuideDecisionParams = z.infer<typeof guideDecisionParamsSchema>;
export type CreateChildParams = z.infer<typeof createChildParamsSchema>;
export type TransferChildParams = z.infer<typeof transferChildParamsSchema>;
export type ManageClassParams = z.infer<typeof manageClassParamsSchema>;
export type ManageTeacherParams = z.infer<typeof manageTeacherParamsSchema>;
export type RefreshGrowthProfileParams = z.infer<typeof refreshGrowthProfileParamsSchema>;
export type RefreshActivitySupportParams = z.infer<typeof refreshActivitySupportParamsSchema>;
export type AttachObservationImagesParams = z.infer<typeof attachObservationImagesParamsSchema>;

/** 模型可见枚举的单一来源（与 schema 同源，仅供描述文案引用） */
export const OBSERVATION_DOMAIN_ENUM = FIVE_DOMAINS;

/* ---------------------- 保存 payload 的形状校验（执行/公开准备入口） ----------------------
 * 与 `YayaDomainPayload` 同构的 12 个 kind：
 * - 只查形状与格式：不重复工具参数的业务长度规则（如观察原文 ≥10 字），
 *   公开准备的合成夹具与服务端派生 payload 都必须原样通过；
 * - 密码类操作（manage_teacher create/reset_password）不在表内，按未注册 kind 拒绝；
 * - payload ↔ 声明元数据绑定不在这里（公开准备允许声明与 payload 分开校验），
 *   由执行入口 loadOperations 的 `assertProposalItemBinding` 负责。
 */
const payloadContext = z.string().max(5000).nullable();
const payloadNote = z.string().max(2000).nullable();
const payloadSourceInput = z.union([z.null(), z.record(z.string(), z.unknown())]);
const payloadIsNullableBoolean = z.boolean().nullable();

const manageClassPayloadSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    kind: z.literal('manage_class'),
    operation: z.literal('create'),
    class_id: z.null(),
    name: z.string().min(1).max(50),
    stage: z.enum(CLASS_STAGES),
    school_year: z.string().regex(SCHOOL_YEAR_RE),
    is_active: payloadIsNullableBoolean,
  }),
  z.strictObject({
    kind: z.literal('manage_class'),
    operation: z.literal('update'),
    class_id: uuid('班级'),
    name: z.string().min(1).max(50),
    stage: z.enum(CLASS_STAGES),
    school_year: z.string().regex(SCHOOL_YEAR_RE),
    is_active: payloadIsNullableBoolean,
  }),
]);

const manageTeacherStatus = z.enum(['active', 'disabled']);
// 单操作恰好一个班级：多班必须由既有多 operation 计划表达，禁止“只读第一班”的静默部分执行
const manageTeacherSingleClassIds = z
  .array(uuid('班级'))
  .length(1, '每次只能处理一个班级，多班请拆分为多个操作');
const manageTeacherPayloadSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    kind: z.literal('manage_teacher'),
    operation: z.literal('set_status'),
    teacher_account_id: uuid('教师账号'),
    username: z.string().nullable(),
    display_name: z.string().nullable(),
    class_ids: z.array(uuid('班级')).length(0, '教师状态操作不携带班级'),
    status: manageTeacherStatus,
    secret_via_secure_control: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal('manage_teacher'),
    operation: z.literal('assign_class'),
    teacher_account_id: uuid('教师账号'),
    username: z.string().nullable(),
    display_name: z.string().nullable(),
    class_ids: manageTeacherSingleClassIds,
    status: z.null(),
    secret_via_secure_control: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal('manage_teacher'),
    operation: z.literal('remove_assignment'),
    teacher_account_id: uuid('教师账号'),
    username: z.string().nullable(),
    display_name: z.string().nullable(),
    class_ids: manageTeacherSingleClassIds,
    status: z.null(),
    secret_via_secure_control: z.literal(true),
  }),
]);

export const yayaWritePayloadSchemas = {
  create_observation: z.strictObject({
    kind: z.literal('create_observation'),
    child_id: uuid('幼儿'),
    observed_at: calendarDate('观察日期'),
    raw_text: z.string().min(1, '观察原文不能为空').max(5000, '观察原文最长 5000 字'),
    context: payloadContext,
    confirmed_class_id: uuid('班级').nullable(),
    image_ids: z.array(z.string().min(1)).max(MEDIA_MAX_IMAGES_PER_UPLOAD),
    source_input: payloadSourceInput,
  }),
  organize_observation: z.strictObject({
    kind: z.literal('organize_observation'),
    observation_id: observationId,
  }),
  follow_up_observation: z.strictObject({
    kind: z.literal('follow_up_observation'),
    observation_id: observationId,
    action: z.enum(['answer', 'skip', 'stop']),
    content: z.string().max(2000),
  }),
  confirm_observation: z.strictObject({
    kind: z.literal('confirm_observation'),
    observation_id: observationId,
    input: confirmObservationSchema.strict(),
  }),
  guide_decision: z.strictObject({
    kind: z.literal('guide_decision'),
    observation_id: observationId,
    mutation: guideEvidenceMutationSchema,
  }),
  create_child: z.strictObject({
    kind: z.literal('create_child'),
    name: z.string().min(1).max(50),
    gender: z.enum(['男', '女', '其他']),
    birth_date: calendarDate('出生日期'),
    target_class_id: uuid('班级'),
    note: payloadNote,
  }),
  transfer_child: z.strictObject({
    kind: z.literal('transfer_child'),
    child_id: uuid('幼儿'),
    target_class_id: uuid('班级'),
    effective_date: calendarDate('生效日期').nullable(),
  }),
  manage_class: manageClassPayloadSchema,
  manage_teacher: manageTeacherPayloadSchema,
  refresh_growth_profile: z.strictObject({
    kind: z.literal('refresh_growth_profile'),
    child_id: uuid('幼儿'),
  }),
  refresh_activity_support: z.strictObject({
    kind: z.literal('refresh_activity_support'),
    child_id: uuid('幼儿'),
  }),
  attach_observation_images: z.strictObject({
    kind: z.literal('attach_observation_images'),
    observation_id: observationId,
    image_ids: z.array(z.string().min(1)).min(1).max(MEDIA_MAX_IMAGES_PER_UPLOAD),
    expected_attachment_revision: z.number().int().min(0),
    source_confirmed_at: z.string().min(1).max(64).nullable(),
  }),
} satisfies Record<YayaPayloadKind, z.ZodType>;

/**
 * 按 kind 分派的保存 payload 校验：表外 kind（含密码类操作）与形状不合法
 * 一律 `invalid_request`。公开准备入口只做本校验；执行入口先本校验、再做绑定。
 */
export function parseWritePayload(value: unknown): YayaDomainPayload {
  if (typeof value !== 'object' || value === null) {
    throw new YayaDataError('invalid_request', 'payload 不合法。');
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    throw new YayaDataError('invalid_request', 'payload 不合法。');
  }
  // own-property 限定：`__proto__`/`constructor`/`toString` 等继承属性不得命中表
  if (!Object.hasOwn(yayaWritePayloadSchemas, kind)) {
    throw new YayaDataError('invalid_request', `未注册的写操作：${kind}`);
  }
  const schema = yayaWritePayloadSchemas[kind as YayaPayloadKind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new YayaDataError('invalid_request', 'payload 不合法。', {
      reasons: parsed.error.issues.map((issue) => issue.code),
    });
  }
  return parsed.data as YayaDomainPayload;
}
