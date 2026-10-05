import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parseAccountStatus } from "../src/lib/accounts/client";

/** Live Next HTTP checks against the explicitly owned, loopback review runner only. */
async function main() {
const runtime = JSON.parse(await fs.readFile("logs/home-review/runtime.json", "utf8")) as {
  port: number; class_ids: string[]; child_ids: string[]; confirmed_ids: string[];
};
const credentials = JSON.parse(await fs.readFile("logs/home-review/local-credentials.json", "utf8")) as
  Record<"admin" | "teacher" | "other" | "unassigned", { username: string; password: string }>;
assert.ok(Number.isInteger(runtime.port) && runtime.port >= 1024 && runtime.port <= 65535);
const base = `http://127.0.0.1:${runtime.port}`;
type Identity = { cookie: string; csrf: string };
const sessions: Identity[] = [];
let passed = 0;
async function check(run: () => Promise<void>) { await run(); passed += 1; }
async function request(path: string, identity?: Identity, method = "GET", body?: unknown, csrf?: string) {
  const response = await fetch(base + path, { method, redirect: "error", signal: AbortSignal.timeout(15_000), headers: {
    Origin: base, "content-type": "application/json", "x-cga-auth-request": "1",
    ...(identity ? { cookie: identity.cookie, "x-csrf-token": csrf ?? identity.csrf } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return response;
}
async function login(role: keyof typeof credentials): Promise<Identity> {
  const response = await request("/api/auth/login", undefined, "POST", credentials[role]);
  assert.equal(response.status, 200);
  const status = parseAccountStatus(await response.json());
  assert.equal(status?.state.kind, "authenticated");
  assert.ok(status?.csrf);
  const identity = { cookie: response.headers.getSetCookie().map(v => v.split(";")[0]).join("; "), csrf: status.csrf.token };
  assert.ok(identity.cookie);
  sessions.push(identity);
  return identity;
}
async function rows(path: string, key: string, identity: Identity): Promise<unknown[]> {
  const response = await request(path, identity); assert.equal(response.status, 200);
  const data = await response.json() as Record<string, unknown>;
  assert.ok(Array.isArray(data[key])); return data[key];
}

try {
  await check(async () => { assert.equal((await request("/api/children")).status, 401); });
  await check(async () => { assert.equal((await request(`/api/children/${runtime.child_ids[0]}/evidence-book`)).status, 401); });
  const teacher = await login("teacher");
  await check(async () => { assert.equal((await rows("/api/classes", "classes", teacher)).length, 3); });
  await check(async () => { assert.equal((await rows("/api/children", "children", teacher)).length, 54); });
  await check(async () => { assert.equal((await request(`/api/classes/${runtime.class_ids[3]}`, teacher)).status, 403); });
  await check(async () => { assert.equal((await request(`/api/children/${runtime.child_ids[3]}/evidence-book`, teacher)).status, 403); });
  await check(async () => { assert.equal((await request(`/api/children/${runtime.child_ids[0]}/evidence-book`, teacher)).status, 200); });
  await check(async () => { assert.equal((await request(`/api/classes/${runtime.class_ids[0]}/evidence-overview`, teacher)).status, 200); });
  await check(async () => { assert.equal((await request("/api/admin/teachers", teacher)).status, 403); });
  await check(async () => { assert.equal((await request(`/api/observations/${runtime.confirmed_ids[0]}/organize`, teacher, "POST", {}, "incorrect-token")).status, 403); });
  const admin = await login("admin");
  await check(async () => { assert.equal((await rows("/api/classes", "classes", admin)).length, 6); });
  await check(async () => { assert.equal((await rows("/api/children", "children", admin)).length, 94); });
  await check(async () => { assert.equal((await rows("/api/admin/teachers", "teachers", admin)).length, 3); });
  await check(async () => {
    // Ten real server renders exceed the five-client pool; every render must release its one client.
    const pages = await Promise.all(Array.from({ length: 10 }, () => request("/admin/teachers", admin)));
    for (const page of pages) { assert.equal(page.status, 200); const html = await page.text(); assert.ok(html.includes("教师与任教班级")); }
  });
  await check(async () => { assert.equal((await request(`/api/classes/${runtime.class_ids[3]}/evidence-overview`, admin)).status, 200); });
  await check(async () => { assert.equal((await request(`/api/observations/${runtime.confirmed_ids[0]}/organize`, admin, "POST", {})).status, 403); });
  const unassigned = await login("unassigned");
  await check(async () => { assert.equal((await request("/api/children", unassigned)).status, 403); });
  await check(async () => { const html = await (await request("/", unassigned)).text(); assert.ok(html.includes("等待班级分配")); assert.ok(!html.includes("去处理待确认")); });
  await check(async () => { assert.equal((await request("/api/auth/logout", teacher, "POST", {})).status, 200); assert.equal((await request("/api/children", teacher)).status, 401); });
  await check(async () => { const html = await (await request("/login?returnTo=%2Fclasses")).text(); assert.ok(html.includes("园所账号登录")); assert.ok(!html.includes("调用失败")); });
  console.log(JSON.stringify({ passed, total: 20, real_next_http: true, concurrent_admin_renders: 10, hosted_database: false,
    successful_business_writes: 0, models: "guarded; no generation requested" }));
} finally {
  for (const identity of sessions) await request("/api/auth/logout", identity, "POST", {}).catch(() => undefined);
}
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "HTTP checks failed");
  process.exitCode = 1;
});
