import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCleanupComplete,
  defaultProcessProbe,
  inspectOwnedContainer,
  modelGuardEnv,
  nativeCommand,
  parseContainerIdFromStdout,
  removeOwnedContainer,
  restoreGeneratedArtifacts,
  runCleanupSteps,
  snapshotGeneratedArtifacts,
  startIsolatedPostgres,
  startModelRequestGuard,
  stopTrackedChildTree,
  trackChildProcess,
  waitForChildExit,
  waitForVerifiedService,
  type ArtifactFs,
  type ChildExit,
  type CleanupReport,
  type CommandResult,
  type CommandRunner,
  type ProcessProbe,
  type TrackedChild,
} from "./harness-safety";

/**
 * G5 装置安全专属检查（先反例后修复；离线为主，Docker 实测可选）。
 *
 * 覆盖：
 * - A 就绪身份：外部占位 200 / 子进程立即退出 / 端口竞争 / 正常本轮服务 / 核验中途失败；
 * - B 进程清理：正常结束 / 已退出不强杀 / taskkill 失败 / 创建身份无法核实 / 拒绝强杀 / 残留后代 / 多步清理互不跳过 /
 *   根消失但已知后代存活 / 已知后代身份无法核实 / PID 复用不误杀 / 失败报告 → 非零退出闸门（B8–B13，内存替身）；
 * - C Docker 三态：daemon 不可用 / rm 失败后也不可用 / 明确不存在 / 标签不匹配 / 合法自有容器删除；
 * - D 生成物快照恢复：读取失败 fail-fast / 枚举失败 / 恢复阶段读取失败 / 明确不存在与新文件清理 / 精确恢复
 *   （D3 真实临时目录，D4–D11 内存替身，不改动真实配置）；
 * - E 模型守门计数；F 实库装置接线（禁止回到旧不安全模式，快照先于服务/数据库）；
 * - L Docker 实测：异标签容器保留、本轮容器清理、启动失败路径清理、既有容器不受影响。
 *
 * 运行：pnpm tsx scripts/check-guide-evidence-harness-safety.ts
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptDir, "..");
const DB_CHECK_FILE = path.join(scriptDir, "check-guide-evidence-db.ts");
const LABEL_KEY = "cga-g5-check";
const OFFLINE_RUN = "qa1offline01";
const OWN_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);

let passed = 0;
let failed = 0;
let currentSection = "F";
const sectionCounts: Record<string, number> = {};
const failures: string[] = [];
const cleanupSteps: { label: string; run: () => void | CleanupReport | Promise<void | CleanupReport> }[] =
  [];

function ok(condition: boolean, message: string): void {
  assert.ok(condition, message);
  passed += 1;
  sectionCounts[currentSection] = (sectionCounts[currentSection] ?? 0) + 1;
}

function eq<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message);
  passed += 1;
  sectionCounts[currentSection] = (sectionCounts[currentSection] ?? 0) + 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${label}`);
  } catch (error) {
    failed += 1;
    const message = messageOf(error);
    failures.push(`${label}: ${message}`);
    console.log(`FAIL ${label}: ${message}`);
  }
}

function registerCleanup(label: string, run: () => void | CleanupReport | Promise<void | CleanupReport>) {
  cleanupSteps.push({ label, run });
}

/* ------------------------------ A 通用辅助 ------------------------------ */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配回环端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

interface PlaceholderServer {
  base: string;
  port: number;
  readHits: () => number;
  writeHits: () => number;
  close: () => Promise<void>;
}

async function startPlaceholder(): Promise<PlaceholderServer> {
  let readHits = 0;
  let writeHits = 0;
  const server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse) => {
    if (request.method === "POST") writeHits += 1;
    else readHits += 1;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("占位服务启动失败");
  return {
    base: `http://127.0.0.1:${address.port}`,
    port: address.port,
    readHits: () => readHits,
    writeHits: () => writeHits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const CHILD_SLEEPER = "setInterval(() => {}, 1000);";
const CHILD_EXIT = "process.exit(0);";
const CHILD_LISTENER =
  'const http=require("node:http");const port=Number(process.env.PROBE_PORT);' +
  'http.createServer((req,res)=>{res.statusCode=200;res.setHeader("content-type","application/json");res.end("{}");})' +
  '.listen(port,"127.0.0.1");';
const CHILD_LISTENER_FAIL =
  'const http=require("node:http");const port=Number(process.env.PROBE_PORT);' +
  'const s=http.createServer();s.on("error",()=>process.exit(2));s.listen(port,"127.0.0.1");';

function spawnProbeChild(code: string, env: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ["-e", code], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ...env },
  });
}

async function expectRejection(promise: Promise<unknown>, message: string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(messageOf(error));
  }
  throw new Error(message);
}

/* ------------------------------ C 假 Docker 运行器 ------------------------------ */

interface FakeCall {
  file: string;
  args: string[];
}

function queuedRunner(responses: CommandResult[]): { run: CommandRunner; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const queue = [...responses];
  const run: CommandRunner = (file, args) => {
    calls.push({ file, args });
    const next = queue.shift();
    if (!next) throw new Error(`意外的外部命令调用：${file} ${args.join(" ")}`);
    return next;
  };
  return { run, calls };
}

function dockerResult(status: number, stdout = "", stderr = ""): CommandResult {
  return { status, stdout, stderr };
}

function inspectJson(id: string, labels: Record<string, string> = {}): CommandResult {
  return { status: 0, stdout: JSON.stringify({ Id: id, Config: { Labels: labels } }), stderr: "" };
}

const DAEMON_DOWN = dockerResult(
  1,
  "",
  "error during connect: open //./pipe/docker_engine: The system cannot find the file specified.",
);
const notFound = (target: string) => dockerResult(1, "", `Error: No such object: ${target}`);
const REMOVAL_FAIL = dockerResult(1, "", "Error response from daemon: container is running");
const removalOk = (id: string) => dockerResult(0, id);

function removalOptions(run: CommandRunner) {
  return { fallbackName: "cga-g5-qa1-offline", runId: OFFLINE_RUN, labelKey: LABEL_KEY, run };
}

