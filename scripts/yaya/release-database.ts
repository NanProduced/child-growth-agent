/** Authorized release backup/restore/dry-run. Production changes require --apply. */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { inspectOwnedContainer, nativeCommand, parseContainerIdFromStdout, removeOwnedContainer, runCleanupSteps, startIsolatedPostgres, type IsolatedPostgres } from '../harness-safety';

const PROJECT = '7690843235199139866', TARGET = 'fb9bdaade52916a4';
const RUN = 'release-' + randomUUID().slice(0, 8), LABEL = 'cga.release.backup';
const DUMP_NAME = 'cga-release-dump-' + RUN;
const ROOT = process.cwd(), DIR = path.join(ROOT, 'logs/release', RUN);
const APPLY = process.argv.includes('--apply');
const FILES = ['upgrade-agent-context.sql', 'upgrade-growth-profile.sql', 'upgrade-guide-evidence-v1.sql', 'upgrade-auth-v1.sql', 'upgrade-yaya-v1.sql', 'upgrade-yaya-runs-v1.sql', 'upgrade-yaya-chat-bind-v1.sql'];
type TableFact = { table: string; columns: string[]; count: number; digest: string };
const q = (id: string) => '"' + id.replaceAll('"', '""') + '"';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function protectedDirectory(): void {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const r = nativeCommand('icacls', [DIR, '/inheritance:r', '/grant:r', os.userInfo().username + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F']);
    if (r.status !== 0) throw Error('Cannot protect backup directory');
  }
}

function productionUrl(): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'coze code env list -p ' + PROJECT + ' --env prod --format json'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) throw Error('Cannot load named project production configuration');
  const rows: unknown = JSON.parse(r.stdout);
  assert.ok(Array.isArray(rows));
  const entry = rows.find(row => row && typeof row === 'object' && row.secret_key === 'DATABASE_URL');
  assert.ok(entry && typeof entry.secret_val === 'string');
  const url = new URL(entry.secret_val);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(hash(url.hostname + url.pathname).slice(0, 16), TARGET);
  return entry.secret_val;
}

