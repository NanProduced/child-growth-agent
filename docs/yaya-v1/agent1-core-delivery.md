# YAYA-AGENT1-CORE 交付报告｜可运行的会话动作引擎

2026-10-06。状态：**核心完成**。只交付可运行引擎、模型兼容扩展与离线验收；
正式 TOOLS/DATA/MEDIA 装配、业务 routes 与 UI 不在本轮（第二波），不宣称整站 chat 完成。

- 共同基线：`11f87ab0d2224d273696ecb86a544768eb014f39`
- 分支/工作树：`codex/yaya-agent1-core`，`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-yaya-agent1-core`
- **实现提交（完整 SHA）：`dfbdca3bc425610728fe2b532ba6040d5ebb6163`**（本文档提交只含文档）
- `scripts/harness-safety.ts` blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 未改（check-preflight 断言）
- RTK：本机存在（`C:\Users\nanpr\.cargo\bin\rtk.exe`），非缺失；仅记录
- 真实模型预算 40/40 未动；**真实 provider/搜索/S3/DB 请求 0**；未读 `.env`；未改 package/lock
- 未新增产品 test 开关；测试替身全部在 `scripts/yaya/check-agent-*.ts` 内

## 1. 交付文件与导出

| 文件 | 内容 |
|---|---|
| `src/lib/llm.ts`（扩展） | `LlmChatMessage`/`LlmChatImage`/`LlmChatOptions`/`LlmChatResult`、`invokeChatLlm`、`buildCozeChatMessages`、`imageDataUri`、`LlmUnsupportedCapabilityError`、`LlmAbortedError`；原 `invokeLlm` 与 6 类 strict schema 未动 |
| `src/lib/yaya/agent/types.ts` | 动作 schema、事件、身份/上限/预算、工具白名单与参数端口、上下文/模型/依赖端口、恢复类型 |
| `src/lib/yaya/agent/prompt.ts` | 芽芽系统指令、动作协议、六来源分区与消息组装、工具结果不可信信封格式 |
| `src/lib/yaya/agent/gateway.ts` | `createLlmYayaModelGateway()`：`invokeChatLlm` + 动作 wire format |
| `src/lib/yaya/agent/engine.ts` | `runYayaAgent`、`recoverYayaOperations`、`verifyRecoveredOutcome`、有限等待/守卫/预算 |
| `src/lib/yaya/agent/index.ts` | 统一导出 |
| `scripts/yaya/check-agent-engine.ts` | 13 项真实引擎 + 替身验收（含 RED→GREEN） |
| `scripts/yaya/check-agent-llm.ts` | 7 项模型兼容回归（6 类 schema 哈希 + chat/图片/取消/usage） |
| `scripts/yaya/check-agent-prompt.ts` | 8 项 Prompt 内容评审（与执行守门分开） |

关键导出（`YayaAgentDependencies` 端口）：
`model`（`YayaModelGateway`）、`resolveCurrentIdentity`、`loadProjectedContext`、
`readTool`、`proposeWrite`、`queryOperation`、`publicSearchPolicy`、`tools`。
事件（`YayaAgentEvent`）：`run_started` / `model_attempted` / `model_completed` /
`action_parsed` / `tool_result` / `public_search_refused` / `proposal_prepared` /
`answer` / `clarify` / `receipt` / `stopped`。
终态：`answered | clarified | proposed | stopped(reason)`；停止原因 21 项见 types.ts。

## 2. 引擎语义

- 模型只能输出 `answer | read | clarify | propose_write`；`read`/`propose_write`
  先查工具白名单、再逐工具参数 schema 校验，非法动作在触达依赖端前停止。
- 数据驱动循环：工具结果以 `YayaUntrustedEnvelope`（`untrusted:true` + 服务端来源）
  作为数据反馈；验收证明第二次 read 的目标来自第一次结果（c2），非固定宏。
- 写入只准备：`proposeWrite` 返回的提案必须带预分配身份与 `model_suggestion` 来源，
  引擎只发布 `proposal_prepared` 事件后暂停；没有批准/执行/SQL/HTTP/密码端口。
- 每次 await、重试与派发前 `guardRun` 重核：取消、deadline、固定 `run_id`、
  身份状态、会话有效性、账号状态、账号一致性；不通过即停。
- 预算（默认）：`max_model_calls=8, max_tool_steps=4, max_tool_attempts=8,
  max_tool_retries=1, deadline=90s, model_wait=60s, tool_wait=30s`；
  失败、超时、重试与被拒绝的公开检索都计入尝试；等待有上界（无悬挂计时器）。
- 恢复：只按原 `operation` 查询；他人账号操作不触达存储；成功回执复核身份与
  成功证明，错配/缺证明降级 `unknown`；恢复不调用模型、没有任何执行端口。
- 多模态：只接受服务端授权字节（base64 + media_type），运行期拒绝混入
  `url/signed_url/key`；provider 不支持图片时 `LlmUnsupportedCapabilityError` → 终态
  `model_unsupported_capability`，零请求、不静默换 provider。
- 公开检索：默认关闭。仅服务端 `provider_enabled` + `scanChildIdentifiers` 返回
  `known_absent` 才调用；`unknown/present/disabled` 拒绝并作为数据反馈；
  模型自报字段被参数 schema 直接拒绝。

