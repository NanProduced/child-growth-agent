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

## 9. R1 返修：动态投影、终态发布与恢复核验边界

起点 `813d656c2480b2b1fe1172bdee10e070c46a9e79`（主评审结论见 `REVIEW.md` 的 P1-A/P1-B/P2-C/P2-D）。
只改 APP1 runtime、专属检查与本文件；**DDL 未改**（投影/快照放在既有 `dependencies` jsonb 内）；
未改 TOOLS1/DATA 审批/UI/冻结 types/API0/内核/gateway/llm/AUTH/MEDIA/READ1/harness/package/lock。

### 9.1 修复内容与 RED→GREEN

**A（P1-A）投影等级快照，降级不得继续消费旧完整数据**

- `YayaRunDependency` 增加 `projection: full | historical_read_only | any`；READ1 负载
  （`get_observation` 观察行 / `list_observations` 逐条，穿透内层 `data` 信封）记录实际加载投影。
- 重核：要求 `full` 的观察引用在当前只剩 `historical_read_only` 时判 `context_revoked`；
  合法历史只读最小查询保持可用；运行消费、终态查询、终态回放共用同一重核。
- 缺 `projection` 的旧 run 快照一律保守不可核验，不补造历史。
- RED（原候选）：full 加载 → 转班仅剩历史只读 → 仍 `answered`，查询恢复返回旧 AI 工作流标记
  （`answer_emitted=true / private_marker_returned=true`）。
- GREEN：运行中降级 → `stopped(context_revoked)`、无 answer 事件、模型调用关闭；
  完整回答完成后再撤权 → 查询 `unverifiable(terminal_unreadable)`、同键回放 409 `source_conflict` 且 0 次重派发；
  恢复授权后查询/回放恢复；历史只读正例照常回答且模型上下文中不含完整私有字段；
  旧快照缺 `projection` 时查询不可核验，恢复快照后重新可读。

**B（P1-B）终局事件在持久化裁决后才发布**

- 引擎终局事件（`answer`/`clarify`/`proposal_prepared`/`stopped`）暂存不发，非终局进度照常逐条 flush。
- `finalizeYayaRun` 改为同一短事务：`verify(client)` 身份重核 + 条件更新原子核对
  `state='active' AND owner_instance`、取消、替换、deadline；取消/替换/到期时成功候选改落
  `stopped(cancelled|run_replaced|deadline)`。
- 落账成功后只从**已持久化终态**构造终局事件与唯一 `run_end`；写失败 → 中断标记 + 协议停止终态，
  绝不先显示成功再改失败；已持久化终态后的取消只记标记，不回溯改写。
- RED（主评审探针）：answer 已发送、终态 UPDATE 被真实 PG 触发器拒绝后又发 stopped run_end，
  冻结 API0 判 `contradictory_terminal`。
- GREEN：整条 NDJSON 逐行 API0 校验通过、无 answer、唯一 `stopped(model_failed)` run_end、DB `interrupted`、
  查询 `unverifiable`；保存边界取消/替换/到期的成功候选一律不落账，合法停止原样落账；
  身份重核在落账事务内可见 `session_invalid`/`account_disabled`；正常候选成功对照通过。

**C（P2-C）历史重核脱离 20 条分页窗口**

- 模型历史加载仍保留 20 条上限；重核改为按本 run 登记的 `message_id/fragment_id` 精确读取，
  用 DATA `projectMessageRow` 重跑当前投影。
- RED：追加 21 条正常消息后，原可读片段被误判不可核验（`ok=false`）。
- GREEN：分页窗口外但未删、未坏、未撤权的片段继续通过；模型注入仍 ≤20 条；
  删除 / 片段损坏 / 来源撤权分别保守拒绝，恢复后重新通过。

**D（P2-D）损坏依赖不再吞成空集合**

- 依赖逐条严格校验：来源 kind 必须在冻结枚举、字段类型正确、`message_id`/`fragment_id` 成对、
  `projection` 必填；任一条坏 → 整组 `dependencies_corrupt`（不丢条后假装完整）。
