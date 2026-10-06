# 芽芽 v1 可序列化 HTTP / 事件协议（api-contract-v1）

2026-10-06，YAYA-API0（含 R1 返修），基线 `24b0588c07ce68968178660ba7dc1382292e8bdc`（YAYA-CORE-INTEGRATE1 候选）。
本文件是**接口协议**，不是实现：正式运行 API 归 AGENT-APP1，`operations` POST 归 TOOLS1；UI1 只消费，不自行修改或 fork。
运行时代码：`src/lib/yaya/api-contract.ts`；纯检查：`scripts/yaya/check-api-contract.ts`（57 项，含真实 browser-target 打包检查，reference_only）。

冻结口径（`contract-v1.md` / `src/lib/yaya/types.ts`）不变；本协议只做**可序列化外壳**：
`YayaRunRequest` 的 `signal` / `onEvent` 是进程内对象，不能 JSON 化，浏览器请求使用本协议的 `YayaRunStartRequest`，
run_id 由服务器建立。事件种类 / 停止原因 / 提案 / 回执 / 查询结论全部复用冻结类型，不维护影子协议。

浏览器消费边界：协议层是 UI1 可直接打包的纯模块，不导入 `node:crypto` / Next / 数据库 / 模型模块；
摘要只做格式校验（内联实现，不导入服务器侧 `storage-types`），摘要计算仍归服务器。检查含真实 esbuild
`platform=browser` 打包（不使用 polyfill、不新增依赖）。

## 1. 接口路径表

| 方法 | 路径 | Owner | 语义 | 状态 |
|---|---|---|---|---|
| POST | `/api/yaya/conversations/{conversation_id}/runs` | AGENT-APP1 | 发起运行；请求体 `YayaRunStartRequest`；响应为 NDJSON 事件流 | 第二波契约（未实现） |
| GET | `/api/yaya/conversations/{conversation_id}/runs?client_request_id={id}` | AGENT-APP1 | 原运行查询（首响应丢失时按 owner 绑定定位）；只读 | 第二波契约（未实现） |
| POST | `/api/yaya/runs/{run_id}/cancel` | AGENT-APP1 | 取消该 run 的后续派发 / 消费 | 第二波契约（未实现） |
| GET | `/api/yaya/operations?operation_id=` / `?batch_id=` | DATA1 | 原操作 / 批次查询（已发布，语义不变） | 已实现 |
| POST | `/api/yaya/operations` | TOOLS1 | 授权执行已批准操作；最小请求 `YayaOperationsExecuteRequest` | 第二波契约（未实现） |
| POST | `/api/yaya/proposals/{proposal_id}/approval` | DATA1 | 可信批准入口（已发布，`{action, operation_ids}`，其余字段净身丢弃） | 已实现 |

错误体沿用：DATA `YayaDataErrorBody { error, message, details? }`、AUTH `mapAccountsError`、MEDIA `mediaErrorBody`。

## 2. 发起会话 run

请求（严格对象；未知字段 / 权威字段 / 秘密字段一律拒绝）：

```json
{
  "conversation_id": "0f0f...",
  "client_request_id": "c7f5b0e2-...-stable-retry-id",
  "user_text": "小满今天搭积木很专注，帮我整理一下观察记录",
  "attachment_ids": ["a1c1..."],
  "expected_conversation_revision": 7
}
```

- `client_request_id`：客户端生成并跨重试保持稳定；首响应丢失时用它查回原运行，**不要求客户端先拿到 run_id**。
- `attachment_ids`：至多 8 张（与 MEDIA 上传限额同源），不得重复；文字与图片至少提供其一。
- `expected_conversation_revision`：必要版本前提；不一致按 409 处理（沿用 DATA 语义）。
- 不接受 `principal` / `role` / `scope` / `school_id` / `approval*` / `approved` / `csrf*` / 密码令牌等任何自报字段（含嵌套键）。

