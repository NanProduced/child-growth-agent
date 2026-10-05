import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import {
  assertCleanupComplete, findListeningPids, modelGuardEnv, restoreGeneratedArtifacts, runCleanupSteps,
  snapshotGeneratedArtifacts, startIsolatedPostgres, startModelRequestGuard, stopTrackedChildTree,
  trackChildProcess, waitForVerifiedService,
  type IsolatedPostgres, type ModelRequestGuard, type TrackedChild,
} from "./harness-safety";
import { hashPassword } from "../src/lib/accounts/password";
import { createInitialAdmin, createTeacherWithAssignments } from "../src/lib/accounts/repository";
import { buildEnrollmentSnapshot, resolveClassContextAt } from "../src/lib/class-context";
import { confirmObservation, createObservation, updateObservationAgentContext, updateObservationAiDraft } from "../src/lib/queries";
import { guideEvidenceDecisionSchema, observationDraftSchema } from "../src/lib/validation";
import { listGuideItems } from "../src/lib/guide/catalog";
import type { ClassStage, ObservationStatus } from "../src/lib/types";

/** Explicit owned local review scenario. Never a production bootstrap or a fixture auth bypass. */
async function main() {
  const root = process.cwd();
  const port = Number(process.env.LOCAL_HOME_PORT ?? 5020);
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  const listeners = findListeningPids(port);
  assert.ok(listeners.ok && listeners.pids.length === 0, "Port occupied/unverifiable; no foreign process will be killed");
  const artifacts = snapshotGeneratedArtifacts(root);
  const runId = `home-${process.pid}-${Date.now().toString(36)}`;
  const issues: string[] = [];
  const output = path.join(root, "logs/home-review");
  const credentialsFile = path.join(output, "local-credentials.json");
  assert.ok(!fs.existsSync(credentialsFile), "Existing review credentials must not be overwritten");
  let db: IsolatedPostgres | null = null;
  let guard: ModelRequestGuard | null = null;
  let service: TrackedChild | null = null;
  let client: Client | null = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    console.log("Preparing fresh owned local account/role review database.");
    db = await startIsolatedPostgres({ runId, containerName: `cga-${runId}`, dbName: `cga_home_${process.pid}_${Date.now().toString(36)}`,
      labelKey: "child-growth-agent.home-review", noteIssue: (label, detail) => issues.push(`${label}: ${detail}`) });
    process.env.DATABASE_URL = db.url;
    process.env.AUTH_TRUSTED_ORIGINS = `http://127.0.0.1:${port}`;
    process.env.AUTH_SCHOOL_ID = "single-school";
    process.env.AUTH_COOKIE_SECURE = "false";
    delete process.env.PGDATABASE_URL;
    delete process.env.TEACHER_PASSCODE;
    client = new Client({ connectionString: db.url });
    await client.connect();
    const initialization = fs.readFileSync(path.join(root, "scripts/initialize-demo-db.sql"), "utf8");
    const seedStart = initialization.indexOf("INSERT INTO children");
    assert.ok(seedStart > 0, "Schema/seed boundary must be explicit");
    await client.query(initialization.slice(0, seedStart));
    await client.query(fs.readFileSync(path.join(root, "scripts/upgrade-auth-v1.sql"), "utf8"));

    const groups: { name: string; stage: ClassStage; count: number }[] = [
      { name: "芽芽班", stage: "small", count: 18 }, { name: "苗苗班", stage: "small", count: 16 },
      { name: "星星班", stage: "middle", count: 20 }, { name: "月亮班", stage: "middle", count: 12 },
      { name: "蒲公英班", stage: "large", count: 14 }, { name: "太阳班", stage: "large", count: 14 },
    ];
    const classIds: string[] = [];
    const childrenByClass: string[][] = [];
    let total = 0;
    for (const [index, group] of groups.entries()) {
      const classId = randomUUID(); classIds.push(classId);
      await client.query("INSERT INTO classes(id,name,stage,school_year,is_active,is_demo) VALUES($1,$2,$3,'2026-2027',true,true)", [classId, group.name, group.stage]);
      const children: string[] = [];
      for (let number = 0; number < group.count; number++) {
        const id = randomUUID(); children.push(id); total++;
        const name = index === 0 && number === 0 ? "童童" : index === 1 && number === 0 ? "阿依努尔·麦麦提" : `${group.name.slice(0, -1)}${number + 1}`;
        const birth = group.stage === "small" ? "2023-05-18" : group.stage === "middle" ? "2022-05-18" : "2021-05-18";
        await client.query("INSERT INTO children(id,name,gender,birth_date,class_name,is_demo) VALUES($1,$2,$3,$4,$5,true)", [id, name, number % 2 ? "女" : "男", birth, group.name]);
        await client.query("INSERT INTO child_class_enrollments(child_id,class_id,start_date) VALUES($1,$2,'2026-09-01')", [id, classId]);
      }
      childrenByClass.push(children);
    }
    assert.equal(total, 94);
    const passwords = { admin: randomBytes(18).toString("base64url"), teacher: randomBytes(18).toString("base64url"), other: randomBytes(18).toString("base64url"), unassigned: randomBytes(18).toString("base64url") };
    const admin = await createInitialAdmin({ username: "review-admin", displayName: "王园长", passwordHash: await hashPassword(passwords.admin) }, "single-school");
    const teacher = await createTeacherWithAssignments({ username: "review-teacher", displayName: "林小满", passwordHash: await hashPassword(passwords.teacher), classIds: classIds.slice(0, 3), assignedBy: admin.account_id });
    await createTeacherWithAssignments({ username: "review-other", displayName: "陈老师", passwordHash: await hashPassword(passwords.other), classIds: classIds.slice(3), assignedBy: admin.account_id });
    await createTeacherWithAssignments({ username: "review-unassigned", displayName: "待分班老师", passwordHash: await hashPassword(passwords.unassigned), classIds: [], assignedBy: admin.account_id });

    async function addObservation(group: number, child: number, status: ObservationStatus, date: string, contextText: string, raw: string) {
      const childId = childrenByClass[group][child];
      const lookup = await resolveClassContextAt(childId, date);
      assert.equal(lookup.status, "resolved");
      if (lookup.status !== "resolved") throw new Error("Seed enrollment is not reliable");
      const record = await createObservation({ child_id: childId, observed_at: date, context: contextText, raw_text: raw, is_demo: true,
        class_context_snapshot: buildEnrollmentSnapshot(lookup.class, lookup.enrollment_id), premise: {
          class_id: lookup.class.id, class_name: lookup.class.name, stage: lookup.class.stage, school_year: lookup.class.school_year, enrollment_id: lookup.enrollment_id, observed_at: date,
        } });
      if (status === "needs_input") {
        await updateObservationAgentContext(record.id, { follow_up: { round: 1, question: "当时幼儿是自己完成，还是有人帮助？", reason: "支持条件会影响对表现的理解。", stopped: false, answers: [], rounds: [{ round: 1, question: "当时幼儿是自己完成，还是有人帮助？", reason: "支持条件会影响对表现的理解。", answer: null }] } }, "needs_input",
          { expectedStatus: "draft", expectedAgentContext: null, expectedAiDraft: null });
      } else if (status === "ai_organized") {
        const draft = observationDraftSchema.parse({ domain: "科学", sub_domain: "探究与尝试", objective_description: raw,
          highlights: [raw], support_suggestions: ["保留材料，让幼儿按自己的方式继续尝试。"], highlight_quote: raw });
        await updateObservationAiDraft(record.id, draft, "local-authored-fixture", { expectedStatus: "draft", expectedAgentContext: null, expectedAiDraft: null });
      }
      return record;
    }
    // Authored fixture drafts are not real model output. These state counts come from actual rows.
    for (const [group, child, status] of [
      [0, 2, "ai_organized"], [0, 3, "ai_organized"], [1, 2, "ai_organized"],
      [0, 4, "needs_input"], [2, 2, "needs_input"],
      [0, 5, "draft"], [1, 3, "draft"], [1, 4, "draft"], [2, 3, "draft"],
    ] as const) await addObservation(group, child, status, "2026-09-30", "建构区游戏", "幼儿把两块积木并排放好，再把一块长积木放在上面，试着让小车通过。");
    const item = (await listGuideItems({ domain_code: "health", age_band: "3-4" })).find((entry) => entry.text.includes("连续向前跳"));
    assert.ok(item);
    const confirmedIds: string[] = [];
    for (const [group, date, contextText, raw] of [
      [0, "2026-10-03", "自主收拾材料", "童童把积木逐一放进收纳筐，然后把小车推回架子上。之后在户外游戏中，双脚连续向前跳过三条标线，途中没有停下，教师在旁边未扶住幼儿。"],
      [1, "2026-10-02", "建构区游戏", "阿依努尔·麦麦提把一块长积木放在两块方积木上，推小车通过后又加了一块支撑积木。"],
    ] as const) {
      const record = await addObservation(group, 0, "draft", date, contextText, raw);
      const draft = observationDraftSchema.parse({ domain: group === 0 ? "健康" : "科学", sub_domain: group === 0 ? "动作发展" : "探究与尝试", objective_description: raw, highlights: [raw], highlight_quote: raw,
        support_suggestions: ["继续提供开放材料，回应幼儿的尝试并记录具体行为。"] });
      await confirmObservation(record.id, record.child_id, draft, { status: "draft", agentContext: null, aiDraft: null }, group === 0 ? {
        expectedRevision: 0, decisions: [guideEvidenceDecisionSchema.parse({ item_id: item.id, support: "single_event", adult_help_used: false,
          basis: [{ observation_id: record.id, quote: raw, quote_source: "raw_text" }], teacher_note: "本次连续跳跃事实可核对。" })],
      } : undefined);
      confirmedIds.push(record.id);
    }
    await client.end(); client = null;
    guard = await startModelRequestGuard();
    const environment = modelGuardEnv(guard);
    environment.DATABASE_URL = db.url; environment.AUTH_TRUSTED_ORIGINS = `http://127.0.0.1:${port}`;
    environment.AUTH_COOKIE_SECURE = "false"; environment.AUTH_SCHOOL_ID = "single-school";
    delete environment.PGDATABASE_URL; delete environment.TEACHER_PASSCODE;
    const processHandle = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    service = trackChildProcess(processHandle);
    processHandle.stdout?.on("data", (value: Buffer) => process.stdout.write(value));
    processHandle.stderr?.on("data", (value: Buffer) => process.stderr.write(value));
    await waitForVerifiedService({ base: `http://127.0.0.1:${port}`, port, child: service, timeoutMs: 90_000 });
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(credentialsFile, JSON.stringify({ admin: { username: "review-admin", password: passwords.admin }, teacher: { username: "review-teacher", password: passwords.teacher }, other: { username: "review-other", password: passwords.other }, unassigned: { username: "review-unassigned", password: passwords.unassigned } }, null, 2));
    fs.writeFileSync(path.join(output, "runtime.json"), JSON.stringify({ run_id: runId, port, supervisor_pid: process.pid, server_pid: service.pid, server_started_at: service.startedAt,
      container_id: db.containerId, class_ids: classIds, child_ids: childrenByClass.map((rows) => rows[0]), confirmed_ids: confirmedIds,
      admin_id: admin.account_id, teacher_id: teacher.account_id, real_model_requests: guard.hits }, null, 2));
    console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, synthetic_review_records: true, children: 94, teacher_scope_children: 54, real_model_requests: guard.hits }));
    await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); processHandle.once("exit", () => resolve()); timer = setTimeout(resolve, 4 * 60 * 60 * 1000); });
  } finally {
    if (timer) clearTimeout(timer);
    await runCleanupSteps([
      { label: "review-server", run: async () => service ? stopTrackedChildTree(service) : undefined },
      { label: "review-client", run: async () => { if (client) await client.end(); } },
      { label: "review-pool", run: async () => { await globalThis.__pgPool?.end(); } },
      { label: "review-credentials", run: () => { if (fs.existsSync(credentialsFile)) fs.unlinkSync(credentialsFile); } },
      { label: "review-guard", run: async () => { if (guard) { console.log(JSON.stringify({ blocked_model_attempts: guard.hits, live_provider_requests: 0 })); await guard.close(); } } },
      { label: "review-db", run: () => db?.teardown() },
      { label: "review-generated-types", run: () => { const restored = restoreGeneratedArtifacts(artifacts, root); return { ok: restored.issues.length === 0, detail: restored.issues.join("; ") }; } },
    ], (label, detail) => issues.push(`${label}: ${detail}`));
    assertCleanupComplete(issues);
  }
}
void main().catch((error: unknown) => { console.error((error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "<redacted>")); process.exitCode = 1; });
