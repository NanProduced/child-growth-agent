import {
  ACCESS_INVALID_COMBINATION_ERROR,
  ACTION_RESOURCE_KINDS,
  TEACHING_ACCESS_ACTIONS,
  type AccessAction,
  type AccessDecision,
  type AccessResource,
  type AccessVia,
  type AuthState,
  type Principal,
} from "./types";

/**
 * AUTH2 可调用的授权基础函数：与冻结契约（含 R2 边界）保持一致。
 * - 先动作/资源组合合法性（400 invalid_request），再角色与范围；
 * - 资源事实必须由调用方从服务端读取后传入；
 * - 本函数不做数据库访问，不缓存 Principal。
 */

export function isLegalAccessCombination(
  action: AccessAction,
  resourceKind: AccessResource["kind"],
): boolean {
  return (ACTION_RESOURCE_KINDS[action] as readonly string[]).includes(resourceKind);
}

export function isTeachingAccessAction(action: AccessAction): boolean {
  return (TEACHING_ACCESS_ACTIONS as readonly string[]).includes(action);
}

function currentClassOf(resource: AccessResource): string | null {
  switch (resource.kind) {
    case "school":
      return null;
    case "class":
      return resource.class_id;
    case "child":
      return resource.current_class_id;
    case "transfer":
      return resource.current_class_id;
    case "observation":
      return resource.current_class_id;
  }
}

function observedClassOf(resource: AccessResource): string | null {
  return resource.kind === "observation" ? resource.observed_class_id : null;
}

export function authorizeAction(
  principal: Principal,
  action: AccessAction,
  resource: AccessResource,
): AccessDecision {
  if (!isLegalAccessCombination(action, resource.kind)) {
    return { allowed: false, invalid_request: ACCESS_INVALID_COMBINATION_ERROR };
  }
  if (principal.account_status === "disabled") {
    return { allowed: false, deny: "account_disabled" };
  }
  if (principal.role === "admin") {
    if (isTeachingAccessAction(action)) return { allowed: false, deny: "forbidden_role" };
    if (principal.scope.kind !== "school") return { allowed: false, deny: "forbidden_role" };
    return { allowed: true, projection: "full", via: "admin_school" };
  }
  const scope = principal.scope;
  if (scope.kind === "none") return { allowed: false, deny: "empty_scope" };
  if (scope.kind !== "classes") return { allowed: false, deny: "forbidden_role" };
  if (scope.class_ids.length === 0) return { allowed: false, deny: "empty_scope" };
  const inScope = (classId: string | null) => classId !== null && scope.class_ids.includes(classId);
  const allow = (via: Extract<AccessVia, "assigned_class" | "school_catalog" | "current_responsible">) =>
    ({ allowed: true, projection: "full", via }) as const;
  const denyOutOfScope: AccessDecision = { allowed: false, deny: "out_of_scope" };

  switch (action) {
    case "class.read":
      return inScope(currentClassOf(resource)) ? allow("assigned_class") : denyOutOfScope;
    case "class.catalog.read":
      return allow("school_catalog");
    case "class.manage":
    case "teacher.manage":
    case "teacher.assign":
    case "child.transfer":
    case "school.read":
      return { allowed: false, deny: "forbidden_role" };
    case "child.read":
    case "child.create_profile":
    case "observation.write":
    case "observation.organize":
    case "observation.confirm":
    case "guide.decide":
    case "growth_profile.write":
    case "activity_support.write":
      // 创建观察按幼儿资源、已有观察的教学操作按宿主观察资源，
      // 两者都以幼儿当前归属授权；原班历史只读不具备操作权。
      return inScope(currentClassOf(resource)) ? allow("current_responsible") : denyOutOfScope;
    case "observation.read": {
      if (inScope(currentClassOf(resource))) return allow("current_responsible");
      if (inScope(observedClassOf(resource))) {
        return { allowed: true, projection: "historical_read_only", via: "historical_class" };
      }
      return denyOutOfScope;
    }
  }
}

/** AuthState 入口：身份不可用 → 503 语义；未认证 → 401 语义 */
export function authorizeAuthState(
  auth: AuthState,
  action: AccessAction,
  resource: AccessResource,
): AccessDecision {
  if (auth.kind === "unavailable") return { allowed: false, deny: "identity_unavailable" };
  if (auth.kind !== "authenticated") return { allowed: false, deny: "unauthenticated" };
  return authorizeAction(auth.principal, action, resource);
}

/** 资源对应的幼儿当前归属（服务端事实），供 AUTH2 做模型等待 before/after 比较 */
export function childAttributionOf(resource: AccessResource): string | null {
  return currentClassOf(resource);
}

/** 模型等待归属前提比较（R2）：事实不同即不得保存旧请求结果 */
export function modelWaitPremiseChanged(before: AccessResource, after: AccessResource): boolean {
  return childAttributionOf(before) !== childAttributionOf(after);
}
