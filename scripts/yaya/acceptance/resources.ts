/**
 * YAYA-QA-SEED1 一次性验收资源（隔离 PostgreSQL 容器 + 自有对象目录）。
 *
 * 安全边界（与 scripts/harness-safety.ts 同一装置，不改动该文件）：
 * - 只使用本轮 docker run 创建的一次性本地 PostgreSQL 容器，容器 ID + 运行标签双重核验；
 * - 只使用 os.tmpdir() 下本轮 mkdtemp 创建的对象目录/凭证目录；清理只删除能核验属于本轮的目录；
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

function ownedTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${ACCEPTANCE_TMP_PREFIX}-${prefix}-`));
  assertOwnedTempDir(dir, prefix);
  return dir;
}

/** 目录必须在 os.tmpdir() 下且名字带本轮前缀；否则视为非本轮资源，拒绝清理/使用 */
export function assertOwnedTempDir(dir: string, kind: string): void {
  const resolved = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  const expectedPrefix = `${ACCEPTANCE_TMP_PREFIX}-${kind}-`;
  if (!resolved.startsWith(`${tmp}${path.sep}`) || !path.basename(resolved).startsWith(expectedPrefix)) {
    throw new Error(`目录不属于本轮受控临时资源：${resolved}`);
  }
}

export function removeOwnedTempDir(dir: string, kind: string): CleanupReport {
  try {
    assertOwnedTempDir(dir, kind);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    fs.rmSync(path.resolve(dir), { recursive: true, force: true });
  } catch (error) {
    return {
      ok: false,
      detail: `删除目录失败：${path.resolve(dir)}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (fs.existsSync(path.resolve(dir))) {
    return { ok: false, detail: `删除后目录仍存在：${path.resolve(dir)}` };
  }
  return { ok: true, detail: `已删除并核实目录不存在：${path.resolve(dir)}` };
}

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

/** 核验容器身份 + 目录归属；任一项无法核实即抛错（不做“失败当不存在”） */
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
  assertOwnedTempDir(resources.object_root, "objects");
  assertOwnedTempDir(resources.secrets_dir, "secrets");
}

export async function prepareAcceptanceResources(): Promise<AcceptanceResources> {
  const seedId = newAcceptanceSeedId();
  const startIssues: string[] = [];
  const isolated = await startIsolatedPostgres({
    runId: seedId,
    containerName: `${ACCEPTANCE_TMP_PREFIX}-${seedId}`.slice(0, 60),
    dbName: ACCEPTANCE_DB_NAME,
    labelKey: ACCEPTANCE_LABEL_KEY,
    noteIssue: (label, detail) => startIssues.push(`${label}: ${detail}`),
  });
  if (startIssues.length > 0) {
    // 启动阶段已有清理失败：先尽量清理，再把问题交给调用方，不继续播种。
    throw new Error(`隔离数据库启动阶段清理未完成：${startIssues.join("；")}`);
  }
  let objectRoot = "";
  let secretsDir = "";
  try {
    objectRoot = ownedTempDir("objects");
    secretsDir = ownedTempDir("secrets");
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
    if (objectRoot) reports.push(removeOwnedTempDir(objectRoot, "objects"));
    if (secretsDir) reports.push(removeOwnedTempDir(secretsDir, "secrets"));
    const issues = reports.filter((report) => !report.ok).map((report) => report.detail);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      issues.length === 0
        ? `${message}（已清理本轮容器与目录）`
        : `${message}；清理未完成：${issues.join("；")}`,
    );
  }
}

/** 精确 teardown 步骤：容器（ID+标签核验后删除）+ 对象目录 + 凭证目录 */
export function acceptanceCleanupSteps(resources: AcceptanceResources): CleanupStep[] {
  return [
    {
      label: "isolated-postgres",
      timeoutMs: 30_000,
      run: () => resources.isolated.teardown(),
    },
    {
      label: "object-root",
      run: () => removeOwnedTempDir(resources.object_root, "objects"),
    },
    {
      label: "credentials-dir",
      run: () => removeOwnedTempDir(resources.secrets_dir, "secrets"),
    },
  ];
}