- 行存在但不可读（依赖损坏/缺快照、核心字段不可解析）→ `unverifiable`，不归 `missing`；
  仍只用既有 `service_failure`/`unverifiable` 语义，未新增第六种查询状态。
- `appendYayaRunDependencies` 检测到损坏时不再覆盖写入，绝不“修复式”抹掉损坏证据。
- RED：`dependencies=[{unexpected:true}]` 被解析成 0 依赖且重核 `ok=true`。
- GREEN：解析标记损坏、查询不可核验、append 拒绝覆盖（DB 原样保留），恢复合法依赖后重新可读；
  合法空集合与损坏集合严格区分。

### 9.2 R1 文件清单（在原 13 个交付文件基础上）

| 文件 | 变更 |
|---|---|
| `src/lib/yaya/agent/runtime/store.ts` | 依赖投影快照 + 严格解析/损坏标记；行三态；append 损坏保护；finalize 同事务边界（verify + 取消/替换/到期裁决） |
| `src/lib/yaya/agent/runtime/identity.ts` | 抽出池/事务共用的边界身份重核；`verifyYayaRunBoundaryIdentity` |
| `src/lib/yaya/agent/runtime/context.ts` | 投影等级重核；历史片段精确读取重投影；损坏依赖保守停止 |
| `src/lib/yaya/agent/runtime/deps.ts` | READ1 负载投影等级登记（含内层 data 信封） |
| `src/lib/yaya/agent/runtime/service.ts` | 终局事件暂存/持久化后发布；finalize 边界；不可读行查询语义 |
| `scripts/yaya/check-agent-app1.ts` | 原 78 项保留 + 46 项 R1 正反例 |
| `docs/yaya-v1/agent-app1-delivery.md` | 本 R1 章节 |

未改 DDL：`scripts/upgrade-yaya-runs-v1.sql` 与表结构不变。

### 9.3 R1 验收（本候选实跑）

| 检查 | 结果 |
|---|---|
| 专属验收 `pnpm exec tsx scripts/yaya/check-agent-app1.ts` | **124/124**（原 78 全部保留 + R1 新增 46），`failures: []`，清理闸门通过 |
| `pnpm validate` | 通过 |
| `pwsh scripts/build.ps1`（Next build + tsup） | 通过 |
| check-preflight / check-contract / check-api-contract | 15/15 / 68/68 / 57/57 |
| check-agent-engine / check-agent-llm | 29/29 / 7/7（`real_model_requests: 0`） |
| check-tools-read / check-data / check-media | 189/189 / 27/27 / 28/28 |

分层（同 9 节）：真实 next dev HTTP、真实 AUTH 登录/会话/CSRF、一次性隔离 PG、真实 DATA/READ1/sharp+本地对象根、
真实 PG 触发器故障注入；模型替身为本地 StepFun 协议服务（真实 `llm.ts` 路径）；真实 provider/搜索/S3/托管库请求 0。
未新增真实模型额度消耗。生成物已还原、容器/媒体根/进程树清理闸门通过。

NOT_RUN 同 §7：真实模型质量、真实浏览器、生产迁移/部署、代理长连接仍不在本轮。

## 10. R2 返修：收紧共享保存边界与解析器

起点 `722b8fab26ab5be2be712b3999cb686f5e9f4bbf`（主评审 P1-A/P1-B/P2-C 见 R1 评审记录）。
只改 APP1 runtime、专属检查与本文件；**无 DDL 变更**；冻结类型/API0/内核/LLM/AUTH/DATA/MEDIA/READ1/harness/package/lock 未改；
未新增审批框架、状态库或全局锁；模型调用保持事务外；API 流仍唯一一致终态、结果未知只查原身份、不重发。

### 10.1 RED→GREEN

先按真实时序反例入库（两连接行锁交错、真实 `startYayaRun` + READ1 + 锁内转班、纯解析反例），
在原候选上实测 RED：`131/139`，失败 8 项；
再修共享根因后 GREEN：`139/139`，`failures: []`，清理闸门通过。

