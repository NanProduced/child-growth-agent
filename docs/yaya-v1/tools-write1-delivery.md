# TOOLS1 交付：真实写工具与批准执行（operations POST）

2026-10-06。任务：把现有平台真实写操作封装为可执行工具，完成
**参数校验 → 当前授权 → 提案 → 人工批准 → 真实业务执行 → 原操作回执**。
基线 `b8bf68313e0ac7b1afbf6589ae9e590e50d71153`（YAYA-PREP-INTEGRATE2 C2 组合候选），
分支 `codex/yaya-tools1`，独立短路径工作树；最终候选 SHA 见交付回复（本文件随候选提交落地）。

本实现轮真实 provider / 搜索 / S3 / 托管库请求为 **0**；`harness-safety.ts` 保持
blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。未改 READ1、Agent 内核、UI、
`package.json`/`pnpm-lock.yaml`、schema 与冻结 `src/lib/yaya/types.ts` /
`agent/types.ts` / `storage-types.ts` / API0 线协议。

## 1. 交付物

| 文件 | 性质 |
|---|---|
| `src/lib/yaya/tools/write/types.ts` | 新增：写工具 registry / prepare / load / compute / execute 类型与最小工具工厂类型 |
| `src/lib/yaya/tools/write/schemas.ts` | 新增：12 个写工具的 Zod strict 参数 schema（与模型可见 JSON Schema 同源） |
| `src/lib/yaya/tools/write/registry.ts` | 新增：写工具登记表与平台入口适配（prepare/load/compute/execute/版本解析） |
| `src/lib/yaya/tools/write/execute.ts` | 新增：operations POST 执行适配（同一 TransactionClient 消费/业务/回执） |
| `src/lib/yaya/tools/write/secure-control.ts` | 新增：教师创建/密码重置的安全控件意图投影（公开元数据） |
| `src/lib/yaya/tools/write/index.ts` | 新增：`createYayaToolkit` 最小工具工厂（tools/readTool/proposeWrite/executeOperations） |
| `src/app/api/yaya/operations/route.ts` | 修改：保留 GET，新增 POST 授权执行入口 |
| `src/lib/queries.ts` | 修改：抽取显式 `*WithClient` 写原语（观察、确认、班级、幼儿、档案、指南建议），原函数改为同 client 短事务包装 |
| `src/lib/accounts/repository.ts` | 修改：抽取 `setTeacherStatusWithClient` / `assignTeacherClassWithClient` / `unassignTeacherClassWithClient` 与教师账号修订读取；登录、会话、CSRF、密码参数与角色规则不变 |
| `src/lib/observation-agent.ts` | 修改：抽出 `computeObservationAgent`（事务外计算）；`processObservationAgent` 行为不变 |
| `src/lib/growth-profile.ts` / `src/lib/activity-support.ts` | 修改：抽出 `generateGrowthProfileUpdate` / `generateActivitySupportUpdate`（模型与依据快照，事务外）；原入口行为不变 |
| `scripts/yaya/check-tools-write.ts` | 新增：离线检查（112 项） |
| `scripts/yaya/check-tools-write-db.ts` | 新增：一次性隔离 PostgreSQL 真实链路检查（134 项，模型进程内替身） |
| `scripts/check-save-consistency.ts` | 修改：语句级断言指向新的 `*WithClient` 权威函数，原断言语义保留（24/24） |
| 本文件与 `docs/yaya-v1/tool-coverage.md` 追加章节 | 文档 |

## 2. 导出签名

