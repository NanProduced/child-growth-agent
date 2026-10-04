import {
  ACCESS_INVALID_COMBINATION_ERROR,
  CLIENT_CLEANUP_TARGETS,
  CSRF_HEADER_NAME,
  LEGACY_AUTH_COOKIE,
  type AccessAction,
  type AccessDecision,
  type AccessProjection,
  type AccessResource,
  type AccessVia,
  type AdminBootstrapContext,
  type AdminBootstrapInput,
  type AdminBootstrapResult,
  type AdminBootstrapStatus,
  type AuthDenyReason,
  type AuthState,
  type ClassAssignmentRequest,
  type ClassUnassignmentRequest,
  type DataScope,
  type LoginGuardFailure,
  type LoginRequest,
  type LoginResponse,
  type LogoutResponse,
  type ModelWaitEvent,
  type PasswordResetRequest,
  type PasswordResetResponse,
  type Principal,
  type SessionStatusView,
  type TeacherAccountSummary,
  type TeacherCreateRequest,
  type TeacherListResponse,
  type TeacherStatusRequest,
  type TeacherStatusResponse,
} from "../types";

/**
 * 账号与授权 v1 契约 fixture（AUTH0-R1 返修候选）：纯数据，
 * 不写数据库、不调用模型、不冒充真实认证。
 *
 * 覆盖反例：两教师不同/重叠班级、多班、空分配、管理员教学拒绝、未登录、
 * 未知身份、权限撤销、转班历史、作者不等授权、错误不等空数据、旧 Cookie 不认可、
 * 动作/资源非法组合、登录前保护、会话 CSRF 绑定、初始化资格与并发、
 * 模型等待期间撤权/停用/转班、首位管理员脚本语义。
 * 期望值由 `scripts/check-auth-contract.ts` 的参考算法核对，标记 reference_only。
 */

/* --------------------------------- 标识 --------------------------------- */

export const FIXTURE_SCHOOL_ID = "f0a00000-0000-4000-8000-000000000001";

export const FIXTURE_CLASS_IDS = {
  sunflower: "c1a10000-0000-4000-8000-000000000001",
  tulip: "c1a10000-0000-4000-8000-000000000002",
  daisy: "c1a10000-0000-4000-8000-000000000003",
} as const;

export const FIXTURE_ACCOUNT_IDS = {
  admin: "acca0000-0000-4000-8000-000000000001",
  teacherA: "acca0000-0000-4000-8000-000000000002",
  teacherB: "acca0000-0000-4000-8000-000000000003",
  teacherEmpty: "acca0000-0000-4000-8000-000000000004",
  teacherDisabled: "acca0000-0000-4000-8000-000000000005",
  /** 任教安排被撤销的教师：当前仅郁金香班，曾在向日葵班写观察 */
  teacherRevoked: "acca0000-0000-4000-8000-000000000006",
} as const;

export const FIXTURE_CHILD_IDS = {
  /** 仍在向日葵班（教师 A 当前负责） */
  current: "a1c10000-0000-4000-8000-0000000000c1",
  /** 原在向日葵班，现转至蒲公英班（教师 A 不再是当前负责人，教师 B 当前负责） */
  transferred: "a1c10000-0000-4000-8000-0000000000c2",
} as const;

export const FIXTURE_OBSERVATION_IDS = {
  /** 转班幼儿在原班（向日葵班）的历史观察 */
  transferredHistory: "0b5e0000-0000-4000-8000-000000000001",
  /** 教师 B 授权撤销前在雏菊班写下的观察（作者≠当前授权） */
  daisyByRevokedAuthor: "0b5e0000-0000-4000-8000-000000000002",
  /** 已停用教师当年在郁金香班写下的历史观察 */
  tulipByDisabledAuthor: "0b5e0000-0000-4000-8000-000000000003",
  /** 当前负责教师在班内待确认的观察 */
  inClassConfirmable: "0b5e0000-0000-4000-8000-000000000004",
} as const;

/* --------------------------------- 操作者 --------------------------------- */

export const FIXTURE_PRINCIPAL_ADMIN: Principal = {
  account_id: FIXTURE_ACCOUNT_IDS.admin,
  username: "yuanzhang",
  display_name: "园所管理员",
  role: "admin",
  account_status: "active",
  scope: { kind: "school", school_id: FIXTURE_SCHOOL_ID },
};

/** 多班教师：向日葵 + 郁金香 */
export const FIXTURE_PRINCIPAL_TEACHER_A: Principal = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherA,
  username: "lilaoshi",
  display_name: "李老师",
  role: "teacher",
  account_status: "active",
  scope: {
    kind: "classes",
    class_ids: [FIXTURE_CLASS_IDS.sunflower, FIXTURE_CLASS_IDS.tulip],
  },
};

