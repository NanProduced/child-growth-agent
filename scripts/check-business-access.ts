import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { NextRequest } from "next/server";
import {
  assertCleanupComplete, modelGuardEnv, runCleanupSteps, startIsolatedPostgres, startModelRequestGuard,
  type IsolatedPostgres,
} from "./harness-safety";
import { AccountsError } from "../src/lib/accounts/errors";
import { ObservationStateConflictError } from "../src/lib/evidence-snapshot";
import { authorizeAuthState } from "../src/lib/accounts/authorize";
import { runBusinessWrite, withBusinessRead } from "../src/lib/accounts/access";
import {
  scopedGetChild, scopedGetObservation, scopedListChildren, scopedListClasses, scopedListObservations,
} from "../src/lib/accounts/scoped-queries";
import { computeCsrfToken, createSessionToken } from "../src/lib/accounts/session";
import {
  createObservation, confirmObservation, getObservation, updateObservationAiDraft,
  updateObservationAgentContext, updateChildGrowthProfileSummary, updateChildActivitySupport,
  saveGuideEvidenceSuggestionResult,
} from "../src/lib/queries";
import type { ObservationDraft } from "../src/lib/types";
import { GET as childrenGet, POST as childrenPost } from "../src/app/api/children/route";
import { GET as classesGet, POST as classesPost } from "../src/app/api/classes/route";
import { GET as observationsGet, POST as observationsPost } from "../src/app/api/observations/route";
import { GET as childBookGet } from "../src/app/api/children/[id]/evidence-book/route";
import { GET as classOverviewGet } from "../src/app/api/classes/[id]/evidence-overview/route";
import { GET as classGet, PATCH as classPatch } from "../src/app/api/classes/[id]/route";
import { POST as transferPost } from "../src/app/api/classes/[id]/children/route";
import { POST as organizePost } from "../src/app/api/observations/[id]/organize/route";
import { POST as followUpPost } from "../src/app/api/observations/[id]/follow-up/route";
import { POST as confirmPost } from "../src/app/api/observations/[id]/confirm/route";
import { POST as guidePost } from "../src/app/api/observations/[id]/guide-evidence/route";
import { POST as profilePost } from "../src/app/api/children/[id]/growth-profile/route";
import { POST as activityPost } from "../src/app/api/children/[id]/activity-support/route";
import { listGuideItems } from "../src/lib/guide/catalog";

