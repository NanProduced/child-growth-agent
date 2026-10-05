# YAYA-TECH0-R2｜聊天与多模态技术兼容性前置（二次修订，PARTIAL）

状态：离线前置核验 + 离线替身 PoC。未安装项目依赖、未改产品源码/共享类型/依赖锁、未读 `.env`、未对真实 provider/搜索/对象存储/托管库发起任何请求。真实协议、视觉质量、部署存储、真实 Agent 质量与浏览器联合验收均为 **NOT_RUN**，需追加预算与资源授权。

- 本修订起点：`3b12738dd75b4deec31dd0e3bff338cffc111afd`（R1 提交）；共同产品基线 `e8225f04918de2073e194cb199dc8cf1bcb7f38f`
- 工作树：`codex/yaya-tech0`，`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-yaya-tech0`
- 固定装置：`scripts/harness-safety.ts` blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`，核验一致
- `RTK.md`：不存在（仅记录）；真实模型账本 40/40，本轮真实模型请求 0

---

## 0. 修订历史

### R2 必修项

| 必修 | 变化 |
| --- | --- |
| A | “已批准无回执”恢复路线改为**先按原 operation_id 查询**：执行中/未知/查询失败 → 保持核验不重发；已提交 → 恢复原结果；详情不可读 → 只读回详情；明确未执行/无提交效果 → 才可重新核对、批准且使用**新操作身份**；不得笼统建议重开新提案再执行。新增 runtime 反例：原写入成功但响应丢失 → 换设备恢复 → 只查询回执，业务写仍为 1 |
| B | 审批替身补齐实际前提：**可信批准记录与本地 approved part 分离**；actor/session/提案状态/取消/过期/消费/内容版本逐项核对；缺前提不默认通过；旧会话本地批准不执行，当前会话重新核对并真实批准才执行一次；重复消费返回原回执。旧 GREEN 结论已拆分修正（原因见 3.2） |
| C | 有界循环异步修复：模型与工具等待均可超时；**await 返回后重查 deadline/run 身份/取消**；异步工具被 await 并在正确错误边界内有限重试；read 与 propose_write 都校验白名单+参数；各类尝试（含超时/失败）计入预算；移除 auto-approve 捷径。新增慢模型/慢工具/拒绝/不返回/取消迟到/未知写工具/预算上限反例 |
| D | 出口守门接入最终退出码：自检调用单列；其余被拒出口（即使异常被吞）必须产生 FAIL 与非零退出；分别记录“被拒尝试”与“实际外发”；守门范围与未覆盖层如实声明。新增子进程反例断言 |
| 文档 | `invokeStructured` 修正为“最多 2 次调用，即 1 次重试”；恢复状态表与场景标签同步；替身不执行注入指令仅记替身口径，不代表真实模型抗注入质量通过 |

### R1 必修项（保留）

| 必修 | 变化 |
| --- | --- |
| A | 5.1 由“单次计划 + 受控执行”改为**结构化动作协议 + 服务端有界 Agent 工具反馈循环**；限定语改为“已安装 SDK 与当前应用路径未暴露原生工具协议”，不再推导供应商全部模型/官方通道不支持；新增闭环替身探针（有界、数据驱动第二步、歧义/写入暂停、白名单与参数校验、步数/请求/重试/时间上界） |
| B | 明确定义 LocalRuntime 自动续跑只是 UI runtime 行为；补充服务端提案状态机、`resolution:cancelled` 的本地性质、跨设备/换登录的重新批准协议、三类灵活性场景与反例对照 ExternalStoreRuntime |
| C | 取消分层表（UI/abortSignal/关闭迭代器/上游物理请求/服务端运行状态）；补迟到结果、旧 adapter 自动恢复、重复恢复的可运行反例；明确已开始写入不回滚、按回执核对 |
| D | 撤销“CLI 必然无增量依赖”的未核验承诺；给出 registry 实际声明依赖、锁定/最小手工两方案；核对 zod 根 4.3.6 与传递 4.6.5 的实际边界（Standard Schema 结构边界，两个场景均编译通过）；PoC 记录全部实际解析版本 |
| E | 对象存储改为引用官方文档的开发/生产**物理隔离**事实；前缀只作命名管理；能力表区分“接口存在”与“真实选定模型可用”；区分原生 JSON Schema 与应用 Zod 守门；Coze invoke/stream 的 usage 分别核对，无数据记 unknown/NOT_RUN |

---

## 1. 推荐结论（供主评审）

| 项 | 结论 |
| --- | --- |
| 库与版本 | `@assistant-ui/react` **精确 0.15.23**（peer `react ^18 \|\| ^19`，本项目 React 19.2.3） |
| 状态/runtime | `useLocalRuntime`（LocalRuntime）+ 自有 `ChatModelAdapter`/`AttachmentAdapter`/`ThreadHistoryAdapter`；多会话用 `useRemoteThreadListRuntime` + 自有 `RemoteThreadListAdapter`（服务端是会话事实源） |
| 组件 | **最小手工组件优先**：用 assistant-ui primitives 渲染消息/输入框/审批卡，配项目已有 shadcn（button/textarea/alert/card/avatar/dialog/tooltip 等），不跑 CLI、不引 markdown/shimmer 链。备选：锁定 `assistant-ui@0.0.119` 跑 registry 生成后逐文件评审（见第 2 节依赖清单） |
| 明确不用 | AssistantCloud/云会话/遥测；AI Elements 与 `ai`/`@ai-sdk/react`；Redux/Zustand 或第二套消息状态源 |
| 模型协议 | **结构化动作协议 + 服务端有界 Agent 反馈循环**（不是原生 Function Calling，也不是“单次计划宏”）：只读工具在已授权且意图明确时自动执行，结果作为数据反馈给模型继续判断；歧义先问；写入暂停提案，真实用户批准后由服务端执行（见 5.1） |
| 审批 | 前端 `respondToToolApproval` 只是请求；服务端必须读取可信提案记录并核对 actor/session/内容/附件/目标/版本，执行走 `runBusinessWrite`（`src/lib/accounts/access.ts:196`）并保持回执原子性（见 3.2） |
| 备选（未选） | `ExternalStoreRuntime`：仅在服务端投影/既有外部 store 已是唯一事实源时；它需要自建消息状态与运行循环，成本更高。当前反例（3.2/7）都可由适配纪律解决，不需要第二套状态源 |

---

## 2. 依赖与 registry（修订）

### 2.1 事实

- `@assistant-ui/react@0.15.23`：peer `react ^18 || ^19`；依赖含 `@assistant-ui/core ^0.3.22`、`store ^0.3.16`、`tap ^0.9.20`、`assistant-stream ^0.3.46`、`assistant-cloud ^0.2.4`、`zustand ^5.0.15`、`radix-ui ^1.6.7`、`react-textarea-autosize`、`safe-content-frame`、`zod ^4.6.5`。
- `@assistant-ui/core@0.3.22` 自身**不声明 zod 依赖**；工具参数类型走 **Standard Schema（`~standard`）结构接口**，不是直接引用 zod 类型。
- 本地 scratch 实测解析：`@assistant-ui/react` 自带 zod **4.6.5**；项目/scratch 根 zod **4.3.6**，两者在同一依赖图中并存（pnpm 独立解析）。

### 2.2 “根保持 4.3.6”对比“统一升级”的实际边界

用同一份类型探针（scratch `zod-boundary/toolkit-check.ts`：`tool({ parameters: z.object({...}), execute: async ({q}) => q.length })` + `z.infer` 结构断言）：

| 场景 | 根 zod | 结果 | 说明 |
| --- | --- | --- | --- |
| 根保持 | 4.3.6 | tsc strict **exit 0** | 根 schema 通过 `~standard` 进入 assistant-ui 类型推断，无跨版本类型冲突 |
| 统一升级 | 4.6.5 | tsc strict **exit 0** | 可行但需改项目锁，属 YAYA-UI1 决策，不是 TECH0 前置 |

本轮**没有找到**支持“根必须升级”的反例；首版的“需要更新锁”修正为：**不自动要求升级**。若接入时要在应用代码里把根 zod schema 直接交给 assistant-ui（如自定义 toolkit），按上述边界验证；不注册前端工具时两者无共享 schema 实例。**本任务不改项目锁**。

### 2.3 组件来源（撤销“CLI 必然无增量依赖”）

- 仓库 `components.json` 为 shadcn `style: "new-york"`；按 CLI `assistant-ui@0.0.119`（当前 latest）源码 `dist/lib/utils/registry.js`，该风格解析到 `https://r.assistant-ui.com/<component>.json`。
- 2026-10-05 实取 registry 声明（非文档承诺，registry 内容可变）：