/** 与教师 A 在郁金香班重叠：郁金香 + 蒲公英（当前负责转班幼儿） */
export const FIXTURE_PRINCIPAL_TEACHER_B: Principal = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherB,
  username: "wanglaoshi",
  display_name: "王老师",
  role: "teacher",
  account_status: "active",
  scope: {
    kind: "classes",
    class_ids: [FIXTURE_CLASS_IDS.tulip, FIXTURE_CLASS_IDS.daisy],
  },
};

/** 未分配班级：可登录，但不能访问业务对象；空数组是明确的“空”，不等于全园 */
export const FIXTURE_PRINCIPAL_TEACHER_EMPTY: Principal = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherEmpty,
  username: "zhaolaoshi",
  display_name: "赵老师",
  role: "teacher",
  account_status: "active",
  scope: { kind: "classes", class_ids: [] },
};

/** 已停用教师：停用撤销会话，但不使历史观察失效 */
export const FIXTURE_PRINCIPAL_TEACHER_DISABLED: Principal = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherDisabled,
  username: "qianlaoshi",
  display_name: "钱老师",
  role: "teacher",
  account_status: "disabled",
  scope: { kind: "none", reason: "account_disabled" },
};

/** 任教安排被撤销的教师：当前范围仅郁金香班，曾在向日葵班写观察 */
export const FIXTURE_PRINCIPAL_TEACHER_REVOKED: Principal = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherRevoked,
  username: "zhoulaoshi",
  display_name: "周老师",
  role: "teacher",
  account_status: "active",
  scope: { kind: "classes", class_ids: [FIXTURE_CLASS_IDS.tulip] },
};

/* -------------------------------- 身份状态 -------------------------------- */

export const FIXTURE_AUTH_ADMIN: AuthState = {
  kind: "authenticated",
  principal: FIXTURE_PRINCIPAL_ADMIN,
};
export const FIXTURE_AUTH_TEACHER_A: AuthState = {
  kind: "authenticated",
  principal: FIXTURE_PRINCIPAL_TEACHER_A,
};
export const FIXTURE_AUTH_TEACHER_B: AuthState = {
  kind: "authenticated",
  principal: FIXTURE_PRINCIPAL_TEACHER_B,
};
export const FIXTURE_AUTH_TEACHER_EMPTY: AuthState = {
  kind: "authenticated",
  principal: FIXTURE_PRINCIPAL_TEACHER_EMPTY,
};
export const FIXTURE_AUTH_TEACHER_DISABLED: AuthState = {
  kind: "authenticated",
  principal: FIXTURE_PRINCIPAL_TEACHER_DISABLED,
};
export const FIXTURE_AUTH_TEACHER_REVOKED: AuthState = {
  kind: "authenticated",
  principal: FIXTURE_PRINCIPAL_TEACHER_REVOKED,
};
export const FIXTURE_AUTH_ANONYMOUS: AuthState = { kind: "anonymous" };
export const FIXTURE_AUTH_UNKNOWN_TOKEN: AuthState = {
  kind: "invalid_session",
  reason: "unknown_token",
};
export const FIXTURE_AUTH_REVOKED: AuthState = { kind: "invalid_session", reason: "revoked" };
export const FIXTURE_AUTH_EXPIRED: AuthState = { kind: "invalid_session", reason: "expired" };
export const FIXTURE_AUTH_UNAVAILABLE: AuthState = {
  kind: "unavailable",
  reason: "identity_service_unavailable",
};

/** 模型等待期间会话被撤销后的状态 */
export const FIXTURE_AUTH_REVOKED_AFTER_WAIT: AuthState = {
  kind: "invalid_session",
  reason: "revoked",
};

/* ------------------------------ 旧 Cookie 与空范围 ------------------------------ */

/** 旧教师口令 Cookie：新会话校验一律不认可 */
export const FIXTURE_LEGACY_COOKIE = {
  cookie_name: LEGACY_AUTH_COOKIE,
  value: "1750000000.0123456789abcdef",
  clear_path: "/",
} as const;

export const FIXTURE_LEGACY_COOKIE_STATE: AuthState = {
  kind: "invalid_session",
  reason: "legacy_cookie_not_accepted",
};

/** 明确空范围与“无范围”的不同形态：两者都不等于全园 */
export const FIXTURE_EMPTY_CLASS_SCOPE: DataScope = { kind: "classes", class_ids: [] };
export const FIXTURE_NO_SCOPE: DataScope = { kind: "none", reason: "no_assignment" };

/* -------------------------------- 授权用例 -------------------------------- */

export interface FixtureAccessExpectation {
  allowed: boolean;
  via?: AccessVia;
  projection?: AccessProjection;
  deny?: AuthDenyReason;
  /** 动作/资源组合非法：400，先于角色与范围判定 */
  invalid_request?: typeof ACCESS_INVALID_COMBINATION_ERROR;
  /** 授权通过后仍可能被 G2 业务保护拦截（409），不属于授权错误 */
  business_guard?: "class_history_protected" | null;
}

