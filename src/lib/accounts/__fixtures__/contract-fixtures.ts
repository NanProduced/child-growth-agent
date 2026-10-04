import {
  CLIENT_CLEANUP_TARGETS,
  CSRF_HEADER_NAME,
  LEGACY_AUTH_COOKIE,
  type AccessAction,
  type AccessDecision,
  type AccessProjection,
  type AccessResource,
  type AccessVia,
  type AuthDenyReason,
  type AuthState,
  type ClassAssignmentRequest,
  type ClassUnassignmentRequest,
  type DataScope,
  type InitialAdminRequest,
  type InitialAdminResponse,
  type LoginRequest,
  type LoginResponse,
  type LogoutResponse,
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
 * 账号与授权 v1 契约 fixture：纯数据，不写数据库、不调用模型、不冒充真实认证。
 *
 * 覆盖反例：两教师不同/重叠班级、多班、空分配、管理员教学拒绝、未登录、
 * 未知身份、权限撤销、转班历史、作者不等授权、错误不等空数据、旧 Cookie 不认可。
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
  /** 原在向日葵班，现转至郁金香班（教师 A 不再是当前负责人） */
  transferred: "a1c10000-0000-4000-8000-0000000000c2",
} as const;

export const FIXTURE_OBSERVATION_IDS = {
  /** 转班幼儿在原班（向日葵班）的历史观察 */
  transferredHistory: "0b5e0000-0000-4000-8000-000000000001",
  /** 教师 B 授权撤销前在雏菊班写下的观察（作者≠当前授权） */
  daisyByRevokedAuthor: "0b5e0000-0000-4000-8000-000000000002",
  /** 已停用教师当年在郁金香班写下的历史观察 */
  tulipByDisabledAuthor: "0b5e0000-0000-4000-8000-000000000003",
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

/** 与教师 A 在郁金香班重叠：郁金香 + 雏菊 */
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

/* ------------------------------ 旧 Cookie 与空范围 ------------------------------ */

/** 旧教师口令 Cookie：新会话校验一律不认可 */
export const FIXTURE_LEGACY_COOKIE = {
  cookie_name: LEGACY_AUTH_COOKIE,
  value: "1750000000.0123456789abcdef",
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
const observationResource = (input: {
  observation_id: string;
  child_id: string;
  current_class_id: string | null;
  observed_class_id: string | null;
  author_account_id: string | null;
}): AccessResource => ({ kind: "observation", ...input });

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
    resource: childResource(FIXTURE_CHILD_IDS.current, FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: true, via: "admin_school", projection: "full" },
  },
  {
    name: "admin-transfer-child",
    auth: FIXTURE_AUTH_ADMIN,
    action: "child.transfer",
    resource: childResource(FIXTURE_CHILD_IDS.current, FIXTURE_CLASS_IDS.sunflower),
    expected: { allowed: true, via: "admin_school", projection: "full" },
  },
  {
    name: "admin-teaching-write-denied",
    auth: FIXTURE_AUTH_ADMIN,
    action: "observation.write",
    resource: observationResource({
      observation_id: FIXTURE_OBSERVATION_IDS.transferredHistory,
      child_id: FIXTURE_CHILD_IDS.current,
      current_class_id: FIXTURE_CLASS_IDS.sunflower,
      observed_class_id: FIXTURE_CLASS_IDS.sunflower,
      author_account_id: null,
    }),
    expected: { allowed: false, deny: "forbidden_role" },
  },
  {
    name: "admin-teaching-confirm-denied",
    auth: FIXTURE_AUTH_ADMIN,
    action: "observation.confirm",
    resource: observationResource({
      observation_id: FIXTURE_OBSERVATION_IDS.transferredHistory,
      child_id: FIXTURE_CHILD_IDS.current,
      current_class_id: FIXTURE_CLASS_IDS.sunflower,
      observed_class_id: FIXTURE_CLASS_IDS.sunflower,
      author_account_id: null,
    }),
    expected: { allowed: false, deny: "forbidden_role" },
  },
  {
    name: "admin-guide-decision-denied",
    auth: FIXTURE_AUTH_ADMIN,
    action: "guide.decide",
    resource: observationResource({
      observation_id: FIXTURE_OBSERVATION_IDS.transferredHistory,
      child_id: FIXTURE_CHILD_IDS.current,
      current_class_id: FIXTURE_CLASS_IDS.sunflower,
      observed_class_id: FIXTURE_CLASS_IDS.sunflower,
      author_account_id: null,
    }),
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
    resource: observationResource({
      observation_id: FIXTURE_OBSERVATION_IDS.transferredHistory,
      child_id: FIXTURE_CHILD_IDS.transferred,
      current_class_id: FIXTURE_CLASS_IDS.daisy,
      observed_class_id: FIXTURE_CLASS_IDS.sunflower,
      author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
    }),
    expected: { allowed: true, via: "historical_class", projection: "historical_read_only" },
  },
  {
    name: "current-responsible-reads-prior-class-history",
    auth: FIXTURE_AUTH_TEACHER_B,
    action: "observation.read",
    resource: observationResource({
      observation_id: FIXTURE_OBSERVATION_IDS.transferredHistory,
      child_id: FIXTURE_CHILD_IDS.transferred,
      current_class_id: FIXTURE_CLASS_IDS.daisy,
      observed_class_id: FIXTURE_CLASS_IDS.sunflower,
      author_account_id: FIXTURE_ACCOUNT_IDS.teacherA,
    }),
    expected: { allowed: true, via: "current_responsible", projection: "full" },
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
];

/** 授权失败 ≠ 空数据：错误必须是显式拒绝，不能伪装成“没有记录” */
export const FIXTURE_AUTHORIZATION_DENIED_RESULT: AccessDecision = {
  allowed: false,
  deny: "out_of_scope",
};
export const FIXTURE_AUTHORIZED_EMPTY_LIST = { items: [] as string[] };

/* ------------------------------ 接口契约 fixture ------------------------------ */

export const FIXTURE_LOGIN_REQUEST: LoginRequest = {
  username: "  LiLaoShi ",
  password: "fixture-only-password",
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

export const FIXTURE_INITIAL_ADMIN_REQUEST: InitialAdminRequest = {
  username: "yayuanzhang",
  display_name: "芽芽园长",
  password: "fixture-admin-password",
};

export const FIXTURE_INITIAL_ADMIN_RESPONSE: InitialAdminResponse = {
  principal: FIXTURE_PRINCIPAL_ADMIN,
};
