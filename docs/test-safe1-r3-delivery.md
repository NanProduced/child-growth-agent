# TEST-SAFE1-R3 交付报告（真实部分初始化用例的无条件清理，等待主评审）

- 基线：`4b9b2ab50aa32d6cdbce51d282cabcdea09f0939`（TEST-SAFE1-R2，已核实分支 `codex/test-safe-classes`、工作树干净）
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-test-safe1`
- 分支：`codex/test-safe-classes`
- 本记录提交：包含本文件的 `test:` 提交（不写入自身 SHA，避免自引用）
- `RTK.md`：不存在（已记录，未补造、未安装）。
- 状态：**返修候选，等待主评审**。只修 `real-partial-init-legacy-created-foreign-fails` 的调用方清理时序；未重开其他问题。

## 1. 精确修改清单

| 文件 | 变更 |
|---|---|
| `scripts/check-classes-harness-safety.ts` | 新增 `runPartialInitCaller`（setup 后立即进入受 finally 保护的检查区域，断言失败也执行 `cleanupOwnedResources(setup)`）与 `describeCleanupFailures`；真实 partial-init 用例改走该调用方控制流；新增 3 项调用方级反例 |
| `docs/test-safe1-r3-delivery.md` | 本记录（新增） |

未修改：`scripts/check-classes.ts`、`scripts/harness-safety.ts`（blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`，每轮校验）、
`src/**`、schema、迁移、依赖与锁文件、AUTH/HOME/G0～G5 与其他 agent 文件、旧交付报告。

检查数量：原 28 项全部保留；新增 3 项；合计 **31 项**。原 15/15 班级检查保持通过。

## 2. 唯一待修问题与 RED

问题：`real-partial-init-legacy-created-foreign-fails` 取得 setup 后先执行多条 assert，最后才调用
`cleanupOwnedResources`，没有 finally；断言失败即跳过清理。

RED（内存 Docker 替身，`red-r3.out.txt`）：复刻调用方时序与竞态——首次 inspect 看到旧容器，原所有者随后移除，
setup 自建 replacement（created:true），基于首次 inspect 的断言失败：

```json
{"first_inspection_state":"verified","docker_ok":false,
 "replacement_created":true,
 "assertion_thrown":"既有 legacy 必须保持 created:false",
 "cleanup_calls":0,
 "replacement_alive":true}
```

探针随后自行清理本轮自建 replacement（内存替身，无真实残留）。

## 3. GREEN（最小修复）

1. 新增 `runPartialInitCaller({ setupRunner, cleanupRunner?, check })`：`setupOwnedResources` 返回后立即进入
   `try { check(setup) } finally { cleanupOwnedResources(setup) }`；任何断言失败都执行清理，与断言成功与否无关。
2. 清理依据 setup 实际持有的句柄与所有权：`created:true` 按完整 ID + 本轮标签核实后清理；
   `created:false` 不进入删除步骤；不依据首次 inspect、`dockerOk` 或断言结果决定是否清理。
3. 主失败与清理失败分别保留：清理异常被捕获为清理问题，不覆盖原断言失败；两者同时失败时合并报告
   `${原失败}；清理问题（资源引用保留）：${清理项与失败资源 ID}`；任一失败或身份无法核实即抛错（整体非零退出）。
4. 复用 `cleanupOwnedResources` / `runCleanupSteps` / `removeOwnedContainer` 现有原语，局部 try/finally；
   未新增资源管理框架、未包装整套测试系统。
5. 未删除任何断言：真实用例在竞态下仍判失败，但失败前必先完成本轮资源清理。

真实用例 `real-partial-init-legacy-created-foreign-fails` 改为调用 `runPartialInitCaller`；
正常环境分支行为不变（自建 legacy 清理后复核 absent；既有 legacy created:false 保持），
竞态分支则在报告断言失败前先清理自建 replacement。

## 4. 新增调用方级反例（实际控制流，内存替身）

| 反例 | 断言 |
|---|---|
| `partial-init-caller-cleans-on-assert-failure` | 竞态：首次看到旧容器 → 旧容器消失 → setup 自建 replacement（created:true）→ 断言失败：清理仍执行、replacement 不残留、原失败可见、整体非 PASS |
| `partial-init-caller-keeps-existing-on-assert-failure` | setup 返回 created:false + 检查失败：既有容器保持原样、不发出删除动作、原失败保留 |
| `partial-init-caller-preserves-both-failures` | 检查失败 + 清理失败并存：两种原因均保留、报告失败资源 ID、整体失败且不覆盖原错误 |

实测详情（`harness-safety-r3.out.txt`）：

- A：`竞态断言失败后仍按句柄清理 replacement，原失败可见且非 PASS`；
- B：`created:false + 检查失败：既有容器保持且不发出删除`；
- C：`原失败与清理失败并存且资源引用保留：检查阶段失败注入；清理问题（资源引用保留）：legacy-container-released-by-id-and-label: 删除容器 1111… 失败：simulated removal denied（资源 1111…）`。

## 5. 验证与结果

串行执行（先安全检查，后班级检查）：

| 检查 | 结果 |
|---|---|
| `pnpm exec tsx scripts/check-classes-harness-safety.ts` | **PASS 31/31，exit 0**（原 28 项 + 新增 3 项） |
| `pnpm exec tsx scripts/check-classes.ts` | **PASS 15/15，exit 0**（原 15 组全部保留） |
| `pnpm ts-check` | exit 0 |
| `pnpm lint:build` | exit 0 |

本轮资源清理证明：运行后 `docker ps -a` 无 `cga-*` 残留；真实 partial-init 用例实测
`自建 legacy 19bb4c78fcca… 已按 ID+标签清理`；主流程 legacy/foreign 收尾均按 ID+标签回收；
既有 `zzsh-*` 等容器未被触碰；`harness-safety.ts` blob 全程未变。

证据分层：

- **内存 Docker 替身（实际调用方控制流）**：新增 3 项反例（A/B/C），覆盖竞态、created:false 保留、双失败并存。
- **真实 Docker / 子进程 / 一次性 PostgreSQL**：`real-partial-init-legacy-created-foreign-fails` 与其余真实反例、
  15 项班级检查；只使用本轮自建并核验的一次性本地资源。
- **源码静态**：helper blob、外部 URL 模式、无直接 docker/模型出口、PASS 位于清理闸门之后。
- **NOT_RUN**：真实模型调用（守门零出口、预算未重置）、托管库/线上库、浏览器/UI、部署、push/合并 main、
  `src/**`/迁移/依赖写入、其他 agent 资源。

## 6. 工作树与状态

- 提交后工作树干净；未 push、未部署、未合并 main。
- 状态：**返修候选，等待主评审**。