export interface FixtureAccessCase {
  name: string;
  auth: AuthState;
  action: AccessAction;
  resource: AccessResource;
  expected: FixtureAccessExpectation;
}

const SCHOOL_RESOURCE: AccessResource = { kind: "school", school_id: FIXTURE_SCHOOL_ID };
const classResource = (class_id: string): AccessResource => ({ kind: "class", class_id });
const childResource = (child_id: string, current_class_id: string | null): AccessResource => ({
  kind: "child",
  child_id,
  current_class_id,
});
const transferResource = (
  child_id: string,
  current_class_id: string | null,
  target_class_id: string,
): AccessResource => ({ kind: "transfer", child_id, current_class_id, target_class_id });
const observationResource = (input: {
  observation_id: string;
  child_id: string;
  current_class_id: string | null;
  observed_class_id: string | null;
  author_account_id: string | null;
}): AccessResource => ({ kind: "observation", ...input });

/** 转班幼儿在原班的历史观察：当前归属蒲公英班，发生时向日葵班 */
const transferredHistoryResource = (): AccessResource =>
  observationResource({
    observation_id: FIXTURE_OBSERVATION_IDS.transferredHistory,
    child_id: FIXTURE_CHILD_IDS.transferred,
    current_class_id: FIXTURE_CLASS_IDS.daisy,
    observed_class_id: FIXTURE_CLASS_IDS.sunflower,
    author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
  });

/** 教师 A 当前负责幼儿在班内待确认的观察 */
const inClassConfirmableResource = (): AccessResource =>
  observationResource({
    observation_id: FIXTURE_OBSERVATION_IDS.inClassConfirmable,
    child_id: FIXTURE_CHILD_IDS.current,
    current_class_id: FIXTURE_CLASS_IDS.sunflower,
    observed_class_id: FIXTURE_CLASS_IDS.sunflower,
    author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
  });