| 场景 | RED（R1 候选实测） | GREEN（R2 实测） |
|---|---|---|
| 最后保存身份边界 | 身份核验先于 run 行锁；锁等待期间撤销已提交仍落账 answered | 身份阶段先取账号→会话共享锁（AUTH 同序），持锁至终态提交；锁等待期间的会话撤被串行化到原终态之后，提交后撤销才生效 |
| 最后保存来源边界 | 真实 `startYayaRun` 完整投影 → 终态 UPDATE 等锁 → 转班 → 仍发布私有标记 answer | run 行锁等待完成后，以**同一 client**重跑全部已装载来源/历史/图片投影；降级即 `stopped(context_revoked)`，无 answer |
| 到期判断 | `deadline_at <= now()`（事务开始时刻）：锁等待跨过期限仍落 answered，`terminal_at` 还早于 deadline | 取得 run 行锁后按 `clock_timestamp()` 裁决；跨期限落 `stopped(deadline)`，`terminal_at` 反映实际裁决时刻 |
| 保存 hook 期限 | 已过期 active run 返回 allowed | `assertYayaRunActive` 取得行锁后按实际时刻判期限并拒绝 |
| 严格解析 | 非法 ref + 合法 message/fragment（或 image）并存时非法 ref 被吞成 null，整条通过 | 非空 ref 解析失败即整组 `dependencies_corrupt`；合法 `ref=null`+image 与合法 ref+message/fragment 对照仍有效 |

### 10.2 实现要点

- `store.ts::finalizeYayaRun` 同一短事务顺序：`verify` 身份阶段 → `SELECT … FOR UPDATE` 等 run 行锁
  → `verifyProjections` 来源阶段 → 条件更新（active/owner_instance + 取消/替换/clock_timestamp 到期）；
  行已被外部终态化时返回已存终态；到期与 `terminal_at` 均用 `clock_timestamp()`。
- `identity.ts`：`resolveYayaRunBoundaryIdentity` 以 AUTH 锁序（账号→会话）取共享行锁并重核身份；
  `boundaryStopForIdentity` 统一身份结论；引擎边界的 `resolveCurrentIdentity` 保持无锁快路径。
- `context.ts`：抽出 `revalidateYayaRunContextWithClient`（资源事实、历史投影、图片授权全部走同一 client），
  引擎异步边界包一层短事务复用同一核心；图片重核用 `bindDataAttachmentMetadataPort(client)` 与同事务记录授权事实。
- `dependencies` 快照解析：`ref=null`（合法空）与非空 ref 解析失败严格区分；未知 kind/缺字段/非法类型不因其他选择器合法而豁免。
- 正常成功、合法停止、已持久化终态后的取消不回溯、fallback 已存终态发布分支全部共用同一核验。

### 10.3 R2 文件清单（在 R1 七文件基础上）

| 文件 | 变更 |
|---|---|
| `src/lib/yaya/agent/runtime/store.ts` | finalize 锁序与双阶段核验；clock_timestamp 到期/时间；hook 锁后判期限；非空 ref 严格解析 |
| `src/lib/yaya/agent/runtime/identity.ts` | 账号→会话共享锁的边界身份核验与结论导出 |
| `src/lib/yaya/agent/runtime/context.ts` | 同 client 重核核心（资源/历史/图片）与引擎包装 |
| `src/lib/yaya/agent/runtime/service.ts` | 保存边界绑定身份+投影双阶段；查询重核异常保守不可展示 |
| `scripts/yaya/check-agent-app1.ts` | 原 139 项（R1 后）新增 14 项 R2 正反例；R1-C 撤权对照改用当前数据库事实 |
| `docs/yaya-v1/agent-app1-delivery.md` | 本 R2 章节 |

`deps.ts`、迁移与表结构在本轮未改。

### 10.4 R2 验收（本候选实跑）

