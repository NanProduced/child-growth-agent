import assert from "node:assert/strict";

import {
  FIXTURE_ACCESS_CASES,
  FIXTURE_ACCOUNT_IDS,
  FIXTURE_ADMIN_BOOTSTRAP_INPUT,
  FIXTURE_ADMIN_BOOTSTRAP_RESULT,
  FIXTURE_ADMIN_BOOTSTRAP_STATUS,
  FIXTURE_AUTH_ADMIN,
  FIXTURE_AUTH_ANONYMOUS,
  FIXTURE_AUTH_EXPIRED,
  FIXTURE_AUTH_REVOKED,
  FIXTURE_AUTH_TEACHER_A,
  FIXTURE_AUTH_TEACHER_B,
  FIXTURE_AUTH_TEACHER_DISABLED,
  FIXTURE_AUTH_TEACHER_EMPTY,
  FIXTURE_AUTH_TEACHER_REVOKED,
  FIXTURE_AUTH_UNAVAILABLE,
  FIXTURE_AUTH_UNKNOWN_TOKEN,
  FIXTURE_AUTHORIZATION_DENIED_RESULT,
  FIXTURE_AUTHORIZED_EMPTY_LIST,
  FIXTURE_BOOTSTRAP_CASES,
  FIXTURE_BOOTSTRAP_CONCURRENT,
  FIXTURE_CHILD_IDS,
  FIXTURE_CLASS_ASSIGNMENT_REQUEST,
  FIXTURE_CLASS_IDS,
  FIXTURE_CLASS_UNASSIGNMENT_REQUEST,
  FIXTURE_COOKIE_COEXISTENCE_CASES,
  FIXTURE_CSRF_BINDING,
  FIXTURE_CSRF_CASES,
  FIXTURE_EMPTY_CLASS_SCOPE,
  FIXTURE_LEGACY_COOKIE,
  FIXTURE_LEGACY_COOKIE_CLEAR,
  FIXTURE_LEGACY_COOKIE_STATE,
  FIXTURE_LOGIN_GUARD_CASES,
  FIXTURE_LOGIN_REQUEST,
  FIXTURE_LOGIN_RESPONSE,
  FIXTURE_LOGOUT_CASES,
  FIXTURE_LOGOUT_RESPONSE,
  FIXTURE_MODEL_WAIT_CASES,
  FIXTURE_NO_SCOPE,
  FIXTURE_PASSWORD_RAW,
  FIXTURE_PASSWORD_RESET_REQUEST,
  FIXTURE_PASSWORD_RESET_RESPONSE,
  FIXTURE_PASSWORD_USERNAME,
  FIXTURE_PRINCIPAL_TEACHER_A,
  FIXTURE_PRINCIPAL_TEACHER_B,
  FIXTURE_PRINCIPAL_TEACHER_EMPTY,
  FIXTURE_RELOGIN_SESSION_IDS,
  FIXTURE_SESSION_STATUS_ANONYMOUS,
  FIXTURE_SESSION_VIEW,
  FIXTURE_TEACHER_A_SUMMARY,
  FIXTURE_TEACHER_CREATE_REQUEST,
  FIXTURE_TEACHER_LIST_RESPONSE,
  FIXTURE_TEACHER_STATUS_REQUEST,
  FIXTURE_TEACHER_STATUS_RESPONSE,
  FIXTURE_TRUSTED_ORIGINS,
  type FixtureAccessCase,
} from "../src/lib/accounts/__fixtures__/contract-fixtures";
import {
  ACCESS_INVALID_COMBINATION_ERROR,
  ACCESS_RESOURCE_FACTS_SOURCE,
  ACTION_RESOURCE_KINDS,
  ADMIN_BOOTSTRAP_CONFLICT_CODE,
  ADMIN_BOOTSTRAP_PRECONDITIONS,
  AUTH_API_ACTIONS,
  AUTH_DENY_ERROR_CODE,
  AUTH_DENY_HTTP_STATUS,
  AUTH_ERROR_HTTP_STATUS,
  AUTH_LOGIN_CONTENT_TYPE,
  AUTH_LOGIN_HEADER_VALUE,
  AUTH_SESSION_TTL_SECONDS,
  AUTH_STATE_KINDS,
  CLIENT_CLEANUP_TARGETS,
  CSRF_FETCH_RENEWS_SESSION,
  CSRF_HEADER_NAME,
  CSRF_TOKEN_BINDING,
  DATA_SCOPE_NONE_REASONS,
  INVALID_SESSION_REASONS,
  LEGACY_AUTH_COOKIE,
  LOGOUT_SEMANTICS,
  MODEL_WAIT_EVENTS,
  MODEL_WAIT_RECHECK_POINTS,
  PASSWORD_HASH_FORMAT,
  PASSWORD_HASH_PARAMS,
  PASSWORD_SALT_MIN_BYTES,
  SESSION_RENEWAL_ON_GET,
  SESSION_WRITE_PROTECTION,
  TEACHING_ACCESS_ACTIONS,
  TRUSTED_ORIGIN_SOURCE,
  type AccessAction,
  type AccessDecision,
  type AccessResource,
  type AuthState,
  type DataScope,
} from "../src/lib/accounts/types";
import {
  FIXTURE_HOME_ADMIN,
  FIXTURE_HOME_CANDIDATE_READONLY_HISTORY,
  FIXTURE_HOME_CANDIDATES,
  FIXTURE_HOME_DATA_UNAVAILABLE,
  FIXTURE_HOME_IDENTITY_UNAVAILABLE,
  FIXTURE_HOME_LOGGED_OUT,
  FIXTURE_HOME_MASKED_CHILD_OBSERVATION,
  FIXTURE_HOME_PRIOR_CLASS_CONFIRMED,
  FIXTURE_HOME_STATES,
  FIXTURE_HOME_TEACHER_A,
  FIXTURE_HOME_TEACHER_A_EXPECTED_COUNTS,
  FIXTURE_HOME_TEACHER_B,
  FIXTURE_HOME_TEACHER_B_EXPECTED_COUNTS,
  FIXTURE_HOME_TEACHER_EMPTY,
  FIXTURE_HOME_TEACHER_NO_CHILDREN,
  FIXTURE_HOME_TEACHER_NO_OBSERVATIONS,
  FIXTURE_PRIMARY_ACTION_CASES,
  type FixtureHomeCandidate,
  type FixturePrimaryActionCase,
} from "../src/lib/home-v2/__fixtures__/contract-fixtures";
import {
  HOME_CLASS_STAGE_ORDER,
  HOME_VIEWER_KINDS,
  type HomeV2Data,
} from "../src/lib/home-v2/types";

/**
 * AUTH0-R2 契约最小检查：只读 fixture，不连数据库、不调用模型、不实现认证。
 * 运行：pnpm exec tsx scripts/check-auth-contract.ts
 *
 * 本文件的参考算法忠实于 `docs/auth-v1/contract.md`，用于验证 fixture 与规则一致性；
 * 它不是生产实现，不能替代真实认证、真实数据库、事务交错与浏览器验收（reference_only）。
 */

/* ------------------------------ 参考授权算法 ------------------------------ */

function isTeachingAction(action: AccessAction): boolean {
  return (TEACHING_ACCESS_ACTIONS as readonly string[]).includes(action);
}

