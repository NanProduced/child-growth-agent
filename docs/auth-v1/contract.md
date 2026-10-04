# 单园所账号与授权 v1 契约（AUTH0，冻结）

- 状态：**已冻结**。基线：`b02e4a1284ac9423d5bffd3ab9436db12aeccf23`（`codex/guide-evidence-integration`，G0-G4 候选整合后验收提交）；工作树分支 `codex/auth0-contract`（独立工作树，不整合其他分支）。
- 范围：契约、共享类型、纯 fixture 与最小参考检查。
- 非目标（本轮不做）：认证实现、建表/迁移执行、模型调用、页面与 UI、部署、生产环境变量变更、注册/短信/家长端/多园所/自定义角色/审批流。
- 冻结文件：`src/lib/accounts/types.ts`、`src/lib/home-v2/types.ts`、本文件、`docs/auth-v1/ownership.md`、`src/lib/accounts/__fixtures__/contract-fixtures.ts`、`src/lib/home-v2/__fixtures__/contract-fixtures.ts`、`scripts/check-auth-contract.ts`。
  并行期间任何模块不得自行修改冻结类型；需要变更时由契约负责人统一处理。
- 必守不变量：`raw_text` 不可静默改写；`ai_draft` 与 `confirmed_content` 分离；指南三状态（暂无相关记录 / 已有相关线索 / 已确认观察到）、✓ 展示、目录数据与证据有效性规则全部保持 G0/G1-G5 不变；G0 冻结文件本轮零修改；角色、账号状态与班级范围只来自服务端；无默认生产密码；旧 `TEACHER_PASSCODE` 不作为新账号密码。

---

## 1. 已确认的产品口径

1. **单园所**，两种持久化角色：`admin`（管理员）与 `teacher`（教师）。
2. **管理员**：全园查看；管理班级、教师、任教分配与转班；可建立成长档案基础信息；**不默认具备教学确认权限**。
3. **教师**：负责班级内建档、观察、AI 整理、归档确认、指南决定、成长小结与活动支持。
4. 教师可任教**多个班级**；同一班级可有**多名教师**协作。
5. **未分配班级的教师可以登录**，但不能访问任何业务对象（幼儿、观察、档案、统计）。
6. 不做注册、短信、家长端、多园所、自定义角色或审批流。

## 2. 数据实体与安全口径

### 2.1 逻辑数据模型（本轮不建表、不迁移）

| 实体 | 关键字段（逻辑） | 约束 |
|---|---|---|
| `app_accounts` | id、username（规范化后唯一）、display_name、password_hash、role、status、created_at、updated_at、password_changed_at、disabled_at | role ∈ admin/teacher；status ∈ active/disabled；停用不做物理删除 |
| `app_sessions` | id、account_id、token_hash（唯一）、created_at、expires_at、revoked_at、revoked_reason | 数据库只存令牌哈希；固定绝对期限；可撤销 |
| `teacher_class_assignments` | id、account_id、class_id、assigned_at、assigned_by_account_id、removed_at、removed_by_account_id | `(account_id, class_id) WHERE removed_at IS NULL` 唯一；撤销只写 removed_at，不删除历史 |

**任教关系与 `child_class_enrollments` 是不同关系**：分配/撤销教师任教**不得改变幼儿归属、观察发生时快照或任何历史记录**；转班仍按 G2 的 `child_class_enrollments` + 快照规则执行。

### 2.2 密码存储契约

- 算法：异步 **scrypt + 随机盐**（每账号独立随机盐，至少 16 字节）。
- 固定参数：`N=16384, r=8, p=1, key_length=64`（`PASSWORD_HASH_PARAMS`）。
- 固定格式：`scrypt$<N>$<r>$<p>$<salt_base64>$<hash_base64>`（`PASSWORD_HASH_FORMAT`）。
- 服务端只接受该固定格式与参数；**不接受请求提供的任意成本参数**，不做明文或可逆存储，校验用恒时比较。
- **用户名规范化与密码处理分开**：用户名按“去两端空白 → NFKC → 小写”规范化后判唯一；**密码不得随意 trim 或规范化**。
- **无默认生产密码**；初始管理员初始化只在系统尚无管理员时一次性可用；旧 `TEACHER_PASSCODE` 仅用于旧入口过渡，不得当作任何新账号密码。
- 重置密码与停用必须导致该账号全部现有会话失效（见 2.5）。

### 2.3 会话契约

