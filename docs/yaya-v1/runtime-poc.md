# YAYA-TECH0-R2｜runtime 生命周期 PoC 复现说明

状态：离线替身 PoC。分层为 **runtime_unit_mock（jsdom + 真实发布包）**、**unit（有界 Agent 协议替身）**、**simulated（假服务端计数器）**；不是真实浏览器验收，不是真实 provider/DB 并发验收。真实网络出口在探针内默认拒绝；非自检的出口尝试会判定整体失败并使进程非零退出。

## 1. 运行入口

仓库唯一运行入口：`scripts/yaya/check-runtime-tech0.cjs`（CommonJS）。

探针不在启动时联网。它需要 `@assistant-ui/react@0.15.23` 等候选依赖；这些依赖**只允许**装在自有 scratch，不进项目 `package.json`/锁。探针通过 `YAYA_POC_MODULES` 或默认路径定位 scratch 的 `node_modules`：

```
默认：%TEMP%\opencode\yaya-tech0-poc\node_modules
覆盖：环境变量 YAYA_POC_MODULES=<scratch>/node_modules
```

运行（在仓库工作树根目录）：

```powershell
node scripts/yaya/check-runtime-tech0.cjs
```

项目依赖未被修改；探针文件被仓库 `eslint.config.mjs` 的 `scripts/**/*.{js,cjs}` 规则显式忽略（`eslint` 输出 ignored warning，exit 0）；`scripts/yaya/check-tech0.ts` 仍走项目 lint/tsc。

## 2. scratch 依赖的精确重建

```powershell
$poc = "$env:TEMP\opencode\yaya-tech0-poc"
New-Item -ItemType Directory -Path $poc -Force | Out-Null
Set-Location $poc
pnpm init
pnpm add @assistant-ui/react@0.15.23 react@19.2.3 react-dom@19.2.3 zod@4.3.6
pnpm add -D jsdom@27.4.0
# 仅用于 registry 源码核对（不执行会改项目的 CLI；不进项目依赖）：
pnpm add -D assistant-ui@0.0.119
```

`zod@4.3.6` 用来模拟“项目根保持 4.3.6”的情形；如需核对“显式统一升级”，改为 `pnpm add zod@4.6.5`，同样的类型边界测试两者都通过（见 tech0.md 第 2 节）。

本次实际解析版本（探针启动时自行打印，pnpm 10.19.0）：

| 包 | 解析版本 |
| --- | --- |
| @assistant-ui/react | 0.15.23 |
| @assistant-ui/core | 0.3.22 |
| @assistant-ui/store | 0.3.16 |
| @assistant-ui/tap | 0.9.20 |
| assistant-stream | 0.3.46 |
| assistant-cloud（传递，未实例化） | 0.2.4 |
| zustand（传递） | 5.0.15 |
| radix-ui（传递伞包） | 1.6.7 |
| safe-content-frame | 0.0.31 |
| react-textarea-autosize | 8.5.9 |
| zod（@assistant-ui/react 自己的依赖） | 4.6.5 |
| zod（根/scratch 顶层） | 4.3.6 |
| react / react-dom | 19.2.3 |
| jsdom | 27.4.0 |

探针顶层用 `createRequire` 从 scratch 根解析直连依赖；传递依赖从 `@assistant-ui/react` 的解析目录二次解析（pnpm 严格布局）。`react`/`react-dom` 与 runtime 内部引用解析到同一实体，因此 React 实例唯一。

## 3. 输出与判定

- **32 项 PASS**，最后一行 `check-runtime-tech0 OK`，exit 0；任一 FAIL（含出口违规）则打印 JSON summary 后 exit 1。
- 末尾 JSON summary：`checks`、`red`（危险行为观察）、`green`（守门后行为）、`simulated`（替身计数）、`real_egress`。
- `real_egress` 字段：`actual_sent: 0`（覆盖入口在 I/O 前抛出；`actual_sent_basis` 说明依据）、`attempted_denied_total`、`attempted_denied_non_self_test`、`self_test`、`denied_by_kind`、`gate_scope`、`gate_uncovered`。计数是实际发生的调用计数，不硬填。
- 出口违规规则：自检调用（`unit/network-gate`）单列；其余任何被拒出口（即使调用方 `try/catch` 吞掉异常）计入 `violations`，追加 FAIL 检查并 exit 1。子进程反例 `unit/egress-violation-fails-exit` 在探针内部用 `YAYA_POC_EXTRA_EGRESS=1` 复测该路径。