export const FIXTURE_ACCESS_CASES: FixtureAccessCase[] = [
  {
    name: "logged-out-school-read",
    auth: FIXTURE_AUTH_ANONYMOUS,
    action: "school.read",
    resource: SCHOOL_RESOURCE,
    expected: { allowed: false, deny: "unauthenticated" },
  },
  {
    name: "unknown-token-child-read",
    auth: FIXTURE_AUTH_UNKNOWN_TOKEN,
    action: "child.read",
    resource: childResource(FIXTURE_CHILD_IDS.current, FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, deny: "unauthenticated" },
  },
  {
    name: "revoked-session-class-read",
    auth: FIXTURE_AUTH_REVOKED,
    action: "class.read",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, deny: "unauthenticated" },
  },
  {
    name: "identity-unavailable-fail-closed",
    auth: FIXTURE_AUTH_UNAVAILABLE,
    action: "school.read",
    resource: SCHOOL_RESOURCE,
    expected: { allowed: false, deny: "identity_unavailable" },
  },
  {
    name: "admin-school-read",
    auth: FIXTURE_AUTH_ADMIN,
    action: "school.read",
    resource: SCHOOL_RESOURCE,
    expected: { allowed: true, via: "admin_school", projection: "full" },
  },
  {
    name: "admin-manage-class",
    auth: FIXTURE_AUTH_ADMIN,
    action: "class.manage",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: true, via: "admin_school", projection: "full" },
  },
  {
    name: "admin-manage-teacher",
    auth: FIXTURE_AUTH_ADMIN,
    action: "teacher.manage",
    resource: SCHOOL_RESOURCE,
    expected: { allowed: true, via: "admin_school", projection: "full" },
  },
  {
    name: "admin-assign-teacher",
    auth: FIXTURE_AUTH_ADMIN,
    action: "teacher.assign",
    resource: classResource(FIXTURE_CLASS_IDS.tulip),
    expected: { allowed: true, via: "admin_school", projection: "full" },
  },
  {
    name: "admin-create-profile-base-info",
    auth: FIXTURE_AUTH_ADMIN,
    action: "child.create_profile",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: true, via: "admin_school", projection: "full" },
  },
  {
    name: "admin-transfer-child",
    auth: FIXTURE_AUTH_ADMIN,
    action: "child.transfer",
    resource: transferResource(
      FIXTURE_CHILD_IDS.current,
      FIXTURE_CLASS_IDS.sunflower,
      FIXTURE_CLASS_IDS.tulip,
    ),
    expected: { allowed: true, via: "admin_school", projection: "full" },
  },
  {
    name: "admin-teaching-write-denied",
    auth: FIXTURE_AUTH_ADMIN,
    action: "observation.write",
    resource: childResource(FIXTURE_CHILD_IDS.current, FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, deny: "forbidden_role" },
  },
  {
    name: "admin-teaching-organize-denied",
    auth: FIXTURE_AUTH_ADMIN,
    action: "observation.organize",
    resource: inClassConfirmableResource(),
    expected: { allowed: false, deny: "forbidden_role" },
  },
  {
    name: "admin-teaching-confirm-denied",
    auth: FIXTURE_AUTH_ADMIN,
    action: "observation.confirm",
    resource: inClassConfirmableResource(),
    expected: { allowed: false, deny: "forbidden_role" },
  },
  {
    name: "admin-guide-decision-denied",
    auth: FIXTURE_AUTH_ADMIN,
    action: "guide.decide",
    resource: inClassConfirmableResource(),
    expected: { allowed: false, deny: "forbidden_role" },
  },
  {
    name: "teacher-a-read-sunflower",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "class.read",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: true, via: "assigned_class", projection: "full" },
  },
  {
    name: "teacher-a-read-second-class",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "class.read",
    resource: classResource(FIXTURE_CLASS_IDS.tulip),
    expected: { allowed: true, via: "assigned_class", projection: "full" },
  },
  {
    name: "teacher-b-read-overlapping-class",
    auth: FIXTURE_AUTH_TEACHER_B,
    action: "class.read",
    resource: classResource(FIXTURE_CLASS_IDS.tulip),
    expected: { allowed: true, via: "assigned_class", projection: "full" },
  },
  {
    name: "teacher-b-read-other-class-denied",
    auth: FIXTURE_AUTH_TEACHER_B,
    action: "class.read",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, deny: "out_of_scope" },
  },
  {
    name: "class-catalog-separate-from-membership",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "class.catalog.read",
    resource: classResource(FIXTURE_CLASS_IDS.daisy),
    expected: { allowed: true, via: "school_catalog", projection: "full" },
  },
  {
    name: "teacher-empty-scope-denied",
    auth: FIXTURE_AUTH_TEACHER_EMPTY,
    action: "class.read",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, deny: "empty_scope" },
  },
  {
    name: "teacher-school-read-denied",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "school.read",
    resource: SCHOOL_RESOURCE,
    expected: { allowed: false, deny: "forbidden_role" },
  },
  {
    name: "teacher-manage-class-denied",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "class.manage",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, deny: "forbidden_role" },
  },
  {
    name: "teacher-a-child-current-full-history",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "child.read",
    resource: childResource(FIXTURE_CHILD_IDS.current, FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
  },
  {
    name: "teacher-a-child-transferred-profile-denied",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "child.read",
    resource: childResource(FIXTURE_CHILD_IDS.transferred, FIXTURE_CLASS_IDS.daisy),
    expected: { allowed: false, deny: "out_of_scope" },
  },
  {
    name: "teacher-b-child-transferred-current",
    auth: FIXTURE_AUTH_TEACHER_B,
    action: "child.read",
    resource: childResource(FIXTURE_CHILD_IDS.transferred, FIXTURE_CLASS_IDS.daisy),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
  },
  {
    name: "teacher-a-read-transferred-history-observation",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "observation.read",
    resource: transferredHistoryResource(),
    expected: { allowed: true, via: "historical_class", projection: "historical_read_only" },
  },
  {
    name: "current-responsible-reads-prior-class-history",
    auth: FIXTURE_AUTH_TEACHER_B,
    action: "observation.read",
    resource: transferredHistoryResource(),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
  },
  {
    name: "teacher-a-write-observation-for-current-child",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "observation.write",
    resource: childResource(FIXTURE_CHILD_IDS.current, FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
  },
  {
    name: "teacher-a-organize-existing-observation",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "observation.organize",
    resource: inClassConfirmableResource(),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
  },
  {
    name: "teacher-a-confirm-existing-observation",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "observation.confirm",
    resource: inClassConfirmableResource(),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
  },
  {
    name: "teacher-b-confirm-prior-class-history",
    auth: FIXTURE_AUTH_TEACHER_B,
    action: "observation.confirm",
    resource: transferredHistoryResource(),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
  },
  {
    name: "teacher-a-operate-transferred-history-denied",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "observation.confirm",
    resource: transferredHistoryResource(),
    expected: { allowed: false, deny: "out_of_scope" },
  },
  {
    name: "author-is-not-authorization-after-revocation",
    auth: FIXTURE_AUTH_TEACHER_REVOKED,
    action: "observation.read",
    resource: observationResource({
      observation_id: FIXTURE_OBSERVATION_IDS.daisyByRevokedAuthor,
      child_id: FIXTURE_CHILD_IDS.current,
      current_class_id: FIXTURE_CLASS_IDS.sunflower,
      observed_class_id: FIXTURE_CLASS_IDS.sunflower,
      author_account_id: FIXTURE_ACCOUNT_IDS.teacherRevoked,
    }),
    expected: { allowed: false, deny: "out_of_scope" },
  },
  {
    name: "disabled-author-history-still-readable",
    auth: FIXTURE_AUTH_TEACHER_B,
    action: "observation.read",
    resource: observationResource({
      observation_id: FIXTURE_OBSERVATION_IDS.tulipByDisabledAuthor,
      child_id: FIXTURE_CHILD_IDS.current,
      current_class_id: FIXTURE_CLASS_IDS.tulip,
      observed_class_id: FIXTURE_CLASS_IDS.tulip,
      author_account_id: FIXTURE_ACCOUNT_IDS.teacherDisabled,
    }),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
  },
  {
    name: "disabled-account-business-denied",
    auth: FIXTURE_AUTH_TEACHER_DISABLED,
    action: "class.read",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, deny: "account_disabled" },
  },
  {
    name: "admin-class-history-protection-is-business-conflict",
    auth: FIXTURE_AUTH_ADMIN,
    action: "class.manage",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: {
      allowed: true,
      via: "admin_school",
      projection: "full",
      business_guard: "class_history_protected",
    },
  },

  /* ---- 动作/资源非法组合：400，先于角色与范围，管理员也不能绕过 ---- */
  {
    name: "invalid-combo-confirm-with-class",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "observation.confirm",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, invalid_request: ACCESS_INVALID_COMBINATION_ERROR },
  },
  {
    name: "invalid-combo-admin-confirm-with-class",
    auth: FIXTURE_AUTH_ADMIN,
    action: "observation.confirm",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, invalid_request: ACCESS_INVALID_COMBINATION_ERROR },
  },
  {
    name: "invalid-combo-write-with-observation",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "observation.write",
    resource: inClassConfirmableResource(),
    expected: { allowed: false, invalid_request: ACCESS_INVALID_COMBINATION_ERROR },
  },
  {
    name: "invalid-combo-profile-with-observation",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "growth_profile.write",
    resource: inClassConfirmableResource(),
    expected: { allowed: false, invalid_request: ACCESS_INVALID_COMBINATION_ERROR },
  },
  {
    name: "invalid-combo-guide-with-child",
    auth: FIXTURE_AUTH_TEACHER_A,
    action: "guide.decide",
    resource: childResource(FIXTURE_CHILD_IDS.current, FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, invalid_request: ACCESS_INVALID_COMBINATION_ERROR },
  },
  {
    name: "invalid-combo-teacher-manage-with-class",
    auth: FIXTURE_AUTH_ADMIN,
    action: "teacher.manage",
    resource: classResource(FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: false, invalid_request: ACCESS_INVALID_COMBINATION_ERROR },
  },
];

