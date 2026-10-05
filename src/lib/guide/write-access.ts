import { headers } from "next/headers";

import { loadAccountsConfig } from "@/lib/accounts/config";
import { resolveRequestAuth, type HeaderCarrier } from "@/lib/accounts/guards";
import { parseCookieHeader } from "@/lib/accounts/session";
import { TEACHER_COOKIE, verifySessionToken } from "@/lib/auth";
import type { Observation } from "@/lib/types";

import {
  LEGACY_TEACHER_ACCESS,
  READ_ONLY_ACCESS,
  type GuideWriteAccessView,
} from "./association-types";
import {
  guideAccessForChild,
  guideAccessForObservation,
  guideCanCreateObservation,
  type IdentityFacts,
} from "./write-access-rules";

/**
 * 指南写入口的服务端身份解析（G6-WRITE1）。
 *
 * - 每次请求重新读取 Cookie 与数据库；不缓存 Principal，不接受客户端声明的权限；
 * - 账号会话存在时用 `resolveRequestAuth` + 资源事实授权；
 * - 只在没有账号会话（匿名，或仅携带旧口令 Cookie）时回退到现有旧口令教师身份，
 *   与当前业务 API 的 `requireTeacher` 保持同一事实；
 * - 失效/撤销的账号会话不回退旧口令（fail closed）。
 */

export async function resolveIdentityFacts(request?: HeaderCarrier): Promise<IdentityFacts> {
  const carrier = request ?? ({ headers: await headers() } satisfies HeaderCarrier);
  const config = loadAccountsConfig();
  if (config) {
    const resolved = await resolveRequestAuth(carrier, config);
    if (resolved.state.kind === "authenticated") {
      return { kind: "principal", principal: resolved.state.principal };
    }
    if (resolved.state.kind === "unavailable") return { kind: "unavailable" };
    if (resolved.state.kind === "invalid_session") {
      const legacyOnly = resolved.state.reason === "legacy_cookie_not_accepted";
      if (!legacyOnly) return { kind: "none" };
    }
  }
  const legacyToken = parseCookieHeader(carrier.headers.get("cookie")).get(TEACHER_COOKIE);
  if (verifySessionToken(legacyToken)) return { kind: "legacy_teacher" };
  return { kind: "none" };
}

/** 只依赖服务端读到的归属事实；Child 与读模型 EvidenceChildRef 都满足此形状 */
export interface ChildAttributionFact {
  id: string;
  class_id: string | null;
}

function childFacts(child: ChildAttributionFact): { id: string; current_class_id: string | null } {
  return { id: child.id, current_class_id: child.class_id ?? null };
}

export async function resolveChildWriteAccess(
  child: ChildAttributionFact,
  request?: HeaderCarrier,
): Promise<GuideWriteAccessView> {
  return guideAccessForChild(await resolveIdentityFacts(request), childFacts(child));
}

/** 班级证据页：按当前名单逐人判定；不用整班一刀切的教师角色结论 */
export async function resolveClassWriteAccess(
  children: ChildAttributionFact[],
  request?: HeaderCarrier,
): Promise<{ access: GuideWriteAccessView; record_by_child: Record<string, boolean> }> {
  const identity = await resolveIdentityFacts(request);
  const record_by_child: Record<string, boolean> = {};
  for (const child of children) {
    record_by_child[child.id] = guideAccessForChild(identity, childFacts(child)).can_record;
  }
  const firstOperable = children.find((child) => record_by_child[child.id]);
  if (firstOperable) {
    return { access: guideAccessForChild(identity, childFacts(firstOperable)), record_by_child };
  }
  return {
    access: guideAccessForChild(identity, { id: "class-scope", current_class_id: null }),
    record_by_child,
  };
}

/** 录入页身份级可写性；具体幼儿仍以服务端 observation.write 授权为准 */
export async function resolveCreateObservationAccess(
  request?: HeaderCarrier,
): Promise<GuideWriteAccessView> {
  const identity = await resolveIdentityFacts(request);
  if (identity.kind === "legacy_teacher") return LEGACY_TEACHER_ACCESS;
  if (identity.kind === "unavailable") {
    return { ...READ_ONLY_ACCESS, read_only_reason: "身份服务暂时不可用，已隐藏写入口；请稍后重试。" };
  }
  if (identity.kind === "none") {
    return { ...READ_ONLY_ACCESS, read_only_reason: "需要教师身份才能录入观察；当前为只读查看。" };
  }
  if (!guideCanCreateObservation(identity)) {
    return {
      ...READ_ONLY_ACCESS,
      read_only_reason:
        identity.principal.role === "admin"
          ? "管理员没有教学操作权限，不能录入观察。"
          : "当前账号还没有任教班级，暂不能录入观察。",
    };
  }
  return {
    can_record: true,
    can_decide: true,
    can_organize: true,
    mode: "account_teacher",
    read_only_reason: null,
  };
}

export async function resolveObservationWriteAccess(
  observation: Observation,
  child: ChildAttributionFact | null,
  request?: HeaderCarrier,
): Promise<GuideWriteAccessView> {
  return guideAccessForObservation(await resolveIdentityFacts(request), {
    observation_id: observation.id,
    child_id: observation.child_id,
    current_class_id: child?.class_id ?? null,
    observed_class_id: observation.class_id ?? null,
    author_account_id: null,
  });
}
