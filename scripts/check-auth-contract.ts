import assert from "node:assert/strict";

import {
  FIXTURE_ACCESS_CASES,
  FIXTURE_ACCOUNT_IDS,
  FIXTURE_AUTH_ANONYMOUS,
  FIXTURE_AUTH_EXPIRED,
  FIXTURE_AUTH_REVOKED,
  FIXTURE_AUTH_TEACHER_DISABLED,
  FIXTURE_AUTH_TEACHER_EMPTY,
  FIXTURE_AUTH_TEACHER_REVOKED,
  FIXTURE_AUTH_UNAVAILABLE,
  FIXTURE_AUTH_UNKNOWN_TOKEN,
  FIXTURE_AUTHORIZATION_DENIED_RESULT,
  FIXTURE_AUTHORIZED_EMPTY_LIST,
  FIXTURE_CHILD_IDS,
  FIXTURE_CLASS_ASSIGNMENT_REQUEST,
  FIXTURE_CLASS_IDS,
  FIXTURE_CLASS_UNASSIGNMENT_REQUEST,
  FIXTURE_EMPTY_CLASS_SCOPE,
  FIXTURE_INITIAL_ADMIN_REQUEST,
  FIXTURE_INITIAL_ADMIN_RESPONSE,
  FIXTURE_LEGACY_COOKIE,
  FIXTURE_LEGACY_COOKIE_STATE,
  FIXTURE_LOGIN_RESPONSE,
  FIXTURE_LOGOUT_RESPONSE,
  FIXTURE_NO_SCOPE,
  FIXTURE_PASSWORD_RESET_REQUEST,
  FIXTURE_PASSWORD_RESET_RESPONSE,
  FIXTURE_PRINCIPAL_ADMIN,
  FIXTURE_PRINCIPAL_TEACHER_A,
  FIXTURE_PRINCIPAL_TEACHER_B,
  FIXTURE_PRINCIPAL_TEACHER_EMPTY,
  FIXTURE_SESSION_STATUS_ANONYMOUS,
  FIXTURE_SESSION_VIEW,
  FIXTURE_TEACHER_A_SUMMARY,
  FIXTURE_TEACHER_CREATE_REQUEST,
  FIXTURE_TEACHER_LIST_RESPONSE,
  FIXTURE_TEACHER_STATUS_REQUEST,
  FIXTURE_TEACHER_STATUS_RESPONSE,
  type FixtureAccessCase,
} from "../src/lib/accounts/__fixtures__/contract-fixtures";
import {
  AUTH_DENY_HTTP_STATUS,
  AUTH_ERROR_HTTP_STATUS,
  AUTH_SESSION_TTL_SECONDS,
  AUTH_STATE_KINDS,
  CLIENT_CLEANUP_TARGETS,
  CSRF_HEADER_NAME,
  DATA_SCOPE_NONE_REASONS,
  INVALID_SESSION_REASONS,
  LEGACY_AUTH_COOKIE,
  PASSWORD_HASH_FORMAT,
  PASSWORD_HASH_PARAMS,
  TEACHING_ACCESS_ACTIONS,
  type AccessAction,
  type AccessDecision,
  type AccessProjection,
  type AccessResource,
  type AccessVia,
  type DataScope,
} from "../src/lib/accounts/types";
import {
  FIXTURE_HOME_ADMIN,
  FIXTURE_HOME_IDENTITY_UNAVAILABLE,
  FIXTURE_HOME_LOGGED_OUT,
  FIXTURE_HOME_MASKED_CHILD_OBSERVATION,
  FIXTURE_HOME_STATES,
  FIXTURE_HOME_TEACHER_A,
  FIXTURE_HOME_TEACHER_EMPTY,
} from "../src/lib/home-v2/__fixtures__/contract-fixtures";
import {
  HOME_CLASS_STAGE_ORDER,
  HOME_VIEWER_KINDS,
  type HomeV2Data,
} from "../src/lib/home-v2/types";

