import { z } from "zod";

import {
  CLASS_STAGES,
  OBSERVATION_STATUSES,
  type AgentContext,
  type ObservationDraft,
  type TeacherEditReviewOutput,
} from "@/lib/types";

import {
  GUIDE_CLASS_SNAPSHOT_SOURCES,
  GUIDE_EVIDENCE_LINK_ORIGINS,
  GUIDE_EVIDENCE_LINK_STATUSES,
  GUIDE_EVIDENCE_QUOTE_FIELDS,
  GUIDE_EVIDENCE_QUOTE_SOURCES,
  GUIDE_EVIDENCE_SUPPORT_KINDS,
} from "./types";
import type { EvidenceLinkView, GuideEvidenceDecisionInput } from "./view-types";

/**
 * 指南写入结果的响应核对（G6-WRITE1-R1，客户端安全）。
 *
 * - 只有形状完整、宿主一致、links 可解析的响应才可能被视为成功；
 * - HTTP 200 + 空对象/缺字段/非法 JSON/错误宿主/非法 links 一律不能显示成功；
 * - 幂等结果允许 revision 不递增；AI 失败 notice 与“没有新增建议”区分；
 * - 读回列表未找到宿主时返回 not_found（不可据此证明“未写入”）。
 */

const EXCLUSION_REASONS = [
  "workflow_pending",
  "teacher_rejected",
  "withdrawn",
  "basis_invalid",
  "basis_out_of_period",
  "catalog_mismatch",
  "support_insufficient",
  "history_unknown",
  "out_of_stage_evidence",
  "unknown_status",
] as const;

const BASIS_INVALID_REASONS = [
  "source_missing",
  "cross_child",
  "not_confirmed",
  "quote_not_found",
  "version_mismatch",
] as const;

const periodNoteSchema = z.object({
  period_start: z.string().min(1),
  period_end: z.string().min(1),
  description: z.string(),
});

const classSnapshotSchema = z.object({
  class_id: z.string().min(1),
  class_name: z.string().min(1),
  stage: z.enum(CLASS_STAGES),
  school_year: z.string().min(1),
  captured_at: z.string().min(1),
  source: z.enum(GUIDE_CLASS_SNAPSHOT_SOURCES),
  enrollment_id: z.string().nullable().optional(),
  confirmed_at: z.string().nullable().optional(),
});

const basisViewSchema = z.object({
  observation_id: z.string().min(1),
  observed_at: z.string().min(1),
  quote: z.string(),
  quote_source: z.enum(GUIDE_EVIDENCE_QUOTE_SOURCES),
  quote_field: z.enum(GUIDE_EVIDENCE_QUOTE_FIELDS).nullable(),
  class_context: classSnapshotSchema.nullable(),
  source_confirmed_at: z.string().nullable(),
  valid: z.boolean(),
  invalid_reason: z.enum(BASIS_INVALID_REASONS).nullable(),
  observation_status: z.enum(OBSERVATION_STATUSES).nullable(),
});

export const evidenceLinkViewSchema = z.object({
  link_id: z.string().min(1),
  item_id: z.string().min(1),
  catalog_version: z.string().min(1),
  origin: z.enum(GUIDE_EVIDENCE_LINK_ORIGINS),
  status: z.enum(GUIDE_EVIDENCE_LINK_STATUSES),
  support: z.enum(GUIDE_EVIDENCE_SUPPORT_KINDS).nullable(),
  sustained_note: periodNoteSchema.nullable(),
  adult_help_used: z.boolean(),
  basis: z.array(basisViewSchema),
  ai_reason: z.string().nullable(),
  teacher_note: z.string().nullable(),
  revision: z.number().int().min(0),
  created_at: z.string().min(1),
  decided_at: z.string().nullable(),
  withdrawn_at: z.string().nullable(),
  withdrawn_reason: z.string().nullable(),
  counts_toward_status: z.boolean(),
  excluded_reason: z.enum(EXCLUSION_REASONS).nullable(),
});