| 检查 | 结果 |
|---|---|
| 专属验收 | **139/139**（原 78 + R1 46 + R2 14），`failures: []`，清理闸门通过 |
| `pnpm validate` / `pwsh scripts/build.ps1` | 通过 |
| check-preflight / contract / api-contract | 15/15 / 68/68 / 57/57 |
| check-agent-engine / agent-llm | 29/29 / 7/7（`real_model_requests: 0`） |
| check-tools-read / data / media | 189/189 / 27/27 / 28/28 |

分层同 §9：真实 next dev HTTP、真实 AUTH/PG/DATA/READ1/sharp+本地对象根、两连接真实行锁交错与真实
`startYayaRun` 交错；模型替身为本地 StepFun 协议服务（真实 `llm.ts` 路径）；真实 provider/搜索/S3/托管库请求 0，
新增 20 次真实额度未动。清理精确核验通过（容器/媒体根/进程树/两连接客户端/生成物还原）。

NOT_RUN 同 §7/§9。

## 11. R3 返修：锁等待窗口的会话到期、已存终态发布与来源权限前提

起点 `62cc3b784d5cb06764e605f3432229e6412a761e`（主评审 P1-A/P1-B/P1-C）。
只改 APP1 runtime 三文件、专属检查与本文件；**无 DDL 变更**；冻结类型/API0/内核/LLM/AUTH/DATA/MEDIA/READ1/
harness/package/lock 未改；模型调用保持事务外；API 流仍唯一一致终态、结果未知只查原身份、不重发。

### 11.1 RED→GREEN

先按三条 P1 的真实时序反例入库（会话 TTL 跨 run 锁等待、peer 已存终态+转班、多来源共享锁窗口转班），
在原候选上实测 RED：`158/164`，失败 6 项（A 跨期 3、B 已存终态 1、C 多来源 2）；
修三处共享根因后 GREEN：`164/164`，`failures: []`，连续两轮实跑（run_id `agent-app1-muxsk8rp-01ffbb4e`、
`agent-app1-muxslglf-6465c067`）。调试期临时插桩（pg_locks/pg_stat_activity/终态行打印）已全部移除并复跑确认；
`pnpm validate` 与 `pwsh scripts/build.ps1` 通过。

| 场景 | RED（R3 反例实测） | GREEN（R3 实测） |
|---|---|---|
| A 会话墙钟跨锁等待（P1-A） | run 行锁等待跨过会话自然到期，保存边界仍按进入时身份发布 answer；落账裁决时刻与查询口径跟随旧身份 | 来源重核完成后、提交前再跑一次边界身份核验（覆盖锁等待期到期），降级 `stopped(session_invalid)` 且无 answer；`terminal_at` 为实际裁决时刻且晚于 `expires_at`；查询口径一致 |
| B 已存终态发布（P1-B） | peer 先落 `answered` 终态，本端发布分支不经当前授权直接发布 fallback 私域内容 | 发布分支对**落库行**（stored/fallback）跑 `withPrivateRead` + `runTerminalPresentable` 全量门禁，降级 `stopped(context_revoked)`；不覆盖 peer 已提交内容；查询 `unverifiable` 且不含标记 |
| C 来源权限前提持锁（P1-C） | 多来源等待窗口内转班可提交，前项已核验来源的权限前提只在核验瞬间成立 | 观察/幼儿资源事实先取 `children FOR SHARE` 再读归属并持到提交；实测 finalize 卡在后项来源（childC 历史片段）共享锁期间，转班被 childA 共享锁挡住；转班提交晚于 `terminal_at`（同一 DB 时钟）；对照：转班先提交 → `stopped(context_revoked)` 无 answer |

### 11.2 实现要点

- `service.ts`：`verify` 与 `verifyProjections` 均走 `verifyYayaRunBoundaryIdentity`；`verifyProjections`
  顺序 = `boundaryStopForIdentity` 优先停止 → `revalidateYayaRunContextWithClient`（run 锁等待之后、同一 client）
  → 结尾再身份核验一次（覆盖来源锁等待期间的到期/撤销）。