## 4. 场景与证据分层

### 4.1 有界 Agent 协议（unit/simulated）

| # | 检查名 | 证明内容 | 关键观察 |
| --- | --- | --- | --- |
| 1 | unit/closed-loop-read-feedback | 模型替身先读 `list_class_children`，**依据第一条结果的第二个孩子**再读 `list_child_observations`，再终答并带来源；不是预写固定两步宏 | modelAttempts=3，tools=…children>…observations，target=c2，answer 引用 o2,o3 |
| 2 | unit/injection-is-data | 工具结果里的“系统指令”文本只作为数据；**替身口径**，不代表真实模型抗注入质量通过 | 0 提案 |
| 3 | unit/ambiguity-clarifies | 意图不明只澄清、不调用工具 | toolCalls=0 |
| 4 | unit/write-pauses-until-approval | 写入先出提案并暂停；无可信批准不执行；可信批准后执行一次；重复消费 `already_consumed` | writes 0→1，no_trusted_blocked=true |
| 5 | unit/batch-does-not-block | 批量 3 项：可信批准 1、3 执行，2 保持 pending，不互相阻塞 | executed=2，pending=1 |
| 6 | unit/bounds-stop-runaway | 循环请求工具在 `maxToolSteps`/`maxToolAttempts` 内停止 | stoppedBy=max_tool_steps，toolCalls=3 |
| 7 | unit/invalid-args-rejected | 参数 schema 先校验，非法参数不触达工具 | stoppedBy=invalid_args:list_child_observations |
| 8 | unit/tool-error-retry-bounded | 同步工具异常按 `maxToolRetries` 重试后停止 | attempts=2 |
| 9 | unit/async-tool-reject-retry-bounded | **异步 rejection 被 await**，进入同一有限重试边界后停止；不产生答案/提案 | stoppedBy=tool_error，attempts=2 |
| 10 | unit/slow-model-deadline | 模型 70ms 返回、deadline 10ms：等待超时后不创建提案 | stoppedBy=deadline_after_await，proposals=0，modelAttempts=1 |
| 11 | unit/slow-tool-deadline | 慢工具结果迟到：不被消费、不产生后续 | stoppedBy=deadline_after_await，consumed=0，toolAttempts=1 |
| 12 | unit/tool-never-returns-deadline | 永不 settle 的工具在 deadline 内停止，无悬挂句柄 | stoppedBy=deadline_after_await |
| 13 | unit/cancel-mid-tool-no-write | 工具等待中取消：await 返回后重查取消状态，不消费结果、不建提案 | stoppedBy=cancelled，toolCalls=0，proposals=0 |
| 14 | unit/late-model-after-cancel | 取消后模型才 resolve：结果被丢弃，不建提案 | stoppedBy=cancelled，modelCalls=0，modelAttempts=1 |
| 15 | unit/unknown-write-tool-rejected | 未登记的写工具名不进入提案（写白名单） | stoppedBy=unknown_write_tool:delete_all_children，proposals=0 |
| 16 | unit/model-call-budget | 模型请求数有上界 | stoppedBy=max_model_calls，modelAttempts=2 |
| 17 | unit/proposal-premise-matrix | 取消/换账号/换 session 无本会话可信批准/缺前提/过期/版本不符 → 全部拒绝；匹配前提写 1 | 6 类 reason，writes=1 |
| 18 | unit/recovery-state-machine | **恢复状态表**：executing/unknown/query_failed/not_found → 保持核验；committed → 恢复结果；detail 不可读 → 只读；failed_no_effect/not_executed → 新操作身份重核 | 仅明确未执行才 reexecute，新 id ≠ 原 id |
| 19 | unit/late-run-result-guard | 取消后旧 run 迟到结果：弱实现派发下一步，带 run 标识/状态前提的实现丢弃 | naive=1 vs guarded=0 |
| 20 | unit/duplicate-execution-idempotent | 同一提案消费两次：业务写仍 1，且返回**原回执** | attempts=2，business_writes=1，original_receipt_returned |

### 4.2 LocalRuntime 生命周期（runtime_unit_mock + simulated）

