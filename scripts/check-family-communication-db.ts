import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { startIsolatedPostgres, startModelRequestGuard, modelGuardEnv, type IsolatedPostgres } from "./harness-safety";
import { createSessionToken, computeCsrfToken } from "../src/lib/accounts/session";
import { AccountsError } from "../src/lib/accounts/errors";
import { isoDateInShanghai } from "../src/lib/format";
import type { ObservationDraft } from "../src/lib/types";
import { previousCommunicationMonth, type CommunicationView } from "../src/lib/family-communication-contract";
import { generateCommunication, loadCommunicationWorkspace, lookupCommunication, updateCommunication, CommunicationError } from "../src/lib/family-communication";
import type { invokeChatLlm } from "../src/lib/llm";
import { GET, POST } from "../src/app/api/family-communications/route";
import { PATCH } from "../src/app/api/family-communications/[id]/route";

const root = fileURLToPath(new URL("../", import.meta.url));
const runId = `family-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const origin = "http://family-check.invalid";
const month = previousCommunicationMonth(isoDateInShanghai());
const period = { kind: "month", value: month } as const;
const ids = { a: randomUUID(), b: randomUUID(), child: randomUUID(), other: randomUUID(), foreign: randomUUID(), first: randomUUID(), second: randomUUID(), draft: randomUUID() };
let passed = 0, models = 0;
function check(name: string, value: unknown) { assert.ok(value, name); passed++; }
function request(token?: string, body?: unknown, path = "/api/family-communications", csrf = true): NextRequest {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (token) { headers.set("cookie", `cga_session=${token}`); if (csrf) headers.set("x-csrf-token", computeCsrfToken(token)); }
  return new NextRequest(`${origin}${path}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
}
function input(extra: Record<string, unknown> = {}) { return { client_request_id: randomUUID(), child_id: ids.child, period, observation_ids: [ids.first, ids.second], note: "分享几个具体小故事", ...extra }; }
async function denial(work: () => Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => (error instanceof AccountsError || error instanceof CommunicationError) && error.code === code); passed++;
}
const model: typeof invokeChatLlm = async (messages) => {
  models++;
  const facts = JSON.parse(messages[1].content) as { observations: Array<{ observation_id: string; raw_text: string }> };
  assert.ok(facts.observations.every((item) => !item.raw_text.includes("陈沐阳")), "other names redacted before provider");
  return { provider: "stepfun", model: "in-process-double", usage: null, content: JSON.stringify({
    text: "小禾家长，您好！这段时间我们留下了几个有意思的片段。积木桥倒下后，她把桥墩挪近再试，说：“这次小车能过去了”。在家可以一起试试搭桥，听她说说自己的办法。",
    evidence: [{ observation_id: ids.first, quote: "这次小车能过去了" }],
  }) };
};