- 新增 `publishableOutcome(run, token, outcome)` 发布门禁：`stopped` 直通；其余必须过 `withPrivateRead` +
  `runTerminalPresentable`（false → `context_revoked`；`AccountsError` 映射 `account_disabled` /
  `identity_unavailable` / 其余 → `session_invalid`；其他异常保守 `context_revoked`）。
  两个内容发布点（stored 与 fallback）都传**落库行**——注册期 in-memory run 依赖为空，传它会漏核（B1 实测拦下）。
- `context.ts::readResourceFactsWith`：`observation` 分支拆为「读观察行 → children FOR SHARE → 读当前归属」，
  `child` 分支先 `FOR SHARE` 再读；锁自核验点持到事务提交，覆盖「读集合 → 写终态」窗口。
- `identity.ts`：assignments 更新 SQL 追加 `${lockSuffix}`，与保存边界共享锁同序。

### 11.3 专属检查装置要点（新增 25 项，139→164）

- **A1**：`directSession(ttl=10s)` + 两连接 `yaya_runs FOR UPDATE` 占位 → 实测剩余 >3000ms 进入边界、
  等待期到期、跨期后唯一 `run_end stopped session_invalid`（无 answer）、`terminal_at > expires_at`、查询口径一致。
- **B1**：可信 peer 先 `finalizeYayaRun` 落 `answered`（库内 marker）→ 转班 → 本端照常跑完；断言无 answer、
  `stopped(context_revoked)`、库内仍是 peer 内容、查询 `unverifiable` 不含 marker。
- **C1**：等到 **answer 的 `action_parsed`** 再抢 childC——首个 `action_parsed` 属 read，那时答案的发布前重核
  尚未经过，racer 会把锁窗口挪到引擎边界而非保存边界；run 行锁仍被测试占着，finalize 必然停在 run 锁上，
  释放后必然卡在 childC 共享锁。`pg_locks` 只认「已持有 children 元组锁且仍在等事务」的等待者，排除 run 行锁
  释放尾迹（否则转班会在 finalize 取得 childA 共享锁之前抢跑——插桩移除前的 162/164 实测抓到过该缺口）；
  时序断言用转班完成瞬间的 `clock_timestamp()` 与 `terminal_at` 同源比较（`children.updated_at = now()` 是
  转班事务开始时刻，不能证明提交顺序）。
- **C2 对照**：转班先提交 → 拒绝旧内容（`stopped context_revoked`、无 answer）。

### 11.4 R3 文件清单（在 R2 五文件基础上）

| 文件 | 变更 |
|---|---|
| `src/lib/yaya/agent/runtime/context.ts` | 资源事实 children 共享锁（child/observation 分支）持到提交 |
| `src/lib/yaya/agent/runtime/identity.ts` | assignments 更新追加 `${lockSuffix}` |
| `src/lib/yaya/agent/runtime/service.ts` | 双重身份核验 + `publishableOutcome` 全量发布门禁（stored/fallback） |
| `scripts/yaya/check-agent-app1.ts` | R3 三组正反例 25 项（139→164）；answer `action_parsed` 等待、精确锁等待探测、同源时序断言 |
| `docs/yaya-v1/agent-app1-delivery.md` | 本 R3 章节 |

`store.ts`、`deps.ts`、迁移与表结构本轮未改。

### 11.5 R3 验收（本候选实跑）

| 检查 | 结果 |
|---|---|
| 专属验收 | **164/164** 连续两轮，`failures: []`，清理闸门通过 |
| `pnpm validate` / `pwsh scripts/build.ps1` | 通过 |
| check-preflight / contract / api-contract 等分层检查 | 本轮未重跑（R3 未改其依赖面；R2 实测见 §10） |

