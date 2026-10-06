# YAYA-CORE-INTEGRATE1 交付：第一波整合、媒体接口收口与真实存储联合验收

2026-10-06。任务：把 DATA、MEDIA、AGENT 三条线整合成第二波可接续的共同基线。
本文件给出来源/合并、MEDIA-R2 复核结论、共享根因修改清单、最终映射与事务调用方式、
联合验收实测与 NOT_RUN、第二波边界与 owner 清单。最终候选 SHA 见交付回复
（本文件随候选提交落地）。

## 1. 来源、祖先与合并

| 线 | 来源 SHA（已通过对应复审） | 合并方式 |
|---|---|---|
| 共同祖先 | `11f87ab0d2224d273696ecb86a544768eb014f39`（build preflight；main `b39df27` 为其祖先） | 工作树起点 |
| DATA1-R2 | `178d376ee3d5fb898ed99770b6b1bac0317d21cd` | `--no-ff` merge `65603d4` |
| AGENT-CORE-R1 收尾 | `f28f01d899f3d4ae8de1f4c9fc33fab36fe70579` | `--no-ff` merge `8920f3a` |
| MEDIA1-R2 | `17310367e21ce73418829003abef20fc666ffa8e` | `--no-ff` merge `83238ab` |
| 整合基线（三线合并后） | `83238abb314f60b05edf4d5251cd09b51f27a072` | 本任务在其上追加实现/装置/文档 |

- 三个来源均为祖先 `11f87ab` 的后代（逐一 `merge-base --is-ancestor` 核实）；
  三来源工作树在复核时为 clean；本任务在独立工作树/分支 `codex/yaya-core-integration` 操作。
