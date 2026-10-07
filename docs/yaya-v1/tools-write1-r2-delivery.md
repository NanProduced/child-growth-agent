# TOOLS1-R2 交付

日期：2026-10-06。工作树：`codex/yaya-tools1`。
起点：`499fc923659e59d2d5b9dc503648c01d50dca7d0`（TOOLS1-R1 候选，主评审 REVIEW.md 判定需 R2）。
实现提交：`049c39c`（本文档随后单独提交）。

结论：R1 主评审三个 P1 全部关闭。三反例先入仓库证明 RED（51/76，25 失败），
共享根因修复后 GREEN 76/76；原 112/134/85 与 DATA 116/58/67 全部保留，
`pnpm validate` 与生产构建步骤通过。未整合、未 push、未部署。

## 1. RED→GREEN

反例检查：`scripts/yaya/check-tools-write-r2-db.ts`（新增，76 项，支持
`TOOLS1_R2_CASE=a|b|c|all`），全部走真实公开 route handler（进程内 NextRequest）、
真实 AUTH 会话/CSRF、真实 `createYayaToolkit().executeOperations`、一次性隔离 PG、
进程内 `invokeLlm` 替身，`LLM_*` 指向自有回环守门并计数。

**RED**（候选 `499fc92` + 新反例，修复前）：
`{"ok":false,"passed":51,"failed":25,"fatal":null,"cleanup":"verified","real_model_requests":2,"model_calls":5}`。
25 项失败分布：A1×5、A2×1、A3×1、A4b×4、A5×4、A8×3、B1×5、C×1、守门×1。
留存：`yaya-tools1-r2-evidence/red-report.json`（含失败全名与守门调用栈）。

- A 根因实证：A3 公开链路执行期未在模型前拦截，真实模块 `invokeLlm → invokeStructured
  → judgeFollowUp → computeObservationAgent` 两次打到回环守门（guard stacks 见 red-report）；
  A1 越权建班 200/saved 且落 1 行管理员班级。
- B 根因实证：null 版本批准 + 并发改名后执行仍 200/saved，并发改名被覆盖。
- C 根因实证：既有 `assignTeacherClassWithClient` 持 teacher 行锁被工具阻塞后
  INSERT 争 classes 触发 `40P01`，旧服务失败。

**GREEN**（修复后同命令）：
`{"ok":true,"passed":76,"failed":0,"fatal":null,"cleanup":"verified","real_model_requests":0,"model_calls":2}`。
`model_calls=2` 全部来自 A6 合法整理对照的注入替身（真实出口 0）。
留存：`yaya-tools1-r2-evidence/green-report.json`。

## 2. 三个 P1 的修复

### P1-A：payload ↔ 批准元数据绑定

- `src/lib/yaya/tools/write/schemas.ts`：新增与 `YayaDomainPayload` 同构的 12 个
  payload Zod schema（strict、形状级：只查结构与格式，不重复工具参数的业务长度规则，
  公开准备的合成夹具与服务端派生 payload 原样通过）与 `parseWritePayload`：
  表外 kind（含 `manage_teacher` 的 `create`/`reset_password` 密码类操作）与形状不合法
  一律 `invalid_request`。
- `src/lib/yaya/tools/write/binding.ts`（新增）：`deriveItemBinding` 从 kind+operation
  推导真实 `action`/`resource`/`resource_ref`（attach 经 `SELECT child_id FROM observations`
  推导），`assertProposalItemBinding` 逐字段比较（不用 JSON.stringify，键序来自 jsonb 不稳定）。
- `src/lib/yaya/tools/write/execute.ts`：共享 `loadOperations`（route 执行与直接 executor
  同一入口）在 registry 解析后、模型与回执之前调用绑定；不一致 → `invalid_request`
  （400）→ 模型 0、业务 0、回执 0、批准不消费。
- `src/app/api/yaya/proposals/route.ts`（公开入口改法，owner 范围内，REVIEW 要求先列明）：
  `parsePrepareItems` 在既有形状检查后加一次 `parseWritePayload(record.payload)`，
  **只做形状校验，不做声明绑定**。理由：A8 要求公开准备拒绝未注册 kind/形状不合法/
  密码类操作；而 DATA 回归以“声明与 payload 不一致”的合成条目走公开准备期待 201，
  绑定必须留在执行期共享入口。未改任何冻结 DTO、reason 词表或协议，错误体复用冻结的
  `invalid_request → 400` 映射。

派生表（binding 与 registry prepare 同源）：

| payload kind | action | resource | 目标比较 |
|---|---|---|---|
| create_observation | observation.write | child | child_id |
| organize / follow_up | observation.organize | observation | observation_id |
| confirm_observation | observation.confirm | observation | observation_id |
| guide_decision | guide.decide | observation | observation_id |
| create_child | child.create_profile | class | target_class_id ↔ ref.class_id |
| transfer_child | child.transfer | transfer | child_id + target_class_id |
| manage_class create | class.manage | class | class_id 必须 null |
| manage_class update | class.manage | class | class_id |
| manage_teacher set_status | teacher.manage | school | ref 无 id |
| manage_teacher assign/remove | teacher.assign | class | class_ids[0] ↔ ref.class_id |
| refresh_growth/activity | growth_profile.write / activity_support.write | child | child_id |
| attach_observation_images | observation.write | child | 观察行 child_id ↔ ref.child_id |