| registry item | 声明 dependencies | 声明的 registryDependencies |
| --- | --- | --- |
| `thread` | `@assistant-ui/react@^0.15.23`、`lucide-react` | shadcn `button`、`skeleton` + attachment/file/follow-up-suggestions/image/markdown-text/reasoning/tooltip-icon-button/tool-fallback/tool-group |
| `attachment` | `@assistant-ui/react@^0.15.23`、`lucide-react` | shadcn `dialog`、`tooltip`、`avatar` + tooltip-icon-button、use-attachment-src |
| `markdown-text` | `@assistant-ui/react-markdown@^0.14.18`、`remark-gfm`、`lucide-react` | tooltip-icon-button、use-copy-to-clipboard |
| `tool-fallback` / `tool-group` | `@assistant-ui/react@^0.15.23`、`lucide-react`、`class-variance-authority`、`tw-shimmer@^0.4.13` | shadcn `button`/`collapsible`/`textarea` 等 |
| `tooltip-icon-button` | `radix-ui` | shadcn `tooltip`、`button` |

- 即：**完整 `thread` 链至少新增** `@assistant-ui/react`、`@assistant-ui/react-markdown`、`remark-gfm`、`tw-shimmer`、`radix-ui`（`lucide-react`、`class-variance-authority` 项目已有；shadcn 组件项目已有 7 个中的全部）。registry 生成的 `thread` 还自带 `ActionBarPrimitive.Reload`（重生成）与 Edit composer，需要按产品要求删除/替换。
- 方案 A（锁定 CLI）：`pnpm dlx assistant-ui@0.0.119 add thread`，在独立分支生成后逐文件评审、移除重生成/编辑入口、记录 registry 内容哈希；不接受 `@latest` 无人值守，CLI 运行会改项目，属 YAYA-UI1。
- 方案 B（推荐）：不跑 CLI，手写最小 `Thread`/`Composer`/`ApprovalCard` 组件，仅依赖 primitives + 现有 shadcn；不引 markdown/shimmer/CLI。文本先按纯文本渲染，确有需求再加 markdown 链。

