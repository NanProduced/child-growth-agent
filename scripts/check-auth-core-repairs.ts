import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type PoolClient } from "pg";
import { NextRequest } from "next/server";

import {
  assertCleanupComplete, modelGuardEnv, runCleanupSteps, sleep,
  startIsolatedPostgres, startModelRequestGuard, stopTrackedChildTree, trackChildProcess,
  type IsolatedPostgres, type ModelRequestGuard, type TrackedChild,
} from "./harness-safety";
import { AccountsError } from "../src/lib/accounts/errors";
import { resolveRequestAuth } from "../src/lib/accounts/guards";
import { loadAccountsConfig } from "../src/lib/accounts/config";
import { hashPassword, verifyPassword } from "../src/lib/accounts/password";
import { createLoginRateLimiter, rateLimitKey } from "../src/lib/accounts/rate-limit";
import {
  buildPrincipal, createInitialAdmin, createTeacherWithAssignments, listTeachers,
  loadSessionByToken, loginWithPassword, resetTeacherPassword, resolvePrincipalById, setTeacherStatus,
} from "../src/lib/accounts/repository";
import { computeCsrfToken, createSessionToken } from "../src/lib/accounts/session";
import { POST as createTeacher } from "../src/app/api/admin/teachers/route";
import { POST as loginRoute } from "../src/app/api/auth/login/route";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_ID = `auth-core-repairs-${crypto.randomUUID()}`;
const SCHOOL = `${RUN_ID}-school`;
const ORIGIN = "https://auth-core-repairs.invalid"; // Request objects only; no preview listener.
const PASSWORD = " Repairs-Password-1! ";
const ROTATED_PASSWORD = "Repairs-Password-2!";
const migration = () => fs.readFileSync(path.join(ROOT, "scripts/upgrade-auth-v1.sql"), "utf8");
type Settled<T> = PromiseSettledResult<T>;
const settled = <T>(promise: Promise<T>): Promise<Settled<T>> => promise.then(
  (value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }),
);
function valueOf<T>(result: Settled<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 12_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Test-only barrier after a real lock; queries and transactions still execute on real pg clients. */
export async function controlledOverlap<A, B>(
  observer: Client, first: () => Promise<A>, second: () => Promise<B>,
  lockSql: RegExp, waitingSql: RegExp,
): Promise<[Settled<A>, Settled<B>]> {
  const pool = globalThis.__pgPool;
  assert.ok(pool, "pool must already belong to the verified isolated database");
  const originalConnect = pool.connect;
  const acquire = originalConnect.bind(pool);
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  let reportLock!: (pid: number) => void;
  const locked = new Promise<number>((resolve) => { reportLock = resolve; });
  let firstResult: Promise<Settled<A>> | undefined;
  let secondResult: Promise<Settled<B>> | undefined;
  // Only the first transaction's connect is intercepted, then immediately restored.
  pool.connect = (async () => {
    pool.connect = originalConnect;
    const client = await acquire();
    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const originalQuery = client.query;
    const execute = originalQuery.bind(client);
    const originalRelease = client.release;
    let paused = false;
    client.query = (async (sql: string, params?: unknown[]) => {
      const result = await execute(sql, params);
      if (!paused && lockSql.test(sql)) {
        paused = true;
        reportLock(pid);
        await barrier;
      }
      return result;
    }) as PoolClient["query"];
    client.release = (error?: Error | boolean) => {
      client.query = originalQuery;
      client.release = originalRelease;
      originalRelease.call(client, error);
    };
    return client;
  }) as typeof pool.connect;
  try {
    firstResult = settled(first());
    const pid = await bounded(Promise.race([locked, firstResult.then((result) => {
      valueOf(result);
      throw new Error("first transaction completed without acquiring the expected lock");
    })]), "first lock");
    secondResult = settled(second());
    await (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const blocked = await observer.query<{ pid: number; query: string; wait_event_type: string }>(
          `SELECT pid, query, wait_event_type FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, [pid],
        );
        if (blocked.rows.length > 0) {
          assert.equal(blocked.rows.length, 1, "exactly one competing connection must be blocked");
          assert.notEqual(blocked.rows[0].pid, pid);
          assert.equal(blocked.rows[0].wait_event_type, "Lock");
          assert.match(blocked.rows[0].query, waitingSql);
          return;
        }
        await sleep(20);
      }
      throw new Error("second connection never waited on the first transaction's lock");
    })();
    releaseBarrier();
    return await bounded(Promise.all([firstResult, secondResult]), "transactions complete");
  } finally {
    releaseBarrier();
    pool.connect = originalConnect;
    await bounded(Promise.all([firstResult, secondResult]), "barrier cleanup");
  }
}

export async function checkInitialAdminRace(
  observer: Client, schoolId: string,
  inputs: [{ username: string; displayName: string; passwordHash: string },
    { username: string; displayName: string; passwordHash: string }],
): Promise<void> {
  const [winner, loser] = await controlledOverlap(observer,
    () => createInitialAdmin(inputs[0], schoolId), () => createInitialAdmin(inputs[1], schoolId),
    /pg_advisory_xact_lock/, /pg_advisory_xact_lock/);
  assert.equal(winner.status, "fulfilled");
  assert.equal(loser.status, "rejected");
  if (loser.status === "rejected") {
    assert.equal((loser.reason as { code?: unknown }).code, "admin_already_initialized");
  }
  const count = await observer.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM app_accounts WHERE role = 'admin'",
  );
  assert.equal(count.rows[0].count, 1);
}

export async function checkLoginMutationOrders(
  observer: Client, schoolId: string, adminId: string, originalHash: string, rotatedHash: string,
  password: string, rotatedPassword: string,
): Promise<void> {
  // Both hashes are prepared by the caller before any overlapping transaction starts.
  for (const mutation of ["reset", "disable"] as const) {
    for (const order of ["login-first", "mutation-first"] as const) {
      const username = `repair-${mutation}-${crypto.randomBytes(6).toString("hex")}`;
      const teacher = await createTeacherWithAssignments({ username, displayName: `Repair ${order}`,
        passwordHash: originalHash, classIds: [], assignedBy: adminId });
      const login = () => loginWithPassword(username, password, schoolId);
      const mutate = () => mutation === "reset"
        ? resetTeacherPassword(teacher.account_id, rotatedHash)
        : setTeacherStatus(teacher.account_id, "disabled");
      if (order === "login-first") {
        const [issued, changed] = await controlledOverlap(observer, login, mutate, /FOR UPDATE/, /FOR UPDATE/);
        const result = valueOf(issued);
        assert.equal(result.kind, "ok");
        assert.equal(valueOf(changed).revokedSessionCount, 1);
        if (result.kind === "ok") {
          assert.equal((await loadSessionByToken(result.token, schoolId)).kind, "invalid");
          const row = await observer.query<{ revoked_reason: string }>(
            "SELECT revoked_reason FROM app_sessions WHERE id = $1", [result.session.session_id]);
          assert.equal(row.rows[0].revoked_reason, mutation === "reset" ? "password_reset" : "disabled");
        }
      } else {
        const [changed, refused] = await controlledOverlap(observer, mutate, login, /FOR UPDATE/, /FOR UPDATE/);
        assert.equal(valueOf(changed).revokedSessionCount, 0);
        assert.equal(valueOf(refused).kind, mutation === "reset" ? "invalid_credentials" : "account_disabled");
        const count = await observer.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM app_sessions WHERE account_id = $1", [teacher.account_id]);
        assert.equal(count.rows[0].count, 0, "mutation-first must issue zero sessions");
      }
      assert.equal((await login()).kind, mutation === "reset" ? "invalid_credentials" : "account_disabled");
      if (mutation === "reset") {
        assert.equal((await loginWithPassword(username, rotatedPassword, schoolId)).kind, "ok");
      }
    }
  }
}

function offlineChecks(): void {
  const facts = { id: crypto.randomUUID(), username: "repair", display_name: "Repair",
    role: "teacher", status: "active", class_ids: [] };
  const invalidIdentity = (error: unknown) => error instanceof AccountsError && error.code === "identity_unavailable";
  for (const role of ["", "ADMIN", "garbage", " teacher"]) {
    assert.throws(() => buildPrincipal({ ...facts, role }, SCHOOL), invalidIdentity);
  }
  for (const status of ["", "ACTIVE", "garbage", "active "]) {
    for (const role of ["admin", "teacher"]) {
      assert.throws(() => buildPrincipal({ ...facts, role, status }, SCHOOL), invalidIdentity);
    }
  }
  assert.deepEqual(buildPrincipal({ ...facts, role: "admin", status: "disabled" }, SCHOOL).scope,
    { kind: "none", reason: "account_disabled" });
  assert.deepEqual(buildPrincipal(facts, SCHOOL).scope, { kind: "classes", class_ids: [] });
  let now = 0;
  const limiter = createLoginRateLimiter(() => now);
  const policy = { maxFailures: 2, windowMs: 1000 };
  limiter.recordFailure(rateLimitKey(" Ｔeacher ", "spoof-a"), policy);
  limiter.recordFailure(rateLimitKey("TEACHER", "spoof-b"), policy);
  assert.equal(limiter.isBlocked(rateLimitKey("teacher", "spoof-c"), policy), true);
  assert.equal(limiter.isBlocked(rateLimitKey("other", "spoof-c"), policy), false);
  now = 1000;
  assert.equal(limiter.isBlocked(rateLimitKey("teacher"), policy), false);
  limiter.recordFailure(rateLimitKey("teacher"), policy);
  limiter.reset(rateLimitKey("TEACHER", "spoof-d"));
  assert.equal(limiter.size(), 0);
}

const request = (pathname: string, json: unknown, token?: string, extra: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}${pathname}`, { method: "POST", headers: {
    origin: ORIGIN, "content-type": "application/json", "x-cga-auth-request": "1",
    ...(token ? { cookie: `cga_session=${token}`, "x-csrf-token": computeCsrfToken(token) } : {}), ...extra,
  }, body: JSON.stringify(json) });

async function metadataChecks(db: Client, hash: string): Promise<void> {
  const invalidIdentity = (error: unknown) => error instanceof AccountsError && error.code === "identity_unavailable";
  for (const [role, status] of [["invalid", "active"], ["admin", "invalid"], ["teacher", "invalid"]]) {
    await assert.rejects(() => db.query(
      `INSERT INTO app_accounts (username, display_name, password_hash, role, status)
       VALUES ($1, 'Repair', $2, $3, $4)`, [crypto.randomUUID(), hash, role, status]),
    (error: unknown) => (error as { code?: unknown }).code === "23514");
  }
  // Simulate an imported pre-CHECK table only inside this disposable owned database.
  await db.query("ALTER TABLE app_accounts DROP CONSTRAINT app_accounts_role_check, DROP CONSTRAINT app_accounts_status_check");
  for (const [role, status] of [["invalid", "active"], ["admin", "invalid"], ["teacher", "invalid"]]) {
    const id = crypto.randomUUID();
    const username = `bad-${id}`;
    const session = createSessionToken();
    await db.query(`INSERT INTO app_accounts (id, username, display_name, password_hash, role, status)
      VALUES ($1, $2, 'Repair bad metadata', $3, $4, $5)`, [id, username, hash, role, status]);
    await db.query("INSERT INTO app_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [id, session.tokenHash]);
    const snapshot = () => db.query("SELECT to_jsonb(a) AS data FROM app_accounts a WHERE id = $1", [id]);
    const before = (await snapshot()).rows;
    await assert.rejects(() => resolvePrincipalById(id, SCHOOL), invalidIdentity);
    await assert.rejects(() => loginWithPassword(username, PASSWORD, SCHOOL), invalidIdentity);
    await assert.rejects(() => loadSessionByToken(session.token, SCHOOL), invalidIdentity);
    await assert.rejects(() => setTeacherStatus(id, "active"), invalidIdentity);
    await assert.rejects(() => resetTeacherPassword(id, hash), invalidIdentity);
    const refused = await loginRoute(request("/api/auth/login", { username, password: PASSWORD }));
    assert.equal(refused.status, 503);
    const config = loadAccountsConfig();
    assert.ok(config);
    assert.equal((await resolveRequestAuth(request("/api/auth/status", {}, session.token), config)).state.kind, "unavailable");
    if (role === "teacher") await assert.rejects(() => listTeachers(), invalidIdentity);
    await assert.rejects(() => db.query(migration()),
      (error: unknown) => (error as { code?: unknown }).code === "23514");
    assert.deepEqual((await snapshot()).rows, before, "migration and mutations must preserve corrupt data");
    const sessions = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM app_sessions WHERE account_id = $1", [id]);
    assert.equal(sessions.rows[0].count, 1, "failed login must write zero new sessions");
    await db.query("DELETE FROM app_accounts WHERE id = $1", [id]); // Exact owned fixture only.
  }
  await db.query(migration());
  await db.query(migration());
  const checks = await db.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint
    WHERE conrelid = 'app_accounts'::regclass AND conname IN ('app_accounts_role_check', 'app_accounts_status_check')`);
  assert.equal(checks.rows.length, 2);
  assert.ok(checks.rows.every((row) => row.convalidated));
}

async function payloadAndRateChecks(db: Client, adminToken: string, classId: string): Promise<void> {
  const counts = async () => (await db.query(`SELECT
    (SELECT count(*)::int FROM app_accounts) AS accounts,
    (SELECT count(*)::int FROM teacher_class_assignments) AS assignments`)).rows;
  const badValues: unknown[] = [null, {}, true, 42, classId, [classId, 42], [classId, null],
    [classId, ""], [classId, " "]];
  for (const class_ids of badValues) {
    const before = await counts();
    const response = await createTeacher(request("/api/admin/teachers", {
      username: crypto.randomUUID(), display_name: "Repair payload", initial_password: PASSWORD, class_ids,
    }, adminToken));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_request");
    assert.deepEqual(await counts(), before, "invalid payload must write zero accounts and assignments");
  }
  for (const body of [null, [], "bad-body"]) {
    const before = await counts();
    assert.equal((await createTeacher(request("/api/admin/teachers", body, adminToken))).status, 400);
    assert.deepEqual(await counts(), before);
  }
  for (const assignment of [{}, { class_ids: [] }, { class_ids: [classId, classId] }]) {
    assert.equal((await createTeacher(request("/api/admin/teachers", {
      username: crypto.randomUUID(), display_name: "Repair valid", initial_password: PASSWORD, ...assignment,
    }, adminToken))).status, 201);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await loginRoute(request("/api/auth/login", {
      username: attempt % 2 ? " ＲＡＴＥＲＥＰＡＩＲ " : "raterepair", password: "Wrong-Password-1!",
    }, undefined, { "x-forwarded-for": `198.51.100.${attempt + 1}, 127.0.0.1` }));
    assert.equal(response.status, attempt < 3 ? 401 : 429, "rotating XFF cannot reopen account bucket");
  }
}

async function cliChecks(db: Client, dbUrl: string, children: TrackedChild[]): Promise<void> {
  const schema = `cli_${crypto.randomBytes(6).toString("hex")}`;
  await db.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.classes (id varchar(36) PRIMARY KEY)`);
  const url = new URL(dbUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const cliDb = new Client({ connectionString: url.toString() });
  await cliDb.connect();
  try {
    await cliDb.query(migration());
    const run = async (stdin: string, args: string[] = []) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts/auth-bootstrap-admin.ts"), ...args], {
        cwd: ROOT, env: { ...process.env, DATABASE_URL: url.toString(), PGDATABASE_URL: "" },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      const tracked = trackChildProcess(child);
      children.push(tracked);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const done = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stdin.on("error", () => { /* Child may reject argv before reading stdin. */ });
      child.stdin.end(stdin);
      const code = await bounded(done, "bootstrap CLI must exit after closing its pool");
      assert.ok(!stdout.includes(PASSWORD) && !stderr.includes(PASSWORD), "password must never be logged");
      assert.ok(!stdout.includes("scrypt$") && !stderr.includes("scrypt$"));
      return { code, stdout };
    };
    const lines = ["cli-repair", "CLI Repair", PASSWORD, PASSWORD];
    for (let count = 0; count < 4; count += 1) {
      const input = count === 0 ? "" : `${lines.slice(0, count).join("\n")}\n`;
      assert.equal((await run(input)).code, 1, `EOF after ${count} lines must fail`);
      assert.equal((await cliDb.query("SELECT id FROM app_accounts")).rows.length, 0);
    }
    assert.equal((await run(`${lines.slice(0, 3).join("\n")}\nMismatch-Password\n`)).code, 1);
    assert.equal((await run("", ["--password"])).code, 1);
    assert.equal((await cliDb.query("SELECT id FROM app_accounts")).rows.length, 0);
    for (const [separator, finalNewline] of [["\n", true], ["\r\n", true], ["\n", false]] as const) {
      const input = lines.join(separator) + (finalNewline ? separator : "");
      assert.equal((await run(input)).code, 0, "prebuffered multiline input must not lose lines");
      const rows = await cliDb.query<{ id: string; password_hash: string }>("SELECT id, password_hash FROM app_accounts");
      assert.equal(rows.rows.length, 1);
      assert.equal(await verifyPassword(PASSWORD, rows.rows[0].password_hash), true, "password stays untrimmed");
      const before = (await cliDb.query("SELECT to_jsonb(a) AS data FROM app_accounts a")).rows;
      assert.equal((await run(input)).code, 2, "existing admin must be refused without hanging");
      assert.deepEqual((await cliDb.query("SELECT to_jsonb(a) AS data FROM app_accounts a")).rows, before);
      await cliDb.query("DELETE FROM app_accounts WHERE id = $1", [rows.rows[0].id]);
    }
  } finally { await cliDb.end(); }
}

async function main(): Promise<void> {
  const interactiveCli = process.argv.includes("--interactive-cli");
  const issues: string[] = [];
  const note = (label: string, detail: string) => { issues.push(`${label}: ${detail}`); };
  let db: IsolatedPostgres | undefined;
  let observer: Client | undefined;
  let guard: ModelRequestGuard | undefined;
  const children: TrackedChild[] = [];
  let failure: unknown;
  try {
    assert.equal(crypto.createHash("sha1").update(Buffer.concat([
      Buffer.from(`blob ${fs.statSync(path.join(ROOT, "scripts/harness-safety.ts")).size}\0`),
      fs.readFileSync(path.join(ROOT, "scripts/harness-safety.ts")),
    ])).digest("hex"), "6702f2ddf3b436e79f8c92ae8756c33f611a8503");
    offlineChecks();
    guard = await startModelRequestGuard();
    Object.assign(process.env, modelGuardEnv(guard));
    db = await startIsolatedPostgres({ runId: RUN_ID, containerName: `cga-${RUN_ID}`,
      dbName: "cga_auth_core_repairs", labelKey: "cga.auth.core.repairs", noteIssue: note });
    delete process.env.PGDATABASE_URL;
    process.env.DATABASE_URL = db.url;
    process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;
    process.env.AUTH_SCHOOL_ID = SCHOOL;
    process.env.AUTH_COOKIE_SECURE = "false";
    process.env.AUTH_LOGIN_RATE_LIMIT_MAX = "3";
    observer = new Client({ connectionString: db.url });
    await observer.connect();
    // Minimal auth-only schema; no business seed or model route is needed.
    await observer.query("CREATE TABLE classes (id varchar(36) PRIMARY KEY)");
    await observer.query(migration());
    await observer.query(migration());
    const classId = crypto.randomUUID();
    await observer.query("INSERT INTO classes (id) VALUES ($1)", [classId]);
    if (interactiveCli) {
      assert.equal(process.stdin.isTTY, true, "interactive check requires a real terminal");
      const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts/auth-bootstrap-admin.ts")], {
        cwd: ROOT, env: { ...process.env }, stdio: "inherit", windowsHide: true,
      });
      children.push(trackChildProcess(child));
      const code = await bounded(new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }), "interactive bootstrap", 30_000);
      assert.equal(code, 0);
      const rows = await observer.query<{ password_hash: string; username: string }>(
        "SELECT password_hash, username FROM app_accounts");
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].username, "cli-tty-repair");
      assert.equal(await verifyPassword(PASSWORD, rows.rows[0].password_hash), true);
    } else {
      const [originalHash, rotatedHash, secondAdminHash] = await Promise.all([
        hashPassword(PASSWORD), hashPassword(ROTATED_PASSWORD), hashPassword(PASSWORD),
      ]);
      await metadataChecks(observer, originalHash);
      await cliChecks(observer, db.url, children);
      // Establish the app pool before installing the test-only connection barrier.
      await resolvePrincipalById(crypto.randomUUID(), SCHOOL);
      await checkInitialAdminRace(observer, SCHOOL, [
        { username: "repair-admin", displayName: "Repair admin", passwordHash: originalHash },
        { username: "repair-admin-second", displayName: "Repair admin second", passwordHash: secondAdminHash },
      ]);
      const admin = await loginWithPassword("repair-admin", PASSWORD, SCHOOL);
      assert.equal(admin.kind, "ok");
      if (admin.kind !== "ok") throw new Error("isolated admin login failed");
      await payloadAndRateChecks(observer, admin.token, classId);
      await checkLoginMutationOrders(observer, SCHOOL, admin.principal.account_id, originalHash, rotatedHash,
        PASSWORD, ROTATED_PASSWORD);
    }
    assert.equal(guard.hits, 0);
  } catch (error) { failure = error; }
  await runCleanupSteps([
    ...children.map((child) => ({ label: `cli-${child.pid}`, run: () => stopTrackedChildTree(child) })),
    { label: "app-pool", run: async () => {
      if (globalThis.__pgPool) { await globalThis.__pgPool.end(); globalThis.__pgPool = undefined; }
    } },
    { label: "observer", run: async () => { await observer?.end(); } },
    { label: "owned-postgres", run: () => db?.teardown() },
    { label: "model-guard", run: async () => { await guard?.close(); } },
  ], note);
  assertCleanupComplete(issues);
  if (failure) throw failure;
  console.log(JSON.stringify({ run_id: RUN_ID, container_id: db?.containerId,
    repairs: interactiveCli ? null : 5, real_db: true, route_handlers: !interactiveCli, real_http: false,
    lock_orders: interactiveCli ? 0 : 4, bootstrap_lock_race: !interactiveCli,
    cli_stdin: !interactiveCli, interactive_tty: interactiveCli ? "real_terminal_verified" : "NOT_RUN",
    model_requests: guard?.hits ?? null, cleanup_verified: true }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