- 登录成功签发**随机会话令牌**（至少 32 字节熵）；数据库只保存其 SHA-256 哈希。
- Cookie 名 `cga_session`；属性 `HttpOnly; SameSite=Lax; Path=/`；HTTPS 下 `Secure`。
- **固定绝对期限** `AUTH_SESSION_TTL_SECONDS = 7 天`（自登录起算）；**GET 请求不得自动续期、不得回写数据库**（不滚动续期）。
- 令牌只存在于 HttpOnly Cookie 与数据库哈希中；**任何 JSON DTO（含首页 DTO、状态 DTO）不得返回会话令牌**。
- 旧 Cookie `cga_teacher` 一律不认可：命中即 `invalid_session.legacy_cookie_not_accepted`（401 语义），不得回退为匿名或教师。

### 2.4 同源 / CSRF / 限流

- 所有变更请求（非 GET/HEAD）必须通过**同源校验**（`Origin` / `Sec-Fetch-Site`）并携带 `x-csrf-token`（与当前会话绑定），否则 `csrf_rejected`（403）。GET 不做写操作。
- 登录失败按“规范化用户名 + IP”做基础限流（固定窗口，超限 `rate_limited` 429）；失败响应统一 `invalid_credentials`，不泄露用户名是否存在。
- 认证日志不记录密码、令牌或完整连接串。

### 2.5 停用、重置与失效策略

| 事件 | 会话处理 | 历史数据 |
|---|---|---|
| 退出登录 | 撤销当前会话 | 不受影响 |
| 停用账号 | **撤销该账号全部会话** | 历史观察不失效；作者显示保持历史事实 |
| 重置密码 | **撤销该账号全部会话** | 不受影响 |
| 会话过期/撤销 | 401，前端清理私有状态 | 不受影响 |
| 最后一个管理员 | 禁止停用/降级（`last_admin_protected` 409） | 不受影响 |

## 3. 资源授权矩阵

### 3.1 范围与主体责任

- **角色、账号状态、班级范围全部来自服务端会话解析**，不是前端标签，也不是可缓存七天不更新的权限快照。
- `DataScope` 三形态严格区分：`school`（管理员全园）/ `classes`（教师任教班级，**空数组=明确为空**）/ `none`（无业务范围）。空数组绝不等于全园。
- 身份/权限服务不可用时 `AuthState.unavailable`，**fail closed**（503），不得默认全园、不得降级为匿名。

### 3.2 动作矩阵（`AccessAction`）

| 动作 | admin | teacher |
|---|---|---|
| `school.read` | ✅ 全园 | ❌ `forbidden_role` |
| `class.read`（含成员/统计） | ✅ 全园 | 仅当前任教班级 |
| `class.catalog.read`（仅班级基础目录） | ✅ | ✅ 基础目录（与成员/统计权限分开，不构成 `class.read`） |
| `class.manage`（创建/改名/停用/学段学年） | ✅，G2 保护不绕过 | ❌ `forbidden_role` |
| `teacher.manage`（列表/创建/启停/重置密码） | ✅ | ❌ |
| `teacher.assign`（分配/撤销任教） | ✅ | ❌ |
| `child.read`（整份档案） | ✅ 全园 | 仅**当前负责**幼儿（完整历史可读） |
| `child.create_profile`（基础信息） | ✅ | 任教班级内 |
| `child.transfer`（分班/转班） | ✅ | ❌ |
| `observation.read` | ✅ 全园 | 当前负责幼儿完整历史；原班仅历史只读投影 |
| `observation.write` / `observation.confirm` | ❌ `forbidden_role` | 任教班级内当前负责幼儿 |
| `guide.decide` | ❌ `forbidden_role` | 同上（AI 建议核对与手动关联同为教学决定） |
| `growth_profile.write` / `activity_support.write` | ❌ `forbidden_role` | 同上 |

管理员执行教学动作一律 **403 `forbidden_role`**，不伪装成教师、不代签确认。

### 3.3 转班历史与只读投影

- **当前负责幼儿的完整历史可读**：只要幼儿当前归属在教师范围内，其全部历史观察（含转入前班级）可读，不按当前班级裁掉历史。
- **原班历史观察可只读**：幼儿转走后，原班教师对“当时发生在本班”的历史观察可读，但投影为 `historical_read_only`：
  - 不因此获得该幼儿的整份档案（`child.read` 仍拒绝，`out_of_scope`）；
  - 历史只读投影**不默认携带无权查看的跨班证据详情**（转走后的观察、指南证据链依据、成长小结、活动支持等）。
