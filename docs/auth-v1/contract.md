# 单园所账号与授权 v1 契约（AUTH0-R1 返修候选）

- 状态：**返修候选，等待主评审**。基线：`734f572925e7c298f2226679c00e3e4e978068b2`（上一轮冻结候选，已被主评审指出启动、授权守门与首页范围问题，**不是获批实装基线**）；工作树分支 `codex/auth0-contract`（独立工作树，不整合其他分支）。
- 本轮范围：只修订契约、共享类型、纯 fixture 与参考检查；不实现真实认证、不建表/不迁移、不调用模型、不改页面。
- 冻结文件：`src/lib/accounts/types.ts`、`src/lib/home-v2/types.ts`、本文件、`docs/auth-v1/ownership.md`、`docs/auth-v1/auth0-r1-delivery.md`、`src/lib/accounts/__fixtures__/contract-fixtures.ts`、`src/lib/home-v2/__fixtures__/contract-fixtures.ts`、`scripts/check-auth-contract.ts`。
- 必守不变量：`raw_text` 不可静默改写；观察状态机与 `ai_draft`/`confirmed_content` 分离不变；G0 指南三状态、✓、目录及证据有效性规则全部不变；G0 冻结文件零修改；角色、账号状态与班级范围只来自服务端；无默认生产密码；旧 `TEACHER_PASSCODE` 不作为新账号密码。

---

## 1. 保留的产品口径

1. **单园所**，仅 `admin` / `teacher` 两种角色。
2. **管理员**：全园查看；管理班级与教师、分配任教、转班、建立成长档案基础信息；**不默认具备观察确认、指南决定等教学权限**。
3. **教师**：负责班级内建档、观察、AI 整理、归档确认、指南决定、成长小结与活动支持；可任教多个班级，同班可有多名教师。
4. **未分配班级的教师可以登录**，但没有业务访问范围。
5. 当前负责幼儿的完整历史可读；转走幼儿只能按原班历史只读投影访问；作者身份不是永久授权；旧记录作者/确认者保持未知，不回填。

## 2. 数据实体与安全口径

### 2.1 逻辑数据模型（本轮不建表、不迁移）

| 实体 | 关键字段（逻辑） | 约束 |
|---|---|---|
| `app_accounts` | id、username（规范化后唯一）、display_name、password_hash、role、status、created_at、updated_at、password_changed_at、disabled_at | role ∈ admin/teacher；status ∈ active/disabled；停用不做物理删除 |
| `app_sessions` | id、account_id、token_hash（唯一）、created_at、expires_at、revoked_at、revoked_reason | 数据库只存令牌哈希；固定绝对期限；可撤销 |
| `teacher_class_assignments` | id、account_id、class_id、assigned_at、assigned_by_account_id、removed_at、removed_by_account_id | `(account_id, class_id) WHERE removed_at IS NULL` 唯一；撤销只写 removed_at，不删除历史 |

**任教关系与 `child_class_enrollments` 是不同关系**：分配/撤销教师任教不得改变幼儿归属、观察发生时快照或任何历史记录；转班仍按 G2 执行。

### 2.2 密码存储契约（R1 修正）

- 异步 **scrypt + 随机盐**（每账号独立随机盐，至少 **16 字节**）。
- 固定参数：**`N=32768, r=8, p=3, key_length=64`**，**`maxmem=64MiB` 必须显式传入**（满足 Node scrypt 的 128·N·r 内存需求；依据 OWASP Password Storage Cheat Sheet 推荐档位与 Node crypto 文档）。
- 固定格式：`scrypt$<N>$<r>$<p>$<salt_base64>$<hash_base64>`。
- 服务端只接受该固定格式与参数；**不接受请求提供的任意成本参数**，不落明文、不做可逆存储，校验恒时比较。
- **用户名规范化与密码处理分开**：用户名“去两端空白 → NFKC → 小写”后判唯一；**密码不 trim、不做 Unicode 规范化**，原样参与哈希。
- **无默认生产密码**；旧 `TEACHER_PASSCODE` 不得作为任何新账号密码。
- 正确/错误密码校验、独立随机盐、格式校验、耗时与并发资源检查列为 **AUTH1 验收项**；本轮只冻结参数，不运行真实哈希、不做性能声明。