分层同 §9/§10：真实 next dev HTTP、真实 AUTH/PG/DATA/READ1/sharp+本地对象根、两连接真实行锁交错；
模型替身为本地 StepFun 协议服务（真实 `llm.ts` 路径）；真实 provider/搜索/S3/托管库请求 0。
NOT_RUN 同 §7：真实模型质量、真实浏览器、生产迁移/部署、代理长连接仍不在本轮。

## 12. R4 返修：终态提交后，发布/恢复门禁的等待跨过会话到期

起点 `4631fc069e6dab00896b304c5df93a5aaa4124c6`（主评审 R3 报告 P1：发布门禁 `publishableOutcome` 进入
`withPrivateRead` 后，`runTerminalPresentable` 的来源重核等待（children/历史/图片锁）跨过会话自然到期，
仍发布正文/已存终态）。只改 APP1 runtime 的 `service.ts`、专属检查与本文件；**无 DDL 变更**；冻结
types/API0/内核/LLM/AUTH/DATA/MEDIA/READ1/harness/package/lock 未改；不新增认证框架/状态码/查询第六态/
全局锁或第二套授权规则；未回滚 R3 三项修复、未重做 C2 或 Agent 内核；不把只允许 active run 的保存钩子
用于已存终态；模型调用保持事务外；流保持合法、单一一致终局（不先发 answer 再改 stopped）。

### 12.1 RED→GREEN

先按真实时序反例入库（真实终态提交后，发布/恢复的来源核验用独立连接持 child 行锁实测等待，
等待开始时会话有效、放行前用真实墙钟到期），在起点实测 RED：`178/182`，失败 4 项（live 发布、
已存终态发布、GET 恢复、同键回放）；原 164 项全部保留通过。在共享可呈现边界修一处根因后 GREEN：
`182/182`，`failures: []`，连续两轮干净实跑（run_id `agent-app1-muxvstta-ea1adf4b`、
`agent-app1-muxvxnr8-ab76bfc0`；插桩期一轮亦 182/182，`agent-app1-muxvman0-dd6f0fb3`）。
调试期临时插桩（stage 标记、`SET lock_timeout`）已全部移除并复跑确认。

| 场景 | RED（R4 反例实测） | GREEN（R4 实测） |
|---|---|---|
| live 发布（D1） | 自身 finalize 已提交后，发布门禁的来源重核等待 childA 共享锁；等待期会话到期，放行后仍发 answer + 合成私域标记 | 全部来源异步核验完成后按当前事实再核身份（AUTH 只读守门）；到期 → `stopped(session_invalid)`、无 answer；已提交 answered 记录与回执不变、模型恰 2 次 |
| 已存终态发布（D2） | 可信 peer 先提交 answered 终态，本 run finalize 停在 run 锁；放行后发布门禁等待来源锁期间到期，仍发布 peer 标记 | 同一共享守门：到期 → `stopped(session_invalid)`、无标记；库内 peer 终态不变；对照（未跨期）正常发布标记 |
| GET 恢复（D3） | 查询恢复的来源核验等待 childA 期间到期，放行后仍返回旧正文（200 + 标记） | 到期 → `401 unauthenticated`、无标记（不冒充 missing/空数据/成功） |
| 同键回放（D4） | 同 `client_request_id` 终态回放等待期间到期，放行后仍回放旧内容 | 到期 → `401 unauthenticated`、无标记 |
| 正向对照 | — | 同 owner 新会话合法恢复（200 + 标记）；过期令牌查询 401；原 164 项（A/B/C 与全部回归）通过 |

### 12.2 实现要点

- `service.ts::runTerminalPresentable`（live/stored/fallback 发布、GET 恢复、同键回放共用的唯一可呈现边界）：
  来源层级重核（`revalidateYayaRunContext`，含 children/历史/图片锁等待）完成后，**再** 以 `withPrivateRead(carrier)`
  按当前事实核当前会话/账号/身份（复用既有 AUTH 私有读守门与错误语义；与引擎边界在重核收尾处再次 `guardRun`
  的既有规则一致）。`AccountsError` 原样抛出：发布路径按既有 `publishableOutcome` 映射落到 `session_invalid` 等；
  查询/回放路径按既有 401/403 语义；非 AUTH 异常保守不可呈现。
