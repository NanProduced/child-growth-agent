# 指南证据链 G0～G4 候选整合与组合验收记录（G-INT1）

- 状态：**候选整合完成，所列组合检查通过**。仅证明 G1～G4 可组合，不证明指南证据业务闭环完成，不代表可部署。
- 范围：四个已获批分支的整合、编译与静态检查、指南目录与契约检查、G2 隔离实库验收、G3/G4 fixture 离线检查与真实浏览器验收、既有安全回归。
- 本轮未开发 G5/G6；未接正式个人证据册或班级聚合页；未合回 main、未 push、未部署。

## 1. 基线与获批提交

| 项 | 值 |
|---|---|
| 共同基线（main HEAD） | `b39df279672d566994810e8419cb210a4d26ffb1` |
| G1 获批 HEAD（`codex/g1-guide-catalog`） | `ec9586c8ac0287fdb4b7f8850e28fa655df19275` |
| G2 获批 HEAD（`codex/g2-history-semester`） | `462f77232e1a07354076d9a331f58ecb7f92682b` |
| G3 获批 HEAD（`codex/g3-child-evidence-ui`） | `91f548d0dba4f9f2d45080c75d4375c29ee1d12c` |
| G4 获批 HEAD（`codex/g4-class-evidence-ui`） | `571e0ec7a7291951a4e0b811d558f8182dee67d1` |
| 候选分支 | `codex/guide-evidence-integration` |
| 候选工作树 | `C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-integration` |
| 候选最终 HEAD | `19c57309fb152b700635a2152f5ddb874be05ae4` |

合并顺序与合并提交（普通 `--no-ff` 合并，保留来源历史，未 rebase、未 squash）：

| 步骤 | 来源 | 合并提交 |
|---|---|---|
| G1 | `ec9586c` | `79a1ca0eb0fa685bbd15a30fc88bd242ecbf5b96` |
| G2 | `462f772` | `eacb43f76f7af732f33da051584effac2c30529f` |
| G3 | `91f548d` | `e10a0bb3f73a1de0011e10af3a40f1d76e255561` |
| G4 | `571e0ec` | `19c57309fb152b700635a2152f5ddb874be05ae4` |

## 2. 前置核验结果

- 执行前核实 main HEAD 即共同基线；四个分支引用与获批 SHA 逐一相等（无提交漂移）。
- 四个来源工作树注册路径与预期一致（`Temp/opencode/child-growth-g1..g4`），`git status --porcelain` 均为空（无未提交内容）。
- `git merge-base --is-ancestor <baseline> <sha>` 对四个 SHA 均退出 0：基线是四者的共同祖先。
- 各分支相对基线的修改路径已列出并比对：**无任何路径重叠**（G1 目录数据/查询；G2 历史、学期、schema、观察创建路径；G3 个人证据册组件与装置；G4 班级证据概览组件与装置）。
- main 工作树中的未跟踪设计资料、插图与文档（`.impeccable/**`、`docs/design/**`、`public/assets/illustrations/**` 等）未纳入候选，保持原位未动。
- `RTK.md` 不存在，按约定仅记录，未创建、未安装。
- 四个来源工作树与 main 在本轮全程未被写入或清理。

## 3. 内容核对

- 四个获批 SHA 均为候选 HEAD 祖先（逐项 `merge-base --is-ancestor` 退出 0）。
- 对每个分支：`git diff <获批 SHA> <候选 HEAD> -- <该分支修改文件>` 均为空，候选内各分支所属文件与获批来源版本**逐字节一致**。
- G0 冻结文件相对基线无差异：`src/lib/guide/types.ts`、`src/lib/guide/view-types.ts`、`docs/guide-evidence-v1/contract.md`、`src/lib/guide/__fixtures__/contract-fixtures.ts`、`scripts/check-guide-contract.ts`。
- 候选相对基线的差异文件清单恰为四分支并集；`package.json`、`pnpm-lock.yaml`、`.env`/`.env.example`、`next-env.d.ts`、`.gitignore` 均未进入差异。
- 整合过程无冲突，**未发生任何额外适配、重构或视觉调整**；无额外提交（除本记录）。