---

## 3. runtime 生命周期与批准（修订）

### 3.1 已核实的发布行为（真实包 + jsdom 替身）

- `respondToToolApproval` 后 LocalRuntime **自动再调用 adapter**（`@assistant-ui/core@0.3.22` `dist/runtimes/local/local-thread-runtime-core.js:883-928`）。这是 UI runtime 行为，**不是业务授权**。
- `cancelRun()` → adapter `abortSignal` 触发、消息 `incomplete/cancelled`；此后迟到的 yield 被 runtime 丢弃，**但 adapter 的副作用继续发生**（没有 `iterator.return`），adapter 必须自检 `abortSignal`/run 标识（探针 `runtime/late-yield-dropped`）。
- `history.load()` 返回 `unstable_resume:true` 时自动 `resumeRun`（同文件 `:308-313`）——历史 adapter 禁止返回该标记。
- 未决 approval 在“后续消息跟随”时被本地标记 `resolution:"cancelled"`（`:29-52,176`）——**这是本地 part 状态，不是服务端提案状态**；服务端必须有独立的取消/过期语义。

### 3.2 服务端提案协议映射（必须由契约/YAYA0 冻结）

- **提案**是服务端事实（字段形状待 YAYA0 冻结）：`proposal { id, operation_id, run_id, actor, tool, args_hash, target, content_version, attachments_version, status, receipt }` 与独立的**可信批准记录**。
- 本地 part 映射：无 `approval` = 尚无提案；`approval.id` = 服务端提案 id；本地 `approved=true` 只代表“用户点过批准按钮”；本地 `resolution:"cancelled"` 只代表该 part 在当前线程不再可操作（不是服务端取消）。
- **可信批准与本地 part 分离（R2 修正）**：本地 `approved=true` 只是“用户点过批准按钮”的 part 状态；服务端必须另存**可信批准记录**（当前 actor/session 在服务端发出的批准）。消费时逐项核对：可信批准存在 → actor 匹配 → 提案 `pending`（cancelled/expired/consumed 分别拒绝）→ 内容版本匹配；缺任一必要前提一律拒绝，**不默认通过**（探针 `unit/proposal-premise-matrix`：cancelled/actor_mismatch/no_trusted_approval/missing_premise/proposal_expired/premise_version_mismatch 全部写 0；匹配后写 1）。
  - R1 的 `guarded-match` GREEN 结论已拆分修正：旧替身允许 adapter 自报 `{actor, session, contentVersion}` 前提、且未要求可信批准记录，因此“已取消提案 + 换账号 + 换 session + 同版本”仍会写入一次（主评审复现）。R2 替身改为可信批准注入 + 状态/actor/session/版本全核对；旧结论不再作为 GREEN 证据。
