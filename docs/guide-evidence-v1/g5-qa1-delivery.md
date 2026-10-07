# G5-QA1：实库/HTTP 验收装置的身份与清理边界修复交付说明

- 分支：`codex/g5-qa1-harness-safety`
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-g5-qa1`
- 共同基线：`6a45636b75f0d853f485b6438754d8911036e22e`（来源工作树 `...\child-growth-g5`，分支 `codex/g5-guide-evidence`）
- 状态：**装置安全检查通过（102/102）**，实库/HTTP 检查通过（87/87）。只修复验收装置的身份与清理边界；
  **不等于**并行 G5-R1 业务修复通过，**不等于**正式页面闭环，**不等于**真实模型质量或线上可部署。
- `RTK.md`：不存在（已记录，未补造）。
- 业务源码、G5 runtime/routes 检查、G0～G4 冻结内容与旧交付记录均未修改；未触碰 main 与来源工作树，未触碰 `codex/g5-r1-business-guards`。

## 1. 文件清单

新增：

| 文件 | 职责 |
|---|---|
| `scripts/harness-safety.ts` | 装置安全原语：进程身份（PID + 创建时间）、进程树归属、可核实的树终止、端口监听者归属、Docker 三态、一次性隔离库启动、模型请求守门、生成物快照恢复、独立多步清理 |
| `scripts/check-guide-evidence-harness-safety.ts` | 专属装置安全检查（102 项）：离线反例 A/B/C/D/E + Docker 实测 L + 实库装置接线静态闸门 F |

修改：

| 文件 | 变更 |
|---|---|
| `scripts/check-guide-evidence-db.ts` | 接入共享安全原语：就绪身份核验、写前数据身份比对、首笔写后直连复核、可核实进程树清理、Docker 三态清理、模型守门与生成物恢复、多步独立清理 |

仅提交以上 3 个脚本文件与本文件；未 `git add .`。

## 2. 修复内容

### 2.1 A｜HTTP 200 不等于本轮服务就绪

旧实现：预选端口 → 启动 `next dev` → 只凭 `/api/auth/status` 返回 200 判定就绪；不跟踪本轮子进程
退出/启动失败，也不核实 200 来自哪个进程。外部占位服务、端口竞争、本轮启动失败都可能被误认为就绪，
随后用固定口令登录并写业务数据。

现在：

1. `trackChildProcess` 记录子进程 PID 与创建时间（防 PID 复用），监听 `error`/`exit` 事件；
2. `waitForVerifiedService` 每轮先检查启动失败/已退出，再探测状态接口；一旦返回 200，必须通过
   `verifyPortOwnedByTree`：该端口**所有**监听者 PID 的父子链都必须能追溯到本轮子进程根，
   否则立即失败，不继续登录/关联/撤回；
3. 写业务数据前增加数据身份核验：`GET /api/children/{child2}/evidence-book` 的 JSON 必须与
   直连本轮隔离库的读模型**完全一致**（证明服务读的是本轮数据库）；
4. 首笔业务写后直连复核 `guide_evidence.revision=1`（业务请求目标证明）；
5. 不新增生产 API、假数据模式或认证绕过；不使用端口反查杀进程。

反例覆盖（`check-guide-evidence-harness-safety.ts`）：

| 反例 | 断言 |
|---|---|
| A1 外部占位服务返回 200 | 身份核验拒绝；占位服务保持存活且业务写请求数为 0 |
| A2 本轮子进程立即退出 | 即使占位返回 200 也失败，错误指向本轮服务已退出 |
| A3 端口竞争 | 本轮监听失败即失败；占位服务保持存活且写请求数为 0 |
| A4 正常本轮服务 | 监听者归属本轮、业务写请求到达正确服务 |
| A5 身份核验中途失败 | 父子关系不可读时立即失败，不继续、不按端口强杀 |

### 2.2 B｜进程清理必须可核实

旧实现：`stopServer` 先置 `serverClosed=true`，然后凭 `server.killed` 判断是否需要 `taskkill`，
忽略 `taskkill` 退出码；`server.killed` 只表示信号已发出，不表示进程已退出。

现在 `stopTrackedChildTree`：

1. 用 PID + 创建时间核实身份后才终止本轮进程树（Windows `taskkill /T /F`）；
2. 已退出/未产生 PID 的进程绝不按旧 PID 强杀；若根进程已退出，则扫描父子映射：
   发现仍存活的疑似后代即记录为非成功并列出 PID，拒绝盲目强杀；
3. 无法记录/无法核实创建身份（PID 可能复用）时拒绝强杀并记录为非成功；
4. `taskkill` 失败且进程仍存活时记录失败原因；发出终止后轮询直到确认消失（或 PID 复用）才算成功；
5. 正常与失败路径均通过 `runCleanupSteps` 独立执行：日志 FD、pg 连接池、持锁/等待中的任务（带超时）、
   本轮服务与容器各自处理，前一步失败不跳过后续；清理问题 → 非零退出；
6. 不依据端口占用推断进程所有权，不触碰已有服务和其他 agent 进程。

反例覆盖：

| 反例 | 断言 |
|---|---|
| B1 正常结束 | 按身份核验终止，进程已消失 |
| B2 子进程已退出 | 注入 kill 永不被调用；报告说明已退出 |
| B3 taskkill 失败 | 报告非成功并保留失败原因 |
| B4 创建身份无法核实 | 拒绝强杀，kill 不被调用 |
| B5 创建身份不一致（疑似 PID 复用） | 拒绝强杀 |
| B6 根进程退出但存在疑似残留后代 | 记录未知资源 PID，拒绝按旧 PID 强杀 |
| B7 持锁/等待状态失败 | 前一步异常/超时不跳过后续步骤；失败、非成功报告、超时分别记录 |

### 2.3 C｜Docker 无法核实不等于不存在

旧实现：`containerIdOf` 把 `docker inspect` 的任何失败都返回 `null`，`removeOwnedContainer`
随后把 `null` 当“不存在”并返回 `ok=true`——daemon 不可用/权限错误会被误报为清理成功。

现在 `inspectOwnedContainer` 三态：`verified`（ID + 标签可核实）/ `absent`（明确不存在）/
`unverifiable`（daemon、权限等导致无法核实）。`removeOwnedContainer`：

- `unverifiable`：不删除身份未知资源、不报成功、记录资源引用，触发非零退出；
- 标签不匹配或返回 ID 与已知 ID 不一致：拒绝删除；
- 删除只按已核实完整 ID + 标签所有权执行，`rm` 成功后再 inspect 复核 `absent` 才算成功；
- 容器 ID 未确认（如 `docker run` 失败）时按唯一容器名 + 标签核实，仍无法核实即失败；
- 保留 RUN_ID、唯一容器/库名、回环端口、写入前身份与空库检查；未恢复固定名 `rm -f` 或外部 URL 模式。

离线反例：C1 daemon 不可用；C2 rm 失败后 inspect 也不可用；C3 明确不存在；C4 标签不匹配；
C5 合法自有容器删除成功；C6–C10 名称路径、ID 不一致、仍存在、rm 成功但无法复核等边界。

Docker 实测（L）：

| 实测 | 断言 |
|---|---|
| L1 异标签容器 | 删除请求被拒绝，容器仍存在（随后由测试按自身 ID 清理） |
| L2 本轮容器 | 正常清理，inspect 明确不存在 |
| L3 启动成功但检查失败 | 路径内清理本轮自有资源，无残留 |
| L4 既有服务 | 运行前后既有容器（`zzsh-*`）全部保留 |

### 2.4 预算隔离与生成物

- 模型守门：测试进程与 `next dev` 子进程的 provider 出口改道到本地守门服务器
  （`LLM_PROVIDER=stepfun`、`STEPFUN_BASE_URL=<loopback guard>`），任何真实调用立即 502 并被计数；
  `real_model_requests` 输出的是守门计数器实际值（两次通过运行均为 0，`requests: []`），
  不是常量冒充。未修改 `src/lib/llm.ts`，未加任何生产 mock 开关，未 mock HTTP 业务 handler。
- 生成物：`next dev` 前后对 `next-env.d.ts`、`tsconfig.json` 与 `.next/{types,dev/types}/**/*.ts`
  做快照；结束后只恢复本轮改动/删除本轮新建文件，不整目录清空 `.next`。两次实库运行均只删除
  本轮新建的 3 个 dev 类型文件（`cache-life.d.ts`、`routes.d.ts`、`validator.ts`），无恢复项、无问题项。
  （`pnpm build` 属于验收步骤，其重写 `next-env.d.ts` 的副作用已单独还原。）

## 3. 验收执行与结果

顺序：先专属装置安全检查，通过后才运行隔离实库/HTTP 检查。

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm tsx scripts/check-guide-evidence-harness-safety.ts` | **102/102，exit 0，live_docker=RUN** | 分段：F 11、A 14、B 22、C 26、D 10、E 7、L 12 |
| `pnpm tsx scripts/check-guide-evidence-db.ts` | **87/87，exit 0**（direct 67、http 20） | see §3.1 |
| `pnpm validate`（tsc + eslint + stylelint） | exit 0 | 两次均通过（含最终状态复跑） |
| `pnpm build`（Next build + tsup） | exit 0，`Build completed successfully!` | 见 §3.3 环境说明 |

