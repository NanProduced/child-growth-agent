# AUTH-UX1 交付报告：账号管理操作与角色入口收口

- 任务：AUTH-UX1——补齐账号管理操作，并消除“页面让做、后端不允许”的入口。
- 基线：`d8825e6e46f606adabb0e220225bc33d188ccc3e`（CLOSE0 发布的 B0_SHA，由 `b39df27` 快进更新，未使用 `reset --hard`）。
- 分支/工作树：`codex/auth-role-ux-close`，独立工作树 `child-growth-auth-ux1`。未 push、未部署、未连接托管库、未修改 main。
- 真实模型预算：0 次真实 provider 请求（浏览器验收由 `startModelRequestGuard` 环境守门，`hits=0`）。

## 修改文件清单

```text
src/components/accounts/teacher-management.tsx   密码重置对话框与不确定态（接入现有 password-reset API）
src/components/read-failure-notice.tsx           新增：登录/无权限/服务不可用/读取失败四态提示（非空态）
src/app/children/new/page.tsx                    班级读取状态分离；未分配教师联系管理员；教师无建班捷径
src/app/children/page.tsx                        读取失败与权限失败不再落入空态
src/app/children/[id]/page.tsx                   转班仅管理员；记录观察/生成支持仅教师；管理员只读时间线
src/app/classes/page.tsx                         新建班级仅管理员；教师空态引导联系管理员
src/app/classes/[id]/page.tsx                    记录观察仅教师；班级管理仅管理员
src/app/observations/page.tsx                    管理员只读，无“开始记录”教学写 CTA
src/app/reports/page.tsx                         待办只在 can_write 记录中选择；管理员无教学 CTA
src/app/activities/page.tsx                      读取失败与权限失败不再落入空态
scripts/check-teacher-management.ts              扩展密码重置行为离线检查（37 项）
scripts/check-role-entries.ts                    新增：页面角色入口/读取失败投影离线检查（16 项）
scripts/check-auth-role-ux.ts                    新增：隔离库 + 真实浏览器验收
docs/auth-v1/auth-ux1-delivery.md                本报告
```

