# G5-COMBO：获批业务修复 + QA 安全装置组合候选与实库验收交付说明

- 分支：`codex/g5-combination-validation`
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-g5-combo`
- 共同来源：`6a45636b75f0d853f485b6438754d8911036e22e`
- 获批业务修复：`faea10d9e321a50ae364aa3daf7fc2948badf122`（`codex/g5-r2-basis-fixes`，含 R1 `a078c9d`/`118690a`）
- 获批安全装置：`711c9cdda7a58eff4d101dd2161cf3980a7524d8`（`codex/g5-qa1-r1-cleanup-fixes`，含 QA1 `2973373`）
- 合并方式：从共同来源以 `--no-ff` 依次合入两个获批来源，保留全部历史；未 squash、未整目录覆盖、未加入 AUTH/HOME 改动
  - `de5f8ab` merge：获批 G5-R1/R2 业务修复
  - `1806f01` merge：获批 G5-QA1-R1 安全装置
- 本记录提交：包含本文件的 `test:` 提交（候选 HEAD）
- 结论：**G5 组合后端候选通过（装置安全 + 已列实库反例 + 回归），等待主评审**。
  不代表 G6、认证接入或可部署。
- `RTK.md`：不存在（已记录，未补造）。

## 1. 来源核实

- 两个来源 SHA 均存在且都以共同来源为祖先（`merge-base --is-ancestor` 均成立）。
- 来源工作树 `child-growth-g5-r2`（HEAD `faea10d`）与 `child-growth-g5-qa1-r1`（HEAD `711c9cd`）合并前均为干净状态。
- 未修改 main、既有整合工作树与任何来源分支；未 push、未部署、未合并 main。

## 2. 精确修改清单（组合候选新增）

| 文件 | 变更 |
|---|---|
| `scripts/check-guide-evidence-db.ts` | 扩展组合实库/HTTP 验收：新增 fixture 与 A–G 反例、真实 HTTP 错误映射与引用定位、测试进程故障注入（C 详情补查失败） |
| `docs/guide-evidence-v1/g5-combo-delivery.md` | 本记录 |

业务源码、G0～G4 冻结内容、QA 安全 helper（`scripts/harness-safety.ts`、`scripts/check-guide-evidence-harness-safety.ts`）均未修改：
它们来自两个获批来源的合并。无新增依赖。

既有 87 项实库/HTTP 检查全部保留（其中 D4 reject 的前提按获批 R1 调整为“宿主先归档”，断言内容与数量不变）。

## 3. 组合实库反例（A–G）

全部在真实 PostgreSQL（一次性本地容器）+ 真实 Next dev HTTP 上执行；模型路径全部替身，真实请求守门计数 0。

### A 宿主守门（30 项）

- `draft` / `needs_input` / `ai_organized` 三种未归档宿主：独立 `confirm` / `reject` / `withdraw` 与幂等重复均 409 `state_conflict`，容器 revision 不变（3×7）。
- 未归档宿主上“内容完全一致的重复确认”同样 409，不得绕过宿主守门。
- 已归档宿主合法操作成功（revision=1），完全重复幂等（revision 不增长、不新增关联）。
- 未归档宿主 `suggest` 保存路径仍可写入待核对建议且不产生正式状态。

### B 版本与原子性（16 项）

- 旧目录关联按 `link_id` 确认 → 409 `catalog_version_mismatch`，不写入。
- 来源 `confirmed_at` 漂移 → 沿用旧快照 409 `basis_expired`；来源 `observed_at` 漂移 → 409 `basis_expired`。
- 旧空版本快照独立确认 → 409；非法版本（`not-a-date`）→ 409。
- 批量两条关联其中一条过期 → 409 且整批零写入（两条均保持 `ai_suggested`，revision 不变）。
- 同事务首次归档合法路径成功：自引用空版本写入新 `confirmed_at` 作为依据版本。

### C 提交与响应（10 项）

- 归档与关联提交后，详情补查失败：**仅在测试进程**对池查询注入异常（无产品开关），路由返回 200 +
  `guideEvidence.status="applied"` + `detail_unavailable=true` + revision 由已提交容器解析，且不含 `links`。
- 直连复核：观察已 `confirmed`、`raw_text` 不变、容器 revision=1 且仅一条关联（无重复写入）。
- 提交前错误回滚沿用既有 D2/B 批量反例（无效依据/过期 → 整批不写入）。
- 注入实现只存在于 `scripts/check-guide-evidence-db.ts` 的测试进程；真实 HTTP 响应语义同时由
  `check-guide-evidence-routes.ts`（模块替身，26/26）覆盖——两者分开报告，不把 mock 当真实 HTTP。

### D 读取与审计（15 项）

- 唯一容器缺 `item_id` 的 confirmed 关联 → 可靠性不是 reliable 且不产生虚假状态。
- 同容器“有效关联 + 未知状态” → `partial`，有效关联仍计入 `confirmed_observed`。
- 班级一人不可读、其余可读 → `partial`，三类之和=分母，占比 null；全部不可读 → `unavailable`，仍保留分母。
- 四类支持条件（`clue_only` 表现、`requires_independence` + 成人帮助、成人帮助无说明、非法纪要日期）
  均不计为表现。

### E 引用定位（15 项）

- 同句 `highlight_quote ↔ highlights` 切换：link 与容器 revision 各 +1，新位置写入结果；反向切换同样生效。
- 完全重复提交幂等，link/容器 revision 均不增长。
- 同一来源多字段并存：按完整定位选择，不误用第一条旧依据。
- 声明位置不含片段 → 400 `invalid_request` 零写入；来源版本漂移 + 切换字段 → 409 `basis_expired` 零写入。
- 批量一条漂移 → 整批零写入。

### F 来源绑定（14 项）

- 真实库观察 + 模型替身：同句跨来源按模型声明的 `quote_source_id` 绑定，来源日期/版本由服务端生成。
- 缺来源 id / 错误 id / 跨幼儿 id / 位置不符 / 虚构引用 / AI 理由打分 → 全部拒绝。
- 保存前来源快照核对：生成后来源版本漂移 → 409 冲突，迟到建议零写入（宿主 revision 0、无容器）。

### G 恢复路线（12 项）

- 已归档宿主的旧空版本建议：独立确认 409 `basis_expired`（revision 不变、宿主保持归档）。
- 拒绝旧建议 revision=2、审计保留；手动关联当前条目 revision=3、新依据版本非空（=宿主 `confirmed_at`）。
- 完全重复幂等（revision 3、不新增关联）；全程 `raw_text` 不变。

## 4. 真实 HTTP 新增（11 项）

真实 `next dev` + 教师会话下：未归档宿主确认 → 409 `state_conflict`；旧目录 → 409 `catalog_version_mismatch`；
旧空版本 → 409 `basis_expired`；引用字段切换 → 200 revision=2、新位置生效；完全重复 → 200 幂等 revision=2。

## 5. 验收结果

| 检查 | 结果 |
|---|---|
| `check-guide-evidence-harness-safety.ts`（装置安全） | **160/160，exit 0**（F17 A14 B38 C26 D46 E7 L12；live_docker=RUN） |
| `check-guide-evidence-db.ts`（隔离实库 + 真实 HTTP） | **209/209，exit 0**（direct 178、http 31；新增 111 + 11） |
| `check-guide-evidence-runtime.ts`（离线运行时） | 140/140 |
| `check-guide-evidence-routes.ts`（模块替身路由） | 26/26（含 C 详情补查 6 条） |
| `check-guide-evidence-r1.ts`（R1/R2 离线反例） | 91/91 |
| `check-guide-contract.ts`（G0 契约） | 19/19 |
| `check-guide-catalog.ts`（G1 目录） | 11/11（317 条目等） |
| `check-history-semester.ts`（G2 安全实库） | 33/33；容器 `c28a3de1fa01`（run `1ouomutaydl9`）按 ID+标签清理；decoy 保留 |
| `check-child-evidence-book-fixtures.ts`（G3 fixture） | 63/63 |
| `check-class-evidence-overview.ts`（G4 fixture） | 42/42 |
| 离线回归 agent-flow / organize-retry / growth-profile / activity-support / teacher-clarify / save-consistency / class-reports-pages | 30/30、9/9、13/13、19/19、13/13、24/24、11/11 |
| homepage-map | 通过 |
| `pnpm validate`（tsc + eslint + stylelint） | exit 0 |
| `pnpm build`（Next build + tsup） | exit 0（Windows 需 PATH 先命中 Git Bash） |

实库运行记录（`db-check.out.txt`）：

- run_id `1p3kmutax7wb`；容器 `85ec1657bf55…`（Docker 三态核实 + 标签所有权 + 删除后复核）
- HTTP 服务 PID `72396`，创建身份 `2026-10-04T04:09:10.1049710Z`；监听者 PID `83000` 属于本轮进程树；
  清理报告含“已核实 1 个已记录后代退出”
- 生成物：删除本轮新建 dev 类型文件 3 个、恢复 0、issues 0
- 模型守门：`requests: []`，`real_model_requests: 0`（来自守门计数，非常量）
- 运行后复查：无 `cga-*` 残留；既有 `zzsh-*` 容器未被触碰

## 6. 证据分层

- **实库 direct**：178 项（含 A–G 与既有 direct/受控双连接交错；并发为真实行锁竞争）。
- **真实 HTTP**：31 项（服务身份核验通过后才发业务写请求）。
- **模块替身**：routes 26、runtime 140、r1 91、契约/目录/G3/G4/回归（不当作真实 HTTP）。
- **测试进程故障注入**：C 详情补查失败（`Pool.prototype.query` 限定窗口拦截）；不新增产品开关。
- **模型替身**：F 生成路径注入 invoke；真实 provider 调用 0。

## 7. NOT_RUN 与剩余限制

- `scripts/check-classes.ts`：**NOT_RUN**（危险装置，TEST-SAFE1 未获批）。
- 真实 StepFun/Coze provider 质量、托管库读写、迁移执行、部署与环境变量：**NOT_RUN**。
- 浏览器/UI 验收、G6 正式页面装配、认证接入：**NOT_RUN**。
- 剩余限制：C 的 `detail_unavailable` 在真实 HTTP 服务器上无法注入（注入只在测试进程），
  真实 HTTP 侧由既有成功路径与错误映射覆盖；跨进程故障注入需产品故障开关，按任务约束不引入。
- 结论分层：组合后端候选通过 ≠ 真实模型质量 ≠ 页面闭环 ≠ 线上可部署。
