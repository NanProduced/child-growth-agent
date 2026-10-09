/** PLATFORM-UX-FIX1: production Next + owned QA seed; never run concurrently with another build. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";

import { createAcceptanceSeed, AcceptanceSeedError, type AcceptanceSeedHandle } from "../yaya/acceptance/seed";
import {
  assertCleanupComplete, findListeningPids, modelGuardEnv, restoreGeneratedArtifacts,
  runCleanupSteps, snapshotGeneratedArtifacts, startModelRequestGuard,
  stopTrackedChildTree, trackChildProcess, waitForChildExit, waitForVerifiedService,
  type ModelRequestGuard, type TrackedChild,
} from "../harness-safety";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const protocolRecheck = process.argv.includes("--protocol-recheck");
const copyReview = process.argv.includes("--copy-review");
const requireModule = createRequire(import.meta.url);
const credentialSchema = z.object({ seed_id: z.string(), accounts: z.object({
  teacher_a: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  admin: z.object({ username: z.string().min(1), password: z.string().min(1) }),
}) });

async function unusedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const listeners = findListeningPids(address.port);
  assert(listeners.ok && listeners.pids.length === 0, "Reserved port must still be unoccupied");
  return address.port;
}

async function main(): Promise<void> {
  // No caller-supplied DB URL, no .env reading, no package installation or mock route writes.
  const playwright = process.env.PLAYWRIGHT_CORE_DIR;
  assert(playwright && path.isAbsolute(playwright), "Set PLAYWRIGHT_CORE_DIR to existing playwright-core dependencies");
  const nextBin = requireModule.resolve("next/dist/bin/next");
  requireModule.resolve(path.join(playwright, "playwright-core"));
  const run = `${copyReview ? "platform-copy2" : "platform-ux-fix1"}-${randomUUID()}`;
  const parent = path.join(ROOT, "output", "playwright");
  fs.mkdirSync(parent, { recursive: true });
  // An exclusive runner lock is not permission to kill another process or remove its lock.
  const lockPath = path.join(parent, "platform-ux-fixes.lock");
  const lock = fs.openSync(lockPath, "wx");
  const out = path.join(parent, run);
  let snapshot: ReturnType<typeof snapshotGeneratedArtifacts> | undefined;
  let seed: AcceptanceSeedHandle | undefined;
  let guard: ModelRequestGuard | undefined;
  let server: TrackedChild | undefined;
  let worker: TrackedChild | undefined;
  let database: Client | undefined;
  let stage = "preflight", failure: string | null = null;
  let completed = false;
  const cleanupIssues: string[] = [];
  const ownedProcesses: Array<{ pid: number; started_at: string | null }> = [];
  const abort = new AbortController();
  const onSignal = (): void => { abort.abort(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const interruptible = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const interrupted = (): void => reject(new Error("Runner interrupted; owned resources require cleanup"));
    if (abort.signal.aborted) { interrupted(); return; }
    abort.signal.addEventListener("abort", interrupted, { once: true });
    promise.then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", interrupted));
  });
  let before = "";
  // Discard inherited provider/database/Node preloads. All provider paths are explicitly local.
  const processEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramFiles|ProgramFiles\(x86\)|PNPM_HOME|HOME|LANG)$/i.test(key))) };
  const spawnOwned = (args: string[], env: NodeJS.ProcessEnv): TrackedChild => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    // Drain diagnostics without retaining request bodies, query strings, passwords or connection strings.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    const tracked = trackChildProcess(child);
    ownedProcesses.push({ pid: tracked.pid, started_at: tracked.startedAt });
    return tracked;
  };
  try {
    fs.writeFileSync(lock, run);
    fs.mkdirSync(out);
    snapshot = snapshotGeneratedArtifacts(ROOT);
    guard = await startModelRequestGuard();
    const guardedEnv = modelGuardEnv(guard, {
      ...processEnv, PGDATABASE_URL: "", DATABASE_URL: "", NODE_ENV: "production",
      COZE_API_TOKEN: "", COZE_WORKLOAD_IDENTITY_API_KEY: "", YAYA_PLATFORM_AUTH: "",
      YAYA_CHAT_TEXT_PROVIDER: "stepfun", YAYA_CHAT_IMAGE_PROVIDER: "stepfun",
      MEDIA_STORAGE_MODE: "local", MEDIA_ENVIRONMENT: "development", NEXT_TELEMETRY_DISABLED: "1",
    });
    stage = "seed";
    // Do not race seed creation: allow it to return its owned handle (or perform its own cleanup).
    seed = await createAcceptanceSeed();
    assert(!abort.signal.aborted, "Runner was interrupted during resource preparation");
    assert(seed.verification.failed === 0, "Owned QA seed fact checks must pass");
    const credentials = credentialSchema.parse(JSON.parse(fs.readFileSync(seed.credentials_path, "utf8")));
    assert.equal(credentials.seed_id, seed.seed_id, "Credential file must belong to this seed");
    database = new Client({ connectionString: seed.database_url });
    await database.connect();
    // Only this seed's DB: family entry read requires its table; no family generation is exercised.
    await database.query(fs.readFileSync(path.join(ROOT, "scripts/upgrade-family-communication-v1.sql"), "utf8"));
    let copyFixtures: { duplicate_child_id: string; birth_date: string; class_name: string } | null = null;
    if (copyReview) {
      // Owned seed only: long names and same-class same-name choices; no real/demo data.
      copyFixtures = { duplicate_child_id: randomUUID(), birth_date: "2023-07-12", class_name: `春日观察与游戏探索活动班（${seed.manifest.classes.class_a.name}）` };
      await database.query("UPDATE classes SET name=$1 WHERE id=$2", [copyFixtures.class_name, seed.manifest.classes.class_a.id]);
      await database.query("INSERT INTO children(id,name,gender,birth_date,class_name,is_demo) VALUES($1,$2,'女',$3,$4,true)",
        [copyFixtures.duplicate_child_id, seed.manifest.children.class_a_same_name.name, copyFixtures.birth_date, copyFixtures.class_name]);
      await database.query("INSERT INTO child_class_enrollments(child_id,class_id,start_date) VALUES($1,$2,$3)",
        [copyFixtures.duplicate_child_id, seed.manifest.classes.class_a.id, seed.manifest.semester.start_date]);
    }
    const readFacts = async (): Promise<string> => JSON.stringify((await database!.query(
      "SELECT (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM observations o) AS observations, " +
      "(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM yaya_messages m) AS messages, " +
      "(SELECT count(*) FROM family_communications) AS family_count")).rows);
    before = await readFacts();
    const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
    const env = { ...guardedEnv, DATABASE_URL: seed.database_url, AUTH_TRUSTED_ORIGINS: base,
      AUTH_SCHOOL_ID: seed.manifest.school_id, AUTH_COOKIE_SECURE: "false", MEDIA_LOCAL_ROOT: seed.object_root };
    stage = "production-build";
    if (protocolRecheck) {
      // Recheck caller timing only: no UI edits, screenshots, or additional design/build pass.
      const builtAt = fs.statSync(path.join(ROOT, ".next", "BUILD_ID")).mtimeMs;
      const verifyUnchangedSource = (directory: string): void => {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, item.name);
          if (item.isDirectory()) verifyUnchangedSource(file);
          else assert(fs.statSync(file).mtimeMs <= builtAt, "Product source changed after the production build; refuse reuse");
        }
      };
      verifyUnchangedSource(path.join(ROOT, "src"));
      for (const file of ["package.json", "pnpm-lock.yaml", "next.config.ts"]) {
        assert(fs.statSync(path.join(ROOT, file)).mtimeMs <= builtAt, "Build input changed; refuse reuse");
      }
    } else {
      worker = spawnOwned([nextBin, "build", "--webpack"], env);
      worker.proc.stdin?.end();
      assert(await interruptible(waitForChildExit(worker, 300_000)) && worker.exit?.code === 0, "Production build failed or timed out");
      const buildCleanup = await stopTrackedChildTree(worker);
      assert(buildCleanup.ok, "Build process tree could not be verified clean");
      worker = undefined;
    }
    stage = "production-server";
    const listeners = findListeningPids(port);
    assert(listeners.ok && listeners.pids.length === 0, "Port became occupied; refuse takeover");
    server = spawnOwned([nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], env);
    server.proc.stdin?.end();
    await interruptible(waitForVerifiedService({ base, port, child: server, timeoutMs: 90_000 }));
    stage = "browser";
    worker = spawnOwned([path.join(ROOT, "scripts/acceptance/check-platform-ux-fixes.cjs")], processEnv);
    worker.proc.stdin?.end(JSON.stringify({ base, out, playwright, run, protocol_recheck: protocolRecheck, copy_review: copyReview, copy_fixtures: copyFixtures, credentials: credentials.accounts,
      manifest: { seed_id: seed.seed_id, classes: seed.manifest.classes, children: seed.manifest.children,
        guide_items: seed.manifest.guide_items, accounts: seed.manifest.accounts, observations: seed.manifest.observations } }));
    assert(await interruptible(waitForChildExit(worker, 900_000)) && worker.exit?.code === 0, "Browser checks failed or timed out; inspect results.json");
    const browserCleanup = await stopTrackedChildTree(worker);
    assert(browserCleanup.ok, "Browser worker tree could not be verified clean");
    worker = undefined;
    stage = "read-only-closeout";
    assert.equal(await readFacts(), before, "Observation/message/family facts changed during read-only browser checks");
    assert.equal(guard.hits, 0, "Unexpected model attempts are failures, even when denied locally");
    completed = true;
  } catch (error) {
    failure = `${stage}:${error instanceof Error ? error.name : "unknown_error"}`;
    if (error instanceof AcceptanceSeedError && !error.cleanup_ok) cleanupIssues.push("seed preparation cleanup unverified");
  } finally {
    await runCleanupSteps([
      { label: "browser-or-build", run: async () => worker ? stopTrackedChildTree(worker) : undefined },
      { label: "production-server", run: async () => server ? stopTrackedChildTree(server) : undefined },
      { label: "database-client", run: async () => { await database?.end(); } },
      { label: "qa-seed", timeoutMs: 60_000, run: async () => { await seed?.teardown(); } },
      { label: "provider-guard", run: async () => { await guard?.close(); } },
      { label: "generated-artifacts", run: () => {
        if (snapshot) cleanupIssues.push(...restoreGeneratedArtifacts(snapshot, ROOT).issues.map(() => "generated artifact restoration unverified"));
      } },
      { label: "runner-lock", run: () => {
        fs.closeSync(lock);
        assert.equal(fs.readFileSync(lockPath, "utf8"), run, "Runner lock identity changed; do not remove");
        fs.unlinkSync(lockPath);
      } },
    ], (label) => cleanupIssues.push(`${label}:cleanup_unverified`));
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    const report = { run, protocol_recheck: protocolRecheck, copy_review: copyReview, completed: completed && guard?.hits === 0 && cleanupIssues.length === 0,
      failure, real_model_requests: 0, denied_model_attempts: guard?.hits ?? 0,
      cleanup_ok: cleanupIssues.length === 0, cleanup_issues: cleanupIssues,
      owned_resources: { seed_id: seed?.seed_id, container_id: seed?.container_id, object_root: seed?.object_root,
        credentials_path: seed?.credentials_path, processes: ownedProcesses },
      evidence: "production_Next+owned_QA_seed+real_AUTH+Chrome; layout comparison is DOM-only",
      NOT_RUN: ["real provider", "production database", "Coze storage", "family generation/edit/copy", "physical phone keyboard", "screen reader"] };
    if (fs.existsSync(out)) fs.writeFileSync(path.join(out, "cleanup.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, evidence_dir: out }));
    assertCleanupComplete(cleanupIssues);
    if (!report.completed) process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  // No error stack/message: dependencies may include connection/auth details in them.
  console.error(JSON.stringify({ completed: false, preflight_error: error instanceof Error ? error.name : "unknown_error" }));
  process.exitCode = 1;
});
