# YAYA-DATA1 交付：正式存储、可信批准与操作账本

状态：第一波实现交付（真实代码 + 隔离库验收），等待整合与主评审接入。
共同基线：`11f87ab0d2224d273696ecb86a544768eb014f39`（`fix: align class GET signature with production route validation`）。
工作树/分支：`%TEMP%\opencode\child-growth-yaya-data1` / `codex/yaya-data1`（独立工作树，未 push、未部署、未合并 main）。
固定装置：`scripts/harness-safety.ts` blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`（已核验，未修改）。
`RTK.md`：不存在（仅记录，未创建/未安装）。真实模型/搜索/S3/托管库请求：0（预算 40/40 未动）；未读 `.env`。

## 1. 交付文件（精确清单）

| 文件 | 内容 |
|---|---|
| `scripts/upgrade-yaya-v1.sql` | 幂等增量迁移（新增 10 张 `yaya_*` 表/索引/约束，不改现有表形状） |
| `src/storage/database/shared/schema.ts` | 仅追加 yaya 表定义（+329 行，现有表零改动） |
| `src/lib/yaya/storage-types.ts` | 对外 DTO/错误语义/digest/仓库签名（发布接口） |
| `src/lib/yaya/data/**` | repository 实现：invariants / rows / private-auth / access-facts / projection / conversations / messages / proposals / operations / attachments / route-errors / index |
| `src/app/api/yaya/conversations/route.ts`、`[id]/route.ts`、`[id]/messages/route.ts` | 私有会话与消息 HTTP |
| `src/app/api/yaya/proposals/route.ts`、`[id]/approval/route.ts` | 准备身份与可信批准/拒绝/取消 HTTP |
| `src/app/api/yaya/operations/route.ts` | 仅 GET（原操作/批次查询）；**POST 未创建**，归 TOOLS1 |
| `scripts/yaya/check-data.ts` | 纯函数/可注入反例检查（27 项） |
| `scripts/yaya/check-data-db.ts` | 隔离 PostgreSQL 验收（116 项，真实路由 + 真实事务 + 受控双连接） |
| 本文件 | 交付与接入清单 |

未改：`src/lib/yaya/types.ts`（冻结）、AUTH/G0 冻结文件、现有业务 queries/routes、`pg-client`、MEDIA/AGENT/UI、`package.json`/`pnpm-lock.yaml`、harness。

## 2. 迁移

执行顺序（在现有 4 个迁移之后）：`scripts/upgrade-yaya-v1.sql`。全部 `CREATE TABLE/INDEX IF NOT EXISTS`，可重复执行；隔离库中连续执行两次并核对现有 7 张业务表列签名完全不变（`check-data-db` 实测通过）。

新增表：

- `yaya_conversations`：owner 私有；`(id, account_id)` 唯一支撑复合外键；标题来源片段 jsonb；revision 版本前提；软删除。
- `yaya_messages`：`(conversation_id, owner_account_id)` 复合外键绑定会话 owner；`client_message_id` 会话内部分唯一（幂等）；fragments/attachment_ids jsonb；execution_state。
- `yaya_proposals` / `yaya_proposal_items` / `yaya_operations`：prepare 预分配 `proposal_id`/`batch_id`/逐项 `operation_id`；操作行先于执行存在（status NULL = 尚未开始）；`superseded_by` 自引用。
- `yaya_approvals`：`approval_source` 固定 `authenticated_entry`；逐项快照 jsonb；同一提案至多一个 pending（部分唯一索引）；expires/cancelled/consumed。
- `yaya_attachments` / `yaya_attachment_refs` / `yaya_observation_attachment_meta` / `yaya_attachment_appends`：元数据、三类业务引用（message/proposal/observation）、删除租约（ready/deleting/deleted + revision CAS + delete_result）、观察附件 revision 与追加审计。

## 3. 发布接口（storage-types.ts）

### 3.1 DTO 与函数

- 会话：`YayaConversationView` / `YayaConversationSummaryView`；`createConversation` / `listConversations` / `getConversation` / `getConversationSummary` / `renameConversation` / `deleteConversation`。
- 消息：`YayaStoredFragment` / `YayaSaveMessageInput` / `YayaProjectedMessageView`（含冻结 `YayaChatMessageProjection`）；`saveMessage` / `listMessages`。
- 提案/批准：`YayaPrepareItemInput` / `YayaPrepareProposalInput` / `YayaPreparedProposalView`；`recordApproval` / `rejectProposalItems` / `cancelPendingApproval` / `getApproval`。
- 执行/回执：`YayaExecuteApprovedInput`（含 `school_id`、可选 `resolveBusinessRevision`、`callback(client, ctx)`）、`YayaBusinessWriteResult`；`executeApprovedOperations`（签名即 `YayaExecuteApproved`）；`queryOperation` / `queryBatch` / `supersedeWithReplacement`。
- 附件：`registerAttachment` / `getAttachment` / `queryAttachmentLifecycle` / `beginAttachmentDeletion` / `commitAttachmentDeletion` / `failAttachmentDeletion` / `linkAttachmentRef` / `listAttachmentRefs` / `appendObservationAttachments` / `getObservationAttachmentRevision`。
- 聚合：`yayaDataRepository` 以实现对象 `satisfies YayaDataRepository`，签名与发布接口逐项一致；`withPrivateRead` / `withPrivateWrite`（复用 `resolveRequestAuth` / `evaluateSameOrigin` / `csrfMatches`，不虚构 AUTH action）。

### 3.2 内容 digest

`computeYayaContentDigest({ payload, action, resource, target_id, attachment_associations })`：SHA-256(UTF-8 规范 JSON)；对象键排序、数组保持业务顺序、附件关联按 `(attachment_id,target_id)` 排序；重复附件/undefined/非有限数字/非 JSON 值抛 `invalid_request`。批准入口对存储 payload 重算并比对，不采信请求体自报摘要；TOOLS1 应复用本函数，避免算法分叉。`computeYayaMessageDigest` 用于 `client_message_id` 幂等比较。

### 3.3 错误语义

`YayaDataError.code`：`invalid_request`(400) / `not_found`·`owner_mismatch`·`operation_not_found`(404) / `revision_conflict`·`idempotency_conflict`·`approval_invalid`·`approval_expired`·`approval_consumed`·`operation_started`·`operation_unknown`·`attachment_missing`·`attachment_conflict`·`attachment_referenced`·`reference_incomplete`(409) / `server_error`(500)。`approval_invalid.details.reasons` 使用冻结 `YAYA_APPROVAL_INVALID_REASONS` 词表。路由统一 `mapYayaDataError`；AUTH 错误（401/403/503）仍走 `mapAccountsError`。

## 4. HTTP DTO

| 方法/路径 | 请求 | 响应 | 守门 |
|---|---|---|---|
| `GET /api/yaya/conversations` | — | `{ conversations: YayaConversationSummaryView[] }` | 登录；GET 不写库/不续期/不调模型 |
| `POST /api/yaya/conversations` | `{ title? }` | `{ conversation }` 201 | 登录 + 同源 + 会话 CSRF |
| `GET /api/yaya/conversations/[id]` | — | `{ conversation }`（投影标题） | owner，否则 404 |
| `PATCH /api/yaya/conversations/[id]` | `{ title, expected_revision, title_source_fragments? }` | `{ conversation }` | owner + revision CAS |
| `DELETE /api/yaya/conversations/[id]?expected_revision=` | — | `{ conversation, detached_attachment_ids, unreferenced_attachment_ids }` | owner + revision CAS |
| `GET /api/yaya/conversations/[id]/messages?limit=` | — | `{ conversation, messages }`（逐条投影；非 full 片段 text=null） | owner |
| `POST .../messages` | `{ client_message_id, role, message_kind, execution_state?, fragments, attachment_ids, expected_conversation_revision }` | `{ message, conversation, replayed }` 201 | owner + 幂等 + 版本前提；附件须 ready 且属于 owner |
| `POST /api/yaya/proposals` | `{ conversation_id, proposal_origin, auth, items[{ item_key, target_id, action, resource, resource_ref, payload, attachment_associations, business_revision }] }` | `{ proposal }` 201（含逐项 `operation_id`） | owner + 形状/组合校验 |
| `GET /api/yaya/proposals?proposal_id=` | — | `{ proposal }` | owner，否则 404 |
| `POST /api/yaya/proposals/[id]/approval` | `{ action: approve\|reject\|cancel, operation_ids? }`；其余字段一律丢弃 | approve → `{ approval, cancelled_approval_id }` 201；reject → `{ proposal }`；cancel → `{ cancelled_approval_id }` | owner + CSRF + 逐项重核 |
| `GET /api/yaya/proposals/[id]/approval` | — | `{ approval }` | owner |
| `GET /api/yaya/operations?operation_id=` 或 `?batch_id=` | — | `{ operation: YayaOperationQueryView }` / `{ batch: YayaBatchQueryView }` | 当前 owner 先验证，否则 404；GET 无副作用 |

## 5. 语义要点（与冻结契约对应）

1. **owner 边界先于角色**：全部读写按 `account_id` 过滤，管理员同样 404；他人标题/正文/附件不会出现在任何响应（含错误详情）。
2. **投影而非隐藏**：消息逐片段逐来源核验（`child.read`/`class.read`/`observation.read` + 冻结 `projectChatMessage`）；未知/损坏来源 `broken`，权限服务不可用 `unavailable`，未评估来源按 hidden；标题来源片段非 full 时回退“受限会话”；存储损坏时消息级 `unavailable`。发给模型的上下文同样走该投影（AGENT1 复用 `listMessages`）。
3. **幂等与版本**：`client_message_id` 同摘要回放、异摘要 409；`expected_conversation_revision` 缺失/过期 409；改名/删除同样 CAS。
4. **可信批准**：仅 `authenticated_entry` 服务端记录可执行；actor/原 session 服务端解析；逐项 action/resource/target/当前资源事实/content digest/附件关联/业务版本在批准时固化，`recordApproval` 不更新已存快照；同权转班通过批准时/执行时资源事实比较判 `attribution_changed`。
5. **执行原子性**：`executeApprovedOperations(client, …)` 必须在调用方已有事务内使用；批准消费 + callback + 回执同一 `TransactionClient`，模型等待在事务外；callback 抛错或成功证明不完整 → 整单回滚；重复请求返回原回执不重复执行；顾问 `resolveBusinessRevision` 用于快照非空时的当前版本比较。
6. **原子替代**：锁旧操作 → `started_at/status/superseded_by` 三项核尚未开始 → 取消包含旧操作的 pending 批准 → 同事务 prepare 新身份并写 `superseded_by`；锁顺序统一为「操作行 → 批准行」，受控双连接实测两种交错都不双写。
7. **附件**：引用保护覆盖消息/提案/观察（prepare 即写 proposal 引用）；删除租约先查无引用再 CAS 锁；deleting 期间新引用被拒；未知删除结果停留 `deleting + unknown`；删除会话只解除本会话消息引用（`unreferenced_attachment_ids` 仅为回收候选，对象删除归 MEDIA1）；资料追加有观察级 revision CAS 与独立审计表。

## 6. 验收（RED→GREEN）

- `check-data.ts` 先行编写并以 `Cannot find module '../../src/lib/yaya/data/invariants'` 实际失败（RED）；实现后 `{"passed":27,"total":27,"failures":[]}`（GREEN）。覆盖：digest 规范化/重复附件/非 JSON、prepare 空白 ID/重复 key/非法组合/ref 错配、批准请求净身、跨 session、内容变化、同权转班、取消/过期、身份缺项错配、owner 读回、空白业务 ID、替代资格与迟到消费、附件租约 CAS、删除计划、harness blob。
- `check-data-db.ts`（隔离 Docker PostgreSQL + 真实路由 handler + 真实事务）：`{"passed":116,...,"route_handler_http":true}`。含：迁移幂等 + 现有表零变化；401/403/同源/CSRF；他人会话与管理员 404 且标题不泄漏；跨班来源正文不外泄；幂等/版本/损坏片段；批准伪造字段被丢弃、actor/session/资源事实服务端生成；真实 callback 写入与重放；callback 故障与无效成功证明整单回滚（观察/消费/开始三项均回滚）；内容变化、转班、取消、跨 session 四类拒绝；**受控双连接**：execute-first → 替代阻塞后拒绝 `operation_started`；supersede-first → 旧消费阻塞后拒绝且 callback 0 次；删除会话 vs 新引用租约；资料追加审计与 revision CAS。
- 旧回归：`pnpm ts-check`、`pnpm lint:build`（eslint . --quiet）通过；`check-contract` 68/68、`check-preflight` 15/15、`check-auth-contract` 36/36、`check-guide-contract` 19/19、`check-business-access` 113/113（隔离库真实既有业务路由）。

分层口径：`check-data.ts` 为纯函数/替身；`check-data-db.ts` 为真实 PostgreSQL + 真实 route handler（进程内 NextRequest/Response，无 Next server/浏览器）；执行回调为 DATA1 自有的真实 SQL 替身（`INSERT observations`），**不是** TOOLS1 正式业务装配。

## 7. 资源与清理

- 仅使用 harness 已获批的一次性本地 Docker PostgreSQL；DDL 前核容器标签/回环端口/库名/空库，teardown 按容器 ID + `child-growth-agent.data1` 标签所有权核验删除；`check-data-db` 结束后实测无残留容器。
- 两次因工具超时被强杀的中断运行，其残留容器均已按标签核验后手动删除（非按名称/端口误杀）；无其他资源。
- 测试进程与子进程走 `startModelRequestGuard`，`guard.hits === 0`；未读 `.env`、未连托管库、未调用模型/搜索/S3。

## 8. 接入清单（其他 owner）

- **TOOLS1**：`POST /api/yaya/operations` 由你创建：在既有 `runBusinessWrite(request, action, ref, () => withTransaction(client => executeApprovedOperations(client, input)))` 内调用；`input.submitter` 用当前解析身份/会话与 `csrf_verified:true`；`school_id` 取 `loadAccountsConfig()!.schoolId`；`callback` 使用同一 client 完成业务写并返回 `YayaBusinessWriteResult`（成功三态必须 `effect:"committed"` + 非空 `business_object_id`，否则拒绝落账并整单回滚）；跨幼儿逐项语义由回调自行返回 `failed/none` 或抛出决定。payload 的 Zod 校验与 `content_digest` 复用 `computeYayaContentDigest`；执行前 `itemsToResend`/`queryOperationOutcome` 判定恢复。
- **MEDIA1**：上传成功调用 `registerAttachment`；关联调用 `linkAttachmentRef` / `appendObservationAttachments`（观察级 revision 用 `getObservationAttachmentRevision` 读取）；回收前 `queryAttachmentLifecycle`（`reference_query_complete=false` 或抛错一律不得删除）+ `beginAttachmentDeletion` CAS + `commitAttachmentDeletion` / `failAttachmentDeletion`；删除会话返回的 `unreferenced_attachment_ids` 只是候选。附件读取投影请复用 `evaluateAttachmentAccess`。
- **AGENT1-CORE**：模型上下文用 `listMessages`（投影后 DTO），不要绕过投影直接读 SQL；提案准备走 `POST /api/yaya/proposals` 或 `prepareProposal`；恢复只读，不自动执行。
- **UI1**：按第 4 节 DTO 渲染；批准请求体只发 `{ action, operation_ids }`，不要发送任何自报字段；标题/正文/附件按服务端投影结果展示。

## 9. NOT_RUN

- 真实 provider/StepFun/Coze 模型、公开检索、S3/对象存储、托管 PostgreSQL、生产部署、Next server 全链路与浏览器/移动端渲染：全部 NOT_RUN。
- ARCH 侧 drizzle-kit 生成/比对迁移文件未执行（权威 DDL 为本文件同批 SQL + schema.ts 形状对齐，已由隔离库幂等执行验证）。
- 旧业务三件套的端到端浏览器回归未重跑（本轮以 `check-business-access` 113 项路由级回归覆盖）。
