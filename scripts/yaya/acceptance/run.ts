/**
 * YAYA-QA-SEED1 模块自检（可重复、彼此隔离、失败路径清理）。
 *
 * 运行：pnpm exec tsx scripts/yaya/acceptance/run.ts
 * 行为：
 * 1) 连续两次完整创建 → 事实回读 → teardown，两次种子 id/容器/对象目录必须不同且各自核验通过；
 * 2) 两次注入失败（schema 后、种子后），断言失败路径同样精确清理自有资源；
 * 3) 结束时断言没有任何带本轮标签的残留容器、没有任何 yaya-qa-seed1-* 临时目录。
 * 只打印检查与资源标识（seed_id/目录名），不打印数据库 URL、口令或连接串。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { nativeCommand } from "../../harness-safety";
import { createAcceptanceSeed, AcceptanceSeedError, type SeedFailureStage } from "./seed";

interface RunSummary {
  run: number;
  seed_id: string;
  semester_id: string;
  checks_passed: number;
  object_root_removed: boolean;
  credentials_removed: boolean;
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function fullRun(run: number): Promise<RunSummary> {
  const handle = await createAcceptanceSeed();
  const credentialsDir = path.dirname(handle.credentials_path);
  try {
    const summary: RunSummary = {
      run,
      seed_id: handle.seed_id,
      semester_id: handle.manifest.semester.id,
      checks_passed: handle.verification.passed,
      object_root_removed: false,
      credentials_removed: false,
    };
    await handle.teardown();
    summary.object_root_removed = !fs.existsSync(handle.object_root);
    summary.credentials_removed = !fs.existsSync(credentialsDir);
    if (!summary.object_root_removed || !summary.credentials_removed) {
      fail(`第 ${run} 轮 teardown 后仍有临时目录残留`);
    }
    if (handle.verification.failed !== 0) fail(`第 ${run} 轮事实回读存在失败项`);
    return summary;
  } catch (error) {
    // 即使断言失败，也必须先精确清理本轮资源再退出。
    await handle.teardown().catch(() => undefined);
    throw error;
  }
}

async function failureRun(stage: SeedFailureStage): Promise<{ stage: SeedFailureStage; cleanup_ok: boolean }> {
  try {
    await createAcceptanceSeed({ failAt: stage });
    fail(`注入失败 ${stage} 未生效`);
  } catch (error) {
    if (!(error instanceof AcceptanceSeedError)) throw error;
    if (!error.cleanup_ok) {
      fail(`注入失败 ${stage} 的清理未完成：${error.cleanup_issues.join("；")}`);
    }
    return { stage, cleanup_ok: error.cleanup_ok };
  }
}

function residualReport(): { containers: string[]; temp_dirs: string[] } {
  const containers: string[] = [];
  const listed = nativeCommand("docker", [
    "ps",
    "-a",
    "--filter",
    "label=yaya.qa-seed1",
    "--format",
    "{{.ID}} {{.Names}}",
  ]);
  if (listed.status !== 0) {
    fail(`无法核对残留容器：${listed.stderr || listed.error || `exit=${listed.status}`}`);
  }
  for (const line of listed.stdout.split("\n")) {
    if (line.trim()) containers.push(line.trim());
  }
  const tempDirs = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("yaya-qa-seed1-"));
  return { containers, temp_dirs: tempDirs };
}

async function main(): Promise<void> {
  const runs: RunSummary[] = [];
  runs.push(await fullRun(1));
  runs.push(await fullRun(2));
  if (runs[0]?.seed_id === runs[1]?.seed_id) fail("两轮种子 id 相同：未隔离");

  const failurePaths = [
    await failureRun("after_resources"),
    await failureRun("after_schema"),
    await failureRun("after_seed"),
  ];

  const residual = residualReport();
  if (residual.containers.length > 0) fail(`存在残留容器：${residual.containers.join(", ")}`);
  if (residual.temp_dirs.length > 0) fail(`存在残留临时目录：${residual.temp_dirs.join(", ")}`);

  const report = {
    ok: true,
    module: "scripts/yaya/acceptance",
    runs,
    failure_paths: failurePaths,
    residual_containers: residual.containers.length,
    residual_temp_dirs: residual.temp_dirs.length,
    not_run: [
      "浏览器交互与截图（本任务只交付数据与计划）",
      "聊天 UI / 聊天查询 / 聊天选图（当前基线未实现聊天界面）",
      "真实模型 / 真实搜索 / S3 / 托管库（0 次请求，未配置出口）",
      "HTTP+DB 场景执行（计划文档已列出，留待浏览器联测轮）",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
