/**
 * 单园所账号与授权 v1 契约共享类型（AUTH0-R1 返修候选）。
 *
 * 范围：仅定义非敏感公共类型与固定口径；不实现认证、不建表、不迁移、不调用模型。
 * 冻结文件：本文件、`src/lib/home-v2/types.ts`、`docs/auth-v1/contract.md`、
 * `docs/auth-v1/ownership.md`、两处契约 fixture、`scripts/check-auth-contract.ts`
 * 与 `docs/auth-v1/auth0-r1-delivery.md`。
 * 并行期间任何模块不得自行修改冻结类型；需要变更时由契约负责人统一修订。
 *
 * 安全边界：
 * - 角色、账号状态、班级范围一律由服务端解析，本文件不提供任何“前端标签即权限”的表达；
 * - 任何 DTO 都不包含密码、密码哈希、会话令牌或可被前端过滤的全园数据；
 * - 权限服务不可用时 fail closed（503），不得回退为匿名或默认全园；
 * - 授权判定使用服务端读取的资源事实，不接受客户端声明的 current_class_id、
 *   observed_class_id、author_account_id 作为授权依据。
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
 * 密码永不做 trim 或 Unicode 规范化，原样参与哈希校验。
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
  "observation.organize",
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
  "observation.organize",
  "observation.confirm",
  "guide.decide",
  "growth_profile.write",
  "activity_support.write",
] as const satisfies readonly AccessAction[];

/* ------------------------------ 动作 / 资源合法组合 ------------------------------ */

export const ACCESS_RESOURCE_KINDS = [
  "school",
  "class",
  "child",
  "transfer",
  "observation",
] as const;
export type AccessResourceKind = (typeof ACCESS_RESOURCE_KINDS)[number];

/**
 * 授权判定使用的服务端事实（不由请求体声明）：
 * - child：幼儿**当前**归属班级；null=当前无归属；
 * - transfer：转班同时核对幼儿当前归属与目标班级；
 * - observation：发生时班级快照与作者账号 id；旧记录作者为 null=历史未知，不补造。
 *
 * 上述事实必须由服务端读取；客户端提交的 current_class_id / observed_class_id /
 * author_account_id 一律不作为授权依据。
 */
export type AccessResource =
  | { kind: "school"; school_id: string }
  | { kind: "class"; class_id: string }
  | { kind: "child"; child_id: string; current_class_id: string | null }
  | {
      kind: "transfer";
      child_id: string;
      current_class_id: string | null;
      target_class_id: string;
    }
  | {
      kind: "observation";
      observation_id: string;
      child_id: string;
      current_class_id: string | null;
      observed_class_id: string | null;
      author_account_id: string | null;
    };

/** 资源事实来源：只允许服务端读取（冻结标记，供参考检查核对） */
export const ACCESS_RESOURCE_FACTS_SOURCE = "server_read" as const;

/**
 * 每个动作的合法资源类型。**先检查组合合法性，再做角色与范围授权**：
 * - 组合非法 → 400 `invalid_request`（illegal_action_resource_combination），不进入允许分支；
 * - 管理员也不能绕过组合检查；
 * - `observation.write` 是“为幼儿创建观察”（child 资源）；
 *   已有观察的整理/追问/确认使用 observation 资源。
 */
export const ACTION_RESOURCE_KINDS: Record<AccessAction, readonly AccessResourceKind[]> = {
  "school.read": ["school"],
  "class.read": ["class"],
  "class.catalog.read": ["class"],
  "class.manage": ["class"],
  "teacher.manage": ["school"],
  "teacher.assign": ["class"],
  "child.read": ["child"],
  "child.create_profile": ["class"],
  "child.transfer": ["transfer"],
  "observation.read": ["observation"],
  "observation.write": ["child"],
  "observation.organize": ["observation"],
  "observation.confirm": ["observation"],
  "guide.decide": ["observation"],
  "growth_profile.write": ["child"],
  "activity_support.write": ["child"],
};

export const ACCESS_INVALID_COMBINATION_ERROR = "illegal_action_resource_combination" as const;

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

/**
 * 授权结论：
 * - 合法组合且通过 → allowed；
 * - 合法组合但无权限 → deny（401/403/503）；
 * - 动作/资源组合非法 → invalid_request（400），先于角色与范围判定。
 */
export type AccessDecision =
  | { allowed: true; projection: AccessProjection; via: AccessVia }
  | { allowed: false; deny: AuthDenyReason }
  | { allowed: false; invalid_request: typeof ACCESS_INVALID_COMBINATION_ERROR };