function isLegalCombination(action: AccessAction, resourceKind: AccessResource["kind"]): boolean {
  return (ACTION_RESOURCE_KINDS[action] as readonly string[]).includes(resourceKind);
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

interface AccessInput {
  auth: AuthState;
  action: AccessAction;
  resource: AccessResource;
}

/**
 * 授权参考算法：先动作/资源组合合法性（400 invalid_request），
 * 再身份、账号状态、角色与范围。管理员不能绕过组合检查。
 */
function evaluateAccess(input: AccessInput): AccessDecision {
  if (!isLegalCombination(input.action, input.resource.kind)) {
    return { allowed: false, invalid_request: ACCESS_INVALID_COMBINATION_ERROR };
  }
  const { auth } = input;
  if (auth.kind === "unavailable") {
    return { allowed: false, deny: "identity_unavailable" };
  }
  if (auth.kind !== "authenticated") {
    return { allowed: false, deny: "unauthenticated" };
  }
  const principal = auth.principal;
  if (principal.account_status === "disabled") {
    return { allowed: false, deny: "account_disabled" };
  }
  if (principal.role === "admin") {
    if (isTeachingAction(input.action)) {
      return { allowed: false, deny: "forbidden_role" };
    }
    if (principal.scope.kind !== "school") {
      return { allowed: false, deny: "forbidden_role" };
    }
    return { allowed: true, projection: "full", via: "admin_school" };
  }
  const scope = principal.scope;
  if (scope.kind === "none") {
    return { allowed: false, deny: "empty_scope" };
  }
  if (scope.kind !== "classes") {
    return { allowed: false, deny: "forbidden_role" };
  }
  if (scope.class_ids.length === 0) {
    return { allowed: false, deny: "empty_scope" };
  }
  const inScope = (classId: string | null) => classId !== null && scope.class_ids.includes(classId);
  const allow = (via: "assigned_class" | "school_catalog" | "current_responsible") =>
    ({ allowed: true, projection: "full", via }) as const;
  const denyOutOfScope: AccessDecision = { allowed: false, deny: "out_of_scope" };

  switch (input.action) {
    case "class.read":
      return inScope(currentClassOf(input.resource)) ? allow("assigned_class") : denyOutOfScope;
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
      // 两者都以幼儿**当前归属**授权；原班历史只读不具备操作权。
      return inScope(currentClassOf(input.resource)) ? allow("current_responsible") : denyOutOfScope;
    case "observation.read": {
      if (inScope(currentClassOf(input.resource))) return allow("current_responsible");
      if (inScope(observedClassOf(input.resource))) {
        return { allowed: true, projection: "historical_read_only", via: "historical_class" };
      }
      return denyOutOfScope;
    }
  }
}

function assertMatchesExpectation(entry: FixtureAccessCase): void {
  const decision = evaluateAccess(entry);
  assert.equal(decision.allowed, entry.expected.allowed, `${entry.name}: allowed 不一致`);
  if (decision.allowed && entry.expected.allowed) {
    assert.equal(decision.via, entry.expected.via, `${entry.name}: via 不一致`);
    assert.equal(decision.projection, entry.expected.projection, `${entry.name}: projection 不一致`);
  }
  if (!decision.allowed && !entry.expected.allowed) {
    if (entry.expected.invalid_request) {
      assert.ok(
        "invalid_request" in decision && decision.invalid_request === entry.expected.invalid_request,
        `${entry.name}: 期望 400 非法组合`,
      );
      assert.equal(AUTH_ERROR_HTTP_STATUS.invalid_request, 400);
      return;
    }
    const expectedDeny = entry.expected.deny;
    assert.ok(expectedDeny, `${entry.name}: 期望缺少 deny`);
    assert.ok("deny" in decision, `${entry.name}: 期望 deny 拒绝`);
    assert.equal(decision.deny, expectedDeny, `${entry.name}: deny 不一致`);
    assert.equal(
      AUTH_DENY_HTTP_STATUS[decision.deny],
      AUTH_DENY_HTTP_STATUS[expectedDeny],
      `${entry.name}: deny 映射不一致`,
    );
  }
}

/* ------------------------------ 登录前请求保护 ------------------------------ */

type LoginGuardResult =
  | { accepted: true }
  | {
      accepted: false;
      failure:
        | "origin_untrusted"
        | "same_origin_proof_missing"
        | "auth_request_header_missing"
        | "content_type_rejected";
    };

/** 媒体类型主体精确匹配 application/json：大小写不敏感，允许 charset 等参数，不做前缀匹配 */
function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false;
  const essence = value.split(";", 1)[0]?.trim().toLowerCase();
  return essence === AUTH_LOGIN_CONTENT_TYPE;
}

/** 可信源只来自部署配置；Host / Forwarded / Sec-Fetch 请求头不参与可信源判定 */
function evaluateLoginGuard(facts: {
  origin: string | null;
  auth_request_header: string | null;
  content_type: string | null;
}): LoginGuardResult {
  if (facts.origin === null) {
    return { accepted: false, failure: "same_origin_proof_missing" };
  }
  if (facts.origin === "null" || !(FIXTURE_TRUSTED_ORIGINS as readonly string[]).includes(facts.origin)) {
    return { accepted: false, failure: "origin_untrusted" };
  }
  if (facts.auth_request_header !== AUTH_LOGIN_HEADER_VALUE) {
    return { accepted: false, failure: "auth_request_header_missing" };
  }
  if (!isJsonMediaType(facts.content_type)) {
    return { accepted: false, failure: "content_type_rejected" };
  }
  return { accepted: true };
}

function evaluateCsrf(sessionId: string, token: string | null): "accepted" | "csrf_rejected" {
  const binding: Record<string, string> = {
    [FIXTURE_CSRF_BINDING.session_a.session_id]: FIXTURE_CSRF_BINDING.session_a.token,
    [FIXTURE_CSRF_BINDING.session_b.session_id]: FIXTURE_CSRF_BINDING.session_b.token,
  };
  return binding[sessionId] !== undefined && token === binding[sessionId]
    ? "accepted"
    : "csrf_rejected";
}

/* ------------------------------ 初始化与模型等待 ------------------------------ */

function evaluateBootstrap(entry: { context: string; admins_exist: boolean }) {
  if (entry.context !== "deployer_non_public_script") {
    return { accepted: false, error: "not_deployer" as const };
  }
  if (entry.admins_exist) {
    return { accepted: false, error: ADMIN_BOOTSTRAP_CONFLICT_CODE };
  }
  return { accepted: true, error: null };
}

/** 请求开始与保存前的幼儿当前归属必须一致；比较 before/after 事实，不依赖事件标签 */
function modelWaitAttributionChanged(entry: (typeof FIXTURE_MODEL_WAIT_CASES)[number]): boolean {
  return currentClassOf(entry.before.resource) !== currentClassOf(entry.after.resource);
}

function evaluateModelWait(entry: (typeof FIXTURE_MODEL_WAIT_CASES)[number]) {
  if (entry.event === "observation_changed") {
    return { write: false, outcome: "conflict" as const, error: "state_conflict" as const };
  }
  if (entry.event === "principal_replaced") {
    return { write: false, outcome: "conflict" as const, error: "attempt_owner_mismatch" as const };
  }
  // 先做保存前授权重核：失效时保留 401/403/503 语义
  const decision = evaluateAccess(entry.after);
  if (!decision.allowed) {
    assert.ok("deny" in decision, "模型等待重核失败必须是显式拒绝");
    return { write: false, outcome: "denied" as const, deny: decision.deny };
  }
  // 授权仍有效但归属前提变化：即使仍在同一教师范围内，也不得保存旧请求结果
  if (modelWaitAttributionChanged(entry)) {
    return { write: false, outcome: "conflict" as const, error: "state_conflict" as const };
  }
  return { write: true, outcome: "saved" as const };
}