// 编译期约束：解析结果与冻结的 EvidenceLinkView 双向可赋值
type AssertAssignable<A extends B, B> = true;
type _SchemaToView = AssertAssignable<z.infer<typeof evidenceLinkViewSchema>, EvidenceLinkView>;
type _ViewToSchema = AssertAssignable<EvidenceLinkView, z.infer<typeof evidenceLinkViewSchema>>;

const evidenceNoticeSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error"]).optional(),
  message: z.string(),
});

const guideMutationSchema = z.object({
  observation_id: z.string().min(1),
  revision: z.number().int().min(0),
  links: z.array(evidenceLinkViewSchema),
  notice: evidenceNoticeSchema.optional(),
});

export interface SanitizedGuideMutation {
  observation_id: string;
  revision: number;
  links: EvidenceLinkView[];
  notice: { code: string; message: string } | null;
}

export type ResponseFailure =
  | { kind: "http"; status: number; message: string; error: string | null }
  | { kind: "invalid_json"; status: number; message: string }
  | { kind: "invalid_shape"; status: number; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; failure: ResponseFailure };

function readMessage(payload: unknown, fallback: string): { message: string; error: string | null } {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    const message = typeof record.message === "string" && record.message.trim() ? record.message : fallback;
    const error = typeof record.error === "string" && record.error ? record.error : null;
    return { message, error };
  }
  return { message: fallback, error: null };
}

function parseJson(rawText: string): { ok: true; payload: unknown } | { ok: false } {
  try {
    return { ok: true, payload: JSON.parse(rawText) };
  } catch {
    return { ok: false };
  }
}

/**
 * 指南操作（confirm/reject/withdraw/suggest）响应核对；错误文案沿用响应 message。
 * HTTP 状态优先：非 2xx 永远是失败，合法成功形状不能覆盖失败状态。
 */
export function parseGuideMutationResponse(
  status: number,
  rawText: string,
  hostObservationId: string,
): ParseResult<SanitizedGuideMutation> {
  const httpFailed = status < 200 || status >= 300;
  const parsed = parseJson(rawText);
  if (httpFailed) {
    const { message, error } = parsed.ok
      ? readMessage(parsed.payload, `操作失败（${status}），请稍后重试。`)
      : { message: `操作失败（${status}），响应无法解析。`, error: null };
    return { ok: false, failure: { kind: "http", status, message, error } };
  }
  if (!parsed.ok) {
    return { ok: false, failure: { kind: "invalid_json", status, message: "服务端返回了无法解析的数据，不能确认本次写入结果。" } };
  }
  const shape = guideMutationSchema.safeParse(parsed.payload);
  if (!shape.success) {
    return { ok: false, failure: { kind: "invalid_shape", status, message: "服务端响应缺少宿主、修订号或关联列表，不能确认本次写入结果。" } };
  }
  if (shape.data.observation_id !== hostObservationId) {
    return { ok: false, failure: { kind: "invalid_shape", status, message: "服务端响应属于其他观察记录，已拒绝采纳。" } };
  }
  return {
    ok: true,
    value: {
      observation_id: shape.data.observation_id,
      revision: shape.data.revision,
      links: shape.data.links,
      notice: shape.data.notice ? { code: shape.data.notice.code, message: shape.data.notice.message } : null,
    },
  };
}

/* ------------------------------- 读回核对 ------------------------------- */

const readObservationSchema = z.object({
  id: z.string().min(1),
  child_id: z.string().min(1),
  status: z.enum(OBSERVATION_STATUSES),
  observed_at: z.string().optional(),
  confirmed_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  guide_evidence: z.unknown().nullable().optional(),
  confirmed_content: z.unknown().nullable().optional(),
});