### 2.3 会话契约

- 登录取**随机会话令牌**（至少 32 字节熵）；数据库只存 SHA-256 哈希。
- Cookie 名 `cga_session`；`HttpOnly; SameSite=Lax; Path=/`；HTTPS 下 `Secure`。
- 固定绝对期限 `AUTH_SESSION_TTL_SECONDS = 7 天`（自登录起算）；`SESSION_RENEWAL_ON_GET = false`，`CSRF_FETCH_RENEWS_SESSION = false`：**GET 不续期、不写数据库；借获取 CSRF 令牌也不得更新会期**。
- 令牌只存在于 HttpOnly Cookie 与数据库哈希中；任何 JSON DTO 不返回会话令牌。
- **登录建立全新会话与新 CSRF 令牌**，不沿用旧会话/旧令牌。

### 2.4 登录前请求保护（R1 新增，与登录后分离）

`POST /api/auth/login` 是登录前接口，**不要求尚不存在的会话绑定 CSRF 令牌**：

1. 严格验证可信公开源的 `Origin`；**可信源只来自部署配置**（`TRUSTED_ORIGIN_SOURCE = "deployment_config"`），**禁止**用请求 `Host` / `X-Forwarded-*` 推导可信源。
2. 只接受 `Content-Type: application/json`。
3. 要求固定自定义请求头 `x-cga-auth-request: 1`（`AUTH_LOGIN_HEADER_NAME/VALUE`）。
4. 不开放跨域凭证访问；未登录状态不允许任何业务写操作。
5. 跨源、`Origin=null`、缺少同源证明、缺少自定义头、普通表单（form-urlencoded 等）一律拒绝，拒绝原因固定为 `LOGIN_GUARD_FAILURES`：`origin_untrusted` / `same_origin_proof_missing` / `auth_request_header_missing` / `content_type_rejected`。
6. 登录失败统一 `invalid_credentials`（401），不泄露账号是否存在；按“规范化用户名 + IP”基础限流（`rate_limited` 429）。
7. 不新增预登录会话表、通用 CSRF 框架或新依赖。

### 2.5 登录后业务变更保护

非 GET/HEAD 的业务变更必须同时满足（`SESSION_WRITE_PROTECTION`）：

1. 同源检查；
2. 当前**有效会话**；
3. 会话绑定 `x-csrf-token`（`CSRF_TOKEN_BINDING = "session"`）：另一会话的令牌不能用于当前会话，缺失/不匹配一律 `csrf_rejected`（403）。令牌随登录建立、随会话撤销失效；获取令牌的请求不得续期。

### 2.6 退出与新旧 Cookie 共存（R1 新增）

- **有效会话退出**：撤销当前会话并清除新旧 Cookie；
- **失效/缺失会话退出**：幂等成功（200），只做 Cookie 清理，不报错；
- **旧 `cga_teacher` 不构成授权，也不能阻止使用新账号重新登录**；
- 新旧 Cookie 并存时，新会话按自身有效性校验，旧 Cookie 不提升权限；
- **服务端按旧 Cookie 原有路径（`/`）清除**（`LEGACY_COOKIE_CLEAR_PATH`），不能只依赖客户端 `cleanup`。

### 2.7 停用、重置与失效策略

| 事件 | 会话处理 | 历史数据 |
|---|---|---|
| 退出登录 | 撤销当前会话（有效时） | 不受影响 |
| 停用账号 | **撤销该账号全部会话** | 历史观察不失效；作者显示保持历史事实 |
| 重置密码 | **撤销该账号全部会话** | 不受影响 |
| 会话过期/撤销 | 401，前端清理私有状态 | 不受影响 |
| 最后一个管理员 | 禁止停用（`last_admin_protected` 409） | 不受影响 |

## 3. 首位管理员初始化（R1 修正：撤销公开接口）