未修改：认证核心、API 路由、schema、共享类型、首页、全局样式、observations/new、Review、两个 evidence 页面、指南组件；未改 `scripts/harness-safety.ts`（blob 仍为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`）。

## 需求对应实现

1. **管理教师页接入 password-reset API**
   - `persistTeacherChange({kind:"reset_password"})` → `POST /api/admin/teachers/:id/password-reset`，路径/请求体携带同一 `account_id`；密码原样提交（不 trim），不写日志、不写 localStorage/sessionStorage。
   - 对话框先展示目标教师姓名与用户名，并明确“将立即撤销全部登录会话，需用新密码重新登录”。
   - 提交前、请求结束、关闭对话框、身份切换都会清空密码输入；React 状态之外不留副本。
   - 仅当 2xx 且响应体 schema 通过、`teacher.account_id` 等于目标时才判成功并展示撤销会话数；网络失败/响应不可核对标为“结果待核对”，只发一次请求，不自动重发。
   - 教师名单读回**不能**证明密码已重置：`teacherChangeObserved(reset)` 恒为 false，重新读取只提示“教师名单无法证明”，不把“教师仍存在”当作重置成功。
2. **角色入口**
   - 页面通过 `resolveServerAuth()` 获取服务端角色投影（UI 用；服务端每个读写仍重新授权）：管理员看到管理入口（新建/编辑班级、转班、教师管理），看不到记录/整理/确认观察与生成支持；教师只在当前任教范围内看到记录观察等写入口，历史只读不产生写入口；未分配教师只得到“联系管理员”，无自建班级捷径。
   - 复用 `scoped-queries` 的 `can_write`/历史投影、`fetchWithAccountAuth` CSRF 客户端与 provider 的 `isTeacher/canManageClasses`，未新增权限矩阵。
3. **读取失败 ≠ 空态**
   - 负责页面统一：真实成功空列表才显示空态；`unauthenticated/account_disabled`→登录提示；`forbidden_role/out_of_scope/empty_scope`→无权限提示；`identity_unavailable`→服务暂不可用；其他错误→“资料暂不可读”。原始错误信息不再渲染给用户。
   - 身份失效时清空私有投影（教师管理页清空名单；建档页清空班级投影并要求 provider 重新核验），不自动重放任何业务写操作。
4. **成长回顾待办跳转**
   - `pendingTarget` 只在 `can_write` 记录中按 `ai_organized → needs_input → draft` 选择；历史只读记录不会成为“先确认/继续整理”目标。管理员无可写记录时展示只读入口，不显示教学 CTA。
5. **TeachersPage 同 client 读取方式**
   - `src/app/admin/teachers/page.tsx` 未修改：仍在 `withBusinessRead` 内使用普通 `listTeachers/listClasses`，未引入会在守卫内再开事务的 scoped 查询。

## 验收证据

### 离线（替换 I/O，不连库/浏览器/模型）

- `pnpm exec tsx scripts/check-teacher-management.ts` → 37/37（含重置路径、字节原样、错误映射、不确定且不重发、目录无法确认重置、密码不留存）。
- `pnpm exec tsx scripts/check-role-entries.ts` → 16/16（管理员/教师/未分配入口、空态与登录/无权限/服务不可用/读取失败的区分、`can_write` 待办过滤）。
- `pnpm exec tsx scripts/check-home-account-client.ts` → 33/33（未改动认证客户端，回归通过）。
- `pnpm validate`（ts-check + lint:build + lint:style）→ 通过。
- 构建：`pwsh scripts/build.ps1`（`next build` + tsup）通过。`pnpm build` 在本机走 WSL `bash` 失败（`set: pipefail invalid option`），为环境问题；已用仓库自带 PowerShell 等价脚本完成。

### 隔离数据库 + 真实 Next HTTP + 真实 Chrome

`PLAYWRIGHT_CORE_DIR=<scratch>/node_modules pnpm exec tsx scripts/check-auth-role-ux.ts`

- 一次性本地 PostgreSQL 容器（身份/标签/端口/库名核验后使用），真实 `next dev` + 真实 Chrome；33 项检查全部通过，14 张三断点截图；`real_model_requests = 0`。
- 关键覆盖：管理员在真实 UI 完成密码重置（撤销会话数展示、页面/浏览器存储不含新密码）→ 旧教师会话 `invalid_session`、旧密码 401、新密码可登录；管理员观察/班级/档案/回顾页无教学写 CTA；多班教师两班可记录、无建班入口；未分配教师在班级/观察/回顾/建档页均为权限或联系管理员提示而非空态；管理员真实会话完成转班后，原班教师仍可读历史观察但整份档案 403、档案页为权限提示，转入班教师获得可整理待办；1440×900、768×1024、390×844 无横向溢出。
- 产物：`logs/auth-role-ux-<runId>/`（`results.json` + 截图，`logs/` 已 gitignore）。密码/会话凭证不写入任何产物；重置对话框截图在输入密码前拍摄。

### 与本次改动无关的既有失败（如实记录）

- `scripts/check-business-access.ts` 在今日（2026-10-05）失败：该脚本第 168 行以硬编码 `observed_at: "2026-10-04"` 断言创建观察返回 201，而 API 建档时以“今天”为分班起始日，导致 409 `class_context_confirmation_required`。属于日期漂移的测试装置问题；`git diff d8825e6 -- scripts/check-business-access.ts src/lib/queries.ts src/lib/accounts src/app/api` 为空，本次改动未触及该链路。未修复（超出本任务文件范围）。

## NOT_RUN / 限制

- 真实模型 provider：禁止且未执行（预算 0/40）。
- 部署、push、托管库迁移：未执行。
- “非法响应/服务不可用”在浏览器验收中未注入（离线投影检查覆盖）；浏览器证据为隔离库与真实 HTTP，不是生产环境。
- 截图仅覆盖关键页面/断点，未做全站视觉回归。
