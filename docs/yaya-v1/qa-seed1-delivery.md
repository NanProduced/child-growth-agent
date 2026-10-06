# YAYA-QA-SEED1 交付：可重用浏览器验收数据与场景包

- 任务起点（基线）：`24b0588c07ce68968178660ba7dc1382292e8bdc`
- 工作树/分支：`codex/yaya-qa-seed1`（独立工作树 `child-growth-agent-qa-seed1`）
- 交付提交：`89c3e0c583c002d55fcfc7a4d8ac22b03dacf036`（本文件 SHA 更新为后续文档提交）
- 交付文件（独占范围）：
  - `scripts/yaya/acceptance/types.ts`、`resources.ts`、`media.ts`、`seed.ts`、`verify.ts`、`run.ts`、`README.md`（新）
  - `docs/yaya-v1/browser-acceptance-plan.md`（新）
  - `docs/yaya-v1/qa-seed1-delivery.md`（本文件，新）
- 不修改产品源码：`src/**`、`package.json`、`pnpm-lock.yaml`、`scripts/harness-safety.ts` 均未改动；
  `scripts/harness-safety.ts` blob 仍为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`（`git hash-object` 实测一致）。

## 1. 模块调用方式

```ts
import { createAcceptanceSeed } from "./scripts/yaya/acceptance/seed";