```ts
// src/lib/yaya/tools/write/index.ts
export interface YayaToolkitOptions {
  readPorts?: YayaReadPorts;                       // READ1 端口（测试替身）
  request?: HeaderCarrier | (() => Promise<HeaderCarrier>); // 缺省 serverRequest()
  resolveConversationId?: (runId: string) => Promise<string | null>; // AGENT-APP1 run 绑定；缺省 fail closed
  verifyRun?: (input: { client: TransactionClient; run_id: string; principal: Principal; school_id: string }) => Promise<void>;
  invoke?: typeof invokeLlm;                       // 模型替身注入点
  mediaStore?: MediaObjectStore;                   // 仅创建/追加附图使用绑定 client 的元数据端口
}

export function createYayaToolkit(options?: YayaToolkitOptions): {
  toolkit: YayaToolkit;                            // tools / readTool / proposeWrite（与 YayaAgentDependencies 对应字段同签名）
  readRegistry: YayaReadRegistry;                  // 直接复用 READ1
  writeRegistry: YayaWriteRegistry;
  executor: YayaOperationsExecutor;
  executeOperations(request: HeaderCarrier, body: unknown): Promise<YayaOperationsExecutionResult>;
};

// 写工具条目（registry 内部契约）
interface YayaWriteToolEntry {
  definition: YayaWriteToolDefinition;            // tool/description/auth/params（zodToolParams 同源）
  prepare(input): Promise<YayaWritePreparedItem>; // 同一 client 内解析资源/版本/附件 + 当前授权
  load?(input): Promise<unknown>;                 // 短读事务内读取 compute 快照（当前授权）
  compute?(input): Promise<YayaWriteComputeResult>; // 事务外模型/依据计算，不再访问数据库
  execute(input): Promise<YayaBusinessWriteResult>; // 批准同一 TransactionClient 内落账
  resolveBusinessRevision?(client, context): Promise<string | null>;
}

// 业务版本解析规则（prepare 写入 business_revision；执行前用同一口径重读比较）
// observation.*  → observations.updated_at
// child 类       → children.updated_at（create_child 用目标班级 classes.updated_at）
// class.manage   → classes.updated_at（create 为 null）
// teacher 类     → set_status 用 app_accounts.updated_at；分配/撤销用 classes.updated_at
// 附件追加       → null（版本由 payload 内 expected_attachment_revision + 宿主 confirmed_at 承担）

// 执行结果语义
type YayaOperationsExecutionResult =
  | { kind: 'receipts'; receipts: readonly YayaOperationReceipt[] }
  | { kind: 'needs_prepare'; operation_id: string; message: string; notice: Record<string, unknown> | null };
// needs_prepare → 409 { error:"approval_invalid", details:{ reason:"needs_prepare", ... } }；
// 批准不消费；可选的准备态写入（教师修改复核）经现有 runBusinessWrite 守卫先行保存。
```

## 3. 写工具登记表（12 个，全部有真实业务入口）

| 工具 | 平台入口 | action / resource | 准备态/执行语义 |
|---|---|---|---|
| `create_observation` | `POST /api/observations` | `observation.write` / child | 同事务校验发生时班级快照前提；附图经 `associateObservationImagesOnCreate` 同一事务关联；raw_text 保存后不改写 |
| `organize_observation` | `POST /api/observations/[id]/organize` | `observation.organize` / observation | 模型在事务外（load 后释放读事务）；保存带原状态/上下文/草稿 guard |
| `follow_up_observation` | `POST /api/observations/[id]/follow-up` | `observation.organize` / observation | 同一事务先存追问回答，再落整理结果；任一冲突整单回滚 |
| `confirm_observation` | `POST /api/observations/[id]/confirm` | `observation.confirm` / observation | AI 草稿一致直接归档；教师修改需匹配复核 accept，否则 `needs_prepare` 并先保存复核结果；`guide_decisions` 与归档同一事务（全有或全无） |
| `guide_decision` | `POST /api/observations/[id]/guide-evidence` | `guide.decide` / observation | `suggest` 模型在事务外、`last_attempt` 同事务落账；confirm/reject/withdraw 复用 G5 显式 client 原语 |
| `create_child` | `POST /api/children` | `child.create_profile` / class | 目标班级必须存在且未停用；管理员/教师按范围 |
| `transfer_child` | `POST /api/classes/[id]/children` | `child.transfer` / transfer | 已在目标班返回 `unchanged`；目标班停用拒绝 |
| `manage_class` | `POST /api/classes`、`PATCH /api/classes/[id]` | `class.manage` / class | 仅管理员；学段/学年历史保护复用原事务 |
| `manage_teacher` | `PATCH /api/admin/teachers/[id]`、assignments | `teacher.manage` / school、`teacher.assign` / class | 仅管理员；**只注册启停/分配/撤销**；`create`/`reset_password` 拒绝（安全控件入口） |
| `refresh_growth_profile` | `POST /api/children/[id]/growth-profile` | `growth_profile.write` / child | 模型生成 + 依据集快照在事务外；保存时锁儿童行重读已确认集合，变化即拒绝 |
| `refresh_activity_support` | `POST /api/children/[id]/activity-support` | `activity_support.write` / child | 同上；无已确认观察停在准备态，不消费批准 |
| `attach_observation_images` | `POST /api/observations/[id]/attachments` | `observation.write` / child | 仅已确认归档观察；不改原文/确认稿；宿主 confirmed_at 与 expected_attachment_revision 同事务 CAS + 审计 |

