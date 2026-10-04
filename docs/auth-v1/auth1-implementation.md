# AUTH1 实现说明：单园所认证、会话与教师任教管理后端

- 基线：`cfa7b0343fc942ef80dc908ddfb47a96cb5a44dd`（AUTH0-R2 契约候选）
- 分支：`codex/auth1-core`（独立工作树 `child-growth-auth1`）
- 范围：认证后端与教师管理后端。**未接入既有班级/幼儿/观察/成长档案/活动支持/指南业务路由**；
  AUTH1 单独完成不代表整个应用已受新认证保护，**禁止单独发布**。

## 1. 模块与文件

| 文件 | 职责 |
|---|---|
| `src/lib/accounts/config.ts` | 部署配置：可信源、园所标识、Cookie Secure、限流参数；缺可信源时 fail closed |
| `src/lib/accounts/normalize.ts` | 用户名规范化（trim → NFKC → lowercase），与密码处理分离 |
| `src/lib/accounts/password.ts` | 固定 scrypt 参数哈希/校验、严格格式解析、恒时比较、dummy 校验 |
| `src/lib/accounts/session.ts` | 会话令牌（32B 随机，库内 SHA-256）、CSRF HMAC 派生、Cookie 属性、旧 Cookie 清理 |
| `src/lib/accounts/repository.ts` | 账号/会话/任教关系 SQL；登录事务锁、停用/重置撤销、初始化 advisory lock |
| `src/lib/accounts/bootstrap.ts` | 部署者初始化逻辑（非 HTTP） |
| `src/lib/accounts/rate-limit.ts` | 登录失败限流（进程内固定窗口） |
| `src/lib/accounts/guards.ts` | 登录前保护、登录后写保护、管理员守门、错误映射 |
| `src/lib/accounts/authorize.ts` | AUTH2 授权基础函数（与冻结契约/R2 边界一致） |
| `src/lib/accounts/pool-safety.ts` | 连接池 `error` 监听：数据库不可用时不崩溃，查询路径 fail closed |
| `src/lib/accounts/errors.ts` | 领域错误到冻结错误码的映射 |

冻结文件 `types.ts` / fixture / `check-auth-contract.ts` 未修改。

## 2. 数据与迁移

`src/storage/database/shared/schema.ts` **仅追加**三个表（其余零修改）：

- `app_accounts`：username 唯一（存规范化值）、password_hash、role（admin/teacher）、status（active/disabled）、password_changed_at、disabled_at；
- `app_sessions`：token_hash 唯一、expires_at、revoked_at、revoked_reason；外键级联删除随账号；
- `teacher_class_assignments`：当前关系部分唯一索引 `(account_id, class_id) WHERE removed_at IS NULL`；撤销只写 `removed_at/removed_by_account_id`，保留历史；不改变幼儿归属与观察快照。

迁移：`scripts/upgrade-auth-v1.sql`（幂等，可重复执行；不删除、不改写业务表）。部署前必须在目标库执行。

## 3. 密码

- 异步 scrypt，冻结参数 `N=32768, r=8, p=3, key_length=64, maxmem=64MiB`，盐 16 字节随机；
- 存储 `scrypt$N$r$p$<salt_b64>$<hash_b64>`，解析严格核对算法/参数/盐长/哈希长/base64，不兼容其他成本参数；
- 恒时比较；密码不 trim、不做 Unicode 规范化；`PASSWORD_MIN_LENGTH=8` 只在创建/重置时校验；
- 账号不存在时执行 dummy scrypt，降低用户名存在性时序差异。

## 4. 会话与 CSRF

- 登录签发 32 字节随机令牌（base64url），数据库只存 SHA-256 十六进制哈希；Cookie `cga_session`：`HttpOnly; SameSite=Lax; Path=/`，Secure 由 `AUTH_COOKIE_SECURE` 或“可信源是否全为 https”决定；固定期限 7 天，不滚动续期；
- CSRF 令牌 = `HMAC-SHA256(session_token, "cga-auth-v1:csrf")`（base64url）。与当前会话绑定、不落库；响应体只返回派生值，绝不返回会话令牌；获取 CSRF 的 `GET /api/auth/status` 不写数据库；
- 登录后变更（非 GET/HEAD）：同源检查 + 有效会话 + `x-csrf-token` 会话绑定校验；另一会话令牌一律 `csrf_rejected`；
- 退出：有效会话撤销；失效/缺失幂等 200；服务端按原路径 `/` 清除 `cga_teacher`；旧 Cookie 不构成授权，也不阻断新账号登录；
- 连接失效（数据库不可用）：`pool-safety` 阻止进程因未处理的 `error` 崩溃，路由/守卫返回 `identity_unavailable`（503），不降级匿名。