/** 授权失败 ≠ 空数据：错误必须是显式拒绝，不能伪装成“没有记录” */
export const FIXTURE_AUTHORIZATION_DENIED_RESULT: AccessDecision = {
  allowed: false,
  deny: "out_of_scope",
};
export const FIXTURE_AUTHORIZED_EMPTY_LIST = { items: [] as string[] };

/* ------------------------------ 登录前请求保护 ------------------------------ */

export const FIXTURE_TRUSTED_ORIGINS = ["https://yaya.example.edu"] as const;

export interface FixtureLoginGuardCase {
  name: string;
  origin: string | null;
  sec_fetch_site: string | null;
  auth_request_header: string | null;
  content_type: string | null;
  has_session_cookie: boolean;
  has_legacy_cookie: boolean;
  /** 用于证明 Host / Forwarded 不能被当作可信源 */
  host_header: string | null;
  expected: { accepted: boolean; failure?: LoginGuardFailure };
}

export const FIXTURE_LOGIN_GUARD_CASES: FixtureLoginGuardCase[] = [
  {
    name: "valid-pre-login-without-session",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "application/json",
    has_session_cookie: false,
    has_legacy_cookie: true,
    host_header: "yaya.example.edu",
    expected: { accepted: true },
  },
  {
    name: "json-with-charset-accepted",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "application/json; charset=utf-8",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: true },
  },
  {
    name: "json-case-insensitive-accepted",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "Application/JSON",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: true },
  },
  {
    name: "jsonp-prefix-rejected",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "application/jsonp",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "content_type_rejected" },
  },
  {
    name: "json-seq-rejected",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "application/json-seq",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "content_type_rejected" },
  },
  {
    name: "jsonx-rejected",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "application/jsonx",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "content_type_rejected" },
  },
  {
    name: "text-plain-rejected",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "text/plain",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "content_type_rejected" },
  },
  {
    name: "empty-content-type-rejected",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "content_type_rejected" },
  },
  {
    name: "cross-origin-rejected",
    origin: "https://evil.example",
    sec_fetch_site: "cross-site",
    auth_request_header: "1",
    content_type: "application/json",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "origin_untrusted" },
  },
  {
    name: "origin-null-rejected",
    origin: "null",
    sec_fetch_site: null,
    auth_request_header: "1",
    content_type: "application/json",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "origin_untrusted" },
  },
  {
    name: "spoofed-host-not-trusted",
    origin: "https://evil.example",
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "application/json",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "origin_untrusted" },
  },
  {
    name: "origin-missing-rejected",
    origin: null,
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "application/json",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "same_origin_proof_missing" },
  },
  {
    name: "custom-header-missing-rejected",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: null,
    content_type: "application/json",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "auth_request_header_missing" },
  },
  {
    name: "plain-form-rejected",
    origin: FIXTURE_TRUSTED_ORIGINS[0],
    sec_fetch_site: "same-origin",
    auth_request_header: "1",
    content_type: "application/x-www-form-urlencoded",
    has_session_cookie: false,
    has_legacy_cookie: false,
    host_header: "yaya.example.edu",
    expected: { accepted: false, failure: "content_type_rejected" },
  },
];

