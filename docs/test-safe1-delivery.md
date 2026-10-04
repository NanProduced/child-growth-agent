# TEST-SAFE1 交付报告（测试装置返修候选，等待主评审）

- 基线：`cfa7b0343fc942ef80dc908ddfb47a96cb5a44dd`（AUTH0-R2）
- 分支：`codex/test-safe-classes`（独立工作树 `child-growth-test-safe1`，未整合其他分支）
- 本轮提交 SHA：见交付消息 / `git log`（本文件不写入自身 SHA，避免自引用）
- 精确修改清单：
  - `scripts/check-classes.ts`（仅测试装置：唯一资源命名、目标绑定、阶段化失败报告、清理闸门、故障注入；15 项业务断言原文保留）
  - `scripts/check-classes-harness-safety.ts`（新增，本任务专属安全反例 11 项）
  - `scripts/harness-safety.ts`（新增，精确引入，blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`，本轮未修改）
  - `docs/test-safe1-delivery.md`（本文件，新增）
  - 未修改：`src/**`（业务代码、认证实现、schema、迁移、API、页面）、`scripts/initialize-demo-db.sql`、`scripts/upgrade-classes.sql`、其他 `scripts/check-*` 测试装置、`PRODUCT.md`、依赖与锁文件、G0～G5/HOME/AUTH 各分支

## 旧装置的三个资源风险的 RED → GREEN

### A. 固定容器名互踩

- RED（静态）：旧装置以固定名 `cga-classes-check` 调用 `docker rm -f`，任何同名容器（含他人/上一轮残留）都会被删除；启动、核验与清理全靠约定名。
- 修正：每轮 `RUN_ID = pid-time36-randomBytes4` 派生容器名 `cga-classes-check-${RUN_ID}`、库名 `cga_check_${RUN_ID}`、所有权标签 `child-growth-agent.check-classes.run`；清理只按**本轮容器 ID + 本轮标签**发出，旧固定名一律拒绝删除。
- GREEN：`legacy-fixed-name-container-preserved`（按旧名清理被拒、未发出 `rm`）、`foreign-containers-untouched`（他人容器不受影响）、`legacy-container-released-by-id-and-label`（本轮创建的旧名容器按 ID+标签回收）。

### B. 外部连接串与平台库回退

- RED（静态）：旧装置接受 `CLASSES_TEST_DATABASE_URL` 指向现成库，且不切断 `pg-client.ts` 的 `PGDATABASE_URL` 回退，可能写入非本轮资源。
- 修正：删除外部 URL 模式；启动后 `process.env.DATABASE_URL = database.url; delete process.env.PGDATABASE_URL`，并用 `SELECT current_database()` 断言连接目标即本轮库。
- GREEN：`source-external-url-pattern-removed`、`real-init-failure-ignores-external-url-and-cleans-up`（注入哨兵 URL，哨兵连接数 = 0，仍在 `database-init` 失败并清理）。

### C. 清理失败仍报 PASS

- RED（静态）：旧装置清理顺序脆弱，清理失败不阻断 PASS；错误输出可能带出连接串。
- 修正：四步清理（connection-pool → setup-client → postgres-container → model-guard）相互独立执行，全部收敛后 `assertCleanupComplete(cleanupIssues)` 作为 PASS 前置闸门；失败统一走 stderr 结构化报告 `{"result":"FAIL",phase,message,passed,total,container,cleanupIssues}`，并统一脱敏连接串与 `cga_teacher=` Cookie。
- GREEN：`cleanup-steps-independent-failure-blocks-pass`（单步失败仍执行全部步骤且阻断 PASS）、`startup-failure-cleans-own-container-only`（非回环映射被拒并按本轮 ID 清理、他人容器保留）、`real-assert-failure-cleans-up-and-keeps-others`（`phase=checks passed=4`、自有容器清空、6 个他人容器全保留）。

## 新增专属安全反例（11 项，`scripts/check-classes-harness-safety.ts`）

1. `helper-blob-unmodified`：`harness-safety.ts` blob 精确匹配。
2. `source-external-url-pattern-removed`：外部 URL 模式、连接串字面量、平台库回退与目标绑定。
3. `source-no-direct-docker-no-model-call`：无 `spawnSync`/`node:child_process`/模型出口配置，复用 helper，PASS 输出位于清理闸门之后，所有权标签可从源码解析。
4. `legacy-fixed-name-container-preserved`：旧固定名容器保留、拒绝路径不发出 `rm`。
5. `foreign-containers-untouched`：仅删除本轮 ID+标签容器。
6. `startup-failure-cleans-own-container-only`：启动/核验失败后本轮容器被清理，他人容器不受影响。
7. `cleanup-steps-independent-failure-blocks-pass`：清理步骤独立执行，失败阻断 PASS。
8. `docker-daemon-available`：进入真实反例的前置。
9. `real-init-failure-ignores-external-url-and-cleans-up`：真实子进程 `phase=database-init passed=3`，哨兵 0 连接，自有容器清空，旧固定名保留。
10. `real-assert-failure-cleans-up-and-keeps-others`：真实子进程 `phase=checks passed=4`，自有容器清空，他人容器 6 个全保留。
11. `legacy-container-released-by-id-and-label`：本轮创建的旧名容器按 ID+标签回收。

过程中发现并修复的装置缺陷：安全反例原以 `import { OWNERSHIP_LABEL } from './check-classes'` 引入常量，而 `check-classes.ts` 顶层 `void main()`，import 即在安全检查进程内跑起整套 15 项真实检查并向 stderr 泄出一条 `passed=11` 的失败行。改为从 `CHECK_SOURCE` 源码文本解析该标签，并加断言保证解析非空；`OWNERSHIP_LABEL` 由 `export const` 收回为 `const`。

## 原 15 项班级业务检查结果

- `node node_modules/tsx/dist/cli.mjs scripts/check-classes.ts` → `{"result":"FAIL","phase":"checks","passed":11,"total":15,"container":"<本轮 64 位 ID>","cleanupIssues":[]}`，退出码 1。
- 通过 1～11：迁移脚本同构、Zod 学段/学年、演示班级与归属、石头转班历史、演示观察发生时班级快照、API 路由只读开放与 401、三学段创建 + 409 + 400、班级详情与 401、儿童建档分班/按名匹配/明确报错/401。
- 第 12 项失败于第 480 行 `assert.equal(firstObs.observed_class?.name, '自检小班')`（其前的 201 与 `firstObs.class_id` 断言均已通过），实际值 `undefined`。
- **该失败与基线完全一致，非本轮装置引入**：把基线原始 `scripts/check-classes.ts`（`git show cfa7b03:scripts/check-classes.ts`）放到同一工作树、同一份 `src/` 下运行，同样在基线第 443 行以相同断言、相同 `undefined vs '自检小班'` 失败（`src/` 与基线零 diff，`git diff cfa7b03 --stat` 只含 `scripts/check-classes.ts`）。
- 根因在业务代码：`createObservation` 的 `RETURNING to_jsonb(observations.*) AS data`（`src/lib/queries.ts:705-709`）不含 `observed_class` 联表，`mapObservation` 因此得到 `null`；该字段只在 `OBSERVATION_SELECT`（列表/详情路径）里补齐。修复需改业务代码，超出本任务边界（只动测试装置），故如实记录、不改断言、不改 fixture。

## 检查结果与限制

- `scripts/check-classes-harness-safety.ts` → `{"result":"PASS","passed":11,"total":11}`，退出码 0；stdout 仅含 11 条反例 + 结果行，**stderr 为空**；运行后 `docker ps -a` 无 `child-growth-agent.check-classes.run` 标签容器残留。
- `scripts/check-classes.ts`（原 15 项）→ 11/15，第 12 项失败原因见上，与基线一致。
- `pnpm ts-check` → 通过；`pnpm lint:build` → 通过。
- `NOT_RUN`：模型调用（守门拦截，零出口）、浏览器/UI、部署、push/合并 main、对 `src/**` 与迁移的任何写入。
- 剩余限制：第 12 项属基线既有的测试-实现不一致，需主评审决定由业务代码补 `observed_class` 还是另行处置；本任务不自行宣布可开工。

## 工作树状态

- 基线祖先正确，分支 `codex/test-safe-classes`，提交后工作树干净；未 push、未部署、未合并 main、未操作其他 agent 工作树，未改动 `harness-safety.ts`（blob 校验通过）。
- 状态：**测试装置返修候选，等待主评审**。
