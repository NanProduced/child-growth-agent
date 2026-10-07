# TEST-SAFE1-R2 交付报告（父层失败分支返修候选，等待主评审）

- 基线：`64dd83fa2a288c51f667d08ff9effd37c25803de`（TEST-SAFE1-R1，已核实分支 `codex/test-safe-classes`、工作树干净）
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-test-safe1`
- 分支：`codex/test-safe-classes`
- 本记录提交：包含本文件的 `test:` 提交（不写入自身 SHA，避免自引用）
- `RTK.md`：不存在（已记录，未补造）。
- 状态：**返修候选，等待主评审**。只修两个主评审已复现的父层失败分支；未重开 C 项、未改业务代码或共享 helper。

## 1. 精确修改清单

| 文件 | 变更 |
|---|---|
| `scripts/check-classes-harness-safety.ts` | A：新增调用方级补偿 `runWithRegisteredCleanup`（finally 补偿、原失败与清理失败并存、不覆盖原失败），三个真实调用方（初始化失败/断言失败/超时检查）全部接入；B：资源句柄改为“先登记后核验”，`setupOwnedResources` / `cleanupOwnedResources` 按实际持有句柄清理，句柄不再受 `dockerOk` 影响；新增 10 项反例 |
| `docs/test-safe1-r2-delivery.md` | 本记录（新增） |

未修改：`scripts/check-classes.ts`（创建快照、真实回读、转班与停用断言及原 15 组全部保留）、`scripts/harness-safety.ts`
（blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`，每轮反例校验）、`src/**`、schema、迁移、AUTH/G0～G5/HOME、
`PRODUCT.md`、依赖与锁文件；未改写旧交付报告。

检查数量：已有 18 项全部保留；新增 10 项；合计 **28 项**。原 15/15 班级业务检查保持通过。

## 2. A：断言失败跳过资源补偿

### RED（调用方控制流，内存替身，`red-a2.out.txt`）

按 R1 调用顺序复现：`assertTimeoutOutcome` 先断言 `treeStop.ok=true`，断言抛错后补偿不会执行：

```json
{"thrown":"进程树终止必须核实退出：终止命令返回失败：simulated；已记录的后代仍存活：PID 9001 ...",
 "compensation_calls":0,
 "registered_container_alive":true}
```

### GREEN（修复）

1. 新增 `runWithRegisteredCleanup(run, body, runner)`：主步骤放在 `try`，**补偿清理放在不依赖断言成功的 `finally`**；
   finally 自身异常只进入清理问题，不覆盖原失败。
2. 实际调用方全部接入：`real-init-failure-ignores-external-url-and-cleans-up`、
   `real-assert-failure-cleans-up-and-keeps-others`、`timeout-hang-after-container-compensates`
   的断言体移入 wrapper，补偿由 wrapper 统一执行。
3. 原失败与清理失败分别保留并合并报告：`原失败；补偿清理问题（资源引用保留）：...`；
   存在任一失败或未核实状态 → 反例 FAIL → 非零退出（不报告 PASS）。
4. 继续复用 `runCleanupSteps` / `removeOwnedContainer` / `assertCleanupComplete` 等现有原语；未新增资源管理框架、未改 helper。

新增调用方级反例（全部执行实际 wrapper 控制流，替身注入故障分支）：

| 反例 | 断言 |
|---|---|
| `caller-compensates-when-tree-stop-fails` | treeStop.ok=false + 登记资源：补偿仍执行、资源被清理、整体失败且保留原失败 |
| `caller-compensates-when-middle-assertion-fails` | 中间断言抛错：登记资源仍被补偿清理 |
| `caller-preserves-both-failures` | 原失败（treeStop）+ 补偿失败（rm denied）并存：两个原因与资源 ID 均保留，资源保持不动 |
| `caller-cleans-remaining-resources-when-one-compensation-fails` | 一个资源清理失败：其余登记资源仍被清理，整体失败 |
| `caller-compensation-idempotent-normal-path` | 正常路径/已清理资源的补偿幂等成功 |

## 3. B：部分初始化失败丢弃已创建句柄

### RED（真实 Docker + 现状调用方逻辑，`red-b2.out.txt`）

legacy 创建成功（`created:true`）后，后续 foreign 创建失败使 `dockerOk=false`，R1 的
`legacyTarget = dockerOk ? legacy : null` 把已持有句柄排除：

```json
{"legacy_created":true,"docker_ok_after_foreign_failure":false,
 "legacy_target_visible_to_cleanup":null,"would_cleanup":false,
 "registered_container_still_alive":true}
```

探针创建的 legacy 容器随后由探针按 ID+标签回收（own resource，未操作他人资源）。

### GREEN（修复）