export interface ParsedHostObservation {
  id: string;
  child_id: string;
  status: (typeof OBSERVATION_STATUSES)[number];
  observed_at: string | null;
  confirmed_at: string | null;
  updated_at: string | null;
  guide_evidence: unknown;
  confirmed_content: unknown;
}

export type ReadBackResult =
  | { ok: true; observation: ParsedHostObservation }
  | { ok: false; kind: "http"; status: number; message: string }
  | { ok: false; kind: "invalid_json"; message: string }
  | { ok: false; kind: "invalid_shape"; message: string }
  | { ok: false; kind: "not_found"; message: string };

/** 解析 GET /api/observations?child_id=…；未找到宿主是“无法据此证明未写入”，不是失败依据 */
export function parseHostObservationResponse(
  status: number,
  rawText: string,
  hostObservationId: string,
): ReadBackResult {
  const httpFailed = status < 200 || status >= 300;
  const parsed = parseJson(rawText);
  if (httpFailed) {
    const { message } = parsed.ok
      ? readMessage(parsed.payload, `读取观察状态失败（${status}），请重试读取。`)
      : { message: `读取观察状态失败（${status}），响应无法解析。` };
    return { ok: false, kind: "http", status, message };
  }
  if (!parsed.ok) {
    return { ok: false, kind: "invalid_json", message: "读取观察状态返回了无法解析的数据。" };
  }
  const shape = z.object({ observations: z.array(readObservationSchema) }).safeParse(parsed.payload);
  if (!shape.success) {
    return { ok: false, kind: "invalid_shape", message: "读取观察状态的响应形状不可核对。" };
  }
  const found = shape.data.observations.find((observation) => observation.id === hostObservationId);
  if (!found) {
    return {
      ok: false,
      kind: "not_found",
      message: "当前列表未包含这条观察，无法据此判断是否已写入；请稍后重试读取。",
    };
  }
  return {
    ok: true,
    observation: {
      id: found.id,
      child_id: found.child_id,
      status: found.status,
      observed_at: found.observed_at ?? null,
      confirmed_at: found.confirmed_at ?? null,
      updated_at: found.updated_at ?? null,
      guide_evidence: found.guide_evidence ?? null,
      confirmed_content: found.confirmed_content ?? null,
    },
  };
}

/* --------------------------- 本次目标结果核对 --------------------------- */

export interface RawGuideBasis {
  observation_id: string;
  quote: string;
  quote_source: string;
  quote_field: string | null;
}

export interface RawGuideLink {
  id: string;
  item_id: string;
  status: string;
  origin: string;
  support: string | null;
  basis: RawGuideBasis[];
  adult_help_used: boolean;
  teacher_note: string | null;
  sustained_note: { period_start: string; period_end: string; description: string } | null;
  withdrawn_reason: string | null;
}

function parseRawBasis(value: unknown): RawGuideBasis[] | null {
  if (!Array.isArray(value)) return null;
  const result: RawGuideBasis[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const observationId = typeof record.observation_id === "string" ? record.observation_id : null;
    const quote = typeof record.quote === "string" ? record.quote : null;
    const quoteSource = typeof record.quote_source === "string" ? record.quote_source : null;
    const rawField = record.quote_field;
    const quoteField = rawField === null || rawField === undefined ? null : typeof rawField === "string" ? rawField : undefined;
    if (!observationId || quote === null || !quoteSource || quoteField === undefined) return null;
    result.push({ observation_id: observationId, quote, quote_source: quoteSource, quote_field: quoteField });
  }
  return result;
}

function parseRawPeriodNote(value: unknown): { period_start: string; period_end: string; description: string } | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const start = typeof record.period_start === "string" ? record.period_start : null;
  const end = typeof record.period_end === "string" ? record.period_end : null;
  const description = typeof record.description === "string" ? record.description : null;
  if (!start || !end || description === null) return undefined;
  return { period_start: start, period_end: end, description };
}