| # | 检查名 | 证明内容 | 关键观察 |
| --- | --- | --- | --- |
| 21 | runtime/approval-pause-resume | 审批暂停；`respondToToolApproval` 后 LocalRuntime 自动再跑 adapter 且 `approved=true`；同一 part 二次响应被拒 | runs=2；“Tool call has no pending approval” |
| 22 | runtime/cancel-aborts-adapter | `cancelRun()` → adapter `abortSignal` 触发，消息 `incomplete/cancelled` | events=start>aborted>end |
| 23 | runtime/history-load-no-autorun | `history.load()` 不返回 `unstable_resume` 时只读恢复、不自动执行 | loaded=1，adapterRuns=0 |
| 24 | runtime/late-yield-dropped | 取消后迟到 yield 被 runtime 丢弃，但 adapter 副作用仍发生（无 iterator.return） | dropped=true；continued_after_abort=true |
| 25 | runtime/restored-approval-naive-RED | 反例：恢复后仅凭本地 `approved=true`，弱 adapter 直接业务写，未读服务端记录 | adapterRuns=1，naive_write_calls=1 |
| 26 | runtime/restored-local-approved-no-trusted-GREEN | 旧会话本地批准 + 当前会话无可信批准 → 拒绝，写 0 | reason=no_trusted_approval |
| 27 | runtime/restored-trusted-stale-GREEN | 当前会话可信批准但内容版本已变 → 拒绝，写 0 | reason=premise_version_mismatch |
| 28 | runtime/restored-trusted-match-GREEN | 当前会话可信批准 + 前提匹配 → 执行一次（不永久锁死） | server_side_write_calls=1 |
| 29 | runtime/lost-response-recovery | **原写入成功但响应丢失** → 换设备恢复 → 按原 operation_id 查询 → 只回执原结果，业务写仍 1 | write=1，query=1，reexecutions=0，receipt=r-p-1 |
| 30 | runtime/approved-without-receipt-lockout | 已 approved 无回执的消息恢复后不自动执行，本地也无法再次批准；由恢复协议按状态处理 | restored adapterRuns=0；re-approve 被拒 |

### 4.3 出口守门与退出码（unit + 子进程）

| # | 检查名 | 证明内容 | 关键观察 |
| --- | --- | --- | --- |
| 31 | unit/network-gate | 自检被拒出口单列，不计违规 | self_test=1，violations=0，scope=4 |
| 32 | unit/egress-violation-fails-exit | 子进程额外被拒出口（异常被吞）→ 主流程非零退出 | child_exit=1，violation reported |

### 4.4 R1→R2 结论修正记录

- 原 `runtime/restored-approval-guarded-stale-GREEN` 与 `...match-GREEN` 均基于**adapter 自报前提**、未要求可信批准记录，不能证明“换账号/换 session/已取消”被拒绝；主评审已复现旧替身在“已取消提案 + 换账号 + 换 session + 同版本”下仍写入一次。R2 拆分为 #26/#27/#28 三条，以可信批准注入 + 状态/actor/session/版本全核对为准；旧结论作废。
- 原 `unit/injection-is-data` 的替身结论仅代表“替身按数据传递”，不构成真实模型抗注入质量证据。
- 原 19 项中其余 17 项保留（含 `restored-approval-naive-RED` 与 `approved-without-receipt-lockout`，后者语义改为“恢复协议按状态处理”，不再暗示只能重开）。

注：所有写操作为**假服务端计数器**（simulated），只验证协议与守门逻辑，不代表真实数据库并发/回执验收。

## 5. 观察到的真实发布包行为（引用点）

- `respondToToolApproval` 后自动再调用 adapter：`@assistant-ui/core@0.3.22` `dist/runtimes/local/local-thread-runtime-core.js:883-928`（审批写入 part 后 `_runLoop`）。
- 取消时丢弃后续 yield：同文件 `:713-727`（`abortSignal.aborted` 检查）。adapter 的 generator 没有被 `return()`，副作用继续。
- 历史加载自动恢复仅当 `load()` 返回 `unstable_resume:true`：同文件 `:308-313`。本方案禁止返回该标记。
- 未决 approval 在「后续消息跟随」时被本地标记 `resolution:"cancelled"`：同文件 `:29-52,176`；这是本地 part 状态，**不是服务端提案状态**。
- 审批/拒绝语义与人工工具暂停：`dist/runtimes/local/should-continue.js` 与官方文档 `runtimes/custom/local-runtime#approval-gates` 一致。

## 6. 清理与边界

- 探针与文档进入仓库；scratch（`%TEMP%\opencode\yaya-tech0-poc`）为本人自建资源，保留以便立即复跑；未覆盖或清理他人 scratch，删除后按第 1、2 节可完全重建。
- 未读 `.env`；未调用真实 provider/搜索/对象存储/托管库；未迁移数据库；未 push/部署/合并；预算 40/40 未动。