- 合并无冲突；未重复合并已合入内容；未 reset/改写来源分支；`src/lib/yaya/types.ts`、
  AUTH/G0 冻结文件、`scripts/harness-safety.ts`（blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`）
  与 package/lock 均未改动（合并后 diff 核实）。`RTK.md` 不存在（仅记录，未创建/安装）。

## 2. MEDIA-R2 单体复核结论（先于合入）

在 MEDIA1 工作树（SHA `1731036`）实跑：`check-media` **28/28**、`check-media-r1` **25/25**、
`pnpm ts-check`、`pnpm lint:build`、`check-contract` 68/68、`check-preflight` 15/15。
按任务清单逐项核代码与反例：

1. 无幂等键未知上传同一身份恢复 — 满足（内容身份 + D1）。
2. 注册正常返回/异常读回统一 `restoreRegistered` 核身份、owner、内容、完整性、ready — 满足（D2）。
3. 预检后宿主状态/confirmed_at 变化，原子保存拒绝且零写入 — 满足（D3/D4，内存替身已忠实）。
4. 已引用照片不能回收；租约先成立后新增引用拒绝 — 满足（A1/A2）。
5. 相同 expected_revision 不同追加一成一冲突 — 满足（C1）。
6. 回收后重新上传若采用新身份，未知结果重试仍须绑定该次身份 —
   **发现保护缺口**：原实现用 `randomUUID()` 兜底，注册未知后重试会重新随机并产生新对象/新记录。
   已在本任务修共享根因并补反例（§4.1，RED 59/61 → GREEN 61/61）。
7. 内容去重仅为存储行为（owner 参与内容身份、不跨账号复用、不复制幼儿事实、读取仍走
   `decideImageReadAccess`）— 满足。

结论：MEDIA-R2 可合入；缺口 6 的修复与证据单列，不把失败候选标为获批来源。

## 3. 共享根因修改清单（跨线）

### 3.1 MEDIA 侧（点 6 根因）

- 根因：无键上传内容身份被回收后随机兜底，注册结果未知时重试不绑定原身份。
- 调用方：`uploadImages`（上传路由/检查共用编排）。
- 修改：`src/lib/media/upload-service.ts` 新增 `recycledContentAttachmentId` 与
  确定性身份链解析（`resolveStableContentIdentity`，含级联上限 8），删除 `randomUUID` 兜底；
  失败仍只精确补偿本轮的、未登记的对象。

### 3.2 DATA 侧（MEDIA 映射文档 §4.4 两项 + 租约区分表达）

- 根因：`source_checksum` 无列；追加 CAS 核心只查宿主存在；媒体租约无版本前提且
  回收/不完整折叠为同一结果。
- 调用方：MEDIA 适配器（`src/lib/media/data-adapter.ts`）、DATA 业务追加
  `appendObservationAttachments`、检查装置。
- 修改：
  - `scripts/upgrade-yaya-v1.sql`：`ADD COLUMN IF NOT EXISTS source_checksum varchar(128)`（幂等）；
  - `src/storage/database/shared/schema.ts`：镜像该列（既有 7 张业务表形状不变）；
  - `src/lib/yaya/storage-types.ts`：`YayaMediaAttachmentRecord` 增 `revision/source_checksum/
    updated_at/deleting_started_at/deleted_at`；租约结果区分化；`addObservationReferences(AtRevision)`
    增 `source_confirmed_at`；`YayaAttachmentAppendInput` 增 `source_confirmed_at`；
    审计条目增 `approval_id`；新增错误码 `observation_not_confirmed`/`source_conflict`（409）；
    `YAYA_MEDIA_INTERFACE_REVISION = "yaya-media-storage-r2"`；
  - `src/lib/yaya/data/attachments.ts`：CAS 核心锁读宿主并核 `confirmed + confirmed_at`；
    `insertPendingAttachment` 持久化 `source_checksum`；`acquireAttachmentDeletionLease`
    增 `expectedRevision` 与 `referenced/reference_incomplete/not_ready(status)` 区分结果；
    `appendMediaAttachmentAudit` 写 `approval_id`；
  - `src/lib/yaya/data/media-port.ts`：绑定/短事务两个工厂透传新签名。
- 未改：DDL 权威仍只有 `upgrade-yaya-v1.sql` + `schema.ts`，MEDIA 不复制 SQL。

### 3.3 新增整合装配

- `src/lib/media/data-adapter.ts`：唯一 DATA↔MEDIA 适配器（§5）。
- `src/lib/media/runtime.ts`：未显式绑定时按环境变量装配**真实** DATA 适配器 + local/S3
  对象存储；缺配置 fail closed 503，不回退内存、不返回假成功。

### 3.4 MEDIA 端口最小扩展（整合需要）

- `metadata-port.ts`：`ATTACHMENT_STATUSES` 增 `pending`（遗留/未就绪记录如实可见）；
  `DeletionLeaseResult` 增 `reference_incomplete`；`beginDeletionLease` 增可信
  `actor_account_id?`。
- `retention-service.ts`：`recycleAttachment` 接收可信上下文操作者（owner 核对）、
  返回 `reference_query_incomplete` 区分态。
- `metadata-memory.ts`：同语义对齐（悬空引用→incomplete、actor 核对）。

### 3.5 测试装置兼容修改（与产品修复分列）

- `check-data-db.ts`：append 夹具补 `confirmed + confirmed_at` 并传 `source_confirmed_at`。
- `check-data-r1-db.ts`：同上（`insertObservation` 夹具改为 confirmed）。
- `check-data-r1-media-db.ts`：R2 CAS 夹具补 `confirmed_at` 并传 `source_confirmed_at`；
  租约断言从 `already_deleting/already_deleted` 精确为 `not_ready + status`；
  引用/悬空断言精确为 `referenced`/`reference_incomplete`（断言实质保留，未删）。
- 新增装置：`scripts/yaya/check-integration-media-db.ts`（61 项；P1 后 88 项）、
  `scripts/yaya/check-integration-http.ts`（17 项）。

## 4. 新增反例 RED→GREEN 与最终实测

### 4.1 点 6 反例（RED→GREEN，真实运行）

场景：无键上传 → 完整回收 → 再次上传遇“登记迟到提交”（结果未知）→ 结算后重试。
以未修版本（`83238ab` 的 upload-service）运行联合检查：**59/61**，两条断言失败：

- `点6 未知结果重试绑定同一身份（不产生新对象/新记录）` FAIL
- `点6 再次重试仍为同一身份` FAIL

修复后同脚本：**61/61**（对象数/记录数不变，身份恒定）。
A/B/C/D 全部场景（含失败注入、双连接交错、悬空引用、审计回滚）均 GREEN。

### 4.2 联合验收分层

| 层 | 内容 | 结果 |
|---|---|---|
| 真实一次性 PostgreSQL（Docker，ID+标签核验） | DATA repository、锁序、CAS、审计、零写入 | 88/88 |
| 真实 sharp | PNG 解码/再编码、三派生对象 | 88/88 |
| 自有本地对象存储（真实本地 I/O） | 写一次、checksum 回读、精确删除/未知删除 | 88/88 |
| 真实 Next HTTP（dev，127.0.0.1 随机端口） | 登录/CSRF、multipart 上传、元数据/字节读取、越权拒绝、幂等重传 | 17/17 |
| Agent 模型 | 进程内替身（真实 DATA 观察/授权事实 + 真实对象字节） | 场景 1/2/3 GREEN |
| 真实 provider/搜索/S3/托管库 | — | **NOT_RUN**（模型守门 0 命中） |

### 4.3 组合回归（在本候选实跑，数值复核）

| 检查 | 结果 |
|---|---|
| `pnpm validate`（tsc/eslint/stylelint） | 通过 |
| `check-contract` / `check-preflight` | 68/68 / 15/15 |
| `check-data.ts` 纯 / `check-data-r1.ts` 纯 | 27/27 / 10/10 |
| `check-data-db.ts` 旧实库 | 116/116 |
| `check-data-r1-db.ts` | 58/58 |
| `check-data-r1-media-db.ts` | 67/67（56+11 R2，含本次装置兼容更新） |
| `check-media.ts` / `check-media-r1.ts` | 28/28 / 25/25 |
| `check-integration-media-db.ts`（新增） | 88/88 |
| `check-integration-http.ts`（新增） | 17/17 |
| `check-agent-engine` / `prompt` / `llm` | 29/29 / 10/10 / 7/7 |
| `check-tech0` / `check-runtime-tech0.cjs` | SDK 表面 OK / PoC 38 项 OK |
| `check-auth-contract` / `check-guide-contract` | 36/36 / 19/19 |
| `check-business-access.ts` | 113/113 |
| 旧 AI：agent-flow / activity-support / growth-profile / ai-context / quality-guard / organize-retry / teacher-clarify / stepfun-timeout | 30/19/13/14/8/9/13/3 全绿 |
| 保存一致性 / 指南写流 / 目录 / 角色入口 | 24/24、123/123、11/11、21/21 |
| `pnpm next build` | 通过（见 §4.4 路径说明） |

### 4.4 Windows 构建环境说明

- 同一 `pnpm next build`（Turbopack）在本整合工作树的原始长路径下报
  `Module not found: @radix-ui/react-dismissable-layer`；在更短路径的工作树（含来源
  MEDIA1 树与重定位后的本候选）通过。判定为 pnpm junction + Windows 长路径的构建环境限制，
  不修改全项目启动体系；候选交付前将工作树重定位到更短路径后重跑（结果以交付回复为准）。
- 构建生成物：`next-env.d.ts` 构建前后哈希一致（`083E23C4…6FD`）；未整目录删除/覆盖
  既有 `.next` 生成物（仅清理本会话自己产生的 dev 缓存，且移到仓库外）。

### 4.5 本次发现的既有基线问题（非本整合引入，未修）

- `scripts/check-classes.ts` 在离线阶段即 `503 !== 401` 失败：该旧检查仍走已移除的
  `TEACHER_PASSCODE` 语义。已在未修改的来源 DATA1-R2 工作树复现同样失败，判定为
  基线遗留、与本候选无关，按“必要回归”清单之外记录。

## 5. 最终 DATA↔MEDIA 映射与事务调用方式

以 `src/lib/media/data-adapter.ts` 为唯一消费入口（映射表见
`media-storage-interface-r1.md` §4/§8；数据结构差异经适配器转换，不复制 SQL）：

```ts
// 业务保存事务内（创建观察附图 / 归档追加）：绑定同一 client，不另开连接
await withTransaction(async (client) => {
  const metadata = bindDataAttachmentMetadataPort(client);
  await metadata.linkObservationReferences({ observation_id, attachment_ids, actor_account_id });
  // ……同一事务写业务记录；或 appendObservationAttachments 完成宿主前提 + CAS + 审计
});