- 首位管理员由**部署者执行的非公网初始化脚本**创建。**公开 `POST /api/auth/initialize-admin` 设计已撤销**；`AUTH_API_ACTIONS` 不包含初始化动作。
- 冻结脚本语义：
  1. 授权前提：只能在部署主机运行；公网/HTTP 上下文（无论是否已登录）一律拒绝（`ADMIN_BOOTSTRAP_CONTEXTS`：`deployer_non_public_script` / `public_http` / `authenticated_http`）；
  2. 一次性：仅当系统不存在管理员时可成功；
  3. **并发**：两个初始化同时进行只允许一个成功，另一个得到 `admin_already_initialized`；**已存在管理员时不得覆盖账号、重置密码或再次创建**；
  4. 密码无默认值，不沿用 `TEACHER_PASSCODE`，**不通过命令行参数或日志暴露**（交互式/标准输入等不回显通道）；
  5. 任一步失败回滚，不产生半成品管理员。
- `AdminBootstrapInput/Result/Status` 是**部署者脚本专用类型，不是公开 HTTP DTO**；本轮不编写、不执行脚本。

## 4. 资源授权矩阵（R1 修正：先组合后授权）

### 4.1 范围与主体责任

- 角色、账号状态、班级范围全部来自服务端会话解析；`DataScope` 三形态：`school` / `classes`（空数组=明确为空）/ `none`。空数组绝不等于全园。
- 身份/权限服务不可用时 `AuthState.unavailable`，fail closed（503）。
- **资源事实（current_class_id、observed_class_id、author_account_id 等）必须由服务端读取**（`ACCESS_RESOURCE_FACTS_SOURCE = "server_read"`），客户端声明不作授权依据。

### 4.2 动作与合法资源（`ACTION_RESOURCE_KINDS`）

| 动作 | 合法资源 | 说明 |
|---|---|---|
| `school.read` / `teacher.manage` | school | 管理员全园 |
| `class.read` / `class.catalog.read` / `class.manage` / `teacher.assign` | class | 目录只给基础信息，与名单/统计分开 |
| `child.read` / `growth_profile.write` / `activity_support.write` | child | 以幼儿当前归属授权 |
| `child.create_profile` | class | **建档核对目标班级** |
| `child.transfer` | transfer | **转班核对幼儿当前归属与目标班级** |
| `observation.read` | observation | 当前负责完整历史；原班历史只读 |
| `observation.write` | child | **为幼儿创建观察**（不是已有观察） |
| `observation.organize` / `observation.confirm` / `guide.decide` | observation | **整理/追问/确认已有观察**；指南决定核对宿主观察 |

规则：

1. **先检查动作/资源组合是否合法**，再进行角色与范围授权；非法组合返回 **400 `invalid_request`**（`illegal_action_resource_combination`），不进入允许分支。
2. **管理员也不能绕过组合检查**（管理员 + `observation.confirm` + class → 400，而不是 403）。
3. 合法组合下的角色矩阵：管理员可全园管理动作，教学动作一律 403 `forbidden_role`；教师按当前任教关系与幼儿当前归属判定。

### 4.3 转班历史与只读投影

- 当前负责幼儿的完整历史可读**且可操作**（整理/确认/指南决定按幼儿当前归属）；
- 原班教师对转走幼儿的历史观察仅 `historical_read_only` 可读：不得获得整份档案（`child.read` 仍 403 `out_of_scope`），且**不可操作**（`observation.organize/confirm/guide.decide` 均 `out_of_scope`）；
- 历史只读投影不默认携带跨班证据详情；
- 停用账号不使历史观察失效；作者不是永久授权；
- 班级停用、历史资料保护遵守 G2（业务 409，管理员不能绕过）。

### 4.4 无权限的表达

- 无权限必须显式授权错误（401/403/503），不得伪装成“无记录/来源失效/空列表”；**错误 ≠ 空数据**。
- 空班级范围教师业务访问 403 `empty_scope`（可登录），不等于全园。

## 5. 错误语义（R1 修正：补齐授权错误码）