## 4. 组合验收结果

所有命令在候选工作树内执行。`pnpm validate` 的 lint-tsc / lint-build / lint-style 三项均退出 0。

| 检查 | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 静态检查 | `pnpm validate` | ts-check + eslint + stylelint 全部通过 | 0 |
| 生产构建 | `pnpm build` | Next.js 16.1.1 编译成功；tsup 打包成功 | 0 |
| 契约检查 | `pnpm tsx scripts/check-guide-contract.ts` | `{passed:19,total:19,reference_only:true}` | 0 |
| 目录检查 | `pnpm tsx scripts/check-guide-catalog.ts` | 11/11；5 领域 / 11 子领域 / 32 目标 / 317 条目 / 87 教育建议；版本 `moe-3-6-2012.v1`；health_reference=3、sustained=27、requires_independence=20 | 0 |
| G2 隔离实库 | `pnpm tsx scripts/check-history-semester.ts` | 33/33；迁移幂等、旧 NULL、历史归属、快照前提、双连接交错、失败清理均通过 | 0 |
| G3 fixture 离线 | `pnpm tsx scripts/check-child-evidence-book-fixtures.ts` | `{passed:63,total:63,fixture_only:true}` | 0 |
| G4 fixture 离线 | `pnpm tsx scripts/check-class-evidence-overview.ts` | `{passed:42,total:42,fixture_only:true}` | 0 |
| G3 浏览器 | `node scripts/check-child-evidence-book-browser.cjs <证据目录>`（`G3_PORT=3210`） | 127/127 | 0 |
| G4 浏览器 | `pwsh -NoProfile -File scripts/acceptance/run-class-evidence-ui-check.ps1 -Port 3211 ...` | 115/115 | 0 |
| 浏览器后类型检查 | `pnpm ts-check` | 通过 | 0 |
| 回归：agent-flow | `pnpm tsx scripts/check-agent-flow.ts` | 30/30 | 0 |
| 回归：organize-retry | `pnpm tsx scripts/check-organize-retry.ts` | 9/9 | 0 |
| 回归：growth-profile | `pnpm tsx scripts/check-growth-profile.ts` | 13/13 | 0 |
| 回归：activity-support | `pnpm tsx scripts/check-activity-support.ts` | 19/19 | 0 |
| 回归：teacher-clarify | `pnpm tsx scripts/check-teacher-clarify.ts` | 13/13 | 0 |
| 回归：save-consistency | `pnpm tsx scripts/check-save-consistency.ts` | 24/24 | 0 |
| 回归：class-reports-pages | `pnpm tsx scripts/check-class-reports-pages.ts` | 11/11 | 0 |
| 回归：homepage-map | `pnpm tsx scripts/check-homepage-map.ts` | 通过（无计数输出） | 0 |

说明：

- 指南目录的 5/11/32/317/87 与三类产品规则计数为**产品规则分类**，不宣称官方规定了证据判定算法。
- 构建产物处理：生产构建曾将 `next-env.d.ts` 由 `.next/dev/types/routes.d.ts` 翻转为 `.next/types/routes.d.ts`（生成物，非业务改动）；后续浏览器装置快照/恢复后该文件已回到提交状态，最终 `git status` 干净。未覆盖任何运行前已有改动。
- 环境注记：首次 `pnpm build` 因 PATH 中 `bash` 解析到 WSL bash 而失败（`set -o pipefail` 报错），改用 Git Bash 后原样重跑成功；非代码问题。

### 浏览器验收口径覆盖