async function facts(c: Client, baseline?: TableFact[]): Promise<TableFact[]> {
  const names = baseline?.map(t => t.table) ?? (await c.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(t => t.table_name);
  const output: TableFact[] = [];
  for (const table of names) {
    const columns = baseline?.find(t => t.table === table)?.columns ?? (await c.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map(x => x.column_name);
    const rows = (await c.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(t) AS data FROM (SELECT ' + columns.map(q).join(',') + ' FROM public.' + q(table) + ' ORDER BY id) t')).rows;
    output.push({ table, columns, count: rows.length, digest: hash(JSON.stringify(rows.map(row => row.data))) });
  }
  return output;
}

async function childBytes(args: string[], input: string | Buffer): Promise<Buffer> {
  const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  // Diagnostic bytes can contain endpoint/identity details. Never print them.
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
  const status = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
  if (status !== 0) throw Error('Owned database utility failed');
  return Buffer.concat(chunks);
}

async function migrations(c: Client, current?: (file: string) => void): Promise<void> {
  for (const file of FILES) { current?.(file); await c.query(fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8')); }
}

async function main(): Promise<void> {
  protectedDirectory();
  const url = productionUrl(), p = new URL(url);
  const source = new Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  let isolated: IsolatedPostgres | null = null, restore: Client | null = null, dumpId: string | null = null;
  let dumpAttempted = false;
  const issues: string[] = [];
  const ownedRun = (file: string, args: string[]) => nativeCommand(file, file === 'docker' && args[0] === 'rm' ? [...args.slice(0, 2), '-v', ...args.slice(2)] : args);
  let stage = 'snapshot';
  try {
    await source.connect();
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await source.query("SET LOCAL timezone='UTC'; SET LOCAL statement_timeout='30s'");
    const baseline = await facts(source);
    assert.deepEqual(baseline.map(t => t.table), ['child_class_enrollments', 'children', 'classes', 'health_check', 'observations']);
    const version = Number((await source.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]!.server_version_num);
    const image = version < 170000 ? 'postgres:16-alpine' : 'postgres:18-alpine';
    const snapshot = (await source.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')).rows[0]!.snapshot;
    assert.ok(/^[A-F0-9-]+$/i.test(snapshot));
    const pgpass = [p.hostname, p.port || '5432', decodeURIComponent(p.pathname.slice(1)), decodeURIComponent(p.username), decodeURIComponent(p.password)].map(v => { assert.ok(!/[\r\n]/.test(v)); return v.replace(/[\\:]/g, '\\$&'); }).join(':');
    const shell = 'umask 077; IFS= read -r PGHOST; IFS= read -r PGPORT; IFS= read -r PGDATABASE; IFS= read -r PGUSER; IFS= read -r passline; IFS= read -r snapshot; printf "%s\\n" "$passline" > /tmp/release.pgpass; export PGHOST PGPORT PGDATABASE PGUSER; export PGPASSFILE=/tmp/release.pgpass PGSSLMODE=verify-full PGSSLROOTCERT=/etc/ssl/cert.pem; exec pg_dump --format=custom --schema=public --snapshot="$snapshot"';
    dumpAttempted = true;
    const created = nativeCommand('docker', ['create', '--name', DUMP_NAME, '--label', LABEL + '=' + RUN, '--entrypoint', 'sh', '-i', image, '-c', shell]);
    dumpId = parseContainerIdFromStdout(created.stdout);
    assert.ok(created.status === 0 && dumpId);
    const checked = inspectOwnedContainer(dumpId, LABEL);
    assert.ok(checked.state === 'verified' && checked.label === RUN);
    console.log(JSON.stringify({ stage: 'backup', run: RUN, version, target: TARGET, counts: baseline.map(t => ({ table: t.table, count: t.count })) }));
    const dump = await childBytes(['start', '-a', '-i', dumpId], [p.hostname, p.port || '5432', decodeURIComponent(p.pathname.slice(1)), decodeURIComponent(p.username), pgpass, snapshot, ''].join('\n'));
    await source.query('ROLLBACK');
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(dump), cipher.final()]);
    fs.writeFileSync(path.join(DIR, 'backup.key'), key, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(DIR, 'public.dump.aes'), encrypted, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify({ run: RUN, project_id: PROJECT, target: TARGET, snapshot_at: new Date().toISOString(), baseline, dump_digest: hash(dump), encrypted_digest: hash(encrypted), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), migration_files: FILES.map(file => ({ file, digest: hash(fs.readFileSync(path.join(ROOT, 'scripts', file))) })) }, null, 2), { flag: 'wx' });
    stage = 'restore';
    isolated = await startIsolatedPostgres({ runId: RUN, labelKey: 'cga.release.restore', containerName: 'cga-release-restore-' + RUN, dbName: 'yaya_release_restore', noteIssue: (label, issue) => issues.push(label + ':' + issue), run: (file, args) => ownedRun(file, args.map(a => a === 'postgres:16-alpine' ? image : a)) });
    const decipher = createDecipheriv('aes-256-gcm', fs.readFileSync(path.join(DIR, 'backup.key')), iv); decipher.setAuthTag(cipher.getAuthTag());
    const restoredBytes = Buffer.concat([decipher.update(fs.readFileSync(path.join(DIR, 'public.dump.aes'))), decipher.final()]);
    assert.equal(hash(restoredBytes), hash(dump));
    await childBytes(['exec', '-i', isolated.containerId, 'pg_restore', '--clean', '--if-exists', '--no-owner', '--no-privileges', '-U', 'postgres', '-d', 'yaya_release_restore'], restoredBytes);
    restore = new Client({ connectionString: isolated.url }); await restore.connect(); await restore.query("SET timezone='UTC'");
    assert.deepEqual(await facts(restore, baseline), baseline);
    stage = 'dry-run';
    await restore.query('BEGIN'); await migrations(restore); await restore.query('COMMIT');
    await restore.query('BEGIN'); await migrations(restore); await restore.query('COMMIT');
    assert.deepEqual(await facts(restore, baseline), baseline);
    const newTables = (await restore.query<{ n: string }>("SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'yaya_%' OR table_name IN ('app_accounts','app_sessions','teacher_class_assignments'))")).rows[0]!.n;
    assert.equal(Number(newTables), 14);
    fs.writeFileSync(path.join(DIR, 'restore-verified.json'), JSON.stringify({ verified: true, old_rows_and_columns_unchanged: true, migration_twice: true, new_tables: Number(newTables), production_changed: false }, null, 2));
    console.log(JSON.stringify({ stage: 'restored-and-migration-dry-run', verified: true, directory: DIR, new_tables: Number(newTables) }));
    if (APPLY) {
      const applicationBaseline = baseline.filter(t => t.table !== 'health_check');
      stage = 'production-migration';
      await source.query('BEGIN'); await source.query("SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
      stage = 'production-lock';
      // health_check belongs to the platform and is read-only to this account.
      // Only the four application tables are modified/locked; never widen grants.
      await source.query('LOCK TABLE public.children, public.classes, public.child_class_enrollments, public.observations IN ACCESS EXCLUSIVE MODE');
      // Concurrent changes since the backup abort the release, never overwrite them.
      assert.deepEqual(await facts(source, applicationBaseline), applicationBaseline);
      await migrations(source, file => { stage = 'production-ddl:' + file; });
      assert.deepEqual(await facts(source, applicationBaseline), applicationBaseline);
      await source.query('COMMIT');
      fs.writeFileSync(path.join(DIR, 'production-migration.json'), JSON.stringify({ committed: true, target: TARGET, preserved: applicationBaseline.map(t => ({ table: t.table, count: t.count, digest: t.digest })), platform_health_table_untouched: true, executed_at: new Date().toISOString() }, null, 2));
      console.log(JSON.stringify({ stage, committed: true, old_data_unchanged: true }));
      // Reuse the non-public AUTH bootstrap; do not overwrite any existing admin.
      process.env.DATABASE_URL = url; process.env.AUTH_SCHOOL_ID = 'single-school';
      const { bootstrapStatus, bootstrapInitialAdmin } = await import('../../src/lib/accounts/bootstrap');
      if (!(await bootstrapStatus()).admin_initialized) {
        stage = 'admin-bootstrap';
        const password = randomBytes(24).toString('base64url');
        const credentials = path.join(DIR, 'admin-credentials.json');
        fs.writeFileSync(credentials, JSON.stringify({ username: 'admin', password, state: 'pending', origin: 'https://childgrowth.coze.site' }, null, 2), { flag: 'wx', mode: 0o600 });
        const admin = await bootstrapInitialAdmin({ username: 'admin', display_name: '园所管理员', password });
        fs.writeFileSync(credentials, JSON.stringify({ username: 'admin', password, state: 'created', account_id: admin.principal.account_id, origin: 'https://childgrowth.coze.site' }, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ admin_initialized: true, username: 'admin', credential_file: path.join(DIR, 'admin-credentials.json') }));
      } else console.log(JSON.stringify({ admin_already_initialized: true, overwritten: false }));
    }
  } catch (error) {
    await source.query('ROLLBACK').catch(() => undefined); await restore?.query('ROLLBACK').catch(() => undefined);
    const pgError = error as { code?: unknown; constraint?: unknown; table?: unknown; routine?: unknown };
    console.error(JSON.stringify({ failed_stage: stage, error_type: error instanceof Error ? error.name : 'unknown', code: typeof pgError.code === 'string' ? pgError.code : null, table: typeof pgError.table === 'string' ? pgError.table : null, constraint: typeof pgError.constraint === 'string' ? pgError.constraint : null, routine: typeof pgError.routine === 'string' ? pgError.routine : null, directory: DIR, sensitive_error_details_omitted: true })); process.exitCode = 1;
  } finally {
    await runCleanupSteps([
      { label: 'restore-client', run: async () => { await restore?.end(); } },
      { label: 'source-client', run: async () => { await source.end(); } },
      { label: 'bootstrap-pool', run: async () => { if (globalThis.__pgPool) { await globalThis.__pgPool.end(); globalThis.__pgPool = undefined; } } },
      { label: 'restore-container', run: () => { if (isolated) { const r = isolated.teardown(); if (!r.ok) throw Error(r.detail); } } },
      { label: 'dump-container', run: () => { if (dumpAttempted) { const r = removeOwnedContainer(dumpId, { fallbackName: DUMP_NAME, labelKey: LABEL, runId: RUN, run: ownedRun }); if (!r.ok) throw Error(r.detail); } } },
    ], (label, issue) => issues.push(label + ':' + issue));
    console.log(JSON.stringify({ cleanup: issues.length ? 'failed' : 'verified', issues, encrypted_backup_retained: DIR }));
    if (issues.length) process.exitCode = 1;
  }
}
void main().catch(error => { console.error(JSON.stringify({ fatal_type: error instanceof Error ? error.name : 'unknown' })); process.exitCode = 1; });