- 进入时的 principal 与 `session_valid=true` 仅作核验输入，不再作为发布/恢复时刻的身份依据；合法终态与
  合法恢复不受影响（不判 `run_replaced`、不关闭终态发布）。

### 12.3 专属检查装置要点（新增 18 项，164→182）

- **D1（live 发布跨期）**：`directSession` TTL 先收紧到 6s、**先于** finalize 的 verify（其会话 FOR SHARE 会挡
  行更新、run 锁/来源锁交错会让测试自锁——插桩实测抓到并修正）；等 answer 的 `action_parsed` 后：childC 行锁
  把 finalize 卡在来源重核（同 R3 锁序），run 锁放行后 finalize 提交；racer2 排在 finalize 的 childA 共享锁
  之后接住 childA → 发布门禁来源核验实测等待（`pg_locks` 未授予 + `pg_blocking_pids` 精确指向阻塞方）。
  等待开始时会话有效、放行前到期；到期后无 answer/标记、唯一 `run_end stopped session_invalid`；
  库内 answered+标记不变、模型恰 2 次；过期令牌查询 401；同 owner 新会话恢复 200+标记。
- **D2/D2b（已存终态发布）**：peer 以真实 `finalizeYayaRun` 先提交终态、run 锁占位（本 run finalize 停在锁上、
  引擎按 `run_replaced` 停止）；racer 持 childA；放行后发布门禁实测等待。到期版拒绝发布（无标记、库内 peer
  终态不变）；未跨期对照正常发布标记。
- **D3（GET 恢复跨期）**：对已存终态 run 实测恢复来源等待期间到期 → 401 unauthenticated、无标记。
- **D4（同键回放跨期）**：同 `client_request_id` 同内容回放，等待期间到期 → 401、无标记。
- **D5 对照**：同 owner 新会话合法恢复已存终态（finished + 标记）。

### 12.4 R4 文件清单（在 R3 五文件基础上）

| 文件 | 变更 |
|---|---|
| `src/lib/yaya/agent/runtime/service.ts` | `runTerminalPresentable`：全部来源异步核验完成后按当前事实再核身份（共享边界单点修复，+13 行） |
| `scripts/yaya/check-agent-app1.ts` | R4 正反例 18 项（164→182）：live/stored 发布、GET 恢复、同键回放的提交后到期与正向对照 |
| `docs/yaya-v1/agent-app1-delivery.md` | 本 R4 章节 |

`context.ts`/`identity.ts`/`store.ts`、迁移与表结构本轮未改。

### 12.5 R4 验收（本候选实跑）

| 检查 | 结果 |
|---|---|
| 专属验收 | **182/182** 连续两轮干净实跑，`failures: []`，清理闸门通过 |
| `pnpm validate` / `pwsh scripts/build.ps1` | 通过 |
| API0 `check-api-contract` / Agent engine | 57/57 / 29/29（`real_model_requests: 0`） |
| 契约回归 `check-contract` / `check-preflight` | 68/68 / 15/15 |
| `git diff --check` | 通过 |

分层：同一 182 套件（真实 next dev HTTP、一次性隔离 PostgreSQL、真实 AUTH 会话/CSRF、真实两连接行锁交错、
本地 StepFun 协议替身模型走真实 `llm.ts` 路径）；真实 provider/搜索/S3/托管库请求 0，不新增 20 次真实额度。
主评审旧诊断 `publish-expiry-r3.ts` 与 `probes.ts` C 段未在本轮运行或作为判据（前者为 R3 观测用；后者时序已不适用）。
仓库内不存在 `RTK.md`（按纪律记录，未补造）。

NOT_RUN 同 §7/§9：真实模型质量、真实浏览器、生产迁移/部署、代理长连接；DATA/TOOLS/UI 正式组合接线不在本轮。
