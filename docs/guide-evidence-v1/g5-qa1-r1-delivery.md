# G5-QA1-R1：快照读取未知状态与子树清理误报修复交付说明

- 分支：`codex/g5-qa1-r1-cleanup-fixes`
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-g5-qa1-r1`
- 基线：`29733732b2035cc0502dee43d62ccbfcccbe4839`（来源工作树 `...\child-growth-g5-qa1`，分支 `codex/g5-qa1-harness-safety`）
- `RTK.md`：不存在（已记录，未补造）。
- 状态：**装置安全检查通过（160/160）**，隔离实库/HTTP 检查通过（87/87）。仅修复装置身份/清理边界；
  **不代表** R1/R2 业务修复、正式页面闭环或线上可部署。
- 未修改业务源码、G0～G4 冻结内容、R1/R2 分支；未触碰 main、来源工作树与其他服务；未 push、未部署、未连接托管库、未调用真实模型。

## 1. 文件清单

修改：

| 文件 | 变更 |
|---|---|
| `scripts/harness-safety.ts` | 生成物快照/恢复三态化（已读取 / 明确不存在 / 无法核实）+ 可注入 `ArtifactFs` + 快照 fail-fast；进程树清理增加已知后代记录与逐一核实、终止命令失败不再被根消失吞掉；新增 `assertCleanupComplete` 清理闸门；`TrackedProcess` 类型拆分以支持内存替身 |
| `scripts/check-guide-evidence-harness-safety.ts` | 新增反例 B8–B13、D3–D12 与接线闸门 F3；保留原有全部断言 |
| `scripts/check-guide-evidence-db.ts` | 最小接线：最终清理闸门改用共享 `assertCleanupComplete` |

新增：`docs/guide-evidence-v1/g5-qa1-r1-delivery.md`（本文件）。

检查数量：原有 102 项全部保留；新增 58 项；合计 **160 项**（F 17、A 14、B 38、C 26、D 46、E 7、L 12）。
实库/HTTP 检查 87 项不变（direct 67、http 20），仅清理闸门改为共享函数。

## 2. 修复 A：读取失败不能当作不存在

旧实现 `readTextOrNull` 把 `readFileSync` 的任何失败都返回 `null`，快照把它当“本轮之前不存在”，
恢复阶段读到正常内容后即按“本轮新建”删除。已复现（临时目录 EISDIR 同类）：`removed: ["tsconfig.json"]`、
文件被删、`issues: []`。

现在：

1. `ArtifactFileState` 三态：`present` / `absent` / `unverifiable`；只有 `ENOENT`/`ENOTDIR`
   才算明确不存在，EACCES、EIO、EISDIR 等一律无法核实；
2. `snapshotGeneratedArtifacts` 对任一文件无法读取、任一类型目录无法枚举（`ArtifactFs.listTypeFiles`
   区分“目录不存在返回 null”与“枚举失败抛出”）即 **fail-fast** 抛出，主装置在启动守门/服务/数据库之前
   调用快照（F3 静态核实调用顺序），因此不会继续启动或执行恢复删除；
3. `restoreGeneratedArtifacts`：恢复前读取无法核实的文件 → 记录问题、不删除、不覆盖；
   目录枚举失败 → 记录问题并跳过该目录新增文件清理；新增文件无法读取 → 不删除；
   仍只处理快照中已核实的两类文件与两个类型目录，不整目录清空 `.next`；
4. 恢复阶段读取正常时按快照精确写回被修改/被删除的已有文件；运行前已有内容与改动保留；
5. 文件读取与目录枚举语义统一收敛到 `ArtifactFs`（Node 实现 + 内存替身同一判别式），未搭建文件系统框架。

反例覆盖（内存替身 D4–D12 + 真实临时目录 D3；失败反例中断言删除/覆盖调用为 0、原内容与存在性不变）：

| 反例 | 断言 |
|---|---|
| D3 快照读取失败（真实目录 EISDIR） | fail-fast 抛出，原路径不变 |
| D4 快照 tsconfig EACCES | fail-fast；writes/removes=0；原内容不变 |
| D5 快照 next-env I/O 错误 | fail-fast；removes=0；原内容不变 |
| D6 类型目录枚举失败 | fail-fast；不得当作空目录 |
| D7 恢复阶段读取失败 | 记录问题；writes/removes=0；文件保持改动后状态 |
| D8 真正缺失且本轮新建 | 明确不存在进入快照；本轮新建文件可清理 |
| D9 恢复阶段目录枚举失败 | 记录问题；跳过该目录删除 |
| D10 新增文件无法读取 | 记录问题；不删除 |
| D11 已有文件被修改 | 按快照精确恢复 |
| D12 已有类型文件被本轮删除 | 恢复；不得当新增文件误删 |

实现过程中 D1（真实临时目录全流程）暴露了一个连带缺陷：重写快照时曾漏收录已有类型文件，
导致恢复阶段把已有类型文件当“本轮新建”删除。已修复（快照收录目录枚举结果）并新增 D12 回归断言；
D1 转绿。这也说明“只看 helper 单测”不足，真实目录全流程断言必须保留。

## 3. 修复 B：根进程消失不等于树已清理

旧实现：`kill` 返回非零但根进程消失时走“等待根消失”分支并返回 `ok=true`，已知存活子进程被忽略。
已复现（内存替身）：`kill` 返回 1、根消失、子进程 9001 存活，`report.ok=true`。

现在 `stopTrackedChildTree` 在终止已核实的根进程前：

1. `captureDescendants` 记录当前已知后代（PID + 创建身份）；无法读取父子关系时标记子树不可核实；
2. 发出终止命令后逐一核实：终止命令非零 → 记录失败（不因根消失吞掉）；根未退出 → 失败；
   已记录后代仍存活 → 失败并列出 PID 与“拒绝按旧 PID 强杀、待人工核实”；
   后代创建身份与记录不符 → 按 PID 复用处理，不误报残留也不误杀新进程；身份无法核实 → 非成功；
3. 根在进入清理前已退出/身份无法核实/归属未知时，沿用 QA1 的拒绝强杀路径（`verifyExitedTree`）；
4. 失败报告经 `runCleanupSteps` 进入清理问题，最终由 `assertCleanupComplete` 抛错 → 非零退出；
   前一步清理失败不跳过后续自有资源（B13 行为断言 + F3 静态接线）；
5. 未新增后台守护或排队系统；不按端口或旧 PID 盲目强杀。

反例覆盖（B8–B13 全部内存替身，不终止真实进程）：

| 反例 | 断言 |
|---|---|
| B8 kill 失败、根消失、已知子进程存活 | 非成功；列出 PID 9001；保留命令失败原因；不追加盲目强杀 |
| B9 kill 成功但已知子进程仍存活 | 非成功；列出 PID |
| B10 根与已知子树全部消失 | 成功；报告含已核实后代数量 |
| B11 根已退出、后代身份无法核实 | 非成功；列出 PID；kill 不被调用 |
| B12 后代 PID 被复用 | 不误杀新进程，按已清理处理 |
| B13 主装置消费链 | 失败报告 → 清理问题 → `assertCleanupComplete` 抛出；后续步骤仍执行 |

## 4. RED → GREEN 证据

| 项 | RED（基线 2973373） | GREEN（本提交） |
|---|---|---|
| A 快照读取失败 | `red-a.out.txt`：`recorded_snapshot_entry: null`、`removed: ["tsconfig.json"]`、文件被删、`issues: []` | `green-a.out.txt`：`无法建立生成物快照（fail-fast…）：…tsconfig.json: EISDIR…`，exit 1，未发生删除 |
| B 根消失子树存活 | `red-b.out.txt`：`report.ok: true`，`known_child_alive: true` | `green-b.out.txt`：`ok: false`，detail 含“终止命令返回失败”+“已记录的后代仍存活…PID 9001” |
| 反例套件 | `staged-red.out.txt`：B8/B9/B10/D3 失败（107/111） | `harness-safety.out.txt`：**160/160，exit 0** |
| 主装置接线 | 基线无子树核实、恢复问题不进入快照闸门 | F3 静态断言（快照先于服务/数据库、恢复问题转非成功、清理闸门）+ B13 行为断言；实库运行输出含“已核实 1 个已记录后代退出” |

模拟与实测分别的证据：
- **内存替身/临时目录**：B8–B13、D3–D12（不改动真实配置、不终止真实进程）；
- **真实本地资源**：A1–A5 回环占位/真实子进程、D1/D2 真实临时目录、L1–L4 真实 Docker、E1 真实回环守门；
- **真实实库/HTTP**：`check-guide-evidence-db.ts`（真实 PostgreSQL 容器 + 真实 Next dev + 受控双连接）。

## 5. 验收执行与结果

顺序：专属安全检查通过后才复跑隔离实库/HTTP 检查。

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm tsx scripts/check-guide-evidence-harness-safety.ts` | **160/160，exit 0，live_docker=RUN** | F 17、A 14、B 38、C 26、D 46、E 7、L 12 |
| `pnpm tsx scripts/check-guide-evidence-db.ts` | **87/87，exit 0**（direct 67、http 20） | 见下 |
| `pnpm validate` | exit 0 | tsc + eslint + stylelint |
| `pnpm build` | exit 0，`Build completed successfully!` | Windows 需 PATH 先命中 Git Bash（WSL bash 不适用） |