### P1-B：null 版本不再关闭版本核验

`src/lib/yaya/data/operations.ts`（原 :405）：改为只要有 `resolveBusinessRevision`
就读当前版本——批准快照为 null 而当前事实存在版本 → `business_version_changed`
（复用冻结 reason，不新增码）；当前也无版本（`manage_class` create 的 resolver 返回
null、attach 无 resolver）才继续。无 resolver 时非空版本仍保守拒绝（原语义不变）。
DATA 直调 `executeApprovedOperations` 不传 resolver，语义不变。
非空一致（B2）、非空过期（B4）、附件 CAS（B5）对照全部保持。

### P1-C：全局锁序消除死锁

`src/lib/yaya/data/operations.ts` `lockExecutionTargets` 稳定序改为
**children(0) → app_accounts(1) → classes(2) → observations(3)**，且 `manage_teacher`
一律按 `payload.teacher_account_id` 锁 app_accounts（不再依赖 ref.kind=school——
`assign_class` 的 ref 是 class，旧代码 verify 阶段根本没锁 teacher）。

锁序图（本轮实证无环）：

| 调用方 | 取锁顺序 |
|---|---|
| 工具 verify（本函数） | children → app_accounts → classes → observations |
| `assignTeacherClassWithClient` | app_accounts(FOR UPDATE) → INSERT 任教关系(classes KEY SHARE) |
| 转班/落库 | children(FOR UPDATE) → classes |
| 登录 | app_accounts（单表） |
| 确认/附件 | observations / 附件行（单表组，不回头取 children/classes FOR UPDATE） |

修复后 C 受控交错：工具按序先等 app_accounts（`waitForLock` 实证等待），既有服务
完成无 40P01，工具随后取得锁执行 saved。无全局锁、无自动重试，版本冲突/回滚/幂等
语义未动；未改任何既有服务。

## 3. 文件表

| 文件 | 变更 |
|---|---|
| `src/lib/yaya/tools/write/schemas.ts` | +12 payload schema、`parseWritePayload`（+159） |
| `src/lib/yaya/tools/write/binding.ts` | 新增：`deriveItemBinding` / `sameResourceRef` / `assertProposalItemBinding` |
| `src/lib/yaya/tools/write/execute.ts` | `loadOperations` 接绑定（+4） |
| `src/lib/yaya/data/operations.ts` | B 版本分支 + C 锁序与注释（+18/−13） |
| `src/app/api/yaya/proposals/route.ts` | `parsePrepareItems` 加 payload 形状校验（+8/−3） |
| `scripts/yaya/check-tools-write-r2-db.ts` | 新增：R2 专属反例检查 76 项 |

未改：冻结 `storage-types.ts` / `types.ts` / `data/invariants.ts` / `data/proposals.ts`、
API0 / Agent / AUTH / MEDIA / READ1 / UI / APP1 / schema / package-lock、
`scripts/harness-safety.ts`（blob 复核 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`）。

## 4. 回归（本候选实跑）

| 检查 | 结果 |
|---|---|
| `check-tools-write-r2-db.ts`（新增） | **76/76**，cleanup verified，守门 0 |
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

构建备注：`pnpm run build`（`bash ./scripts/build.sh`）在本 Windows 检出中因
`.sh` 文件为 CRLF、`bash` 指向 WSL 而失败于 `set: pipefail: invalid option name`
（基线遗留的本地环境问题，与本轮改动无关，未改 build.sh）；已直接执行该脚本的两个
构建步骤（next build、tsup）均通过。

## 5. 资源清理

- R2/134/85/DATA 各检查均使用一次性隔离 PG + 自有回环守门，正常与失败路径均
  teardown/close，全部输出 `cleanup:"verified"`；red/green 两轮均 `fatal:null`。
- 未读 `.env`，未连托管库/真实桶；真实 provider 请求 R2 两轮合计 0（守门计数），
  20 次模型额度未动。
- 未操作 main、未 push、未部署、未迁移；`.coze` 未写入任何凭证。

## 6. NOT_RUN

- operations POST 的真实 Next HTTP server / 浏览器（本轮为进程内真实 route handler；
  既有路由的 Next HTTP 由 `check-integration-http` 覆盖，本轮未复跑）。
- 真实 provider 模型质量、真实搜索/S3、托管库迁移、生产安全与部署。
- AGENT-APP1 的 run→conversation 装配核验。
- `check-integration-http` / `check-integration-media-db` / `check-business-access` /
  `check-tools-read*` 等未在本轮复跑（未触及读路径与集成 HTTP；如需可复跑）。
- `scripts/check-guide-evidence-db.ts` 与 `scripts/check-classes.ts` 基线遗留
  （旧口令会话已退役）仍不可运行，与前轮记录一致。

## 7. 提交

- 实现 + 反例检查：`049c39c`
- 本文档：随后提交（SHA 见提交记录）
