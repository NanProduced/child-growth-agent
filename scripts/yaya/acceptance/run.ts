/**
 * YAYA-QA-SEED1 模块自检（可重复、彼此隔离、失败路径清理、所有权与残留精确判定）。
 *
 * 运行：pnpm exec tsx scripts/yaya/acceptance/run.ts
 * 行为：
 * 1) 连续两次完整创建 → 事实回读 → teardown，两次种子 id/容器/对象目录必须不同且各自核验通过；
 * 2) 三轮注入失败（资源创建后、schema 后、种子后），断言失败路径同样精确清理自有资源；
 * 3) 所有权探针：同前缀异 run 目录保留、未登记路径拒绝、登记目录清理与重试、错误 seed_id 拒绝、
 *    强制删除失败后恢复重试（模拟 teardown 首败重试）；
 * 4) 只按本轮登记的精确容器 ID / seed_id 标签 / 精确目录判定残留；命名空间内其他合法实例只展示、不计失败、不清理。
 * 只打印检查与资源标识（seed_id/目录名），不打印数据库 URL、口令或连接串。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inspectOwnedContainer, nativeCommand } from "../../harness-safety";
import {
  ACCEPTANCE_LABEL_KEY,
  isTempDirRegistered,
  registerOwnedTempDir,
  removeOwnedTempDir,
} from "./resources";
import { AcceptanceSeedError, createAcceptanceSeed, type SeedFailureStage } from "./seed";

interface RunSummary {
  run: number;
  seed_id: string;
  semester_id: string;
  checks_passed: number;
  container_absent: boolean;
  object_root_removed: boolean;
  credentials_removed: boolean;
  label_residual: number;
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function labelResiduals(seedId: string): string[] {
  const listed = nativeCommand("docker", [
    "ps",
    "-a",
    "--filter",
    `label=${ACCEPTANCE_LABEL_KEY}=${seedId}`,
    "--format",
    "{{.ID}} {{.Names}}",
  ]);
  if (listed.status !== 0) {
    fail(`无法按 seed_id 核验残留容器：${listed.stderr || listed.error || `exit=${listed.status}`}`);
  }
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
      container_absent: false,
      object_root_removed: false,
      credentials_removed: false,
      label_residual: -1,
    };
    await handle.teardown();
    const inspection = inspectOwnedContainer(handle.container_id, ACCEPTANCE_LABEL_KEY);
    if (inspection.state === "unverifiable") {
      fail(`第 ${run} 轮无法核实容器 ${handle.container_id} 是否已删除：${inspection.detail}`);
    }
    summary.container_absent = inspection.state === "absent";
    summary.object_root_removed = !fs.existsSync(handle.object_root);
    summary.credentials_removed = !fs.existsSync(credentialsDir);
    summary.label_residual = labelResiduals(handle.seed_id).length;
    if (!summary.container_absent || !summary.object_root_removed || !summary.credentials_removed) {
      fail(`第 ${run} 轮 teardown 后仍有本轮资源残留`);
    }
    if (summary.label_residual !== 0) fail(`第 ${run} 轮仍有带本轮 seed_id 标签的容器`);
    if (handle.verification.failed !== 0) fail(`第 ${run} 轮事实回读存在失败项`);
    return summary;
  } catch (error) {
    // 即使断言失败，也必须先精确清理本轮资源再退出（teardown 可重试）。
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

interface OwnershipProbe {
  foreign_same_prefix_preserved: boolean;
  unregistered_path_rejected: boolean;
  registered_dir_removed_and_retry_ok: boolean;
  wrong_seed_id_rejected: boolean;
  forced_delete_failure_then_retry: boolean;
}

/** 所有权/重试探针：只操作本探针自建的目录，不触碰他方资源 */
function ownershipProbe(): OwnershipProbe {
  const probeSeed = `qaseed1-probe-${Date.now().toString(36)}`;
  const probeDirs: string[] = [];
  try {
    // 1) 同前缀但未登记（模拟其他 run）→ 拒绝删除且保留
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "yaya-qa-seed1-objects-"));
    probeDirs.push(foreign);
    const foreignRemoval = removeOwnedTempDir(foreign, "objects", probeSeed);
    const foreignPreserved = !foreignRemoval.ok && fs.existsSync(foreign);

    // 2) 未登记路径 → 拒绝
    const unregistered = fs.mkdtempSync(path.join(os.tmpdir(), "yaya-qa-seed1-secrets-"));
    probeDirs.push(unregistered);
    const unregisteredRemoval = removeOwnedTempDir(unregistered, "secrets", probeSeed);
    const unregisteredRejected = !unregisteredRemoval.ok && fs.existsSync(unregistered);

    // 3) 正常登记目录 → 删除成功，再次调用（重试）核实不存在仍为成功
    const own = registerOwnedTempDir("objects", probeSeed);
    const first = removeOwnedTempDir(own, "objects", probeSeed);
    const second = removeOwnedTempDir(own, "objects", probeSeed);
    const ownOk = first.ok && second.ok && !fs.existsSync(own) && isTempDirRegistered(own, "objects", probeSeed);

    // 4) 登记身份不符（知道路径也不够）→ 拒绝
    const wrongSeedDir = registerOwnedTempDir("secrets", probeSeed);
    const wrongRemoval = removeOwnedTempDir(wrongSeedDir, "secrets", `${probeSeed}-other`);
    const wrongRejected = !wrongRemoval.ok && fs.existsSync(wrongSeedDir);
    removeOwnedTempDir(wrongSeedDir, "secrets", probeSeed);

    // 5) 强制删除失败 → 非成功且保留；恢复后重试 → 最终删除（模拟 teardown 首败后重试）
    const faultDir = registerOwnedTempDir("objects", probeSeed);
    const originalRm = fs.rmSync;
    let forcedFailureReport = { ok: true, detail: "" };
    try {
      fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
        if (path.resolve(String(target)) === path.resolve(faultDir)) {
          throw new Error("probe: forced rm failure");
        }
        return originalRm(target, options);
      }) as typeof fs.rmSync;
      forcedFailureReport = removeOwnedTempDir(faultDir, "objects", probeSeed);
    } finally {
      fs.rmSync = originalRm;
    }
    const forcedRetry = removeOwnedTempDir(faultDir, "objects", probeSeed);
    const forcedOk = !forcedFailureReport.ok && forcedRetry.ok && !fs.existsSync(faultDir);

    return {
      foreign_same_prefix_preserved: foreignPreserved,
      unregistered_path_rejected: unregisteredRejected,
      registered_dir_removed_and_retry_ok: ownOk,
      wrong_seed_id_rejected: wrongRejected,
      forced_delete_failure_then_retry: forcedOk,
    };
  } finally {
    // 探针自建目录全部按精确路径回收（这些目录不进入正式登记流程的断言）
    for (const dir of probeDirs) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function namespaceObservation(): { containers: string[]; temp_dirs: string[] } {
  const containers: string[] = [];
  const listed = nativeCommand("docker", [
    "ps",
    "-a",
    "--filter",
    `label=${ACCEPTANCE_LABEL_KEY}`,
    "--format",
    "{{.ID}} {{.Names}} {{.Label \"yaya.qa-seed1\"}}",
  ]);
  if (listed.status !== 0) {
    fail(`无法读取命名空间容器（只用于展示）：${listed.stderr || listed.error || `exit=${listed.status}`}`);
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

  const ownership = ownershipProbe();
  if (!ownership.foreign_same_prefix_preserved) fail("所有权探针：同前缀异 run 目录被删除");
  if (!ownership.unregistered_path_rejected) fail("所有权探针：未登记路径未被拒绝");
  if (!ownership.registered_dir_removed_and_retry_ok) fail("所有权探针：登记目录删除/重试失败");
  if (!ownership.wrong_seed_id_rejected) fail("所有权探针：错误 seed_id 未被拒绝");
  if (!ownership.forced_delete_failure_then_retry) fail("所有权探针：强制删除失败后重试未收敛");

  // 命名空间观察仅展示他方资源，不计入本轮失败、不清理。
  const namespace = namespaceObservation();

  const report = {
    ok: true,
    module: "scripts/yaya/acceptance",
    runs,
    failure_paths: failurePaths,
    ownership_probe: ownership,
    observed_other_namespace_resources: namespace,
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