实库/HTTP 运行记录（`db-check.out.txt`）：

- run_id `wrwmut3motv`；容器 `5bd88653291a…`；Docker 三态核实 + 标签所有权 + 删除后复核
- HTTP 服务 PID `83404`，创建身份 `2026-10-04T00:45:01.7293080Z`；监听者 PID `83116`（本轮树）
- 清理报告：`已按 PID 83404 + 创建身份核验终止本轮进程树；已核实 1 个已记录后代退出`（子树核实生效）
- 生成物：恢复 0、删除本轮新建 dev 类型文件 3 个、issues 0
- 模型守门计数 0（`requests: []`，真实监测非常量）；`real_model_requests: 0`
- 运行后复查：无 `cga-*` 残留；既有 `zzsh-*` 容器未被触碰

## 6. 遗留、限制与 NOT_RUN

- 遗留资源：无。Docker 容器、进程树、临时目录均在各自路径清理；`next-env.d.ts` 的 `pnpm build`
  副作用已还原，提交只含负责文件。
- 已知限制（按范围不做后台追踪）：子树快照取自终止前一刻，终止前刚派生且尚未进入父子映射的极端后代
  不在核实范围；非 Windows 平台进程身份/端口归属路径未验证。
- NOT_RUN：真实 StepFun/Coze 调用（守门阻断，计数 0）；非 Windows 平台；G5-R1/R2 业务修复
  （未合并、未复制、未替代）；正式页面闭环、托管库迁移、线上部署。
- 结论分层：装置安全修复通过 ≠ 业务 R2 通过 ≠ 页面闭环 ≠ 可部署。

## 7. 复现

```powershell
pnpm tsx scripts/check-guide-evidence-harness-safety.ts
pnpm tsx scripts/check-guide-evidence-db.ts
pnpm validate
pnpm build   # Windows 下需让 PATH 先命中 Git Bash
```