## 5. 登录前保护与限流

- `POST /api/auth/login`：可信 `Origin`（仅部署配置）+ 媒体类型主体精确 `application/json`（允许 `charset` 参数、大小写不敏感；拒绝 `jsonp/json-seq/jsonx/form/空值`）+ `x-cga-auth-request: 1`；
- 失败映射（不新增错误码）：来源类（`origin_untrusted` / `same_origin_proof_missing`）→ 403 `csrf_rejected`；请求形状类（缺自定义头/媒体类型不符）→ 400 `invalid_request`；
- 登录失败统一 `invalid_credentials`（401），未知账号与错误密码响应一致；停用账号在校验通过密码后返回 403 `account_disabled`；
- 限流：进程内固定窗口，键 = 规范化用户名 + 客户端地址（XFF 首跳，仅辅助）；超限 429；多实例不共享计数（未引入 Redis，已记录为已知限制）。

## 6. 账号与任教管理

- 仅管理员可访问 `/api/admin/teachers**`；错误顺序：同源 → 会话 → 角色 → CSRF；
- 路径 ID 与请求体 `account_id`（撤销时还含 `class_id`）不一致 → 400 `invalid_request`；
- 教师接口传入管理员 ID → 403 `forbidden_role`（不得通过教师接口修改管理员）；
- 创建教师 + 初始分配同一事务，全有或全无；用户名规范化后唯一 → 409 `username_taken`；
- 同一教师多班、同班多教师、空数组分配均支持；撤销只写 removed_at，重复撤销幂等；
- 停用/重置密码在同一事务内撤销该账号全部会话并返回 `revoked_session_count`；
- 响应 DTO 严格按冻结类型，不含密码、哈希、盐或会话令牌。

## 7. 首位管理员初始化（部署者脚本）

`scripts/auth-bootstrap-admin.ts`（无 HTTP 入口）：

```
DATABASE_URL=... AUTH_SCHOOL_ID=... pnpm exec tsx scripts/auth-bootstrap-admin.ts
```

- 用户名/显示名/密码从标准输入读取；TTY 下密码输入不回显；拒绝任何含 password 的 argv、不使用环境变量传密码；
- 事务内 `pg_advisory_xact_lock` + “无管理员”检查，并发只有一个成功；已有管理员退出码 2（`admin_already_initialized`）；不覆盖、不重置、无默认密码。

## 8. AUTH2 可调用接口

- `resolveRequestAuth(request, config)`：返回 `AuthState` + 会话视图 + CSRF；数据库不可用 → `unavailable`；
- `authorizeAction(principal, action, resource)` / `authorizeAuthState(...)`：动作/资源组合先校验（非法 400 语义），再角色/范围；与 `check-auth-contract` fixture 交叉验证；
- `childAttributionOf(resource)` / `modelWaitPremiseChanged(before, after)`：模型等待归属前提比较（R2）；
- `resolvePrincipalById(accountId, schoolId)`：按当前数据库事实重建 Principal（模型等待重核用）；
- `guardAdmin` 仅供管理员接口；AUTH2 接入业务路由时应使用 `resolveRequestAuth` + `authorizeAction`，不得缓存 Principal。

## 9. 部署与回滚

1. 在目标库执行 `scripts/upgrade-auth-v1.sql`（幂等）；新库需先具备 `classes` 表；
2. 配置 `AUTH_TRUSTED_ORIGINS`（必需）、`AUTH_SCHOOL_ID`、`AUTH_COOKIE_SECURE`、限流变量；
3. 运行一次性初始化脚本创建首位管理员；
4. 旧 `TEACHER_PASSCODE` 与旧业务路由保持不变，直到 AUTH2 完成路由切换；**AUTH1 单独上线不会保护既有业务接口**。