- 执行必须是「消费提案 + 业务写」的原子路径（`runBusinessWrite` 内提交），重复消费返回原回执（`already_consumed`），不重复写（探针 `unit/duplicate-execution-idempotent`：两次消费、业务写 1、返回原 receipt）。
- 跨设备/换登录：不继承旧 `approved`，也不复用旧会话的可信批准；当前会话必须**重新核对并真实批准**（新可信批准记录），匹配前提后执行一次（探针 `runtime/restored-local-approved-no-trusted-GREEN` 写 0、`runtime/restored-trusted-stale-GREEN` 写 0、`runtime/restored-trusted-match-GREEN` 写 1）。
- **恢复路线（R2 修正，不笼统重开）**：已批准但结果未知时，先按**原 operation_id** 查询，不重发：
  | 查询结果 | 动作 |
  | --- | --- |
  | 执行中 / 结果未知 / 查询失败 / 查无记录 | 保持核验，不重发、不新建执行 |
  | 已提交 | 恢复原结果与回执，不再执行 |
  | 已保存但详情不可读 | 只读重取详情，不执行 |
  | 明确失败且无提交效果 / 明确仍未执行的准备项 | 才可重新核对、批准；使用**新操作身份**，不绕过原操作的幂等与核验边界 |
  对应探针：`unit/recovery-state-machine`（状态表映射；只有 `failed_no_effect/not_executed` 允许重核且新 id ≠ 原 id）与 `runtime/lost-response-recovery`（原写入成功、响应丢失 → 换设备恢复 → 只查询回执，业务写仍为 1，`reexecutions_after_restore=0`）。
- 删除/撤权/转班：沿用 AUTH 在保存时重查；模型等待在事务外。运行标识（run_id）用于挡住迟到的模型/工具结果触发新动作，与 AUTH 撤权防护是**两件事**，都要有。

### 3.3 三类灵活性（不因守门牺牲产品行为）

1. **待批准时继续普通问答**：新用户消息会本地结束旧 part 的暂停；旧提案在服务端保持其状态（由协议决定 cancel/keep），普通问答走只读路径；私有草稿存服务端，不因本地 part 取消而丢。
2. **批量一项待核对不阻塞其他项**：每项独立提案与独立回执；已核对项照常执行，待核对项单独展示（探针 `unit/batch-does-not-block`：2 执行 / 1 pending）。
3. **历史恢复后显式重新核对/批准**：恢复只读、不自动执行；用户明确重新核对后建立新可信批准与新操作身份；不复用旧 `approved`（探针 `history-load-no-autorun` + `restored-trusted-match-GREEN` + `lockout`）。

### 3.4 与 ExternalStoreRuntime 的对照（不换轨）

观察到的最强反例是“恢复后的本地批准会自动再跑 adapter”（`restored-approval-naive-RED`，弱 adapter 直接发生业务写）。该问题由 **adapter 必须消费服务端提案** 解决（minimal adapter 纪律），ExternalStoreRuntime 不会自动免除这个问题（外部 store 的 `onRespondToToolApproval` 同样需要服务端核对），却要自己维护消息状态/approval 生命周期/历史投影。因此维持 LocalRuntime 推荐，不引入第二套状态库。

### 3.5 云与遥测的网络守门

- 不实例化 `AssistantCloud`、不用 cloud runtimes；`createCloudThreadListAdapter` 仅在 `NEXT_PUBLIC_ASSISTANT_BASE_URL` 存在时创建匿名云实例（`@assistant-ui/core` `dist/react/runtimes/cloud/createCloudThreadListAdapter.js:12-17`）。
- 探针在启动时把 `fetch`/`http.request|get`/`https.request|get`/`window.XMLHttpRequest` 替换为拒绝并计数（范围与未覆盖层在输出 `gate_scope`/`gate_uncovered` 如实声明）；32 项场景运行后 `actual_sent=0`、自检 1 次、非自检被拒尝试 0。另有子进程反例：故意发起被拒出口并吞掉异常，主流程仍以非零退出（`unit/egress-violation-fails-exit`）。这同时覆盖任何隐藏的云/遥测路径，而不只是“没有主动 new Cloud”；`node:net/dgram/socket`、DNS 与原生插件不在守门范围，未宣称已验证。