const seed = await createAcceptanceSeed();       // 创建 + 身份核验 + 播种 + 事实回读
seed.manifest;                                    // 数据清单（班级/幼儿/观察/会话/附件/故障夹具 id）
seed.verification;                                // 62 项事实回读结果（失败即抛错并清理）
seed.database_url;                                // 交给被测服务；CLI 不打印
seed.object_root;                                 // MEDIA_LOCAL_ROOT
seed.credentials_path;                            // 账号口令（tmp、0600、teardown 删除）
await seed.teardown();                            // 容器（ID+标签核验）+ 对象目录 + 凭证目录，逐项核验删除
```

- 自检：`pnpm exec tsx scripts/yaya/acceptance/run.ts`（连续两轮完整种子 + 三轮失败注入 + 所有权探针 + 精确残留判定）。
- 只允许自有一次性隔离 PG 与自有对象目录：`createAcceptanceSeed()` 不接受任何数据库 URL 参数；
  进程内若已存在 `globalThis.__pgPool` 直接拒绝，防止混用其他数据库。
- 迁移：`initialize-demo-db.sql`（按 AGENTS 约定截取 `INSERT INTO children` 之前的纯结构）+ `upgrade-classes.sql`
  （截取演示班级插入之前）+ `upgrade-guide-evidence-v1.sql` + `upgrade-auth-v1.sql` + `upgrade-yaya-v1.sql`；
  隔离库中除种子外没有演示数据（回读断言 `is_demo=false` 计数为 0）。
- 复用而非重写：AUTH repository（管理员/教师/任教）、`lib/queries`（观察原文/整理/待补充/归档）、
  guide decisions（指南证据真实写入路径）、`yayaDataRepository`（会话/消息/附件引用/原操作查询）、
  MEDIA 上传管线（sharp + 本地对象存储 + DATA 适配器）、guide read-model（事实回读）。
- 不调用待修回收路径（`retention-service`/`recycleAttachment` 零引用）；不 import 任何带顶层 main 副作用的旧检查脚本。

## 2. 数据清单（seed 提供的验收数据）

| 类别 | 内容 |
|---|---|
| 账号 | 管理员；教师A（松果班+白桦班+故障隔离班）；教师B（云杉班）；未分配教师；另有教师A 对云杉班的已撤销任教历史 |
| 班级 | 松果班/白桦班/云杉班（small，当前学年）+ `[故障夹具] 隔离班` |
| 幼儿 | 同名「王一诺」×2（两班）；共用照片「陈小满/周小满」；可信空数据「赵小树」；转班「郑小舟」（松果班→云杉班）；draft/needs_input/ai_organized 各一名；`[故障夹具]` 两名 |
| 观察 | 14 条：draft/needs_input/ai_organized/confirmed 全覆盖；全部 `is_demo` + 原文 `[合成]` 标记 |
| 指南证据 | 行为 `item.moe.health.physical.1.3-4.2`、持续性 `item.moe.health.physical.2.3-4.1`、保健参考 `item.moe.health.physical.1.3-4.1`、社会行为 `item.moe.social.interpersonal.1.3-4.1`；均由产品 decisions 路径写入，依据逐条可核验，条目与事实语义对照见下表 |
| 媒体 | 1 张 sharp 合成照片（ready、`metadata.synthetic=true`），被两名幼儿两条观察各自引用；对象目录仅 3 个派生对象 |
| 会话 | 教师A 场景会话（full / historical_read_only / hidden 三种片段 + 受限标题）；教师B 私有会话 |
| 故障夹具（单独登记，与正常种子分开） | 容器不可读（→ unavailable）、依据与原文不一致（→ partial）、`saved_detail_unavailable` 回执（原操作查询） |
| 日期派生 | 观察日期全部由当前学期（显式校历）与已保存分班事实派生：转班前观察落在旧归属区间、转班后落在新归属区间；无硬编码“今天”的旧日期 |

### 2.1 正常种子：指南条目 ↔ 事实对照（返修 E）

| 类型 | item_id | 条目文字（节选） | 宿主观察（manifest 键） | 依据片段 | 语义关键词 |
|---|---|---|---|---|---|
| 行为 | `item.moe.health.physical.1.3-4.2` | 在提醒下能自然坐直、站直 | `a1_h1` | 「在老师提醒后能自然坐直、站直」 | 坐直/站直 |
| 持续性 | `item.moe.health.physical.2.3-4.1` | 情绪比较稳定，很少因一点小事哭闹不止 | `a1_h2`（依据 `a1_h2`+`a1_h3` 跨两日） | 「情绪比较稳定，和同伴商量着轮流玩」「情绪依然比较稳定」 | 情绪 |
| 保健参考 | `item.moe.health.physical.1.3-4.1` | 身高和体重适宜 | `a1_h4` | 「身高 102 厘米、体重 17 公斤」 | 身高/体重 |
| 社会行为 | `item.moe.social.interpersonal.1.3-4.1` | 愿意和小朋友一起游戏 | `c1_new` | 「愿意和小朋友一起游戏」 | 小朋友 |

- 结构可核验（`checkBasis`）不等于语义自洽：回读新增逐项对照检查（条目文字包含预期短语、依据片段含语义关键词、
  片段逐字落在对应观察原文中）；**故意不匹配的只保留在故障夹具**（`fault_partial`）。
- 观察草稿的领域/子领域也随事实调整（坐直站直→动作发展；情绪→身心状况；身高体重→身心状况；同伴游戏→社会/人际交往）。

## 3. 场景矩阵

见 `docs/yaya-v1/browser-acceptance-plan.md` 第 2/3 节（主链路 10 步 + 18 类场景，含级别、当前状态、
操作与应检查的 DB/读模型事实）。主链路：登录 → 聊天入口 → 查询 → 选图 → 准备记录 → 人工核对 → 归档 →
证据册引用 → 班级同期聚合 → 下钻；聊天 UI 未实现的部分已逐条标 NOT_RUN。

## 4. 实际运行结果（本轮实测）

命令：`pnpm exec tsx scripts/yaya/acceptance/run.ts`（Windows + Docker Desktop，本地一次性容器）

```json
{
  "ok": true,
  "runs": [
    { "run": 1, "seed_id": "qaseed1-muw9vkcn-73372945", "semester_id": "2026-2027-1", "checks_passed": 62,
      "container_absent": true, "object_root_removed": true, "credentials_removed": true, "label_residual": 0 },
    { "run": 2, "seed_id": "qaseed1-muw9vovd-7a021178", "semester_id": "2026-2027-1", "checks_passed": 62,
      "container_absent": true, "object_root_removed": true, "credentials_removed": true, "label_residual": 0 }
  ],
  "failure_paths": [
    { "stage": "after_resources", "cleanup_ok": true },
    { "stage": "after_schema", "cleanup_ok": true },
    { "stage": "after_seed", "cleanup_ok": true }
  ],
  "ownership_probe": {
    "foreign_same_prefix_preserved": true,
    "unregistered_path_rejected": true,
    "registered_dir_removed_and_retry_ok": true,
    "wrong_seed_id_rejected": true,
    "forced_delete_failure_then_retry": true
  },
  "observed_other_namespace_resources": { "containers": [], "temp_dirs": [] }
}
```

- 每轮 62 项回读全部通过，覆盖：库身份、账号/角色/任教、撤权历史、分班与转班、日期派生（观察落在分班事实内）、
  四种状态、合成标记、指南依据逐条可核验、条目与事实语义对照（4 组）、三类条目读模型、可信空数据/partial/unavailable、
  班级聚合（行为占比、保健参考不显示占比、名单正确）、媒体三对象与 checksum、两幼儿共用照片各自事实、
  消息投影（full/historical_read_only/hidden）、受限标题、账号私有、故障夹具 `saved_detail_unavailable`。
- 两轮种子 id/容器/对象目录互不相同；每轮验证“库内恰好 4 个本轮账号且无演示数据”，证明彼此隔离与可重复。
- 失败路径（资源创建后、schema 后、种子后注入）均 `cleanup_ok=true`。
- 残留判定只针对本轮：每轮按登记的精确容器 ID、`label=yaya.qa-seed1=<seed_id>` 与精确目录核实；
  命名空间内其他合法实例只展示在 `observed_other_namespace_resources`，不计入失败、不清理。
- 所有权探针 5/5：同前缀异 run 目录保留、未登记路径拒绝、登记目录删除与重试、错误 seed_id 拒绝、
  强制删除失败后恢复重试收敛。
- 质量门：`pnpm ts-check`、`pnpm exec eslint scripts/yaya/acceptance --quiet` 通过。

## 5. 清理与凭证

- 正常与失败路径统一走 `runCleanupSteps`：关闭连接池 → 容器（ID+运行标签核验后删除）→ 对象目录 → 凭证目录；
  任一步失败都会作为 issue 上报（不把“已调用清理”当成功），且其余步骤继续执行。
- teardown 只有全部资源删除并核实后才进入完成态；失败保留可重试清理与失败信息，再次调用会重新执行全部步骤
  （已删除资源经核实不存在视为成功）；并发 teardown 共享同一次进行中的清理。
- 准备阶段失败携带结构化清理结果（`AcceptanceResourceError.cleanup_ok/cleanup_issues`），入口层不重算为“已清理”。
- 临时目录所有权 = 创建时登记的本轮精确绝对路径 + seed_id + 用途；仅名字前缀相同的其他实例目录不会被使用或删除。
- 口令/连接串只写 `credentials_path`（本轮 tmp、非仓库、尽力设置 0600——Windows 未验证 ACL 隔离）；
  不打印、不进截图/trace/HAR；teardown 后实测目录不存在。

## 6. NOT_RUN 与已知边界

- 浏览器交互/截图/断点/可访问性；聊天 UI 全流程；HTTP+DB 场景的浏览器执行（接口存在、数据就绪）。
- 真实模型、真实公开检索、S3、托管库、生产部署（本模块 0 请求、0 配置）。
- 本模块自检在 Windows + PowerShell 7 + Docker 上实测；非 Windows 未验证（NOT_RUN）。
- 学期配置无当前学期时（寒暑假间隙）会以明确错误停止，不猜测日期；需在学期内运行或显式调整 `src/lib/semester/config.ts`。
- 故障夹具是刻意构造的异常存储（已标注），只用于降级展示验证，不作为业务闭环证据。
