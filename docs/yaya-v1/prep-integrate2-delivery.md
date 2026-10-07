# YAYA-PREP-INTEGRATE2 交付：第二波共同基线 C2 组合、联合检查与交接

2026-10-06。任务：把四个已获批提交（核心候选 `44d2303` + API0-R1、TOOLS-READ1-R1、QA-SEED1-R1）
在独立工作树上组合成第二波共同基线 C2，完成组合验证与最小联合检查。
本文件随候选提交落地；完整 C2_SHA、分支与工作树见交付回复。**不含写工具、聊天运行 API 或 UI**。

## 1. 来源、祖先与合并

| 项 | SHA | 说明 |
|---|---|---|
| 起点（核心候选） | `44d230357d5b52560714de7e1123015081fa35bf` | `codex/yaya-core-integration` tip（P1 收口后） |
| API0-R1 | `98f6b477a99de6a60460e7e33b81b53a9a8beccd` | `--no-ff` merge `af90c3f950c006e93396ebb492381e909dd098bc` |
| TOOLS-READ1-R1 | `2f0f3f31d6dd00ad0fa9fcb9beb77898dd719b98` | `--no-ff` merge `373db7ee48c96a3a5e34f385e0c95be4269334e7` |
| QA-SEED1-R1 | `70a04a8200c051bd77401bca57e08257cc45d869` | `--no-ff` merge `4a2c7fac874236213f10dc6788be2321f0a53301` |
| 组合候选（C2） | 见交付回复 | 本文件随该提交落地 |

- 三条准备支线均从 `24b0588` 分叉（`merge-base` 逐一核实），不要求它们先含 `44d2303`；
  合并前已用 `merge-base --is-ancestor 24b0588 <tip>` 核实来源祖先关系。
- 合并后已用 `merge-base --is-ancestor <四个获批 SHA> HEAD` 逐项核实：**四个 SHA 均为最终 HEAD 的祖先**。
- 合并全部按 `ort` 无冲突纯合并；未整文件取 ours/theirs、未复制在制文件、未压平来源历史、未 reset 其他分支。
- 工作树/分支：`C:\Users\nanpr\AppData\Local\Temp\opencode\yaya-c2` / `codex/yaya-prep-integration2`；
  来源工作树在操作时均为 clean，本轮未改动 `main`、来源工作树或其他 agent 文件。