响应：HTTP 200 + `Content-Type: application/x-ndjson; charset=utf-8`，每行一个事件（见 §4）。
响应头未发送前的失败用 HTTP 错误（401/403/404/409/503，冻结错误体）；流开始后失败只能是显式终态事件。

## 3. 原运行查询与取消

查询只读：不启动模型、不执行旧批准、不产生业务写、不续期。五态分开：

```json
{ "status": "missing" }
{ "status": "in_progress", "run_id": "..." }
{ "status": "finished", "run_id": "...", "outcome": { "kind": "answered", "content": "...", "sources": [] } }
{ "status": "unverifiable", "reason": "owner_binding_failed" }
{ "status": "service_failure" }
```

- owner 绑定核不上（`owner_binding_failed`）或终态记录不可读 / 不合法（`terminal_unreadable`）→ `unverifiable`；
- 数据库 / 服务失败是 `service_failure`，**绝不冒充** `missing`；
- `finished` 只返回冻结 `YayaRunOutcome`，未知结果只核原身份，**不自动重发 POST**；
- `finished` 的 `stopped.detail` 与实时事件同口径，统一替换为 `safeYayaStopDetail` 协议文案，不回传内部异常文本；
- 响应解析只扫描秘密字段，不套用请求的伪造权威字段（`content_digest` / `actor_account_id` 等是合法响应字段）。

取消（请求体必须为空；run_id 在路径）：

```json
{ "run_id": "..." , "status": "cancel_requested",
  "stops_subsequent_dispatch": true,
  "rolls_back_committed_business": false,
  "upstream_http_cancel_verified": false }
```

取消只停止该 run 后续派发 / 消费；不宣称撤销已提交业务，也不保证上游物理请求已经取消。
首响应丢失时先查询（§3）拿到 run_id 再取消，两条路径都不会触发模型或业务写。

## 4. 事件传输（NDJSON，固定）

- 传输：`application/x-ndjson`；每行一个 JSON 对象；`\n` 结尾；不使用 WebSocket。
- 信封：`protocol: "yaya-run-events-v1"`、`run_id`、`seq`（从 1 严格连续递增）。
- 事件种类：冻结 `YayaAgentEvent` 全部（`run_started` / `model_attempted` / `model_completed` /
  `action_parsed` / `tool_result` / `public_search_refused` / `proposal_prepared` / `answer` /
  `clarify` / `receipt` / `stopped`）+ 线协议终态 `run_end`。
- 结束形态：每个流恰好一个 `run_end`，`outcome` 为冻结 `YayaRunOutcome`（answered / clarified / proposed / stopped），
  必须与已发布事件一致：回答正文、澄清问题、停止原因逐一对照；提案按**完整业务内容**（proposal/batch 身份、
  动作/资源、逐项 item_key/target/content_digest、附件关联、payload 全部字段）语义深比较，键顺序无关；
  同 `proposal_id` 但内容不同、或同 id 重复/歧义，一律判矛盾，不得折叠成一致。
- 回执事件：成功声明（saved / saved_detail_unavailable）必须通过冻结 `receiptProvesSuccess`（`effect=committed` +
  非空业务标识）；`effect=unknown` 或空标识一律 `unverified_success`；回执身份与原操作不一致、同一操作回执矛盾分别拒绝；
  完全相同结果的重复回执是合法幂等重放。
- 不承诺字符级模型流：`model_completed` 是整段响应；无 token/delta 事件。
- 失败投递：`selectYayaRunFailureMode(headersSent)` → 头未发 `http_error`，流已开始 `terminal_event`
  （中途失败不能伪装成 HTTP 503）。
- 不展示未经校验的模型原始 JSON / 内部异常栈：`stopped.detail` 由 `safeYayaStopDetail(reason)` 固定文案替换；
  UI1 渲染前必须用 `parseYayaRunWireLine` 逐行校验，坏行 / 未知字段 / 未知协议一律拒绝。

示例（成功回答）：

