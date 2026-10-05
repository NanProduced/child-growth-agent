# 首页业务入口最小授权接入

工作树：`D:/CodexWorktrees/guide-local-preview/child-growth-agent`，分支 `codex/home-v2-craft`。直接编辑，未提交、合并、切换分支或部署。AUTH1 仓储/迁移/初始化修复、首页 UI、客户端和首页数据服务由其他任务负责。

## 父任务导出接口

`src/lib/accounts/access.ts`（主要入口；`src/lib/auth.ts` 也重导出四个主入口）：

```ts
resolveServerAuth(): Promise<ResolvedRequestAuth>
requireServerAccess(action: AccessAction, ref: ResourceRef): Promise<Principal>
withBusinessRead<T>(request: HeaderCarrier | undefined, action: AccessAction,
  ref: ResourceRef, read: (principal: Principal) => Promise<T>): Promise<T>
runBusinessWrite<T>(request: HeaderCarrier, action: AccessAction,
  ref: ResourceRef, work: () => Promise<T>): Promise<T>
```

`ResolvedRequestAuth` 从 `accounts/guards.ts` 复用并重导出；返回原形状 `{state, session, csrf, token}`。`token` 仅服务端内存使用，禁止序列化给页面或 JSON。`resolveServerAuth` 每次读取当前 Cookie、数据库账号/会话/任教，不缓存 Principal；未分配教师仍是 authenticated，scope 为 classes 空数组。配置/身份库不可用为 unavailable，不能当匿名或零值。

`ResourceRef` 只接受 IDs，禁止把请求声明的归属当事实：

```ts
{kind:'school'}
{kind:'class', class_id?:string} // 缺 ID 仅用于 class.manage 新建班级
{kind:'child', child_id:string}
{kind:'transfer', child_id:string, target_class_id:string}
{kind:'observation', observation_id:string}
```

`src/lib/accounts/scoped-queries.ts`：

```ts
scopedListClasses(options?: {catalog?:boolean}, request?: HeaderCarrier): Promise<SchoolClass[]>
scopedListChildren(request?: HeaderCarrier): Promise<Child[]>
scopedListObservations(filters?: {childId?:string; status?:string; limit?:number},
  request?: HeaderCarrier): Promise<ScopedObservation[]>
scopedGetChild(id:string, request?: HeaderCarrier): Promise<Child|null>
scopedGetClass(id:string, request?: HeaderCarrier): Promise<SchoolClass|null>
scopedGetClassChildren(id:string, request?: HeaderCarrier): Promise<Child[]>
scopedListEnrollments(id:string, request?: HeaderCarrier): Promise<ChildClassEnrollment[]>
scopedGetObservation(id:string, request?: HeaderCarrier): Promise<ScopedObservation|null>
```

省略 request 时读取 Next server headers。列表签名无需传入 Principal；资源不存在仅在有权限前提下披露。`ScopedObservation` 是 `Observation & {access_projection:'full'|'historical_read_only'; can_write:boolean}`，可赋给已有 Observation[]。权限错误抛 `AccountsError`，API 用现有 `mapAccountsError` 映射 400/401/403/404/409/503，不能 catch 后返回空数组。页面服务端将 AccountsError 向上传播，避免渲染正常零计数；本次未新增 Next 页面级 401/403 错误边界。

## 行为与事务边界

- 列表在服务端 SQL 中限定范围；教师读取当前负责幼儿的完整历史，或自己任教原班发生的历史观察。访客、旧 Cookie、空范围不能读业务。管理员可全园读取、管理班级、建档和转班，教学写操作拒绝。
- `catalog:true` / `GET /api/classes?catalog=true` 仅返回 SchoolClass 基础目录；没有成员、任教关系或统计，不赋予 class.read，未分配教师仍拒绝。
- 原班历史投影删除 guide_evidence、agent_context、ai_draft 及模型信息；不读取转走幼儿的整份档案。当前服务端 review/page 对历史和管理员直接呈现只读原文/确认描述，不挂载 ReviewClient，也不提供写动作。完整教师路径仍复用现有 ReviewClient。后续客户端若接收 projection prop，应保留这条整份档案边界。
- G5 证据册 GET 要求 child.read；班级概览 GET 要求 class.read。G5/R1 状态、引用、快照、revision、attempt 前提比较保留。
- 动作/资源组合先于身份/角色/范围检查；非法组合 400。全部业务写路由使用新会话、配置可信 Origin 和会话绑定 CSRF；旧口令/HMAC Cookie 不再授权。auth.ts 旧同步 requireTeacher 仅留作失败兼容入口，不得用于新业务实现。
- 模型等待在事务外。runBusinessWrite 捕获原会话和服务器归属前提；一个 AsyncLocalStorage 保存 hook 在每次短事务 BEGIN 后、业务写前重核，不按路由各自实现弱复核。单语句保存也进入 withTransaction。
- 保存锁序：账号 FOR SHARE → 原会话 FOR SHARE → 幼儿 FOR UPDATE → 既有班级/观察锁。AUTH1 重置/停用/分配的账号 FOR UPDATE 与之协调，退出的会话 UPDATE 与之协调。取得会话锁、资源锁后分别用数据库时钟验证过期；读取完成后也再次验证，防止等待锁时自动过期。
- 原账号/原会话、当前状态/角色/任教、幼儿当前归属均重新查询。同教师范围内 A→B 仍 409 state_conflict；撤销、停用、越界保持 401/403；数据库连接/身份检查不可用 503。拒绝不写草稿、失败元数据、确认、指南或档案。新会话不能接续原请求。
- scoped read 使用同一个事务 client；GET 不续期、不写数据库。原始 queries/read-model 属于内部原语，新的公开入口必须使用 scoped 查询或 withBusinessRead；不要直接绕过这些入口。
- 主动成长小结重试改用现有会抛错的 updateGrowthProfileAfterConfirmation，防止保存拒绝被吞为普通模型失败。确认已提交后的附属小结失败仍保留确认收据，不改报整条确认失败。