- `scripts/harness-safety.ts` 保持 blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503`（合并前后 `hash-object` 复核）。
  `package.json` / `pnpm-lock.yaml` / 冻结 `src/lib/yaya/types.ts`、`agent/types.ts`、`storage-types.ts`
  与起点逐字节一致（`git diff 44d2303 HEAD -- ...` 为空）。`RTK.md` 不存在（仅记录，未创建/安装）。
- 真实模型预算 40/40 未重置；本轮全部装置 `real_model_requests = 0`、模型守门 0 命中；未读 `.env`、
  未连托管库、未调用真实 provider/搜索/S3。

## 2. 必要兼容修改

**产品源码零额外修改**：除四个来源提交外，`src/**` 无任何整合写改。
本任务新增/更新文件（全部为本任务自有范围）：

| 文件 | 性质 |
|---|---|
| `scripts/yaya/check-integration-prep-joint.ts` | 新增：本任务专属最小联合检查（31 项） |
| `docs/yaya-v1/prep-integrate2-delivery.md` | 新增：本文件 |
| `docs/yaya-v1/development-plan.md` | 局部更新：§1.1 第二波接续与唯一 owner |
| `docs/yaya-v1/qa-seed1-delivery.md` | 事实计数勘正：观察 14 条 → 15 条（与种子键数、验收计划一致） |

## 3. 跨模块接缝复核

### A. API0 浏览器消费与恢复边界

- `src/lib/yaya/api-contract.ts` 不导入 `storage-types`/`node:crypto`（导入仅 zod、accounts 类型常量、
  `import type` 的 LlmUsage、media limits 与冻结 yaya 类型）；`check-api-contract` 内做真实 esbuild
  `platform=browser` 打包，57/57 通过。
- 四种终态恢复往返、`finished + proposed` 恢复、停止详情统一 `safeYayaStopDetail` 脱敏、
  run_end 与 proposal 完整业务内容深比较、重复/歧义终态拒绝，均由 57 项装置实跑覆盖。
- 结构解析成功 ≠ 保存成功：`assessYayaOperationsExecutionResponse(plan, body)` 对照完整预期计划，
  `saved + effect=unknown + 空业务标识` 判 `unverified_success`；本轮联合检查另证内核流经
  `projectYayaAgentEvent/projectYayaRunEnd → encodeYayaRunEventLine → parseYayaRunWireLine →
  validateYayaRunEventStream` 往返一致（含 stopped 详情脱敏）。

### B. READ1 来源协议

- 工具结果使用 `citable_source`（唯一可引用主来源）+ `recheck_dependencies`（服务器重核图），
  不再消费旧 `source_refs` 字段；`outcome.source === payload.citable_source`。
- 离线 189/189 与真实库 87/87 复跑：正向引用 `children:current_scope` 成功；引用依赖 ID / 任意 ID
  被 `source_mismatch` 拒绝；原文/确认内容/AI 草稿/工作流 `content_sources` 分层。
- 成长小结/活动支持依据观察保留在重核依赖中（离线替身端口），缺失/坏来源不隐藏、不伪造已核验。

### C. 后续 APP 重核约束（本轮不冒充正式装配）

- 真实 Agent 内核按 run 累积 `knownSources`（Map，逐次读取只增），联合检查实测：
  读取列表 → 再次读取另一列表 → 仍可引用**早先**的 `children:current_scope`（不被后来结果覆盖）。
- 依赖完整保留实测：`list_children` 的 `recheck_dependencies` 含全部可读幼儿与主来源；
  `get_observation` 依赖保留对象自身；目录策略与名单权限分离沿用 READ1 真实库检查（catalog 只给基础目录）。
- **来源标签不是授权**；本轮 `recheck_substitute: 'dependency presence probe only'`，
  正式 AGENT-APP1 逐项重核装配与 run 持久化仍是 NOT_RUN，未以联合检查冒称完成。

### D. QA 种子装置

- 精确目录/容器登记、teardown 首败重试、准备阶段失败传递（`AcceptanceResourceError.cleanup_ok`）
  经 `acceptance/run.ts` 复跑：两轮各 62 项回读、三条失败路径 `cleanup_ok=true`、所有权探针 5/5。
- 他方合法资源仅展示不计残留；本轮结束后按容器标签/临时目录复查 0 残留。
- 正常指南种子条目与事实语义对照（4 组）在 verify 中逐字/关键词核验；故障夹具单列（`[故障夹具]`）。
- 种子回读 62 项 ≠ 聊天/真实模型验收（浏览器轮与真实模型仍 NOT_RUN）。

## 4. 组合验证（在 C2 组合候选上重新实跑，未复制来源数字）

| 检查 | 结果 |
|---|---|
| `pnpm validate`（tsc / eslint / stylelint） | 通过 |
| 完整构建入口 `scripts/build.ps1`（`pnpm next build` + `tsup src/server.ts`） | 通过（见 §5 Windows 说明） |
| `check-api-contract.ts` | **57/57** |
| `check-tools-read.ts` | **189/189** |
| `check-tools-read-db.ts` | **87/87**，`cleanup: verified` |
| `acceptance/run.ts`（QA 种子自检） | 两轮各 **62/62**；失败路径 3/3 `cleanup_ok`；所有权 **5/5**；0 残留 |
| `check-contract` / `check-preflight` | **68/68** / **15/15** |
| `check-agent-engine` / `prompt` / `llm` | **29/29** / **10/10** / **7/7** |
| `check-media` / `check-media-r1` | **28/28** / **25/25** |
| `check-integration-media-db` | **88/88** |
| `check-integration-http` | **17/17** |
| `check-auth-contract` / `check-guide-contract` | **36/36** / **19/19** |
| `check-business-access` | **113/113**，`cleanup: verified` |
| `check-save-consistency` / `check-guide-write-flow`（既有离线回归） | **24/24** / **123/123** |
| `check-integration-prep-joint.ts`（本任务新增） | **31/31**，`real_model_requests: 0`，`cleanup: verified` |

未删断言、未降低预期；所有数值为本轮实跑输出。Next/HTTP 与 Docker 装置按串行执行，避免生成物与端口竞争。

## 5. 环境差异与已知问题（单列，不修旧系统）

- **Windows 构建**：在短路径工作树 `…\Temp\opencode\yaya-c2` 使用既有 PowerShell 入口 `scripts/build.ps1`，
  Next build + tsup 均通过；未改全项目构建系统。构建会把 `next-env.d.ts` 由 dev 类型路径改写为 build 类型路径，
  属既有生成物行为，提交前已精确还原（`git status` clean）。
- **`scripts/check-classes.ts` → NOT_RUN（基线遗留）**：离线阶段 `503 !== 401`，仍走已移除的
  `TEACHER_PASSCODE` 语义；与来源整合报告 §4.5 记录一致，非本轮引入，未修。
- **RTK.md 缺失**：仅记录；`rtk.exe` 存在不代表该指令文件存在，未创建。
- 真实 provider/搜索/S3/托管库、真实浏览器与聊天 UI、生产部署：NOT_RUN。

## 6. 最小联合检查摘要（`scripts/yaya/check-integration-prep-joint.ts`）

真实层：QA 种子一次性隔离 PG + 对象目录（回读 62 项）→ 真实 AUTH 会话/scoped 读取 →
真实 READ1 registry + 真实 `runYayaAgent`（进程内模型替身，0 provider 请求）→ 真实 API0 线事件编解码与流校验。
覆盖：列表 citable_source 与完整依赖、二次读取后引用早先来源、错引用 `source_mismatch`、
真实空列表 / `empty_scope` / `out_of_scope` / `not_found` 分离、观察内容分层、终态唯一与内容一致、停止详情脱敏。
明确替身边界：模型输出为进程内替身；APP 重核装配为探测替身；成长档案依据重核只在
`check-tools-read` 离线替身（种子无 AI 成长小结）。**本检查不是正式聊天 API，也不是浏览器闭环。**

## 7. 第二波交接（唯一 owner）

| 任务 | 唯一 owner 范围 | 本轮状态 |
|---|---|---|
| **TOOLS1** | `src/lib/yaya/tools/**` 写工具、`/api/yaya/operations` POST、必要既有业务兼容 | 未开始；直接复用 READ1 读取注册表，不重新实现读取 |
| **AGENT-APP1** | `src/lib/yaya/agent/runtime/**`、`/api/yaya/` 运行/查询/取消/事件 API | 未开始；消费 API0 协议 + READ1 来源协议；run 持久化未实现（不得用内存 Map 冒充跨进程恢复）；如需存储扩展由本 owner 列明最小需求再报 |
| **UI1** | `src/components/yaya/**`、助手入口页、`package.json`/`pnpm-lock.yaml` 唯一 owner | 未开始；只消费批准 DTO/协议；视觉选稿是否获批与代码整合分开 |

表单 / Review / 档案附件接入与最终浏览器联测归后续 INTEGRATE1/QA1。本轮到此停止：不合并 main、
不 push、不部署、不启动长期预览，不自行开始 TOOLS1 / AGENT-APP1 / UI1。