/* ------------------------------ F 实库装置接线 ------------------------------ */

async function runWiringChecks(): Promise<void> {
  currentSection = "F";
  await check("F1 check-guide-evidence-db.ts 使用共享安全原语", () => {
    const source = fs.readFileSync(DB_CHECK_FILE, "utf8");
    ok(source.includes('from "./harness-safety"'), "必须从 harness-safety 引入安全原语");
    for (const symbol of [
      "startIsolatedPostgres",
      "waitForVerifiedService",
      "stopTrackedChildTree",
      "runCleanupSteps",
      "startModelRequestGuard",
      "snapshotGeneratedArtifacts",
    ]) {
      ok(source.includes(symbol), `实库装置必须使用 ${symbol}`);
    }
  });
  await check("F2 实库装置不保留旧的不安全模式", () => {
    const source = fs.readFileSync(DB_CHECK_FILE, "utf8");
    ok(!/containerIdOf/.test(source), "不再存在把 inspect 失败当不存在的 containerIdOf");
    ok(!/server\.killed/.test(source), "不再用 server.killed 推断进程存活");
    ok(!/spawnSync\(\s*"taskkill"/.test(source), "不再直接 taskkill，必须走 stopTrackedChildTree");
    ok(source.includes("assertCleanupComplete(cleanupIssues)"), "清理问题必须走共享闸门并非零退出");
  });
  await check("F3 实库装置消费失败报告：快照 fail-fast、恢复问题、清理闸门", () => {
    const source = fs.readFileSync(DB_CHECK_FILE, "utf8");
    const snapshotIndex = source.indexOf("snapshotGeneratedArtifacts(ROOT)");
    const guardIndex = source.indexOf("startModelRequestGuard()");
    const databaseIndex = source.indexOf("startIsolatedPostgres({");
    ok(snapshotIndex >= 0 && guardIndex >= 0 && databaseIndex >= 0, "关键调用均存在");
    ok(
      snapshotIndex < guardIndex && snapshotIndex < databaseIndex,
      "快照先于守门/数据库：快照失败即 fail-fast，不启动服务或数据库",
    );
    ok(source.includes("artifactReport.issues.length > 0"), "生成物恢复问题转为非成功报告");
    ok(source.includes("httpAudit.stop = report"), "进程树清理报告被主装置记录消费");
    ok(source.includes("assertCleanupComplete(cleanupIssues)"), "主装置最终闸门会非零退出");
    ok(
      /process\.exitCode\s*=\s*1/.test(source),
      "main 顶层 catch 设置非零退出码",
    );
  });
}

/* ------------------------------ A 就绪身份 ------------------------------ */

async function runReadinessChecks(): Promise<void> {
  currentSection = "A";
  await check("A1 外部占位服务返回 200：身份核验拒绝，占位零业务写入", async () => {
    const placeholder = await startPlaceholder();
    registerCleanup("A1-placeholder", () => placeholder.close());
    const child = trackChildProcess(spawnProbeChild(CHILD_SLEEPER));
    registerCleanup("A1-child", () => stopTrackedChildTree(child));
    const error = await expectRejection(
      waitForVerifiedService({
        base: placeholder.base,
        port: placeholder.port,
        child,
        timeoutMs: 5000,
        pollMs: 200,
      }),
      "占位 200 不应通过就绪核验",
    );
    ok(/身份无法核验|非本轮/.test(error.message), `拒绝原因应指向身份：${error.message}`);
    eq(placeholder.writeHits(), 0, "占位服务收到 0 个业务写请求");
    ok(placeholder.readHits() > 0, "拒绝前确实探测过占位服务的状态接口");
    ok(!child.exit, "身份拒绝后子进程仍由测试负责清理，未被按端口强杀");
  });

  await check("A2 本轮子进程立即退出：不得凭占位 200 继续", async () => {
    const placeholder = await startPlaceholder();
    registerCleanup("A2-placeholder", () => placeholder.close());
    const child = trackChildProcess(spawnProbeChild(CHILD_EXIT));
    await waitForChildExit(child, 5000);
    const error = await expectRejection(
      waitForVerifiedService({
        base: placeholder.base,
        port: placeholder.port,
        child,
        timeoutMs: 3000,
        pollMs: 200,
      }),
      "子进程退出后不应就绪",
    );
    ok(/已退出/.test(error.message), `错误应说明本轮服务已退出：${error.message}`);
    eq(placeholder.writeHits(), 0, "占位服务收到 0 个业务写请求");
  });

  await check("A3 端口竞争：本轮监听失败即失败，不误认占位服务", async () => {
    const placeholder = await startPlaceholder();
    registerCleanup("A3-placeholder", () => placeholder.close());
    const child = trackChildProcess(
      spawnProbeChild(CHILD_LISTENER_FAIL, { PROBE_PORT: String(placeholder.port) }),
    );
    registerCleanup("A3-child", () => stopTrackedChildTree(child));
    const error = await expectRejection(
      waitForVerifiedService({
        base: placeholder.base,
        port: placeholder.port,
        child,
        timeoutMs: 5000,
        pollMs: 200,
      }),
      "端口竞争时不应就绪",
    );
    ok(error.message.length > 0, "端口竞争必须给出明确失败原因");
    eq(placeholder.writeHits(), 0, "占位服务收到 0 个业务写请求");
    const stillAlive = await fetch(`${placeholder.base}/api/auth/status`);
    eq(stillAlive.status, 200, "占位服务保持存活且未被装置关闭");
  });

  await check("A4 正常本轮服务：身份核验通过，业务写请求到达正确服务", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = trackChildProcess(spawnProbeChild(CHILD_LISTENER, { PROBE_PORT: String(port) }));
    registerCleanup("A4-child", () => stopTrackedChildTree(child));
    const ready = await waitForVerifiedService({ base, port, child, timeoutMs: 10_000, pollMs: 200 });
    ok(ready.ownerPids.length >= 1, "监听者归属本轮子进程树");
    ok(ready.ownerPids.includes(child.pid), "直接子进程就是监听者");
    const write = await fetch(`${base}/api/observations/f5200000-0000-4000-8000-000000000004/guide-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "withdraw" }),
    });
    eq(write.status, 200, "正常服务收到业务写请求");
  });

  await check("A5 身份核验中途失败：立即失败且不继续", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = trackChildProcess(spawnProbeChild(CHILD_LISTENER, { PROBE_PORT: String(port) }));
    registerCleanup("A5-child", () => stopTrackedChildTree(child));
    const brokenProbe: ProcessProbe = { ...defaultProcessProbe, parentMap: () => null };
    const error = await expectRejection(
      waitForVerifiedService({ base, port, child, timeoutMs: 5000, pollMs: 200, probe: brokenProbe }),
      "父子关系不可读时不应就绪",
    );
    ok(/父子关系/.test(error.message), `错误应说明身份不可核实：${error.message}`);
    eq(child.exit, null, "核验失败时子进程未被强杀（仍在运行）");
  });
}

/* ------------------------------ B 进程清理 ------------------------------ */

interface FakeProcessState {
  alive: Set<number>;
  created: Map<number, string | null>;
  parents: Map<number, number>;
}

function fakeProbe(state: FakeProcessState): ProcessProbe {
  return {
    creationTime: (pid) => (state.alive.has(pid) ? state.created.get(pid) ?? null : null),
    isAlive: (pid) => state.alive.has(pid),
    parentMap: () => new Map(state.parents),
  };
}

function fakeTrackedChild(
  pid: number,
  startedAt: string | null,
  exit: ChildExit | null = null,
): TrackedChild {
  return {
    pid,
    proc: {} as unknown as ChildProcess,
    startedAt,
    spawnError: null,
    exit,
    logFile: null,
  } as TrackedChild;
}

function expectPid(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`终止命令目标错误：期望 ${expected}，实际 ${actual}`);
  }
}

async function runProcessCleanupChecks(): Promise<void> {
  currentSection = "B";
  await check("B1 正常结束：按 PID + 创建身份终止本轮进程树", async () => {
    const child = trackChildProcess(spawnProbeChild(CHILD_SLEEPER));
    eq(typeof child.startedAt, "string", "启动时记录了创建身份");
    const report = await stopTrackedChildTree(child);
    ok(report.ok, report.detail);
    ok(!defaultProcessProbe.isAlive(child.pid), "进程树已终止");
  });

  await check("B2 子进程已经退出：不得按旧 PID 强杀", async () => {
    const child = trackChildProcess(spawnProbeChild(CHILD_EXIT));
    await waitForChildExit(child, 5000);
    let killCalls = 0;
    const report = await stopTrackedChildTree(child, {
      kill: () => {
        killCalls += 1;
        return dockerResult(1, "", "should not be called");
      },
    });
    ok(report.ok, report.detail);
    eq(killCalls, 0, "已退出进程不执行强杀");
    ok(/已退出/.test(report.detail), `报告应说明已退出：${report.detail}`);
  });

  await check("B3 taskkill 失败：记录为非成功且给出来源", async () => {
    const child = trackChildProcess(spawnProbeChild(CHILD_SLEEPER));
    const report = await stopTrackedChildTree(child, {
      kill: () => dockerResult(1, "", "Access is denied."),
    });
    ok(!report.ok, "taskkill 失败不得当作清理成功");
    ok(report.detail.includes("Access is denied."), `保留失败原因：${report.detail}`);
    registerCleanup("B3-child", () => stopTrackedChildTree(child));
  });

  await check("B4 创建身份无法核实：拒绝强杀", async () => {
    const child = trackChildProcess(spawnProbeChild(CHILD_SLEEPER));
    let killCalls = 0;
    const probe: ProcessProbe = { ...defaultProcessProbe, creationTime: () => null };
    const report = await stopTrackedChildTree(child, {
      probe,
      kill: () => {
        killCalls += 1;
        return dockerResult(1, "", "should not be called");
      },
    });
    ok(!report.ok, "无法核实身份时不得报告清理成功");
    ok(/创建身份/.test(report.detail), report.detail);
    eq(killCalls, 0, "无法核实身份时不得强杀");
    registerCleanup("B4-child", () => stopTrackedChildTree(child));
  });

  await check("B5 创建身份不一致（疑似 PID 复用）：拒绝强杀", async () => {
    const child = trackChildProcess(spawnProbeChild(CHILD_SLEEPER));
    let killCalls = 0;
    const probe: ProcessProbe = {
      ...defaultProcessProbe,
      creationTime: () => "1999-01-01T00:00:00.0000000Z",
    };
    const report = await stopTrackedChildTree(child, {
      probe,
      kill: () => {
        killCalls += 1;
        return dockerResult(1, "", "should not be called");
      },
    });
    ok(!report.ok, "身份不一致时不得报告清理成功");
    ok(/不一致/.test(report.detail), report.detail);
    eq(killCalls, 0, "身份不一致时不得强杀");
    registerCleanup("B5-child", () => stopTrackedChildTree(child));
  });

  await check("B6 根进程已退出但存在残留后代：记录未知，拒绝按旧 PID 强杀", async () => {
    const child = trackChildProcess(spawnProbeChild(CHILD_SLEEPER));
    const orphanPid = 424242;
    let killCalls = 0;
    const probe: ProcessProbe = {
      creationTime: () => null,
      isAlive: (pid) => pid === orphanPid,
      parentMap: () => new Map([[child.pid, 1], [orphanPid, child.pid]]),
    };
    const report = await stopTrackedChildTree(child, {
      probe,
      kill: () => {
        killCalls += 1;
        return dockerResult(1, "", "should not be called");
      },
    });
    ok(!report.ok, "发现疑似残留后代必须记录为非成功");
    ok(report.detail.includes(String(orphanPid)), `报告列出未知资源 PID：${report.detail}`);
    eq(killCalls, 0, "残留后代不得按旧 PID 强杀");
    registerCleanup("B6-child", () => stopTrackedChildTree(child));
  });

  await check("B7 多步清理：前一步失败/超时不跳过后续自有资源清理", async () => {
    const order: string[] = [];
    const notes: string[] = [];
    await runCleanupSteps(
      [
        { label: "step-1", run: () => { order.push("1"); throw new Error("boom"); } },
        { label: "step-2", run: () => { order.push("2"); return { ok: false, detail: "failed-report" }; } },
        { label: "step-3", timeoutMs: 150, run: () => new Promise<void>(() => { order.push("3"); }) },
        { label: "step-4", run: () => { order.push("4"); } },
      ],
      (label, detail) => notes.push(`${label}:${detail}`),
    );
    eq(order, ["1", "2", "3", "4"], "每一步都被尝试");
    eq(notes.length, 3, "异常 / 非成功报告 / 超时各自记录");
    ok(notes[0]?.startsWith("step-1:"), notes[0] ?? "");
    ok(notes[1]?.includes("failed-report"), notes[1] ?? "");
    ok(notes[2]?.includes("step-3") && notes[2].includes("超时"), notes[2] ?? "");
  });

  await check("B8 kill 失败且根消失：已知存活子进程必须报告非成功", async () => {
    const state: FakeProcessState = {
      alive: new Set([9000, 9001]),
      created: new Map([[9000, "T0"], [9001, "T1"]]),
      parents: new Map([[9001, 9000]]),
    };
    const killCalls: number[] = [];
    const report = await stopTrackedChildTree(fakeTrackedChild(9000, "T0"), {
      probe: fakeProbe(state),
      kill: (pid) => {
        killCalls.push(pid);
        state.alive.delete(9000);
        return { status: 1, stdout: "", stderr: "simulated taskkill failure" };
      },
    });
    ok(!report.ok, "根消失不等于树已清理，不得报成功");
    ok(report.detail.includes("9001"), `报告列出待人工核实的资源：${report.detail}`);
    ok(/taskkill failure|失败/.test(report.detail), `保留终止命令失败原因：${report.detail}`);
    eq(killCalls, [9000], "只对已核实根 PID 发出终止命令，不盲目追加强杀");
  });

  await check("B9 kill 返回成功但已知子进程仍存活：报告非成功", async () => {
    const state: FakeProcessState = {
      alive: new Set([9100, 9101]),
      created: new Map([[9100, "T0"], [9101, "T1"]]),
      parents: new Map([[9101, 9100]]),
    };
    const report = await stopTrackedChildTree(fakeTrackedChild(9100, "T0"), {
      probe: fakeProbe(state),
      kill: (pid) => {
        expectPid(pid, 9100);
        state.alive.delete(9100);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    ok(!report.ok, "已记录后代仍存活必须非成功");
    ok(report.detail.includes("9101"), report.detail);
  });

  await check("B10 根与已知子树全部消失：确认成功", async () => {
    const state: FakeProcessState = {
      alive: new Set([9200, 9201, 9202]),
      created: new Map([[9200, "T0"], [9201, "T1"], [9202, "T2"]]),
      parents: new Map([[9201, 9200], [9202, 9201]]),
    };
    const report = await stopTrackedChildTree(fakeTrackedChild(9200, "T0"), {
      probe: fakeProbe(state),
      kill: (pid) => {
        expectPid(pid, 9200);
        state.alive.clear();
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    ok(report.ok, report.detail);
    ok(/2 个|后代/.test(report.detail), `成功报告应包含子树核实信息：${report.detail}`);
  });

  await check("B11 根已退出且后代身份无法核实：非成功且不强杀", async () => {
    const state: FakeProcessState = {
      alive: new Set([9301]),
      created: new Map([[9301, null]]),
      parents: new Map([[9301, 9300]]),
    };
    let killCalls = 0;
    const report = await stopTrackedChildTree(
      fakeTrackedChild(9300, "T0", { code: 1, signal: null, atMs: 1 }),
      {
        probe: fakeProbe(state),
        kill: () => {
          killCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    ok(!report.ok, "身份无法核实的后代不得当作已清理");
    ok(report.detail.includes("9301"), report.detail);
    eq(killCalls, 0, "拒绝按旧 PID 强杀");
  });

  await check("B12 后代 PID 被复用：不得误杀新进程，按已清理处理", async () => {
    const state: FakeProcessState = {
      alive: new Set([9400, 9401]),
      created: new Map([[9400, "T0"], [9401, "T1"]]),
      parents: new Map([[9401, 9400]]),
    };
    const report = await stopTrackedChildTree(fakeTrackedChild(9400, "T0"), {
      probe: fakeProbe(state),
      kill: (pid) => {
        expectPid(pid, 9400);
        state.alive.delete(9400);
        state.created.set(9401, "T-NEW-REUSED");
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    ok(report.ok, `PID 复用不得当作残留：${report.detail}`);
  });

  await check("B13 主装置消费链：失败报告 → 清理问题 → 非零退出闸门", async () => {
    const state: FakeProcessState = {
      alive: new Set([9000, 9001]),
      created: new Map([[9000, "T0"], [9001, "T1"]]),
      parents: new Map([[9001, 9000]]),
    };
    const cleanupNotes: string[] = [];
    const captured: { report: CleanupReport | null } = { report: null };
    await runCleanupSteps(
      [
        {
          label: "http-server",
          run: async () => {
            captured.report = await stopTrackedChildTree(fakeTrackedChild(9000, "T0"), {
              probe: fakeProbe(state),
              kill: () => {
                state.alive.delete(9000);
                return { status: 1, stdout: "", stderr: "simulated failure" };
              },
            });
            return captured.report;
          },
        },
        {
          label: "later-step",
          run: () => {
            cleanupNotes.push("later-step-ran");
          },
        },
      ],
      (label, detail) => cleanupNotes.push(`${label}: ${detail}`),
    );
    ok(captured.report !== null && !captured.report.ok, "失败报告被 runCleanupSteps 判为非成功");
    ok(cleanupNotes.includes("later-step-ran"), "前一步清理失败不跳过后续自有资源");
    let gateError: Error | null = null;
    try {
      assertCleanupComplete(cleanupNotes.filter((entry) => entry.includes(":")));
    } catch (caught) {
      gateError = caught instanceof Error ? caught : new Error(String(caught));
    }
    ok(gateError !== null, "主流程闸门必须抛出（非零退出）");
    ok(/simulated failure|9001/.test(gateError?.message ?? ""), `闸门保留资源引用：${gateError?.message}`);
    assertCleanupComplete([]);
  });
}

/* ------------------------------ C Docker 三态 ------------------------------ */

async function runDockerTriStateChecks(): Promise<void> {
  currentSection = "C";
  await check("C1 首次 inspect daemon 不可用：不删除、不报成功、记录资源 ID", () => {
    const { run, calls } = queuedRunner([DAEMON_DOWN]);
    const report = removeOwnedContainer(OWN_ID, removalOptions(run));
    ok(!report.ok, "无法核实不得报成功");
    ok(report.detail.includes("无法核实") && report.detail.includes(OWN_ID), report.detail);
    eq(calls.length, 1, "不尝试删除身份未知资源");
    eq(calls[0]?.args[0], "inspect", "唯一调用是 inspect");
  });

  await check("C2 rm 失败后 inspect 也不可用：记录未知并不报成功", () => {
    const { run, calls } = queuedRunner([
      inspectJson(OWN_ID, { [LABEL_KEY]: OFFLINE_RUN }),
      REMOVAL_FAIL,
      DAEMON_DOWN,
    ]);
    const report = removeOwnedContainer(OWN_ID, removalOptions(run));
    ok(!report.ok, "rm 失败且无法复核不得报成功");
    ok(report.detail.includes("无法核实") && report.detail.includes(OWN_ID), report.detail);
    eq(calls.length, 3, "inspect → rm → 复核 inspect");
    eq(calls[1]?.args[0], "rm", "中间一步是 rm");
  });

  await check("C3 明确不存在：核实后按无残留处理", () => {
    const { run, calls } = queuedRunner([notFound(OWN_ID)]);
    const report = removeOwnedContainer(OWN_ID, removalOptions(run));
    ok(report.ok, report.detail);
    ok(report.detail.includes("不存在"), report.detail);
    eq(calls.length, 1, "不存在时不再删除");
  });

  await check("C4 标签不匹配：拒绝删除他人容器", () => {
    const { run, calls } = queuedRunner([inspectJson(OWN_ID, { [LABEL_KEY]: "other-run" })]);
    const report = removeOwnedContainer(OWN_ID, removalOptions(run));
    ok(!report.ok, "异标签容器不得删除");
    ok(report.detail.includes("标签不属于本轮"), report.detail);
    eq(calls.length, 1, "标签不匹配时不执行 rm");
  });

  await check("C5 合法自有容器：按 ID + 标签核验后删除并复核", () => {
    const { run, calls } = queuedRunner([
      inspectJson(OWN_ID, { [LABEL_KEY]: OFFLINE_RUN }),
      removalOk(OWN_ID),
      notFound(OWN_ID),
    ]);
    const report = removeOwnedContainer(OWN_ID, removalOptions(run));
    ok(report.ok, report.detail);
    eq(calls[1]?.args, ["rm", "-f", OWN_ID], "按已核实 ID 执行 rm");
  });

  await check("C6 容器 ID 未确认：按唯一名核实不存在后视为无残留", () => {
    const { run, calls } = queuedRunner([notFound("cga-g5-qa1-name")]);
    const report = removeOwnedContainer(null, {
      fallbackName: "cga-g5-qa1-name",
      runId: OFFLINE_RUN,
      labelKey: LABEL_KEY,
      run,
    });
    ok(report.ok, report.detail);
    eq(calls[0]?.args, ["inspect", "--format", "{{json .}}", "cga-g5-qa1-name"], "按唯一容器名核实");
  });

  await check("C7 容器 ID 未确认且 daemon 不可用：记录未知并非成功", () => {
    const { run, calls } = queuedRunner([DAEMON_DOWN]);
    const report = removeOwnedContainer(null, {
      fallbackName: "cga-g5-qa1-name",
      runId: OFFLINE_RUN,
      labelKey: LABEL_KEY,
      run,
    });
    ok(!report.ok, "名称路径无法核实也不得报成功");
    eq(calls.length, 1, "不尝试删除");
  });

  await check("C8 inspect 返回的 ID 与已知 ID 不一致：拒绝删除", () => {
    const { run, calls } = queuedRunner([inspectJson(OTHER_ID, { [LABEL_KEY]: OFFLINE_RUN })]);
    const report = removeOwnedContainer(OWN_ID, removalOptions(run));
    ok(!report.ok && report.detail.includes("身份不一致"), report.detail);
    eq(calls.length, 1, "身份不一致时不执行 rm");
  });

  await check("C9 rm 失败且复核显示仍存在：记录删除失败", () => {
    const { run, calls } = queuedRunner([
      inspectJson(OWN_ID, { [LABEL_KEY]: OFFLINE_RUN }),
      REMOVAL_FAIL,
      inspectJson(OWN_ID, { [LABEL_KEY]: OFFLINE_RUN }),
    ]);
    const report = removeOwnedContainer(OWN_ID, removalOptions(run));
    ok(!report.ok, "仍在运行不得报成功");
    ok(report.detail.includes("container is running"), report.detail);
    eq(calls.length, 3, "inspect → rm → 复核 inspect");
  });

  await check("C10 rm 成功但无法复核：严格记录为非成功", () => {
    const { run } = queuedRunner([
      inspectJson(OWN_ID, { [LABEL_KEY]: OFFLINE_RUN }),
      removalOk(OWN_ID),
      DAEMON_DOWN,
    ]);
    const report = removeOwnedContainer(OWN_ID, removalOptions(run));
    ok(!report.ok && report.detail.includes("无法复核"), report.detail);
  });
}

/* ------------------------------ D 生成物恢复 ------------------------------ */

interface MemoryArtifactFs {
  ops: ArtifactFs;
  files: Map<string, string>;
  readErrors: Map<string, string>;
  listErrors: Map<string, string>;
  listResults: Map<string, string[] | null>;
  calls: {
    reads: string[];
    writes: string[];
    removes: string[];
    lists: string[];
    ensureDirs: string[];
  };
}

function memoryArtifactFs(): MemoryArtifactFs {
  const files = new Map<string, string>();
  const readErrors = new Map<string, string>();
  const listErrors = new Map<string, string>();
  const listResults = new Map<string, string[] | null>();
  const calls = {
    reads: [] as string[],
    writes: [] as string[],
    removes: [] as string[],
    lists: [] as string[],
    ensureDirs: [] as string[],
  };
  const simulated = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });
  const ops: ArtifactFs = {
    readText(absolute) {
      calls.reads.push(absolute);
      const error = readErrors.get(absolute);
      if (error) throw simulated(error);
      const content = files.get(absolute);
      if (content === undefined) throw simulated("ENOENT");
      return content;
    },
    writeText(absolute, content) {
      calls.writes.push(absolute);
      files.set(absolute, content);
    },
    removeFile(absolute) {
      calls.removes.push(absolute);
      if (!files.delete(absolute)) throw simulated("ENOENT");
    },
    ensureDir(absolute) {
      calls.ensureDirs.push(absolute);
    },
    listTypeFiles(absolute) {
      calls.lists.push(absolute);
      const error = listErrors.get(absolute);
      if (error) throw simulated(error);
      return listResults.has(absolute) ? listResults.get(absolute) ?? null : null;
    },
  };
  return { ops, files, readErrors, listErrors, listResults, calls };
}

async function runArtifactChecks(): Promise<void> {
  currentSection = "D";
  await check("D1 只恢复/删除本轮导致的变化，不覆盖运行前已有改动", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "g5-artifacts-"));
    const nextEnv = path.join(tempRoot, "next-env.d.ts");
    const tsconfig = path.join(tempRoot, "tsconfig.json");
    const keep = path.join(tempRoot, ".next", "types", "keep.ts");
    const oldType = path.join(tempRoot, ".next", "dev", "types", "old.ts");
    const outside = path.join(tempRoot, "outside.txt");
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.mkdirSync(path.dirname(oldType), { recursive: true });
    fs.writeFileSync(nextEnv, "ORIGINAL_NEXT_ENV");
    fs.writeFileSync(tsconfig, "ORIGINAL_TSCONFIG");
    fs.writeFileSync(keep, "PRE_EXISTING_TYPE");
    fs.writeFileSync(oldType, "RESTORE_ME");
    const snapshot = snapshotGeneratedArtifacts(tempRoot);

    fs.writeFileSync(nextEnv, "CHANGED_BY_RUN");
    fs.writeFileSync(tsconfig, "CHANGED_BY_RUN");
    fs.rmSync(oldType);
    fs.writeFileSync(path.join(tempRoot, ".next", "types", "new.ts"), "CREATED_BY_RUN");
    fs.writeFileSync(outside, "USER_CHANGE");

    const report = restoreGeneratedArtifacts(snapshot, tempRoot);
    eq(fs.readFileSync(nextEnv, "utf8"), "ORIGINAL_NEXT_ENV", "next-env.d.ts 恢复运行前内容");
    eq(fs.readFileSync(tsconfig, "utf8"), "ORIGINAL_TSCONFIG", "tsconfig.json 恢复运行前内容");
    eq(fs.readFileSync(oldType, "utf8"), "RESTORE_ME", "被本轮删除的类型文件恢复");
    eq(fs.existsSync(path.join(tempRoot, ".next", "types", "new.ts")), false, "本轮新建类型文件删除");
    eq(fs.readFileSync(keep, "utf8"), "PRE_EXISTING_TYPE", "运行前已有类型文件不受影响");
    eq(fs.readFileSync(outside, "utf8"), "USER_CHANGE", ".next 外的用户文件不被触碰");
    ok(report.restored.length >= 3, `报告恢复文件：${report.restored.join(",")}`);
    ok(report.removed.some((entry) => entry.includes("new.ts")), `报告删除文件：${report.removed.join(",")}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await check("D2 快照本身不改写任何文件", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "g5-artifacts-"));
    const file = path.join(tempRoot, "next-env.d.ts");
    fs.writeFileSync(file, "UNTOUCHED");
    const before = fs.statSync(file).mtimeMs;
    snapshotGeneratedArtifacts(tempRoot);
    eq(fs.readFileSync(file, "utf8"), "UNTOUCHED", "内容不变");
    eq(fs.statSync(file).mtimeMs, before, "mtime 不变");
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await check("D3 快照读取失败不得当作不存在：fail-fast 且不改动原路径", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "g5-artifacts-"));
    const tsconfig = path.join(tempRoot, "tsconfig.json");
    fs.mkdirSync(tsconfig);
    let error: Error | null = null;
    try {
      snapshotGeneratedArtifacts(tempRoot);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    ok(error !== null, "快照无法建立时必须抛出，而不是把读取失败记为不存在");
    ok(/tsconfig\.json/.test(error?.message ?? ""), `错误包含资源引用：${error?.message}`);
    ok(fs.statSync(tsconfig).isDirectory(), "原路径保持不变");
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await check("D4 快照 tsconfig EACCES：fail-fast，读取失败不得记为不存在", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const tsconfig = path.join(root, "tsconfig.json");
    mem.files.set(tsconfig, "ORIGINAL_TSCONFIG");
    mem.readErrors.set(tsconfig, "EACCES");
    let error: Error | null = null;
    try {
      snapshotGeneratedArtifacts(root, mem.ops);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    ok(error !== null, "快照必须 fail-fast");
    ok(/EACCES/.test(error?.message ?? "") && /tsconfig\.json/.test(error?.message ?? ""), `错误保真：${error?.message}`);
    eq(mem.calls.writes.length, 0, "覆盖调用为 0");
    eq(mem.calls.removes.length, 0, "删除调用为 0");
    eq(mem.files.get(tsconfig), "ORIGINAL_TSCONFIG", "原内容保持不变");
  });

  await check("D5 快照 next-env I/O 错误：fail-fast，不记为不存在", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const nextEnv = path.join(root, "next-env.d.ts");
    mem.files.set(nextEnv, "ORIGINAL_NEXT_ENV");
    mem.readErrors.set(nextEnv, "EIO");
    let error: Error | null = null;
    try {
      snapshotGeneratedArtifacts(root, mem.ops);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    ok(error !== null && /EIO/.test(error.message), `I/O 错误必须 fail-fast：${error?.message}`);
    eq(mem.calls.removes.length, 0, "删除调用为 0");
    eq(mem.files.get(nextEnv), "ORIGINAL_NEXT_ENV", "原内容保持不变");
  });

  await check("D6 快照类型目录枚举失败：fail-fast，不得当作空目录", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const typeDir = path.join(root, ".next", "types");
    mem.listErrors.set(typeDir, "EACCES");
    let error: Error | null = null;
    try {
      snapshotGeneratedArtifacts(root, mem.ops);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    ok(error !== null && /目录枚举失败/.test(error.message), `枚举失败必须 fail-fast：${error?.message}`);
    eq(mem.calls.writes.length, 0, "覆盖调用为 0");
    eq(mem.calls.removes.length, 0, "删除调用为 0");
  });

  await check("D7 恢复阶段读取失败：记录问题、不删除/不覆盖、原文件保持改动后状态", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const nextEnv = path.join(root, "next-env.d.ts");
    const tsconfig = path.join(root, "tsconfig.json");
    mem.files.set(nextEnv, "ORIGINAL_NEXT_ENV");
    mem.files.set(tsconfig, "ORIGINAL_TSCONFIG");
    const snapshot = snapshotGeneratedArtifacts(root, mem.ops);
    mem.files.set(tsconfig, "CHANGED_BY_RUN");
    mem.readErrors.set(tsconfig, "EACCES");
    const report = restoreGeneratedArtifacts(snapshot, root, mem.ops);
    ok(report.issues.some((entry) => entry.includes("tsconfig.json") && entry.includes("EACCES")), `问题记录：${report.issues.join("；")}`);
    eq(mem.calls.writes.length, 0, "覆盖调用为 0");
    eq(mem.calls.removes.length, 0, "删除调用为 0");
    eq(mem.files.get(tsconfig), "CHANGED_BY_RUN", "恢复阶段未改动该文件");
    eq(mem.files.get(nextEnv), "ORIGINAL_NEXT_ENV", "其他文件保持原状");
  });

  await check("D8 真正缺失且本轮新建的文件可清理，明确不存在不被误判", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const nextEnv = path.join(root, "next-env.d.ts");
    const tsconfig = path.join(root, "tsconfig.json");
    const typeDir = path.join(root, ".next", "types");
    const newType = path.join(typeDir, "new.ts");
    mem.files.set(tsconfig, "ORIGINAL_TSCONFIG");
    mem.listResults.set(typeDir, []);
    const snapshot = snapshotGeneratedArtifacts(root, mem.ops);
    eq(snapshot.files.get(nextEnv)?.state, "absent", "未读取到且 ENOENT：记录为明确不存在");
    mem.files.set(nextEnv, "CREATED_BY_RUN");
    mem.files.set(newType, "CREATED_BY_RUN");
    mem.listResults.set(typeDir, [newType]);
    const report = restoreGeneratedArtifacts(snapshot, root, mem.ops);
    ok(report.removed.some((entry) => entry.includes("next-env.d.ts")), `本轮新建 next-env 被清理：${report.removed.join(",")}`);
    ok(report.removed.some((entry) => entry.includes("new.ts")), `本轮新建类型文件被清理：${report.removed.join(",")}`);
    eq(report.issues, [], "无问题");
    eq(mem.files.get(tsconfig), "ORIGINAL_TSCONFIG", "原有文件不受影响");
  });

  await check("D9 恢复阶段目录枚举失败：记录问题并跳过该目录删除", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const typeDir = path.join(root, ".next", "types");
    mem.listResults.set(typeDir, []);
    const snapshot = snapshotGeneratedArtifacts(root, mem.ops);
    mem.listErrors.set(typeDir, "EACCES");
    const report = restoreGeneratedArtifacts(snapshot, root, mem.ops);
    ok(report.issues.some((entry) => entry.includes("目录枚举失败")), `问题记录：${report.issues.join("；")}`);
    eq(mem.calls.removes.length, 0, "枚举失败时删除调用为 0");
  });

  await check("D10 恢复阶段新增文件无法读取：记录问题且不删除", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const typeDir = path.join(root, ".next", "types");
    const newType = path.join(typeDir, "new.ts");
    mem.listResults.set(typeDir, []);
    const snapshot = snapshotGeneratedArtifacts(root, mem.ops);
    mem.files.set(newType, "CREATED_BY_RUN");
    mem.listResults.set(typeDir, [newType]);
    mem.readErrors.set(newType, "EACCES");
    const report = restoreGeneratedArtifacts(snapshot, root, mem.ops);
    ok(report.issues.some((entry) => entry.includes("new.ts")), `问题记录：${report.issues.join("；")}`);
    eq(mem.calls.removes, [], "无法核实的新增文件不得删除");
    eq(mem.files.get(newType), "CREATED_BY_RUN", "文件保持不变");
  });

  await check("D11 已有文件被本轮修改：按快照精确恢复", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const nextEnv = path.join(root, "next-env.d.ts");
    mem.files.set(nextEnv, "ORIGINAL_NEXT_ENV");
    const snapshot = snapshotGeneratedArtifacts(root, mem.ops);
    mem.files.set(nextEnv, "CHANGED_BY_RUN");
    const report = restoreGeneratedArtifacts(snapshot, root, mem.ops);
    eq(mem.files.get(nextEnv), "ORIGINAL_NEXT_ENV", "内容精确恢复");
    ok(report.restored.some((entry) => entry.includes("next-env.d.ts")), report.restored.join(","));
    eq(report.issues, [], "无问题");
  });

  await check("D12 快照收录运行前已有类型文件：被本轮删除后恢复，不被当新增文件误删", () => {
    const mem = memoryArtifactFs();
    const root = path.join(os.tmpdir(), "g5-mem-root");
    const typeDir = path.join(root, ".next", "types");
    const oldType = path.join(typeDir, "old.ts");
    mem.files.set(oldType, "PRE_EXISTING_TYPE");
    mem.listResults.set(typeDir, [oldType]);
    const snapshot = snapshotGeneratedArtifacts(root, mem.ops);
    eq(snapshot.files.get(oldType)?.state, "present", "已有类型文件进入快照");
    mem.files.delete(oldType);
    const report = restoreGeneratedArtifacts(snapshot, root, mem.ops);
    eq(mem.files.get(oldType), "PRE_EXISTING_TYPE", "被本轮删除的已有类型文件恢复");
    eq(report.removed, [], "不得作为新增文件删除");
    ok(report.restored.some((entry) => entry.includes("old.ts")), report.restored.join(","));
  });
}

