# scripts/yaya/acceptance —— YAYA-QA-SEED1 可重用浏览器验收种子包

创建 → 身份核验 → 种子初始化 → 事实回读 → 精确 teardown。只使用**本轮自有的一次性隔离
PostgreSQL 容器**（`scripts/harness-safety.ts`，blob 不变）与 **os.tmpdir() 下的自有对象/凭证目录**；
不接受任意外部数据库 URL、不读 `.env`、不连托管库、不调用模型/搜索/S3、不 import 旧检查脚本。

## 文件

| 文件 | 作用 |
|---|---|
| `types.ts` | 共享类型与 `[合成]`/`[故障夹具]` 标记常量 |
| `resources.ts` | 隔离 PG 容器 + 对象/凭证目录 + 身份核验 + 精确清理步骤 |
| `media.ts` | sharp 合成照片（几何图形，无真实幼儿影像） |
| `seed.ts` | `createAcceptanceSeed()`：账号/班级/幼儿/分班/观察/指南证据/媒体/会话消息/故障夹具 |
| `verify.ts` | 62 项事实回读（产品读模型 + repository + 表级 SQL + 条目/事实语义对照） |
| `run.ts` | 自检：两轮完整种子 + 三轮失败注入 + 所有权/重试探针 + 精确残留判定 |

## 用法

```ts
import { createAcceptanceSeed } from "./scripts/yaya/acceptance/seed";

const seed = await createAcceptanceSeed();
try {
  // 被测服务：DATABASE_URL=seed.database_url
  //          MEDIA_LOCAL_ROOT=seed.object_root
  // 账号口令：seed.credentials_path（tmp；不打印、不进截图）
  // 数据标识：seed.manifest
} finally {
  await seed.teardown();
}
```

自检（需要 Docker）：

```powershell
pnpm exec tsx scripts/yaya/acceptance/run.ts
```

输出 JSON：两轮 seed_id、回读通过数、失败注入清理结果、所有权探针、精确残留判定、命名空间内其他实例（仅展示）；
不打印数据库 URL 与口令。

## 安全边界

1. 容器身份 = docker run stdout 容器 ID + 运行标签双重核验；删除前再核验，失败不删也不报成功。
2. 临时目录所有权 = 创建时登记的**本轮精确绝对路径 + seed_id + 用途**（进程内登记表）；
   仅名字前缀相同的其他实例目录不会被使用或删除；未登记路径一律拒绝。
3. 进程内已存在 `globalThis.__pgPool` 时直接拒绝运行，避免混用其他数据库连接池。
4. teardown 只有全部资源删除并核实后才进入完成态；失败保留可重试清理与失败信息，重试重新执行全部步骤；
   准备阶段失败以 `AcceptanceResourceError` 携带结构化清理结果，不重算为“已清理”。
5. 残留判定只针对本轮登记的精确容器 ID / `label=yaya.qa-seed1=<seed_id>` / 精确目录；
   命名空间内其他合法实例只展示、不计失败、不清理。
6. 凭证只落本轮 tmp 目录（尽力 0600；Windows 未验证 ACL 隔离），teardown 删除并核验不存在。

## 数据与场景

数据清单与场景矩阵见 `docs/yaya-v1/browser-acceptance-plan.md`；
本轮实测结果与交付说明见 `docs/yaya-v1/qa-seed1-delivery.md`。