### 3.1 实库/HTTP 运行记录（证据目录 `%TEMP%\g5-qa1-evidence\`）

正式证据运行（`db-check.out.txt`）：

- 运行标记 run_id：`1m8cmusnk8a2`；容器 `21ec04eba321…`（完整 ID 在脚本内，按 ID + 标签清理并复核）
- HTTP 服务：PID `75908`，创建身份 `2026-10-03T17:15:13.2216340Z`；
  监听者 PID `66932`（属于本轮进程树）；清理：`已按 PID 75908 + 创建身份核验终止本轮进程树`
- 数据库：一次性本地 Docker Postgres，写入前核验容器 ID/标签、回环端口映射、
  `current_database/current_user/inet_server_port` 与空库
- 业务请求目标证明：HTTP 读模型与直连隔离库完全一致；首笔写后直连复核 revision=1
- 模型调用监测：守门计数 0（`requests: []`）；生成物：删除本轮新建 3 个 dev 类型文件，恢复 0
- 运行后复查：无 `cga-*` 残留；既有 `zzsh-*`、`claread-*` 容器未被触碰

### 3.2 RED → GREEN

| 项 | RED（修复前） | GREEN（修复后） |
|---|---|---|
| F1/F2 实库装置接线 | 首轮安全检查：`FAIL F1 必须从 harness-safety 引入安全原语`、`FAIL F2 不再存在把 inspect 失败当不存在的 containerIdOf` | 102/102 全绿 |
| A1/A2/A3 就绪身份 | 旧实现无进程退出跟踪与监听者归属检查（旧 `runHttpTests` 只轮询 200；旧 `stopServer` 用 `server.killed` 判断），对应反例无法通过 | A1–A5 全绿 |
| B2/B3/B4/B6 进程清理 | 旧实现忽略 `taskkill` 退出码、以 `server.killed` 作为已关闭依据 | B1–B7 全绿 |
| C1/C2 三态清理 | 旧 `containerIdOf` 把 inspect 失败当不存在并返回 `ok=true` | C1–C10 全绿 |
| L1–L4 Docker 实测 | 无对应实测 | 全绿（异标签保留、本轮清理、失败路径清理、既有不受影响） |

