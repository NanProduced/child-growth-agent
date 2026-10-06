# YAYA-UI1 交付：芽芽聊天界面与真实客户端适配

- 基线：`b8bf68313e0ac7b1afbf6589ae9e590e50d71153`（YAYA-C2 联合检查）
- 分支：`codex/yaya-ui1`；工作树：`%TEMP%\opencode\yaya-ui1`
- 状态：实现完成；离线检查 / 浏览器 fixture 验收 / validate / next build 通过；未部署、未 push、未合并 main。
- 真实 provider / 搜索 / S3 / 托管数据库请求：**0**（浏览器验收在网络层拦截全部 `/api/**`；本地 dev 无 `.env`，身份服务 fail closed）。
- harness `scripts/harness-safety.ts` blob：`6702f2ddf3b436e79f8c92ae8756c33f611a8503`（未变）。

## 1. 交付范围（唯一 owner 文件）

| 文件 | 内容 |
|---|---|
| `src/components/yaya/yaya-provider.tsx` | 身份键控运行时挂载（`useRemoteThreadListRuntime` + `useLocalRuntime`）、与会话就绪探测 |
| `src/components/yaya/yaya-entry.tsx` | 右下入口、`aria-live` 状态（响应中/异常） |
| `src/components/yaya/yaya-panel.tsx` | 桌面非模态侧栏 / 手机全屏、Escape 关闭与焦点归还、权限卡 |
| `src/components/yaya/yaya-thread.tsx` | 消息视口、空态、读取未完成说明 |
| `src/components/yaya/yaya-message.tsx` | 用户/助手消息、data part 组件映射 |
| `src/components/yaya/yaya-markdown.tsx` | 安全 Markdown（无原始 HTML、仅 http(s) 链接、长答展开） |
| `src/components/yaya/yaya-parts.tsx` | 来源/澄清/查询/停止/未知/回执/历史状态卡 |
| `src/components/yaya/yaya-proposal.tsx` | 待核对提案卡（多幼儿独立子卡、仅提交选中且完整项） |
| `src/components/yaya/yaya-composer.tsx` | 输入区：附件条、上下文 chips、IME 安全发送、停止 |
| `src/components/yaya/yaya-attachment.tsx` | 可复用：选图、附件条、图片查看器、图片库 |
| `src/components/yaya/yaya-thread-list.tsx` | 历史会话：新建/切换/删除（二次确认） |
| `src/components/yaya/yaya-workspace.tsx` + `yaya-review-panel.tsx` | `/assistant` 工作区 + 宽屏批量核对台 |
| `src/components/yaya/client/{api,schemas,wire,actions,mapping,parts,store,adapters}.ts` | 客户端协议消费、校验、适配器与恢复动作 |
| `src/app/assistant/page.tsx`、`src/app/layout.tsx`、`src/app/globals.css` | 工作区路由、全局挂载、宽屏核对台去重样式 |
| `public/assets/yaya/yaya-avatar.png` | 批准透明头像 v2（精确素材，不整分支合并） |
| `scripts/yaya/check-ui1-client.ts`、`scripts/yaya/__fixtures__/yaya-ui-fixtures.json` | 纯函数检查（37 项）与离线 fixture |
| `scripts/acceptance/{check-yaya-ui.cjs,run-yaya-ui-check.ps1,yaya-preview-page.template.tsx}` | 浏览器 fixture 验收（临时预览路由，跑完删除） |
| `docs/yaya-v1/ui1-surface-brief.md`、本文件 | 表面 brief 与交付 |

未改：业务服务/API/schema/AUTH 规则、冻结 DTO、`.env`、main、首页与全站画风。

## 2. 运行时与适配器签名

- `createYayaChatModelAdapter(store, aui): ChatModelAdapter`
  - `POST /api/yaya/conversations/{id}/runs`（`YayaRunStartRequest`，严格字段）；
  - 逐行 `parseYayaRunWireLine` + 结束 `validateYayaRunEventStream`；坏行/错 run/缺终态/终态矛盾 → `incomplete` + `yaya-run-error` 卡，不显示成功；
  - 新会话先 `threadListItem.initialize()` 拿 remoteId；`expected_conversation_revision` 取共享写入链之后的当前版本；
  - 上下文 chips 只并入本条 `user_text`（协议无独立字段；业务 raw_text 由历史适配器单独保存，见 §3.8）。
