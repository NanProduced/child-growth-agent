/** One named project's additive release: encrypted backup, real restore, dry-run, optional apply. */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";
import { inspectOwnedContainer, nativeCommand, parseContainerIdFromStdout, removeOwnedContainer, startIsolatedPostgres, type IsolatedPostgres } from "./harness-safety";

const PROJECT = "7690843235199139866", TARGET = "fb9bdaade52916a4";
const ROOT = process.cwd(), RUN = `family-release-${randomUUID()}`, DIR = path.join(ROOT, "logs/release", RUN);
const LABEL = "cga.family.release.backup", DUMP_NAME = `cga-family-dump-${RUN}`;
const APPLY = process.argv.includes("--apply"), FILE = "scripts/upgrade-family-communication-v1.sql";
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
type Fact = { table: string; columns: string[]; count: number; digest: string };

function productionUrl(): string {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `coze code env list -p ${PROJECT} --env prod --format json`], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, "Project configuration unavailable");
  const rows: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(rows));
  const entry: unknown = rows.find((row: unknown) => row && typeof row === "object" && "secret_key" in row && row.secret_key === "DATABASE_URL");
  assert.ok(entry && typeof entry === "object" && "secret_val" in entry && typeof entry.secret_val === "string");
  const url = new URL(entry.secret_val);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(sha(url.hostname + url.pathname).slice(0, 16), TARGET, "Production target changed");
  return entry.secret_val;
}