- G3 127/127：1440×900 / 768×1024 / 390×844 无横向溢出、核心目标 ≥44px；键盘 Enter/焦点流转；期间草稿与受控切换；领域/参考年龄/目标筛选与解除；reliable/partial/unavailable 语义；保健参考不渲染行为确认徽章与占比；待核对不计入正式状态；下钻意图保留期间与筛选参数；减少动态；长文本与窄屏。
- G4 115/115：三断点同口径；班级分母与统计期间；可靠条目完整三类分布与占比（含分母与期间）；partial 仅可核验依据摘要、占比 null；unavailable 保留名单分母且不冒充“暂无”；保健参考（reliable/partial/pending/unavailable 各场景）无行为分布、无占比、无达成式徽章；受限名单与普通名单分组；待核对不计入；期间草稿、自定义区间与父级拒绝；下钻携带已应用期间与筛选；空名单；减少动态。

浏览器证据目录（保留在 Temp，供主评审）：

- G3：`C:\Users\nanpr\AppData\Local\Temp\opencode\integration-g3-evidence`（`results.json` + 7 张截图）
- G4：`C:\Users\nanpr\AppData\Local\Temp\opencode\integration-g4-evidence`（`results.json`、`acceptance-run.json`、`dev-*.log` + 13 张截图）

### 隔离数据库身份与清理

- G2 实库使用一次性本地 Docker Postgres：`disposable-local-postgres (identity-verified before DDL)`；唯一运行标记 `19zomusiql1e`，容器 `95dfcd1163b3`。
- 清理仅按已核实容器 ID + 标签所有权校验执行并验证结果；`external_url_mode: removed`（不回退任何未知库）；既有反例容器保留（`decoy_container_preserved: true`，normal/fault 两条路径均验证）。
- 运行后复查：无 `cga-hist-*` 容器残留、无 `cga-history-check` 标签残留；与本次无关的既有容器（`zzsh-*`，Up 2 days）未被触碰。
- 未连接 `.env` 指向的托管库；未输出连接串或口令。

### 进程、路由与生成物清理

- G3 浏览器装置：临时路由 `src/app/guide-preview` 已删除，3210 端口释放，引用该路由的类型生成物已清理。
- G4 装置审计（`acceptance-run.json`）：`route_cleaned: true`、`server_cleaned: true`、`check_exit: 0`；3211 端口释放；`next-env.d.ts` 与类型生成物按快照恢复。
- 两装置串行执行，使用不同且启动前核验为空闲的端口；未关闭任何已有服务，未按端口杀进程。

## 5. NOT_RUN 与遗留风险

- **NOT_RUN**：G5 证据关联/决策/运行时校验/读模型与 API；G6 正式页面装配、URL 状态与真实业务链路；真实 StepFun/Coze 调用（预算耗尽，未调用、未重置）；托管库迁移、线上读写与部署。
- **NOT_RUN（测试安全债务）**：`scripts/check-classes.ts` 仍含固定名删除与外部 URL 测试装置，本轮**未运行、未返工**；不得据此声称班级全量回归通过。应作为独立任务先修复其资源安全，再纳入回归。
- 浏览器装置为 fixture/拦截验收，只证明 UI 状态与口径，不等价于真实数据库或模型全链路验收。
- `pnpm validate` / 各检查通过不等于功能可用；G5/G6 仍需按契约完成实现与端到端验收。

## 6. G5/G6 接入说明

- G5 可直接基于候选 HEAD 接入：目录查询（G1 `src/lib/guide/catalog.ts`）、班级快照与学期（G2 `src/lib/class-context.ts`、`src/lib/semester/`）、两个 JSONB 列与迁移 SQL 已就位且经隔离实库验证。
- G5 需实现契约冻结的 `getChildEvidenceBook` / `getClassEvidenceOverview`、`POST /api/observations/[id]/guide-evidence` 与观察确认扩展，运行时校验以 G0 契约为准。
- G3/G4 组件按 DTO fixture 验收完毕，G6 装配时应复用同一 DTO；页面 URL 状态与筛选参数传递需保留组件已验收的下钻意图语义（期间 + 筛选）。
- 本候选工作树保留供主评审；未经主评审不合并回 main、不 push、不部署、不清理。