未注册：删除、分享、语音、活动反馈、学期快照、任意 SQL/HTTP、密码类教师创建/重置。

## 4. 关键执行语义

1. **参数与协议同源**：每个工具用 `zodToolParams(strictObject)` 从同一 Zod schema 导出模型可见 JSON Schema；
   dispatcher 用同一 schema 再校验。`approved`/`principal`/`role`/`scope`/`password` 等自报或秘密字段被 strict 拒绝。
2. **准备态 ≠ 业务已保存**：`proposeWrite` 只写 `yaya_proposals`/`yaya_proposal_items`/`yaya_operations`（planned），
   预分配 proposal/batch/operation 身份；不触发任何业务写。
3. **模型等待不持事务/行锁**：执行分三段——短读事务 `load`（当前授权 + 快照）→ **无事务** `compute`（模型/依据计算）
   → 同一 `withPrivateWrite` 事务内 `executeApprovedOperations`（批准消费 + 业务 callback + 回执）。
   首版曾在读事务内调用模型，验收反例（模型等待期间吊销会话/停用/转班）暴露其会阻塞撤权写入；
   已改为读事务先关闭再计算。
4. **批准前提重核**：执行事务内由 DATA `executeApprovedOperations` 重读当前 actor/session/资源事实/内容摘要/附件关联/
   业务版本；`modelWaitPremiseChanged` 使同权转班也失效。
5. **原 operation 幂等**：重复 POST 返回原回执；部分回执/未知按 DATA 语义拒绝，客户端按 `GET /api/yaya/operations` 查询。
6. **失败零部分写入**：callback 抛错整单回滚（批准不消费、业务与回执都不落账）；业务领域错误映射为冻结错误体。
7. **安全控件**：`projectTeacherSecureControlIntent` 只投影控件种类与目标账号；
   `manage_teacher` 的 create/reset_password 不在写工具枚举内，密码不进入提案 payload/事件/日志；
   现有教师管理页/路由仍可直接创建与重置密码。
8. **注入式 run 核验**：`proposeWrite` 在准备事务内调用注入的 `verifyRun`（同一 client）；未注入时不伪造核验。

## 5. 验收

### 5.1 离线（`pnpm exec tsx scripts/yaya/check-tools-write.ts`）

`{"ok":true,"passed":112,"total":112,"real_model_requests":0,"postgres_requests":0,"network_requests":0}`

12 工具登记/合法组合/非空 JSON Schema；strict 反例（未知字段、自报批准/Principal、密码字段、非法日期、
超 8 张/重复图片、raw_text 过短、嵌套伪造批准）；`manage_teacher` 不含密码操作；安全控件投影拒绝秘密字段；
工厂接线与 `proposeWrite` fail-closed（无会话绑定/未知工具/非法参数/匿名/身份不可用/停用/错误来源）。

### 5.2 隔离库真实链路（`pnpm exec tsx scripts/yaya/check-tools-write-db.ts`）

`{"ok":true,"passed":134,"total":134,"real_model_requests":0,"cleanup":"verified"}`

一次性 PostgreSQL 容器（ID + 标签 + 回环端口 + 空库核验，按 ID/所有权清理）+ 真实 AUTH 会话/CSRF +
真实业务服务 + `invokeLlm` 进程内替身。覆盖：

- 未批准执行拒绝且业务 0 行；请求体伪造 `approved` 在解析层拒绝；越权/管理员教学/空任教分别拒绝且 0 提案；
  `verifyRun` 拒绝时 0 提案；