/* ------------------------------ 会话 CSRF 绑定 ------------------------------ */

export const FIXTURE_CSRF_BINDING = {
  session_a: { session_id: "5e55ion0-0000-4000-8000-00000000000a", token: "csrf-token-a" },
  session_b: { session_id: "5e55ion0-0000-4000-8000-00000000000b", token: "csrf-token-b" },
} as const;

export interface FixtureCsrfCase {
  name: string;
  session_id: string;
  token: string | null;
  expected: "accepted" | "csrf_rejected";
}

export const FIXTURE_CSRF_CASES: FixtureCsrfCase[] = [
  {
    name: "own-session-token-accepted",
    session_id: FIXTURE_CSRF_BINDING.session_a.session_id,
    token: FIXTURE_CSRF_BINDING.session_a.token,
    expected: "accepted",
  },
  {
    name: "other-session-token-rejected",
    session_id: FIXTURE_CSRF_BINDING.session_b.session_id,
    token: FIXTURE_CSRF_BINDING.session_a.token,
    expected: "csrf_rejected",
  },
  {
    name: "missing-token-rejected",
    session_id: FIXTURE_CSRF_BINDING.session_a.session_id,
    token: null,
    expected: "csrf_rejected",
  },
];

/* -------------------------------- 退出与 Cookie 并存 -------------------------------- */

export interface FixtureLogoutCase {
  name: string;
  session: "valid" | "invalid" | "absent";
  expected: { status: 200; revoke_current: boolean; clear_cookies: true };
}

export const FIXTURE_LOGOUT_CASES: FixtureLogoutCase[] = [
  { name: "logout-valid-session", session: "valid", expected: { status: 200, revoke_current: true, clear_cookies: true } },
  { name: "logout-invalid-session-idempotent", session: "invalid", expected: { status: 200, revoke_current: false, clear_cookies: true } },
  { name: "logout-absent-session-idempotent", session: "absent", expected: { status: 200, revoke_current: false, clear_cookies: true } },
];

export const FIXTURE_LEGACY_COOKIE_CLEAR = {
  cookie_name: LEGACY_AUTH_COOKIE,
  path: "/",
} as const;

/** 新旧 Cookie 并存：新会话按自身有效性校验，旧 Cookie 不提升权限也不阻断登录 */
export interface FixtureCookieCoexistenceCase {
  name: string;
  new_session: "valid" | "invalid" | "absent";
  legacy_cookie: boolean;
  expected_state: "authenticated" | "invalid_session";
  login_allowed: boolean;
}

export const FIXTURE_COOKIE_COEXISTENCE_CASES: FixtureCookieCoexistenceCase[] = [
  { name: "valid-new-session-with-legacy", new_session: "valid", legacy_cookie: true, expected_state: "authenticated", login_allowed: true },
  { name: "invalid-new-session-with-legacy", new_session: "invalid", legacy_cookie: true, expected_state: "invalid_session", login_allowed: true },
  { name: "legacy-only", new_session: "absent", legacy_cookie: true, expected_state: "invalid_session", login_allowed: true },
];

export const FIXTURE_RELOGIN_SESSION_IDS = {
  previous: "5e55ion0-0000-4000-8000-00000000000c",
  next: "5e55ion0-0000-4000-8000-00000000000d",
} as const;

/* ------------------------------ 首位管理员初始化（部署者脚本） ------------------------------ */

export interface FixtureBootstrapCase {
  name: string;
  context: AdminBootstrapContext;
  admins_exist: boolean;
  expected: { accepted: boolean; error?: "not_deployer" | "admin_already_initialized" };
}

