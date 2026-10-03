import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Client } from "pg";

/**
 * G5 隔离装置安全原语。
 *
 * 这里只放三类共享能力，供 check-guide-evidence-db.ts 与专属安全检查复用：
 * - 进程身份：PID + 创建时间核实、进程树归属、可核实的树终止；
 * - 端口归属：监听者 PID 必须属于本轮子进程树（不按端口杀进程）；
 * - Docker 三态：已核实 / 明确不存在 / 无法核实，拒绝把 inspect 失败当不存在；
 * - 模型守门：把测试进程与子进程的真实 provider 出口改道到本地计数守门服务器。
 *
 * 平台说明：进程身份/树终止的完整实现以 Windows（PowerShell + taskkill）验证；
 * 其他平台尽力使用 ps/kill，无法核实即如实失败（不做猜测）。
 */

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export type CommandRunner = (file: string, args: string[]) => CommandResult;

export const nativeCommand: CommandRunner = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error?.message,
  };
};

export interface CleanupReport {
  ok: boolean;
  detail: string;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lastNonEmptyLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/* ------------------------------ 进程身份探针 ------------------------------ */

export interface ProcessProbe {
  /** 进程创建时间（用于防 PID 复用）；无法核实返回 null */
  creationTime(pid: number): string | null;
  isAlive(pid: number): boolean;
  /** PID → 父 PID 映射；无法读取返回 null */
  parentMap(): Map<number, number> | null;
}

const WIN32_CREATION_TIME_ARGS = (pid: number) => [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString('o')`,
];

export const defaultProcessProbe: ProcessProbe = {
  creationTime(pid) {
    if (process.platform === "win32") {
      const result = nativeCommand("powershell", WIN32_CREATION_TIME_ARGS(pid));
      return result.status === 0 ? lastNonEmptyLine(result.stdout) || null : null;
    }
    const result = nativeCommand("ps", ["-p", String(pid), "-o", "lstart="]);
    return result.status === 0 ? lastNonEmptyLine(result.stdout) || null : null;
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  parentMap() {
    if (process.platform === "win32") {
      const result = nativeCommand("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
      ]);
      if (result.status !== 0 || !result.stdout) return null;
      try {
        const parsed = JSON.parse(result.stdout) as unknown;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const map = new Map<number, number>();
        for (const row of rows) {
          if (typeof row !== "object" || row === null) continue;
          const record = row as Record<string, unknown>;
          const childPid = Number(record.ProcessId);
          const parentPid = Number(record.ParentProcessId);
          if (Number.isInteger(childPid) && Number.isInteger(parentPid)) {
            map.set(childPid, parentPid);
          }
        }
        return map;
      } catch {
        return null;
      }
    }
    const result = nativeCommand("ps", ["-e", "-o", "pid=,ppid="]);
    if (result.status !== 0) return null;
    const map = new Map<number, number>();
    for (const line of result.stdout.split("\n")) {
      const [childPid, parentPid] = line
        .trim()
        .split(/\s+/)
        .map((part) => Number(part));
      if (Number.isInteger(childPid) && Number.isInteger(parentPid)) {
        map.set(childPid, parentPid);
      }
    }
    return map;
  },
};

export function isDescendantOrSelf(
  pid: number,
  rootPid: number,
  parents: Map<number, number>,
): boolean {
  let current = pid;
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === rootPid) return true;
    const next = parents.get(current);
    if (next === undefined || next === 0 || next === current) return false;
    current = next;
  }
  return false;
}

export function collectDescendants(rootPid: number, parents: Map<number, number>): number[] {
  const byParent = new Map<number, number[]>();
  for (const [childPid, parentPid] of parents) {
    const list = byParent.get(parentPid);
    if (list) list.push(childPid);
    else byParent.set(parentPid, [childPid]);
  }
  const found: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const childPid of byParent.get(current) ?? []) {
      if (found.includes(childPid)) continue;
      found.push(childPid);
      queue.push(childPid);
    }
  }
  return found;
}

/* ------------------------------ 端口归属 ------------------------------ */

export type ListenerLookup = { ok: true; pids: number[] } | { ok: false; detail: string };

export function findListeningPids(port: number, run: CommandRunner = nativeCommand): ListenerLookup {
  if (process.platform === "win32") {
    const result = run("netstat", ["-ano", "-p", "tcp"]);
    if (result.status !== 0) {
      return {
        ok: false,
        detail: `netstat 失败：${result.stderr || result.error || `exit=${result.status}`}`,
      };
    }
    const pids = new Set<number>();
    for (const line of result.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
      const local = parts[1] ?? "";
      const separator = local.lastIndexOf(":");
      if (separator <= 0 || Number(local.slice(separator + 1)) !== port) continue;
      const pid = Number(parts[4]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return { ok: true, pids: [...pids] };
  }
  const lsof = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (lsof.status === 0) {
    const pids = new Set(
      lsof.stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    );
    return { ok: true, pids: [...pids] };
  }
  const lsofMissing =
    (lsof.error !== undefined && /ENOENT/.test(lsof.error)) ||
    /command not found|not recognized/i.test(lsof.stderr);
  if (!lsofMissing) {
    return { ok: false, detail: `lsof 失败：${lsof.stderr || lsof.error || `exit=${lsof.status}`}` };
  }
  const ss = run("ss", ["-ltnp"]);
  if (ss.status !== 0) return { ok: false, detail: "无法读取端口监听者（lsof/ss 均不可用）" };
  const pids = new Set<number>();
  for (const line of ss.stdout.split("\n")) {
    if (!line.includes(`:${port} `)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return { ok: true, pids: [...pids] };
}

export type OwnershipCheck = { ok: true; ownerPids: number[] } | { ok: false; detail: string };

/** 端口上所有监听者都必须能核实为本轮子进程树，否则身份不成立 */
export function verifyPortOwnedByTree(
  port: number,
  rootPid: number,
  deps: { probe?: ProcessProbe; findListeners?: (port: number) => ListenerLookup } = {},
): OwnershipCheck {
  if (rootPid <= 0) return { ok: false, detail: "本轮子进程 PID 未记录，无法核实端口归属" };
  const probe = deps.probe ?? defaultProcessProbe;
  const listeners = (deps.findListeners ?? findListeningPids)(port);
  if (!listeners.ok) return { ok: false, detail: `无法读取端口监听者：${listeners.detail}` };
  if (listeners.pids.length === 0) return { ok: false, detail: `端口 ${port} 上没有发现监听者` };
  const parents = probe.parentMap();
  if (!parents) return { ok: false, detail: "无法读取进程父子关系，拒绝把服务视为本轮进程" };
  const foreign = listeners.pids.filter((pid) => !isDescendantOrSelf(pid, rootPid, parents));
  if (foreign.length > 0) {
    return {
      ok: false,
      detail: `端口 ${port} 存在非本轮监听者 PID ${foreign.join(",")}（本轮根 PID ${rootPid}），拒绝继续`,
    };
  }
  return { ok: true, ownerPids: listeners.pids };
}

/* ------------------------------ 子进程跟踪与本轮清理 ------------------------------ */

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  atMs: number;
}

export interface TrackedChild {
  pid: number;
  proc: ChildProcess;
  /** spawn 时记录的创建身份（防 PID 复用）；null 表示未记录/无法核实 */
  startedAt: string | null;
  spawnError: string | null;
  exit: ChildExit | null;
  logFile: string | null;
  stopped?: CleanupReport;
}

export function trackChildProcess(
  proc: ChildProcess,
  options: { logFile?: string | null; probe?: ProcessProbe } = {},
): TrackedChild {
  const child: TrackedChild = {
    pid: proc.pid ?? -1,
    proc,
    startedAt: null,
    spawnError: null,
    exit: null,
    logFile: options.logFile ?? null,
  };
  proc.on("error", (error) => {
    if (!child.spawnError) child.spawnError = error.message;
  });
  proc.on("exit", (code, signal) => {
    if (!child.exit) child.exit = { code, signal, atMs: Date.now() };
  });
  if (proc.pid) {
    const probe = options.probe ?? defaultProcessProbe;
    child.startedAt = probe.creationTime(proc.pid);
  }
  return child;
}

export function childExitLabel(child: TrackedChild): string {
  if (child.spawnError) return `spawn error: ${child.spawnError}`;
  if (!child.exit) return "仍在运行";
  const code = child.exit.code === null ? "null" : String(child.exit.code);
  const signal = child.exit.signal === null ? "null" : child.exit.signal;
  return `exit=${code} signal=${signal}`;
}

export function readLogTail(child: TrackedChild, lines = 20): string {
  if (!child.logFile || !fs.existsSync(child.logFile)) return "";
  try {
    return fs
      .readFileSync(child.logFile, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
}

function logSuffix(child: TrackedChild): string {
  const tail = readLogTail(child);
  return tail ? `\n日志尾部：\n${tail}` : "";
}

export async function waitForChildExit(child: TrackedChild, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!child.exit && Date.now() < deadline) {
    await sleep(200);
  }
  return child.exit !== null;
}

function defaultKillTree(pid: number): CommandResult {
  if (process.platform === "win32") {
    return nativeCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
  }
  return nativeCommand("kill", ["-TERM", String(pid)]);
}

export type KillTree = (pid: number) => CommandResult;

async function waitUntilGone(
  probe: ProcessProbe,
  pid: number,
  startedAt: string | null,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!probe.isAlive(pid)) return true;
    if (startedAt !== null) {
      const current = probe.creationTime(pid);
      if (current !== null && current !== startedAt) return true;
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

function verifyExitedTree(child: TrackedChild, probe: ProcessProbe): CleanupReport {
  if (child.pid <= 0) return { ok: true, detail: "未产生子进程 PID，无需清理" };
  if (probe.isAlive(child.pid)) {
    return {
      ok: false,
      detail: `PID ${child.pid} 已被复用，无法核实残留后代归属；拒绝按旧 PID 强杀`,
    };
  }
  const parents = probe.parentMap();
  if (!parents) {
    return {
      ok: false,
      detail: `子进程已退出（${childExitLabel(child)}），但无法读取进程关系核实是否存在残留后代`,
    };
  }
  const orphans = collectDescendants(child.pid, parents).filter((pid) => probe.isAlive(pid));
  if (orphans.length > 0) {
    return {
      ok: false,
      detail: `子进程已退出，但发现疑似残留后代 PID ${orphans.join(",")}；拒绝按旧 PID 强杀，需人工核实`,
    };
  }
  return {
    ok: true,
    detail: `子进程已退出（${childExitLabel(child)}），未执行强杀，未发现残留后代`,
  };
}

/**
 * 只终止仍可核实属于本轮的子进程树：
 * 先核对 PID + 创建时间；已退出的进程绝不按旧 PID 强杀；无法核实即失败。
 */
export async function stopTrackedChildTree(
  child: TrackedChild,
  options: { kill?: KillTree; probe?: ProcessProbe; waitMs?: number } = {},
): Promise<CleanupReport> {
  if (child.stopped?.ok) return child.stopped;
  const probe = options.probe ?? defaultProcessProbe;
  const kill = options.kill ?? defaultKillTree;
  const waitMs = options.waitMs ?? 10_000;
  let report: CleanupReport;
  if (child.pid <= 0) {
    report = { ok: true, detail: "未产生子进程 PID，无需清理" };
  } else if (child.exit) {
    report = verifyExitedTree(child, probe);
  } else if (!probe.isAlive(child.pid)) {
    report = verifyExitedTree(child, probe);
  } else if (!child.startedAt) {
    report = { ok: false, detail: `PID ${child.pid} 创建身份未记录，拒绝强杀` };
  } else {
    const current = probe.creationTime(child.pid);
    if (current === null) {
      report = { ok: false, detail: `无法核实 PID ${child.pid} 创建身份，拒绝强杀` };
    } else if (current !== child.startedAt) {
      report = {
        ok: false,
        detail: `PID ${child.pid} 创建身份不一致（可能已被复用），拒绝强杀`,
      };
    } else {
      const killResult = kill(child.pid);
      if (killResult.status !== 0 && probe.isAlive(child.pid)) {
        report = {
          ok: false,
          detail: `终止进程树失败：${killResult.stderr || killResult.stdout || killResult.error || `exit=${killResult.status}`}`,
        };
      } else {
        const gone = await waitUntilGone(probe, child.pid, child.startedAt, waitMs);
        report = gone
          ? {
              ok: true,
              detail:
                process.platform === "win32"
                  ? `已按 PID ${child.pid} + 创建身份核验终止本轮进程树`
                  : `已终止根进程 PID ${child.pid}；非 Windows 平台未验证后代清理`,
            }
          : { ok: false, detail: `已发出终止命令，但 PID ${child.pid} 仍在运行` };
      }
    }
  }
  child.stopped = report;
  return report;
}

/* ------------------------------ 就绪与身份核实 ------------------------------ */

export interface VerifiedServiceOptions {
  base: string;
  port: number;
  child: TrackedChild;
  timeoutMs: number;
  statusPath?: string;
  pollMs?: number;
  probe?: ProcessProbe;
  findListeners?: (port: number) => ListenerLookup;
  fetchImpl?: typeof fetch;
}

/**
 * 就绪必须同时满足：本轮子进程未退出/未启动失败 + 端口监听者属于本轮进程树。
 * 任意 HTTP 200（哪怕来自占位服务）都不算就绪。
 */
export async function waitForVerifiedService(
  options: VerifiedServiceOptions,
): Promise<{ ownerPids: number[] }> {
  const statusPath = options.statusPath ?? "/api/auth/status";
  const pollMs = options.pollMs ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (options.child.spawnError) {
      throw new Error(`本轮服务启动失败：${options.child.spawnError}${logSuffix(options.child)}`);
    }
    if (options.child.exit) {
      throw new Error(
        `本轮服务已退出（${childExitLabel(options.child)}），拒绝把 HTTP 响应当作本轮服务${logSuffix(options.child)}`,
      );
    }
    let statusOk = false;
    try {
      const response = await fetchImpl(`${options.base}${statusPath}`);
      statusOk = response.ok;
    } catch {
      statusOk = false;
    }
    if (statusOk) {
      const ownership = verifyPortOwnedByTree(options.port, options.child.pid, {
        probe: options.probe,
        findListeners: options.findListeners,
      });
      if (!ownership.ok) {
        throw new Error(`服务身份无法核验，拒绝继续登录或写入：${ownership.detail}`);
      }
      return { ownerPids: ownership.ownerPids };
    }
    if (Date.now() > deadline) {
      throw new Error(`服务未在 ${options.timeoutMs}ms 内就绪${logSuffix(options.child)}`);
    }
    await sleep(pollMs);
  }
}

/* ------------------------------ Docker 三态 ------------------------------ */

export type ContainerInspection =
  | { state: "verified"; id: string; label: string | null }
  | { state: "absent" }
  | { state: "unverifiable"; detail: string };

export function parseContainerIdFromStdout(stdout: string): string | null {
  const last = lastNonEmptyLine(stdout);
  return /^[0-9a-f]{64}$/i.test(last) ? last : null;
}

export function inspectOwnedContainer(
  target: string,
  labelKey: string,
  run: CommandRunner = nativeCommand,
): ContainerInspection {
  const result = run("docker", ["inspect", "--format", "{{json .}}", target]);
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || result.error || `exit=${result.status}`;
    if (/no such (object|container)/i.test(detail)) return { state: "absent" };
    return { state: "unverifiable", detail };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { state: "unverifiable", detail: "docker inspect 输出不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { state: "unverifiable", detail: "docker inspect 输出缺少容器对象" };
  }
  const record = parsed as Record<string, unknown>;
  const id = typeof record.Id === "string" ? record.Id : "";
  const config =
    typeof record.Config === "object" && record.Config !== null
      ? (record.Config as Record<string, unknown>)
      : null;
  const labels =
    config && typeof config.Labels === "object" && config.Labels !== null
      ? (config.Labels as Record<string, unknown>)
      : null;
  const label = labels && typeof labels[labelKey] === "string" ? (labels[labelKey] as string) : null;
  if (!/^[0-9a-f]{64}$/i.test(id)) {
    return { state: "unverifiable", detail: `docker inspect 返回的容器 ID 不合法：${id || "空"}` };
  }
  return { state: "verified", id, label };
}

export interface ContainerRemovalOptions {
  fallbackName: string;
  runId: string;
  labelKey: string;
  run?: CommandRunner;
}

/**
 * 仅删除能核实身份与标签所有权的本轮容器：
 * inspect 失败（daemon/权限）视为“无法核实”，既不删除也不报成功。
 */
export function removeOwnedContainer(
  knownId: string | null,
  options: ContainerRemovalOptions,
): CleanupReport {
  const run = options.run ?? nativeCommand;
  const target = knownId ?? options.fallbackName;
  const first = inspectOwnedContainer(target, options.labelKey, run);
  if (first.state === "absent") return { ok: true, detail: `已核实容器不存在：${target}` };
  if (first.state === "unverifiable") {
    return {
      ok: false,
      detail: `无法核实容器 ${target} 身份（${first.detail}）；拒绝删除身份未知资源，资源引用=${target}`,
    };
  }
  if (knownId !== null && first.id !== knownId) {
    return { ok: false, detail: `容器身份不一致：期望 ${knownId}，实际 ${first.id}；拒绝删除` };
  }
  if (first.label !== options.runId) {
    return {
      ok: false,
      detail: `容器 ${first.id} 标签不属于本轮（期望 ${options.runId}，实际 ${first.label ?? "无"}），拒绝删除`,
    };
  }
  const removal = run("docker", ["rm", "-f", first.id]);
  if (removal.status === 0) {
    const after = inspectOwnedContainer(first.id, options.labelKey, run);
    if (after.state === "absent") {
      return { ok: true, detail: `已按容器 ID ${first.id} + 标签所有权核验删除` };
    }
    if (after.state === "verified") {
      return { ok: false, detail: `docker rm 返回成功，但容器 ${first.id} 仍然存在` };
    }
    return {
      ok: false,
      detail: `docker rm 返回成功，但无法复核容器 ${first.id} 已删除（${after.detail}）`,
    };
  }
  const after = inspectOwnedContainer(first.id, options.labelKey, run);
  if (after.state === "absent") {
    return { ok: true, detail: `删除命令失败但已核实容器 ${first.id} 不存在` };
  }
  if (after.state === "unverifiable") {
    return {
      ok: false,
      detail: `删除失败（${removal.stderr || removal.stdout || removal.error || `exit=${removal.status}`}），且无法核实容器 ${first.id} 现状（${after.detail}）`,
    };
  }
  return {
    ok: false,
    detail: `删除容器 ${first.id} 失败：${removal.stderr || removal.stdout || removal.error || `exit=${removal.status}`}`,
  };
}

/* ------------------------------ 一次性隔离数据库 ------------------------------ */

export interface IsolatedPostgresOptions {
  runId: string;
  containerName: string;
  dbName: string;
  labelKey: string;
  noteIssue?: (label: string, detail: string) => void;
  run?: CommandRunner;
}

export interface IsolatedPostgres {
  url: string;
  containerId: string;
  teardown: () => CleanupReport;
}

/**
 * 启动一次性本地 PostgreSQL 容器并完成身份核验：
 * 容器 ID/标签、回环端口映射、current_database/current_user/inet_server_port、空库。
 * 任何启动/检查失败都会先清理本轮自有容器，再抛错。
 */
export async function startIsolatedPostgres(
  options: IsolatedPostgresOptions,
): Promise<IsolatedPostgres> {
  const run = options.run ?? nativeCommand;
  const removalOptions: ContainerRemovalOptions = {
    fallbackName: options.containerName,
    runId: options.runId,
    labelKey: options.labelKey,
    run,
  };
  const probe = run("docker", ["version"]);
  if (probe.status !== 0) {
    throw new Error(
      "未检测到可用的 Docker：本检查只使用一次性本地容器，不连接 .env、外部 URL 或任何未知数据库",
    );
  }
  const started = run("docker", [
    "run",
    "-d",
    "--name",
    options.containerName,
    "--label",
    `${options.labelKey}=${options.runId}`,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    `POSTGRES_DB=${options.dbName}`,
    "-e",
    "TZ=UTC",
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  const containerId = parseContainerIdFromStdout(started.stdout);
  if (started.status !== 0 || !containerId) {
    const fallbackRemoval = removeOwnedContainer(null, removalOptions);
    if (!fallbackRemoval.ok) options.noteIssue?.("startup-container", fallbackRemoval.detail);
    throw new Error(
      `启动一次性测试数据库失败：${started.stderr || started.stdout || started.error || `exit=${started.status}`}`,
    );
  }
  const teardown = () => removeOwnedContainer(containerId, removalOptions);
  try {
    const inspected = inspectOwnedContainer(containerId, options.labelKey, run);
    if (inspected.state !== "verified") {
      throw new Error(
        `无法核实本轮容器身份：${inspected.state === "unverifiable" ? inspected.detail : "容器不存在"}`,
      );
    }
    if (inspected.id !== containerId) {
      throw new Error("无法核实本轮容器身份：docker run stdout 与 inspect 不一致");
    }
    if (inspected.label !== options.runId) throw new Error("容器标签与本轮运行标记不一致，拒绝继续");
    const mapped = run("docker", ["port", containerId, "5432/tcp"]).stdout.split("\n")[0] ?? "";
    if (!mapped.startsWith("127.0.0.1:")) throw new Error("端口映射不在本机回环地址上，拒绝连接");
    const hostPort = mapped.split(":").pop()?.trim();
    if (!hostPort) throw new Error("无法读取一次性测试数据库端口");
    const url = `postgresql://postgres:postgres@127.0.0.1:${hostPort}/${options.dbName}`;

    const deadline = Date.now() + 60_000;
    for (;;) {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.end();
        break;
      } catch {
        try {
          await client.end();
        } catch {
          // 忽略
        }
        if (Date.now() > deadline) throw new Error("一次性测试数据库启动超时");
        await sleep(500);
      }
    }

