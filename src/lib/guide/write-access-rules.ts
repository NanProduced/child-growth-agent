import { authorizeAction } from "@/lib/accounts/authorize";
import type { AccessAction, AccessResource, Principal } from "@/lib/accounts/types";

import {
  LEGACY_TEACHER_ACCESS,
  READ_ONLY_ACCESS,
  type GuideWriteAccessView,
} from "./association-types";

/**
 * 指南写入口的纯权限规则（G6-WRITE1）。
 *
 * - 服务端事实（幼儿当前归属、发生时班级）由调用方从数据库读取后传入；
 * - 管理员对教学动作一律 read_only（forbidden_role）；
 * - 原班历史只读（发生时班级在内、当前归属已转出）不得出现写控件；
 * - 旧口令教师是当前单教师演示模式的现有身份：与业务 API 的 requireTeacher 一致，
 *   只在没有任何账号会话时作为教师身份使用，不作为“角色一刀切”的授权。
 */

export type IdentityFacts =
  | { kind: "legacy_teacher" }
  | { kind: "principal"; principal: Principal }
  | { kind: "none" }
  | { kind: "unavailable" };

const UNAVAILABLE_ACCESS: GuideWriteAccessView = {
  ...READ_ONLY_ACCESS,
  read_only_reason: "身份服务暂时不可用，已隐藏写入口；请稍后重试。",
};

const NO_IDENTITY_ACCESS: GuideWriteAccessView = {
  ...READ_ONLY_ACCESS,
  read_only_reason: "需要教师身份才能建立关联；当前为只读查看。",
};

function denyReasonText(decision: Extract<ReturnType<typeof authorizeAction>, { allowed: false }>): string {
  if ("invalid_request" in decision) return "动作与资源组合不合法，已隐藏写入口。";
  switch (decision.deny) {
    case "forbidden_role":
      return "管理员没有教学操作权限，不能建立或修改关联。";
    case "out_of_scope":
      return "当前账号没有这名幼儿的操作权限（原班历史只读），不能建立或修改关联。";
    case "empty_scope":
      return "当前账号还没有任教班级，暂不能建立或修改关联。";
    case "account_disabled":
      return "账号已停用，不能建立或修改关联。";
    case "identity_unavailable":
      return "身份服务暂时不可用，已隐藏写入口；请稍后重试。";
    case "unauthenticated":
      return "需要教师身份才能建立关联；当前为只读查看。";
  }
}

function decide(
  principal: Principal,
  action: AccessAction,
  resource: AccessResource,
): { allowed: boolean; reason: string | null } {
  const decision = authorizeAction(principal, action, resource);
  if (decision.allowed) return { allowed: true, reason: null };
  return { allowed: false, reason: denyReasonText(decision) };
}

function accountAccess(
  principal: Principal,
  resource: AccessResource,
  actions: { record?: AccessAction; decide?: AccessAction; organize?: AccessAction },
): GuideWriteAccessView {
  let readOnlyReason: string | null = null;
  const allowedOf = (action: AccessAction | undefined): boolean => {
    if (!action) return false;
    const result = decide(principal, action, resource);
    if (!result.allowed && readOnlyReason === null) readOnlyReason = result.reason;
    return result.allowed;
  };
  const can_record = allowedOf(actions.record);
  const can_decide = allowedOf(actions.decide);
  const can_organize = allowedOf(actions.organize);
  if (can_record || can_decide || can_organize) {
    return {
      can_record,
      can_decide,
      can_organize,
      mode: "account_teacher",
      read_only_reason: null,
    };
  }
  return { ...READ_ONLY_ACCESS, read_only_reason: readOnlyReason };
}

/**
 * 录入入口的身份级可写性：旧口令教师可用；账号教师需有非空任教范围；
 * 管理员与空范围账号不可用（真实归属在幼儿资源层再逐人判定）。
 */
export function guideCanCreateObservation(identity: IdentityFacts): boolean {
  if (identity.kind === "legacy_teacher") return true;
  if (identity.kind !== "principal") return false;
  const principal = identity.principal;
  if (principal.account_status !== "active") return false;
  if (principal.role === "admin") return false;
  return principal.scope.kind === "classes" && principal.scope.class_ids.length > 0;
}

/** 幼儿资源的可操作性：记录观察（observation.write，child 资源） */
export function guideAccessForChild(
  identity: IdentityFacts,
  child: { id: string; current_class_id: string | null },
): GuideWriteAccessView {
  if (identity.kind === "legacy_teacher") return LEGACY_TEACHER_ACCESS;
  if (identity.kind === "none") return NO_IDENTITY_ACCESS;
  if (identity.kind === "unavailable") return UNAVAILABLE_ACCESS;
  return accountAccess(identity.principal, {
    kind: "child",
    child_id: child.id,
    current_class_id: child.current_class_id,
  }, { record: "observation.write" });
}

/** 观察资源的可操作性：确认归档、指南决定、AI 整理（observation 资源） */
export function guideAccessForObservation(
  identity: IdentityFacts,
  observation: {
    observation_id: string;
    child_id: string;
    current_class_id: string | null;
    observed_class_id: string | null;
    author_account_id: string | null;
  },
): GuideWriteAccessView {
  if (identity.kind === "legacy_teacher") return LEGACY_TEACHER_ACCESS;
  if (identity.kind === "none") return NO_IDENTITY_ACCESS;
  if (identity.kind === "unavailable") return UNAVAILABLE_ACCESS;
  const access = accountAccess(identity.principal, {
    kind: "observation",
    observation_id: observation.observation_id,
    child_id: observation.child_id,
    current_class_id: observation.current_class_id,
    observed_class_id: observation.observed_class_id,
    author_account_id: observation.author_account_id,
  }, {
    decide: "guide.decide",
    organize: "observation.organize",
  });
  // 观察上下文不单独提供“新建观察”入口；can_record 仅作为同范围可写的展示近似
  return { ...access, can_record: access.can_decide };
}