export const FIXTURE_BOOTSTRAP_CASES: FixtureBootstrapCase[] = [
  {
    name: "deployer-no-admin-accepted",
    context: "deployer_non_public_script",
    admins_exist: false,
    expected: { accepted: true },
  },
  {
    name: "deployer-admin-exists-rejected",
    context: "deployer_non_public_script",
    admins_exist: true,
    expected: { accepted: false, error: "admin_already_initialized" },
  },
  {
    name: "public-http-no-admin-rejected",
    context: "public_http",
    admins_exist: false,
    expected: { accepted: false, error: "not_deployer" },
  },
  {
    name: "authenticated-http-admin-exists-rejected",
    context: "authenticated_http",
    admins_exist: true,
    expected: { accepted: false, error: "not_deployer" },
  },
];

/** 并发初始化：两个同时执行只允许一个成功，另一个得到 admin_already_initialized */
export const FIXTURE_BOOTSTRAP_CONCURRENT = {
  attempts: 2,
  initial_admins: 0,
  expected_successes: 1,
  expected_conflicts: 1,
} as const;

export const FIXTURE_ADMIN_BOOTSTRAP_INPUT: AdminBootstrapInput = {
  username: "yayuanzhang",
  display_name: "芽芽园长",
  password: "fixture-admin-password-no-default",
};

export const FIXTURE_ADMIN_BOOTSTRAP_RESULT: AdminBootstrapResult = {
  principal: FIXTURE_PRINCIPAL_ADMIN,
};

export const FIXTURE_ADMIN_BOOTSTRAP_STATUS: AdminBootstrapStatus = {
  admin_initialized: false,
};

/* ------------------------------ 模型等待期间重核 ------------------------------ */

export interface FixtureModelWaitCase {
  name: string;
  event: ModelWaitEvent;
  before: { auth: AuthState; action: AccessAction; resource: AccessResource };
  after: { auth: AuthState; action: AccessAction; resource: AccessResource };
  expected:
    | { write: true; outcome: "saved" }
    | { write: false; outcome: "denied"; deny: AuthDenyReason }
    | { write: false; outcome: "conflict"; error: "state_conflict" | "attempt_owner_mismatch" };
}

export const FIXTURE_MODEL_WAIT_CASES: FixtureModelWaitCase[] = [
  {
    name: "no-change-saves",
    event: "none",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    expected: { write: true, outcome: "saved" },
  },
  {
    name: "session-revoked-during-wait",
    event: "session_revoked",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_REVOKED_AFTER_WAIT,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    expected: { write: false, outcome: "denied", deny: "unauthenticated" },
  },
  {
    name: "account-disabled-during-wait",
    event: "account_disabled",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_TEACHER_DISABLED,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    expected: { write: false, outcome: "denied", deny: "account_disabled" },
  },
  {
    name: "assignment-removed-during-wait",
    event: "assignment_removed",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_TEACHER_REVOKED,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    expected: { write: false, outcome: "denied", deny: "out_of_scope" },
  },
  {
    name: "child-transferred-during-wait",
    event: "child_transferred",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: observationResource({
        observation_id: FIXTURE_OBSERVATION_IDS.inClassConfirmable,
        child_id: FIXTURE_CHILD_IDS.current,
        current_class_id: FIXTURE_CLASS_IDS.daisy,
        observed_class_id: FIXTURE_CLASS_IDS.sunflower,
        author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
      }),
    },
    expected: { write: false, outcome: "denied", deny: "out_of_scope" },
  },
  {
    /**
     * 主评审反例：教师同时负责向日葵与郁金香；请求开始时幼儿在向日葵，
     * 模型等待期间转到郁金香。返回后仍有权限，但归属前提已变化，必须冲突且零写入。
     */
    name: "child-transferred-within-scope-conflicts",
    event: "child_transferred",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: observationResource({
        observation_id: FIXTURE_OBSERVATION_IDS.inClassConfirmable,
        child_id: FIXTURE_CHILD_IDS.current,
        current_class_id: FIXTURE_CLASS_IDS.tulip,
        observed_class_id: FIXTURE_CLASS_IDS.sunflower,
        author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
      }),
    },
    expected: { write: false, outcome: "conflict", error: "state_conflict" },
  },
  {
    /** 归属事实已变，但事件标签为 none：仍必须冲突，证明比较来自事实而非标签 */
    name: "attribution-changed-with-none-label-conflicts",
    event: "none",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: observationResource({
        observation_id: FIXTURE_OBSERVATION_IDS.inClassConfirmable,
        child_id: FIXTURE_CHILD_IDS.current,
        current_class_id: FIXTURE_CLASS_IDS.tulip,
        observed_class_id: FIXTURE_CLASS_IDS.sunflower,
        author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
      }),
    },
    expected: { write: false, outcome: "conflict", error: "state_conflict" },
  },
  {
    name: "observation-changed-during-wait",
    event: "observation_changed",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    expected: { write: false, outcome: "conflict", error: "state_conflict" },
  },
  {
    name: "new-session-cannot-take-over",
    event: "principal_replaced",
    before: {
      auth: FIXTURE_AUTH_TEACHER_A,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    after: {
      auth: FIXTURE_AUTH_TEACHER_B,
      action: "observation.confirm",
      resource: inClassConfirmableResource(),
    },
    expected: { write: false, outcome: "conflict", error: "attempt_owner_mismatch" },
  },
];