/* --------------------------------- 错误体 --------------------------------- */

export const AUTH_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "invalid_credentials",
  "forbidden_role",
  "out_of_scope",
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
 * 授权失败不得包装为空列表、无记录或依据失效。
 */
export interface AuthApiError {
  error: AuthErrorCode;
  message: string;
}

export const AUTH_ERROR_HTTP_STATUS: Record<
  AuthErrorCode,
  400 | 401 | 403 | 404 | 409 | 429 | 500 | 503
> = {
  invalid_request: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden_role: 403,
  out_of_scope: 403,
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

/** 授权拒绝原因到错误码的固定映射：拒绝原因与错误码不得两套语义 */
export const AUTH_DENY_ERROR_CODE: Record<AuthDenyReason, AuthErrorCode> = {
  unauthenticated: "unauthenticated",
  forbidden_role: "forbidden_role",
  out_of_scope: "out_of_scope",
  empty_scope: "empty_scope",
  account_disabled: "account_disabled",
  identity_unavailable: "identity_unavailable",
};

/* -------------------------------- 固定口令策略 -------------------------------- */

/**
 * 固定、可核验的密码哈希参数与格式；服务端必须使用本常量，
 * 不接受请求提供的任意成本参数（N/r/p/maxmem），也不接受明文或可逆存储。
 * 存储格式：scrypt$N$r$p$<salt_base64>$<hash_base64>（salt 与 hash 均为标准 base64）。
 *
 * 参数依据 OWASP Password Storage Cheat Sheet 的 scrypt 推荐档位：
 * N=2^15, r=8, p=3；maxmem=64MiB 必须显式给出以满足 Node scrypt 的 128*N*r 内存需求。
 * 本轮不实现哈希与校验，不做事先性能声明；正确/错误密码、独立随机盐、格式校验、
 * 耗时与并发资源检查列为 AUTH1 验收项。
 */
export const PASSWORD_HASH_ALGORITHM = "scrypt";
export const PASSWORD_HASH_FORMAT = "scrypt$<N>$<r>$<p>$<salt_base64>$<hash_base64>";
export const PASSWORD_HASH_PARAMS = {
  N: 32768,
  r: 8,
  p: 3,
  key_length: 64,
  /** 64MiB，必须显式传入 crypto scrypt 的 options.maxmem */
  maxmem: 64 * 1024 * 1024,
} as const;
export const PASSWORD_SALT_MIN_BYTES = 16;
export const PASSWORD_MIN_LENGTH = 8;

/* --------------------------------- 会话 --------------------------------- */

/** 会话固定绝对期限（登录起算）；GET 不得自动续期或写库，只可撤销 */
export const AUTH_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** GET 类请求不得续期会话或回写数据库 */
export const SESSION_RENEWAL_ON_GET = false;
/** 获取 CSRF 令牌的请求不得更新会话期限（不得借取令牌续期） */
export const CSRF_FETCH_RENEWS_SESSION = false;

export const CSRF_HEADER_NAME = "x-csrf-token";
/** CSRF 令牌与当前会话绑定：另一会话的令牌不得用于本会话业务变更 */
export const CSRF_TOKEN_BINDING = "session" as const;

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

/* --------------------------- 登录前请求保护（不依赖会话） --------------------------- */

/**
 * 登录是“登录前”接口：不能要求尚不存在的会话绑定 CSRF 令牌。
 * 可信公开源来自部署配置（`TRUSTED_ORIGIN_SOURCE`），
 * **禁止**用请求 Host / X-Forwarded-* 推导可信源。
 */
export const TRUSTED_ORIGIN_SOURCE = "deployment_config" as const;
export const AUTH_LOGIN_HEADER_NAME = "x-cga-auth-request";
export const AUTH_LOGIN_HEADER_VALUE = "1";
export const AUTH_LOGIN_CONTENT_TYPE = "application/json";

export const LOGIN_GUARD_FAILURES = [
  "origin_untrusted",
  "same_origin_proof_missing",
  "auth_request_header_missing",
  "content_type_rejected",
] as const;
export type LoginGuardFailure = (typeof LOGIN_GUARD_FAILURES)[number];

/* --------------------------- 登录后的会话 CSRF 保护 --------------------------- */

/**
 * 登录后的业务变更（非 GET/HEAD）：同源检查 + 当前有效会话 + 会话绑定 `x-csrf-token`。
 * 登录建立全新会话与新令牌，不沿用旧会话或旧令牌。
 */
export const SESSION_WRITE_PROTECTION = [
  "same_origin_check",
  "valid_session",
  "session_bound_csrf_token",
] as const;

/* ------------------------------ 旧入口与客户端清理 ------------------------------ */

/** 旧教师口令 Cookie：新会话校验一律不认可（invalid_session.legacy_cookie_not_accepted） */
export const LEGACY_AUTH_COOKIE = "cga_teacher";
/** 旧 Cookie 由服务端按其原有路径清除，不能只依赖客户端 cleanup */
export const LEGACY_COOKIE_CLEAR_PATH = "/";

/**
 * 退出语义：
 * - 有效会话：撤销当前会话并清除新旧 Cookie；
 * - 失效/缺失会话：幂等成功，仅做 Cookie 清理，不报错、不影响新账号登录；
 * - 旧 Cookie 不构成授权，也不能阻止使用新账号登录。
 */
export const LOGOUT_SEMANTICS = [
  "revoke_current_session_when_valid",
  "clear_new_and_legacy_cookies",
  "idempotent_when_session_invalid",
] as const;

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

/**
 * HTTP API 动作清单。首位管理员初始化**不是**公网接口：
 * 只有部署者执行的非公网脚本（见下方 AdminBootstrap*），因此不在此清单中。
 */
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

/* ------------------------------ 首位管理员初始化（部署者脚本） ------------------------------ */

/**
 * 首位管理员由部署者执行的非公网初始化脚本创建，不存在公开 HTTP 接口
 * （旧 `POST /api/auth/initialize-admin` 设计已撤销）。
 *
 * 冻结语义：
 * - 授权前提：只能在部署主机运行；公网/HTTP 上下文（无论是否已登录管理员）一律拒绝；
 * - 一次性：仅当系统不存在管理员时可成功；
 * - 并发：两个初始化同时进行只允许一个成功，另一个得到 `admin_already_initialized`；
 *   已存在管理员时不得覆盖账号、重置密码或再次创建；
 * - 密码：无默认值，不沿用 TEACHER_PASSCODE，不通过命令行参数或日志暴露
 *   （只允许交互式/标准输入等不回显通道）。
 */
export const ADMIN_BOOTSTRAP_CONTEXTS = [
  "deployer_non_public_script",
  "public_http",
  "authenticated_http",
] as const;
export type AdminBootstrapContext = (typeof ADMIN_BOOTSTRAP_CONTEXTS)[number];

export const ADMIN_BOOTSTRAP_PRECONDITIONS = [
  "non_public_deployer_script",
  "no_admin_exists",
  "password_not_from_argv_env_or_log",
  "single_concurrent_winner",
  "no_overwrite_or_reset",
] as const;

export const ADMIN_BOOTSTRAP_CONFLICT_CODE = "admin_already_initialized" as const;

/** 部署者初始化输入：非公网脚本专用，不是公开 HTTP DTO，不包含任何默认值 */
export interface AdminBootstrapInput {
  username: string;
  display_name: string;
  password: string;
}

export interface AdminBootstrapResult {
  principal: Principal;
}

/** 供部署者脚本查询是否已完成初始化；不是公开 HTTP DTO */
export interface AdminBootstrapStatus {
  admin_initialized: boolean;
}

/* ------------------------------ 模型等待期间的重核 ------------------------------ */

/**
 * 模型调用在事务外执行，不持有数据库锁；模型返回后、正式落库前必须重新核对：
 * 会话有效性、账号状态、动作权限、任教关系、幼儿当前归属、目标观察修订与请求归属。
 * 写入与撤销/停用/转班之间由共同事务协调，不能只依赖请求开始时的一次授权；
 * 不接受客户端 Principal 或长期缓存范围；新会话/新账号不能代替原发起者承接旧请求。
 */
export const MODEL_WAIT_RECHECK_POINTS = [
  "session_valid",
  "account_active",
  "role_and_action_permission",
  "assignment_current",
  "child_current_attribution",
  "target_observation_revision",
  "attempt_owner",
] as const;

export const MODEL_WAIT_EVENTS = [
  "none",
  "session_revoked",
  "account_disabled",
  "assignment_removed",
  "child_transferred",
  "observation_changed",
  "principal_replaced",
] as const;
export type ModelWaitEvent = (typeof MODEL_WAIT_EVENTS)[number];

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