| HTTP | `AuthErrorCode` | 条件 |
|---|---|---|
| 400 | `invalid_request` | 结构非法；**动作/资源组合非法** |
| 401 | `unauthenticated` | 未登录、未知令牌、过期、撤销、旧 Cookie |
| 401 | `invalid_credentials` | 登录失败（不区分账号是否存在） |
| 403 | **`forbidden_role`** | 角色不允许（含管理员教学动作、教师管理动作） |
| 403 | **`out_of_scope`** | 班级/幼儿不在当前任教范围，或历史只读被要求操作 |
| 403 | `account_disabled` / `empty_scope` / `csrf_rejected` | 停用 / 空范围 / 同源或 CSRF 失败 |
| 404 | `not_found` | 目标不存在（仅在有权限前提下判定） |
| 409 | `username_taken` / `last_admin_protected` / `state_conflict` | 账号与业务冲突（含 `admin_already_initialized` 的语义码） |
| 429 | `rate_limited` | 登录限流 |
| 500 | `server_error` | 其他服务端错误 |
| 503 | `identity_unavailable` | 身份/权限服务不可用，fail closed |

- `AUTH_DENY_ERROR_CODE` 固定映射拒绝原因 → 错误码，HTTP 状态必须一致；`forbidden_role` / `out_of_scope` 均为 403。
- 授权失败不包装为空列表、无记录或依据失效；**409 业务冲突不吞掉**。

## 6. 模型等待期间的重核（R1 新增，AUTH1/AUTH2 必需行为）

- 模型调用在**事务外**执行，不持有数据库锁；
- 模型返回后、正式落库前必须重新核对（`MODEL_WAIT_RECHECK_POINTS`）：`session_valid`、`account_active`、`role_and_action_permission`、`assignment_current`、`child_current_attribution`、`target_observation_revision`、`attempt_owner`；
- 写入与撤销/停用/转班之间需要**共同事务协调**，不能只依赖请求开始时的一次授权；
- 不接受客户端 `Principal` 或长期缓存范围作为最终授权；
- **新会话/新账号不能代替原发起者承接旧请求**（`principal_replaced` → 409 冲突，零写入）；
- 参考事件（`MODEL_WAIT_EVENTS`）：`none / session_revoked / account_disabled / assignment_removed / child_transferred / observation_changed / principal_replaced`。
- 本轮只提供参考时序与 fixture；真实事务、双连接交错与零写入验证留给实现轮（**不伪称已证明**）。

## 7. 冻结接口与类型

### 7.1 `src/lib/accounts/types.ts`

| 类型/常量 | 用途 |
|---|---|
| `Principal`、`AuthState`、`DataScope` | 服务端身份与范围三形态 |
| `AccessAction`、`ACTION_RESOURCE_KINDS`、`AccessDecision` | 动作、合法资源组合与授权结论（含 400 组合非法） |
| `AuthApiError`、`AUTH_ERROR_HTTP_STATUS`、`AUTH_DENY_ERROR_CODE` | 错误体与拒绝原因映射 |
| `LoginRequest/Response`、`LogoutResponse`、`AuthStatusResponse` | 登录/状态/退出（含 `cleanup`） |
| `LOGIN_GUARD_FAILURES`、`SESSION_WRITE_PROTECTION`、`CSRF_TOKEN_BINDING` | 登录前/登录后分层保护 |
| `LEGACY_AUTH_COOKIE`、`LEGACY_COOKIE_CLEAR_PATH`、`LOGOUT_SEMANTICS` | 旧 Cookie 服务端清理与退出语义 |
| `ADMIN_BOOTSTRAP_*`、`AdminBootstrapInput/Result/Status` | 部署者脚本初始化（非公开 HTTP DTO） |
| `MODEL_WAIT_RECHECK_POINTS`、`MODEL_WAIT_EVENTS` | 模型等待重核清单 |
| 教师管理 DTO、`SessionView/SessionStatusView/CsrfTokenView` | 账号管理与会话状态（不含令牌） |
| `PASSWORD_HASH_*`、`PASSWORD_SALT_MIN_BYTES` | 固定 scrypt 参数、maxmem、盐长度 |

### 7.2 接口契约（R1 更新）