// No dotenv, supplied URL, reused container, permission bypass, preview server or real model.
const RUN = `business-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "http://business-check.invalid";
const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID(), childA: randomUUID(), childB: randomUUID(), moved: randomUUID(), childC: randomUUID(), obsA: randomUUID(), obsB: randomUUID(), history: randomUUID(), movedNew: randomUUID(), outsider: randomUUID() };
const draft: ObservationDraft = { domain: "科学", sub_domain: "科学探究", objective_description: "幼儿把积木放在一起。", highlights: ["幼儿把积木放在一起。"], support_suggestions: ["继续观察摆放过程。"], highlight_quote: "把积木放在一起" };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
let passed = 0;
function check(condition: unknown, label: string): void { assert.ok(condition, label); passed++; }
async function denies(work: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => error instanceof AccountsError && error.code === code);
  passed++;
}
function req(token?: string, body?: unknown, overrides: Record<string, string> = {}, path = "/api/children"): NextRequest {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json", ...overrides };
  if (token) { headers.cookie ??= `cga_session=${token}`; headers["x-csrf-token"] ??= computeCsrfToken(token); }
  return new NextRequest(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function status(response: Promise<Response>, expected: number, code?: string): Promise<Record<string, unknown>> {
  const result = await response;
  const body: unknown = await result.json();
  assert.equal(result.status, expected, JSON.stringify(body));
  check(body && typeof body === "object", "JSON response");
  if (code) { assert.equal((body as Record<string, unknown>).error, code); passed++; }
  return body as Record<string, unknown>;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main(): Promise<void> {
  check(globalThis.__pgPool === undefined, "fresh process must not reuse a database pool");
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  let isolated: IsolatedPostgres | null = null;
  let db: Client | null = null;
  let competitor: Client | null = null;
  const cleanupIssues: string[] = [];
  let failure: unknown;
  try {
    isolated = await startIsolatedPostgres({ runId: RUN, containerName: `cga-${RUN}`, dbName: "cga_business_check", labelKey: "cga.business.check", noteIssue: (label, detail) => cleanupIssues.push(`${label}: ${detail}`) });
    process.env.DATABASE_URL = isolated.url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;
    db = new Client({ connectionString: isolated.url });
    competitor = new Client({ connectionString: isolated.url });
    await db.connect(); await competitor.connect();
    await db.query(fs.readFileSync(`${ROOT}scripts/initialize-demo-db.sql`, "utf8"));
    await db.query(fs.readFileSync(`${ROOT}scripts/upgrade-auth-v1.sql`, "utf8"));
    for (const [id, name] of [[ids.a, "Access A"], [ids.b, "Access B"], [ids.c, "Access C"]]) {
      await db.query("INSERT INTO classes (id,name,stage,school_year) VALUES ($1,$2,'small','2026')", [id, name]);
    }
    for (const [id, classId] of [[ids.childA, ids.a], [ids.childB, ids.b], [ids.moved, ids.b], [ids.childC, ids.c]]) {
      await db.query("INSERT INTO children (id,name,gender,birth_date,class_name) VALUES ($1,$2,'女','2022-01-01','fixture')", [id, `Fixture ${id.slice(0, 8)}`]);
      await db.query("INSERT INTO child_class_enrollments (child_id,class_id,start_date) VALUES ($1,$2,'2026-01-01')", [id, classId]);
    }
    await db.query("INSERT INTO child_class_enrollments (child_id,class_id,start_date,end_date) VALUES ($1,$2,'2025-01-01','2025-12-31')", [ids.moved, ids.a]);
    for (const [id, childId, classId] of [[ids.obsA, ids.childA, ids.a], [ids.obsB, ids.childB, ids.b], [ids.history, ids.moved, ids.a], [ids.movedNew, ids.moved, ids.b], [ids.outsider, ids.childC, ids.c]]) {
      await db.query(`INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status,ai_draft,agent_context,guide_evidence)
        VALUES ($1,$2,$3,'2026-01-02','幼儿把积木放在一起。','ai_organized',$4::jsonb,$5::jsonb,$6::jsonb)`, [id, childId, classId, JSON.stringify(draft), JSON.stringify({ private_profile: "must-not-leak" }), JSON.stringify({ revision: 0, links: [], private_cross_class: "must-not-leak" })]);
    }
    const session = async (name: string, role: "teacher" | "admin", classes: string[]) => {
      const accountId = randomUUID(); const token = createSessionToken();
      await db!.query("INSERT INTO app_accounts (id,username,display_name,password_hash,role) VALUES ($1,$2,$2,'test-never-logged-in',$3)", [accountId, `${RUN}-${name}`, role]);
      await db!.query("INSERT INTO app_sessions (account_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')", [accountId, token.tokenHash]);
      for (const classId of classes) await db!.query("INSERT INTO teacher_class_assignments (account_id,class_id) VALUES ($1,$2)", [accountId, classId]);
      return { accountId, ...token };
    };
    const a = await session("a", "teacher", [ids.a]);
    const b = await session("b", "teacher", [ids.b]);
    const ab = await session("ab", "teacher", [ids.a, ids.b]);
    const empty = await session("empty", "teacher", []);
    const admin = await session("admin", "admin", []);
    await status(childrenGet(req()), 401, "unauthenticated");
    await status(childrenGet(req(undefined, undefined, { cookie: "cga_teacher=old-passcode-cookie" })), 401, "unauthenticated");
    await status(childrenGet(req(empty.token)), 403, "empty_scope");
    await status(classesGet(req(empty.token, undefined, {}, "/api/classes?catalog=true")), 403, "empty_scope");
    await status(childrenGet(req(a.token, undefined, { cookie: `cga_session=${a.token}; cga_teacher=old` })), 200);
    const scoped = await scopedListChildren(req(a.token));
    assert.deepEqual(scoped.map((x) => x.id), [ids.childA]); passed++;
    const all = await scopedListChildren(req(admin.token));
    check(all.some((x) => x.id === ids.childC), "admin reads school");
    const classes = await scopedListClasses({}, req(a.token));
    assert.deepEqual(classes.map((x) => x.id), [ids.a]); passed++;
    const catalog = await scopedListClasses({ catalog: true }, req(a.token));
    check(catalog.some((x) => x.id === ids.c), "base catalog includes unassigned classes");
    check(!JSON.stringify(catalog).includes("child_count"), "catalog has no statistics");
    await status(classGet(req(a.token), params(ids.b)), 403, "out_of_scope");
    await status(classesGet(req(a.token, undefined, {}, "/api/classes?catalog=true")), 200);
    await denies(() => scopedGetChild(ids.moved, req(a.token)), "out_of_scope");
    const history = await scopedGetObservation(ids.history, req(a.token));
    check(history?.access_projection === "historical_read_only" && !history.can_write, "former teacher history is readonly");
    check(history?.guide_evidence === null && history.agent_context === null && history.ai_draft === null, "historical cross-class details removed");
    const current = await scopedGetObservation(ids.history, req(b.token));
    check(current?.access_projection === "full" && current.can_write, "current teacher reads and acts on complete history");
    const listA = await scopedListObservations({}, req(a.token));
    check(listA.some((x) => x.id === ids.history) && !listA.some((x) => x.id === ids.movedNew || x.id === ids.outsider), "SQL scopes current and original-class history");
    await status(observationsGet(req(a.token, undefined, {}, `/api/observations?child_id=${ids.childC}`)), 403, "out_of_scope");
    await status(childBookGet(req(a.token), params(ids.moved)), 403, "out_of_scope");
    await status(childBookGet(req(b.token, undefined, {}, "/evidence?scope=all_history"), params(ids.moved)), 200);
    await status(classOverviewGet(req(a.token), params(ids.b)), 403, "out_of_scope");
    await status(classOverviewGet(req(a.token, undefined, {}, "/evidence?scope=all_history"), params(ids.a)), 200);
    const invalid = authorizeAuthState({ kind: "anonymous" }, "observation.confirm", { kind: "class", class_id: ids.a });
    check(!invalid.allowed && "invalid_request" in invalid, "combination legality precedes identity");
    await denies(() => runBusinessWrite(req(admin.token, {}), "observation.confirm", { kind: "class", class_id: ids.a }, async () => null), "invalid_request");

    // All teaching routes deny admin before invoking a model; all management routes deny teachers.
    for (const [handler, id, body] of [
      [organizePost, ids.obsA, {}], [followUpPost, ids.obsA, { action: "stop", content: "" }],
      [confirmPost, ids.obsA, { content: draft }], [guidePost, ids.obsA, { action: "suggest" }],
      [profilePost, ids.childA, {}], [activityPost, ids.childA, {}],
    ] as const) await status(handler(req(admin.token, body), params(id)), 403, "forbidden_role");
    await status(classesPost(req(a.token, { name: "denied", stage: "small", school_year: "2026-2027" })), 403, "forbidden_role");
    await status(classPatch(req(a.token, { name: "denied" }), params(ids.a)), 403, "forbidden_role");
    await status(transferPost(req(a.token, { child_id: ids.childA }), params(ids.b)), 403, "forbidden_role");
    await status(organizePost(req(a.token, {}), params(ids.history)), 403, "out_of_scope");
    await status(organizePost(req(a.token, {}, { "x-csrf-token": "bad" }), params(ids.obsA)), 403, "csrf_rejected");
    await status(organizePost(req(a.token, {}, { "x-csrf-token": computeCsrfToken(b.token) }), params(ids.obsA)), 403, "csrf_rejected");
    await status(organizePost(req(a.token, {}, { origin: "null" }), params(ids.obsA)), 403, "csrf_rejected");
    await status(organizePost(req(a.token, {}, { origin: "https://untrusted.invalid", host: "business-check.invalid" }), params(ids.obsA)), 403, "csrf_rejected");

    // Successful real Request handlers, verified directly in the owned isolated database.
    const created = await status(childrenPost(req(a.token, { name: "权限检查幼儿", gender: "女", birth_date: "2022-01-01", class_id: ids.a })), 201);
    const newChild = created.child as { id: string };
    check((await db.query("SELECT id FROM children WHERE id=$1", [newChild.id])).rowCount === 1, "handler saved in owned fixture DB");
    await status(childrenPost(req(a.token, { name: "不能建档", gender: "女", birth_date: "2022-01-01", class_id: ids.b })), 403, "out_of_scope");
    // 建档接口按运行日写首次分班起始日：成功路径必须使用隔离库中已保存的归属事实，
    // 固定日历日会随运行日漂移出归属窗口，把正确的 409 误判为失败。
    const enrollment = await db.query<{ start_date: string }>(
      "SELECT start_date::text AS start_date FROM child_class_enrollments WHERE child_id = $1 AND end_date IS NULL ORDER BY start_date DESC LIMIT 1",
      [newChild.id],
    );
    check(enrollment.rowCount === 1, "new child has exactly one saved current enrollment");
    const enrollmentStart = enrollment.rows[0].start_date;
    const successObservedAt = "2026-10-04";
    check(successObservedAt >= enrollmentStart, "success-path observation date is covered by the child's saved enrollment");
    // 反例：早于入班起始日的观察没有归属，必须 409 且不得落库。
    const beforeEnrollment = await db.query<{ day: string }>("SELECT ($1::date - 1)::text AS day", [enrollmentStart]);
    const noAttribution = await status(observationsPost(req(a.token, { child_id: newChild.id, observed_at: beforeEnrollment.rows[0].day, raw_text: "早于入班不能自动归属。" })), 409, "class_context_confirmation_required");
    check(noAttribution.reason === "no_attribution", "no-attribution rejection reports the attribution reason");
    check((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM observations WHERE child_id=$1", [newChild.id])).rows[0].n === 0, "no-attribution observation was not persisted");
    await status(observationsPost(req(a.token, { child_id: newChild.id, observed_at: successObservedAt, raw_text: "幼儿把积木放在一起。" })), 201);
    await status(classesPost(req(admin.token, { name: `New ${RUN}`, stage: "small", school_year: "2026-2027" })), 201);
    await status(classPatch(req(admin.token, { stage: "middle" }), params(ids.a)), 409); // G2 history protection
    await status(transferPost(req(admin.token, { child_id: newChild.id }), params(ids.b)), 200);
    const obsBeforeConfirm = await getObservation(ids.obsB); assert.ok(obsBeforeConfirm);
    await runBusinessWrite(req(b.token, {}), "observation.confirm", { kind: "observation", observation_id: ids.obsB }, () => confirmObservation(ids.obsB, ids.childB, draft, { status: "ai_organized", agentContext: obsBeforeConfirm.agent_context, aiDraft: draft }));
    check((await getObservation(ids.obsB))?.status === "confirmed", "same-client R1 confirmation preserved");
    const item = (await listGuideItems()).find((x) => x.product_rules.evidence_type === "behavior"); assert.ok(item);
    await status(guidePost(req(b.token, { action: "confirm", expected_guide_revision: 0, decisions: [{ item_id: item.id, support: "clue_only", basis: [{ observation_id: ids.obsB, quote: draft.highlight_quote, quote_source: "raw_text" }] }] }), params(ids.obsB)), 200);

    const snapshot = async () => (await db!.query<{ state: unknown }>(`SELECT jsonb_build_object(
      'children',(SELECT jsonb_agg(to_jsonb(c.*) ORDER BY id) FROM children c),
      'observations',(SELECT jsonb_agg(to_jsonb(o.*) ORDER BY id) FROM observations o),
      'enrollments',(SELECT jsonb_agg(to_jsonb(e.*) ORDER BY id) FROM child_class_enrollments e),
      'classes',(SELECT jsonb_agg(to_jsonb(k.*) ORDER BY id) FROM classes k)) AS state`)).rows[0].state;
    // Substitute model return, with B holding/removing assignment under AUTH1's account lock.
    const late = await session("late", "teacher", [ids.a, ids.b]);
    const entered = deferred(), returned = deferred();
    const originalObservation = await getObservation(ids.obsA); assert.ok(originalObservation);
    const pending = runBusinessWrite(req(late.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
      entered.resolve(); await returned.promise;
      return updateObservationAiDraft(ids.obsA, draft, "offline-return-substitute", { expectedStatus: "ai_organized", expectedAiDraft: draft, expectedAgentContext: originalObservation.agent_context });
    });
    const rejected = assert.rejects(pending, (e: unknown) => e instanceof AccountsError && e.code === "out_of_scope");
    await entered.promise;
    await competitor.query("BEGIN");
    await competitor.query("SELECT id FROM app_accounts WHERE id=$1 FOR UPDATE NOWAIT", [late.accountId]);
    await competitor.query("SELECT id FROM children WHERE id=$1 FOR UPDATE NOWAIT", [ids.childA]);
    await competitor.query("SELECT id FROM observations WHERE id=$1 FOR UPDATE NOWAIT", [ids.obsA]);
    check(true, "no account/child/observation locks during model substitute wait");
    await competitor.query("UPDATE teacher_class_assignments SET removed_at=now() WHERE account_id=$1 AND class_id=$2", [late.accountId, ids.a]);
    const beforeLate = await snapshot(); returned.resolve();
    let waited = false;
    for (let tries = 0; tries < 100; tries++) {
      const waiting = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%app_accounts%FOR SHARE%'");
      if (waiting.rows[0].n > 0) { waited = true; break; }
      await new Promise((done) => setTimeout(done, 10));
    }
    await competitor.query("COMMIT"); await rejected;
    check(waited, "save really waited on the competing account row lock");
    assert.deepEqual(await snapshot(), beforeLate); passed++;

    // Transfer A→B remains authorized for the same teacher, but old result still conflicts.
    const transferEntered = deferred(), transferReturn = deferred();
    const transferPending = runBusinessWrite(req(ab.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
      transferEntered.resolve(); await transferReturn.promise;
      return updateObservationAgentContext(ids.obsA, {}, "ai_organized");
    });
    const transferRejected = assert.rejects(transferPending, (e: unknown) => e instanceof AccountsError && e.code === "state_conflict");
    await transferEntered.promise;
    await competitor.query("BEGIN");
    await competitor.query("SELECT id FROM children WHERE id=$1 FOR UPDATE", [ids.childA]);
    await competitor.query("UPDATE child_class_enrollments SET end_date='2026-02-01' WHERE child_id=$1 AND end_date IS NULL", [ids.childA]);
    await competitor.query("INSERT INTO child_class_enrollments (child_id,class_id,start_date) VALUES ($1,$2,'2026-02-02')", [ids.childA, ids.b]);
    await competitor.query("COMMIT");
    const afterTransfer = await snapshot(); transferReturn.resolve(); await transferRejected;
    assert.deepEqual(await snapshot(), afterTransfer); passed++;
    check((await getObservation(ids.obsA))?.class_id === ids.a, "occurrence class snapshot unchanged after transfer");
    const revisionBefore = await getObservation(ids.obsA); assert.ok(revisionBefore);
    let afterCompetingRevision: unknown;
    await assert.rejects(() => runBusinessWrite(req(ab.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
      await competitor!.query("BEGIN");
      await competitor!.query("SELECT id FROM children WHERE id=$1 FOR UPDATE", [ids.childA]);
      await competitor!.query("UPDATE observations SET agent_context='{}'::jsonb WHERE id=$1", [ids.obsA]);
      await competitor!.query("COMMIT");
      afterCompetingRevision = await snapshot();
      return updateObservationAiDraft(ids.obsA, draft, "substitute", { expectedStatus: revisionBefore.status, expectedAgentContext: revisionBefore.agent_context, expectedAiDraft: revisionBefore.ai_draft });
    }), ObservationStateConflictError);
    assert.deepEqual(await snapshot(), afterCompetingRevision); passed++;

    // Every shared save family refuses a revoked original session, including model failure metadata.
    const saves: Array<() => Promise<unknown>> = [
      () => updateObservationAiDraft(ids.obsA, draft, "substitute"),
      () => updateObservationAgentContext(ids.obsA, {}, "needs_input"),
      () => confirmObservation(ids.obsA, ids.childA, draft, { status: "ai_organized", aiDraft: draft, agentContext: originalObservation.agent_context }),
      () => saveGuideEvidenceSuggestionResult(ids.obsA, { expectedRevision: 0, expectedStatus: "ai_organized", expectedRawText: originalObservation.raw_text, expectedAiDraft: draft, expectedConfirmedContent: null, ok: false, model: null, suggestions: [] }),
      () => updateChildGrowthProfileSummary(ids.childA, { summary: "substitute", recent_change: "", development_clues: [], next_support: "", next_focus: "", source_observation_ids: [], ai_model: "substitute", updated_at: new Date().toISOString() }, []),
      () => updateChildActivitySupport(ids.childA, { suggestions: [], source_observation_ids: [], ai_model: "substitute", generated_at: new Date().toISOString() }, null, []),
      () => createObservation({ child_id: ids.childA, observed_at: "2026-02-03", context: null, raw_text: "must not save", is_demo: false, class_context_snapshot: { class_id: ids.b, class_name: "Access B", stage: "small", school_year: "2026", source: "teacher_confirmed", captured_at: new Date().toISOString() }, premise: { class_id: ids.b, class_name: "Access B", stage: "small", school_year: "2026", enrollment_id: null, observed_at: "2026-02-03" } }),
    ];
    for (let i = 0; i < saves.length; i++) {
      const actor = await session(`revoked-${i}`, "teacher", [ids.b]);
      const before = await snapshot();
      await denies(() => runBusinessWrite(req(actor.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
        await competitor!.query("UPDATE app_sessions SET revoked_at=now() WHERE account_id=$1", [actor.accountId]);
        return saves[i]();
      }), "unauthenticated");
      assert.deepEqual(await snapshot(), before); passed++;
    }
    const disabled = await session("disabled-late", "teacher", [ids.b]);
    const beforeDisabled = await snapshot();
    await denies(() => runBusinessWrite(req(disabled.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
      await competitor!.query("UPDATE app_accounts SET status='disabled' WHERE id=$1", [disabled.accountId]);
      return updateObservationAiDraft(ids.obsA, draft, "substitute");
    }), "account_disabled");
    assert.deepEqual(await snapshot(), beforeDisabled); passed++;
    const expired = await session("expired-late", "teacher", [ids.b]);
    const beforeExpired = await snapshot();
    await denies(() => runBusinessWrite(req(expired.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
      await competitor!.query("UPDATE app_sessions SET expires_at=now()-interval '1 second' WHERE account_id=$1", [expired.accountId]);
      return updateObservationAiDraft(ids.obsA, draft, "substitute");
    }), "unauthenticated");
    assert.deepEqual(await snapshot(), beforeExpired); passed++;
    const lockExpiry = await session("child-lock-expiry", "teacher", [ids.b]);
    const expiryEntered = deferred(), expiryReturn = deferred();
    const expiryPending = runBusinessWrite(req(lockExpiry.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
      expiryEntered.resolve(); await expiryReturn.promise;
      return updateObservationAiDraft(ids.obsA, draft, "substitute");
    });
    const expiryRejected = assert.rejects(expiryPending, (e: unknown) => e instanceof AccountsError && e.code === "unauthenticated");
    await expiryEntered.promise;
    await db.query("UPDATE app_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE account_id=$1", [lockExpiry.accountId]);
    await competitor.query("BEGIN");
    await competitor.query("SELECT id FROM children WHERE id=$1 FOR UPDATE", [ids.childA]);
    const beforeLockExpiry = await snapshot(); expiryReturn.resolve();
    let waitedForChild = false;
    for (let tries = 0; tries < 100; tries++) {
      const waiting = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%children%FOR UPDATE%'");
      if (waiting.rows[0].n > 0) { waitedForChild = true; break; }
      await new Promise((done) => setTimeout(done, 10));
    }
    await db.query("SELECT pg_sleep(2.1)");
    await competitor.query("COMMIT"); await expiryRejected;
    check(waitedForChild, "automatic session expiry after real child-lock wait fails closed");
    assert.deepEqual(await snapshot(), beforeLockExpiry); passed++;
    const replaced = await session("replaced-late", "teacher", [ids.b]);
    const newSession = createSessionToken();
    const replaceRequest = req(replaced.token, {});
    const beforeReplacement = await snapshot();
    await denies(() => runBusinessWrite(replaceRequest, "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
      await competitor!.query("UPDATE app_sessions SET revoked_at=now() WHERE account_id=$1", [replaced.accountId]);
      await competitor!.query("INSERT INTO app_sessions (account_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')", [replaced.accountId, newSession.tokenHash]);
      replaceRequest.headers.set("cookie", `cga_session=${newSession.token}`);
      replaceRequest.headers.set("x-csrf-token", computeCsrfToken(newSession.token));
      return updateObservationAiDraft(ids.obsA, draft, "substitute");
    }), "unauthenticated");
    assert.deepEqual(await snapshot(), beforeReplacement); passed++;
    await status(childrenGet(req(newSession.token)), 200);
    const roleChanged = await session("role-late", "teacher", [ids.b]);
    const beforeRoleChange = await snapshot();
    await denies(() => runBusinessWrite(req(roleChanged.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
      await competitor!.query("UPDATE app_accounts SET role='admin' WHERE id=$1", [roleChanged.accountId]);
      return updateObservationAiDraft(ids.obsA, draft, "substitute");
    }), "forbidden_role");
    assert.deepEqual(await snapshot(), beforeRoleChange); passed++;
    const unavailable = await session("save-db-unavailable", "teacher", [ids.b]);
    const savePool = globalThis.__pgPool; assert.ok(savePool);
    const originalConnect = savePool.connect;
    const beforeUnavailable = await snapshot();
    try {
      await denies(() => runBusinessWrite(req(unavailable.token, {}), "observation.organize", { kind: "observation", observation_id: ids.obsA }, async () => {
        savePool.connect = (() => Promise.reject(new Error("fixture save connection unavailable"))) as typeof savePool.connect;
        return updateObservationAiDraft(ids.obsA, draft, "substitute");
      }), "identity_unavailable");
    } finally { savePool.connect = originalConnect; }
    assert.deepEqual(await snapshot(), beforeUnavailable); passed++;
    // Auth DB failure is 503, never an empty list. Only the test process's owned pool is intercepted.
    const pool = globalThis.__pgPool; assert.ok(pool);
    const originalQuery = pool.query;
    pool.query = (() => Promise.reject(new Error("fixture identity unavailable"))) as typeof pool.query;
    try { await status(childrenGet(req(b.token)), 503, "identity_unavailable"); }
    finally { pool.query = originalQuery; }
    check(guard.hits === 0, "zero provider network requests");
  } catch (error) { failure = error; }
  finally {
    await runCleanupSteps([
      { label: "competitor", run: async () => { await competitor?.end(); } },
      { label: "fixture-client", run: async () => { await db?.end(); } },
      { label: "owned-pool", run: async () => { await globalThis.__pgPool?.end(); } },
      { label: "owned-container", run: () => isolated?.teardown() ?? { ok: true, detail: "not created" } },
      { label: "model-guard", run: () => guard.close() },
    ], (label, detail) => cleanupIssues.push(`${label}: ${detail}`));
  }
  assertCleanupComplete(cleanupIssues);
  if (failure) throw failure;
  console.log(JSON.stringify({ passed, total: passed, database: "unique owned isolated PostgreSQL; immutable harness", routes: "real Request/Response handlers in process; no Next server or browser", late_save: "two connections + model-return substitute + verified lock wait + zero business writes", real_model_requests: guard.hits, cleanup: "verified", NOT_RUN: ["full Next HTTP/browser", "real LLM", "hosted DB", "deployment/security certification"] }));
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "business check failed"); process.exitCode = 1; });