/** 从原始 guide_evidence 容器读取关联；结构不可核对返回 null（不可当作没有关联） */
export function readRawGuideLinks(value: unknown): RawGuideLink[] | null {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const links = (value as Record<string, unknown>).links;
  if (!Array.isArray(links)) return null;
  const result: RawGuideLink[] = [];
  for (const link of links) {
    if (typeof link !== "object" || link === null || Array.isArray(link)) return null;
    const record = link as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const itemId = typeof record.item_id === "string" ? record.item_id : null;
    const linkStatus = typeof record.status === "string" ? record.status : null;
    const origin = typeof record.origin === "string" ? record.origin : null;
    const supportRaw = record.support;
    const support = supportRaw === null || supportRaw === undefined ? null : typeof supportRaw === "string" ? supportRaw : undefined;
    const basis = parseRawBasis(record.basis);
    const adultHelp = typeof record.adult_help_used === "boolean" ? record.adult_help_used : null;
    const noteRaw = record.teacher_note;
    const teacherNote = noteRaw === null || noteRaw === undefined ? null : typeof noteRaw === "string" ? noteRaw : undefined;
    const sustained = parseRawPeriodNote(record.sustained_note);
    const withdrawnRaw = record.withdrawn_reason;
    const withdrawnReason = withdrawnRaw === null || withdrawnRaw === undefined ? null : typeof withdrawnRaw === "string" ? withdrawnRaw : undefined;
    if (
      !id || !itemId || !linkStatus || !origin ||
      support === undefined || basis === null || adultHelp === null ||
      teacherNote === undefined || sustained === undefined || withdrawnReason === undefined
    ) {
      return null;
    }
    result.push({
      id, item_id: itemId, status: linkStatus, origin,
      support, basis, adult_help_used: adultHelp, teacher_note: teacherNote,
      sustained_note: sustained, withdrawn_reason: withdrawnReason,
    });
  }
  return result;
}

/** 原始容器修订号；缺失/非法返回 null（不可当作 0 或最新） */
export function readRawRevision(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const revision = (value as Record<string, unknown>).revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : null;
}

/**
 * 本次决定的完整身份：支持类型、依据定位（来源/片段/出处/字段）、成人帮助、备注与纪要。
 * 目标判定必须核对内容本身，不能只匹配条目和正式状态。
 */
export interface DecisionIdentityInput {
  link_id: string | null;
  item_id: string;
  support: string;
  basis: RawGuideBasis[];
  adult_help_used: boolean;
  teacher_note: string | null;
  sustained_note: { period_start: string; period_end: string; description: string } | null;
}

function normalizedNote(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** 由提交的决定输入构造身份；link_id 决定（已有建议）不需要 item_id */
export function decisionIdentity(
  input: GuideEvidenceDecisionInput,
  itemId?: string,
): DecisionIdentityInput {
  return {
    link_id: "link_id" in input ? input.link_id : null,
    item_id: "item_id" in input ? input.item_id : itemId ?? "",
    support: input.support,
    basis: input.basis.map((entry) => ({
      observation_id: entry.observation_id,
      quote: entry.quote.trim(),
      quote_source: entry.quote_source,
      quote_field: entry.quote_source === "raw_text" ? null : entry.quote_field ?? null,
    })),
    adult_help_used: input.adult_help_used === true,
    teacher_note: normalizedNote(input.teacher_note),
    sustained_note: input.support === "sustained" ? input.sustained_note ?? null : null,
  };
}

export type MutationTarget =
  | { action: "confirm"; decision: DecisionIdentityInput }
  | { action: "reject"; link_id: string; reason: string | null }
  | { action: "withdraw"; link_id: string; reason: string | null }
  | { action: "suggest" };

export type TargetOutcome = "applied" | "not_applied" | "unconfirmed";

const FORMAL_STATUSES = ["confirmed_performance", "confirmed_clue"];

function sameBasisIdentity(left: RawGuideBasis[], right: RawGuideBasis[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      entry.observation_id === other.observation_id &&
      entry.quote.trim() === other.quote.trim() &&
      entry.quote_source === other.quote_source &&
      (entry.quote_field ?? null) === (other.quote_field ?? null)
    );
  });
}

