import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import {
  assertCleanupComplete, findListeningPids, modelGuardEnv, restoreGeneratedArtifacts,
  runCleanupSteps, snapshotGeneratedArtifacts, startIsolatedPostgres, startModelRequestGuard,
  stopTrackedChildTree, trackChildProcess, waitForVerifiedService,
  type IsolatedPostgres, type ModelRequestGuard, type TrackedChild,
} from "./harness-safety";
import { listGuideItems } from "../src/lib/guide/catalog";
import { confirmObservation, createObservation, getClassChildren, listClasses } from "../src/lib/queries";
import { buildEnrollmentSnapshot, resolveClassContextAt } from "../src/lib/class-context";
import { guideEvidenceDecisionSchema, observationDraftSchema } from "../src/lib/validation";

/** Local viewing only: fresh owned database, no hosted URL, no live model, no write session. */
async function main() {
  const root = process.cwd();
  const port = Number(process.env.LOCAL_PREVIEW_PORT ?? 5020);
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "Invalid local preview port");
  const listeners = findListeningPids(port);
  assert.ok(listeners.ok && listeners.pids.length === 0, "Preview port is occupied or unverifiable; no process will be stopped");
  const artifacts = snapshotGeneratedArtifacts(root);
  const runId = `preview-${process.pid}-${Date.now().toString(36)}`;
  const issues: string[] = [];
  let database: IsolatedPostgres | null = null;
  let guard: ModelRequestGuard | null = null;
  let service: TrackedChild | null = null;
  let client: Client | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  try {
    console.log("Preparing owned local PostgreSQL; hosted databases are not used.");
    database = await startIsolatedPostgres({
      runId, containerName: `cga-${runId}`, dbName: `cga_preview_${process.pid}_${Date.now().toString(36)}`,
      labelKey: "child-growth-agent.local-preview", noteIssue: (label, detail) => issues.push(`${label}: ${detail}`),
    });
    // Ignore inherited database configuration. The helper verified identity and an empty schema before returning.
    process.env.DATABASE_URL = database.url;
    delete process.env.PGDATABASE_URL;
    delete process.env.TEACHER_PASSCODE;
    client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(fs.readFileSync(path.join(root, "scripts/initialize-demo-db.sql"), "utf8"));
    const legacy = await client.query<{ count: string }>("SELECT count(*) FROM observations WHERE class_context_snapshot IS NULL");
    const classes = await listClasses();
    const small = classes.find((entry) => entry.stage === "small" && entry.is_active);
    assert.ok(small, "Initial seed requires an active small-stage class");
    const roster = await getClassChildren(small.id);
    assert.ok(roster.length >= 2, "Initial seed requires two children in the small-stage class");
    const item = (await listGuideItems({ domain_code: "health", age_band: "3-4" }))
      .find((entry) => entry.text.includes("连续向前跳"));
    assert.ok(item && item.product_rules.evidence_type === "behavior", "Jumping item must be a single-event behavior item");
    for (const [index, child] of roster.slice(0, 2).entries()) {
      const date = `2026-09-${28 + index}`;
      const context = await resolveClassContextAt(child.id, date);
      assert.equal(context.status, "resolved", "Local seed date must have a verified enrollment");
      if (context.status !== "resolved") throw new Error("Local enrollment unavailable");
      const raw = index === 0
        ? `户外游戏时，${child.name}双脚连续向前跳过了三条地面标线，途中没有停下。老师站在旁边，没有牵手或扶住他。`
        : `户外游戏时，${child.name}试着双脚向前跳，跳过一条标线后停下，握住老师的手再跳了一次。`;
      const draft = observationDraftSchema.parse({
        domain: "健康", sub_domain: "身体控制与协调", objective_description: raw,
        highlights: [raw], highlight_quote: raw,
        support_suggestions: ["提供间距适宜的地面标线，让幼儿选择自己的尝试方式。"],
      });
      const observation = await createObservation({
        child_id: child.id, observed_at: date, context: "户外自主游戏", raw_text: raw, is_demo: true,
        class_context_snapshot: buildEnrollmentSnapshot(context.class, context.enrollment_id),
        premise: { class_id: context.class.id, class_name: context.class.name, stage: context.class.stage,
          school_year: context.class.school_year, enrollment_id: context.enrollment_id, observed_at: date },
      });
      // Fixture content is authored, not model output. Archive and manual association use the real G5 transaction.
      await confirmObservation(observation.id, child.id, draft, {
        status: "draft", agentContext: null, aiDraft: null,
      }, {
        expectedRevision: 0,
        decisions: [guideEvidenceDecisionSchema.parse({
          item_id: item.id, support: index === 0 ? "single_event" : "clue_only",
          basis: [{ observation_id: observation.id, quote: raw, quote_source: "raw_text" }],
          adult_help_used: index !== 0,
          teacher_note: index === 0 ? "本次连续跳跃事实可核对。" : "本次只是尝试线索，尚不足以确认连续跳跃的表现。",
        })],
      });
    }
    const afterLegacy = await client.query<{ count: string }>("SELECT count(*) FROM observations WHERE class_context_snapshot IS NULL");
    assert.equal(afterLegacy.rows[0].count, legacy.rows[0].count, "Legacy snapshots must not be backfilled");
    await client.end();
    client = null;
    guard = await startModelRequestGuard();
    const env = modelGuardEnv(guard);
    env.DATABASE_URL = database.url;
    delete env.PGDATABASE_URL;
    delete env.TEACHER_PASSCODE;
    const childProcess = spawn(process.execPath, [
      path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port),
    ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    service = trackChildProcess(childProcess);
    // Keep framework logs visible without printing environment values.
    childProcess.stdout?.on("data", (value: Buffer) => process.stdout.write(value));
    childProcess.stderr?.on("data", (value: Buffer) => process.stderr.write(value));
    const base = `http://127.0.0.1:${port}`;
    await waitForVerifiedService({ base, port, child: service, timeoutMs: 90_000 });
    const links = {
      home: base,
      child: `${base}/children/${roster[0].id}/evidence?domain=health&age_band=3-4`,
      class: `${base}/classes/${small.id}/evidence?domain=health&age_band=3-4`,
    };
    fs.mkdirSync(path.join(root, "logs/local-preview"), { recursive: true });
    fs.writeFileSync(path.join(root, "logs/local-preview/runtime.json"), JSON.stringify({
      run_id: runId, supervisor_pid: process.pid, server_pid: service.pid, server_started_at: service.startedAt,
      container_id: database.containerId, label_key: "child-growth-agent.local-preview", links,
      auth_runtime: "legacy writes disabled", real_model_requests: guard.hits,
    }, null, 2));
    console.log(JSON.stringify({ ready: true, ...links, server_pid: service.pid, real_model_requests: guard.hits }));
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      childProcess.once("exit", () => resolve());
      watchdog = setTimeout(resolve, 2 * 60 * 60 * 1000);
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await runCleanupSteps([
      { label: "preview-server", run: async () => service ? stopTrackedChildTree(service) : undefined },
      { label: "seed-client", run: async () => { if (client) await client.end(); } },
      { label: "seed-pool", run: async () => { await globalThis.__pgPool?.end(); } },
      { label: "model-guard", run: async () => { if (guard) { console.log(JSON.stringify({ real_model_requests: guard.hits })); await guard.close(); } } },
      { label: "preview-database", run: () => database?.teardown() },
      { label: "generated-types", run: () => {
        const restored = restoreGeneratedArtifacts(artifacts, root);
        return { ok: restored.issues.length === 0, detail: restored.issues.join("; ") };
      } },
    ], (label, detail) => issues.push(`${label}: ${detail}`));
    assertCleanupComplete(issues);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "<redacted>"));
  process.exitCode = 1;
});
