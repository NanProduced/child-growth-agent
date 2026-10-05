# YAYA-TECH0｜聊天与多模态技术兼容性前置报告（PARTIAL）

状态：本轮为**离线前置核验**。未安装项目依赖、未改产品源码/共享类型/依赖锁、未读 `.env`、未对真实 provider/搜索/对象存储/托管库发起任何请求。真实协议、视觉质量、部署存储与浏览器联合验收均为 **NOT_RUN**，需追加预算与资源授权。

- 基线：`e8225f04918de2073e194cb199dc8cf1bcb7f38f`（工作树 `codex/yaya-tech0`，路径 `C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-yaya-tech0`）
- 固定装置：`scripts/harness-safety.ts` blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`，核验一致，未改动
- `RTK.md`：不存在（仅记录，未补造）
- 真实模型账本：仓库 `logs/ai-quality/budget.json` 仍为 `used=40,total=40`，本轮真实模型请求 0，未重置、未新建预算轮次

---

## 1. 推荐结论（供主评审）

**推荐 UI/runtime 组合（只装一套）**：

| 项 | 结论 |
| --- | --- |
| 库与版本 | `@assistant-ui/react` **精确 0.15.23**（peerDependencies `react ^18 \|\| ^19`，本项目 React 19.2.3） |
| 状态/runtime | `useLocalRuntime`（LocalRuntime）+ 自有 `ChatModelAdapter` / `AttachmentAdapter` / `ThreadHistoryAdapter`；多会话用 `useRemoteThreadListRuntime` + 自有 `RemoteThreadListAdapter`（服务端仍是会话事实源） |
| 组件 | assistant-ui 官方 registry 的 shadcn 风格组件（`pnpm dlx assistant-ui@latest add thread`，拷入 `src/components/`，不再新增运行时依赖）；业务确认卡与回执卡用自有 shadcn 组件渲染 `tool-call`/`data` part |
| 明确不用 | AssistantCloud、`useCloudThreadListRuntime`、托管会话、任何云遥测；AI Elements 与 `ai`/`@ai-sdk/react`；Redux/Zustand 或第二套消息状态源 |
| 备选（本轮未选） | `ExternalStoreRuntime`：仅在需要「服务端投影/外部 store 已是唯一事实源」时改用；它会接管消息状态，但运行循环与流式回传要全部自己实现，成本高于 LocalRuntime + adapters |
| 模型接入 | 保留现有 `src/lib/llm.ts` 与 provider 选择不动；新聊天后端独立新增适配层，普通对话与工具规划走成对的服务端端点 |

选择依据摘要（详见第 4、5 节）：LocalRuntime 恰好覆盖「自有后端 + 附件 + 暂停审批 + 自有历史」且不需要引入新状态库；ExternalStoreRuntime 需要我们自己维护消息状态与运行循环；AI Elements 不是 runtime，是 AI SDK 之上的组件注册表，接入前提是安装并配置 `ai` + `@ai-sdk/react`、后端输出 AI SDK UIMessage 流协议，与现有 Coze 链路叠加成本明显更高。

---

## 2. 依赖增量（下一阶段 YAYA-UI1 才允许执行）

本轮只在自有 scratch（`%TEMP%\opencode\yaya-tech0-poc`）安装验证，**未改 package.json / pnpm-lock.yaml**。

| 增量 | 内容 | 风险/备注 |
| --- | --- | --- |
| `pnpm add @assistant-ui/react@0.15.23` | 精确版本，不用 `^` | 官网文档已出现 0.16 的弃用提示，API 仍在演进；必须锁死版本再升级 |
| 传递依赖（自动） | `@assistant-ui/core@0.3.22`、`store`、`tap`、`assistant-stream@0.3.46`、`zustand@^5`、`radix-ui`（伞包）、`react-textarea-autosize`、`safe-content-frame`、`assistant-cloud@0.2.4` | 我方代码不直接 import zustand/assistant-cloud；伞包 `radix-ui` 与现有 `@radix-ui/react-*` 并存，pnpm 会分别保留 |
| 锁影响 | `zod`：发布包要求 `^4.6.5`，当前锁为 `4.3.6`（package.json 范围 `^4.3.5`） | 需更新锁（可提升到 4.6.x 单版本）；属 YAYA-UI1 的依赖变更，TECH0 不动 |
| 明确不新增 | `ai`、`@ai-sdk/react`、AG-UI/LangChain runtime、Redux/Zustand（自用）、`@assistant-ui/react-ai-sdk` | AI Elements 路线才需要 `ai` 系依赖，本推荐不使用 |
| 组件文件 | registry 命令拷入组件源码（可选，不做也行） | 只拷组件、不带 runtime；与现有 `src/components/ui/` shadcn 规范一致 |

---

## 3. assistant-ui@0.15.23 实际接口核验（发布包 + 官方文档）

证据来自 scratch 安装的发布包：`@assistant-ui/react@0.15.23` → `@assistant-ui/core@0.3.22`（下文路径均相对包根）。官方文档（2026-10-05 查阅）与发布类型一致：`unstable_humanToolNames`、approval gate、resume、adapters 章节均可对上。

### 3.1 LocalRuntime + 自有 adapters

- `useLocalRuntime(chatModel, options)`：`LocalRuntimeOptions = { maxSteps?, adapters?: { history?, attachments?, speech?, ... }, unstable_humanToolNames?, unstable_enableMessageQueue?, initialMessages? }`（`dist/react/runtimes/useLocalRuntime.d.ts`）。`chatModel` 单独注入。
- `ChatModelAdapter.run(options)` 返回 `Promise<ChatModelRunResult> | AsyncGenerator<ChatModelRunResult>`；options 含 `messages`（整条线程，含附件 part）、`runConfig`、`abortSignal`、`context`、`unstable_assistantMessageId`、`unstable_threadId`、`unstable_getMessage()`（`dist/runtime/utils/chat-model-adapter.d.ts`）。
- 流式语义（源码 + 行为验证）：每次 yield 的 `content` 追加到本轮初始内容之后（`local-thread-runtime-core.js:582,656`）；连续文本 part 合并为一条（行为验证 A：两次 yield `a`/`ab` 最终只有 `text: "ab"`）；**审批恢复时不要在 yield 里重复 tool-call part**，否则 store 报 `Duplicate key toolCallId`（行为验证中出现过，改为只 yield 后续文本即通过）。
- 默认 `maxSteps=2`（`local-thread-runtime-core.js:678`），应显式配置并设上界，不放开无限循环。
- `cancelRun()` → adapter 的 `abortSignal` 触发 abort，消息settle 为 `incomplete/cancelled`（`local-thread-runtime-core.js:714-727`；行为验证 B 通过）。

### 3.2 暂停/审批（HITL）

- 审批门：assistant 消息 `status:{type:"requires-action",reason:"tool-calls"}` + tool-call part 携带 `approval:{id}`（无 `approved` 字段）→ run 暂停（源码 `should-continue.js`：存在未决 approval 即不继续）。
- UI 调用：`thread.getMessageById(id).getMessagePartByToolCallId(toolCallId).respondToToolApproval({approved, optionId?, text?, reason?})`（`dist/runtime/api/message-part-runtime.d.ts`；新 store API 通过 part scope 暴露，见 `store/scopes/part.d.ts`）。
- 批准后：LocalRuntime **自动再次调用** `ChatModelAdapter.run`，恢复调用可在 `unstable_getMessage().content` 读到 `approval.approved=true`，由 adapter 去服务端执行；拒绝则合成 `isError` 结果（`local-thread-runtime-core.js:883-928`）。行为验证：审批后 adapter 第二次运行、`approved===true`、后续文本落到同一条 assistant 消息。
- 安全结论：**前端回调只是「请求」**。服务端执行必须走现有 `runBusinessWrite`（`src/lib/accounts/access.ts:196`），在保存时重查账号/会话/班级归属/草稿/证据快照；模型等待在事务外（现有 `pg-client.ts` 的 `withSaveAuthorization` 机制不变）。审批卡只携带 `approvalId + 内容摘要`，不能携带可复用的授权凭证。
- 「历史批准恢复不能自动调用业务写」：`history.load()` 返回 `unstable_resume:true` 时 LocalRuntime 会自动 `resumeRun`（`local-thread-runtime-core.js:308-313`）——**历史 adapter 永远不得返回该标记**，也不要实现 `resume()` 执行语义；未决 approval 在后续消息跟随时会被标记 `resolution:"cancelled"`（`:29-52,176`），旧批准自然失效。

### 3.3 附件

- `AttachmentAdapter = { accept, add(File), send(PendingAttachment,{signal}), remove() }`（`dist/adapters/attachment.d.ts`）。`send` 返回 `CompleteAttachment`，其 `content: ThreadUserMessagePart[]` 可含 `{type:"image", image: "<url 或 data>"}`；此后 `ChatModelAdapter` 的 `messages` 里可直接读到该图片 part。
- 建议实现：`add` 走现有鉴权的上传端点（对象存储），`send` 返回服务端对象引用 + 短期签名 URL（或仅对象 key + 服务端按需取字节）；失败/重试状态用 `PendingAttachmentStatus` 呈现，不伪装成功。
- 不做匿名长效公开 URL；签名过期后由 `send`/预览端刷新（见第 6 节）。

### 3.4 自有历史与会话列表

- 单线程历史：`ThreadHistoryAdapter = { load(), append(item), update?(item), delete?(items), resume?, unstable_copy? }`（`dist/adapters/thread-history.d.ts`）。`load()` 返回 `ExportedMessageRepository & { unstable_resume? }`；`update?` 是「暂停审批后同一消息先落库、恢复后定稿」的受支持路径；`unstable_copy` 用于「消息事实源在服务端，adapter 只维护副本」。
- 多线程列表：`useRemoteThreadListRuntime({ runtimeHook, adapter })` + `RemoteThreadListAdapter = { list, rename, archive, unarchive, delete, initialize, fetch, generateTitle, unstable_useAdapters? }`（`dist/runtimes/remote-thread-list/types.d.ts`），全部可由自有 API 实现，`generateTitle` 返回 `AssistantStream`（可用服务端生成后返回最小流）。**不接 AssistantCloud**。
- 侧栏/工作区切换：同一 `AssistantRuntimeProvider` 下，侧栏用 `ThreadListPrimitive`，工作区用 `ThreadPrimitive`；两者共享同一 runtime 与线程状态，无需额外状态库。需在真实浏览器验证切线程后历史加载与 composer 状态（NOT_RUN）。

### 3.5 关闭不需要的自动行为

- 不注册任何带 `execute` 的前端工具（`defineToolkit`/`useAssistantTool`）；ExternalStore 的 `unstable_enableToolInvocations` 也不会开启（而 LocalRuntime 本身不自动执行未注册工具）。
- 「消息重生成/编辑」由 UI 决定：不渲染 `ActionBarPrimitive.Reload`、Edit composer 即可；runtime 的 capabilities 仍有 edit/reload 位，但产品入口可以关。
- 不在历史中恢复「待执行」动作：见 3.2 的 `unstable_resume` 禁令。

### 3.6 遥测/云

- `AssistantCloud` 与 `CloudEngagementReporter` 只在显式 `new AssistantCloud(...)` / cloud hooks / `NEXT_PUBLIC_ASSISTANT_BASE_URL` 存在时才生效（`@assistant-ui/core dist/react/runtimes/cloud/createCloudThreadListAdapter.js:12-17`；`assistant-cloud` 的 telemetry 默认开启但仅在实例化后）。本方案不实例化、不设置该环境变量，不发送私有数据。
- 需要在接入评审中确认构建产物不引入 `NEXT_PUBLIC_ASSISTANT_BASE_URL`。

---

## 4. AI Elements 对照（为什么不同时装）

依据官方 Setup/Confirmation 文档（2026-10-05 查阅）：

| 维度 | `@assistant-ui/react@0.15.23` | AI Elements |
| --- | --- | --- |
| 本质 | runtime + 无样式 primitives + shadcn registry 组件 | 仅 shadcn registry 组件（UI），无 runtime |
| 前提依赖 | 本包（peer React 19 已满足） | 必须安装并配置 **AI SDK**（`ai`、`@ai-sdk/react`），或接 AI Gateway |
| 自有后端 | `ChatModelAdapter` 一个 `run` 即可；流式自定 | 后端须产出 AI SDK UIMessage 流（`streamText`/`toUIMessageStreamResponse`）；审批绑定 AI SDK tools `requireApproval` |
| 与 Coze SDK 现状 | 适配层完全自有，可直译现有 JSON schema 结果 | 需要从 Coze/StepFun 结果再桥接到 AI SDK 消息协议，且无原生 tools 时审批链也只能自造 |
| 状态管理 | runtime 内建，无额外 store | `useChat` 状态（AI SDK） |
| 结论 | **推荐** | 不做；避免同时安装两套聊天库与两套消息状态 |

---

## 5. 模型能力矩阵（Coze SDK vs 当前 StepFun 路径）

证据级别：**类型**=发布 .d.ts；**源码**=发布包运行时代码；**行为**=本轮可运行替身/真实安装包验证；**无**=该能力不存在；**NOT_RUN**=需真实请求/环境，本轮未测。

| 能力 | Coze（`coze-coding-dev-sdk@0.7.32`） | StepFun（`src/lib/llm.ts` 当前实现） |
| --- | --- | --- |
| 图片输入 | 支持：`Message.content` 用 `ContentPart[]`，`image_url.url` 接受 http(s) URL 或 **base64 data URI**（类型+源码 `checkBase64DataUri`）；本地文件路径被拒绝并要求先上传存储；过时图片格式被拒 | **不支持**：`LlmMessage.content` 为 `string`，整条链路只发文本（源码）；StepFun 服务本身为 OpenAI 风格，多模态能力 NOT_RUN |
| 多图 | 支持：一个 `ContentPart[]` 可含多个 `image_url`（类型） | 不支持（同上） |
| stream | SDK 有 `LLMClient.stream()` 返回 `AsyncGenerator<AIMessageChunk>`（类型+源码）；**当前 `src/lib/llm.ts` 只用 `invoke()`，不向前端流式** | 不支持：`invokeStepFun` 一次性 `fetch` + `response_format`，无流（源码） |
| abort | 无用户级 AbortSignal 参数：`stream`/`invoke` 签名无 signal，只有 `Config.timeout`（类型）；上层无法中途取消（可用请求级超时兜底） | 仅 `AbortSignal.timeout`（超时，不是用户取消）；无流可断 |
| 原生 tool_calls | **无**：发布 `LLMConfig` 只有 model/thinking/caching/temperature/streaming；`Message.role` 无 `tool`；`LLMResponse` 只有 `content`；运行时 `createLLM` 不传 tools，`convertMessages` 只映射 system/user/assistant（类型+源码）；整包无 `tool_calls` 字段（源码检索） | 无：请求体无 tools；响应只取 `choices[0].message.content` |
| 工具结果回传 | **无**：消息角色无 `tool`/`tool_call_id`，无法按协议回传 | 无 |
| 多轮工具循环 | 无原生循环；需应用侧「结构化规划 + 受控服务执行」（见 5.1） | 同左 |
| schema 约束 | 发布 `LLMConfig` 无 `response_format`；当前应用未做 schema 约束（类型） | 支持：6 个 `json_schema`（strict）经 `response_format` 下发（源码，如 `observation_draft`） |
| usage | `LLMResponse={content}`，**不暴露 usage**（类型）；当前 `invokeCoze` 也未记录 | 支持：从 `payload.usage` 归一化 input/output/total tokens（源码） |
| 公开检索 | `SearchClient.search/webSearch/webSearchWithSummary/advancedSearch`（类型+源码），服务端经 Config 调用；结果含 `url/site_name/snippet/publish_time/summary`（类型）；无 usage 字段 | 无 |

结论：**不能声称 Coze 已有原生工具循环，也不能声称 StepFun 当前路径支持图片或流式**。两者都需要应用侧补齐；普通模型列表或 coding 模型能力不代表已部署应用接口支持。

### 5.1 原生工具不可用时的替代（供主评审选择）

方案 A（推荐）：**结构化规划 + 受控服务执行**。服务端一次调用模型产出「受控计划 JSON」（沿用 StepFun strict schema / Coze 提示 + Zod 二次校验），前端渲染为确认卡；教师批准后，由服务端按已批准计划执行既有业务函数（`runBusinessWrite` + 现有 queries），再把执行回执作为 assistant 消息的 `data` part 渲染。**与完整 Agent 的差异**：没有模型自主连续调用工具；每步计划先落卡、执行由服务端白名单函数完成；无模型→工具→模型的自环（可做「执行后再汇总」的第二轮模型调用，但不是协议级 tool loop）。仍满足「不绕过权限/事务/确认」。

方案 B：官方适配替代（例如经平台支持的兼容 OpenAI tools 的网关注入工具循环）。本轮**没有找到已发布且文档化的路径**，且不得调用私有属性/未文档接口硬接；需另行核实平台网关是否暴露标准 tools 协议，NOT_RUN。

禁止项：用正则指令分流、或在 Prompt 里写工具名就算「工具循环已验收」——本轮明确不采用。

---

## 6. 图片与对象存储前置（复用已装 S3/lib-storage/sharp）

现状：`@aws-sdk/client-s3@^3.958.0`、`@aws-sdk/lib-storage`、`sharp@0.35.3` 已在 dependencies，但 `src/` 中**零使用**（grep 证据），本轮未上传/开通任何桶。

已核实的发布 SDK 能力（`coze-coding-dev-sdk` s3 模块，类型+源码）：

- `S3Storage.uploadFile/readFile/deleteFile/listFiles/streamUploadFile/uploadFromUrl/chunkUploadFile/generatePresignedUrl`；上传返回对象 key。
- 运行时配置：生产由平台项目运行时授权调用 `/api/v1/integration/storage/ensure` 获取 bucket/endpoint（`ensureStorageEnvironment`）；也支持环境变量 `COZE_BUCKET_ENDPOINT_URL` / `COZE_BUCKET_NAME` 显式配置。**部署面板需要提供/确认对应资源授权**，本轮无法验证是否已开通（NOT_RUN）。
- `generatePresignedUrl` 默认有效期 **86400s（24h）**（`S3Config.DEFAULT_PRESIGNED_EXPIRE_TIME`）；**禁止默认使用长效公开 URL**，调用必须显式传短 TTL。
- 对象 key 由 `generateObjectKey` 生成（`<dir>/<basename>_<8hex><ext>`），**不含项目/环境前缀**。开发（沙箱）与生产若共用同一 `COZE_PROJECT_ID`，很可能共用同一 bucket → 必须在应用层给 key 加显式环境前缀（如 `yaya/dev/`、`yaya/prod/`）或使用独立桶；**开发/生产隔离未验证，列为 MEDIA1 阻塞项**。

LLM 读取私有图的可行方式：

1. **服务端取字节 → base64 data URI 传入 Coze `image_url`**（首选）：SDK 明确接受 data URI，无需公开 URL，签名/权限不进入模型侧日志；代价是请求体膨胀，需用已装 `sharp` 先压缩/转码；大小上限 NOT_RUN。
2. 短 TTL 签名 URL 传给模型网关：模型后端需能访问该 URL，签名本身是 bearer 类秘密，可能被网关/模型供应商记录；仅在 1 不可用时考虑，且 TTL 最小化、不复用。
3. 匿名/长效公开 URL：**禁止**。
4. 图片对象与聊天/观察引用只存对象标识与来源；对话删除不删正式观察或仍被引用的图片（对象回收规则由契约/存储 owner 定义，不允许按目录前缀清空）。

---

## 7. 探针与验证结果

### 7.1 仓库内最小探针（已提交）

`scripts/yaya/check-tech0.ts`：离线、零网络、零环境变量。断言：SDK 版本 `0.7.32`；`LLMClient.prototype` 无任何 tool 方法且含 `invoke/stream`；`SearchClient` 四个检索方法存在；`S3Config.DEFAULT_PRESIGNED_EXPIRE_TIME===86400`；类型级正向断言 `image_url` data URI 合法；`@ts-expect-error` 反向断言 `LLMConfig.tools`、`Message.role:"tool"` 不存在。

本轮执行结果（此工作树无 node_modules，使用主仓依赖 + 路径映射验证；评审可 `pnpm install` 后按原命令运行）：

- `tsx scripts/yaya/check-tech0.ts` → `check-tech0 OK: coze-coding-dev-sdk@0.7.32 surface matches tech0.md`（行为级，exit 0）
- `tsc`（单文件 + SDK 路径映射，strict）→ exit 0（`@ts-expect-error` 全部命中）
- `eslint`（项目 flat config）→ exit 0

### 7.2 scratch 行为验证（真实发布包，未提交）

`%TEMP%\opencode\yaya-tech0-poc`：`pnpm add @assistant-ui/react@0.15.23 react@19.2.3 react-dom@19.2.3`，jsdom 渲染 `useLocalRuntime`：

1. 审批门：第一次 run 产出待批准 tool-call 并停住 → `respondToToolApproval({approved:true})` → adapter 第二次运行且读到 `approved===true`，后续文本落入同一消息。PASS
2. 流中断：`cancelRun()` → adapter `abortSignal` 触发、消息 `incomplete/cancelled`。PASS
3. 自有历史：`history.load()` 注入旧消息（不带 `unstable_resume`）→ 线程恢复且未自动运行；`append` 记录用户与 assistant 两条。PASS

证据分级：assistant-ui 为 **行为（browser_mock）**；SDK 为 **类型+源码+行为（原型检查）**；provider 真实协议为 **NOT_RUN**。

---

## 8. 阻塞项

1. **无原生 tool_calls**（Coze/StepFun 当前路径均无，证据见第 5 节）→ 必须走 5.1-A 结构化规划+受控服务执行；若主评审要求协议级工具循环，先解决方案 B 的官方通道，否则不能宣称 Agent 工具循环。
2. **zod 锁升级**：安装 assistant-ui 需要 `zod ^4.6.5`（当前锁 4.3.6），由 YAYA-UI1 显式更新并回归现有 Zod 校验。
3. **对象存储部署配置与开发/生产隔离未验证**：`COZE_BUCKET_ENDPOINT_URL`/`COZE_BUCKET_NAME` 或平台授权是否就绪、key 环境前缀策略，均待 MEDIA1/部署核验；本轮未开通、未调用。
4. **真实 provider 协议/视觉质量/usage/限流 NOT_RUN**：预算 40/40，未发请求；Coze 无用户级 abort 已确认，是否可在平台网关层取消待真实压测。
5. **assistant-ui 版本漂移**：官网文档已含 0.16 弃用说明；必须精确锁 0.15.23，升级另立评审。
6. **前端审批 ≠ 授权**：服务端必须复用 `runBusinessWrite`（`access.ts:196`）并在等待后重查身份/归属/草稿/证据快照；历史恢复不得自动执行业务写（`unstable_resume` 禁令）。
7. **Coze 无 usage 暴露**：若产品需要 token 计量，Coze 通道需要平台侧补充或改用可返回 usage 的通道（StepFun 已有）。

---

## 9. 下一轮最小真实 smoke 清单（需预算/资源授权后执行）

| # | 项目 | 最小步骤 | 需要的授权 |
| --- | --- | --- | --- |
| 1 | Coze 视觉 | 1 张合成非幼儿图片（sharp 压缩）→ base64 data URI → `invoke`，确认可用与大小上限 | 真实模型预算 1 次 |
| 2 | Coze 流式 | `LLMClient.stream()` 固定短提示，确认 chunk 行为与无 abort 的实际影响 | 真实模型预算 1 次 |
| 3 | StepFun 视觉（若保留该 provider） | 直连 REST `image_url` 合成图，确认当前链路是否可扩展 | 真实模型预算 1 次 |
| 4 | 公开检索 | 1 个无幼儿信息的教育关键词，核对 `url/site_name/publish_time` 与失败语义 | 搜索服务预算/授权 |
| 5 | 对象存储 | 专用前缀上传→list→presign（显式短 TTL）→read→delete，确认部署环境 key 与桶隔离 | 桶开通/部署授权 |
| 6 | assistant-ui 浏览器 smoke | 侧栏↔工作区同会话切换、选图/拍照上传与移除重试、审批暂停/拒绝/批准（服务端写受 `runBusinessWrite` 保护）、刷新后历史无自动执行、流中取消、390/768/1440 布局 | 测试环境 + 浏览器 |
| 7 | 会话隔离 | 两个账号/过期会话读取对方会话与附件被拒；删除会话不影响正式观察与引用图片 | 测试库授权 |

---

## 10. 交付、边界与清理

- 本轮提交文件（仅此两个）：
  - `docs/yaya-v1/tech0.md`（本文件）
  - `scripts/yaya/check-tech0.ts`（最小离线探针）
- 工作树：`codex/yaya-tech0`，基 `e8225f04918de2073e194cb199dc8cf1bcb7f38f`；`git status` 仅上述两处新增。
- 未改：产品源码、共享类型、`package.json`、`pnpm-lock.yaml`、`.env`、`scripts/harness-safety.ts`；未建任何 mock 路由；未 push/部署/合并。
- scratch：`%TEMP%\opencode\yaya-tech0-poc`（候选包安装与行为脚本）为本轮自建资源，证据命令与输出已记录在 7.1/7.2，**已删除清理**；工作树 `%TEMP%\opencode\child-growth-yaya-tech0` 为交付位置保留，未对其他 agent 的工作树做任何写操作。
- 真实请求计数：模型 0、搜索 0、对象存储 0、托管库 0。
- 停止点：等主评审确认「推荐组合 + 5.1 替代方案选择 + smoke 清单」后，才进入第二阶段的 DATA1/MEDIA1/TOOLS1/UI1 等 prompt 发布。