/* ------------------------------ 密码原样处理 ------------------------------ */

/** 含两端空白与大小写的原始密码：不得 trim、不得 Unicode 规范化 */
export const FIXTURE_PASSWORD_RAW = "  Passw0rd 保留两端空白与大小写 ";
export const FIXTURE_PASSWORD_USERNAME = "  LiLaoShi ";

/* ------------------------------ 接口契约 fixture ------------------------------ */

export const FIXTURE_LOGIN_REQUEST: LoginRequest = {
  username: FIXTURE_PASSWORD_USERNAME,
  password: FIXTURE_PASSWORD_RAW,
};

export const FIXTURE_SESSION_VIEW = {
  session_id: "5e55ion0-0000-4000-8000-000000000001",
  created_at: "2026-09-30T08:00:00.000Z",
  expires_at: "2026-10-07T08:00:00.000Z",
} as const;

export const FIXTURE_LOGIN_RESPONSE: LoginResponse = {
  state: FIXTURE_AUTH_TEACHER_A,
  session: FIXTURE_SESSION_VIEW,
  csrf: { header_name: CSRF_HEADER_NAME, token: "fixture-csrf-token" },
  cleanup: [...CLIENT_CLEANUP_TARGETS],
};

export const FIXTURE_LOGOUT_RESPONSE: LogoutResponse = {
  state: FIXTURE_AUTH_ANONYMOUS,
  session: null,
  csrf: null,
  cleanup: [...CLIENT_CLEANUP_TARGETS],
};

export const FIXTURE_SESSION_STATUS_ANONYMOUS: SessionStatusView = {
  state: FIXTURE_AUTH_ANONYMOUS,
  session: null,
  csrf: null,
};

export const FIXTURE_TEACHER_A_SUMMARY: TeacherAccountSummary = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherA,
  username: "lilaoshi",
  display_name: "李老师",
  role: "teacher",
  status: "active",
  class_ids: [FIXTURE_CLASS_IDS.sunflower, FIXTURE_CLASS_IDS.tulip],
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: null,
};

export const FIXTURE_TEACHER_EMPTY_SUMMARY: TeacherAccountSummary = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherEmpty,
  username: "zhaolaoshi",
  display_name: "赵老师",
  role: "teacher",
  status: "active",
  class_ids: [],
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: null,
};

export const FIXTURE_TEACHER_LIST_RESPONSE: TeacherListResponse = {
  teachers: [FIXTURE_TEACHER_A_SUMMARY, FIXTURE_TEACHER_EMPTY_SUMMARY],
};

export const FIXTURE_TEACHER_CREATE_REQUEST: TeacherCreateRequest = {
  username: "chenlaoshi",
  display_name: "陈老师",
  initial_password: "fixture-initial-password",
  class_ids: [FIXTURE_CLASS_IDS.daisy],
};

export const FIXTURE_TEACHER_STATUS_REQUEST: TeacherStatusRequest = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherB,
  status: "disabled",
};

/** 停用必须撤销该账号全部会话；响应不包含密码或哈希信息 */
export const FIXTURE_TEACHER_STATUS_RESPONSE: TeacherStatusResponse = {
  teacher: { ...FIXTURE_TEACHER_A_SUMMARY, status: "disabled" },
  revoked_session_count: 2,
};

export const FIXTURE_CLASS_ASSIGNMENT_REQUEST: ClassAssignmentRequest = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherEmpty,
  class_id: FIXTURE_CLASS_IDS.sunflower,
};

export const FIXTURE_CLASS_UNASSIGNMENT_REQUEST: ClassUnassignmentRequest = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherB,
  class_id: FIXTURE_CLASS_IDS.daisy,
  reason: "调整任教安排",
};

export const FIXTURE_PASSWORD_RESET_REQUEST: PasswordResetRequest = {
  account_id: FIXTURE_ACCOUNT_IDS.teacherA,
  new_password: "fixture-reset-password",
};

/** 重置密码必须撤销该账号全部会话；响应不返回任何密码或哈希信息 */
export const FIXTURE_PASSWORD_RESET_RESPONSE: PasswordResetResponse = {
  teacher: FIXTURE_TEACHER_A_SUMMARY,
  revoked_session_count: 3,
};