// 无外层事务（上传/回收）：每方法独立短事务
const metadata = createDataAttachmentMetadataPort();
await metadata.registerAttachment(input); // pending+ready 同一短事务
const lease = await metadata.beginDeletionLease({ attachment_id, expected_revision, actor_account_id });
```

要点：`pending` 不对外当作 ready；同键异内容冲突；引用写入与租约共享附件行锁；
对象 I/O 始终在数据库事务外；操作者身份来自可信调用上下文（缺省 fail closed）；
`runtime.ts` 在 Next 进程按环境装配真实端口，缺配置 503。

## 6. 资源与安全纪律证明

- 未读 `.env`、未连托管库、未调用真实 provider/搜索/S3；模型守门在所有实跑中 0 命中。
- 隔离库：Docker 一次性容器，启动即核容器 ID/标签/回环端口/空库；按 ID+标签删除并复核
  `已核实容器不存在`；端口占用即失败（HTTP 检查随机端口 + 监听者归属核验）。
- 临时对象目录、Next 子进程树（PID+创建身份）与生成物快照均按 ID/身份精确清理，
  成功路径与失败路径都经 `assertCleanupComplete` 闸门。
- 凭证/连接串/私有图像不进聊天、日志、提交；上传响应/元数据不含对象 key 与签名 URL。

## 7. 第二波接续边界（共同 SHA 与 owner）

共同接续基线：**本候选最终 SHA（见交付回复；三来源合并提交为 `83238ab`）**。
第二波任务只消费本基线发布的接口，不重开选型：

| 任务 | 唯一 owner 范围 | 允许消费 | 本波未实现（明确 NOT_IMPLEMENTED） |
|---|---|---|---|
| **TOOLS1** | `src/lib/yaya/tools/**`、`/api/yaya/operations` **POST**、必要的既有业务 routes/queries 兼容修改 | `yayaDataRepository.prepareProposal/recordApproval/executeApprovedOperations`（同一 `TransactionClient`）、`YayaDomainPayload` 判别联合、`computeYayaContentDigest`、附件端口（创建/追加事务内绑定） | 工具 registry 全表、schema/候选/读结果、批准执行装配、operations POST 与同事务业务 callback、密码安全窗口 |
| **AGENT-APP1** | `src/lib/yaya/agent/runtime/**`（正式装配）、`/api/yaya/` 会话运行/取消/事件接口 | `runYayaAgent`/`recoverYayaOperations`、`YayaAgentDependencies` 全部端口、DATA 消息/提案投影、MEDIA 授权字节、AUTH 身份 | 正式 run/cancel/event API、当前身份与来源加载/重核装配、历史与 operation 恢复的正式持久化接线 |
| **UI1** | `src/components/yaya/**`、助手入口页面、**package.json/pnpm-lock.yaml 唯一 owner** | 服务端投影 DTO（会话/消息/提案/附件/回执）、批准与事件协议；只渲染 | UI 侧授权判断、业务写、假批准；不做本地权限或统计 |

### 7.1 现有接口（已发布可用）

- DATA：`storage-types.ts` 全部 DTO/repository；`data-media-port` 两工厂；附件适配器两工厂；
  错误码映射（§5）。
- MEDIA：上传/元数据/内容三路由（账号私有 + 逐引用授权）、`upsertAttachment` 无；
  追加路由 `POST /api/observations/[id]/attachments`（真实 AUTH `runBusinessWrite` + 宿主前提）。
- AGENT：动作/事件/端口类型与 `runYayaAgent`；`revalidateProjectedContext` 端口
  （第二波接真实 AUTH/DATA 事实）。
- 审批/回执：DATA 已实现 `recordApproval`、`executeApprovedOperations`（callback 同事务）、
  `queryOperation/queryBatch/supersedeWithReplacement`；operations POST 未实现（归 TOOLS1）。

### 7.2 最小请求/响应/错误/事件约定（沿用，不新增）

- 错误：`YayaDataErrorBody { error, message, details? }`（DATA）与
  `mediaErrorBody`（MEDIA）；AUTH 沿用 `mapAccountsError`。
- 事件：`YayaAgentEvent` 与 `YAYA_AGENT_STOP_REASONS` 冻结口径；
  `receipt { operation_id, outcome }` 为回执事件最小形态。
- 运行：`YayaRunRequest { run_id, user_text, attachment_ids?, signal?, onEvent? }`；
  取消沿用 AbortSignal + run_id 守门（正式 HTTP cancel 归 AGENT-APP1）。

## 8. NOT_RUN（继续单列）

真实模型质量与 provider 请求、真实 S3/桶、托管数据库、浏览器聊天/UI、生产安全与部署、
真实搜索、真实 AUTH/DATA/MEDIA 在 AGENT 引擎中的正式装配（第二波）。
本轮不声称真实模型行为、真实桶或部署可用。

## 9. P1 复审收口：统一回收操作者守门（2026-10-06 追加）

主评审在候选 `24b0588` 上复现的唯一 P1：`recycleAttachment` 仅在 `actor_account_id`
已提供时核 owner。ready 路径有适配器兜底（`ready_missing_actor_code=invalid_request`），
但 `deleting`/`deleting+unknown`/`deleted` 分支先行返回或提前 `finishDeletion`，
绕过运行时校验；无合法操作者时 `deleting+unknown` 会删除 3 个对象并落 `deleted`
（`unknown_recovery_status=deleted, deleted_object_calls=3, objects_before=3,
objects_after=0, database_status=deleted`）。

### 9.1 共享根因修复

- `src/lib/media/retention-service.ts`：`RecycleInput.actor_account_id` 改为必填；
  入口先做运行期校验（缺失/空/空白/非字符串 → `invalid_request`，先于任何状态分支），
  再做 owner 比对（错 owner → `not_owner`，覆盖 ready/deleting/deleting+unknown/deleted）；
  `beginDeletionLease` 恒传 actor。旧租约/revision/“已删除”状态不作为身份豁免；
  不从请求体自报、不按附件 owner 自动补齐、不默认系统身份。
- 合法 owner 语义保持不变：未知恢复、revision 冲突不重复落账、引用/引用不完整保护、
  对象 I/O 在事务外、精确删除。
- 调用方兼容：`check-media.ts`、`check-media-r1.ts` 共 18 处补显式 owner（均为 OWNER_A）；
  `check-integration-media-db.ts` 原调用已带 actor，新增反例经类型旁路验证运行期守门。

### 9.2 反例 RED→GREEN（真实 DATA 适配器 + 隔离 PG + 删除计数替身）

新增 E 段 27 项：ready/deleting/deleting+unknown/deleted 各测缺 actor、空白 actor、
错 owner（均须零对象删除、状态/revision 不变）与合法 owner 行为（ready 回收、
进行中 lease_busy、unknown 恢复、deleted 幂等、引用/不完整保护、revision 冲突不重复落账）。

- RED（`24b0588` 产品代码 + 新反例）：**78/88**，10 项失败，全部为守门缺失：
  ready 空白 actor 误报 not_owner；deleting 缺/空白 actor 不拒；
  deleting+unknown 缺/空白 actor 直接删除并落账（零删除/不变两项同失败），
  且对象已被非操作者删掉导致后续合法 owner 恢复失败；deleted 缺/空白 actor 不拒。
- GREEN（本 P1 修复）：**88/88**，原 61 项断言全部保留。

### 9.3 P1 回归复跑

`check-media` 28/28、`check-media-r1` 25/25、`check-integration-http` 17/17、
`check-agent-engine` 29/29、`check-agent-prompt` 10/10、`check-agent-llm` 7/7、
`check-contract` 68/68、`check-preflight` 15/15、`pnpm validate`、`pnpm next build` 均通过。

### 9.4 文件清单（P1）

- `src/lib/media/retention-service.ts`（入口守门与必填类型）
- `scripts/yaya/check-media.ts`、`scripts/yaya/check-media-r1.ts`（调用方补 owner）
- `scripts/yaya/check-integration-media-db.ts`（E 段 27 项反例）
- 本文件（P1 说明与计数更新）

本轮仅关闭此 P1；新 SHA 仍为待主评审候选，不自行宣布获批。
