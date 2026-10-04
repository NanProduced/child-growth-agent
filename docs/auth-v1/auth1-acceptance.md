# AUTH1 验收记录：真实数据库、真实 HTTP 与受控并发

- 基线：`cfa7b0343fc942ef80dc908ddfb47a96cb5a44dd`；分支 `codex/auth1-core`
- 结论：AUTH1 后端验收通过；**未接入业务路由，禁止单独发布**。

## 1. 命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm exec tsx scripts/check-auth-core.ts` | `{"passed":28,"total":28,"offline":true,"real_db":true,"real_http":true,"controlled_concurrency":true,"model_requests":0}`，exit 0，清理闸门通过 |
| `pnpm exec tsx scripts/check-auth-contract.ts`（AUTH0 回归） | `{"passed":36,"total":36,"reference_only":true}` |
| `pnpm validate` | ts-check / lint:build / lint:style 全部 0 |
| `pnpm next build` | 成功（路由表包含新增 auth/admin 接口） |
| `pnpm tsup src/server.ts ...`（build.sh 第二步） | 成功（`dist/server.js`） |
| `pnpm build`（bash 包装） | **NOT_RUN（本机环境）**：`bash` 解析为 WSL 且 `set -o pipefail` 不可用；未修改启动脚本，改为直接执行 build.sh 的等价步骤 |
| 生成物恢复 | `next build` 修改的 `next-env.d.ts` 已精确恢复；`tsconfig.json` 未被修改；`.next/`、`dist/` 为 gitignore 产物 |

## 2. 隔离实库（harness-safety，唯一 RUN_ID）

- 一次性本地 `postgres:16-alpine` 容器：容器 ID + 标签（`cga.auth1.check=<RUN_ID>`）核验；端口映射必须为 `127.0.0.1:*`；连接后核验 `current_database=cga_auth1_check`、`current_user=postgres`、`inet_server_port=5432` 与全新空库；
- 未读取 `.env`、未接受任何外部数据库 URL；检查进程显式覆盖 `DATABASE_URL` 并删除 `PGDATABASE_URL`，服务端子进程同样隔离；
- `initialize-demo-db.sql` + `upgrade-auth-v1.sql` 连续执行两遍，验证迁移幂等。

## 3. 真实 HTTP（next dev，仅回环）

- `next dev -H 127.0.0.1` 子进程，就绪前核验端口监听者 PID 属于本轮子进程树；
- 模型 provider 出口改道本地守门（任何真实调用立即 502 计数）：`model_requests=0`；
- 覆盖断言：
  - 登录前：`application/json` / `charset` / 大小写通过；`jsonp`、`json-seq`、`jsonx`、`text/plain`、空值、普通表单、缺 `x-cga-auth-request`、跨源、`Origin=null`/缺失全部拒绝；
  - 登录：会话 Cookie `HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`，本地 http 不强制 Secure；响应体不含会话令牌/password/hash/salt；旧 `cga_teacher` 由服务端 `Max-Age=0; Path=/` 清除且不阻断登录；
  - 状态：`GET /api/auth/status` 前后会话行（`expires_at/revoked_at/created_at`）不变（不续期、不写库）；旧 Cookie 单独出现为 `invalid_session.legacy_cookie_not_accepted`；
  - CSRF：同会话令牌通过；另一会话令牌、缺失令牌、跨源写请求全部 403；
  - 权限：匿名 401、教师调管理员接口 403 `forbidden_role`、路径/请求体 ID 不一致 400、教师接口传入管理员 ID 403；
  - 教师管理：创建（规范化唯一 409）、多班、同班多教师、撤销（保留历史）、空分配教师可登录且范围为 `classes: []`；
  - 停用/重置：`revoked_session_count ≥ 1`，旧会话立即 `invalid_session`，旧密码 401、新密码 200；
  - `invalid_credentials`：未知账号与错误密码响应体完全一致；
  - 限流：失败 3 次后第 4 次 429；
  - 退出：有效会话 200 撤销 + 清 Cookie；失效/缺失会话幂等 200（服务端未假装“身份服务已成功撤销”，数据库不可用时返回 503）。

## 4. 受控并发（参考级）

- 首位管理员：两个并发初始化 → 恰好 1 成功、1 `admin_already_initialized`；
- 登录 × 重置（2 组）、登录 × 停用（2 组）：`Promise.all` 同时发起；断言登录要么失败（旧前提失效），要么成功但其会话行 `revoked_at` 非空（不可留下基于旧密码/旧状态前提的新会话）；
- 以上为真实数据库上的受控交错，不等价于穷尽并发证明；真实模型等待场景的事务交错仍属 AUTH2 范围。

## 5. 清理与资源核验

- 服务子进程按 PID + 创建身份核验终止；生成物按快照恢复；容器按 ID + 标签所有权核验删除（失败路径同样执行）；
- 复核：无残留 `label=cga.auth1.check` 容器、无监听端口残留、临时日志已删除；`runCleanupSteps` + `assertCleanupComplete` 通过。

## 6. NOT_RUN 与剩余限制

- `pnpm build` 的 bash 包装（本机 WSL 环境）；等价构建步骤已执行；
- 浏览器/UI、登录入口 UI 切换（teacher-provider/top-nav/首页）：未执行；
- 既有业务路由的授权接入（AUTH2）：未执行；旧 `TEACHER_PASSCODE` 仍控制业务写接口；
- 反向代理后的真实 `Origin` 行为：未执行；
- 多实例限流共享：按设计未实现（进程内固定窗口，多实例不共享）；
- scrypt 定量性能/资源曲线：执行了真实哈希但未做性能声明；
- 生产/托管库：未连接、未迁移、未部署。

## 7. AUTH2 发布前置

1. 业务路由改用 `resolveRequestAuth` + `authorizeAction`（不得缓存 Principal/长期范围）；
2. 模型等待路径落实 R2 归属前提比较与写前重核；
3. G5 两个 GET 从公开变受限；现有公开 GET 按范围裁剪；
4. 前端登录入口从口令切换为账号密码，携带 `x-cga-auth-request` 与会话绑定 CSRF，并执行 `cleanup`；
5. 在目标环境执行 `upgrade-auth-v1.sql` 并配置 AUTH 环境变量；切换完成后再退役 `TEACHER_PASSCODE`。
