import type { ClassContextConfirmationReason } from "./class-context";
import { CLASS_STAGES, type SchoolClass } from "./types";

/**
 * 发生时班级查询的客户端解析（G2）。
 *
 * 只接受明确合法的 resolved / needs_confirmation 响应：
 * - HTTP 或 JSON 解析失败 → ok:false（由调用方转成可见错误，不得当作 needs_confirmation）；
 * - resolved 的 class 必须通过字段核实（id/name/school_year 非空，stage 为真实学段）；
 * - needs_confirmation 的 reason 必须在已知集合内；
 * - 其他结构一律 ok:false，不静默降级。
 * 本文件必须保持客户端安全：只依赖纯类型与常量，不引入数据库或服务端模块。
 */

export interface ClassContextResolvedState {
  status: "resolved";
  class: SchoolClass;
}

export interface ClassContextNeedsConfirmationState {
  status: "needs_confirmation";
  reason: ClassContextConfirmationReason;
  message: string;
}

export type ClassContextLookupState =
  | ClassContextResolvedState
  | ClassContextNeedsConfirmationState;

export const CLASS_CONTEXT_REASON_FALLBACK_MESSAGES: Record<
  ClassContextConfirmationReason,
  string
> = {
  no_attribution: "分班历史中没有覆盖这条观察日期的班级归属，请选择当时幼儿所在的班级。",
  overlapping_attribution: "这条观察日期同时落在多条分班记录中，无法自动确定当时班级，请选择。",
  unreliable_history: "这名幼儿的分班历史存在异常记录，无法自动确定当时班级，请选择。",
  unreliable_class_record:
    "分班历史指向的班级资料无法核实，请选择当时所在班级或先补全班级资料。",
};

const CONFIRMATION_REASONS = Object.keys(
  CLASS_CONTEXT_REASON_FALLBACK_MESSAGES,
) as ClassContextConfirmationReason[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 响应中的班级必须字段完整、学段真实；缺失/非法 stage 不得被接受 */
export function isReliableClassShape(value: unknown): value is SchoolClass {
  if (!isRecord(value)) return false;
  const { id, name, stage, school_year } = value;
  if (typeof id !== "string" || id.length === 0) return false;
  if (typeof name !== "string" || name.length === 0) return false;
  if (typeof school_year !== "string" || school_year.length === 0) return false;
  return typeof stage === "string" && (CLASS_STAGES as readonly string[]).includes(stage);
}

export function isClassContextConfirmationReason(
  value: unknown,
): value is ClassContextConfirmationReason {
  return typeof value === "string" && (CONFIRMATION_REASONS as string[]).includes(value);
}

/** AbortError 由调用方用于“取消不覆盖状态”，不得进入错误展示 */
export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export type ClassContextParseResult =
  | { ok: true; state: ClassContextLookupState }
  | { ok: false; message: string };

/**
 * 解析 GET /api/children/[id]/class-context 的响应。
 * rawText 为响应体原文；解析失败、HTTP 失败、结构不合法都返回 ok:false。
 */
export function parseClassContextResponse(
  status: number,
  rawText: string,
): ClassContextParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return { ok: false, message: "发生时班级服务返回了无法解析的数据，请重试。" };
  }

  if (status < 200 || status >= 300) {
    const message =
      isRecord(payload) && typeof payload.message === "string" && payload.message.trim()
        ? payload.message
        : `核对发生时班级失败（${status}），请重试。`;
    return { ok: false, message };
  }

  if (!isRecord(payload)) {
    return { ok: false, message: "发生时班级服务返回了无法识别的数据，请重试。" };
  }

  if (payload.status === "resolved") {
    if (!isReliableClassShape(payload.class)) {
      return {
        ok: false,
        message: "发生时班级资料无法核实（班级名称、学段或学年缺失/异常），请重试或联系管理员。",
      };
    }
    return { ok: true, state: { status: "resolved", class: payload.class } };
  }

  if (payload.status === "needs_confirmation") {
    if (!isClassContextConfirmationReason(payload.reason)) {
      return { ok: false, message: "发生时班级服务返回了无法识别的核对状态，请重试。" };
    }
    const message =
      typeof payload.message === "string" && payload.message.trim()
        ? payload.message
        : CLASS_CONTEXT_REASON_FALLBACK_MESSAGES[payload.reason];
    return {
      ok: true,
      state: { status: "needs_confirmation", reason: payload.reason, message },
    };
  }

  return { ok: false, message: "发生时班级服务返回了无法识别的数据，请重试。" };
}

/**
 * 发起查询并返回合法状态；解析失败抛出带用户文案的错误。
 * fetchImpl 仅用于测试注入；AbortError 原样抛出，由调用方忽略。
 */
export async function fetchClassContextState(input: {
  childId: string;
  observedAt: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ClassContextLookupState> {
  const fetchFn = input.fetchImpl ?? fetch;
  const response = await fetchFn(
    `/api/children/${input.childId}/class-context?observed_at=${encodeURIComponent(input.observedAt)}`,
    { signal: input.signal },
  );
  const rawText = await response.text();
  const parsed = parseClassContextResponse(response.status, rawText);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.state;
}