- `createYayaThreadHistoryAdapter(store, aui): ThreadHistoryAdapter`
  - `load()` 只读投影 → `ExportedMessageRepository`，**永不返回 `unstable_resume`**；
  - `append()` 存储正文 + 必要原操作标记（`raw_input` / `model_text` / `tool_result`），`client_message_id` 幂等、`expected_conversation_revision` 前提，409 时重新读取版本重试一次；
  - 不实现 `update`/`delete`（服务端只有 insert 幂等接口，避免重复投影）。
- `createYayaAttachmentAdapter(): AttachmentAdapter`
  - 单图单请求、10MiB/JPEG-PNG-WebP 客户端快速失败、`client_upload_id` 稳定、AsyncGenerator 回传上传进度；
  - `send()` 生成 `…/uploads/{id}/content?variant=thumbnail` 授权 URL；失败可移除/重试，不丢文字。
- `createYayaThreadListAdapter(store): RemoteThreadListAdapter`（remoteId = conversation_id；重命名/删除带版本前提，409 重读一次；不实现归档；标题由服务端 `projected_title`，本地不生成标题）。
- `createYayaRuntimeAdaptersHook(store): () => RuntimeAdapters`（per-thread `history`+`attachments`；适配器引用跨渲染稳定）。
- 动作出口：`fetchProposalProjection / approveProposalItems / rejectProposalItems / cancelProposal / executeApprovedOperations / queryOriginalOperation / lookupOriginalRun`。

## 3. 守门逐项对照

| 要求 | 实现 |
|---|---|
| 只消费批准协议 | `api-contract.ts` 的 schema / 校验函数；无影子协议、无自报权威字段 |
| 先 HTTP 状态，再事件/语义 | `parseOrThrow` / `yayaHttpError` / `readYayaRunStream`；200 空对象/坏 JSON/坏行不成功 |
| 编辑后重新准备、旧批准失效 | 提案卡每次从 `GET /proposals?proposal_id=` 读投影；批准只在显式点击后随选中项提交 |
| 本地 runtime approved 不是授权 | 不使用 `respondToToolApproval`；无 tool part 执行路径 |
| 历史加载不自动执行 | 无 `unstable_resume`、无 `resume` 实现 |
| 结果未知只查询原 operation | `queryOriginalOperation`（GET，只读）；执行响应经 `assessYayaOperationsExecutionResponse` 语义核验 |
| 已保存详情不可读 | 只读重读详情，不重复提交（回执卡文案与按钮） |
| 关闭/停止/取消提案/撤回业务分开 | `cancelRun` 停止回答；提案卡"取消提案"只取消 pending；均不宣称撤销已提交业务 |
| 换账号清理旧投影 | Provider 以身份键重建；迟到响应随闭包失效 |
| 503 不冒充匿名/空数据 | 会话列表失败显示"会话读取暂未完成"，不渲染空会话；身份 503 fail closed |
| proposal 事件可能只有 id | 卡片只消费 `proposal_id`，投影与 `operation_ids` 全部来自 DATA GET；事件内容不参与执行身份 |
| 密码不进入聊天/模型 | 无密码输入路径；无安全控件意图渲染实现（未接入，见 NOT_RUN） |

### 3.8 状态分层与持久化映射

- 原文/教师补充：`raw_input` 片段（用户消息）；图片解读/模型文本：`model_text`；工具/回执：`tool_result`。
- 消息 `execution_state`：提案 → `pending_approval`；成功回执 → `executed`；未知/失败回执 → `unknown`。
- 历史重载只重建文本与状态标记（受限内容给说明文本），不重放任何执行。
- AI 草稿、回执与正式记录永远分层展示；未确认不画成功。

## 4. 图片管线对照

- 批量选择至多 8 张（选图组件逐批传入），每张独立请求；单图 >10MiB / 非允许格式即时失败。
- 失败只影响该图：文字与其他图片保留；可"移除"或用同一文件重试（`client_upload_id` 幂等）。
- 不抓任意远程 URL；模型图/预览只走 `GET /api/yaya/uploads/{id}/content?variant=`（同源凭据、无公开 URL）。
- 可复用组件：`YayaImagePicker` / `YayaAttachmentStrip` / `YayaAttachmentGallery` / `YayaImageViewer`。
- 传统录入/Review/档案页的正式挂载归后续整合 owner；本轮不改这些页面（组件已发布，页面未接入）。

## 5. 验证

### 5.1 命令与结果

