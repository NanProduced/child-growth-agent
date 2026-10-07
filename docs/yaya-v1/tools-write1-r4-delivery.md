# TOOLS1-R4 交付

日期：2026-10-07。工作树：`codex/yaya-tools1`。
起点：`457d3cfac35a8cbef6e93d596ea835df4fd221c4`（TOOLS1-R3 候选；R3 实现 `c5084ba`）。
独立评审：`yaya-tools1-r2-review-20261007/REVIEW-R3.md`（剩余 P1：非教师目标先取锁再拒绝）。
实现提交：`df15359`（本文档随后单独提交）。

结论：剩余 P1 关闭。反例先入仓库证明 RED（33/37，4 失败），修复后 GREEN 37/37；
R3 33/33、R2 76/76、原 112/134/85、DATA 116/58/67 与 validate、相关离线回归、生产构建
全部保留。未整合、未 push、未部署。

## 1. RED→GREEN

反例检查：`scripts/yaya/check-tools-write-r4-db.ts`（新增，37 项，支持
`TOOLS1_R4_CASE=g|all`），全部走真实公开 route handler（进程内 NextRequest）、
真实 AUTH 会话/CSRF、真实 `createYayaToolkit().executeOperations`、一次性隔离 PG、
进程内 `invokeLlm` 替身（R4 用例期望零模型调用），`LLM_*` 指向自有回环守门并计数。

**RED**（候选 `457d3cf` + 新反例，修复前）：
`{"ok":false,"passed":33,"failed":4,"fatal":null,"cleanup":"verified","real_model_requests":0,"model_calls":0}`。

- G1c/G1d：其他管理员目标的 assign/remove 通过绑定、取得业务目标锁（app_accounts +
  classes），之后才在版本步骤以 `409 approval_invalid` 被拒——目标资格未先核验；
- G3a：管理员目标请求在竞争方持有目标账号行锁时被阻塞整个 4s 预算后才可能拒绝。

留存：`yaya-tools1-r2-evidence/r4-red-report.json`。

**GREEN**（修复后同命令）：
`{"ok":true,"passed":37,"failed":0,"fatal":null,"cleanup":"verified","real_model_requests":0,"model_calls":0}`。
留存：`yaya-tools1-r2-evidence/r4-green-report.json`。

## 2. 修复：目标账号资格先于业务锁

- `src/lib/accounts/repository.ts`：新增 `assertTeacherTargetEligibleWithClient`
  （不取锁的普通 SELECT；与 `lockTeacherAccount` 同一判定口径：不存在 →
  `AccountNotFoundError('not_found')`、状态非法 → `asStatus`、非教师角色 →
  `ForbiddenTargetError('forbidden_role')`）。业务原语 `lockTeacherAccount` 的
  锁后复核**未改**——锁后角色/状态可能被并发修改，两处缺一不可。
  （该文件属本任务 owner 范围“必要账号同 client 原语”。）
- `src/lib/yaya/tools/write/binding.ts`：共享绑定边界 `assertProposalItemBinding`
  对 `manage_teacher`（set_status / assign_class / remove_assignment 全操作）在
  声明与目标一致性校验之后调用该资格预检。绑定边界已由 `verifyApprovedOperations`
  在 `lockExecutionTargets` 之前逐项执行，故拒绝先于任何业务目标锁；
  公开准备、旧库提案、executor 三处边界共用同一函数，未在公开路由加 if。
- 不改：AUTH 账户/会话/密码/角色语义、`lockTeacherAccount`、业务原语、锁序；
  不引入全局锁/死锁重试/超时改错码。

## 3. 反例覆盖（`TOOLS1_R4_CASE=g`）

| 用例 | 覆盖 |
|---|---|
| G1a | 管理员目标（自己）：准备/批准 201 → 执行 `forbidden_role`，账号保持 active，零回执，批准不消费 |
| G1b | 不存在目标：`not_found`，零回执，批准不消费 |
| G1c/G1d | 其他管理员目标（新增第二管理员）assign/remove：`forbidden_role`，零回执，批准不消费 |
| G2 | 旧库执行路径（绕过公开准备直接落库 + route handler）：403 `forbidden_role`，零业务写/回执，批准不消费 |
| G3a | 持锁竞争者：资格拒绝不排队等待目标行锁（elapsed ≪ 4s 预算），无回执 |
| G3b | 双请求并发（管理员目标自己）：两个明确 `forbidden_role`、无 40P01、零业务写/回执 |
| G4 | 正常对照：教师停用→启用仍 saved 且库内状态一致 |