/**
 * AUTH0 契约最小检查：只读 fixture，不连数据库、不调用模型、不实现认证。
 * 运行：pnpm tsx scripts/check-auth-contract.ts
 *
 * 本文件的参考算法忠实于 `docs/auth-v1/contract.md`，用于验证 fixture 与规则一致性；
 * 它不是生产实现，不能替代真实认证、真实数据库与浏览器验收（标记 reference_only）。
 */

/* ------------------------------ 参考授权算法 ------------------------------ */

function isTeachingAction(action: AccessAction): boolean {
  return (TEACHING_ACCESS_ACTIONS as readonly string[]).includes(action);
}

/** 资源对应的“当前责任班级”：观察/幼儿用当前归属；班级用自身；全园无班级 */
function currentClassOf(resource: AccessResource): string | null {
  switch (resource.kind) {
    case "school":
      return null;
    case "class":
      return resource.class_id;
    case "child":
      return resource.current_class_id;
    case "observation":
      return resource.current_class_id;
  }
}

function observedClassOf(resource: AccessResource): string | null {
  return resource.kind === "observation" ? resource.observed_class_id : null;
}

function evaluateAccess(entry: FixtureAccessCase): AccessDecision {
  const { auth } = entry;
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
    if (isTeachingAction(entry.action)) {
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
  const allow = (via: AccessVia, projection: AccessProjection = "full"): AccessDecision => ({
    allowed: true,
    projection,
    via,
  });
  const denyOutOfScope: AccessDecision = { allowed: false, deny: "out_of_scope" };

  switch (entry.action) {
    case "class.read":
      return inScope(currentClassOf(entry.resource)) ? allow("assigned_class") : denyOutOfScope;
    case "class.catalog.read":
      return allow("school_catalog");
    case "class.manage":
    case "teacher.manage":
    case "teacher.assign":
    case "child.transfer":
    case "school.read":
      return { allowed: false, deny: "forbidden_role" };
    case "child.create_profile":
    case "child.read":
    case "observation.write":
    case "observation.confirm":
    case "guide.decide":
    case "growth_profile.write":
    case "activity_support.write":
      return inScope(currentClassOf(entry.resource)) ? allow("current_responsible") : denyOutOfScope;
    case "observation.read": {
      if (inScope(currentClassOf(entry.resource))) return allow("current_responsible");
      if (inScope(observedClassOf(entry.resource))) return allow("historical_class", "historical_read_only");
      return denyOutOfScope;
    }
  }
}

/* -------------------------------- 辅助检查 -------------------------------- */

function assertMatchesExpectation(entry: FixtureAccessCase): void {
  const decision = evaluateAccess(entry);
  assert.equal(decision.allowed, entry.expected.allowed, `${entry.name}: allowed 不一致`);
  if (decision.allowed && entry.expected.allowed) {
    assert.equal(decision.via, entry.expected.via, `${entry.name}: via 不一致`);
    assert.equal(decision.projection, entry.expected.projection, `${entry.name}: projection 不一致`);
  }
  if (!decision.allowed && !entry.expected.allowed) {
    const expectedDeny = entry.expected.deny;
    assert.ok(expectedDeny, `${entry.name}: 期望缺少 deny`);
    assert.equal(decision.deny, expectedDeny, `${entry.name}: deny 不一致`);
    assert.equal(
      AUTH_DENY_HTTP_STATUS[decision.deny],
      AUTH_DENY_HTTP_STATUS[expectedDeny],
      `${entry.name}: deny 映射不一致`,
    );
  }
}

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
    assert.notEqual(state.kind, "anonymous", "失效会话不是未登录");
  }
  assert.equal(FIXTURE_LEGACY_COOKIE.cookie_name, LEGACY_AUTH_COOKIE);
  assert.ok(
    FIXTURE_LEGACY_COOKIE_STATE.kind === "invalid_session" &&
      FIXTURE_LEGACY_COOKIE_STATE.reason === "legacy_cookie_not_accepted",
  );
  passed += 1;

  /* 3) DataScope 三形态严格区分：空数组明确为空，不等于全园 */
  assert.deepEqual([...DATA_SCOPE_NONE_REASONS], ["no_assignment", "account_disabled", "no_business_scope"]);
  assert.equal(scopeEqualsAll(FIXTURE_EMPTY_CLASS_SCOPE), false);
  assert.equal(scopeEqualsAll(FIXTURE_NO_SCOPE), false);
  assert.equal(scopeEqualsAll({ kind: "school", school_id: "s" }), true);
  assert.equal(FIXTURE_EMPTY_CLASS_SCOPE.kind, "classes");
  assert.equal(FIXTURE_EMPTY_CLASS_SCOPE.class_ids.length, 0);
  assert.equal(FIXTURE_NO_SCOPE.kind, "none");
  assert.ok(FIXTURE_PRINCIPAL_TEACHER_A.scope.kind === "classes");
  passed += 1;

  /* 4) 两教师班级不同/重叠、多班、空分配结构 */
  const scopeA = FIXTURE_PRINCIPAL_TEACHER_A.scope;
  const scopeB = FIXTURE_PRINCIPAL_TEACHER_B.scope;
  assert.ok(scopeA.kind === "classes" && scopeB.kind === "classes");
  assert.ok(scopeA.class_ids.length >= 2, "教师 A 应为多班");
  const overlap = scopeA.class_ids.filter((id) => scopeB.class_ids.includes(id));
  assert.deepEqual(overlap, [FIXTURE_CLASS_IDS.tulip], "两教师应在郁金香班重叠");
  assert.ok(
    scopeA.class_ids.some((id) => !scopeB.class_ids.includes(id)),
    "两教师班级集合必须不同",
  );
  assert.ok(FIXTURE_PRINCIPAL_TEACHER_EMPTY.scope.kind === "classes");
  assert.equal(FIXTURE_PRINCIPAL_TEACHER_EMPTY.scope.class_ids.length, 0, "空分配必须显式为空数组");
  passed += 1;

  /* 5) 全部授权用例与参考算法一致 */
  const requiredCaseNames = [
    "logged-out-school-read",
    "unknown-token-child-read",
    "revoked-session-class-read",
    "identity-unavailable-fail-closed",
    "admin-teaching-write-denied",
    "admin-teaching-confirm-denied",
    "admin-guide-decision-denied",
    "teacher-a-read-second-class",
    "teacher-b-read-overlapping-class",
    "teacher-b-read-other-class-denied",
    "class-catalog-separate-from-membership",
    "teacher-empty-scope-denied",
    "teacher-a-child-transferred-profile-denied",
    "teacher-a-read-transferred-history-observation",
    "current-responsible-reads-prior-class-history",
    "author-is-not-authorization-after-revocation",
    "disabled-author-history-still-readable",
    "admin-class-history-protection-is-business-conflict",
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

  /* 6) 授权失败映射 401 / 403 / 503；业务冲突（409）不属于授权错误 */
  assert.equal(AUTH_DENY_HTTP_STATUS.unauthenticated, 401);
  assert.equal(AUTH_DENY_HTTP_STATUS.forbidden_role, 403);
  assert.equal(AUTH_DENY_HTTP_STATUS.out_of_scope, 403);
  assert.equal(AUTH_DENY_HTTP_STATUS.empty_scope, 403);
  assert.equal(AUTH_DENY_HTTP_STATUS.account_disabled, 403);
  assert.equal(AUTH_DENY_HTTP_STATUS.identity_unavailable, 503);
  assert.ok(
    Object.values(AUTH_DENY_HTTP_STATUS).every((status) => status === 401 || status === 403 || status === 503),
  );
  assert.ok(!(Object.values(AUTH_DENY_HTTP_STATUS) as number[]).includes(409), "授权错误不得占用 409");
  assert.equal(AUTH_ERROR_HTTP_STATUS.state_conflict, 409);
  assert.equal(AUTH_ERROR_HTTP_STATUS.unauthenticated, 401);
  assert.equal(AUTH_ERROR_HTTP_STATUS.forbidden, 403);
  assert.equal(AUTH_ERROR_HTTP_STATUS.identity_unavailable, 503);
  assert.equal(AUTH_ERROR_HTTP_STATUS.rate_limited, 429);
  assert.equal(AUTH_ERROR_HTTP_STATUS.csrf_rejected, 403);
  assert.equal(AUTH_ERROR_HTTP_STATUS.last_admin_protected, 409);
  const historyCase = FIXTURE_ACCESS_CASES.find(
    (entry) => entry.name === "admin-class-history-protection-is-business-conflict",
  );
  assert.ok(historyCase);
  assert.equal(historyCase.expected.allowed, true, "管理员改有历史班级的学段是授权通过");
  assert.equal(
    historyCase.expected.business_guard,
    "class_history_protected",
    "G2 班级历史保护属于业务冲突 409，管理员不能绕过",
  );
  passed += 1;

  /* 7) 空分配教师：可登录（authenticated）但业务访问为空范围拒绝 */
  assert.equal(FIXTURE_AUTH_TEACHER_EMPTY.kind, "authenticated");
  const emptyScopeDecision = evaluateAccess({
    name: "empty-scope",
    auth: FIXTURE_AUTH_TEACHER_EMPTY,
    action: "class.read",
    resource: { kind: "class", class_id: FIXTURE_CLASS_IDS.sunflower },
    expected: { allowed: false, deny: "empty_scope" },
  });
  assert.deepEqual(emptyScopeDecision, { allowed: false, deny: "empty_scope" });
  passed += 1;

  /* 8) 管理员全园管理允许，教学动作拒绝；教师管理动作拒绝 */
  for (const action of TEACHING_ACCESS_ACTIONS) {
    const decision = evaluateAccess({
      name: `admin-${action}`,
      auth: { kind: "authenticated", principal: FIXTURE_PRINCIPAL_ADMIN },
      action,
      resource: {
        kind: "observation",
        observation_id: "obs",
        child_id: FIXTURE_CHILD_IDS.current,
        current_class_id: FIXTURE_CLASS_IDS.sunflower,
        observed_class_id: FIXTURE_CLASS_IDS.sunflower,
        author_account_id: null,
      },
      expected: { allowed: false, deny: "forbidden_role" },
    });
    assert.deepEqual(decision, { allowed: false, deny: "forbidden_role" }, `管理员教学动作 ${action} 必须拒绝`);
  }
  for (const action of ["class.manage", "teacher.manage", "teacher.assign", "child.transfer"] as const) {
    const decision = evaluateAccess({
      name: `admin-${action}`,
      auth: { kind: "authenticated", principal: FIXTURE_PRINCIPAL_ADMIN },
      action,
      resource: { kind: "class", class_id: FIXTURE_CLASS_IDS.sunflower },
      expected: { allowed: true },
    });
    assert.equal(decision.allowed, true, `管理员管理动作 ${action} 应允许`);
  }
  assert.equal(
    evaluateAccess({
      name: "teacher-manage",
      auth: { kind: "authenticated", principal: FIXTURE_PRINCIPAL_TEACHER_A },
      action: "class.manage",
      resource: { kind: "class", class_id: FIXTURE_CLASS_IDS.sunflower },
      expected: { allowed: false, deny: "forbidden_role" },
    }).allowed,
    false,
  );
  passed += 1;

  /* 9) 转班历史：当前负责才读整份档案；原班只能历史只读投影，不带跨班证据详情 */
  const transferredHistory = {
    kind: "observation" as const,
    observation_id: "obs-history",
    child_id: FIXTURE_CHILD_IDS.transferred,
    current_class_id: FIXTURE_CLASS_IDS.daisy,
    observed_class_id: FIXTURE_CLASS_IDS.sunflower,
    author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
  };
  const originalClassView = evaluateAccess({
    name: "original-class-view",
    auth: { kind: "authenticated", principal: FIXTURE_PRINCIPAL_TEACHER_A },
    action: "observation.read",
    resource: transferredHistory,
    expected: { allowed: true },
  });
  assert.deepEqual(originalClassView, {
    allowed: true,
    via: "historical_class",
    projection: "historical_read_only",
  });
  const currentClassView = evaluateAccess({
    name: "current-class-view",
    auth: { kind: "authenticated", principal: FIXTURE_PRINCIPAL_TEACHER_B },
    action: "observation.read",
    resource: transferredHistory,
    expected: { allowed: true },
  });
  assert.deepEqual(currentClassView, {
    allowed: true,
    via: "current_responsible",
    projection: "full",
  });
  const wholeProfile = evaluateAccess({
    name: "transferred-whole-profile",
    auth: { kind: "authenticated", principal: FIXTURE_PRINCIPAL_TEACHER_A },
    action: "child.read",
    resource: {
      kind: "child",
      child_id: FIXTURE_CHILD_IDS.transferred,
      current_class_id: FIXTURE_CLASS_IDS.daisy,
    },
    expected: { allowed: false, deny: "out_of_scope" },
  });
  assert.deepEqual(wholeProfile, { allowed: false, deny: "out_of_scope" });
  passed += 1;

  /* 10) 作者不是永久授权：撤销任教后作者本人也读不到原班观察；停用作者不影响其他授权者读历史 */
  const authorAfterRevocation = evaluateAccess({
    name: "author-after-revocation",
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
    expected: { allowed: false, deny: "out_of_scope" },
  });
  assert.deepEqual(authorAfterRevocation, { allowed: false, deny: "out_of_scope" });
  const disabledAuthorHistory = evaluateAccess({
    name: "disabled-author-history",
    auth: { kind: "authenticated", principal: FIXTURE_PRINCIPAL_TEACHER_B },
    action: "observation.read",
    resource: {
      kind: "observation",
      observation_id: "obs-by-disabled",
      child_id: FIXTURE_CHILD_IDS.current,
      current_class_id: FIXTURE_CLASS_IDS.tulip,
      observed_class_id: FIXTURE_CLASS_IDS.tulip,
      author_account_id: FIXTURE_ACCOUNT_IDS.teacherDisabled,
    },
    expected: { allowed: true },
  });
  assert.equal(disabledAuthorHistory.allowed, true, "停用账号不使历史观察失效");
  const disabledAccount = evaluateAccess({
    name: "disabled-account",
    auth: FIXTURE_AUTH_TEACHER_DISABLED,
    action: "class.read",
    resource: { kind: "class", class_id: FIXTURE_CLASS_IDS.sunflower },
    expected: { allowed: false, deny: "account_disabled" },
  });
  assert.deepEqual(disabledAccount, { allowed: false, deny: "account_disabled" });
  passed += 1;

  /* 11) 错误不等空数据：拒绝必须显式，不能伪装成“没有记录” */
  assert.equal(FIXTURE_AUTHORIZATION_DENIED_RESULT.allowed, false);
  assert.ok(!("data" in FIXTURE_AUTHORIZATION_DENIED_RESULT), "授权错误不得携带空数据字段");
  assert.deepEqual(FIXTURE_AUTHORIZED_EMPTY_LIST.items, [], "有权查看的空集合才是正常空数据");
  assert.notEqual(
    JSON.stringify(FIXTURE_AUTHORIZATION_DENIED_RESULT),
    JSON.stringify(FIXTURE_AUTHORIZED_EMPTY_LIST),
    "错误与空数据必须形态不同",
  );
  passed += 1;

  /* 12) 口令与会话固定契约 */
  assert.equal(PASSWORD_HASH_PARAMS.N, 16384);
  assert.equal(PASSWORD_HASH_PARAMS.r, 8);
  assert.equal(PASSWORD_HASH_PARAMS.p, 1);
  assert.equal(PASSWORD_HASH_PARAMS.key_length, 64);
  assert.ok(PASSWORD_HASH_FORMAT.startsWith("scrypt$"));
  assert.ok(PASSWORD_HASH_FORMAT.includes("salt_base64"));
  assert.equal(AUTH_SESSION_TTL_SECONDS, 7 * 24 * 60 * 60, "会话固定期限");
  assert.equal(LEGACY_AUTH_COOKIE, "cga_teacher");
  passed += 1;

  /* 13) 接口 DTO：登录/状态/退出 + 教师管理 + 指派 + 重置 + 初始管理员 */
  assert.equal(FIXTURE_SESSION_STATUS_ANONYMOUS.state.kind, "anonymous");
  assert.equal(FIXTURE_SESSION_STATUS_ANONYMOUS.session, null);
  assert.equal(FIXTURE_LOGIN_RESPONSE.state.kind, "authenticated");
  assert.deepEqual([...CLIENT_CLEANUP_TARGETS], [
    "legacy_teacher_provider",
    "home_v2_payload",
    "private_query_cache",
  ]);
  assert.deepEqual(FIXTURE_LOGIN_RESPONSE.cleanup, [...CLIENT_CLEANUP_TARGETS], "登录后必须先清理旧私有状态");
  assert.deepEqual(FIXTURE_LOGOUT_RESPONSE.cleanup, [...CLIENT_CLEANUP_TARGETS]);
  assert.equal(FIXTURE_LOGOUT_RESPONSE.state.kind, "anonymous");
  assert.equal(FIXTURE_LOGIN_RESPONSE.csrf?.header_name, CSRF_HEADER_NAME);
  assert.equal(FIXTURE_TEACHER_LIST_RESPONSE.teachers.length, 2);
  assert.equal(FIXTURE_TEACHER_A_SUMMARY.role, "teacher");
  assert.equal(FIXTURE_TEACHER_CREATE_REQUEST.username.length > 0, true);
  assert.equal(FIXTURE_TEACHER_STATUS_REQUEST.status, "disabled");
  assert.ok(FIXTURE_TEACHER_STATUS_RESPONSE.revoked_session_count > 0, "停用必须撤销会话");
  assert.ok(FIXTURE_PASSWORD_RESET_REQUEST.new_password.length > 0);
  assert.ok(FIXTURE_PASSWORD_RESET_RESPONSE.revoked_session_count > 0, "重置密码必须撤销会话");
  assert.ok(FIXTURE_CLASS_ASSIGNMENT_REQUEST.class_id.length > 0);
  assert.ok(FIXTURE_CLASS_UNASSIGNMENT_REQUEST.reason);
  assert.equal(FIXTURE_INITIAL_ADMIN_REQUEST.password.length > 0, true);
  assert.equal(FIXTURE_INITIAL_ADMIN_RESPONSE.principal.role, "admin");
  passed += 1;

  /* 14) 会话/响应 DTO 不泄露敏感信息 */
  assert.deepEqual(Object.keys(FIXTURE_SESSION_VIEW).sort(), ["created_at", "expires_at", "session_id"]);
  assert.ok(FIXTURE_LOGIN_RESPONSE.session && !("token" in FIXTURE_LOGIN_RESPONSE.session));
  const forbiddenResponseKeys = ["password", "password_hash", "initial_password", "new_password", "passcode", "session_token", "salt"];
  assertNoForbiddenKeys(
    {
      login: FIXTURE_LOGIN_RESPONSE,
      logout: FIXTURE_LOGOUT_RESPONSE,
      status: FIXTURE_SESSION_STATUS_ANONYMOUS,
      teachers: FIXTURE_TEACHER_LIST_RESPONSE,
      teacherStatus: FIXTURE_TEACHER_STATUS_RESPONSE,
      passwordReset: FIXTURE_PASSWORD_RESET_RESPONSE,
      initialAdmin: FIXTURE_INITIAL_ADMIN_RESPONSE,
    },
    forbiddenResponseKeys,
    "auth response",
  );
  passed += 1;

  /* 15) 首页四态由服务端判定 */
  assert.deepEqual([...HOME_VIEWER_KINDS], ["logged_out", "teacher", "admin", "identity_unavailable"]);
  assert.equal(FIXTURE_HOME_LOGGED_OUT.viewer.kind, "logged_out");
  assert.equal(FIXTURE_HOME_TEACHER_A.viewer.kind, "teacher");
  assert.equal(FIXTURE_HOME_ADMIN.viewer.kind, "admin");
  assert.equal(FIXTURE_HOME_IDENTITY_UNAVAILABLE.viewer.kind, "identity_unavailable");
  passed += 1;

  /* 16) 未登录首页：不加载任何园所数据 */
  assert.equal(FIXTURE_HOME_LOGGED_OUT.scope, null);
  assert.deepEqual(FIXTURE_HOME_LOGGED_OUT.class_groups, []);
  assert.equal(FIXTURE_HOME_LOGGED_OUT.pending_count, 0);
  assert.deepEqual(FIXTURE_HOME_LOGGED_OUT.pending, []);
  assert.deepEqual(FIXTURE_HOME_LOGGED_OUT.recent, []);
  assert.equal(FIXTURE_HOME_LOGGED_OUT.primary_action.code, "login");
  passed += 1;

  /* 17) 教师首页：只含其任教班级（多班），不含未授权班级 */
  assert.equal(FIXTURE_HOME_TEACHER_A.scope?.kind, "classes");
  assert.equal(FIXTURE_HOME_TEACHER_A.scope?.class_count, 2);
  const teacherClassIds = collectClassIds(FIXTURE_HOME_TEACHER_A);
  assert.deepEqual([...teacherClassIds].sort(), [FIXTURE_CLASS_IDS.sunflower, FIXTURE_CLASS_IDS.tulip].sort());
  assert.ok(!JSON.stringify(FIXTURE_HOME_TEACHER_A).includes(FIXTURE_CLASS_IDS.daisy), "未授权班级不得出现在首页 DTO");
  const scopedClassIds = new Set(teacherClassIds);
  for (const observation of [...FIXTURE_HOME_TEACHER_A.pending, ...FIXTURE_HOME_TEACHER_A.recent]) {
    assert.ok(
      observation.class_id !== null && scopedClassIds.has(observation.class_id),
      "教师首页观察必须落在其任教班级内",
    );
  }
  passed += 1;

  /* 18) 管理员首页：全园范围与三个学段分组 */
  assert.equal(FIXTURE_HOME_ADMIN.scope?.kind, "school");
  assert.deepEqual(
    FIXTURE_HOME_ADMIN.class_groups.map((group) => group.stage),
    [...HOME_CLASS_STAGE_ORDER],
  );
  assert.deepEqual(
    [...collectClassIds(FIXTURE_HOME_ADMIN)].sort(),
    [FIXTURE_CLASS_IDS.sunflower, FIXTURE_CLASS_IDS.tulip, FIXTURE_CLASS_IDS.daisy].sort(),
  );
  passed += 1;

  /* 19) 空分配首页：明确 scope_empty + 等待分配，不渲染任何班级 */
  assert.equal(FIXTURE_HOME_TEACHER_EMPTY.scope?.kind, "classes");
  assert.equal(FIXTURE_HOME_TEACHER_EMPTY.scope?.class_count, 0);
  assert.deepEqual(FIXTURE_HOME_TEACHER_EMPTY.class_groups, []);
  assert.ok(FIXTURE_HOME_TEACHER_EMPTY.notices.some((notice) => notice.code === "scope_empty"));
  assert.equal(FIXTURE_HOME_TEACHER_EMPTY.primary_action.code, "await_class_assignment");
  passed += 1;

  /* 20) 身份服务不可用首页：fail closed，不展示任何园所数据 */
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

  /* 21) 首页 DTO 不含密码/令牌；观察摘要只有 excerpt，无 raw_text */
  const forbiddenHomeKeys = ["password", "password_hash", "passcode", "token", "csrf", "session_token", "raw_text"];
  for (const home of FIXTURE_HOME_STATES) {
    assertNoForbiddenKeys(home, forbiddenHomeKeys, `home:${home.viewer.kind}`);
    for (const observation of [...home.pending, ...home.recent]) {
      assert.ok("excerpt" in observation, "观察摘要必须提供 excerpt");
      assert.ok(!("raw_text" in observation), "观察摘要不得携带 raw_text 原文");
    }
  }
  passed += 1;

  /* 22) 无权查看的幼儿显式 null，不用占位文案或当前账号补造 */
  assert.equal(FIXTURE_HOME_MASKED_CHILD_OBSERVATION.child_name, null);
  assert.equal(FIXTURE_HOME_MASKED_CHILD_OBSERVATION.class_id, null);
  assert.ok(
    !JSON.stringify(FIXTURE_HOME_MASKED_CHILD_OBSERVATION).includes("暂不可用"),
    "不得用占位文案冒充未知幼儿",
  );
  passed += 1;

  console.log(JSON.stringify({ passed, total: 22, reference_only: true }));
}

main();
