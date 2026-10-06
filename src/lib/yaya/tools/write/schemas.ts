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
