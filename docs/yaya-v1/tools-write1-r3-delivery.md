# TOOLS1-R3 交付

日期：2026-10-07。工作树：`codex/yaya-tools1`。
起点：`1ac32bf0f7509da460ed00c6ef5b99d4b2205c56`（TOOLS1-R2 候选；R2 实现 `049c39c`）。
独立评审：`yaya-tools1-r2-review-20261007/REVIEW.md`（NEEDS_R3，三项补充反例）。
实现提交：`c5084ba`（本文档随后单独提交）。

结论：独立评审三项全部关闭。反例先入仓库证明 RED（19/33，14 失败），修复后
GREEN 33/33；R2 76/76、原 112/134/85、DATA 116/58/67 与 validate、相关离线回归
全部保留；生产构建步骤通过。未整合、未 push、未部署。

## 1. RED→GREEN

反例检查：`scripts/yaya/check-tools-write-r3-db.ts`（新增，33 项，支持
`TOOLS1_R3_CASE=k|m|l|all`），全部走真实公开 route handler（进程内 NextRequest）、
真实 AUTH 会话/CSRF、真实 `createYayaToolkit().executeOperations`、一次性隔离 PG、
进程内 `invokeLlm` 替身（R3 用例期望零模型调用），`LLM_*` 指向自有回环守门并计数。

**RED**（候选 `1ac32bf` + 新反例，修复前）：
`{"ok":false,"passed":19,"failed":14,"fatal":null,"cleanup":"verified","real_model_requests":0,"model_calls":0}`。
失败与评审三问题一一对应：

- K：`__proto__`/`constructor`/`toString` 纯解析抛 `TypeError`、公开 handler `500/server_error`；
- M：两班 assign/remove payload 公开准备 `201` 通过；旧库多班提案只在版本步骤 `409` 拒绝
  （未到绑定边界）；
- L：非法（声明与 payload 不一致）提案在竞争方持 class 行锁时被阻塞 4006ms 后才拒绝
  （先取业务锁、后做绑定）。

留存：`yaya-tools1-r2-evidence/r3-red-report.json`。

**GREEN**（修复后同命令）：
`{"ok":true,"passed":33,"failed":0,"fatal":null,"cleanup":"verified","real_model_requests":0,"model_calls":0}`。
留存：`yaya-tools1-r2-evidence/r3-green-report.json`。

## 2. 三项修复

### P1-1 多班 payload 静默部分执行 → 单操作恰好一个班级

- `src/lib/yaya/tools/write/schemas.ts`：`manage_teacher` 持久化 payload
  `assign_class`/`remove_assignment` 的 `class_ids` 收紧为**恰好 1 个**；
  `set_status` 收紧为**恰好 0 个**（状态操作不携带班级）。多班表达沿用既有
  多 operation 计划（工具参数本就是单 `class_id`），不新增批处理框架。
- 该 schema 同时被公开准备入口（route `parseWritePayload`）和执行入口
  （`loadOperations` + 前置绑定边界）复用：公开准备多班 → 400 `invalid_request`；
  旧库/直接落库的多班提案在执行入口（取锁之前）同样拒绝，零回执、批准不消费。
- `registry.ts` 执行侧的 `class_ids[0]` 在收口后恒为唯一班级，无需另加分支。

### P1-2 语义绑定晚于业务锁 → 绑定进入共享前置核验、先绑定后取锁

- `src/lib/yaya/data/operations.ts`：`YayaVerifyApprovedInput` 新增可选
  `assertItemBinding(client, item)` 注入点；`verifyApprovedOperations` 在
  `lockExecutionTargets` **之前**对全部提案条目逐项执行形状+声明绑定校验。
  非法/未绑定提案在取得任何业务目标行锁之前即 `invalid_request`，
  不再触发 AUTH `FOR SHARE → FOR UPDATE` 升级路径的 40P01 条件。
- `execute.ts` 三处共享边界都注入同一 `assertProposalItemBinding`：
  预检核验、准备态保存复核、正式执行（经 `executeApprovedOperations` 透传；
  其参数以交叉类型扩宽，未改冻结 `storage-types.ts`）。