说明：A/B/C 行为反例面向本轮新增的安全原语编写（旧脚本没有可注入的进程/Docker 边界），
运行级 RED 以 F1/F2 接线闸门 + 旧实现代码行为复核为准；这种行为差异在交付评审时可逐条对照。

### 3.3 环境说明

- `pnpm build` 在默认 PATH 下会命中 WSL `bash` 并失败（`set: pipefail: invalid option name`），
  与本次改动无关；将 Git Bash（`C:\Program Files\Git\bin`）置于 PATH 前部后 `pnpm build` exit 0。
- 进程身份/树终止按 Windows（PowerShell + `taskkill`）实现并实测；非 Windows 平台尽力用 `ps/kill`，
  无法核实时按失败记录（不做猜测），未在本轮验证。

## 4. 遗留资源、未知状态与 NOT_RUN

- 遗留资源：无。检查结束复查无 `cga-g5-*` 容器、无 `cga-g5-check` 标签残留；日志文件
  `%TEMP%\g5-db-check-server-<run_id>.log` 为普通临时日志，不属于服务资源。
- 未知状态：无容器/进程无法核实的遗留（两次运行清理报告均为 ok）。
- NOT_RUN：
  - 真实 StepFun/Coze 模型调用（预算耗尽；守门已阻断，计数为 0，未触达外部 provider）；
  - 非 Windows 平台的进程身份/端口归属路径；
  - G5-R1 业务修复（并行分支，未复制、未替代、未合并）；
  - 正式页面闭环、托管库迁移、线上部署。
- 结论分层：装置安全检查通过 ≠ R1 业务通过 ≠ 正式页面闭环 ≠ 线上可部署。

## 5. 复现

```powershell
# 装置安全检查（离线反例 + Docker 实测，需本机 Docker）
pnpm tsx scripts/check-guide-evidence-harness-safety.ts

# 通过后才运行隔离实库 + 真实 HTTP
pnpm tsx scripts/check-guide-evidence-db.ts

# 静态检查与构建
pnpm validate
pnpm build   # Windows 下需让 PATH 先命中 Git Bash，而非 WSL bash
```