1. `ensureLegacyContainer` / `ensureSameLabelForeignContainer` 改为“**句柄先登记再核验**”：
   `docker run` 成功并解析出容器 ID 后立即 `register(handle)`，后续核验失败也不丢资源引用（错误信息携带 ID）。
2. `setupOwnedResources` 返回实际持有的句柄（`legacy` / `foreign` / `setupError`）；`dockerOk` 只决定是否继续执行检查，
   不再决定句柄保留或清理；`legacyTarget` / `foreignTarget` 直接取自 setup，不受 `dockerOk` 影响。
3. `cleanupOwnedResources` 按实际句柄生成清理步骤：`created:true` 才进入删除；`created:false` 的既有 legacy 永不删除；
   foreign 由创建者按 ID+对应标签回收；步骤经 `runCleanupSteps` 独立执行，单步失败不跳过其他资源，失败项保留资源 ID。
4. 主流程 finally 使用 `cleanupOwnedResources`；清理结果以既有反例名
   `legacy-container-released-by-id-and-label` / `same-label-foreign-container-released-by-creator` 记录（18 项名称保留）。

新增反例（优先替身，另有 1 项真实资源验证）：

| 反例 | 断言 |
|---|---|
| `partial-init-legacy-created-foreign-fails` | 自建 legacy 成功、foreign 创建失败：legacy 句柄保留并清理 |
| `partial-init-existing-legacy-foreign-fails` | 既有 legacy（created:false）+ foreign 创建失败：既有资源保留、不进入删除步骤 |
| `partial-init-both-created-middle-fails` | 两资源均创建后中间步骤失败：两者都进入清理 |
| `partial-init-one-cleanup-fails-other-continues` | 一个清理失败：另一个仍执行；整体非成功且保留失败资源引用 |
| `real-partial-init-legacy-created-foreign-fails` | **真实 Docker**：真实 legacy 创建成功 + foreign 创建失败（测试侧 runner 注入），legacy 仍按 ID+标签清理（本轮实测 `自建 legacy 72cea9acffd1… 已清理`；若环境已有 legacy 则验证 created:false 保留分支） |

## 4. 验证与结果

串行执行（先安全检查，后班级检查）：

| 检查 | 结果 |
|---|---|
| `pnpm exec tsx scripts/check-classes-harness-safety.ts` | **PASS 28/28，exit 0**（保留原 18 项 + 新增 10 项） |
| `pnpm exec tsx scripts/check-classes.ts` | **PASS 15/15，exit 0**（原 15 组全部保留） |
| `pnpm ts-check` | exit 0 |
| `pnpm lint:build` | exit 0 |

真实测试 / 替身测试区分：

- **真实（Docker / 子进程 / 一次性 PostgreSQL）**：`real-partial-init-legacy-created-foreign-fails`、
  三个真实调用方反例（init/assert/超时挂起）、既有 legacy 保留与回收、同标签异 RUN 容器保留与创建者回收、
  15 项班级业务检查。
- **替身/注入（不产生真实破坏）**：A 的 5 项调用方级反例、B 的 4 项部分初始化反例、以及既有 11 项中依赖假 docker 的反例。
- **源码静态**：helper blob、外部 URL 模式、无直接 docker/模型出口、PASS 位于清理闸门之后。

关键证据：

- 原失败与补偿失败并存：`caller-preserves-both-failures` 详情同时含 `未核实/残留` 原失败、`removal denied` 补偿失败与容器 ID。
- created:true 清理：`real-partial-init-legacy-created-foreign-fails`、`partial-init-legacy-created-foreign-fails`、
  主流程 `legacy-container-released-by-id-and-label`。
- created:false 保留：`partial-init-existing-legacy-foreign-fails`、`legacy-fixed-name-container-preserved`。
- 本轮实测超时路径：`timeout-hang-after-container-compensates` → `已按 PID 19980 + 创建身份核验终止本轮进程树；已核实 2 个已记录后代退出；登记容器 16d33ee9e3b8… 已补偿清理`。

## 5. 清理、NOT_RUN 与剩余限制

- 清理：每轮运行后 `docker ps -a` 无 `cga-*` 残留；既有 `zzsh-*` 等容器未被触碰；
  `harness-safety.ts` blob 全程未变；RED 探针创建的真实容器均由探针按 ID+标签回收。
- NOT_RUN：模型调用（守门零出口）、浏览器/UI、部署、push/合并 main、对 `src/**`/迁移/依赖的任何写入、其他 agent 工作树。
- 剩余限制：A 的调用方反例使用内存替身覆盖故障分支（真实调用方控制流已执行）；
  真实 partial-init 的 foreign 失败由测试侧 runner 注入（现状代码无产品故障开关）；非 Windows 平台进程树语义未验证。
- 工作树：提交后干净，未 push、未部署、未合并 main。
- 状态：**返修候选，等待主评审**。
