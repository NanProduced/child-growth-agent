# YAYA-TOOLS1-R1 交付：模型前写保护、准备态批准守门与锁后版本核对

2026-10-06。任务：关闭主评审 `yaya-tools1-review-20261006` 的三个 P1（A 模型前写保护、
B needs_prepare 批准前提、C 锁后版本核对），先补反例证明 RED，再修共享根因。
起点 `30153321022fcce7dca3edc24fe4237ccfac4495`，沿 `codex/yaya-tools1` 追加；
完整候选 SHA 见交付回复（本文件随候选提交落地）。

未改：冻结 `types.ts`/API0/Agent 内核/AUTH 规则/MEDIA/READ1/schema/package-lock/UI/APP1；
`scripts/harness-safety.ts` 保持 blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。
真实 provider / 搜索 / S3 / 托管库请求 0；未读 `.env`；未使用新增 20 次真实模型额度。

## 1. 文件表

| 文件 | 性质 |
|---|---|
| `src/lib/yaya/data/operations.ts` | 修改：抽取 `verifyApprovedOperations`（同 client、核验但不消费批准）、`lockExecutionTargets`（稳定锁序）与锁后新鲜度复核；`executeApprovedOperations` 改为复用同一核验后消费 |
| `src/lib/yaya/tools/write/execute.ts` | 修改：共享 executor 入口的模型前预检（`withPrivateWrite` + `verifyApprovedOperations`）；`needs_prepare` 准备保存前再核验并用同一 client 落账 |
| `src/lib/yaya/tools/write/registry.ts` | 修改：业务版本统一为 `COALESCE(updated_at, created_at)::text`（prepare 与执行解析同一助手）；准备态写入收敛为单笔条件 UPDATE（`updateObservationAgentContextWithClient`） |
| `src/lib/yaya/tools/write/types.ts` | 修改：`prepare_write` 契约改为接收调用方已核验事务的 client |
| `src/lib/accounts/repository.ts` | 修改：`getTeacherAccountRevisionWithClient` 使用 `COALESCE(updated_at, created_at)::text`（本人上一轮新增的 TOOLS1 共享读取；登录/会话/密码/角色规则不变） |
| `scripts/yaya/check-tools-write-r1-db.ts` | 新增：R1 专属真实链路检查（`TOOLS1_R1_CASE=a|b|c|all`），85 项 |
| 本文件 | 文档 |

`data/index.ts` 无需改动：其 `export * from "./operations"` 已导出新核验入口。
未新增 DATA 公开 DTO、未改冻结 `YayaExecuteApprovedInput`，没有 skip/approved/consume 绕过开关。

## 2. RED 证据（修复前，同一起点）

主评审独立探针（`probes.ts`，RED 实跑）：

| 探针 | RED 实测 |
|---|---|
| A/missing_csrf | `model_calls=1` 后才 `csrf_rejected` |
| A/untrusted_origin | `model_calls=1` 后才 `csrf_rejected` |
| B/cancelled_before、cancelled_during_model、expired_before、same_scope_transfer_during_model | 全部返回 `needs_prepare` 且 `review_saved=true`、批准未消费、未归档 |
| B2/preparation-save-partial-commit | `context_changed=true`、`review_still_present_after=false`（旧 review 被第一笔清除） |
| C/class-version-after-lock-wait | `wait_observed=true`、返回 1 条回执、`final_name=APPROVED_STALE_NAME` |
| D/actual-POST-missing-csrf | `status=500 server_error`，被回环守门截获的模型尝试 2 次 |

仓库内新增 R1 检查在修复前的分组 RED（逐组单跑，cleanup 均 verified）：

- A：`passed 14 / failed 7`（缺 CSRF、错误 Origin 均先调用模型；route handler 返回 500 而非 403，且到达 provider 守门）。
- B：`passed 26 / failed 21`（四种失效前提均返回 needs_prepare 并写入 review；B2 部分提交；合法归档被 B2 破坏）。
- C：`passed 3 / failed 10`（C1 旧批准覆盖新名称且落回执；C2 观察版本竞争未被发现）。

## 3. 修复（共享根因）

### A. 模型调用前完成写请求守门

`createYayaOperationsExecutor.execute` 在 `loadOperations`/`compute` 之前，用一个
`withPrivateWrite` 短事务完成：有效账号与原会话、可信 Origin、会话绑定 CSRF，
并调用 DATA `verifyApprovedOperations` 核验原批准前提（含目标行锁与锁后版本）。
事务结束、模型尚未派发；最终保存仍在新的 `withPrivateWrite` 事务内由
`executeApprovedOperations`（内部复用同一核验）新鲜重核。operations POST handler 只
转交 executor，因此 route 与 executor 两条入口同时覆盖，不是路由补丁。

### B. needs_prepare 也受可信批准与原始前提约束

- `data/operations.ts` 抽取 `verifyApprovedOperations`：与正式执行共用同一套判定
  （提交者/原 session/CSRF、批准取消/到期/消费、逐项身份/内容摘要/附件/资源事实、
  `evaluateApprovalExecution`），只核验不消费；正式执行与准备态保存都调用它。
- `needs_prepare` 有准备态写入时：在新的 `withPrivateWrite` 事务内先再次
  `verifyApprovedOperations`（覆盖模型等待期间的取消/到期/换会话/同权转班/版本变化），
  再用同一个 client 执行准备写入；失败整单回滚。合法准备保存不消费正式归档批准、
  不归档、不返回正式保存成功。
- 准备写入从“两笔包装函数事务”收敛为**单笔带前提的条件 UPDATE**
  （`updateObservationAgentContextWithClient`）：清旧 review 与存新 review 在同一语句，
  第二笔失败不再可能留下部分提交；任何语句失败时原上下文、旧 review、raw_text、
  确认稿完整保留。