| 动作 | 接口 | 说明 |
|---|---|---|
| `auth.login` | `POST /api/auth/login` | 登录前保护（Origin + 自定义头 + JSON）；`{ username, password }` |
| `auth.status` | `GET /api/auth/status` | `SessionStatusView`；GET 不续期 |
| `auth.logout` | `POST /api/auth/logout` | 有效撤销 / 失效幂等；清理新旧 Cookie |
| `admin.teachers.list/create/set_status` | `/api/admin/teachers...` | 教师列表/创建/启停（停用撤销会话） |
| `admin.assignments.assign/remove` | `/api/admin/teachers/[id]/assignments...` | 分配/撤销任教 |
| `admin.password.reset` | `/api/admin/teachers/[id]/password-reset` | 重置并撤销全部会话 |
| ~~`admin.initialize`~~ | **已撤销** | 改为部署者非公网脚本 |

### 7.3 首页 v2 契约（R1 修正）

- `HomeViewer` 四态由服务端判定；未登录文案统一为“**园所账号登录**”。
- `HomeScopeSummary.class_count/child_count` 与 `HomeClassSummary` 各计数、`HomePendingCounts` 均区分 `null=未获取（读取失败）` 与 `0=真实零值`。
- 班级计数分开：`confirmation_count`（待确认）/ `supplement_count`（待补充）/ `organize_count`（待整理），**不可混用**。
- `pending` 仅包含**当前具有教学操作权限**的记录；转走幼儿的历史只读记录不进入待办与计数，历史只读入口留在班级历史页面；当前负责幼儿的转入前历史可展示且保留发生时班级。
- 管理员没有教学权限，`pending` 为空、待办计数为 0（全园观察仍在班级页只读浏览）。
- 主行动单一且固定优先级：**待确认 → 待补充 → 待整理 → 建档 / 新记录**；未分配班级只提供等待分配，不提供建班捷径；已分配无幼儿时提供建档入口。
- `data_unavailable` 与 `empty_*` 语义分开；不得把读取失败显示为普通 0 或空数据。

## 8. 旧入口切换与增量接口改造（本轮只列清单）

1. **G5 GET 从公开变受限**：`GET /api/children/[id]/evidence-book` 按 `child.read`（当前负责整份；原班只读不整本）；`GET /api/classes/[id]/evidence-overview` 按 `class.read` + 名单/统计。指南三状态/✓/目录/证据规则不变；G0/G5 冻结文件不改。
2. 现有公开 GET（children / observations / classes / classes/[id] / class-context）按范围裁剪，无权限 401/403 不伪装空数组。
3. 现有写接口角色修正：转班=admin `child.transfer`；班级创建/修改=admin `class.manage`；创建观察=`observation.write`（child 资源）；整理/追问=`observation.organize`、确认=`observation.confirm`（observation 资源）；指南决定=`guide.decide`；成长小结/活动支持按幼儿。
4. 认证入口替换：登录前/登录后保护分层；旧 Cookie 不认可且由服务端按原路径清理；登录/退出响应携带 `cleanup`；客户端清理 `legacy_teacher_provider / home_v2_payload / private_query_cache`。
5. 错误映射：旧 `teacher_auth_disabled` 退役；授权统一 401/403/503；组合非法 400；业务保持 409。

## 9. 审计元数据增量接入方案（不变）

阶段 A 建账号/会话/任教表；阶段 B `observations.created_by_account_id / confirmed_by_account_id`（可空，旧记录 NULL=历史未知，永不回填）；阶段 C 指南决定旁路审计表（不改 G0 冻结形状）；阶段 D 会话 `revoked_reason` 等。`teacher_note` 不是决定者审计；当前账号不得作旧记录兜底。

## 10. 参考反例与规则映射