- **历史补录需要的班级基础目录与成员/统计权限分开**：`class.catalog.read` 只给名称/学段/学年/启停；名单、人数与统计仍要求当前任教关系或管理员。
- **作者不是永久访问授权**：记录作者身份不构成读取或写入授权；任教关系撤销后，作者本人同样按当前范围判定。
- **停用账号不使历史观察失效**：历史观察对当前有权者照常可读；停用只影响该账号的登录与新操作。
- 班级停用、历史资料保护遵守 G2：管理员 `class.manage` 在授权层通过，但有分班/观察历史的班级改学段/学年等仍由业务规则以 **409** 拦截，管理员不能绕过。

### 3.4 无权限的表达

- 无权限必须是**显式授权错误**（401/403/503），不得伪装成“无记录”“来源失效”或空列表。
- 明确区分：**错误 ≠ 空数据**。有权查看的空范围（如空班、无观察）是正常空状态；无权限是拒绝。
- 空班级范围的教师业务访问返回 403 `empty_scope`（可登录），不等于全园。

## 4. 错误语义

| HTTP | `AuthErrorCode` | 条件 |
|---|---|---|
| 400 | `invalid_request` | 结构/格式非法 |
| 401 | `unauthenticated` | 未登录、未知令牌、过期、撤销、旧 Cookie |
| 401 | `invalid_credentials` | 登录用户名或密码错误（不区分） |
| 403 | `forbidden` / `forbidden_role` | 角色不允许（含管理员教学动作） |
| 403 | `account_disabled` | 账号已停用 |
| 403 | `empty_scope` | 教师无任何任教班级 |
| 403 | `csrf_rejected` | 同源/CSRF 校验失败 |
| 404 | `not_found` | 目标不存在（仅在有权限的前提下判定） |
| 409 | `username_taken` / `last_admin_protected` / `state_conflict` | 账号与业务冲突 |
| 429 | `rate_limited` | 登录限流 |
| 500 | `server_error` | 其他服务端错误 |
| 503 | `identity_unavailable` | 身份/权限服务不可用，fail closed |

- `AuthDenyReason → HTTP`：`unauthenticated→401`；`forbidden_role/out_of_scope/empty_scope/account_disabled→403`；`identity_unavailable→503`。
- **409 等业务冲突仍归原业务规则**（班级同名、重复分班、班级历史保护、指南 `state_conflict` 等），不混入授权错误码。

## 5. 冻结接口与类型

### 5.1 `src/lib/accounts/types.ts`

| 类型 | 用途 |
|---|---|
| `Principal` | 服务端操作者：账号 id、规范化用户名、显示名、角色、状态、`DataScope` |
| `AuthState` | `authenticated / anonymous / invalid_session / unavailable`；身份不可用单独表达 |
| `DataScope` | `school / classes（含空数组）/ none`；空数组 ≠ 全园 |
| `AccessAction` / `AccessDecision` | 固定访问动作与授权结果（`via`、`projection`、`deny`） |
| `AuthApiError` | 稳定错误体 `{ error, message }` + HTTP 映射 |
| `SessionView` / `SessionStatusView` / `CsrfTokenView` | 会话状态 DTO（不含令牌） |
| `TeacherAccountSummary` 等教师管理 DTO | 列表/创建/启停/分配/重置请求与响应，响应不含密码 |
| `LoginRequest/Response`、`LogoutResponse`、`AuthStatusResponse` | 登录、状态、退出；响应携带 `cleanup` 私有状态清理清单 |
| `PASSWORD_HASH_*`、`AUTH_SESSION_TTL_SECONDS`、`LEGACY_AUTH_COOKIE` | 固定哈希参数/格式、固定会期、旧 Cookie 名 |
| `AccountRef` / `ObservationAuthorshipView` | 审计人员引用；旧记录作者/确认者为 null=历史未知 |

### 5.2 接口契约

| 动作 | 接口（建议路径） | 说明 |
|---|---|---|
| `auth.login` | `POST /api/auth/login` | `{ username, password }` → `LoginResponse`（含 `cleanup`）；旧 `{passcode}` 入口退役 |
| `auth.status` | `GET /api/auth/status` | 返回 `SessionStatusView`；取代旧 `{ configured, isTeacher }` 形状 |
| `auth.logout` | `POST /api/auth/logout` | 撤销当前会话 + 清理指令 |
| `admin.initialize` | `POST /api/auth/initialize-admin` | 仅系统无管理员时可用，一次性 |
| `admin.teachers.list` | `GET /api/admin/teachers` | 列表（含 `class_ids`，空数组显式为空） |
| `admin.teachers.create` | `POST /api/admin/teachers` | 创建教师 + 可选分配 |
| `admin.teachers.set_status` | `PATCH /api/admin/teachers/[id]` | 启停；停用撤销全部会话 |
| `admin.assignments.assign` | `POST /api/admin/teachers/[id]/assignments` | 分配班级 |
| `admin.assignments.remove` | `DELETE /api/admin/teachers/[id]/assignments/[classId]` | 撤销（保留历史，只写 removed_at） |
| `admin.password.reset` | `POST /api/admin/teachers/[id]/password-reset` | 重置并撤销全部会话 |