- DATA 直调 `executeApprovedOperations`/`verifyApprovedOperations` 不传该注入
  （省略即保持原语义）：DATA 回归的合成不一致条目仍按原理由
  （`content_changed`/`attribution_changed`/`approval_cancelled`/`session_changed`）拒绝。
- `binding.ts` 的 `assertProposalItemBinding` 现接受原始 `resource_ref`（未知形态）
  并在内部 `parseResourceRef`，同一函数可用于执行入口（已解析视图）与前置核验（原始行）。

### P2-3 未注册 kind 命中 Object 原型 → own-property 收口

- `schemas.ts` `parseWritePayload`：查表前 `Object.hasOwn(yayaWritePayloadSchemas, kind)`；
  `__proto__`/`constructor`/`toString` 与普通未知 kind 一律
  `YayaDataError('invalid_request')`（纯函数与公开 handler 均 400）。
  不声称此问题构成代码执行或原型污染。

## 3. 文件表

| 文件 | 变更 |
|---|---|
| `src/lib/yaya/tools/write/schemas.ts` | class_ids 恰好 0/1；`Object.hasOwn` 收口（+10/−5） |
| `src/lib/yaya/tools/write/binding.ts` | `assertProposalItemBinding` 接受原始 ref 并内部解析（+4/−2） |
| `src/lib/yaya/tools/write/execute.ts` | 三处核验边界注入 `assertItemBinding`（+4） |
| `src/lib/yaya/data/operations.ts` | 前置绑定注入点 + 取锁前校验 + 透传（+17/−1） |
| `scripts/yaya/check-tools-write-r3-db.ts` | 新增：R3 专属反例检查 33 项 |

未改：冻结 `storage-types.ts` / `types.ts` / `data/invariants.ts` / `data/proposals.ts`、
API0 / Agent / AUTH / MEDIA / READ1 / UI / APP1 / schema / package-lock、
`scripts/harness-safety.ts`（blob 复核 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`）。

## 4. 回归（本候选实跑）

| 检查 | 结果 |
|---|---|
| `check-tools-write-r3-db.ts`（新增） | **33/33**，cleanup verified，守门 0，模型 0 |
| `check-tools-write-r2-db.ts`（保留） | **76/76**，cleanup verified，守门 0 |
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

构建备注：与 R2 相同，`pnpm run build`（`bash ./scripts/build.sh`）在本 Windows 检出
因 `.sh` 为 CRLF / `bash` 指向 WSL 失败于 `set: pipefail: invalid option name`
（基线遗留，未改 build.sh）；已直接执行其两个构建步骤，均通过。

评审原 C（真实任教服务/FK 双连接竞争）与合法对照（A6 教师整理、A7 管理员建班）
由 R2 76/76 复跑保留；R3 的 M3 另补单班 assign/remove 正反对照。

## 5. 资源清理

- R3 red/green 两轮与全部复跑均使用一次性隔离 PG + 自有回环守门，正常与失败路径
  均 teardown/close，输出 `cleanup:"verified"`；两轮均 `fatal:null`。
- 未读 `.env`，未连托管库/真实桶；真实 provider 请求 0（守门计数），
  20 次模型额度未动；未改其他 agent 工作树。
- 未操作 main、未 push、未部署、未迁移。

## 6. NOT_RUN

- operations POST 的真实 Next HTTP server / 浏览器（R3 为进程内真实 route handler）。
- 真实 provider 模型质量、真实搜索/S3、托管库迁移、生产安全与部署。
- AGENT-APP1 的 run→conversation 装配核验。
- `check-integration-http` / `check-integration-media-db` / `check-business-access` /
  `check-tools-read*` 等未在本轮复跑（未触及读路径与集成 HTTP）。
- `scripts/check-guide-evidence-db.ts` 与 `scripts/check-classes.ts` 基线遗留
  （旧口令会话已退役）仍不可运行，与前轮记录一致。

## 7. 提交

- 实现 + 反例检查：`c5084ba`
- 本文档：随后提交（SHA 见提交记录）