    const verifier = new Client({ connectionString: url });
    await verifier.connect();
    try {
      const identity = await verifier.query<{ db: string; usr: string; port: number }>(
        "SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port",
      );
      if (identity.rows[0]?.db !== options.dbName) throw new Error("目标库身份不符：库名不一致");
      if (identity.rows[0]?.usr !== "postgres") throw new Error("目标库身份不符：用户不一致");
      if (identity.rows[0]?.port !== 5432) throw new Error("目标端口上不是预期的 PostgreSQL 服务");
      const existing = await verifier.query<{ rel: string | null }>(
        "SELECT to_regclass('public.observations') AS rel",
      );
      if (existing.rows[0]?.rel !== null) throw new Error("目标库不是全新空库，拒绝初始化");
    } finally {
      await verifier.end();
    }
    return { url, containerId, teardown };
  } catch (error) {
    const removal = teardown();
    if (!removal.ok) options.noteIssue?.("startup-container", removal.detail);
    throw error;
  }
}

/* ------------------------------ 模型请求守门 ------------------------------ */

export interface ModelRequestGuard {
  readonly baseUrl: string;
  readonly hits: number;
  readonly requestPaths: string[];
  close: () => Promise<void>;
}

/**
 * 本地守门服务器：测试进程与子进程的 provider 出口都改道到这里。
 * 任何一次真实模型调用都会被计数并以 502 立即失败，不触达外部 provider。
 */