/* ------------------------------ E 模型守门 ------------------------------ */

async function runGuardChecks(): Promise<void> {
  currentSection = "E";
  await check("E1 守门计数来自真实请求，不写常量冒充", async () => {
    const guard = await startModelRequestGuard();
    eq(guard.hits, 0, "初始计数为 0");
    const response = await fetch(`${guard.baseUrl}/v1/chat/completions`, { method: "POST" });
    eq(response.status, 502, "守门服务器立即拒绝并失败");
    eq(guard.hits, 1, "计数来自实际请求");
    eq(guard.requestPaths, ["/v1/chat/completions"], "记录触达路径");
    const env = modelGuardEnv(guard, process.env);
    eq(env.LLM_PROVIDER, "stepfun", "provider 改道");
    eq(env.STEPFUN_BASE_URL, guard.baseUrl, "base URL 指向守门服务器");
    await guard.close();
    ok(true, "守门服务器可关闭");
  });
}

/* ------------------------------ L Docker 实测 ------------------------------ */

function listContainerNames(run: CommandRunner = nativeCommand): string[] {
  const result = run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function runLiveDockerChecks(): Promise<string> {
  currentSection = "L";
  const probe = nativeCommand("docker", ["version"]);
  if (probe.status !== 0) return "NOT_RUN";
  const liveRun = `${process.pid.toString(36)}${Date.now().toString(36)}`.toLowerCase();
  const before = listContainerNames();
  const preExisting = before.filter((name) => name.startsWith("zzsh-"));

  await check("L1 异标签容器保留：删除请求被拒绝且容器仍存在", () => {
    const decoyName = `cga-g5-qa1-decoy-${liveRun}`;
    const created = nativeCommand("docker", [
      "run", "-d", "--name", decoyName,
      "--label", `${LABEL_KEY}=foreign-${liveRun}`,
      "postgres:16-alpine",
    ]);
    const decoyId = parseContainerIdFromStdout(created.stdout);
    ok(Boolean(decoyId), `创建异标签容器失败：${created.stderr || created.stdout}`);
    try {
      const report = removeOwnedContainer(decoyId, {
        fallbackName: decoyName,
        runId: liveRun,
        labelKey: LABEL_KEY,
      });
      ok(!report.ok, `异标签容器不得删除：${report.detail}`);
      const inspected = inspectOwnedContainer(decoyId ?? decoyName, LABEL_KEY);
      eq(inspected.state, "verified", "异标签容器保留");
    } finally {
      if (decoyId) nativeCommand("docker", ["rm", "-f", decoyId]);
    }
  });

  await check("L2 本轮容器正常清理：删除后 inspect 明确不存在", () => {
    const ownName = `cga-g5-qa1-own-${liveRun}`;
    const created = nativeCommand("docker", [
      "run", "-d", "--name", ownName,
      "--label", `${LABEL_KEY}=${liveRun}`,
      "postgres:16-alpine",
    ]);
    const ownId = parseContainerIdFromStdout(created.stdout);
    ok(Boolean(ownId), `创建本轮容器失败：${created.stderr || created.stdout}`);
    try {
      const report = removeOwnedContainer(ownId, {
        fallbackName: ownName,
        runId: liveRun,
        labelKey: LABEL_KEY,
      });
      ok(report.ok, report.detail);
      eq(inspectOwnedContainer(ownId ?? ownName, LABEL_KEY).state, "absent", "清理后明确不存在");
    } finally {
      if (ownId) nativeCommand("docker", ["rm", "-f", ownId]);
    }
  });

  await check("L3 启动成功但检查失败：路径内清理本轮自有资源", async () => {
    const iso = await startIsolatedPostgres({
      runId: liveRun,
      containerName: `cga-g5-qa1-iso-${liveRun}`,
      dbName: `cga_g5_qa1_${liveRun}`,
      labelKey: LABEL_KEY,
      noteIssue: (label, detail) => {
        failed += 1;
        failures.push(`L3-${label}: ${detail}`);
      },
    });
    try {
      throw new Error("simulated check failure");
    } catch {
      // 预期的检查失败
    } finally {
      const report = iso.teardown();
      ok(report.ok, report.detail);
    }
    eq(inspectOwnedContainer(iso.containerId, LABEL_KEY).state, "absent", "失败路径后无本轮残留");
  });

  await check("L4 既有服务不受影响：既有容器仍在运行", () => {
    const after = listContainerNames();
    for (const name of preExisting) {
      ok(after.includes(name), `既有容器保留：${name}`);
    }
    ok(preExisting.length > 0, `运行前存在既有容器：${preExisting.join(",")}`);
  });

  return "RUN";
}

/* ------------------------------ 主流程 ------------------------------ */

async function main(): Promise<void> {
  console.log(`G5 装置安全检查开始：${new Date().toISOString()}`);
  try {
    await runWiringChecks();
    await runReadinessChecks();
    await runProcessCleanupChecks();
    await runDockerTriStateChecks();
    await runArtifactChecks();
    await runGuardChecks();
  } finally {
    const cleanupNotes: string[] = [];
    await runCleanupSteps(cleanupSteps, (label, detail) => cleanupNotes.push(`${label}: ${detail}`));
    for (const note of cleanupNotes) {
      failed += 1;
      failures.push(`cleanup ${note}`);
      console.log(`FAIL cleanup ${note}`);
    }
  }
  const liveStatus = await runLiveDockerChecks();

  console.log(
    JSON.stringify(
      {
        passed,
        failed,
        sections: sectionCounts,
        live_docker: liveStatus,
        failures,
      },
      null,
      2,
    ),
  );
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.log(`FATAL ${messageOf(error)}`);
  process.exitCode = 1;
});