/* ------------------------------ 首页参考算法 ------------------------------ */

function pendingActionFor(status: FixtureHomeCandidate["observation"]["status"]): AccessAction | null {
  switch (status) {
    case "ai_organized":
      return "observation.confirm";
    case "needs_input":
    case "draft":
      return "observation.organize";
    case "confirmed":
      return null;
  }
}

function observationResourceOf(candidate: FixtureHomeCandidate): AccessResource {
  return {
    kind: "observation",
    observation_id: candidate.observation.observation_id,
    child_id: candidate.observation.child_id,
    current_class_id: candidate.child_current_class_id,
    observed_class_id: candidate.observed_class_id,
    author_account_id: null,
  };
}

/** 可操作待办：仅当前具有教学操作权限的记录；原班历史只读被排除 */
function computeOperablePending(auth: AuthState, candidates: FixtureHomeCandidate[]) {
  const pending: FixtureHomeCandidate["observation"][] = [];
  const counts = { confirmations: 0, supplements: 0, organizes: 0 };
  for (const candidate of candidates) {
    const action = pendingActionFor(candidate.observation.status);
    if (action === null) continue;
    const decision = evaluateAccess({ auth, action, resource: observationResourceOf(candidate) });
    if (!decision.allowed) continue;
    pending.push(candidate.observation);
    if (candidate.observation.status === "ai_organized") counts.confirmations += 1;
    else if (candidate.observation.status === "needs_input") counts.supplements += 1;
    else counts.organizes += 1;
  }
  return { pending, counts };
}

function nextPrimaryAction(entry: FixturePrimaryActionCase) {
  if (entry.counts === null) return "retry";
  if (entry.viewer === "admin") return "manage_school";
  // 高优先级待办数量未知：不得当作 0 继续选择较低优先级动作
  if (entry.counts.confirmations === null) return "retry";
  if (entry.counts.confirmations > 0) return "process_confirmations";
  if (entry.counts.supplements === null) return "retry";
  if (entry.counts.supplements > 0) return "supplement_observation";
  if (entry.counts.organizes === null) return "retry";
  if (entry.counts.organizes > 0) return "organize_draft";
  // 待办全部已知为 0，才依据范围数量决定建档/新记录；未知不等零
  if (entry.class_count === null) return "retry";
  if (entry.class_count === 0) return "await_class_assignment";
  if (entry.child_count === null) return "retry";
  if (entry.child_count === 0) return "create_profile";
  return "start_observation";
}

/* -------------------------------- 辅助检查 -------------------------------- */