export async function startModelRequestGuard(): Promise<ModelRequestGuard> {
  let hits = 0;
  const requestPaths: string[] = [];
  const server = http.createServer((request, response) => {
    hits += 1;
    if (requestPaths.length < 10 && request.url) requestPaths.push(request.url);
    response.statusCode = 502;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        error: { message: "G5 harness guard: real model provider calls are forbidden in checks" },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法启动模型守门服务器");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get hits() {
      return hits;
    },
    get requestPaths() {
      return [...requestPaths];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 把 provider 出口改道到守门服务器；只影响测试进程与显式传入的子进程环境 */
export function modelGuardEnv(
  guard: ModelRequestGuard,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    LLM_PROVIDER: "stepfun",
    STEPFUN_API_KEY: "g5-harness-guard",
    STEPFUN_BASE_URL: guard.baseUrl,
    STEPFUN_MODEL: "g5-harness-guard",
    STEPFUN_TIMEOUT_MS: "5000",
  };
}

/* ------------------------------ 独立清理步骤 ------------------------------ */

export interface CleanupStep {
  label: string;
  timeoutMs?: number;
  run: () => void | CleanupReport | Promise<void | CleanupReport>;
}

/**
 * 依次尝试所有清理步骤：单步失败/超时只记录，不跳过后续自有资源清理。
 * “已调用清理”不等于“清理成功”：非 ok 报告与异常都会进入 note。
 */
export async function runCleanupSteps(
  steps: CleanupStep[],
  note: (label: string, detail: string) => void,
): Promise<void> {
  for (const step of steps) {
    const timeoutMs = step.timeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(step.run()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${step.label} 清理超时（${timeoutMs}ms），按未完成记录并继续`)),
            timeoutMs,
          );
        }),
      ]);
      if (result && !result.ok) note(step.label, result.detail || "清理未成功");
    } catch (error) {
      note(step.label, error instanceof Error ? error.message : String(error));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/* ------------------------------ 生成物快照与恢复 ------------------------------ */

export interface GeneratedArtifactSnapshot {
  files: Map<string, string | null>;
}

const GENERATED_ARTIFACT_FILES = ["next-env.d.ts", "tsconfig.json"];
const GENERATED_ARTIFACT_DIRS = [".next/types", ".next/dev/types"];

function listTypeFiles(dir: string): string[] {
  const result: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(absolute);
    }
  };
  walk(dir);
  return result;
}

function readTextOrNull(absolute: string): string | null {
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

/** 快照 next-env.d.ts / tsconfig.json 与 .next 类型生成物；不触碰 .next 其他内容 */
export function snapshotGeneratedArtifacts(root: string): GeneratedArtifactSnapshot {
  const files = new Map<string, string | null>();
  for (const relative of GENERATED_ARTIFACT_FILES) {
    const absolute = path.join(root, relative);
    files.set(absolute, readTextOrNull(absolute));
  }
  for (const relative of GENERATED_ARTIFACT_DIRS) {
    for (const absolute of listTypeFiles(path.join(root, relative))) {
      files.set(absolute, readTextOrNull(absolute));
    }
  }
  return { files };
}

export interface ArtifactRestoreReport {
  restored: string[];
  removed: string[];
  issues: string[];
}

/** 只处理本轮导致的变化：改回的按快照写回，新建的删除，运行前已有改动不覆盖 */
export function restoreGeneratedArtifacts(
  snapshot: GeneratedArtifactSnapshot,
  root: string,
): ArtifactRestoreReport {
  const restored: string[] = [];
  const removed: string[] = [];
  const issues: string[] = [];
  for (const [absolute, before] of snapshot.files) {
    const current = readTextOrNull(absolute);
    if (before === null) {
      if (current !== null) {
        try {
          fs.rmSync(absolute);
          removed.push(path.relative(root, absolute));
        } catch (error) {
          issues.push(`${path.relative(root, absolute)}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      continue;
    }
    if (current !== before) {
      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, before);
        restored.push(path.relative(root, absolute));
      } catch (error) {
        issues.push(`${path.relative(root, absolute)}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  for (const relative of GENERATED_ARTIFACT_DIRS) {
    for (const absolute of listTypeFiles(path.join(root, relative))) {
      if (snapshot.files.has(absolute)) continue;
      try {
        fs.rmSync(absolute);
        removed.push(path.relative(root, absolute));
      } catch (error) {
        issues.push(`${path.relative(root, absolute)}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { restored, removed, issues };
}