function samePeriodNote(
  left: { period_start: string; period_end: string; description: string } | null,
  right: { period_start: string; period_end: string; description: string } | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.period_start === right.period_start &&
    left.period_end === right.period_end &&
    left.description === right.description
  );
}

interface DecisionContentShape {
  support: string | null;
  basis: RawGuideBasis[];
  adult_help_used: boolean;
  teacher_note: string | null;
  sustained_note: { period_start: string; period_end: string; description: string } | null;
}

function decisionContentMatches(link: DecisionContentShape, decision: DecisionIdentityInput): boolean {
  if (link.support !== decision.support) return false;
  if (!sameBasisIdentity(link.basis, decision.basis)) return false;
  if (link.adult_help_used !== decision.adult_help_used) return false;
  if (normalizedNote(link.teacher_note) !== normalizedNote(decision.teacher_note)) return false;
  if (!samePeriodNote(link.sustained_note, decision.sustained_note)) return false;
  return true;
}

/** 已提交决定是否已在 links 视图中按内容生效（同条目可能保留旧终态审计，必须找到生效项） */
export function decisionAppliedInLinks(links: EvidenceLinkView[], decision: DecisionIdentityInput): boolean {
  const candidates = decision.link_id
    ? links.filter((entry) => entry.link_id === decision.link_id)
    : links.filter((entry) => entry.item_id === decision.item_id && entry.origin === "manual");
  return candidates.some(
    (candidate) => FORMAL_STATUSES.includes(candidate.status) && decisionContentMatches(candidate, decision),
  );
}

function rejectWithdrawApplied(
  status: string,
  actualReason: string | null | undefined,
  target: Extract<MutationTarget, { action: "reject" | "withdraw" }>,
): boolean {
  if (target.action === "reject") return status === "rejected" && normalizedNote(actualReason) === normalizedNote(target.reason);
  return status === "withdrawn" && normalizedNote(actualReason) === normalizedNote(target.reason);
}

/** 在已解析的 links 视图上核对本次目标结果；无法确认时返回 unconfirmed（需要读回） */
export function mutationTargetOutcome(links: EvidenceLinkView[], target: MutationTarget): TargetOutcome {
  if (target.action === "suggest") {
    return links.some((link) => link.status === "ai_suggested") ? "applied" : "unconfirmed";
  }
  if (target.action === "reject" || target.action === "withdraw") {
    const link = links.find((entry) => entry.link_id === target.link_id);
    if (!link) return "unconfirmed";
    const reason = target.action === "reject" ? link.teacher_note : link.withdrawn_reason;
    return rejectWithdrawApplied(link.status, reason, target) ? "applied" : "not_applied";
  }
  return decisionAppliedInLinks(links, target.decision) ? "applied" : "unconfirmed";
}

/**
 * 在读回的原始容器上核对本次目标结果（读回是权威事实）：
 * 容器不可读 → unconfirmed；容器可读但目标缺失/内容不符 → not_applied。
 */
export function rawTargetOutcome(raw: unknown, target: MutationTarget): TargetOutcome {
  const links = readRawGuideLinks(raw);
  if (links === null) return "unconfirmed";
  if (target.action === "suggest") {
    return links.some((link) => link.status === "ai_suggested") ? "applied" : "not_applied";
  }
  if (target.action === "reject" || target.action === "withdraw") {
    const link = links.find((entry) => entry.id === target.link_id);
    if (!link) return "not_applied";
    const reason = target.action === "reject" ? link.teacher_note : link.withdrawn_reason;
    return rejectWithdrawApplied(link.status, reason, target) ? "applied" : "not_applied";
  }
  const candidates = links.filter((entry) =>
    target.decision.link_id
      ? entry.id === target.decision.link_id
      : entry.item_id === target.decision.item_id && entry.origin === "manual",
  );
  return candidates.some(
    (candidate) =>
      FORMAL_STATUSES.includes(candidate.status) && decisionContentMatches(candidate, target.decision),
  )
    ? "applied"
    : "not_applied";
}

