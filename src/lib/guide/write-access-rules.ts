import { authorizeAction } from "@/lib/accounts/authorize";
import type { AccessAction, AccessResource, Principal } from "@/lib/accounts/types";

import { READ_ONLY_ACCESS, type GuideWriteAccessView } from "./association-types";

/**
 * 指南写入口的纯权限规则（G6-WRITE1，B0 基线：旧口令已退役，只认园所账号会话）。
 *
 * - 资源事实（幼儿当前归属）由调用方从服务端读取后传入；不接受客户端声明；
 * - 管理员对教学动作一律 read_only（forbidden_role）；
 * - 原班历史只读（发生时班级在内、当前归属已转出）不得出现写控件；
 * - 身份不可用 fail closed，不回退匿名或全园。
 */

export type IdentityFacts =
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

function allowed(
  principal: Principal,
  action: AccessAction,
  resource: AccessResource,
): { allowed: boolean; reason: string | null } {
  const decision = authorizeAction(principal, action, resource);
  if (decision.allowed) return { allowed: true, reason: null };
  return { allowed: false, reason: denyReasonText(decision) };
}

/** 幼儿资源的可操作性：记录观察（observation.write，child 资源） */
export function guideAccessForChild(
  identity: IdentityFacts,
  child: { id: string; current_class_id: string | null },
): GuideWriteAccessView {
  if (identity.kind === "none") return NO_IDENTITY_ACCESS;
  if (identity.kind === "unavailable") return UNAVAILABLE_ACCESS;
  const decision = allowed(identity.principal, "observation.write", {
    kind: "child",
    child_id: child.id,
    current_class_id: child.current_class_id,
  });
  if (decision.allowed) {
    return {
      can_record: true,
      can_decide: true,
      can_organize: true,
      mode: "account_teacher",
      read_only_reason: null,
    };
  }
  return { ...READ_ONLY_ACCESS, read_only_reason: decision.reason };
}

/**
 * 录入入口的身份级可写性：账号教师需有非空任教范围；
 * 管理员与空范围账号不可用（真实幼儿归属在资源层再逐人判定）。
 */
export function guideCanCreateObservation(identity: IdentityFacts): boolean {
  if (identity.kind !== "principal") return false;
  const principal = identity.principal;
  if (principal.account_status !== "active") return false;
  if (principal.role === "admin") return false;
  return principal.scope.kind === "classes" && principal.scope.class_ids.length > 0;
}
