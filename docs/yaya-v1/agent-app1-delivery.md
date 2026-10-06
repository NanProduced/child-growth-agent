# YAYA-AGENT-APP1 交付：正式运行服务、run 持久化与动态授权装配

2026-10-06。任务：在第二波共同基线（`b8bf68313e0ac7b1afbf6589ae9e590e50d71153`）上，
实现 API0 已批准的三个接口（发起 / 查询 / 取消），接真实 AUTH、DATA、MEDIA、READ1 与现有 Agent 内核。
最终候选完整 SHA 见交付回复（本文件随候选提交落地）。

- 分支 / 工作树：`codex/yaya-agent-app1`，`%TEMP%\opencode\yaya-app1`
- 真实账号/会话/CSRF + 隔离 PostgreSQL + 真实 Next HTTP + 模型替身；**真实 provider/搜索/S3/托管库请求 0**，
  本轮不消费新增 20 次额度。
- `scripts/harness-safety.ts` 保持 blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`（hash-object 复核）。
- 未读 `.env`、未 push / 部署 / 合并 `main`、未改其他工作树或分支。
- 模型配置增量：**无源码改动**。运行网关直接复用 AGENT1-CORE 的 `createLlmYayaModelGateway()`；
  `src/lib/llm.ts`、原 6 类 strict schema 与旧调用行为逐字节未改（check-agent-llm 7/7 哈希回归）。

## 1. 交付文件

| 文件 | 性质 |
|---|---|
| `scripts/upgrade-yaya-runs-v1.sql` | 新增：独立 run 迁移（仅 `yaya_runs` 表 + 索引） |
| `src/storage/database/shared/schema.ts` | 追加：`yayaRuns` drizzle 定义（不改既有表） |
| `src/lib/yaya/agent/runtime/store.ts` | 新增：run 持久化（登记/幂等/依赖/终态/取消/替换/中断/保存钩子） |
| `src/lib/yaya/agent/runtime/registry.ts` | 新增：进程内 AbortController 注册表（不冒充恢复存储） |
| `src/lib/yaya/agent/runtime/identity.ts` | 新增：每次异步边界重核原账号/会话/run |
| `src/lib/yaya/agent/runtime/context.ts` | 新增：历史当前投影、MEDIA 授权字节、依赖累积与逐项重核 |
| `src/lib/yaya/agent/runtime/deps.ts` | 新增：`YayaAgentDependencies` 正式装配 + TOOLS1 写绑定接口 |
| `src/lib/yaya/agent/runtime/service.ts` | 新增：三条接口服务端逻辑与 NDJSON 流写出 |
| `src/lib/yaya/agent/runtime/index.ts` | 新增：导出 |
| `src/app/api/yaya/conversations/[id]/runs/route.ts` | 新增：POST 发起 / GET 查询（Node runtime） |
| `src/app/api/yaya/runs/[runId]/cancel/route.ts` | 新增：POST 取消（Node runtime） |
| `scripts/yaya/check-agent-app1.ts` | 新增：专属验收装置（78 项） |
| `docs/yaya-v1/agent-app1-delivery.md` | 本文件 |

未改：冻结 `types.ts` / `agent/types.ts` / `storage-types.ts` / `api-contract.ts` /
`agent/engine.ts` / `agent/gateway.ts` / `agent/prompt.ts`、DATA、MEDIA、READ1、AUTH、既有 routes、
`package.json` / `pnpm-lock.yaml`、UI、harness（`git diff b8bf683 -- <冻结文件>` 为空）。

## 2. 最小 run 存储（先列明、后实现；单表）

`yaya_runs` 字段：`id`（服务器建立 run_id）、`owner_account_id`、`conversation_id`、
`client_request_id`、`request_digest`（规范化内容 SHA-256）、`user_text`（原文，绝不改写）、
`attachment_ids`、`expected_conversation_revision`、`session_id`、`owner_instance`、
`state ∈ active|terminal|interrupted`、`outcome`、`dependencies`、`cancel_requested_at`、
`replaced_by`、`deadline_at`、`created_at/updated_at/terminal_at`。

约束：`UNIQUE (owner_account_id, conversation_id, client_request_id)`（双连接竞争由唯一索引裁决）、
复合外键 `(conversation_id, owner_account_id) → yaya_conversations(id, account_id) ON DELETE CASCADE`、
状态/版本/摘要/JSON 形状 CHECK；索引 `(owner, conversation, created_at desc)` 与部分索引
`(owner_instance) WHERE state='active'`。

`store.ts` 接口：`registerYayaRun`（created/replayed/conflict/active 四态）、`loadYayaRun`、
`findYayaRunByClientRequest`、`appendYayaRunDependencies`（只增不覆盖）、`finalizeYayaRun`
（`state='active' AND owner_instance=$` 守卫，迟到结果被拒）、`markYayaRunInterrupted`、
`requestYayaRunCancel`、`assertYayaRunActive`（TOOLS1 同 client 保存钩子）、`assertYayaRunAttachments`。

`dependencies` 逐项形状（内部、非冻结协议）：`{ref, tool, image_id, message_id, fragment_id}` ——
`tool` 非空为 READ1 工具来源；`message_id/fragment_id` 为已装载历史片段；`image_id` 为授权图片。

## 3. 动态授权装配语义

- **身份**：`resolveCurrentIdentity` 每边界用原会话令牌重读当前账号/会话/任教范围与 run 行；
  run 非 active / `replaced_by` 非空 / 会话绑定不一致 → 不同 run_id（引擎 `run_replaced`）；
  失效会话 → `session_invalid`，停用 → `account_disabled`，身份服务失败 → `identity_unavailable`；
  取消只 abort 本进程控制器。不缓存 Principal，不接受请求体身份。
- **历史**：`yayaDataRepository.listMessages` 当前投影（最近 20 条；只有 full 片段正文进入模型），
  逐片段登记 run 级依赖；重核时**重跑当前投影**比对 full 可见性，不比较 scope 数组。
- **图片**：MEDIA `loadAttachmentContent(variant='model')` 当前授权、已处理字节 → base64；
  不接触对象 key / 签名 URL / Cookie / CSRF；`image_interpretation` 来源，教师原文分开。
  不可读/缺字节 → 加载失败 → 下一次重核 `context_revoked`，不进模型。
- **读取**：READ1 `registry.dispatch`（citable_source + `recheck_dependencies` 全量累积，后续读不覆盖）。
- **重核**：对象引用复读真实资源后按原工具动作授权（`list_classes`/`resolve_child_class` 的班级引用
  按基础目录 `class.catalog.read`）；scope 来源复用 AUTH `class.catalog.read` 范围判定；
  指南引用按 `authenticated_reference`；教师账号引用按 `teacher.manage + school`；未知引用保守拒绝。
  `source_refs=[]` 不豁免（重核只看已装载依赖，与模型引用无关）。
- **写入**：正式路径缺 TOOLS1 工厂时 `proposeWrite` 明确 `unsupported`（空写工具目录 →
  引擎在触达依赖端前 `unknown_write_tool`），**不产生假提案 / 假回执**；TOOLS1 交付后经
  `createYayaRunDependencies(state, { write })` 绑定，并用 `assertYayaRunActive` 在保存前同 client 核 run。
- **公开检索**：默认关闭（`provider_enabled=false`），扫描恒未知，服务端保守拒绝。

## 4. 三条接口与传输

| 方法 | 路径 | 语义 |
|---|---|---|
| POST | `/api/yaya/conversations/{id}/runs` | API0 严格请求校验（拒绝自报权威/秘密字段）→ 同事务登记（先落库）→ 200 NDJSON |
| GET | `/api/yaya/conversations/{id}/runs?client_request_id=` | 五态只读；不启动模型、不执行批准、不续期 |
| POST | `/api/yaya/runs/{run_id}/cancel` | 空请求体；持久化取消并 abort 本进程；不撤销已提交业务 |

- 幂等：同键同摘要终态回放（同 run_id/同终态，不再派发）；同键异内容 409 `idempotency_conflict`；
  同键活跃/中断 409 `operation_started`（绝不二次派发）；双连接由唯一索引裁决。
- 五态：`missing` / `in_progress`（本进程活跃派发者）/ `finished` / `service_failure`（查询失败不冒充缺失）/
  `unverifiable`：活跃但派发者不可核验（进程失联/跨进程）→ `owner_binding_failed`；
  中断标记、终态不可读、或终态依赖/历史/图片在当前授权下不可核验 → `terminal_unreadable`，
  不返回旧私域内容（回答/澄清/提案类终态；`stopped` 只含协议语义）。
- 传输：`application/x-ndjson`、`Cache-Control: no-store`、`X-Accel-Buffering: no`；
  事件逐条 API0 schema、seq 连续、唯一 `run_end`；头未发用 HTTP 错误，流开始后用显式终态；
  停止详情统一 `safeYayaStopDetail`，内部异常/模型原始 JSON 不进事件。
  业务事件在模型等待期间即逐条写出（检查实测）；引擎 deadline 90s 与代理 90s 无数据限制同口径。
- 取消：三个固定布尔；重复取消幂等；取消他人/不存在 run 404；终态后取消不改写已发布结果。
- 断开连接：运行继续到终态并落库，供 `client_request_id` 查回；不自动重跑、不撤销已提交业务。

## 5. 验收（本候选实跑）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 / Lint / 样式 | `pnpm validate` | 通过 |
| 完整构建 | `pwsh scripts/build.ps1`（Next build + tsup） | 通过 |
| **专属验收** | `pnpm exec tsx scripts/yaya/check-agent-app1.ts` | **78/78**，`failures: []`，清理闸门通过 |
| 契约 / preflight | `check-contract` / `check-preflight` | 68/68 / 15/15 |
| API0 协议 | `check-api-contract` | 57/57 |
| 内核 / 模型兼容 / 只读工具 | `check-agent-engine` / `check-agent-llm` / `check-tools-read` | 29/29 / 7/7 / 189/189 |

专属装置分层（输出 `layers`）：真实 next dev HTTP、一次性隔离 PG、真实登录/会话/CSRF（辅助账号直插会话）、
真实 sharp+本地对象根、本地 StepFun 协议模型替身（真实 `llm.ts` 路径）、检查进程跨进程读同一隔离库。
覆盖（逐项对应任务验收）：

- 匿名/他人会话/管理员边界/自报 Principal/错误 CSRF；
- 空任教一般问答、一般问答、真实读取后引用 citable_source、run 依赖完整累积、两次读取不覆盖旧依赖；
- 同键同内容回放（0 次再派发）、同键异内容 409、双连接竞争只派发一次；
- 模型等待期间撤权（`context_revoked` 且无回答）、独立进程重核复现、run 替换（迟到结果不发布、不覆盖）、
  撤权后终态恢复不可核验、恢复后可读；
- 会话失效 `session_invalid`、账号停用 `account_disabled`、身份服务失败 `unavailable`（模型调用关闭）；
- 图片授权正例（进模型请求，StepFun 显式 unsupported、0 provider 请求）、他人附件拒绝、
  正式上下文图片为 `image_interpretation` 且字节等于 MEDIA `model` 变体 checksum；
- 首响应丢失（in_progress 查回）、取消（固定布尔、流 `stopped(cancelled)`、查询一致）、跨进程取消、
  进程失联（真实 kill）后跨进程查询不可核验、终态跨进程可读；
- 中断恢复标记、模型失败显式终态与协议文案、未知工具/未知来源/写入 fail closed、保存前 run 钩子；
- 全部流逐行 API0 校验、唯一终态、usage 未知为 null、查询/原 operation 查询不触发模型、查询不续期；
- 在途事件逐条 flush（模型等待期间已读到 run_started/model_attempted）。

## 6. 资源与安全纪律

- 真实模型/搜索/S3/托管库请求 0；模型替身为本地 127.0.0.1 HTTP 服务，未登记请求 0。
- 隔离 PG 为一次性 Docker 容器（回环端口、标签所有权、空库校验）；媒体根为自有临时目录；
  进程树按 PID+创建身份核验终止；生成物快照恢复（`next-env.d.ts` 已还原）；清理闸门 `assertCleanupComplete` 通过。
- 每个 command 自包含；未读 `.env`；未写任何凭证/连接串进仓库、日志或事件。
- 迁移只新增 `yaya_runs`；不新建聊天/批准账本。

## 7. NOT_RUN / NOT_IMPLEMENTED

- 真实 provider（含视觉、字符级流、上游物理取消）、真实搜索、S3、托管部署：NOT_RUN。
- TOOLS1 写工具、`operations` POST、批准执行装配、密码安全窗口：NOT_IMPLEMENTED（本模块以
  `write` 绑定接口与 `assertYayaRunActive` 钩子对接，正式路径 fail closed）。
- UI1 聊天界面与 adapters：NOT_IMPLEMENTED。
- 真实浏览器闭环、移动端与消息落库（运行不代 UI 保存消息）：NOT_RUN。
- 90 秒无数据连接限制只按引擎 deadline 与逐条 flush 装置证明；未做真实代理长连接浸泡。

## 8. 停止与转交

- TOOLS1：`createYayaRunDependencies(state, { write: { write_tools, proposeWrite } })` 绑定真实写工厂；
  保存前在**同一 TransactionClient** 调 `assertYayaRunActive(client, run_id, owner_instance)`。
- UI1：只消费 API0 协议与三条路由，不自行放宽事件解析；`unverifiable` / `service_failure` 必须如实展示。
- 本任务到此停止：不实现 TOOLS1 / UI1，不部署、不 push、不合并 `main`，等主评审。