```
{"protocol":"yaya-run-events-v1","run_id":"run-1","seq":1,"type":"run_started"}
{"protocol":"yaya-run-events-v1","run_id":"run-1","seq":2,"type":"model_attempted","attempt":1}
{"protocol":"yaya-run-events-v1","run_id":"run-1","seq":3,"type":"model_completed","provider":"stepfun","model":"...","usage":null}
{"protocol":"yaya-run-events-v1","run_id":"run-1","seq":4,"type":"action_parsed","action":"answer","tool":null}
{"protocol":"yaya-run-events-v1","run_id":"run-1","seq":5,"type":"answer","content":"小满今天很专注。","sources":[{"kind":"model_text","ref_id":null,"label":null,"derived_from":null}]}
{"protocol":"yaya-run-events-v1","run_id":"run-1","seq":6,"type":"run_end","outcome":{"kind":"answered","content":"小满今天很专注。","sources":[...]}}
```

示例（提案，等待教师批准）：

```
{"protocol":"yaya-run-events-v1","run_id":"run-1","seq":2,"type":"proposal_prepared","proposal":{...YayaOperationProposal...}}
{"protocol":"yaya-run-events-v1","run_id":"run-1","seq":3,"type":"run_end","outcome":{"kind":"proposed","proposals":[{...}]}}
```

示例（取消后的停止终态）：`stopped` 事件 + `run_end{kind:"stopped",reason:"cancelled"}`
（detail 为协议文案，不含内部文本）。

## 5. 批准与执行

- 批准沿用 DATA 入口 `POST /api/yaya/proposals/{id}/approval`：只认 `{action:"approve"|"reject", operation_ids}` 或 `{action:"cancel"}`；
  `approved` / `principal` / `approval_source` / 摘要 / 资源事实等自报字段由 `normalizeApprovalAction` 净身丢弃，
  不是批准证明。operation 身份在 DATA prepare 时预分配（proposal_id / batch_id / 每项 operation_id）。
- TOOLS1 执行入口 `POST /api/yaya/operations` 最小请求：`{ "approval_id": "...", "operation_ids": ["..."] }`；
  提交者身份 / 会话 / CSRF / 执行时刻由服务端解析（`YayaApprovalSubmitter`），不得自报；
  请求体 `approved`、模型输出、本地 runtime tool part 都不是批准证明。
- 最小响应：`{ "receipts": [YayaOperationReceipt, ...] }`，非空；结构解析之后必须走语义核验
  `assessYayaOperationsExecutionResponse(plan, body)`（复用冻结 `compareBatchReceipts` / `queryOperationOutcome` /
  `receiptProvesSuccess` / `itemsToResend`）：
  - 成功声明必须满足 `receiptProvesSuccess`；`saved + effect=unknown + 空业务标识` 结构合法但判 `unverified_success`，
    不能渲染为已保存；
  - 对照 DATA prepare 的完整预期计划：缺项 `response_incomplete`、身份错配（错 batch/proposal/item/target/actor 或多出）
    `response_identity_mismatch`、矛盾回执 `contradictory_receipt`，任一存在都不能渲染全成功；
  - 合法的 failed / in_progress / unknown 与 `unchanged` 保留在 `comparison` / `outcomes` 中；合法幂等重复回执允许；
    `explicit_resend_candidates` 只含“明确失败且确认无效果”的显式候选，协议不自动重发。
- 未知结果只按原 operation_id 查询（DATA GET）；协议不自动重发任何 POST。

## 6. 密码相关管理动作

只返回安全控件意图 / 目标，不接受也不返回任何秘密字段：

```json
{ "secure_control": "teacher_password_reset", "target_account_id": "teacher-2", "secrets_in_protocol": false }
```

`projectYayaSecureControlIntent` 对输入做递归秘密字段扫描（password/passcode/secret/token/api_key/…）并拒绝；
密码由安全窗口直接提交服务端，不经过聊天、事件或任何请求 / 响应体。

## 7. 校验反例（check-api-contract.ts 实际覆盖）