- 批准闭环：建档/录入观察/附图同事务/档案追加/班级/转班/任教/启停；重复执行返回原回执；
  `GET` 原 operation 查询恢复；原 operation 回执唯一；
- 模型等待期间：撤会话（401）、停用账号（401/approval_invalid）、同权转班（attribution_changed）、
  观察版本推进（business_version_changed）、依据集新增确认观察（StaleEvidenceError→409）、
  附件回收/过期 revision（409）全部拒绝且零业务变化、批准不消费；
- 教师修改复核：首次 `needs_prepare` 且复核结果落准备态、批准不消费；准备态写入令旧批准快照失效；
  重新准备 + 复核匹配后归档；raw_text 不变；
- 同宿主原子性：确认 + 失败指南决定整单回滚（未归档、证据未变、批准未消费）；
- 多幼儿分项：两个独立提案，第二项归属变化失败时第一项已保存不回滚、失败项 0 行不自动重发；
- 安全控件：管理路由可创建/重置（响应不含密码），assistant 携带密码的 teacher 提案被拒；
- 回归：READ1 读取、DATA 回执查询、AUTH repository 状态变更在同一真实库上仍可用。

### 5.3 组合回归（本候选实跑）

| 检查 | 结果 |
|---|---|
| `pnpm validate`（tsc / eslint / stylelint） | 通过 |
| `check-contract` / `check-preflight` | 68/68 / 15/15 |
| `check-agent-engine` / `check-tools-read` | 29/29 / 189/189 |
| `check-tools-write` / `check-tools-write-db` | 112/112 / 134/134（cleanup verified） |
| `check-data` / `check-data-r1` | 27/27 / 10/10 |
| `check-data-db` / `check-data-r1-db` / `check-data-r1-media-db` | 116/116 / 58/58 / 67/67 |
| `check-business-access` | 113/113（cleanup verified） |
| `check-tools-read-db` | 87/87（cleanup verified） |
| `check-guide-write-flow` / `check-save-consistency` | 123/123 / 24/24 |
| `check-integration-prep-joint` | 31/31（cleanup verified） |
| `check-integration-media-db` / `check-integration-http` | 88/88 / 17/17 |
| `check-auth-contract` / `check-guide-contract` | 36/36 / 19/19 |

本次修改的共享业务函数（观察保存/确认、档案、班级、幼教、指南建议、observation-agent、growth/activity）
在原检查中行为不变；`check-save-consistency` 的语句断言仅指向抽取后的权威 `*WithClient` 函数，断言未删减。

### 5.4 基线遗留（非本轮引入）

- `scripts/check-guide-evidence-db.ts` 在离线阶段即抛 `旧口令会话已退役`（`src/lib/auth.ts` 的
  legacy `createSessionToken` 固定抛错），与 `check-classes.ts` 同属已记录基线遗留，未修。

## 6. NOT_RUN / 接续

- AGENT-APP1 正式装配：`run→conversation` 绑定、`verifyRun`（run 持久化核验）与聊天运行 API；
  本模块提供注入点，默认缺省 fail closed / 不伪造核验。
- operations POST 的真实 Next HTTP / 浏览器验收；UI 消费 `needs_prepare` 复核卡片与安全控件卡片。
- 真实 provider 模型质量、真实视觉/字符级流、真实搜索/S3/托管库/生产部署。
- `manage_teacher` create/reset_password 的助手账本参与：按契约不注册为可执行写工具；
  密码只走现有教师管理页/路由（本轮以真实 HTTP 路由验证其仍可用）。

## 7. 资源清理

- 两个专属检查各自使用一次性隔离容器/临时目录，正常与失败路径都经 teardown 复核；
  `check-tools-write-db` 输出 `cleanup:"verified"`，结束后容器/卷 0 残留。
- 开发过程中一次 shell 超时留下的同标签容器已按容器 ID + 所有权标签（`yaya.qa-seed1`）核验后删除，
  未按端口/名称前缀误杀其他资源。
- 未读 `.env`，未连托管库，未调用真实 provider/搜索/S3；模型守门命中 0。