async function main() {
  const guard = await startModelRequestGuard(); Object.assign(process.env, modelGuardEnv(guard));
  let isolated: IsolatedPostgres | undefined, db: Client | undefined;
  try {
    isolated = await startIsolatedPostgres({ runId, containerName: `cga-${runId}`, dbName: "family_check", labelKey: "cga.family.check" });
    process.env.DATABASE_URL = isolated.url; delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = origin; process.env.AUTH_SCHOOL_ID = "single-school"; process.env.AUTH_COOKIE_SECURE = "false";
    db = new Client({ connectionString: isolated.url }); await db.connect();
    await db.query(fs.readFileSync(`${root}scripts/initialize-demo-db.sql`, "utf8"));
    await db.query(fs.readFileSync(`${root}scripts/upgrade-auth-v1.sql`, "utf8"));
    const migration = fs.readFileSync(`${root}scripts/upgrade-family-communication-v1.sql`, "utf8");
    await db.query(migration); await db.query(migration); check("migration idempotent", true);
    for (const [id, name] of [[ids.a, "阳光班"], [ids.b, "星河班"]]) await db.query("INSERT INTO classes(id,name,stage,school_year) VALUES($1,$2,'small','2026-2027')", [id, name]);
    for (const [id, name, cls] of [[ids.child, "林小禾", ids.a], [ids.other, "陈沐阳", ids.a], [ids.foreign, "周亦安", ids.b]]) {
      await db.query("INSERT INTO children(id,name,gender,birth_date,class_name,is_demo) VALUES($1,$2,'女','2023-03-10','阳光班',true)", [id, name]);
      await db.query("INSERT INTO child_class_enrollments(child_id,class_id,start_date) VALUES($1,$2,'2020-01-01')", [id, cls]);
    }
    const content: ObservationDraft = { domain: "科学", sub_domain: "建构尝试", objective_description: "幼儿在搭桥中调整了桥墩的位置。", highlights: ["把桥墩挪近"], highlight_quote: "把桥墩挪近", support_suggestions: ["保留积木让她继续尝试。"] };
    for (const [id, date, state, raw] of [[ids.first, `${month}-02`, "confirmed", "桥倒了，她把桥墩挪近，说：这次小车能过去了。陈沐阳在旁边看。"], [ids.second, `${month}-11`, "confirmed", "拿来图书请老师讲，指着画面停留了一会儿。"], [ids.draft, `${month}-17`, "draft", "这条还没有确认。"]]) {
      await db.query(`INSERT INTO observations(id,child_id,class_id,observed_at,context,raw_text,status,confirmed_content,confirmed_at,is_demo)
        VALUES($1,$2,$3,$4,'积木区',$5,$6::varchar,$7::jsonb,CASE WHEN $6::varchar='confirmed' THEN clock_timestamp() ELSE NULL END,true)`,
        [id, ids.child, ids.a, date, raw, state, state === "confirmed" ? JSON.stringify(content) : null]);
    }
    const session = async (name: string, role: "teacher" | "admin", classes: string[]) => {
      const id = randomUUID(), token = createSessionToken();
      await db!.query("INSERT INTO app_accounts(id,username,display_name,password_hash,role) VALUES($1,$2,$3,'test-only-no-login',$4)", [id, name, name, role]);
      await db!.query("INSERT INTO app_sessions(account_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day')", [id, token.tokenHash]);
      for (const cls of classes) await db!.query("INSERT INTO teacher_class_assignments(account_id,class_id) VALUES($1,$2)", [id, cls]);
      return { id, ...token };
    };
    const teacher = await session("family_teacher", "teacher", [ids.a]);
    const outsider = await session("family_outsider", "teacher", [ids.b]);
    const colleague = await session("family_colleague", "teacher", [ids.a]);
    const admin = await session("family_admin", "admin", []);
    const empty = await session("family_empty", "teacher", []);
    check("anonymous real handler is 401", (await GET(request(undefined, undefined, `/?child_id=${ids.child}&kind=month&value=${month}`))).status === 401);
    await denial(() => generateCommunication(request(), input(), model), "unauthenticated");
    await denial(() => generateCommunication(request(teacher.token, input(), "/", false), input(), model), "csrf_rejected");
    await denial(() => generateCommunication(request(admin.token), input(), model), "forbidden_role");
    await denial(() => generateCommunication(request(outsider.token), input(), model), "out_of_scope");
    await denial(() => generateCommunication(request(empty.token), input(), model), "empty_scope");
    await denial(() => generateCommunication(request(teacher.token), input({ observation_ids: [ids.draft] }), model), "source_conflict");
    await denial(() => generateCommunication(request(teacher.token), input({ observation_ids: [] }), model), "invalid_request");
    await denial(() => generateCommunication(request(teacher.token), input({ actor_account_id: teacher.id }), model), "invalid_request");
    check("all denied paths made no model calls", models === 0 && guard.hits === 0);
    const workspace = await loadCommunicationWorkspace(request(teacher.token), ids.child, period);
    check("only two confirmed sources returned", workspace.sources.length === 2 && !JSON.stringify(workspace).includes("这条还没有确认"));
    check("fresh draft list is empty", workspace.communication === null);
    const create = input();
    const draft = await generateCommunication(request(teacher.token), create, model);
    check("real DB draft is stored", draft.status === "draft" && draft.owner_account_id === teacher.id && draft.text.includes("桥墩"));
    check("model once only", models === 1);
    const replay = await generateCommunication(request(teacher.token), { ...create, observation_ids: [...create.observation_ids].reverse() }, model);
    check("same request replays no model", replay.id === draft.id && models === 1);
    await denial(() => generateCommunication(request(teacher.token), { ...create, note: "different" }, model), "idempotency_conflict");
    check("colleague cannot read private draft", (await lookupCommunication(request(colleague.token), create.client_request_id)) === null);
    check("admin cannot read teacher private draft", (await lookupCommunication(request(admin.token), create.client_request_id)) === null);
    const loaded = await loadCommunicationWorkspace(request(teacher.token), ids.child, period);
    check("refresh recovers saved draft", loaded.communication?.id === draft.id && loaded.communication.text === draft.text);
    const saved = await updateCommunication(request(teacher.token), draft.id, { expected_revision: draft.revision, action: "save", text: draft.text + "您也可以听她说说画里的故事。" });
    check("edit persists without confirming observation", saved.status === "draft" && saved.revision === draft.revision + 1);
    await denial(() => updateCommunication(request(teacher.token), draft.id, { expected_revision: draft.revision, action: "save", text: draft.text }), "revision_conflict");
    await denial(() => updateCommunication(request(colleague.token), draft.id, { expected_revision: saved.revision, action: "review", text: saved.text }), "not_found");
    await denial(() => updateCommunication(request(admin.token), draft.id, { expected_revision: saved.revision, action: "review", text: saved.text }), "not_found");
    const reviewed = await updateCommunication(request(teacher.token), draft.id, { expected_revision: saved.revision, action: "review", text: saved.text });
    check("review is distinct from sending", reviewed.status === "reviewed" && !JSON.stringify(reviewed).includes("sent"));
    const original = await db.query("SELECT raw_text,status,confirmed_content,confirmed_at FROM observations WHERE id=$1", [ids.first]);
    check("raw and observation workflow unchanged", original.rows[0].raw_text.includes("陈沐阳") && original.rows[0].status === "confirmed" && original.rows[0].confirmed_content.domain === "科学");
    const failure = input();
    await denial(() => generateCommunication(request(teacher.token), failure, async () => { throw new Error("double-offline"); }), "generation_failed");
    check("failed generation has explicit result", (await lookupCommunication(request(teacher.token), failure.client_request_id))?.status === "failed");
    check("failure keeps prior successful draft on refresh", (await loadCommunicationWorkspace(request(teacher.token), ids.child, period)).communication?.id === draft.id);
    const timedOut = input();
    await denial(() => generateCommunication(request(teacher.token), timedOut, async (messages, options) => {
      await db!.query("UPDATE family_communications SET deadline_at=clock_timestamp()-interval '1 second' WHERE client_request_id=$1", [timedOut.client_request_id]);
      return model(messages, options);
    }), "generation_expired");
    check("late model cannot save after deadline", (await lookupCommunication(request(teacher.token), timedOut.client_request_id))?.status === "failed");
    const orphanId = randomUUID(), orphanRequest = randomUUID();
    await db.query(`INSERT INTO family_communications(id,owner_account_id,child_id,client_request_id,request_digest,period,range_from,range_to,range_label,class_premise,sources,note,body,author_name,state,deadline_at)
      SELECT $1,owner_account_id,child_id,$2,request_digest,period,range_from,range_to,range_label,class_premise,sources,note,'',author_name,'generating',clock_timestamp()-interval '1 second'
      FROM family_communications WHERE id=$3`, [orphanId, orphanRequest, draft.id]);
    check("expired pending SQL fixture is not permanently generating", (await lookupCommunication(request(teacher.token), orphanRequest))?.status === "failed");
    check("expired pending does not hide prior draft", (await loadCommunicationWorkspace(request(teacher.token), ids.child, period)).communication?.id === draft.id);
    const concurrency = await Promise.allSettled([1, 2].map((number) => updateCommunication(request(teacher.token), draft.id, { expected_revision: reviewed.revision, action: "save", text: reviewed.text + `这是老师补充的第${number}个想法。` })));
    check("same revision concurrent save has one winner", concurrency.filter((item) => item.status === "fulfilled").length === 1);
    check("concurrent loser is real conflict", concurrency.some((item) => item.status === "rejected" && item.reason instanceof CommunicationError && item.reason.code === "revision_conflict"));
    const sameKey = input();
    const beforeRegistration = models;
    const duplicates: CommunicationView[] = await Promise.all([generateCommunication(request(teacher.token), sameKey, model), generateCommunication(request(teacher.token), sameKey, model)]);
    check("concurrent registration gives same identity", duplicates[0].id === duplicates[1].id);
    check("same identity leaves single row", (await db.query("SELECT count(*)::int AS n FROM family_communications WHERE client_request_id=$1", [sameKey.client_request_id])).rows[0].n === 1);
    check("two registrations added only one model call", models === beforeRegistration + 1);
    const beforeModel = models;
    const forged = await POST(request(teacher.token, input({ approved: true })));
    check("real public create rejects authority forgery", forged.status === 400 && models === beforeModel && guard.hits === 0);
    check("real PATCH preserves CSRF gate", (await PATCH(request(teacher.token, { expected_revision: 1, action: "review", text: reviewed.text }, "/", false), { params: Promise.resolve({ id: draft.id }) })).status === 403);
    // Confirmed source revision is checked before editing or exposing old draft text.
    await db.query("UPDATE observations SET confirmed_content=jsonb_set(confirmed_content,'{objective_description}','\"原确认内容已变化。\"') WHERE id=$1", [ids.first]);
    const stale = await lookupCommunication(request(teacher.token), create.client_request_id);
    check("changed source hides stored sharing body", stale?.status === "stale" && stale.text === "");
    await denial(() => updateCommunication(request(teacher.token), draft.id, { expected_revision: reviewed.revision + 1, action: "review", text: reviewed.text }), "source_conflict");
    await db.query("UPDATE observations SET confirmed_content=$1::jsonb WHERE id=$2", [JSON.stringify(content), ids.first]);
    const expire = input();
    await denial(() => generateCommunication(request(teacher.token), expire, async (messages, options) => {
      await db!.query("UPDATE app_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [teacher.tokenHash]);
      return model(messages, options);
    }), "unauthenticated");
    check("expired session stores failure metadata only", (await db.query("SELECT state,body FROM family_communications WHERE client_request_id=$1", [expire.client_request_id])).rows[0].state === "failed" &&
      (await db.query("SELECT body FROM family_communications WHERE client_request_id=$1", [expire.client_request_id])).rows[0].body === "");
    await db.query("UPDATE app_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE token_hash=$1", [teacher.tokenHash]);
    const revokeBeforeRetry = input(); let attempts = 0;
    await denial(() => generateCommunication(request(teacher.token), revokeBeforeRetry, async () => {
      attempts++;
      await db!.query("UPDATE teacher_class_assignments SET removed_at=clock_timestamp() WHERE account_id=$1 AND class_id=$2", [teacher.id, ids.a]);
      return { content: "{}", provider: "stepfun", model: "double", usage: null };
    }), "empty_scope");
    check("revocation between retries blocks second model call", attempts === 1);
    await db.query("UPDATE teacher_class_assignments SET removed_at=NULL WHERE account_id=$1 AND class_id=$2", [teacher.id, ids.a]);
    await db.query("INSERT INTO teacher_class_assignments(account_id,class_id) VALUES($1,$2)", [teacher.id, ids.b]);
    const samePermissionTransfer = input();
    await denial(() => generateCommunication(request(teacher.token), samePermissionTransfer, async (messages, options) => {
      await db!.query("UPDATE child_class_enrollments SET class_id=$1 WHERE child_id=$2 AND end_date IS NULL", [ids.b, ids.child]);
      return model(messages, options);
    }), "source_conflict");
    check("same-permission transfer stores no body", (await db.query("SELECT body FROM family_communications WHERE client_request_id=$1", [samePermissionTransfer.client_request_id])).rows[0].body === "");
    await db.query("UPDATE child_class_enrollments SET class_id=$1 WHERE child_id=$2 AND end_date IS NULL", [ids.a, ids.child]);
    await db.query("DELETE FROM teacher_class_assignments WHERE account_id=$1 AND class_id=$2", [teacher.id, ids.b]);
    const change = input();
    await denial(() => generateCommunication(request(teacher.token), change, async (messages, options) => {
      await db!.query("UPDATE child_class_enrollments SET end_date=$1 WHERE child_id=$2 AND end_date IS NULL", [`${month}-30`, ids.child]);
      await db!.query("INSERT INTO child_class_enrollments(child_id,class_id,start_date) VALUES($1,$2,$3)", [ids.child, ids.b, isoDateInShanghai()]);
      return model(messages, options);
    }), "out_of_scope");
    check("transfer during model saved no parent body", (await db.query("SELECT body FROM family_communications WHERE client_request_id=$1", [change.client_request_id])).rows[0].body === "");
    await denial(() => lookupCommunication(request(teacher.token), create.client_request_id), "out_of_scope");
    check("after transfer new teacher does not inherit old private draft", (await lookupCommunication(request(outsider.token), create.client_request_id)) === null);
    const historic = await generateCommunication(request(outsider.token), input(), model);
    check("new responsible teacher can use confirmed history with previous classmates redacted", historic.status === "draft" && !historic.text.includes("陈沐阳"));
    check("guard saw no real egress", guard.hits === 0);
    console.log(JSON.stringify({ passed, model_double_calls: models, real_model_requests: 0, evidence: "isolated_pg+real_auth+route_handler", run_id: runId }));
  } finally {
    await db?.end(); await globalThis.__pgPool?.end(); globalThis.__pgPool = undefined;
    await guard.close(); const cleanup = isolated?.teardown();
    assert.ok(!cleanup || cleanup.ok, cleanup?.detail); console.log(JSON.stringify({ cleanup: "verified", container_id: isolated?.containerId ?? null }));
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