| 类别 | 反例 | 判定 |
|---|---|---|
| 错形 | 缺 conversation_id / client_request_id / 版本前提；版本 0 或小数；client_request_id 超长 | `malformed_request` |
| 错形 | 空文字且无图片；附件重复 / 空串 / 超过 8 张；未知额外字段 | `malformed_request` |
| 错形 | 坏 JSON 行、缺信封、缺字段事件；空回执的执行响应 | `malformed_event` / `malformed_request` |
| 伪造 | run 请求带 `principal` / `role` / `scope` / `approval.approved` | `forged_authority_field`（含嵌套路径） |
| 伪造 | operations 带 `approved` / `actor_account_id` / `submitter`；DATA 净身丢弃自报字段 | 拒绝 / 不参与判定 |
| 秘密 | 请求或安全控件带 `password` / `api_key` | `secret_field_present` |
| 错 run | 事件 run_id 与预期或流内其他事件不一致 | `run_mismatch` |
| 协议 | `yaya-run-events-v2` | `unsupported_protocol` |
| 重复 | 序号重复 / 多个 run_end | `sequence_duplicate` / `duplicate_terminal` |
| 矛盾 | run_end 后有事件；回答 / 澄清 / 提案 / 停止事件与终态不一致 | `event_after_terminal` / `contradictory_terminal` |
| 中断 | 空流、首事件不是 run_started、缺 run_end、序号缺口 | `missing_run_started` / `missing_terminal` / `sequence_gap` |
| 查询 | 服务失败 vs 缺失 vs 运行中 vs 已结束 vs 不可核验 | 五态分开，服务失败不冒充缺失 |
| 查询 | `finished + proposed` 往返（含 `content_digest` / `actor_account_id`） | 响应解析只扫秘密字段，不误判伪造 |
| 查询 | 恢复路径 `stopped.detail` 带内部标记 | 统一替换为 `safeYayaStopDetail` |
| 回执 | `unknown` 不冒充成功；空业务标识的“成功” | `unverified_success` |
| 回执 | 回执身份与原操作不一致；同一操作回执矛盾 | `receipt_identity_mismatch` / `contradictory_receipt` |
| 回执 | 流回执 `saved + effect=unknown + 空标识` | `unverified_success`，不得当成功 |
| 执行 | POST 响应结构合法但未证明成功（`effect=unknown`） | `unverified_success`（结构解析与语义核验分开） |
| 执行 | 缺项 / 错 target / 错 actor / 错 batch / 矛盾回执 | `response_incomplete` / `response_identity_mismatch` / `contradictory_receipt` |
| 执行 | 合法 failed / in_progress / unknown / unchanged / 幂等重复 | 保留在 comparison / outcomes，不丢失 |
| 提案 | 同 `proposal_id` 但 batch / 目标 / 原文 / 摘要 / 附件改变 | `contradictory_terminal`（完整业务内容比对） |
| 提案 | 仅对象键顺序不同、语义一致 | 放行 |
| 提案 | 同 id 重复 / 歧义提案 | `contradictory_terminal`，不得折叠 |
| 幂等 | 完全相同结果的重复回执 | 合法幂等，放行 |
| 文案 | 停止详情携带内部异常文本 | 被 `safeYayaStopDetail` 替换 |
| 浏览器 | 协议层真实 esbuild `platform=browser` 打包 | 通过；无 `node:` 内置依赖链 |

## 8. 未实现接口清单与 NOT_RUN

未实现（明确 NOT_IMPLEMENTED，按 owner）：
- AGENT-APP1：`runs` 发起 / 查询 / 取消三条路由的正式装配、run 持久化与 client_request_id 绑定、事件流写出、运行期身份 / 来源重核接线；
- TOOLS1：`operations` POST 与同事务业务 callback、工具 registry、批准执行装配、密码安全窗口；
- UI1：消费本协议的 adapters 与界面。

NOT_RUN：真实认证 / HTTP / 浏览器、真实模型（含字符级流与真实取消）、真实数据库 / 对象存储 / 托管部署。
本文档与检查只证明**协议结构与纯函数判定**，不证明真实认证、真实 HTTP 或生产可用。