---

## 4. AI Elements 对照（不变）

AI Elements 是 AI SDK 之上的 shadcn registry 组件，前置要求“AI SDK installed and configured”（官方 Setup），后端须输出 `toUIMessageStreamResponse()` 流，审批绑定 AI SDK tools `requireApproval`。与现 Coze/StepFun 链路叠加需要新增 `ai`/`@ai-sdk/react` 并再桥接消息协议，成本高于 assistant-ui；不同时装两套聊天库。

---

## 5. 模型能力矩阵（Coze SDK vs 当前 StepFun 路径）

证据级别：**类型**=发布 .d.ts；**源码**=发布包运行时代码；**行为**=可运行替身/原型检查；**无**=不存在；**NOT_RUN**=需真实请求/环境。**接口存在 ≠ 真实选定模型可用**。

| 能力 | Coze（`coze-coding-dev-sdk@0.7.32`） | StepFun（`src/lib/llm.ts` 当前实现） |
| --- | --- | --- |
| 图片输入 | 接口存在：`Message.content: ContentPart[]`，`image_url.url` 接受 http(s) 或 base64 data URI（类型+源码 `checkBase64DataUri`），本地路径被拒并要求先上传；**部署所选模型是否具备视觉能力 NOT_RUN** | 不支持：`LlmMessage.content` 为 `string`；StepFun 服务侧多模态 NOT_RUN |
| 多图 | 接口存在：一个 `ContentPart[]` 多张图（类型） | 不支持 |
| stream | SDK `LLMClient.stream(): AsyncGenerator<AIMessageChunk>`（类型+源码）；当前 `llm.ts` 只用 `invoke()`，不向前端流式 | 不支持：一次性 fetch + `response_format` |
| abort | 类型无 AbortSignal 参数；源码中 LLM 路径无 AbortController 接线（只在 URL 校验/S3 等使用）；关闭方式与上游物理效果见第 6 节 | 仅 `AbortSignal.timeout`（超时，非用户取消） |
| 原生 tool_calls | **已安装 SDK 与当前应用路径未暴露**：`LLMConfig` 只有 model/thinking/caching/temperature/streaming，无 `tools` 参数；`Message.role` 无 `tool`；`LLMResponse` 仅 `content`；运行时 `createLLM` 不传 tools；整包无 `tool_calls` 字段（类型+源码）。**不能据此推断供应商所有模型/官方通道都不支持 tools** | 无：请求体无 tools |
| 工具结果回传 | 无 tool 角色/`tool_call_id`，不支持协议级回传（见 5.1 替代） | 无 |
| 多轮工具循环 | 无原生循环；采用 5.1 的服务端有界循环 | 同左 |
| schema 约束 | 公开 `LLMConfig` 无 `response_format`（类型）；**但应用层已有守门**：`ai.ts` `invokeStructured` 用 Zod `safeParse` + 最多 2 次调用（即 1 次重试）+ 领域词/引文/证据校验（`src/lib/ai.ts:433-481,535-628`） | 原生：6 个 strict `json_schema` 经 `response_format` 下发（源码） |
| usage | `invoke()` 返回 `{content}`，**不暴露 usage**（类型）；`stream()` 的 chunk 类型来自 @langchain/core，类型上可选 `usage_metadata`，SDK 未声明填充，**实际 unknown/NOT_RUN**（不写 0） | 支持：从 `payload.usage` 归一化 input/output/total（源码） |
| 公开检索 | `SearchClient.search/webSearch/webSearchWithSummary/advancedSearch` 接口存在（类型+源码，服务端经 Config 调用）；结果含 url/site_name/snippet/publish_time/summary；**服务是否已开通/真实可用 NOT_RUN** | 无 |

### 5.1 原生工具不可用时的替代（修订）

**方案 A（推荐）：结构化动作协议 + 服务端有界 Agent 工具反馈循环。**

