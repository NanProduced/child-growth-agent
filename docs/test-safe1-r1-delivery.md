# TEST-SAFE1-R1 交付报告（班级测试装置返修候选，等待主评审）

- 基线：`dcfaa54ce8790c03b4cb8aa10474472c2073a3f9`（TEST-SAFE1，已核实分支 `codex/test-safe-classes`、工作树干净）
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-test-safe1`
- 分支：`codex/test-safe-classes`
- 本记录提交：包含本文件的 `test:` 提交（不写入自身 SHA，避免自引用）
- `RTK.md`：不存在（已记录，未补造）。
- 状态：**返修候选，等待主评审**。只闭合主评审确认的三处问题；未修改班级业务、认证实现与其他 agent 工作树。

## 1. 精确修改清单

| 文件 | 变更 |
|---|---|
| `scripts/check-classes.ts` | A：容器核验通过后输出最小结构化资源报告（RUN_ID / 容器名 / 容器ID / 所有权标签 / 创建阶段），新增确定性挂起注入 `hang-after-container`；C：创建响应断言对齐持久化快照（12/13/14 项） |
| `scripts/check-classes-harness-safety.ts` | A：`runCheckChild` 改用 `trackChildProcess` / `stopTrackedChildTree`，超时报告区分“已发送终止请求”与“已核实进程树退出”，父进程按登记资源补偿清理；B：残留判定改为本轮登记 ID，新增同标签异 RUN 反例；新增 7 项反例 |
| `docs/test-safe1-r1-delivery.md` | 本记录（新增） |

未修改：`scripts/harness-safety.ts`（blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`，每轮反例校验）、`src/**`、schema、迁移、AUTH/G0～G5/HOME、`PRODUCT.md`、依赖与锁文件；未改写上一轮交付报告。

## 2. A：超时不能只杀根进程

### RED（真实进程对照，`red-a.out.txt`）

基线 `runCheckChild` 超时只 `child.kill()`，根进程消失即按“已终止”返回。用本轮自建的“父进程派生 detached 后代后退出”复现：

```json
{"baseline_conclusion":"已终止（仅根进程消失，未核验后代）","descendant_pid":76416,
 "descendant_alive":true,
 "helper_report":{"ok":false,"detail":"子进程已退出，但发现疑似残留后代 PID 76416；拒绝按旧 PID 强杀，需人工核实"}}
```

RED 后由探针按 PID 清理本轮自建后代（`descendant_cleaned:true`），未触碰其他进程。

### GREEN（修复）

1. `runCheckChild` 用 `trackChildProcess` 记录 PID 与创建身份；超时后 `stopTrackedChildTree` 终止并核验进程树，返回 `timedOut`、`treeStop`、`resources` 结构化结果。
2. `assertTimeoutOutcome`：只有 `treeStop.ok`（已核实退出）才算完成；未核实/后代残留必须失败，不写“已终止”冒充完成。
3. 子任务在容器身份核验后输出最小结构化资源报告（不含连接串/口令/Cookie/模型凭证），父检查据此掌握 RUN_ID、容器名、容器ID、所有权标签与创建阶段。
4. 超时/异常退出来不及执行 finally 时，父进程 `compensateRegisteredResources` 按已核实 ID + 所有权补偿清理；创建结果或所有权无法核实 → 记录未知、保留资源引用、非零退出。
5. 清理步骤经 `runCleanupSteps` 独立执行；不按端口、宽泛进程名、固定容器名强杀；未新增通用资源框架、未改共享 helper。

实测（`timeout-hang-after-container-compensates`）：确定性挂起点 + 45s 短超时（不等待 300s）：

```json
{"name":"timeout-hang-after-container-compensates","ok":true,
 "detail":"短超时触发；已按 PID 79264 + 创建身份核验终止本轮进程树；已核实 2 个已记录后代退出；登记容器 c51946ac6dba… 已补偿清理"}
```

补充反例（真实结果统计）：`timeout-descendant-survivor-reports-failure`（根消失、已知后代存活 → 非成功并列出 PID）、
`timeout-compensation-rm-failure-blocks-pass`、`timeout-compensation-unverifiable-keeps-reference`（不删除身份不明资源、保留引用）、
`timeout-compensation-idempotent-on-clean-resource`（正常结束路径保持成功）。

## 3. B：残留判定只针对本轮资源

### RED（真实 Docker，`red-b.out.txt`）

基线 `listContainerIds(OWNERSHIP_LABEL).length === 0` 检查整个标签命名空间。存在同一标签、不同 RUN_ID 的合法容器时：

```json
{"baseline_namespace_count":1,"baseline_conclusion":"误报残留 1 个",
 "same_label_foreign_run_id":"red-foreign-5948-mutecngj","same_label_foreign_verified":true,
 "per_id_residue":[]}
```

探针创建的异 RUN 容器由创建者按 ID + 对应标签回收（`creator_cleanup.ok:true`）。

### GREEN（修复）