### 5.3 `src/lib/home-v2/types.ts`

- `HomeViewer`：`logged_out / teacher / admin / identity_unavailable`，由服务端判定。
- `HomeScopeSummary`：`school / classes / none` + 范围班级数/幼儿数；未登录或不可用为 null。
- `HomeStageClassGroup` + `HomeClassSummary`：按小班→中班→大班分组，仅包含可见班级。
- `HomePrimaryAction`：固定 `code` 列表（login、process_confirmations、supplement_observation、create_class、create_profile、start_observation、await_class_assignment、manage_school、retry）。
- `HomeObservationSummary`：待处理与最近观察摘要；`child_name=null` 表示无权/不可用，`excerpt` 而非 `raw_text`。
- **DTO 不包含密码、密码哈希、会话令牌、CSRF 令牌，也不包含“全园数据供前端过滤”**：范围裁剪必须在服务端完成。

## 6. 旧入口切换与增量接口改造（本轮只列清单，不改代码）

1. **G5 GET 从公开变受限（增量授权契约）**：
   - `GET /api/children/[id]/evidence-book`：按 `child.read` 整份档案授权——管理员全园；教师仅**当前负责**幼儿。原班历史只读投影不得整本返回。
   - `GET /api/classes/[id]/evidence-overview`：按 `class.read` + 成员/统计授权——管理员或该班当前任教教师；其他教师 403 `out_of_scope`，不得以空名单代替拒绝。
   - 指南三状态、✓、目录、证据有效性规则**保持不变**；G0/G5 冻结文件不改，由 G5 实现方在后续增量中接入本契约的授权结果。
2. **现有公开 GET 收紧**（同一实现轮）：`GET /api/children`、`GET /api/observations`、`GET /api/classes`、`GET /api/classes/[id]`、`GET /api/children/[id]/class-context` 全部按范围裁剪；无权限返回 401/403，不返回空数组伪装。
3. **现有写接口的角色修正**：`POST /api/classes/[id]/children`（分班/转班）由“教师口令”改为 **admin `child.transfer`**；班级创建/修改改为 admin `class.manage`；观察与 AI、确认、成长小结、活动支持改为 `observation.write/confirm`、`growth_profile.write`、`activity_support.write`（教师当前负责幼儿）。
4. **认证入口替换**：`/api/auth/login`、`/api/auth/status`、`/api/auth/logout` 切换到 5.2 契约；旧 `cga_teacher` Cookie 不认可；登录/退出响应携带 `cleanup` 清单，客户端清理 `legacy_teacher_provider`、`home_v2_payload`、`private_query_cache` 后再渲染私有数据。
5. **错误映射增量**：现有 `teacher_auth_disabled` 503 文案退役；统一为 401 `unauthenticated` / 403 `forbidden` / 503 `identity_unavailable`；409 业务错误保持原语义。

## 7. 审计元数据增量接入方案

> 目的：新观察的作者/确认者由服务端产生；旧记录保持未知；**不得把当前账号或教师备注冒充所有历史决定者**。本轮不迁移、不建表。

| 阶段 | 内容 | 规则 |
|---|---|---|
| A（AUTH0 实装轮） | 建 `app_accounts` / `app_sessions` / `teacher_class_assignments` | 不触碰业务表 |
| B（作者/确认者） | `observations` 增可空列 `created_by_account_id`、`confirmed_by_account_id`（建议 `ON DELETE SET NULL`） | 新记录由服务端按会话写入；旧记录 NULL=历史未知，**永不回填**；展示“未知作者/未知确认者” |
| C（指南决定审计） | 旁路审计表 `guide_decision_audit`（observation_id、link_id、account_id、action、support、at） | 不改 G0 `GuideEvidenceLink` 冻结形状；需要展示“决定者”时由契约负责人统一提案；旧 link 无记录=未知 |
| D（会话审计） | `app_sessions.revoked_reason`（logout/disabled/password_reset/replaced）、`disabled_at`、`password_changed_at` | 停用与重置后可追溯 |