- 动作协议（文本/严格 JSON，Zod 校验；Coze 用提示 + 应用 Zod，StepFun 可叠加 strict json_schema）：`answer` | `read`（工具名 + 参数） | `clarify` | `propose_write`。
- 循环：模型输出 `read` → 服务端在**白名单**中解析、**先完整校验参数**、逐步重核授权后执行 → 结果作为**数据**（非指令）反馈 → 模型继续判断或回答；歧义输出 `clarify`；写入输出 `propose_write` → 出提案暂停，等待真实用户批准 → 服务端消费提案执行 → 回执反馈/渲染。
- 这不是协议级 Function Calling：没有模型侧原生 tool message；每一步都在应用/服务端白名单与授权之内；但它是**有界的工具反馈循环**，不是“单次计划宏”。
- 边界（R2 补强）：工具全部来自白名单（read 与 propose_write 分别校验工具名与参数）；网页/图片/工具结果只是数据；模型得不到批准入口、密码、CSRF/会话令牌，也没有任意 SQL/HTTP 能力；`max_tool_steps`、`max_tool_attempts`、`max_model_calls`、`max_tool_retries`、`deadline` 显式上界（探针默认 steps=3 / tool attempts=6 / model calls=8 / retries=1 / 2s），**模型与工具等待均可超时，await 返回后重查 deadline/run 身份/取消**；超时/失败/重试等所有尝试都计入预算，不只数成功步骤；不存在 auto-approve 捷径（写入一律暂停等真实批准）。失败/未知不无限循环，执行失败或结果未知只按原回执核对。
- 离线闭环证据（`scripts/yaya/check-runtime-tech0.cjs`，`unit` 层）：模型替身读取第一个工具结果后**依据数据选择第二个只读工具**再终答（modelCalls=3，tools=children>observations，target=c2，answer 引用 o2,o3）；注入文本保持数据；歧义只澄清；写入暂停且未批准时写 0；越界/非法参数/工具异常都在上界内停止。**这是替身/单元证据，不代表 provider 已支持或真实 Agent 质量已通过。**

**方案 B（待核实，不硬接）：官方通道原生 tools。** 只在平台文档/发布接口明确提供标准 tools 协议时启用；不得调用私有属性或未文档接口，本轮 NOT_RUN。

**禁止**：用简单正则分流、或在 Prompt 里列工具名冒充完整工具循环；也不把普通模型列表/coding 模型能力当作已部署应用接口能力。

---

## 6. 取消分层与迟到结果（修订）

| 层 | 手段/事实 | 证据 | 效果 |
| --- | --- | --- | --- |
| UI 停止 | LocalRuntime `cancelRun()` | 行为（runtime_unit_mock） | adapter `abortSignal` 触发；迟到 yield 被丢弃；消息 cancelled |
| adapter 取消传播 | 我方 `fetch(..., {signal})` / 服务端调用携带 signal | 设计约束（本项目 fetch 支持） | 停止客户端等待；已批准写入不自动回滚 |
| SDK 流/迭代器 | `LLMClient.stream()` 无 signal 参数；AsyncGenerator 协议支持 `iterator.return()` | 类型+源码 | 可停止消费；**上游物理请求是否终止 NOT_RUN**（源码 LLM 路径无 AbortController 接线） |
| 上游物理请求 | provider 侧请求取消 | NOT_RUN | 需真实 provider/网关验证 |
| 服务端运行/操作状态 | run_id + 提案状态机 + 回执 + await 后重查 | unit RED/GREEN | 迟到结果被 run 标识挡住；超时/取消后不调用新工具、不建提案、不写；重复恢复幂等；已执行写入不假称回滚，按回执核对 |

迟到结果与异步上界反例（可运行，simulated/unit）：取消后模型仍 resolve → 弱处理派发下一步 1 次，带 run 标识/状态前提的实现派发 0 次（`unit/late-run-result-guard`）；取消后继续运行的 adapter 迟到 yield 被 runtime 丢弃但副作用仍发生（`runtime/late-yield-dropped`）；恢复后的本地批准会让 LocalRuntime 自动再跑 adapter，弱 adapter 发生写入、守门（可信批准+前提核对）写 0（`restored-approval-naive-RED` / `restored-local-approved-no-trusted-GREEN` / `restored-trusted-stale-GREEN`）；同一提案重复消费业务写仍 1 次（`unit/duplicate-execution-idempotent`）；慢模型/慢工具/不返回工具/取消后迟到模型都在 deadline 内停止且不产生提案/写入（`unit/slow-model-deadline` / `unit/slow-tool-deadline` / `unit/tool-never-returns-deadline` / `unit/late-model-after-cancel` / `unit/cancel-mid-tool-no-write`）。这些是替身计数，不是真实数据库并发验收。运行标识/状态前提与 AUTH 的撤权防护是两件事，都需要。

---