## 3. 模型兼容性（同 `llm.ts`，实际 provider 请求 NOT_RUN）

| 能力 | Coze（默认路径） | StepFun |
|---|---|---|
| 文本聊天 | `LLMClient.invoke`；动作协议由 Prompt 承载 + 应用 Zod | 同 `invokeLlm` 请求路径 + `response_format` |
| 结构化动作 | SDK 无 `response_format`/tools（tech0 结论不变）：Prompt + `yayaAgentActionSchema` | 应用自有 strict `json_schema`（`yaya_agent_action`）+ 同一 Zod |
| 图片输入 | `ContentPart[].image_url` 只填 base64 data URI（接口存在；真实视觉质量 NOT_RUN） | **显式 unsupported**，不换 provider |
| 取消传播 | `raceWithAbort` 停止等待（SDK 无 signal；上游物理取消 NOT_RUN） | `AbortSignal.any(timeout, caller)` 直达 fetch |
| usage | SDK 不暴露 → `null`（不填 0） | `payload.usage` 归一化，缺值 `null` |
| 原 6 类 strict schema | 未改（哈希回归） | 未改（哈希回归） |

## 4. 验收、反例 RED→GREEN 与计数

运行（工作树根目录，全部离线）：

| 命令 | 结果 |
|---|---|
| `pnpm ts-check` | exit 0 |
| `pnpm lint --quiet` | exit 0 |
| `pnpm exec tsx scripts/yaya/check-contract.ts` | 68/68（reference_only） |
| `pnpm exec tsx scripts/yaya/check-preflight.ts` | 15/15 |
| `node scripts/yaya/check-runtime-tech0.cjs` | `check-runtime-tech0 OK`（38 项） |
| `pnpm exec tsx scripts/yaya/check-tech0.ts` | OK（SDK 表面未变） |
| `pnpm exec tsx scripts/yaya/check-agent-engine.ts` | **13/13**，real_model_requests=0 |
| `pnpm exec tsx scripts/yaya/check-agent-llm.ts` | **7/7**，real_provider_requests=0 |
| `pnpm exec tsx scripts/yaya/check-agent-prompt.ts` | **8/8**，model_behavior=NOT_RUN |
| AI 回归：check-agent-flow 30/30、check-activity-support 19/19、check-growth-profile 13/13、check-ai-context 14/14、check-ai-quality-guard 8/8、check-organize-retry 9/9、check-teacher-clarify 13/13、check-stepfun-timeout 3/3（fetch 替身） | 全绿 |

RED→GREEN（RED 为显式弱实现计数，GREEN 为真实引擎同输入行为）：

| 场景 | RED | GREEN |
|---|---|---|
| 一般问答/空任教 | 拒绝或 10 字门槛 | answered，model=1 |
| 多人咨询/记录 | 提案即执行 | 咨询 answered 0 提案；明确记录 2 卡暂停 |
| 图片来源 | 转发签名 URL | `source_mismatch`，model=0 |
| 数据驱动 | 固定宏 c1 | 第二次读 target=c2，reads=2 |
| 非法动作/参数 | 直接派发 2 次 | 分别 `unknown_read_tool`/`invalid_params`/`invalid_action`，read=0 |
| 撤权 | 撤权后仍派发 | `session_invalid`，read=0 |
| 管理员教学 | 信模型成功文本 | `tool_unauthorized`，0 提案/0 回执 |
| 暂停批准 | — | `proposed`；模型文本不能产生 receipt 事件 |
| 迟到结果/重试 | 接受迟到、重试 2 派发 | `run_replaced`，read=1，retries=1 |
| 取消/永不 settle | 取消后仍消费 | `cancelled`/`deadline` ≤40ms，0 提案 |
| 请求/步数/尝试上限 | 只数成功 | steps=3 停、attempts 含失败 |
| 原 operation 恢复 | saved 即重放 | 只查询（query=4、model=0、无执行端口），错配降级 unknown |
| 来源错配/公开检索 | 任意来源、信模型自报 | `source_mismatch`、`invalid_params`；拒绝时 read=0 |
| 6 类 strict schema | — | 基线哈希不符即 RED（见 check-agent-llm.ts） |
| StepFun 图片 | 静默降级/换 provider | `unsupported`，fetch=0 |

替身计数（check-agent-engine 输出）：model=30、read=11、propose=3、query=4；均为进程内替身调用，非真实请求。
Prompt 评审只做静态口径核对，**不构成真实模型抗注入或行为合规证据**。

## 5. NOT_RUN 与边界

- 真实 Coze/StepFun 请求（文本/视觉/usage/流式/上游物理取消）：NOT_RUN，预算未动。
- 真实公开检索 provider 与去识别算法：NOT_RUN；引擎只做服务端结论守门。
- 隔离库/事务批准消费/回执持久化、S3、HTTP 路由、assistant-ui/UI、浏览器：NOT_RUN（归 DATA1/MEDIA1/TOOLS1/UI1）。
- `scripts/check-ai-quality.ts`（dotenv + `--real` 质量评测）未运行：会读 `.env` 并占用真实预算。
- 真实模型质量、抗注入与视觉判读质量：NOT_RUN。

停止点：核心交付完成，等整合给第二波共同基线；不自行装 TOOLS/业务 routes/UI，不 push/部署/merge main。
