# AUTH-UX1-R1 交付报告：建档去向、活动支持只读、身份不可用

- 任务：AUTH-UX1-R1（在 AUTH-UX1 之上修复三项缺口）。
- 基线：`8a104f865a0591d43be370e0792f0c3f49fbe269`（AUTH-UX1 提交），沿 `codex/auth-role-ux-close` 分支追加提交；未 reset、未从 B0 重做、未合并 G6。
- 真实模型请求：0（浏览器验收由 `startModelRequestGuard` 守门，`hits=0`）。

## 修改文件清单

```text
src/app/children/new/page.tsx            建档去向按角色分流；身份四态分离；目录请求 generation 防脏
src/app/children/[id]/page.tsx            活动支持改为 readOnly 传入，不再整区隐藏
src/components/activity-support-section.tsx  新增最小 readOnly 属性（读内容、无写控件、管理员文案）
scripts/check-role-entries.ts             更新/新增离线反例（21 项）
scripts/check-auth-role-ux.ts             新增浏览器反例与动画稳定截图（44 项、17 截图）
docs/auth-v1/auth-ux1-r1-delivery.md      本报告
```

未修改：认证核心、API、schema、冻结类型、queries、首页、Review、指南组件与 evidence 页面。

## A. 管理员建档后的去向

- 创建 API 与权限未改；`handleSubmit` 成功后在客户端按服务端角色投影分流：
  管理员 → `/children/{id}`（成长档案）；教师 → `/observations/new?child_id=...`（原流程）。
- 建档页内文按角色调整：管理员看到“建档后进入成长档案/观察由教师录入”，按钮为“建立成长档案”。
- 浏览器反例（真实 HTTP + 隔离库）：管理员填表提交后 URL 为 `/children/<uuid>`、页面显示新幼儿姓名、`SELECT id FROM children WHERE name=$1` 命中 1 行；教师对照路径提交后落在 `/observations/new?child_id=`。

## B. 活动支持读写分离

- `ActivitySupportSection` 新增 `readOnly` 属性：
  - 管理员（`readOnly`）：完整渲染建议卡片的可以这样做/材料/调整方式/继续观察/依据；不渲染“生成活动支持/重新生成/再试一次”；无建议时显示“还没有活动支持建议”“生成活动支持由教师在成长档案中完成”，旧依据失效时提示“请由教师重新生成”。
  - 教师（默认）：生成/重新生成/错误重试与既有处理完全不变。
- `children/[id]` 对管理员传入 `readOnly={isAdmin}`，不再隐藏整区。
- 浏览器反例：管理员档案页可读到“楼梯测量/跳格子接力/用积木搭出台阶/软尺/粉笔/材料不够时改用椅子”，页面上匹配 `生成活动支持|重新生成|再试一次` 的按钮数为 0；教师同页可看到“重新生成”按钮且计数为 1。离线检查用真实组件渲染同口径断言（含 stale 与空态文案）。

## C. 身份服务不可用

- `children/new` 渲染分支分开：加载中；`unavailable`；`anonymous/invalid_session`；已登录但未分配任教；可建档。
  - `unavailable` 显示“账号服务暂时不可用”，明确“这与未登录不同：重复输入账号密码不会恢复”，并提供“重新核验”（`revalidate`）；不显示登录或未分配文案。
  - 未登录/失效会话显示登录入口（`/login?returnTo=%2Fchildren%2Fnew`）。
- 目录读取仍区分：真实空目录、无权限（403）、会话失效（401）、服务不可读、响应无法核对。
- 身份/范围变化时：effect 递增 `directoryGeneration`、立即把目录清为 loading；`loadDirectory` 在每个 await 后校验 generation，迟到响应不能恢复过时目录。浏览器反例：教师档案页挂起第一个真实 `/api/classes` 响应期间，管理员撤销其全部任教并触发 `cga:auth-changed`，页面立即显示“尚未分配任教班级”；放行迟到响应后页面不再出现任何旧班级名。

## 验收

- `pnpm exec tsx scripts/check-teacher-management.ts` → 37/37（密码重置成功/不确定态/不重发保护保持）。
- `pnpm exec tsx scripts/check-role-entries.ts` → 21/21（含 readOnly 真实内容、身份不可用、generation 源码守卫）。
- `pnpm exec tsx scripts/check-home-account-client.ts` → 33/33（回归）。
- `pnpm validate`（ts-check + lint:build + lint:style）与 `pwsh scripts/build.ps1`（next build + tsup）通过。
- 隔离库 + 真实 Next HTTP + 真实 Chrome：44/44、17 张截图（1440/768/390）、`real_model_requests = 0`；截图前等待 `document.getAnimations()` 结束，不采用过渡帧。
- 密码重置既有链路仍验证：旧会话失效、旧密码 401、新密码可登录、新密码不出现在页面/浏览器存储。

## NOT_RUN / 限制

- 真实模型 provider：禁止且未执行（预算 0/40）。
- 身份不可用（`unavailable`）的浏览器反例未执行（无法在不破坏环境的前提下停掉身份库）：该分支以替换 I/O 的离线渲染检查覆盖，明确标注为替身证据；浏览器证据不包含该状态。
- 部署、push、托管库：未执行。