## 7. 图片与对象存储前置（修订）

- 官方文档（`https://docs.coze.cn/guides_integrate_storage`，2026-10-05 查阅）明确：**开发环境与生产环境物理独立**，每项目各一个开发桶与一个生产桶，生产桶首次部署时创建；项目间隔离；仅项目所有者有操作权限；文件 URL 有效期 0–30 天，另有稳定 URI 可换取新 URL；单文件上限 200MB。
- 因此：**不能由“同一 project_id”推导“很可能共桶”**；应核对本项目实际资源身份/覆盖环境配置，部署验证留给授权后的 MEDIA/QA。
- 对象前缀（如 `yaya/dev/`、`yaya/prod/`）只作命名与资源管理，**不替代桶隔离或 IAM/应用账号权限**。
- 已装 `@aws-sdk/client-s3` / `lib-storage` / `sharp`，`src/` 零使用；发布 SDK 提供 `S3Storage.uploadFile/readFile/deleteFile/listFiles/generatePresignedUrl/...`，运行时经平台授权或 `COZE_BUCKET_ENDPOINT_URL`/`COZE_BUCKET_NAME`（接口与源码证据）；`generatePresignedUrl` 默认 86400s，必须显式短 TTL。
- LLM 读取私有图：首选服务端取字节 → `sharp` 压缩 → base64 data URI；短 TTL 签名 URL 仅在必要时且不落日志；禁止匿名/长效公开 URL；图片对象只存标识与来源，删除对话不删正式观察或仍被引用的图。
- 上述均为**接口/文档证据**；真实上传、签名、部署桶隔离、模型读图质量 **NOT_RUN**。

---

## 8. 探针与验证结果

### 8.1 `scripts/yaya/check-tech0.ts`（SDK 接口探针，复跑通过）

断言 SDK 版本 0.7.32；`LLMClient.prototype` 无 tool 方法且含 `invoke/stream`；`SearchClient` 四方法存在；`S3Config.DEFAULT_PRESIGNED_EXPIRE_TIME===86400`；类型级 `image_url` data URI 合法；`@ts-expect-error` 覆盖 `LLMConfig.tools`、`Message.role:"tool"` 不存在。复跑：`tsx` exit 0；单文件 tsc strict exit 0；项目 eslint exit 0。

### 8.2 `scripts/yaya/check-runtime-tech0.cjs`（R1 新增、R2 扩充，离线替身）

32 项 PASS，exit 0。`real_egress`：`actual_sent=0`、`self_test=1`、非自检被拒尝试 0；守门范围与未覆盖层在输出中声明。覆盖：
- 有界闭环（数据驱动第二步）、注入即数据（替身口径，不代表真实模型抗注入质量）、歧义澄清、写入暂停/可信批准/幂等、批量不阻塞；
- 步数/尝试/模型调用/重试/时间上界、非法参数、未知读/写工具、同步与异步工具失败、慢模型、慢工具、不返回工具、取消中/取消后迟到结果；
- 重复消费幂等（返回原回执）、恢复状态机（executing/unknown/query_failed/not_found → 保持核验；committed → 恢复；detail 不可读 → 只读；failed_no_effect/not_executed → 新身份重核）、提案前提矩阵（cancelled/actor/session/missing/expired/version 全拒绝）；
- LocalRuntime：审批恢复、取消 abort、历史只读恢复、迟到 yield 丢弃、恢复后批准 RED/三条 GREEN（无可信批准/旧版本/匹配）、响应丢失后按原 operation_id 恢复（业务写仍 1）、无回执锁死；
- 出口违规必须影响最终退出码（子进程吞异常反例 exit≠0）。

分层、逐项说明与运行方法见 `docs/yaya-v1/runtime-poc.md`；实际解析版本（core 0.3.22 / store 0.3.16 / tap 0.9.20 / assistant-stream 0.3.46 / zod 4.6.5+4.3.6 并存等）亦记录在该文件。

### 8.3 证据分层口径

- source_only/类型：SDK 与 assistant-ui 的发布 d.ts/源码；registry 声明（实取 JSON）。
- runtime_unit_mock：jsdom + React 19 + 真实发布包；是 DOM 模拟，**不是真实浏览器验收**。
- unit/simulated：模型、工具、服务端、写入计数全为进程内替身。
- real_provider / 真实 HTTP/DB / 浏览器 / 部署：**NOT_RUN**（预算 40/40 未动，未读 `.env`）。

---

## 9. 阻塞项