| # | 反例 | 规则 | Fixture / 检查 |
|---|---|---|---|
| 1 | 无管理员但非部署者请求初始化 | 只有部署者脚本可初始化；公开 HTTP 一律拒绝 | `public-http-no-admin-rejected`、`FIXTURE_BOOTSTRAP_CASES` |
| 2 | 已有管理员再次初始化 / 并发双发 | 已有管理员拒绝；并发唯一成功 | `deployer-admin-exists-rejected`、`FIXTURE_BOOTSTRAP_CONCURRENT` |
| 3 | 无会话用户登录依赖会话 CSRF | 登录前不要求会话 CSRF；合规请求可过 | `valid-pre-login-without-session` |
| 4 | 跨源 / 普通表单 / 缺自定义头 / Origin=null / Host 伪造 | `LOGIN_GUARD_FAILURES` 拒绝；Host 不参与可信源 | `FIXTURE_LOGIN_GUARD_CASES` |
| 5 | 另一会话 CSRF 令牌 | 会话绑定，`csrf_rejected` | `other-session-token-rejected` |
| 6 | 旧 Cookie 授权或阻断登录 | 不授权、不阻断；服务端按原路径清除 | `FIXTURE_COOKIE_COEXISTENCE_CASES`、`FIXTURE_LEGACY_COOKIE_CLEAR` |
| 7 | 教师/管理员非法动作+资源组合 | 400 `invalid_request`，先于角色与范围 | `invalid-combo-*` 反例（含管理员确认+class） |
| 8 | 合法创建观察 / 已有观察确认 | `observation.write`+child、`observation.confirm`+observation 允许 | `teacher-a-write-observation-for-current-child` 等 |
| 9 | 授权错误码缺失 | `forbidden_role`/`out_of_scope` 存在于错误码与 403 映射 | `AUTH_DENY_ERROR_CODE` 检查 |
| 10 | 密码参数过时/被请求控制 | N=32768, r=8, p=3, maxmem=64MiB，密码不 trim | 密码契约检查 |
| 11 | 模型等待期间撤权/停用/转班 | 返回后重核，拒绝旧请求保存；修订/归属变化 409 零写入 | `FIXTURE_MODEL_WAIT_CASES` |
| 12 | 当前负责幼儿的转入前历史被排除 | 不因发生班级排除，按当前归属可读可操作 | `current-responsible-reads-prior-class-history`、教师 B 首页 |
| 13 | 转走幼儿历史进入可操作待办 | 历史只读排除在待办与计数外 | 教师 A 首页候选过滤 |
| 14 | 无分配/无幼儿/无观察/读取失败混为 0 | 四种语义分离，null=未获取 | 首页四态 fixture |
| 15 | 多个主行动并列或优先级错乱 | 单一主行动固定优先级 | `FIXTURE_PRIMARY_ACTION_CASES` |
| — | 保留的旧反例 | 未登录/未知身份/撤权/作者≠授权/停用历史/错误≠空/空范围≠全园/管理员教学拒绝/G2 409 | 原 fixture 集合 |

## 11. Fixture 与最小检查

- Fixture（纯数据）：`src/lib/accounts/__fixtures__/contract-fixtures.ts`（授权、登录保护、CSRF、退出、初始化、模型等待、密码、接口 DTO）；`src/lib/home-v2/__fixtures__/contract-fixtures.ts`（首页各状态、可操作待办候选、主行动用例）。
- 检查：`pnpm exec tsx scripts/check-auth-contract.ts`（离线，只读 fixture，输出 `reference_only: true`）。
  - 参考算法忠实于本契约；**不能替代真实认证、真实数据库、事务交错与浏览器验收**。
  - 当前输出：`{ passed: 33, total: 33, reference_only: true }`。

## 12. 验收与已知限制

本轮离线验收：`pnpm exec tsx scripts/check-auth-contract.ts`、`pnpm ts-check`、`pnpm lint:build` 全部通过。

`NOT_RUN`（明确未执行，不得当作通过）：

- 真实账号认证、scrypt 校验与性能、Cookie/CSRF 行为：`NOT_RUN`（不实现认证）；
- 建表/迁移/实库读写、真实事务与双连接交错：`NOT_RUN`（未连接任何数据库）；
- 模型调用：`NOT_RUN`；
- 浏览器/UI、部署、环境变量变更：未执行且禁止。

## 13. 仓库事实记录

- 基线 `b02e4a1` / `734f572` 均不存在 `RTK.md`（已核实）；不补造、不安装。
- 基线尚无 G5 的 `evidence-book` / `evidence-overview` 路由；第 8 节按增量契约列出，不在本轮实现。