### C. 目标行锁后核对业务版本

- `verifyApprovedOperations` 在逐项核对之前先 `lockExecutionTargets`：按稳定顺序
  **children → classes → observations → teacher accounts**（`FOR UPDATE`，同类按 id 排序），
  与既有 children 优先、确认链路（child→observation）、班级历史保护（class 行锁）
  锁序一致；只锁当前操作明确指向的目标行，普通只读 getter 不加锁。
- 锁后逐项读取当前资源事实/业务版本；随后按**当前时间**复核批准到期，并按
  `app_sessions` 当前事实复核原会话有效性（与 AUTH private-auth 同一判定：
  `revoked_at IS NULL AND expires_at > clock_timestamp()`）。
- 业务版本口径统一为 `COALESCE(updated_at, created_at)::text`（prepare 快照与执行解析
  共用 `entityRevisionWithClient` / `getTeacherAccountRevisionWithClient`）：既有 schema 的
  `updated_at` 可空，旧实现把“缺失版本”当成可跳过，班级改名可绕过版本前提；现在
  child/observation/class/teacher 四类都有稳定非空修订且保留微秒精度。

## 4. GREEN 证据

### 4.1 R1 专属检查（`pnpm exec tsx scripts/yaya/check-tools-write-r1-db.ts`）

| 分组 | 结果 |
|---|---|
| A（executor + route handler 正反例） | **21/21**：缺 CSRF/错误 Origin/撤会话/停用账号模型 0；403 csrf_rejected / 401 unauthenticated；合法 executor 模型 1 次并消费批准；合法 route（无模型工具）200 saved；provider 守门命中 0 |
| B（准备态守门与原子保存） | **53/53**：执行前取消/过期、模型等待中取消/过期、换会话、同权转班、版本变化全部拒绝且 agent_context 逐字节不变、未归档、批准不消费；合法复核保存准备态不归档；B9 故障注入后旧 review/上下文/原文/确认稿完整保留；随后合法归档成功 |
| C（锁后版本核对） | **13/13**：C1 班级改名受控交错 `wait_observed=true`，旧批准 `approval_invalid/business_version_changed`，他端新名保留、回执 0 新增、批准不消费；C2 观察版本竞争同上 |
| 合计 | **85/85**，`cleanup:"verified"`，`real_provider_requests=0`（provider 守门 hits 0） |

分层标注（输出 JSON）：real executor（真实 AUTH 会话/CSRF + 隔离 PG）、real route handler
（进程内 NextRequest，不含 Next server）、model double（`invokeLlm` 注入，真实出口 0）、
provider guard（`LLM_*` 指向自有回环守门并计数）。

主评审 `probes.ts` 在修复后再次实跑：A 两类 `model_calls=0`、B 四类不再保存 review，
探针因此在 B2 的“需存在旧 review”前置断言处停止（该前置正是旧部分提交行为的产物）；
B2 等价场景已由 R1 检查的 B8+B9 以合法 review 前置覆盖。

### 4.2 原检查与回归（本候选实跑）

| 检查 | 结果 |
|---|---|
| `check-tools-write.ts`（原 112） | **112/112**（未删断言） |
| `check-tools-write-db.ts`（原 134） | **134/134**，cleanup verified |
| `check-tools-write-r1-db.ts`（新增） | **85/85**，cleanup verified |
| `pnpm validate`（tsc/eslint/stylelint） | 通过 |
| `check-save-consistency` / `check-agent-flow` / `check-teacher-clarify` | 24/24 / 30/30 / 13/13 |
| `check-auth-contract` / `check-guide-contract` / `check-contract` / `check-preflight` | 36/36 / 19/19 / 68/68 / 15/15 |
| `check-agent-engine` / `check-tools-read` | 29/29 / 189/189 |
| `check-data` / `check-data-r1` | 27/27 / 10/10 |
| `check-data-db` / `check-data-r1-db` / `check-data-r1-media-db` | 116/116 / 58/58 / 67/67 |
| `check-business-access` | 113/113，cleanup verified |
| `check-tools-read-db` | 87/87，cleanup verified |
| `check-guide-write-flow` | 123/123 |
| `check-integration-prep-joint` | 31/31，cleanup verified |
| `check-integration-media-db` / `check-integration-http` | 88/88 / 17/17（真实 Next HTTP） |

### 4.3 基线遗留（非本轮引入，未修）

`scripts/check-guide-evidence-db.ts` 与 `scripts/check-classes.ts` 仍走已退役旧口令
`src/lib/auth.ts createSessionToken`，离线阶段即抛 `旧口令会话已退役`；与上一轮记录一致。

## 5. 资源清理

- R1 检查每次运行使用一次性隔离 PG + 自有回环 provider 守门，正常与失败路径都经
  teardown/close，本轮全部输出 `cleanup:"verified"`；主评审探针复跑同样 `cleanup:"verified"`。
- 按验收标签复查无容器残留；未按端口/名称前缀误杀；未连接托管库/真实桶。
- 未读 `.env`，真实模型额度消耗 0。

## 6. NOT_RUN（明确未验收）

- operations POST 的真实 Next HTTP server / 浏览器（本轮为进程内真实 route handler；
  其余既有路由的 Next HTTP 由 `check-integration-http` 17/17 覆盖）。
- AGENT-APP1 的 run→conversation 与 run 持久化核验（`verifyRun` 仍为显式测试注入）。
- 真实 provider 模型质量、真实搜索/S3、托管库迁移、生产安全与部署。
- UI 对 `needs_prepare` 复核卡片/安全控件的消费。
