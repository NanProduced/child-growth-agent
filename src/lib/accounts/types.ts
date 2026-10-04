/**
 * 单园所账号与授权 v1 契约共享类型（AUTH0 冻结）。
 *
 * 范围：仅定义非敏感公共类型与固定口径；不实现认证、不建表、不迁移、不调用模型。
 * 冻结文件：本文件、`src/lib/home-v2/types.ts`、`docs/auth-v1/contract.md`、
 * `docs/auth-v1/ownership.md`、两处契约 fixture 与 `scripts/check-auth-contract.ts`。
 * 并行期间任何模块不得自行修改冻结类型；需要变更时由契约负责人统一修订。
 *
 * 安全边界：
 * - 角色、账号状态、班级范围一律由服务端解析，本文件不提供任何“前端标签即权限”的表达；
 * - 任何 DTO 都不包含密码、密码哈希、会话令牌或可被前端过滤的全园数据；
 * - 权限服务不可用时 fail closed（503），不得回退为匿名或默认全园。
 */

/** 持久化角色：单园所仅 admin / teacher 两种，不做自定义角色 */
export const ACCOUNT_ROLES = ["admin", "teacher"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** 账号状态：停用不做物理删除，停用会使现有会话失效，但不使历史观察失效 */
export const ACCOUNT_STATUSES = ["active", "disabled"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * 规范化后的用户名。规范化规则（与密码处理分离）：
 * 两端去空白 → Unicode NFKC → 转小写；唯一性按规范化结果判断。
 * 密码永不做 trim 或规范化，原样参与哈希校验。
 */
export type NormalizedUsername = string;

/* ---------------------------------- 范围 ---------------------------------- */

export const DATA_SCOPE_NONE_REASONS = [
  "no_assignment",
  "account_disabled",
  "no_business_scope",
] as const;
export type DataScopeNoneReason = (typeof DATA_SCOPE_NONE_REASONS)[number];

/**
 * 服务端数据范围。三种形态必须严格区分：
 * - school：管理员的全园范围；
 * - classes：教师的任教班级集合；**空数组是明确的“空”**，绝不等于全园；
 * - none：没有任何业务范围（未分配 / 已停用 / 无范围角色）。
 * 身份不可用不是范围，单独由 `AuthState.unavailable` 表达。
 */
export type DataScope =
  | { kind: "school"; school_id: string }
  | { kind: "classes"; class_ids: string[] }
  | { kind: "none"; reason: DataScopeNoneReason };

/* -------------------------------- 身份状态 -------------------------------- */

export const AUTH_STATE_KINDS = [
  "authenticated",
  "anonymous",
  "invalid_session",
  "unavailable",
] as const;
export type AuthStateKind = (typeof AUTH_STATE_KINDS)[number];

/** 会话不被认可的具体原因；全部按 401 返回，但状态语义不同 */
export const INVALID_SESSION_REASONS = [
  "expired",
  "revoked",
  "unknown_token",
  "legacy_cookie_not_accepted",
] as const;
export type InvalidSessionReason = (typeof INVALID_SESSION_REASONS)[number];

/**
 * 服务端解析出的身份状态。身份/权限服务不可用（unavailable）必须单独表达，
 * 不得降级成匿名（anonymous），也不得按“无记录”处理。
 */
export type AuthState =
  | { kind: "authenticated"; principal: Principal }
  | { kind: "anonymous" }
  | { kind: "invalid_session"; reason: InvalidSessionReason }
  | { kind: "unavailable"; reason: "identity_service_unavailable" };

/** 当前操作者：角色、状态与范围全部来自服务端会话解析，不使用前端标签或过期快照 */
export interface Principal {
  account_id: string;
  username: NormalizedUsername;
  display_name: string;
  role: AccountRole;
  account_status: AccountStatus;
  scope: DataScope;
}

/* ------------------------------- 资源授权动作 ------------------------------- */

export const ACCESS_ACTIONS = [
  "school.read",
  "class.read",
  "class.catalog.read",
  "class.manage",
  "teacher.manage",
  "teacher.assign",
  "child.read",
  "child.create_profile",
  "child.transfer",
  "observation.read",
  "observation.write",
  "observation.confirm",
  "guide.decide",
  "growth_profile.write",
  "activity_support.write",
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/**
 * 教学动作：管理员一律拒绝（403 forbidden_role），不得伪装成教师执行。
 * 教师是否可做，仍取决于其当前任教关系与幼儿当前归属。
 */
export const TEACHING_ACCESS_ACTIONS = [
  "observation.write",
  "observation.confirm",
  "guide.decide",
  "growth_profile.write",
  "activity_support.write",
] as const satisfies readonly AccessAction[];

/**
 * 授权判定使用的服务端事实（不由请求体声明）：
 * - child：幼儿**当前**归属班级；null=当前无归属；
 * - observation：发生时班级快照与作者账号 id；旧记录作者为 null=历史未知，不补造。
 */
export type AccessResource =
  | { kind: "school"; school_id: string }
  | { kind: "class"; class_id: string }
  | { kind: "child"; child_id: string; current_class_id: string | null }
  | {
      kind: "observation";
      observation_id: string;
      child_id: string;
      current_class_id: string | null;
      observed_class_id: string | null;
      author_account_id: string | null;
    };

export const AUTH_DENY_REASONS = [
  "unauthenticated",
  "forbidden_role",
  "out_of_scope",
  "empty_scope",
  "account_disabled",
  "identity_unavailable",
] as const;
export type AuthDenyReason = (typeof AUTH_DENY_REASONS)[number];

/** 授权失败对应的 HTTP 状态：401 未认证 / 403 无权限 / 503 身份服务不可用（fail closed） */
export const AUTH_DENY_HTTP_STATUS: Record<AuthDenyReason, 401 | 403 | 503> = {
  unauthenticated: 401,
  forbidden_role: 403,
  out_of_scope: 403,
  empty_scope: 403,
  account_disabled: 403,
  identity_unavailable: 503,
};

/**
 * 读取投影：full=完整对象；historical_read_only=原班历史只读投影（不带跨班证据详情）。
 * `class.catalog.read` 只返回班级基础目录（名称/学段/学年/启停），
 * 与成员名单、统计口径分开授权，不构成 `class.read`。
 */
export const ACCESS_PROJECTIONS = ["full", "historical_read_only"] as const;
export type AccessProjection = (typeof ACCESS_PROJECTIONS)[number];

export const ACCESS_VIAS = [
  "admin_school",
  "school_catalog",
  "assigned_class",
  "current_responsible",
  "historical_class",
] as const;
export type AccessVia = (typeof ACCESS_VIAS)[number];

export type AccessDecision =
  | { allowed: true; projection: AccessProjection; via: AccessVia }
  | { allowed: false; deny: AuthDenyReason };

/* --------------------------------- 错误体 --------------------------------- */

export const AUTH_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "invalid_credentials",
  "forbidden",
  "account_disabled",
  "empty_scope",
  "csrf_rejected",
  "not_found",
  "username_taken",
  "last_admin_protected",
  "state_conflict",
  "rate_limited",
  "server_error",
  "identity_unavailable",
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/**
 * 账号与授权接口错误体。401/403/503 只表达身份与权限问题；
 * 409 等业务冲突（如同名班级、班级历史保护）仍归原业务规则，不混入授权错误。
 */
export interface AuthApiError {
  error: AuthErrorCode;
  message: string;
}

export const AUTH_ERROR_HTTP_STATUS: Record<AuthErrorCode, 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503> = {
  invalid_request: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden: 403,
  account_disabled: 403,
  empty_scope: 403,
  csrf_rejected: 403,
  not_found: 404,
  username_taken: 409,
  last_admin_protected: 409,
  state_conflict: 409,
  rate_limited: 429,
  server_error: 500,
  identity_unavailable: 503,
};

/* -------------------------------- 固定口令策略 -------------------------------- */

/**
 * 固定、可核验的密码哈希参数与格式；服务端必须使用本常量，
 * 不接受请求提供的任意成本参数（N/r/p），也不接受明文或可逆存储。
 * 存储格式：scrypt$N$r$p$<salt_base64>$<hash_base64>（salt 与 hash 均为标准 base64）。
 * 本轮不实现哈希与校验，只冻结参数。
 */
export const PASSWORD_HASH_ALGORITHM = "scrypt";
export const PASSWORD_HASH_FORMAT = "scrypt$<N>$<r>$<p>$<salt_base64>$<hash_base64>";
export const PASSWORD_HASH_PARAMS = { N: 16384, r: 8, p: 1, key_length: 64 } as const;
export const PASSWORD_MIN_LENGTH = 8;

/* --------------------------------- 会话 --------------------------------- */

/** 会话固定绝对期限（登录起算）；GET 不得自动续期或写库，只可撤销 */
export const AUTH_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const CSRF_HEADER_NAME = "x-csrf-token";

/** 会话元数据：只含非敏感信息，绝不包含会话令牌或其哈希 */
export interface SessionView {
  session_id: string;
  created_at: string;
  expires_at: string;
}

/** CSRF 令牌（同源页面读取后通过 `x-csrf-token` 回传；不是会话令牌，不写 HttpOnly Cookie） */
export interface CsrfTokenView {
  header_name: string;
  token: string;
}

export interface SessionStatusView {
  state: AuthState;
  session: SessionView | null;
  csrf: CsrfTokenView | null;
}

/* ------------------------------ 旧入口与客户端清理 ------------------------------ */

/** 旧教师口令 Cookie：新会话校验一律不认可（invalid_session.legacy_cookie_not_accepted） */
export const LEGACY_AUTH_COOKIE = "cga_teacher";

/**
 * 旧入口切换时需要清理的客户端私有状态。登录/退出响应携带该清单，
 * 客户端必须清理后再渲染私有页面，避免旧权限快照或旧缓存残留。
 */
export const CLIENT_CLEANUP_TARGETS = [
  "legacy_teacher_provider",
  "home_v2_payload",
  "private_query_cache",
] as const;
export type ClientCleanupTarget = (typeof CLIENT_CLEANUP_TARGETS)[number];

/* --------------------------------- 接口契约 --------------------------------- */

export const AUTH_API_ACTIONS = [
  "auth.login",
  "auth.status",
  "auth.logout",
  "admin.teachers.list",
  "admin.teachers.create",
  "admin.teachers.set_status",
  "admin.assignments.assign",
  "admin.assignments.remove",
  "admin.password.reset",
  "admin.initialize",
] as const;
export type AuthApiAction = (typeof AUTH_API_ACTIONS)[number];

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse extends SessionStatusView {
  /** 旧入口切换与缓存清理指令；登录成功后客户端必须先清理再加载私有数据 */
  cleanup: ClientCleanupTarget[];
}

export interface LogoutResponse extends SessionStatusView {
  cleanup: ClientCleanupTarget[];
}

/** GET /api/auth/status 的响应：身份不可用时为 unavailable，不得降级为已登录或匿名 */
export type AuthStatusResponse = SessionStatusView;

export interface TeacherAccountSummary {
  account_id: string;
  username: NormalizedUsername;
  display_name: string;
  role: "teacher";
  status: AccountStatus;
  /** 当前任教班级；空数组=尚未分配（可登录，但不能访问业务对象） */
  class_ids: string[];
  created_at: string;
  updated_at: string | null;
}

export interface TeacherListResponse {
  teachers: TeacherAccountSummary[];
}

export interface TeacherCreateRequest {
  username: string;
  display_name: string;
  initial_password: string;
  class_ids?: string[];
}

export interface TeacherCreateResponse {
  teacher: TeacherAccountSummary;
}

export interface TeacherStatusRequest {
  account_id: string;
  status: AccountStatus;
}

/** 停用必须撤销该账号全部会话；revoked_session_count 便于审计与提示 */
export interface TeacherStatusResponse {
  teacher: TeacherAccountSummary;
  revoked_session_count: number;
}

export interface ClassAssignmentRequest {
  account_id: string;
  class_id: string;
}

export interface ClassUnassignmentRequest {
  account_id: string;
  class_id: string;
  reason?: string;
}

export interface ClassAssignmentResponse {
  teacher: TeacherAccountSummary;
}

export interface PasswordResetRequest {
  account_id: string;
  new_password: string;
}

/** 重置密码必须撤销该账号全部会话；不返回任何密码或哈希信息 */
export interface PasswordResetResponse {
  teacher: TeacherAccountSummary;
  revoked_session_count: number;
}

/** 初始管理员初始化：仅在系统尚未存在管理员时一次性可用；无默认生产密码 */
export interface InitialAdminRequest {
  username: string;
  display_name: string;
  password: string;
}

export interface InitialAdminResponse {
  principal: Principal;
}

export interface AdminBootstrapStatus {
  admin_initialized: boolean;
}

/* -------------------------------- 审计元数据 -------------------------------- */

/**
 * 人员引用：只能来自服务端写入的账号 id + 当时的显示名。
 * 旧记录缺作者/确认者时显式返回 null（历史未知），禁止用当前登录账号
 * 或教师备注冒充历史决定者。
 */
export interface AccountRef {
  account_id: string;
  display_name: string;
}

/** 观察的作者与确认者：新记录由服务端写入；旧记录两个字段均可为 null=历史未知 */
export interface ObservationAuthorshipView {
  author: AccountRef | null;
  confirmer: AccountRef | null;
}