/* ------------------------- Review 确认响应核对 ------------------------- */

const objectOrNull = <T,>() =>
  z.union([z.null(), z.custom<T>((value) => typeof value === "object" && value !== null)]);

const guideConfirmExtensionSchema = z.object({
  status: z.enum(["applied", "deferred"]),
  revision: z.number().int().min(0).optional(),
  links: z.array(evidenceLinkViewSchema).optional(),
  detail_unavailable: z.boolean().optional(),
  message: z.string().optional(),
});

export const reviewConfirmResponseSchema = z.object({
  observation: z.object({
    id: z.string().min(1),
    child_id: z.string().min(1),
    status: z.enum(OBSERVATION_STATUSES),
    agent_context: objectOrNull<AgentContext>(),
    ai_draft: objectOrNull<ObservationDraft>(),
    ai_model: z.string().nullable(),
    ai_organized_at: z.string().nullable(),
    confirmed_content: objectOrNull<ObservationDraft>(),
    confirmed_at: z.string().nullable(),
    updated_at: z.string().nullable().optional(),
  }),
  requiresAgentConfirmation: z.boolean().optional(),
  agentReview: objectOrNull<TeacherEditReviewOutput>().optional(),
  profileUpdateStatus: z.enum(["updated", "failed"]).optional(),
  profileUpdateMessage: z.string().optional(),
  guideEvidence: guideConfirmExtensionSchema.optional(),
});

export type ReviewConfirmParsed = z.infer<typeof reviewConfirmResponseSchema>;

export function parseReviewConfirmResponse(
  status: number,
  rawText: string,
  hostObservationId: string,
  hostChildId: string,
): ParseResult<ReviewConfirmParsed> {
  const httpFailed = status < 200 || status >= 300;
  const parsed = parseJson(rawText);
  if (httpFailed) {
    const { message, error } = parsed.ok
      ? readMessage(parsed.payload, `确认失败（${status}），请稍后重试。`)
      : { message: `确认失败（${status}），响应无法解析。`, error: null };
    return { ok: false, failure: { kind: "http", status, message, error } };
  }
  if (!parsed.ok) {
    return { ok: false, failure: { kind: "invalid_json", status, message: "服务端返回了无法解析的确认结果，不能据此认为已归档。" } };
  }
  const shape = reviewConfirmResponseSchema.safeParse(parsed.payload);
  if (!shape.success) {
    return { ok: false, failure: { kind: "invalid_shape", status, message: "确认响应缺少观察状态或关联结果，不能据此认为已归档。" } };
  }
  if (shape.data.observation.id !== hostObservationId) {
    return { ok: false, failure: { kind: "invalid_shape", status, message: "确认响应属于其他观察记录，已拒绝采纳。" } };
  }
  if (shape.data.observation.child_id !== hostChildId) {
    return { ok: false, failure: { kind: "invalid_shape", status, message: "确认响应属于其他幼儿，已拒绝采纳。" } };
  }
  return { ok: true, value: shape.data };
}

/** 确认响应是否构成“已保存”的充分事实（links 或 detail_unavailable 至少一个） */
export function confirmAppliedIsDecisive(
  guide: ReviewConfirmParsed["guideEvidence"],
): "saved_with_links" | "saved_detail_unavailable" | "deferred" | "incomplete" | null {
  if (!guide) return null;
  if (guide.status === "deferred") return "deferred";
  if (guide.links) return "saved_with_links";
  if (guide.detail_unavailable) return "saved_detail_unavailable";
  return "incomplete";
}