1. **无原生 tool_calls**（已安装 SDK 与当前路径）→ 必须走 5.1-A 有界循环；若主评审要求协议级 Function Calling，先核实方案 B 官方通道。不得再用“必须降级为单步宏”的表述。
2. **提案/批准协议映射未冻结**（3.2 是草案，需 YAYA0 契约接收）：可信批准记录与本地 part 的映射、actor/session/状态/版本核对字段、恢复路线按 `operation_id` 查询的 DTO、回执原子性；替身字段只是最小替身形状，最终以契约为准。
3. **zod**：根 4.3.6 可保持（Standard Schema 结构边界两种场景均编译通过）；若产品选择统一升级，属 YAYA-UI1 锁变更，TECH0 不改锁。
4. **组件来源**：registry 内容可变，`@latest` 不可锁；需按 2.3 选定手工最小方案或锁定 CLI+逐文件评审。
5. **对象存储部署配置/隔离**：官方文档定义了物理隔离，但本项目实际桶/授权/环境覆盖未验证（MEDIA/QA）。
6. **真实 provider 协议/视觉/usage/限流、SDK 流关闭的上游效果**：NOT_RUN。
7. **assistant-ui 版本漂移**：锁 0.15.23；官网已含 0.16 弃用说明。

---

## 10. 下一轮最小真实 smoke 清单（需预算/资源授权）

| # | 项目 | 最小步骤 | 需要的授权 |
| --- | --- | --- | --- |
| 1 | Coze 视觉 | 合成非幼儿图片 → sharp 压缩 → base64 data URI → `invoke`，确认可用与大小上限 | 真实模型预算 1 次 |
| 2 | Coze 流式与取消 | `LLMClient.stream()` 固定短提示；到达若干 chunk 后调用 `iterator.return()`，记录是否停止消费/是否仍有迟到 chunk；上游取消效果另记 NOT_RUN | 真实模型预算 1–2 次 |
| 3 | StepFun 视觉（若保留） | 直连 REST `image_url` 合成图 | 真实模型预算 1 次 |
| 4 | 公开检索 | 1 个无幼儿信息的教育关键词，核对 url/site_name/publish_time 与失败语义 | 搜索服务授权 |
| 5 | 对象存储 | 专用前缀上传→list→presign（短 TTL）→read→delete；核对开发/生产桶身份与隔离 | 桶/部署授权 |
| 6 | 服务端提案/回执 | 隔离库内：pending→可信批准→consume+写原子、重复消费回执、取消/过期/换账号/换 session/改内容拒绝、跨会话重新核对、**响应丢失后按原 operation_id 查询恢复且不重发** | 隔离库授权 |
| 7 | assistant-ui 浏览器 smoke | 侧栏↔工作区同会话、选图/拍照上传与重试、审批暂停/拒绝/批准（服务端守门）、刷新无自动执行、流中取消、草稿保留、390/768/1440 | 测试环境 + 浏览器 |
| 8 | 取消/迟到 | 真实后端慢响应下 cancel + 迟到结果重放，核对无重复写入；真实上游物理取消效果 | 测试环境 |
| 9 | 出口守门 | 部署构建产物中断言无自设允许的云/遥测出口（守门范围外：socket/DNS/原生层需独立网络策略验证） | 部署环境 |

---

## 11. 交付、边界与清理

- 本轮（R2）文件：`docs/yaya-v1/tech0.md`（本文件，修订）、`docs/yaya-v1/runtime-poc.md`（修订）、`scripts/yaya/check-runtime-tech0.cjs`（扩充）；`scripts/yaya/check-tech0.ts` 未改（无需修改）。
- 未改：产品源码、共享类型、`package.json`/`pnpm-lock.yaml`、AUTH/G0、schema、`.env`、`scripts/harness-safety.ts`；未建 mock 路由；未 push/部署/合并。
- scratch：`%TEMP%\opencode\yaya-tech0-poc`（候选依赖 + 行为脚本 + registry 核对）为本人自建，保留以便复跑；可复现步骤见 `runtime-poc.md`；未覆盖或清理他人 scratch。
- 真实请求计数：模型 0、搜索 0、对象存储 0、托管库 0；`.env` 未读。
- 停止点：等三线评审与主评审确认「推荐组合 + 5.1-A 协议 + 3.2 提案映射草案」后，再进入第二阶段 prompt 发布；接口变更建议交 YAYA0，本任务不改共享类型。