展示禁令：`teacher_note` 是教师备注，不是决定者审计字段；当前登录账号不得作为旧记录作者/确认者的兜底。

## 8. 反例清单与规则映射

| 反例 | 规则 | Fixture / 检查 |
|---|---|---|
| 未登录或旧 Cookie 访问业务 | 401，旧 Cookie 不认可 | `logged-out-school-read`、`FIXTURE_LEGACY_COOKIE_STATE` |
| 未知/过期/撤销令牌 | `invalid_session`，401，不降级为匿名 | `unknown-token-child-read`、`revoked-session-class-read` |
| 身份/权限服务不可用默认全园 | fail closed 503，不返回全园数据 | `identity-unavailable-fail-closed`、首页 `identity_unavailable` |
| 管理员执行教学动作 | 403 `forbidden_role`，不伪装教师 | `admin-teaching-*-denied`（写入/确认/指南） |
| 两教师不同/重叠班级 | 各自按当前任教关系判定 | `teacher-b-read-other-class-denied`、`teacher-b-read-overlapping-class` |
| 教师多班 | 第二个班级同样可读 | `teacher-a-read-second-class` |
| 未分配班级教师 | 可登录；业务对象 403 `empty_scope` | `teacher-empty-scope-denied`、首页 `await_class_assignment` |
| 权限撤销后作者仍访问 | 作者不是永久授权 | `author-is-not-authorization-after-revocation` |
| 转班后原班教师拿整份档案 | 整份档案 403；历史只读投影允许 | `teacher-a-child-transferred-profile-denied`、`teacher-a-read-transferred-history-observation` |
| 用当前班级裁掉历史 | 当前负责幼儿完整历史可读 | `current-responsible-reads-prior-class-history` |
| 停用账号使历史失效 | 历史观察对有权者仍可读 | `disabled-author-history-still-readable` |
| 把错误伪装成空数据 | 错误与空状态形态不同 | `FIXTURE_AUTHORIZATION_DENIED_RESULT` vs `FIXTURE_AUTHORIZED_EMPTY_LIST` |
| 空班级范围等于全园 | `classes: []` 明确为空 | `FIXTURE_EMPTY_CLASS_SCOPE`、`scopeEqualsAll` |
| 历史补录目录权限等于名单/统计 | `class.catalog.read` 与 `class.read` 分开 | `class-catalog-separate-from-membership` |
| 管理员绕过班级历史保护 | G2 业务规则 409，授权层不拦截 | `admin-class-history-protection-is-business-conflict` |
| 首页 DTO 泄露密码/令牌或全园数据 | DTO 服务端裁剪、无敏感字段 | 22 号检查、首页 fixture 扫描 |

## 9. Fixture 与最小检查

- Fixture（纯数据，不写库、不调模型）：
  - `src/lib/accounts/__fixtures__/contract-fixtures.ts`：两教师不同/重叠班级、多班、空分配、停用、撤权、转班历史、作者≠授权、旧 Cookie、错误≠空、接口 DTO。
  - `src/lib/home-v2/__fixtures__/contract-fixtures.ts`：未登录/教师/管理员/空分配/身份不可用四态与范围裁剪。
- 检查：`pnpm tsx scripts/check-auth-contract.ts`（离线，只读 fixture，输出 `reference_only: true`）。
  - 参考算法忠实于本契约的授权矩阵与错误映射，**明确不能替代真实认证、真实数据库与浏览器验收**。
  - 当前输出：`{ passed: 22, total: 22, reference_only: true }`。

## 10. 验收与已知限制

本轮离线验收：

- `pnpm ts-check` 通过；
- `pnpm lint:build` 通过；
- `pnpm tsx scripts/check-auth-contract.ts` 输出 `{ passed: 22, total: 22, reference_only: true }`。

`NOT_RUN`（本环境明确未执行，不得当作通过）：

- 真实账号认证、scrypt 校验、会话 Cookie 行为：`NOT_RUN`（本轮不实现认证）；
- 建表/迁移/实库读写：`NOT_RUN`（本轮不执行迁移，未连接任何数据库）；
- 模型调用：`NOT_RUN`（本轮不涉及）；
- 浏览器/UI 验收：`NOT_RUN`（无页面交付）；
- 生产部署与环境变量变更：未执行且禁止。

## 11. 仓库事实记录

- 基线 `b02e4a1` 不存在 `RTK.md`（已核实）；本契约不补造该文件，如需引入由仓库维护者另行决定。
- 基线尚无 G5 的 `evidence-book` / `evidence-overview` 路由（G5 未合并）；第 6 节以增量契约列出，不在本轮实现。