| 检查 | 结果 |
|---|---|
| `pnpm validate`（ts-check / lint:build / lint:style） | 全部 exit 0 |
| `pnpm exec next build` | 通过（`/assistant` 动态路由生成） |
| `pnpm tsx scripts/yaya/check-ui1-client.ts` | **37/37** |
| `pwsh scripts/acceptance/run-yaya-ui-check.ps1 -Port 3213` | **38/38**，check exit 0 |
| `scripts/harness-safety.ts` blob | 未变 |

纯函数检查覆盖：NDJSON（合法/坏行/坏协议/序号缺口/重复终态/终态后事件/矛盾终态/HTTP 失败）、
Markdown 安全（HTML 文本化、`javascript:` 不成为链接、https 链接、长文保真）、消息↔投影映射
（raw_input 附件提取、提案 pending 无授权字段、saved 回执 executed、受限历史不冒充可读）、
URL 白名单、错误分层文案、选中计划与 `assessYayaOperationsExecutionResponse`（成功/未证明成功/缺项）。

### 5.2 浏览器 fixture 验收（场景分层）

- 类型：组件/交互层（真实 Chrome + 自建 fixture + Playwright 网络拦截），**不接真实 API/DB/模型**。
- 临时预览路由 `src/app/yaya-preview` 由 runner 创建并删除；仓库不保留可访问 mock 路由。
- 证据目录：`%TEMP%\yaya-ui1-browser`（`results.json`、`acceptance-run.json`、截图）。
- 截图：`1440-panel-history`、`1440-panel-long-answer`、`1440-panel-receipt-recheck`、`1440-panel-proposal-saved`、`1440-panel-service-failure`、`1440-workspace`、`768-panel`、`390-panel`。
- 已验收：三视口全屏/侧栏切换与无横向溢出、核心目标 ≥44px、历史投影（含 metadata_only 说明与未知操作标记）、长答展开、HTML 不执行/危险协议不渲染/https 可点、回执未知→只读重读→按回执成功、上传失败保留文字并可移除、多幼儿独立卡 + 仅完整项可选 + 确认后才显示已保存、unverified 不显示成功、Escape 关闭、503 不冒充空数据、无未捕获页面异常。

### 5.3 依赖增量

- 直接依赖：仅新增 `@assistant-ui/react: 0.15.23`（精确锁版）；未安装 AI Elements / AssistantCloud（传递包不作为入口使用）/第二状态库；根 zod 保持 4.3.6。
- 锁文件：无既有版本升级/降级（removed versions = 0）；新增 12 个传递包（core/store/tap/assistant-stream/assistant-cloud/nanoid/radix-ui/react-textarea-autosize/safe-content-frame/secure-json-parse/use-* /zod@4.6.5/zustand）。其余 diff 为 pnpm 重新计算 peer 后缀导致的键重排。

### 5.4 清理证明

- 预览路由与进程：runner 只清理本轮 PID+StartTime 核实的进程树；`acceptance-run.json` 记录 `route_cleaned=true`、`server_cleaned=true`；
- `.next` 不整目录清空；类型生成物按快照恢复，快照若已被上一次预览污染则删除该生成物（可再生成）；
- scratch：`%TEMP%\opencode\yaya-ui1`（工作树）、`%TEMP%\yaya-ui1-browser`（证据）为本人创建；未动他人资源；`git status` 无临时文件残留。

## 6. NOT_RUN 与已知限制

- AGENT-APP1 的 `runs` 发起/查询/取消三条路由与 TOOLS1 的 `operations` POST 尚未实现：真实接线存在，验收以 fixture 拦截完成；未声明业务闭环。
- 真实认证/HTTP/数据库/对象存储/模型、真实搜索结果：NOT_RUN。
- 真机软键盘与真机截图：NOT_RUN（未做视觉仿真替代；只实现 `100dvh` + 安全区布局）。
- Safari/iOS、屏幕阅读器人工走查、真实图片字节渲染：NOT_RUN。
- 入口旁路状态本轮实现了"响应中/异常"；"有一条待确认/保存中"未驱动入口（卡片内有文字状态）。
- 提案事件的 id-only 变体：当前 api-contract 冻结 schema 要求完整提案对象；客户端只使用 `proposal_id` 并一律回读投影，待协议 v2 放行 id-only 形状时无需改 UI。
- 上下文 chips 通过 `user_text` 有限并入（协议无独立字段）；是否被 AGENT-APP1 采纳为结构化上下文取决于后续协议。

## 7. 停止点

本地提交，停止等主评审；不部署、不合并 main、不自行接入未交付接口。