## 4. 文件表

| 文件 | 变更 |
|---|---|
| `src/lib/accounts/repository.ts` | 新增 `assertTeacherTargetEligibleWithClient`（+21） |
| `src/lib/yaya/tools/write/binding.ts` | manage_teacher 目标资格预检接入绑定边界（+6） |
| `scripts/yaya/check-tools-write-r4-db.ts` | 新增：R4 专属反例检查 37 项 |

未改：冻结 `storage-types.ts` / `types.ts` / `data/invariants.ts` / `data/proposals.ts`、
`lockTeacherAccount`、API0 / Agent / AUTH 角色与会话语义 / MEDIA / READ1 / UI / APP1 /
schema / package-lock、`scripts/harness-safety.ts`（blob 复核
`6702f2ddf3b436e79f8c92ae8756c33f611a8503`）。

## 5. 回归（本候选实跑）

| 检查 | 结果 |
|---|---|
| `check-tools-write-r4-db.ts`（新增） | **37/37**，cleanup verified，守门 0，模型 0 |
| `check-tools-write-r3-db.ts`（保留） | **33/33**，cleanup verified |
| `check-tools-write-r2-db.ts`（保留） | **76/76**，cleanup verified |
| `check-tools-write.ts`（原 112） | **112/112** |
| `check-tools-write-db.ts`（原 134） | **134/134**，cleanup verified |
| `check-tools-write-r1-db.ts`（原 85） | **85/85**，cleanup verified |
| `pnpm validate`（tsc/eslint/stylelint） | 通过 |
| `check-data-db` / `check-data-r1-db` / `check-data-r1-media-db` | 116/116 / 58/58 / 67/67 |
| `check-auth-contract` / `check-guide-contract` | 36/36 / 19/19 |
| `check-contract` / `check-preflight` / `check-api-contract` | 68/68 / 15/15 / 57/57 |
| `check-data` / `check-data-r1` | 27/27 / 10/10 |
| `check-save-consistency` / `check-guide-write-flow` | 24/24 / 123/123 |
| 生产构建 | `next build` ✓ + `tsup src/server.ts …` ✓ |

构建备注与前两轮一致：`pnpm run build`（`bash ./scripts/build.sh`）在本 Windows 检出因
CRLF/WSL 失败于 `set: pipefail: invalid option name`（基线遗留，未改 build.sh）；
已直接执行其两个构建步骤，均通过。

## 6. 资源清理

- R4 red/green 两轮与全部复跑均使用一次性隔离 PG + 自有回环守门，正常与失败路径
  均 teardown/close，输出 `cleanup:"verified"`；两轮均 `fatal:null`。
- 第二管理员与所有会话/提案/批准都在一次性隔离库内，随 teardown 精确清理；
  未按端口/名称前缀误杀，未连托管库/真实桶。
- 未读 `.env`，真实 provider 请求 0（守门计数），20 次模型额度未动；
  未操作 main、未 push、未部署、未迁移。

## 7. NOT_RUN

- operations POST 的真实 Next HTTP server / 浏览器（R4 为进程内真实 route handler）。
- 真实 provider 模型质量、真实搜索/S3、托管库迁移、生产安全与部署。
- AGENT-APP1 的 run→conversation 装配核验。
- `check-integration-http` / `check-integration-media-db` / `check-business-access` /
  `check-tools-read*` 等未在本轮复跑（未触及读路径与集成 HTTP）。
- `scripts/check-guide-evidence-db.ts` 与 `scripts/check-classes.ts` 基线遗留
  （旧口令会话已退役）仍不可运行，与前轮记录一致。

## 8. 提交

- 实现 + 反例检查：`df15359`
- 本文档：随后提交（SHA 见提交记录）