async function facts(client: Client, baseline?: Fact[]): Promise<Fact[]> {
  const names = baseline?.map((item) => item.table) ?? (await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map((row) => row.table_name);
  const result: Fact[] = [];
  for (const table of names) {
    const columns = (await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map((row) => row.column_name);
    const old = baseline?.find((item) => item.table === table);
    if (old) assert.deepEqual(columns, old.columns, "Existing table columns changed");
    const rows = (await client.query<{ data: unknown[] }>(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS data FROM (SELECT ${columns.map(quote).join(",")} FROM public.${quote(table)}) t`)).rows[0]!.data;
    result.push({ table, columns, count: rows.length, digest: sha(JSON.stringify(rows)) });
  }
  return result;
}

async function utility(args: string[], input: string | Buffer): Promise<Buffer> {
  const child = spawn("docker", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.resume(); // Database utility diagnostics can contain endpoint identities.
  child.stdin.on("error", () => undefined); child.stdin.end(input);
  const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (value) => resolve(value ?? 1)); });
  assert.equal(code, 0, "Owned database utility failed");
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") assert.equal(nativeCommand("icacls", [DIR, "/inheritance:r", "/grant:r", `${os.userInfo().username}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]).status, 0);
  const url = productionUrl(), parsed = new URL(url);
  const source = new Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  let restore: Client | undefined, isolated: IsolatedPostgres | undefined, dumpId: string | null = null;
  let stage = "snapshot", dumpAttempted = false;
  const cleanup: string[] = [];
  const ownedCommand: typeof nativeCommand = (file, args) => nativeCommand(file, file === "docker" && args[0] === "rm" ? [...args.slice(0, 2), "-v", ...args.slice(2)] : args);
  try {
    await source.connect();
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await source.query("SET LOCAL timezone='UTC'; SET LOCAL statement_timeout='30s'");
    const baseline = await facts(source);
    assert.ok(["children", "observations", "app_accounts", "app_sessions", "yaya_messages"].every((table) => baseline.some((item) => item.table === table)));
    const version = Number((await source.query<{ server_version_num: string }>("SHOW server_version_num")).rows[0]!.server_version_num);
    assert.ok(version >= 160000 && version < 190000);
    const image = "postgres:18-alpine";
    const snapshot = (await source.query<{ snapshot: string }>("SELECT pg_export_snapshot() AS snapshot")).rows[0]!.snapshot;
    assert.ok(/^[A-F0-9-]+$/i.test(snapshot));
    const values = [parsed.hostname, parsed.port || "5432", decodeURIComponent(parsed.pathname.slice(1)), decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)];
    assert.ok(values.every((value) => !/[\r\n]/.test(value)));
    const pgpass = values.map((value) => value.replace(/[\\:]/g, "\\$&")).join(":");
    const shell = 'umask 077; IFS= read -r PGHOST; IFS= read -r PGPORT; IFS= read -r PGDATABASE; IFS= read -r PGUSER; IFS= read -r passline; IFS= read -r snapshot; printf "%s\\n" "$passline" > /tmp/family-release.pgpass; export PGHOST PGPORT PGDATABASE PGUSER; export PGPASSFILE=/tmp/family-release.pgpass PGSSLMODE=verify-full PGSSLROOTCERT=/etc/ssl/cert.pem; exec pg_dump --format=custom --schema=public --snapshot="$snapshot"';
    dumpAttempted = true;
    const created = nativeCommand("docker", ["create", "--name", DUMP_NAME, "--label", `${LABEL}=${RUN}`, "--entrypoint", "sh", "-i", image, "-c", shell]);
    dumpId = parseContainerIdFromStdout(created.stdout); assert.ok(created.status === 0 && dumpId);
    const identity = inspectOwnedContainer(dumpId, LABEL); assert.ok(identity.state === "verified" && identity.label === RUN);
    const dump = await utility(["start", "-a", "-i", dumpId], [...values.slice(0, 4), pgpass, snapshot, ""].join("\n"));
    await source.query("ROLLBACK");
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(dump), cipher.final()]), tag = cipher.getAuthTag();
    fs.writeFileSync(path.join(DIR, "backup.key"), key, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(DIR, "public.dump.aes"), encrypted, { flag: "wx", mode: 0o600 });
    const sql = fs.readFileSync(path.join(ROOT, FILE), "utf8"), migrationHash = sha(sql);
    assert.equal((sql.match(/^BEGIN;\s*$/gm) ?? []).length, 1); assert.equal((sql.match(/^COMMIT;\s*$/gm) ?? []).length, 1);
    const body = sql.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, ""); // Only remove whole-script transaction wrappers; no DDL is selected or omitted.
    fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify({ run: RUN, project_id: PROJECT, target: TARGET, version, baseline, dump_digest: sha(dump), encrypted_digest: sha(encrypted), iv: iv.toString("hex"), tag: tag.toString("hex"), migration: FILE, migration_digest: migrationHash }, null, 2), { flag: "wx" });
    stage = "restore-and-dry-run";
    isolated = await startIsolatedPostgres({ runId: RUN, labelKey: "cga.family.release.restore", containerName: `cga-family-restore-${RUN}`, dbName: "family_release_restore", noteIssue: (label, issue) => cleanup.push(`${label}:${issue}`), run: (file, args) => ownedCommand(file, args.map((arg) => arg === "postgres:16-alpine" ? image : arg)) });
    const decipher = createDecipheriv("aes-256-gcm", fs.readFileSync(path.join(DIR, "backup.key")), iv); decipher.setAuthTag(tag);
    const restored = Buffer.concat([decipher.update(fs.readFileSync(path.join(DIR, "public.dump.aes"))), decipher.final()]);
    assert.equal(sha(restored), sha(dump));
    await utility(["exec", "-i", isolated.containerId, "pg_restore", "--clean", "--if-exists", "--no-owner", "--no-privileges", "-U", "postgres", "-d", "family_release_restore"], restored);
    restore = new Client({ connectionString: isolated.url }); await restore.connect(); await restore.query("SET timezone='UTC'");
    assert.deepEqual(await facts(restore, baseline), baseline);
    for (let i = 0; i < 2; i++) { await restore.query("BEGIN"); await restore.query(body); await restore.query("COMMIT"); }
    assert.deepEqual(await facts(restore, baseline), baseline);
    assert.ok((await restore.query("SELECT to_regclass('public.family_communications') AS name")).rows[0].name);
    // A failure after the same DDL must roll back, including on a clean schema.
    await restore.query("DROP TABLE family_communications"); await restore.query("BEGIN"); await restore.query(body);
    await assert.rejects(restore.query("SELECT 1/0")); await restore.query("ROLLBACK");
    assert.equal((await restore.query("SELECT to_regclass('public.family_communications') AS name")).rows[0].name, null);
    assert.deepEqual(await facts(restore, baseline.filter((item) => item.table !== "family_communications")), baseline.filter((item) => item.table !== "family_communications"));
    fs.writeFileSync(path.join(DIR, "dry-run.json"), JSON.stringify({ restored: true, preserved: true, migration_twice: true, rollback_verified: true, production_changed: false }));
    if (APPLY) {
      stage = "production-migration";
      const protectedFacts = baseline.filter((item) => item.table !== "health_check");
      assert.equal(sha(fs.readFileSync(path.join(ROOT, FILE))), migrationHash);
      await source.query("BEGIN"); await source.query("SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
      await source.query(`LOCK TABLE ${protectedFacts.map((item) => `public.${quote(item.table)}`).join(",")} IN SHARE MODE`);
      assert.deepEqual(await facts(source, protectedFacts), protectedFacts, "Live data changed since backup; release must stop");
      await source.query(body);
      assert.deepEqual(await facts(source, protectedFacts), protectedFacts);
      await source.query("COMMIT");
      fs.writeFileSync(path.join(DIR, "production-migration.json"), JSON.stringify({ committed: true, target: TARGET, preserved_tables: protectedFacts.map(({ table, count, digest }) => ({ table, count, digest })), migration_digest: migrationHash, health_table_untouched: true }, null, 2));
    }
    console.log(JSON.stringify({ run: RUN, directory: DIR, target: TARGET, backed_up: true, restored: true, dry_run: true, applied: APPLY, old_app_data: "byte-identical", tables: baseline.map(({ table, count }) => ({ table, count })) }));
  } catch (error: unknown) {
    await source.query("ROLLBACK").catch(() => undefined); await restore?.query("ROLLBACK").catch(() => undefined);
    console.error(JSON.stringify({ failed_stage: stage, error_type: error instanceof Error ? error.name : "unknown", code: error && typeof error === "object" && "code" in error ? error.code : null, directory: DIR, sensitive_details_omitted: true })); process.exitCode = 1;
  } finally {
    await restore?.end().catch(() => cleanup.push("restore-client")); await source.end().catch(() => cleanup.push("source-client"));
    if (isolated) { const result = isolated.teardown(); if (!result.ok) cleanup.push("restore-container"); }
    if (dumpAttempted) { const result = removeOwnedContainer(dumpId, { fallbackName: DUMP_NAME, labelKey: LABEL, runId: RUN, run: ownedCommand }); if (!result.ok) cleanup.push("dump-container"); }
    fs.writeFileSync(path.join(DIR, "cleanup.json"), JSON.stringify({ verified: cleanup.length === 0, issues: cleanup }));
    if (cleanup.length) process.exitCode = 1;
    console.log(JSON.stringify({ cleanup: cleanup.length ? "unverified" : "verified" }));
  }
}
void main().catch(() => { console.error("Release preparation failed; no secret details printed"); process.exitCode = 1; });