父任务的 `fetchWithAccountAuth(input,init)` / provider 权限字段负责客户端写请求与控件。未编辑 class-dialogs、activity-support、growth-retry、review-client、children/new、observations/new 等客户端文件；无 CSRF 的旧调用会被 API 拒绝。未创建或编辑 home-v2/data.ts、首页服务或 UI。

## 本侧实际修改路径

```text
src/lib/accounts/access.ts                         (new)
src/lib/accounts/scoped-queries.ts                 (new)
src/lib/accounts/authorize.ts
src/lib/auth.ts
src/lib/queries.ts                                 (single-statement transaction hook only)
src/storage/database/pg-client.ts                  (shared save/read context)
src/app/api/children/route.ts
src/app/api/children/[id]/class-context/route.ts
src/app/api/children/[id]/evidence-book/route.ts
src/app/api/children/[id]/growth-profile/route.ts
src/app/api/children/[id]/activity-support/route.ts
src/app/api/classes/route.ts
src/app/api/classes/[id]/route.ts
src/app/api/classes/[id]/children/route.ts
src/app/api/classes/[id]/evidence-overview/route.ts
src/app/api/observations/route.ts
src/app/api/observations/[id]/organize/route.ts
src/app/api/observations/[id]/follow-up/route.ts
src/app/api/observations/[id]/confirm/route.ts
src/app/api/observations/[id]/guide-evidence/route.ts
src/app/children/page.tsx
src/app/children/[id]/page.tsx
src/app/children/[id]/evidence/page.tsx
src/app/classes/page.tsx
src/app/classes/[id]/page.tsx
src/app/classes/[id]/evidence/page.tsx
src/app/observations/page.tsx
src/app/observations/[id]/review/page.tsx
src/app/activities/page.tsx
src/app/reports/page.tsx
scripts/check-business-access.ts                    (new)
docs/auth-v1/business-access-home.md                (new)
```

冻结契约/types、auth repository/schema/迁移、api/auth、api/admin、模型提示词、provider 配置、raw_text 语义、组件和首页文件均未由本侧修改。工作树包含其他任务修改，不属于以上清单。

## 验证与 NOT_RUN

`pnpm exec tsx scripts/check-business-access.ts`：107/107。使用不可变 harness-safety 的唯一自有隔离 PostgreSQL 容器，按 ID/标签/数据库身份验证后初始化，仅合成数据；没有 dotenv/托管库/复用 URL/5020 端口。真实 Request/Response API handler 直接在测试进程执行，成功写入由同一隔离库复查；不是 Next HTTP 或浏览器验收。

已验证：范围/历史脱敏/G5 GET/管理员教学拒绝/Origin 与跨会话 CSRF；双连接竞争账号锁并实际观察到锁等待，撤销任教后零业务写；模型替身等待期间 NOWAIT 能取得账号/幼儿/观察锁；同范围转班冲突；R1 原状态/上下文/草稿快照冲突；七类共享保存入口在会话撤销后零业务写；停用、过期、新有效会话不能替换原会话、角色变更、保存连接失效；实际等待幼儿锁跨过会话期限后拒绝且零业务写。测试故障注入仅在测试进程，不增加产品开关或权限绕过。容器和本轮连接清理已核验，真实 provider 请求为 0。

其他检查：pnpm ts-check、范围 ESLint、AUTH 契约 36/36（reference_only）、指南契约 19/19（reference_only）、G5 运行时 140/140（offline）。

NOT_RUN：完整 Next HTTP/curl、浏览器/客户端联调、真实模型、真实园所/托管库、部署、全面安全认证。旧脚本中仍有旧口令 Cookie 假设；不以本次检查替代其迁移。AUTH1 core 修复由其他任务验证，未重复修改或运行其脚本。
