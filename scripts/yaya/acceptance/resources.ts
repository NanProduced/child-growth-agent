/**
 * YAYA-QA-SEED1 一次性验收资源（隔离 PostgreSQL 容器 + 自有对象目录）。
 *
 * 安全边界（与 scripts/harness-safety.ts 同一装置，不改动该文件）：
 * - 只使用本轮 docker run 创建的一次性本地 PostgreSQL 容器，容器 ID + 运行标签双重核验；
 * - 临时目录在创建时**登记本轮精确绝对路径 + seed_id + 用途**（进程内登记表）；
 *   使用/删除必须命中登记且身份一致——名字前缀与“知道路径”都不构成所有权证明；
 * - 不接受任何外部数据库 URL 参数、不读 .env、不连接托管库（调用方拿不到「传入 URL」入口）。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";

import {
  inspectOwnedContainer,
  startIsolatedPostgres,
  type CleanupReport,
  type CleanupStep,
  type IsolatedPostgres,
} from "../../harness-safety";

export const ACCEPTANCE_LABEL_KEY = "yaya.qa-seed1";
export const ACCEPTANCE_DB_NAME = "yaya_qa_seed1";
export const ACCEPTANCE_TMP_PREFIX = "yaya-qa-seed1";
export const ACCEPTANCE_SCHOOL_ID = "single-school";

export type AcceptanceTempKind = "objects" | "secrets";

export interface AcceptanceResources {
  seed_id: string;
  db_name: string;
  container_id: string;
  database_url: string;
  object_root: string;
  secrets_dir: string;
  credentials_path: string;
  isolated: IsolatedPostgres;
}

/** 准备阶段失败：携带结构化清理结果，入口层不得把未清理误报为已清理 */
export class AcceptanceResourceError extends Error {
  constructor(
    message: string,
    public readonly cleanup_ok: boolean,
    public readonly cleanup_issues: readonly string[],
  ) {
    super(message);
    this.name = "AcceptanceResourceError";
  }
}

/* ------------------------------ 临时目录所有权登记 ------------------------------ */

interface OwnedTempDirEntry {
  seed_id: string;
  kind: AcceptanceTempKind;
  removed: boolean;
}

/** 进程内登记表：key = 本轮创建时登记的精确绝对路径 */
const ownedTempDirs = new Map<string, OwnedTempDirEntry>();

function assertTempDirShape(dir: string, kind: AcceptanceTempKind): void {
  const resolved = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  const expectedPrefix = `${ACCEPTANCE_TMP_PREFIX}-${kind}-`;
  if (!resolved.startsWith(`${tmp}${path.sep}`) || !path.basename(resolved).startsWith(expectedPrefix)) {
    throw new Error(`目录不满足本轮临时目录形状：${resolved}`);
  }
}

/**
 * 创建并登记本轮临时目录。所有权 = 登记表中的精确路径 + seed_id + 用途；
 * 仅前缀相同的其他实例目录不会进入登记表，因此不会被使用或删除。
 */
export function registerOwnedTempDir(kind: AcceptanceTempKind, seedId: string): string {
  if (!seedId.trim()) throw new Error("登记临时目录需要非空 seed_id");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${ACCEPTANCE_TMP_PREFIX}-${kind}-`));
  const resolved = path.resolve(dir);
  assertTempDirShape(resolved, kind);
  ownedTempDirs.set(resolved, { seed_id: seedId, kind, removed: false });
  return resolved;
}

/** 使用前核验：形状 + 登记表命中 + seed_id/用途一致；未登记或身份不符一律拒绝 */
export function assertOwnedTempDir(dir: string, kind: AcceptanceTempKind, seedId: string): void {
  const resolved = path.resolve(dir);
  assertTempDirShape(resolved, kind);
  const entry = ownedTempDirs.get(resolved);
  if (!entry || entry.kind !== kind || entry.seed_id !== seedId) {
    throw new Error(`目录未登记为本轮（${seedId}/${kind}）资源，拒绝使用或删除：${resolved}`);
  }
}

/**
 * 精确删除已登记的临时目录：
 * - 未登记/身份不符 → 拒绝，不触碰；
 * - 已删除过 → 只要核实不存在即视为成功（teardown 可安全重试）；
 * - 删除后必须核实不存在才算成功。
 */
export function removeOwnedTempDir(
  dir: string,
  kind: AcceptanceTempKind,
  seedId: string,
): CleanupReport {
  const resolved = path.resolve(dir);
  try {
    assertOwnedTempDir(resolved, kind, seedId);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const entry = ownedTempDirs.get(resolved);
  if (!entry) return { ok: false, detail: `登记缺失，拒绝删除：${resolved}` };
  if (!fs.existsSync(resolved)) {
    entry.removed = true;
    return { ok: true, detail: `已核实目录不存在（登记路径 ${resolved}）` };
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (error) {
    return {
      ok: false,
      detail: `删除目录失败：${resolved}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (fs.existsSync(resolved)) {
    return { ok: false, detail: `删除后目录仍存在：${resolved}` };
  }
  entry.removed = true;
  return { ok: true, detail: `已按登记路径删除并核实不存在：${resolved}` };
}

/** 仅供自检：查询登记状态（不影响清理语义） */
export function isTempDirRegistered(dir: string, kind: AcceptanceTempKind, seedId: string): boolean {
  const entry = ownedTempDirs.get(path.resolve(dir));
  return entry !== undefined && entry.kind === kind && entry.seed_id === seedId;
}