- 两处真实反例的残留判定改为“本轮登记容器 ID + 对应所有权标签”逐一核实；不再检查整个标签命名空间，也不以“前后新增的所有容器”为删除目标。
- 测试装置自建“同一 OWNERSHIP_LABEL、不同 RUN_ID”容器模拟他人资源，另记测试装置所有权，收尾只由创建者按 ID + 对应标签删除。
- 预先存在的旧固定名容器保持 `created:false`，绝不删除。
- 不再 import `check-classes.ts` 获取常量（沿用源码解析）。
- 反例 `same-label-foreign-run-not-residue`（替身）：本轮按登记 ID 判定清理成功，同标签异 RUN 容器保持不变；
  真实 init/assert/hang 三个反例中同标签异 RUN 容器始终 verified，收尾 `same-label-foreign-container-released-by-creator` 按 ID+标签回收。

## 4. C：创建响应断言对齐持久化快照

### RED（基线脚本实跑，`red-c.out.txt`）

`git show dcfaa54:scripts/check-classes.ts` 原样运行：`{"result":"FAIL","phase":"checks","message":"undefined vs '自检小班'","passed":11,"total":15}`，退出码 1（第 12 项把读取路径的 `observed_class` 联表投影断言在创建响应上）。

### GREEN（修复，测试侧对齐，未改业务）

- 第 12 项创建响应优先验证：`class_id`、`observed_at`、`raw_text` 与 `class_context_snapshot` 的
  `class_id / class_name / stage / school_year / source`；
- 随后用真实读取路径（`listObservations`）回读同一观察，保留 `observed_class` 名称等联表投影验证，并对创建响应与回读的持久化快照做 `deepEqual` 一致性比较；
- 第 13 项：转班后旧观察的 `class_id`、持久化快照、`raw_text` 保持不变；新观察创建响应验证新班级快照（`自检中班`/`middle`）并回读校验；
- 第 14 项：停用班级后历史观察快照与原文不变；
- `observed_class` 仅用于读取路径的动态投影验证，不用于回填历史快照、推断未知阶段或代替指南证据阶段；不 mock 响应、不跳过断言、不吞失败、未改 `queries.ts` 或业务 API。

### 原 15 项业务结果（真实一次性 PostgreSQL + 路由）

`{"result":"PASS","passed":15,"total":15,...}`，退出码 0；覆盖迁移同构、Zod、演示班级/归属、石头转班历史、
演示观察快照、API 只读/401、三学段创建/409/400、班级详情、儿童建档分班/按名匹配/报错、
观察发生时班级快照与回读一致、未登录 401、无归属 409、**转班**、**停用**、**终态复核**。
未发现新的业务缺陷；此前第 12 项失败确认为测试断言位置错误，非业务缺陷。

## 5. 验证与结果

串行执行（先安全检查，后班级检查）：

| 检查 | 结果 |
|---|---|
| `pnpm exec tsx scripts/check-classes-harness-safety.ts` | **PASS 18/18，exit 0**（保留原 11 项，新增 7 项） |
| `pnpm exec tsx scripts/check-classes.ts` | **PASS 15/15，exit 0** |
| `pnpm ts-check` | exit 0 |
| `pnpm lint:build` | exit 0 |

安全检查 18 项明细：helper-blob-unmodified、source-external-url-pattern-removed、
source-no-direct-docker-no-model-call、legacy-fixed-name-container-preserved、foreign-containers-untouched、
startup-failure-cleans-own-container-only、cleanup-steps-independent-failure-blocks-pass、
same-label-foreign-run-not-residue、timeout-descendant-survivor-reports-failure、
timeout-compensation-rm-failure-blocks-pass、timeout-compensation-unverifiable-keeps-reference、
timeout-compensation-idempotent-on-clean-resource、docker-daemon-available、
real-init-failure-ignores-external-url-and-cleans-up、real-assert-failure-cleans-up-and-keeps-others、
timeout-hang-after-container-compensates、legacy-container-released-by-id-and-label、
same-label-foreign-container-released-by-creator。

真实测试 / 替身测试区分：

- **真实（Docker / 子进程 / 一次性 PostgreSQL）**：legacy 保留与回收、他人容器不受影响、启动失败清理、
  同标签异 RUN 容器保留与创建者回收、init/assert 失败清理、超时挂起子任务的进程树核验与补偿清理、15 项班级检查。
- **替身/注入（不产生真实破坏）**：旧固定名拒绝、仅删本轮 ID、同标签异 RUN 残留判定、
  后代残留/清理失败/无法核实/幂等补偿。
- **源码静态**：helper blob、外部 URL 模式、无直接 docker/模型出口、PASS 位于清理闸门之后。

## 6. 清理、NOT_RUN 与剩余限制

- 清理：每轮运行后 `docker ps -a` 无 `cga-*` 残留；既有 `zzsh-*` 等容器未被触碰；
  期间一次管道中断（证据文件路径不存在）遗留的 2 个本轮自建容器，已用获批 helper 按 ID+对应标签回收，
  未操作其他 agent 资源；`harness-safety.ts` blob 全程未变。
- NOT_RUN：模型调用（守门拦截，零出口）、浏览器/UI、部署、push/合并 main、对 `src/**`/迁移/依赖的任何写入、
  其他 agent 工作树。
- 剩余限制：超时默认值仍为 300s，测试用 45s 短超时；挂起点是测试专用注入阶段（仅环境变量，非产品开关）；
  非 Windows 平台进程树语义未验证；C 为测试侧断言对齐，不改变业务读写路径。
- 工作树：提交后干净，未 push、未部署、未合并 main。
- 状态：**返修候选，等待主评审**。