function collectClassIds(home: HomeV2Data): string[] {
  return home.class_groups.flatMap((group) => group.classes.map((klass) => klass.class_id));
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function assertNoForbiddenKeys(value: unknown, forbidden: string[], label: string): void {
  for (const key of collectKeys(value)) {
    assert.ok(!forbidden.includes(key), `${label}: 不应包含字段 ${key}`);
  }
}

function scopeEqualsAll(scope: DataScope): boolean {
  return scope.kind === "school";
}

const SCHOOL_RESOURCE: AccessResource = { kind: "school", school_id: "f0a00000-0000-4000-8000-000000000001" };
const CLASS_RESOURCE_A: AccessResource = { kind: "class", class_id: FIXTURE_CLASS_IDS.sunflower };
const CHILD_RESOURCE_A: AccessResource = {
  kind: "child",
  child_id: FIXTURE_CHILD_IDS.current,
  current_class_id: FIXTURE_CLASS_IDS.sunflower,
};
const OBSERVATION_RESOURCE_A: AccessResource = {
  kind: "observation",
  observation_id: "0b5e0000-0000-4000-8000-000000000004",
  child_id: FIXTURE_CHILD_IDS.current,
  current_class_id: FIXTURE_CLASS_IDS.sunflower,
  observed_class_id: FIXTURE_CLASS_IDS.sunflower,
  author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
};

/** 为教学动作构造一个合法资源，专用于“组合合法但角色拒绝”的验证 */
function legalResourceFor(action: AccessAction): AccessResource {
  const kind = ACTION_RESOURCE_KINDS[action][0];
  switch (kind) {
    case "school":
      return SCHOOL_RESOURCE;
    case "class":
      return CLASS_RESOURCE_A;
    case "child":
      return CHILD_RESOURCE_A;
    case "transfer":
      return {
        kind: "transfer",
        child_id: FIXTURE_CHILD_IDS.current,
        current_class_id: FIXTURE_CLASS_IDS.sunflower,
        target_class_id: FIXTURE_CLASS_IDS.tulip,
      };
    case "observation":
      return OBSERVATION_RESOURCE_A;
  }
}

function main(): void {
  let passed = 0;

  /* 1) AuthState 四态，身份不可用单独表达，不强制变成匿名 */
  assert.deepEqual([...AUTH_STATE_KINDS], [
    "authenticated",
    "anonymous",
    "invalid_session",
    "unavailable",
  ]);
  assert.equal(FIXTURE_AUTH_ANONYMOUS.kind, "anonymous");
  assert.equal(FIXTURE_AUTH_UNAVAILABLE.kind, "unavailable");
  assert.ok(
    FIXTURE_AUTH_UNAVAILABLE.kind === "unavailable" &&
      FIXTURE_AUTH_UNAVAILABLE.reason === "identity_service_unavailable",
  );
  assert.notEqual(FIXTURE_AUTH_UNAVAILABLE.kind, "anonymous", "身份服务不可用不得降级为匿名");
  assert.equal(FIXTURE_AUTH_TEACHER_EMPTY.kind, "authenticated");
  passed += 1;

  /* 2) 未知/过期/撤销/旧 Cookie 会话一律 invalid_session，按 401 处理 */
  assert.deepEqual([...INVALID_SESSION_REASONS], [
    "expired",
    "revoked",
    "unknown_token",
    "legacy_cookie_not_accepted",
  ]);
  for (const state of [
    FIXTURE_AUTH_UNKNOWN_TOKEN,
    FIXTURE_AUTH_REVOKED,
    FIXTURE_AUTH_EXPIRED,
    FIXTURE_LEGACY_COOKIE_STATE,
  ]) {
    assert.equal(state.kind, "invalid_session");
  }
  assert.equal(FIXTURE_LEGACY_COOKIE.cookie_name, LEGACY_AUTH_COOKIE);
  assert.ok(
    FIXTURE_LEGACY_COOKIE_STATE.kind === "invalid_session" &&
      FIXTURE_LEGACY_COOKIE_STATE.reason === "legacy_cookie_not_accepted",
  );
  passed += 1;

  /* 3) DataScope 三形态严格区分：空数组明确为空，不等于全园 */
  assert.deepEqual([...DATA_SCOPE_NONE_REASONS], [
    "no_assignment",
    "account_disabled",
    "no_business_scope",
  ]);
  assert.equal(scopeEqualsAll(FIXTURE_EMPTY_CLASS_SCOPE), false);
  assert.equal(scopeEqualsAll(FIXTURE_NO_SCOPE), false);
  assert.equal(scopeEqualsAll({ kind: "school", school_id: "s" }), true);
  assert.equal(FIXTURE_EMPTY_CLASS_SCOPE.kind, "classes");
  assert.equal(FIXTURE_EMPTY_CLASS_SCOPE.class_ids.length, 0);
  passed += 1;

  /* 4) 两教师班级不同/重叠、多班、空分配结构 */
  const scopeA = FIXTURE_PRINCIPAL_TEACHER_A.scope;
  const scopeB = FIXTURE_PRINCIPAL_TEACHER_B.scope;
  assert.ok(scopeA.kind === "classes" && scopeB.kind === "classes");
  assert.ok(scopeA.class_ids.length >= 2, "教师 A 应为多班");
  assert.deepEqual(
    scopeA.class_ids.filter((id) => scopeB.class_ids.includes(id)),
    [FIXTURE_CLASS_IDS.tulip],
    "两教师应在郁金香班重叠",
  );
  assert.ok(
    scopeA.class_ids.some((id) => !scopeB.class_ids.includes(id)),
    "两教师班级集合必须不同",
  );
  assert.ok(FIXTURE_PRINCIPAL_TEACHER_EMPTY.scope.kind === "classes");
  assert.equal(FIXTURE_PRINCIPAL_TEACHER_EMPTY.scope.class_ids.length, 0, "空分配必须显式为空数组");
  passed += 1;

  /* 5) 动作/资源组合表完整、冻结为服务端事实 */
  assert.equal(ACCESS_RESOURCE_FACTS_SOURCE, "server_read", "资源事实必须由服务端读取");
  for (const action of Object.keys(ACTION_RESOURCE_KINDS)) {
    assert.ok(
      ACTION_RESOURCE_KINDS[action as AccessAction].length > 0,
      `${action} 必须至少有一种合法资源`,
    );
  }
  assert.deepEqual(ACTION_RESOURCE_KINDS["observation.write"], ["child"]);
  assert.deepEqual(ACTION_RESOURCE_KINDS["observation.organize"], ["observation"]);
  assert.deepEqual(ACTION_RESOURCE_KINDS["observation.confirm"], ["observation"]);
  assert.deepEqual(ACTION_RESOURCE_KINDS["guide.decide"], ["observation"]);
  assert.deepEqual(ACTION_RESOURCE_KINDS["child.create_profile"], ["class"]);
  assert.deepEqual(ACTION_RESOURCE_KINDS["child.transfer"], ["transfer"]);
  passed += 1;

  /* 6) 非法组合先于角色与范围：教师、管理员、匿名一律 400，不进入允许分支 */
  const illegalProbes: AccessInput[] = [
    { auth: FIXTURE_AUTH_TEACHER_A, action: "observation.confirm", resource: CLASS_RESOURCE_A },
    { auth: FIXTURE_AUTH_ADMIN, action: "observation.confirm", resource: CLASS_RESOURCE_A },
    { auth: FIXTURE_AUTH_ANONYMOUS, action: "observation.confirm", resource: CLASS_RESOURCE_A },
    { auth: FIXTURE_AUTH_TEACHER_A, action: "observation.write", resource: OBSERVATION_RESOURCE_A },
    { auth: FIXTURE_AUTH_TEACHER_A, action: "growth_profile.write", resource: OBSERVATION_RESOURCE_A },
    { auth: FIXTURE_AUTH_TEACHER_A, action: "guide.decide", resource: CHILD_RESOURCE_A },
    { auth: FIXTURE_AUTH_ADMIN, action: "teacher.manage", resource: CLASS_RESOURCE_A },
  ];
  for (const probe of illegalProbes) {
    const decision = evaluateAccess(probe);
    assert.equal(decision.allowed, false);
    assert.ok(
      "invalid_request" in decision && decision.invalid_request === ACCESS_INVALID_COMBINATION_ERROR,
      `非法组合必须返回 invalid_request：${probe.action} + ${probe.resource.kind}`,
    );
    assert.ok(!("deny" in decision), "非法组合不得进入 401/403/503 授权分支");
  }
  passed += 1;

  /* 7) 全部授权用例与参考算法一致，反例场景齐全 */
  const requiredCaseNames = [
    "logged-out-school-read",
    "unknown-token-child-read",
    "revoked-session-class-read",
    "identity-unavailable-fail-closed",
    "admin-teaching-write-denied",
    "admin-teaching-organize-denied",
    "admin-teaching-confirm-denied",
    "admin-guide-decision-denied",
    "teacher-b-read-other-class-denied",
    "class-catalog-separate-from-membership",
    "teacher-empty-scope-denied",
    "teacher-a-child-transferred-profile-denied",
    "teacher-a-read-transferred-history-observation",
    "teacher-a-operate-transferred-history-denied",
    "teacher-b-confirm-prior-class-history",
    "current-responsible-reads-prior-class-history",
    "teacher-a-write-observation-for-current-child",
    "teacher-a-organize-existing-observation",
    "teacher-a-confirm-existing-observation",
    "author-is-not-authorization-after-revocation",
    "disabled-author-history-still-readable",
    "admin-class-history-protection-is-business-conflict",
    "invalid-combo-confirm-with-class",
    "invalid-combo-admin-confirm-with-class",
    "invalid-combo-write-with-observation",
    "invalid-combo-profile-with-observation",
    "invalid-combo-guide-with-child",
    "invalid-combo-teacher-manage-with-class",
  ];
  for (const name of requiredCaseNames) {
    assert.ok(
      FIXTURE_ACCESS_CASES.some((entry) => entry.name === name),
      `fixture 缺少反例场景 ${name}`,
    );
  }
  for (const entry of FIXTURE_ACCESS_CASES) {
    assertMatchesExpectation(entry);
  }
  passed += 1;

  /* 8) 管理员教学动作组合合法时也拒绝；管理动作允许；教师管理动作拒绝 */
  for (const action of TEACHING_ACCESS_ACTIONS) {
    const decision = evaluateAccess({
      auth: FIXTURE_AUTH_ADMIN,
      action,
      resource: legalResourceFor(action),
    });
    assert.deepEqual(
      decision,
      { allowed: false, deny: "forbidden_role" },
      `管理员教学动作 ${action} 必须拒绝`,
    );
  }
  for (const action of ["class.manage", "teacher.manage", "teacher.assign", "child.transfer"] as const) {
    const decision = evaluateAccess({ auth: FIXTURE_AUTH_ADMIN, action, resource: legalResourceFor(action) });
    assert.equal(decision.allowed, true, `管理员管理动作 ${action} 应允许`);
  }
  assert.equal(
    evaluateAccess({ auth: FIXTURE_AUTH_TEACHER_A, action: "class.manage", resource: CLASS_RESOURCE_A }).allowed,
    false,
  );
  passed += 1;

  /* 9) 空分配教师：可登录（authenticated）但业务访问为空范围拒绝 */
  assert.deepEqual(
    evaluateAccess({ auth: FIXTURE_AUTH_TEACHER_EMPTY, action: "class.read", resource: CLASS_RESOURCE_A }),
    { allowed: false, deny: "empty_scope" },
  );
  passed += 1;

  /* 10) 转班历史：当前负责读整份与操作；原班仅历史只读且不可操作 */
  const transferredHistory: AccessResource = {
    kind: "observation",
    observation_id: "obs-history",
    child_id: FIXTURE_CHILD_IDS.transferred,
    current_class_id: FIXTURE_CLASS_IDS.daisy,
    observed_class_id: FIXTURE_CLASS_IDS.sunflower,
    author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
  };
  assert.deepEqual(
    evaluateAccess({ auth: FIXTURE_AUTH_TEACHER_A, action: "observation.read", resource: transferredHistory }),
    { allowed: true, projection: "historical_read_only", via: "historical_class" },
  );
  assert.deepEqual(
    evaluateAccess({ auth: FIXTURE_AUTH_TEACHER_B, action: "observation.read", resource: transferredHistory }),
    { allowed: true, projection: "full", via: "current_responsible" },
  );
  assert.deepEqual(
    evaluateAccess({
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: transferredHistory,
    }),
    { allowed: false, deny: "out_of_scope" },
  );
  assert.deepEqual(
    evaluateAccess({
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "child.read",
      resource: { kind: "child", child_id: FIXTURE_CHILD_IDS.transferred, current_class_id: FIXTURE_CLASS_IDS.daisy },
    }),
    { allowed: false, deny: "out_of_scope" },
  );
  passed += 1;

  /* 11) 作者≠授权；停用作者不使历史失效；停用账号业务拒绝 */
  assert.deepEqual(
    evaluateAccess({
      auth: FIXTURE_AUTH_TEACHER_REVOKED,
      action: "observation.read",
      resource: {
        kind: "observation",
        observation_id: "obs-authored",
        child_id: FIXTURE_CHILD_IDS.current,
        current_class_id: FIXTURE_CLASS_IDS.sunflower,
        observed_class_id: FIXTURE_CLASS_IDS.sunflower,
        author_account_id: FIXTURE_ACCOUNT_IDS.teacherRevoked,
      },
    }),
    { allowed: false, deny: "out_of_scope" },
  );
  assert.equal(
    evaluateAccess({
      auth: FIXTURE_AUTH_TEACHER_B,
      action: "observation.read",
      resource: {
        kind: "observation",
        observation_id: "obs-by-disabled",
        child_id: FIXTURE_CHILD_IDS.current,
        current_class_id: FIXTURE_CLASS_IDS.tulip,
        observed_class_id: FIXTURE_CLASS_IDS.tulip,
        author_account_id: FIXTURE_ACCOUNT_IDS.teacherDisabled,
      },
    }).allowed,
    true,
    "停用账号不使历史观察失效",
  );
  assert.deepEqual(
    evaluateAccess({ auth: FIXTURE_AUTH_TEACHER_DISABLED, action: "class.read", resource: CLASS_RESOURCE_A }),
    { allowed: false, deny: "account_disabled" },
  );
  passed += 1;

  /* 12) 错误不等空数据：拒绝必须显式，不能伪装成“没有记录” */
  assert.equal(FIXTURE_AUTHORIZATION_DENIED_RESULT.allowed, false);
  assert.ok(!("data" in FIXTURE_AUTHORIZATION_DENIED_RESULT), "授权错误不得携带空数据字段");
  assert.deepEqual(FIXTURE_AUTHORIZED_EMPTY_LIST.items, [], "有权查看的空集合才是正常空数据");
  assert.notEqual(
    JSON.stringify(FIXTURE_AUTHORIZATION_DENIED_RESULT),
    JSON.stringify(FIXTURE_AUTHORIZED_EMPTY_LIST),
    "错误与空数据必须形态不同",
  );
  passed += 1;

  /* 13) 授权拒绝原因 → 错误码 → HTTP：forbidden_role / out_of_scope 表达为 403 */
  assert.equal(AUTH_DENY_ERROR_CODE.forbidden_role, "forbidden_role");
  assert.equal(AUTH_DENY_ERROR_CODE.out_of_scope, "out_of_scope");
  for (const [deny, code] of Object.entries(AUTH_DENY_ERROR_CODE)) {
    assert.equal(
      AUTH_ERROR_HTTP_STATUS[code],
      AUTH_DENY_HTTP_STATUS[deny as keyof typeof AUTH_DENY_HTTP_STATUS],
      `${deny} → ${code} 状态必须一致`,
    );
  }
  assert.equal(AUTH_ERROR_HTTP_STATUS.forbidden_role, 403);
  assert.equal(AUTH_ERROR_HTTP_STATUS.out_of_scope, 403);
  assert.equal(AUTH_ERROR_HTTP_STATUS.empty_scope, 403);
  assert.equal(AUTH_ERROR_HTTP_STATUS.account_disabled, 403);
  assert.equal(AUTH_ERROR_HTTP_STATUS.identity_unavailable, 503);
  assert.equal(AUTH_ERROR_HTTP_STATUS.state_conflict, 409);
  assert.ok(
    !(Object.values(AUTH_DENY_HTTP_STATUS) as number[]).includes(409),
    "授权错误不得占用 409",
  );
  passed += 1;

  /* 14) 密码固定参数、maxmem、盐长度、原样密码处理 */
  assert.equal(PASSWORD_HASH_PARAMS.N, 32768);
  assert.equal(PASSWORD_HASH_PARAMS.r, 8);
  assert.equal(PASSWORD_HASH_PARAMS.p, 3);
  assert.equal(PASSWORD_HASH_PARAMS.key_length, 64);
  assert.equal(PASSWORD_HASH_PARAMS.maxmem, 64 * 1024 * 1024);
  assert.equal(PASSWORD_SALT_MIN_BYTES, 16);
  assert.deepEqual(PASSWORD_HASH_FORMAT.split("$"), [
    "scrypt",
    "<N>",
    "<r>",
    "<p>",
    "<salt_base64>",
    "<hash_base64>",
  ]);
  assert.equal(AUTH_SESSION_TTL_SECONDS, 7 * 24 * 60 * 60);
  assert.equal(FIXTURE_LOGIN_REQUEST.password, FIXTURE_PASSWORD_RAW);
  assert.ok(FIXTURE_PASSWORD_RAW.startsWith("  ") && FIXTURE_PASSWORD_RAW.endsWith(" "), "密码原样用于哈希");
  assert.equal(FIXTURE_PASSWORD_USERNAME.trim().toLowerCase(), "lilaoshi", "用户名规范化与密码处理分开");
  passed += 1;

  /* 15) 登录前保护：可信源来自部署配置；跨源/Origin=null/缺头/普通表单拒绝；旧 Cookie 不阻断 */
  assert.equal(TRUSTED_ORIGIN_SOURCE, "deployment_config");
  for (const entry of FIXTURE_LOGIN_GUARD_CASES) {
    const result = evaluateLoginGuard(entry);
    if (entry.expected.accepted) {
      assert.deepEqual(result, { accepted: true }, `${entry.name}: 合规登录应接受`);
    } else {
      assert.deepEqual(
        result,
        { accepted: false, failure: entry.expected.failure },
        `${entry.name}: 登录保护结果不一致`,
      );
    }
  }
  const validLogin = FIXTURE_LOGIN_GUARD_CASES.find((entry) => entry.name === "valid-pre-login-without-session");
  assert.ok(validLogin);
  assert.equal(validLogin.has_session_cookie, false, "登录前没有会话，不得要求会话 CSRF");
  assert.equal(validLogin.has_legacy_cookie, true, "旧 Cookie 不得阻断新账号登录");
  passed += 1;

  /* 16) 登录后写保护：同源 + 有效会话 + 会话绑定 CSRF；GET 不续期、取令牌不续期 */
  assert.deepEqual([...SESSION_WRITE_PROTECTION], [
    "same_origin_check",
    "valid_session",
    "session_bound_csrf_token",
  ]);
  assert.equal(CSRF_TOKEN_BINDING, "session");
  assert.equal(SESSION_RENEWAL_ON_GET, false, "GET 不得续期或写库");
  assert.equal(CSRF_FETCH_RENEWS_SESSION, false, "获取 CSRF 令牌不得更新会期");
  assert.equal(AUTH_LOGIN_HEADER_VALUE, "1");
  passed += 1;

  /* 17) 会话绑定 CSRF：另一会话令牌不能用于当前会话 */
  for (const entry of FIXTURE_CSRF_CASES) {
    assert.equal(
      evaluateCsrf(entry.session_id, entry.token),
      entry.expected,
      `${entry.name}: CSRF 绑定结果不一致`,
    );
  }
  const otherSessionCase = FIXTURE_CSRF_CASES.find((entry) => entry.name === "other-session-token-rejected");
  assert.ok(otherSessionCase && otherSessionCase.token !== null, "复审反例必须存在另一会话令牌");
  passed += 1;

  /* 18) 退出语义、旧 Cookie 服务端清理、新旧 Cookie 并存 */
  for (const entry of FIXTURE_LOGOUT_CASES) {
    assert.equal(entry.expected.status, 200);
    assert.equal(entry.expected.clear_cookies, true);
    if (entry.session === "valid") assert.equal(entry.expected.revoke_current, true);
    else assert.equal(entry.expected.revoke_current, false, "失效/缺失会话退出必须幂等");
  }
  assert.deepEqual([...LOGOUT_SEMANTICS], [
    "revoke_current_session_when_valid",
    "clear_new_and_legacy_cookies",
    "idempotent_when_session_invalid",
  ]);
  assert.equal(FIXTURE_LEGACY_COOKIE_CLEAR.cookie_name, LEGACY_AUTH_COOKIE);
  assert.equal(FIXTURE_LEGACY_COOKIE_CLEAR.path, FIXTURE_LEGACY_COOKIE.clear_path, "旧 Cookie 由服务端按原路径清除");
  for (const entry of FIXTURE_COOKIE_COEXISTENCE_CASES) {
    assert.equal(entry.login_allowed, true, "旧 Cookie 不得阻断新账号登录");
    if (entry.new_session === "valid") assert.equal(entry.expected_state, "authenticated");
    else assert.equal(entry.expected_state, "invalid_session", "旧 Cookie 不提升权限");
  }
  assert.equal(FIXTURE_LOGOUT_RESPONSE.state.kind, "anonymous");
  assert.equal(FIXTURE_LOGOUT_RESPONSE.cleanup.length, CLIENT_CLEANUP_TARGETS.length);
  assert.equal(FIXTURE_LOGIN_RESPONSE.csrf?.header_name, CSRF_HEADER_NAME);
  assert.equal(FIXTURE_SESSION_STATUS_ANONYMOUS.session, null);
  passed += 1;

  /* 19) 登录建立全新会话：不沿用旧会话/旧令牌 */
  assert.notEqual(FIXTURE_RELOGIN_SESSION_IDS.previous, FIXTURE_RELOGIN_SESSION_IDS.next);
  passed += 1;

  /* 20) 首位管理员初始化：只有部署者脚本可成功；已有管理员拒绝；并发唯一成功；无公开接口 */
  for (const entry of FIXTURE_BOOTSTRAP_CASES) {
    const result = evaluateBootstrap(entry);
    if (entry.expected.accepted) {
      assert.deepEqual(result, { accepted: true, error: null }, `${entry.name}: 部署者脚本应成功`);
    } else {
      assert.deepEqual(
        result,
        { accepted: false, error: entry.expected.error },
        `${entry.name}: 初始化资格/一次性语义不一致`,
      );
    }
  }
  let admins = FIXTURE_BOOTSTRAP_CONCURRENT.initial_admins;
  let successes = 0;
  let conflicts = 0;
  for (let i = 0; i < FIXTURE_BOOTSTRAP_CONCURRENT.attempts; i += 1) {
    const result = evaluateBootstrap({ context: "deployer_non_public_script", admins_exist: admins > 0 });
    if (result.accepted) {
      successes += 1;
      admins += 1;
    } else if (result.error === ADMIN_BOOTSTRAP_CONFLICT_CODE) {
      conflicts += 1;
    }
  }
  assert.equal(successes, FIXTURE_BOOTSTRAP_CONCURRENT.expected_successes, "并发初始化只允许一个成功");
  assert.equal(conflicts, FIXTURE_BOOTSTRAP_CONCURRENT.expected_conflicts, "并发失败方得到 admin_already_initialized");
  assert.equal(admins, 1, "已有管理员不得被覆盖或重置");
  assert.ok(ADMIN_BOOTSTRAP_PRECONDITIONS.includes("no_overwrite_or_reset"));
  assert.ok(ADMIN_BOOTSTRAP_PRECONDITIONS.includes("password_not_from_argv_env_or_log"));
  assert.ok(
    !AUTH_API_ACTIONS.some((action) => action.includes("initialize")),
    "不存在公开初始化接口",
  );
  passed += 1;

  /* 21) 部署者初始化 DTO 非公开、无默认密码；其余接口 DTO 完整 */
  assert.equal(FIXTURE_ADMIN_BOOTSTRAP_STATUS.admin_initialized, false);
  assert.ok(FIXTURE_ADMIN_BOOTSTRAP_INPUT.password.length > 0);
  assert.equal(FIXTURE_ADMIN_BOOTSTRAP_RESULT.principal.role, "admin");
  assert.equal(FIXTURE_TEACHER_LIST_RESPONSE.teachers.length, 2);
  assert.equal(FIXTURE_TEACHER_A_SUMMARY.role, "teacher");
  assert.equal(FIXTURE_TEACHER_CREATE_REQUEST.username.length > 0, true);
  assert.equal(FIXTURE_TEACHER_STATUS_REQUEST.status, "disabled");
  assert.ok(FIXTURE_TEACHER_STATUS_RESPONSE.revoked_session_count > 0, "停用必须撤销会话");
  assert.ok(FIXTURE_PASSWORD_RESET_REQUEST.new_password.length > 0);
  assert.ok(FIXTURE_PASSWORD_RESET_RESPONSE.revoked_session_count > 0, "重置密码必须撤销会话");
  assert.ok(FIXTURE_CLASS_ASSIGNMENT_REQUEST.class_id.length > 0);
  assert.ok(FIXTURE_CLASS_UNASSIGNMENT_REQUEST.reason);
  passed += 1;

  /* 22) 模型等待期间的重核：撤权/停用/转班拒绝保存，修订与归属变化冲突，零写入 */
  for (const entry of FIXTURE_MODEL_WAIT_CASES) {
    const result = evaluateModelWait(entry);
    assert.deepEqual(result, entry.expected, `${entry.name}: 模型等待重核结果不一致`);
    if (entry.event !== "none" || modelWaitAttributionChanged(entry)) {
      assert.equal(result.write, false, `${entry.name}: 等待期间发生变化必须零写入`);
    }
  }
  assert.deepEqual([...MODEL_WAIT_EVENTS], [
    "none",
    "session_revoked",
    "account_disabled",
    "assignment_removed",
    "child_transferred",
    "observation_changed",
    "principal_replaced",
  ]);
  passed += 1;

  /* 23) 重核清单冻结：模型事务外 + 返回后核对全部事实 */
  assert.deepEqual([...MODEL_WAIT_RECHECK_POINTS], [
    "session_valid",
    "account_active",
    "role_and_action_permission",
    "assignment_current",
    "child_current_attribution",
    "target_observation_revision",
    "attempt_owner",
  ]);
  passed += 1;

  /* 24) 首页四态由服务端判定 */
  assert.deepEqual([...HOME_VIEWER_KINDS], ["logged_out", "teacher", "admin", "identity_unavailable"]);
  assert.equal(FIXTURE_HOME_LOGGED_OUT.viewer.kind, "logged_out");
  assert.equal(FIXTURE_HOME_TEACHER_A.viewer.kind, "teacher");
  assert.equal(FIXTURE_HOME_ADMIN.viewer.kind, "admin");
  assert.equal(FIXTURE_HOME_IDENTITY_UNAVAILABLE.viewer.kind, "identity_unavailable");
  passed += 1;

  /* 25) 未登录首页：不加载任何园所数据，文案统一为园所账号登录 */
  assert.equal(FIXTURE_HOME_LOGGED_OUT.scope, null);
  assert.deepEqual(FIXTURE_HOME_LOGGED_OUT.class_groups, []);
  assert.deepEqual(FIXTURE_HOME_LOGGED_OUT.pending, []);
  assert.deepEqual(FIXTURE_HOME_LOGGED_OUT.recent, []);
  assert.equal(FIXTURE_HOME_LOGGED_OUT.primary_action.code, "login");
  assert.equal(FIXTURE_HOME_LOGGED_OUT.primary_action.label, "园所账号登录");
  passed += 1;

  /* 26) 教师 A 首页：可操作待办仅含当前任教班级；转走幼儿历史只读被排除 */
  const operableA = computeOperablePending(FIXTURE_AUTH_TEACHER_A, FIXTURE_HOME_CANDIDATES);
  assert.deepEqual(operableA.counts, FIXTURE_HOME_TEACHER_A_EXPECTED_COUNTS);
  assert.deepEqual(
    [...operableA.pending.map((item) => item.observation_id)].sort(),
    [...FIXTURE_HOME_TEACHER_A.pending.map((item) => item.observation_id)].sort(),
    "教师 A 可操作待办与 fixture 必须一致",
  );
  assert.ok(
    !operableA.pending.some(
      (item) => item.observation_id === FIXTURE_HOME_CANDIDATE_READONLY_HISTORY.observation.observation_id,
    ),
    "转走幼儿的历史只读记录不得进入可操作待办",
  );
  assert.deepEqual(FIXTURE_HOME_TEACHER_A.pending_counts, {
    availability: "available",
    ...FIXTURE_HOME_TEACHER_A_EXPECTED_COUNTS,
  });
  assert.ok(!JSON.stringify(FIXTURE_HOME_TEACHER_A).includes(FIXTURE_CLASS_IDS.daisy));
  passed += 1;

  /* 27) 教师 B 首页：当前负责幼儿的转入前历史可操作，保留发生时班级 */
  const operableB = computeOperablePending(FIXTURE_AUTH_TEACHER_B, FIXTURE_HOME_CANDIDATES);
  assert.deepEqual(operableB.counts, FIXTURE_HOME_TEACHER_B_EXPECTED_COUNTS);
  assert.deepEqual(
    [...operableB.pending.map((item) => item.observation_id)].sort(),
    [...FIXTURE_HOME_TEACHER_B.pending.map((item) => item.observation_id)].sort(),
    "教师 B 可操作待办与 fixture 必须一致",
  );
  const priorHistory = operableB.pending.find(
    (item) => item.observation_id === FIXTURE_HOME_CANDIDATE_READONLY_HISTORY.observation.observation_id,
  );
  assert.ok(priorHistory, "当前负责的转入前历史对教师 B 是可操作的");
  assert.equal(priorHistory.class_id, FIXTURE_CLASS_IDS.sunflower, "保留发生时班级");
  assert.equal(priorHistory.class_label, "小班 · 向日葵班");
  assert.ok(
    FIXTURE_HOME_TEACHER_B.recent.some(
      (item) => item.observation_id === FIXTURE_HOME_PRIOR_CLASS_CONFIRMED.observation_id,
    ),
  );
  passed += 1;

  /* 28) 管理员首页：全园只读；无教学权限，可操作待办为 0 */
  assert.equal(FIXTURE_HOME_ADMIN.scope?.kind, "school");
  assert.deepEqual(
    FIXTURE_HOME_ADMIN.class_groups.map((group) => group.stage),
    [...HOME_CLASS_STAGE_ORDER],
  );
  assert.deepEqual(
    [...collectClassIds(FIXTURE_HOME_ADMIN)].sort(),
    [FIXTURE_CLASS_IDS.sunflower, FIXTURE_CLASS_IDS.tulip, FIXTURE_CLASS_IDS.daisy].sort(),
  );
  const operableAdmin = computeOperablePending(FIXTURE_AUTH_ADMIN, FIXTURE_HOME_CANDIDATES);
  assert.deepEqual(operableAdmin.counts, { confirmations: 0, supplements: 0, organizes: 0 });
  assert.deepEqual(operableAdmin.pending, []);
  assert.deepEqual(FIXTURE_HOME_ADMIN.pending, []);
  passed += 1;

  /* 29) 未分配班级：等待分配，不提供创建班级捷径 */
  assert.equal(FIXTURE_HOME_TEACHER_EMPTY.scope?.kind, "classes");
  assert.equal(FIXTURE_HOME_TEACHER_EMPTY.scope?.class_count, 0);
  assert.deepEqual(FIXTURE_HOME_TEACHER_EMPTY.class_groups, []);
  assert.ok(FIXTURE_HOME_TEACHER_EMPTY.notices.some((notice) => notice.code === "scope_empty"));
  assert.equal(FIXTURE_HOME_TEACHER_EMPTY.primary_action.code, "await_class_assignment");
  assert.notEqual(FIXTURE_HOME_TEACHER_EMPTY.primary_action.code, "create_class");
  passed += 1;

  /* 30) 无幼儿 / 无观察 / 无分配 / 读取失败：四种语义互不相同 */
  assert.equal(FIXTURE_HOME_TEACHER_NO_CHILDREN.primary_action.code, "create_profile");
  assert.ok(FIXTURE_HOME_TEACHER_NO_CHILDREN.notices.some((notice) => notice.code === "empty_children"));
  assert.equal(FIXTURE_HOME_TEACHER_NO_CHILDREN.pending_counts.availability, "available");
  assert.equal(FIXTURE_HOME_TEACHER_NO_CHILDREN.pending_counts.confirmations, 0);
  assert.equal(FIXTURE_HOME_TEACHER_NO_OBSERVATIONS.primary_action.code, "start_observation");
  assert.ok(
    FIXTURE_HOME_TEACHER_NO_OBSERVATIONS.notices.some(
      (notice) => notice.code === "empty_observations",
    ),
  );
  assert.equal(FIXTURE_HOME_TEACHER_NO_OBSERVATIONS.pending_counts.confirmations, 0);
  assert.equal(FIXTURE_HOME_DATA_UNAVAILABLE.pending_counts.availability, "unavailable");
  assert.equal(FIXTURE_HOME_DATA_UNAVAILABLE.pending_counts.confirmations, null, "读取失败不是 0");
  assert.equal(FIXTURE_HOME_DATA_UNAVAILABLE.scope?.child_count, null);
  assert.deepEqual(FIXTURE_HOME_DATA_UNAVAILABLE.class_groups, []);
  assert.ok(
    FIXTURE_HOME_DATA_UNAVAILABLE.notices.some((notice) => notice.code === "data_unavailable"),
  );
  assert.equal(FIXTURE_HOME_DATA_UNAVAILABLE.primary_action.code, "retry");
  passed += 1;

  /* 31) 身份服务不可用首页：fail closed，不展示任何园所数据 */
  assert.equal(FIXTURE_HOME_IDENTITY_UNAVAILABLE.scope, null);
  assert.deepEqual(FIXTURE_HOME_IDENTITY_UNAVAILABLE.class_groups, []);
  assert.deepEqual(FIXTURE_HOME_IDENTITY_UNAVAILABLE.pending, []);
  assert.deepEqual(FIXTURE_HOME_IDENTITY_UNAVAILABLE.recent, []);
  assert.ok(
    FIXTURE_HOME_IDENTITY_UNAVAILABLE.notices.some((notice) => notice.code === "identity_unavailable"),
  );
  assert.equal(FIXTURE_HOME_IDENTITY_UNAVAILABLE.primary_action.code, "retry");
  assert.ok(
    !JSON.stringify(FIXTURE_HOME_IDENTITY_UNAVAILABLE).includes(FIXTURE_CLASS_IDS.sunflower),
    "身份不可用时不得泄露任何班级数据",
  );
  passed += 1;

  /* 32) 单一主行动优先级：待确认 → 待补充 → 待整理 → 建档 / 新记录 */
  for (const entry of FIXTURE_PRIMARY_ACTION_CASES) {
    assert.equal(nextPrimaryAction(entry), entry.expected, `${entry.name}: 主行动优先级不一致`);
  }
  const noClassCase = FIXTURE_PRIMARY_ACTION_CASES.find((entry) => entry.name === "no-class-await-assignment");
  assert.ok(noClassCase && noClassCase.expected !== "create_class", "未分配班级不得提供建班捷径");
  passed += 1;

  /* 33) 首页 DTO 无密码/令牌；观察摘要只有 excerpt；无权幼儿显式 null */
  const forbiddenHomeKeys = [
    "password",
    "password_hash",
    "passcode",
    "token",
    "csrf",
    "session_token",
    "raw_text",
  ];
  for (const home of FIXTURE_HOME_STATES) {
    assertNoForbiddenKeys(home, forbiddenHomeKeys, `home:${home.viewer.kind}`);
    for (const observation of [...home.pending, ...home.recent]) {
      assert.ok("excerpt" in observation, "观察摘要必须提供 excerpt");
      assert.ok(!("raw_text" in observation), "观察摘要不得携带 raw_text 原文");
      assert.equal(typeof observation.child_name === "string" || observation.child_name === null, true);
    }
  }
  assert.equal(FIXTURE_HOME_MASKED_CHILD_OBSERVATION.child_name, null);
  assert.equal(FIXTURE_HOME_MASKED_CHILD_OBSERVATION.class_id, null);
  assert.ok(
    !JSON.stringify(FIXTURE_HOME_MASKED_CHILD_OBSERVATION).includes("暂不可用"),
    "不得用占位文案冒充未知幼儿",
  );
  assert.deepEqual(Object.keys(FIXTURE_SESSION_VIEW).sort(), ["created_at", "expires_at", "session_id"]);
  assert.ok(FIXTURE_LOGIN_RESPONSE.session && !("token" in FIXTURE_LOGIN_RESPONSE.session));
  passed += 1;

  /* 34) JSON 媒体类型精确匹配：允许合法参数与大小写，拒绝相似前缀、其他类型与空值 */
  const mediaTypeCases: Array<[string, boolean]> = [
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["Application/JSON", true],
    ["application/jsonp", false],
    ["application/json-seq", false],
    ["application/jsonx", false],
    ["text/plain", false],
    ["", false],
  ];
  for (const [contentType, accepted] of mediaTypeCases) {
    const result = evaluateLoginGuard({
      origin: FIXTURE_TRUSTED_ORIGINS[0],
      auth_request_header: AUTH_LOGIN_HEADER_VALUE,
      content_type: contentType,
    });
    assert.equal(result.accepted, accepted, `媒体类型 ${JSON.stringify(contentType)} 判定不一致`);
  }
  const mediaTypeFixtureNames = [
    "json-with-charset-accepted",
    "json-case-insensitive-accepted",
    "jsonp-prefix-rejected",
    "json-seq-rejected",
    "jsonx-rejected",
    "text-plain-rejected",
    "empty-content-type-rejected",
  ];
  for (const name of mediaTypeFixtureNames) {
    assert.ok(
      FIXTURE_LOGIN_GUARD_CASES.some((entry) => entry.name === name),
      `fixture 缺少媒体类型场景 ${name}`,
    );
  }
  passed += 1;

  /* 35) 模型等待归属前提：比较 before/after 事实，不依赖事件标签 */
  const modelWaitFixtureNames = [
    "child-transferred-within-scope-conflicts",
    "attribution-changed-with-none-label-conflicts",
    "child-transferred-during-wait",
  ];
  for (const name of modelWaitFixtureNames) {
    assert.ok(
      FIXTURE_MODEL_WAIT_CASES.some((entry) => entry.name === name),
      `fixture 缺少模型等待场景 ${name}`,
    );
  }
  const withinScopeTransfer = FIXTURE_MODEL_WAIT_CASES.find(
    (entry) => entry.name === "child-transferred-within-scope-conflicts",
  );
  assert.ok(withinScopeTransfer, "A→B 同教师转班反例必须存在");
  assert.deepEqual(evaluateModelWait(withinScopeTransfer), {
    write: false,
    outcome: "conflict",
    error: "state_conflict",
  });
  const noneLabelAttributionChange = FIXTURE_MODEL_WAIT_CASES.find(
    (entry) => entry.name === "attribution-changed-with-none-label-conflicts",
  );
  assert.ok(noneLabelAttributionChange, "事件标签 none 但事实变化的反例必须存在");
  assert.deepEqual(evaluateModelWait(noneLabelAttributionChange), {
    write: false,
    outcome: "conflict",
    error: "state_conflict",
  });
  const stableAttribution = FIXTURE_MODEL_WAIT_CASES.find((entry) => entry.name === "no-change-saves");
  assert.ok(stableAttribution);
  assert.deepEqual(evaluateModelWait(stableAttribution), { write: true, outcome: "saved" });
  const outOfScopeTransfer = FIXTURE_MODEL_WAIT_CASES.find(
    (entry) => entry.name === "child-transferred-during-wait",
  );
  assert.ok(outOfScopeTransfer);
  assert.deepEqual(evaluateModelWait(outOfScopeTransfer), {
    write: false,
    outcome: "denied",
    deny: "out_of_scope",
  });
  passed += 1;

  /* 36) 首页局部未知计数：null 不转 0；已知待办可处理；高优先级未知不跳过 */
  const partialPrimaryNames = [
    "child-count-unknown-retry",
    "class-count-unknown-retry",
    "known-confirmations-with-unknown-range",
    "known-supplements-with-unknown-range",
    "known-organizes-with-unknown-range",
    "unknown-higher-priority-retry",
    "unknown-supplements-blocks-start",
  ];
  for (const name of partialPrimaryNames) {
    assert.ok(
      FIXTURE_PRIMARY_ACTION_CASES.some((entry) => entry.name === name),
      `fixture 缺少局部未知主行动场景 ${name}`,
    );
  }
  for (const name of partialPrimaryNames) {
    const entry = FIXTURE_PRIMARY_ACTION_CASES.find((candidate) => candidate.name === name);
    assert.ok(entry);
    assert.equal(nextPrimaryAction(entry), entry.expected, `${name}: 局部未知计数主行动不一致`);
  }
  const childCountUnknown = FIXTURE_PRIMARY_ACTION_CASES.find(
    (entry) => entry.name === "child-count-unknown-retry",
  );
  assert.ok(childCountUnknown && childCountUnknown.child_count === null);
  assert.equal(nextPrimaryAction(childCountUnknown), "retry");
  const knownConfirmationRangeUnknown = FIXTURE_PRIMARY_ACTION_CASES.find(
    (entry) => entry.name === "known-confirmations-with-unknown-range",
  );
  assert.ok(knownConfirmationRangeUnknown?.counts);
  assert.equal(nextPrimaryAction(knownConfirmationRangeUnknown), "process_confirmations");
  passed += 1;

  console.log(JSON.stringify({ passed, total: 36, reference_only: true }));
}

main();