/* ------------------------------ 隔离数据库 ------------------------------ */

export function newAcceptanceSeedId(): string {
  return `qaseed1-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

async function assertDatabaseIdentity(url: string, dbName: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const identity = await client.query<{ db: string; usr: string; port: number }>(
      "SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port",
    );
    const row = identity.rows[0];
    if (row?.db !== dbName) throw new Error(`验收库身份不符：期望 ${dbName}，实际 ${row?.db ?? "空"}`);
    if (row?.usr !== "postgres") throw new Error("验收库身份不符：用户不是 postgres");
    if (row?.port !== 5432) throw new Error("验收库身份不符：目标端口上不是预期的 PostgreSQL");
    const preexisting = await client.query<{ rel: string | null }>(
      "SELECT to_regclass('public.observations') AS rel",
    );
    if (preexisting.rows[0]?.rel !== null) throw new Error("验收库不是全新空库，拒绝初始化");
  } finally {
    await client.end();
  }
}

/** 核验容器身份 + 目录登记；任一项无法核实即抛错（不做“失败当不存在”） */
export function verifyAcceptanceResources(resources: AcceptanceResources): void {
  const inspection = inspectOwnedContainer(resources.container_id, ACCEPTANCE_LABEL_KEY);
  if (inspection.state === "unverifiable") {
    throw new Error(`无法核实本轮容器 ${resources.container_id}：${inspection.detail}`);
  }
  if (inspection.state === "absent") {
    throw new Error(`本轮容器不存在：${resources.container_id}`);
  }
  if (inspection.id !== resources.container_id) {
    throw new Error(`容器身份不一致：期望 ${resources.container_id}，实际 ${inspection.id}`);
  }
  if (inspection.label !== resources.seed_id) {
    throw new Error(
      `容器标签不属于本轮（期望 ${resources.seed_id}，实际 ${inspection.label ?? "无"}）`,
    );
  }
  assertOwnedTempDir(resources.object_root, "objects", resources.seed_id);
  assertOwnedTempDir(resources.secrets_dir, "secrets", resources.seed_id);
}

export async function prepareAcceptanceResources(): Promise<AcceptanceResources> {
  const seedId = newAcceptanceSeedId();
  const startIssues: string[] = [];
  let isolated: IsolatedPostgres;
  try {
    isolated = await startIsolatedPostgres({
      runId: seedId,
      containerName: `${ACCEPTANCE_TMP_PREFIX}-${seedId}`.slice(0, 60),
      dbName: ACCEPTANCE_DB_NAME,
      labelKey: ACCEPTANCE_LABEL_KEY,
      noteIssue: (label, detail) => startIssues.push(`${label}: ${detail}`),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AcceptanceResourceError(
      `${message}${startIssues.length > 0 ? `；启动阶段清理未完成：${startIssues.join("；")}` : ""}`,
      startIssues.length === 0,
      startIssues,
    );
  }
  if (startIssues.length > 0) {
    // 启动函数已自行尝试清理但报告失败：再核验一次容器现状，失败则如实上报，不继续。
    const retry = isolated.teardown();
    if (!retry.ok) {
      throw new AcceptanceResourceError(
        `隔离数据库启动阶段清理未完成：${startIssues.join("；")}`,
        false,
        startIssues,
      );
    }
  }

  const created: { kind: AcceptanceTempKind; dir: string }[] = [];
  try {
    const objectRoot = registerOwnedTempDir("objects", seedId);
    created.push({ kind: "objects", dir: objectRoot });
    const secretsDir = registerOwnedTempDir("secrets", seedId);
    created.push({ kind: "secrets", dir: secretsDir });
    await assertDatabaseIdentity(isolated.url, ACCEPTANCE_DB_NAME);
    const resources: AcceptanceResources = {
      seed_id: seedId,
      db_name: ACCEPTANCE_DB_NAME,
      container_id: isolated.containerId,
      database_url: isolated.url,
      object_root: objectRoot,
      secrets_dir: secretsDir,
      credentials_path: path.join(secretsDir, "credentials.json"),
      isolated,
    };
    verifyAcceptanceResources(resources);
    return resources;
  } catch (error) {
    const reports: CleanupReport[] = [isolated.teardown()];
    for (const entry of created) {
      reports.push(removeOwnedTempDir(entry.dir, entry.kind, seedId));
    }
    const issues = reports.filter((report) => !report.ok).map((report) => report.detail);
    const message = error instanceof Error ? error.message : String(error);
    throw new AcceptanceResourceError(
      issues.length === 0
        ? `${message}（已清理本轮容器与已登记目录）`
        : `${message}；清理未完成：${issues.join("；")}`,
      issues.length === 0,
      issues,
    );
  }
}

/** 精确 teardown 步骤：容器（ID+标签核验后删除）+ 对象目录 + 凭证目录（均按登记身份） */
export function acceptanceCleanupSteps(resources: AcceptanceResources): CleanupStep[] {
  return [
    {
      label: "isolated-postgres",
      timeoutMs: 30_000,
      run: () => resources.isolated.teardown(),
    },
    {
      label: "object-root",
      run: () => removeOwnedTempDir(resources.object_root, "objects", resources.seed_id),
    },
    {
      label: "credentials-dir",
      run: () => removeOwnedTempDir(resources.secrets_dir, "secrets", resources.seed_id),
    },
  ];
}
