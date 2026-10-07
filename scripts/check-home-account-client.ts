import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

import {
  authIdentityKey, fetchWithAccountAuth, parseAccountStatus, readAccountStatus, unavailableStatus,
} from "../src/lib/accounts/client";
import { safeLoginReturn } from "../src/lib/accounts/login-return";
import { CSRF_HEADER_NAME, type AuthStatusResponse, type DataScope } from "../src/lib/accounts/types";

/** Assert-only mocks: no network/browser/React runtime, server, model, or dependency installation. */
const teacher: AuthStatusResponse = {
  state: { kind: "authenticated", principal: { account_id: "account-a", username: "teacher", display_name: "李老师",
    role: "teacher", account_status: "active", scope: { kind: "classes", class_ids: ["class-b", "class-a"] } } },
  session: { session_id: "session-a", created_at: "2026-10-04T00:00:00.000Z", expires_at: "2026-10-11T00:00:00.000Z" },
  csrf: { header_name: CSRF_HEADER_NAME, token: "csrf-session-a" },
};
const anonymous: AuthStatusResponse = { state: { kind: "anonymous" }, session: null, csrf: null };
const authenticatedPrincipal = () => {
  assert.equal(teacher.state.kind, "authenticated");
  if (teacher.state.kind !== "authenticated") throw new Error("fixture must be authenticated");
  return teacher.state.principal;
};
const rotated = (sessionId: string): AuthStatusResponse => ({ ...teacher,
  session: { ...teacher.session!, session_id: sessionId }, csrf: { header_name: CSRF_HEADER_NAME, token: `csrf-${sessionId}` } });

interface Call { path: string; method: string; init?: RequestInit; headers: Headers }
interface Step { path: string; method?: string; reply: Response | (() => Promise<Response>) }
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let queue: Step[] = [];
let calls: Call[] = [];
let authEvents = 0;
const events = new EventTarget();
events.addEventListener("cga:auth-changed", () => { authEvents += 1; });
Object.defineProperty(globalThis, "window", { configurable: true, value: events });
globalThis.fetch = async (input, init) => {
  const path = input instanceof Request ? new URL(input.url).pathname : input.toString();
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  calls.push({ path, method, init, headers });
  const step = queue.shift();
  assert.ok(step, `unexpected fetch ${method} ${path}; real fetch is never called`);
  assert.equal(path, step.path);
  assert.equal(method, step.method ?? "GET");
  return typeof step.reply === "function" ? step.reply() : step.reply;
};
const statusStep = (body: unknown, status = 200): Step => ({ path: "/api/auth/status", reply: Response.json(body, { status }) });
const rejectedFetch = () => Promise.reject<Response>(new TypeError("mock network failure"));
function mock(steps: Step[]): void { queue = steps; calls = []; authEvents = 0; }

let passed = 0;
const failures: { name: string; message: string }[] = [];
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    mock([]);
    await run();
    assert.equal(queue.length, 0, "all planned mock fetches must be consumed");
    passed += 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name, message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

// Execute only the provider's actual callback expressions with mocked closure values.
// JSX/effects are neither rendered nor simulated; this is logic evidence, not UI acceptance.
const providerSource = fs.readFileSync(fileURLToPath(new URL("../src/components/teacher-provider.tsx", import.meta.url)), "utf8");
const providerAst = ts.createSourceFile("teacher-provider.tsx", providerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
type ProviderCallback = (...args: unknown[]) => Promise<unknown>;
function providerCallbacks(initial: AuthStatusResponse) {
  const current = { current: initial };
  const generation = { current: 0 };
  const operationPending = { current: false };
  let visible = initial;
  let loading = false;
  let refreshes = 0;
  const replacements: string[] = [];
  function callback(name: string): ProviderCallback {
    let expression: ts.Expression | undefined;
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
        && node.initializer && ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "useCallback") {
        expression = node.initializer.arguments[0];
      }
      ts.forEachChild(node, visit);
    }
    visit(providerAst);
    assert.ok(expression, `provider callback ${name} must exist`);
    const js = ts.transpileModule(`(${expression.getText(providerAst)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const result: unknown = vm.runInNewContext(js, {
      current, generation, operationPending, readAccountStatus, authIdentityKey, parseAccountStatus, unavailableStatus, Headers,
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
      setAuth: (status: AuthStatusResponse) => { visible = status; },
      setLoading: (value: boolean) => { loading = value; },
      router: { refresh: () => { refreshes += 1; }, replace: (path: string) => { replacements.push(path); } },
    });
    assert.equal(typeof result, "function");
    return result as ProviderCallback;
  }
  return { revalidate: callback("revalidate"), login: callback("login"), logout: callback("logout"),
    current, visible: () => visible, loading: () => loading, refreshes: () => refreshes, replacements };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main(): Promise<void> {
  await check("parser accepts legitimate role/scope and state variants", () => {
    for (const body of [teacher, anonymous, unavailableStatus,
      { ...anonymous, state: { kind: "invalid_session", reason: "expired" } },
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), scope: { kind: "classes", class_ids: [] } } } },
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), scope: { kind: "none", reason: "no_assignment" } } } },
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), role: "admin", scope: { kind: "school", school_id: "school" } } } },
    ]) assert.ok(parseAccountStatus(body));
  });
  await check("parser rejects malformed state, missing credentials, disabled account, and wrong CSRF header", () => {
    for (const body of [null, {}, [], { ...teacher, state: { kind: "invented" } },
      { ...teacher, session: null }, { ...teacher, csrf: null }, { ...teacher, csrf: { header_name: "wrong", token: "x" } },
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), role: "owner" } } },
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), account_status: "disabled" } } },
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), scope: { kind: "all" } } } },
    ]) assert.equal(parseAccountStatus(body), null);
  });
  await check("parser strips unsolicited private metadata", () => {
    const parsed = parseAccountStatus({ ...teacher, password: "must-not-return", token_hash: "must-not-return",
      state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), password_hash: "must-not-return" } } });
    assert.ok(parsed);
    assert.ok(!JSON.stringify(parsed).includes("must-not-return"));
  });
  await check("parser rejects teacher with school scope", () => {
    assert.equal(parseAccountStatus({ ...teacher, state: { kind: "authenticated", principal: {
      ...authenticatedPrincipal(), scope: { kind: "school", school_id: "school" },
    } } }), null);
  });
  await check("parser rejects admin with teacher class scope", () => {
    assert.equal(parseAccountStatus({ ...teacher, state: { kind: "authenticated", principal: {
      ...authenticatedPrincipal(), role: "admin",
    } } }), null);
  });
  await check("identity key is stable for class order without mutating input", () => {
    const principal = authenticatedPrincipal();
    const reordered: AuthStatusResponse = { ...teacher, state: { kind: "authenticated", principal: {
      ...principal, scope: { kind: "classes", class_ids: ["class-a", "class-b"] },
    } } };
    const before = structuredClone(teacher);
    assert.equal(authIdentityKey(teacher), authIdentityKey(reordered));
    assert.deepEqual(teacher, before);
  });
  await check("identity key changes with session, account, role and assigned scope", () => {
    const variants: AuthStatusResponse[] = [rotated("session-b"),
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), account_id: "account-b" } } },
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), role: "admin", scope: { kind: "school", school_id: "school" } } } },
      { ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), scope: { kind: "classes", class_ids: ["class-c"] } } } },
    ];
    for (const status of variants) assert.notEqual(authIdentityKey(teacher), authIdentityKey(status));
    assert.notEqual(authIdentityKey(anonymous), authIdentityKey(unavailableStatus));
  });
  await check("identity key distinguishes none scope from class named none", () => {
    const keyed = (scope: DataScope) =>
      authIdentityKey({ ...teacher, state: { kind: "authenticated", principal: { ...authenticatedPrincipal(), scope } } });
    assert.notEqual(keyed({ kind: "none", reason: "no_assignment" }), keyed({ kind: "classes", class_ids: ["none"] }));
  });
  await check("identity key distinguishes single comma-containing class ID from two classes", () => {
    const keyed = (class_ids: string[]) => authIdentityKey({ ...teacher, state: { kind: "authenticated", principal: {
      ...authenticatedPrincipal(), scope: { kind: "classes", class_ids },
    } } });
    assert.notEqual(keyed(["a,b"]), keyed(["a", "b"]));
  });
  await check("status read uses no-store same-origin and preserves valid states", async () => {
    for (const status of [teacher, anonymous, unavailableStatus]) {
      mock([statusStep(status, status.state.kind === "unavailable" ? 503 : 200)]);
      assert.deepEqual(await readAccountStatus(), status);
      assert.equal(calls[0].init?.cache, "no-store");
      assert.equal(calls[0].init?.credentials, "same-origin");
    }
  });
  await check("network, non-JSON and malformed reads are unavailable, never fake anonymous", async () => {
    for (const reply of [rejectedFetch, new Response("not-json"), Response.json({}), Response.json({ state: { kind: "authenticated" } })]) {
      mock([{ path: "/api/auth/status", reply }]);
      assert.deepEqual(await readAccountStatus(), unavailableStatus);
    }
  });
  await check("HTTP 503 carrying anonymous body remains unavailable", async () => {
    mock([statusStep(anonymous, 503)]);
    assert.deepEqual(await readAccountStatus(), unavailableStatus);
  });
  await check("HTTP failure cannot authenticate even with shape-valid authenticated body", async () => {
    for (const status of [401, 403, 500, 503]) {
      mock([statusStep(teacher, status)]);
      assert.notEqual((await readAccountStatus()).state.kind, "authenticated");
    }
  });
  await check("GET/HEAD reads perform no preflight or write and preserve read failure", async () => {
    for (const method of ["GET", "HEAD"]) {
      const denied = new Response(null, { status: 503 });
      mock([{ path: "/api/classes", method, reply: denied }]);
      assert.equal(await fetchWithAccountAuth("/api/classes", { method }), denied);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init?.cache, "no-store");
      assert.equal(calls[0].init?.credentials, "same-origin");
      assert.equal(authEvents, 0);
    }
  });
  await check("failed auth preflight sends zero business POSTs", async () => {
    for (const status of [anonymous, unavailableStatus, { ...anonymous, state: { kind: "invalid_session", reason: "revoked" } }]) {
      mock([statusStep(status)]);
      const response = await fetchWithAccountAuth("/api/admin/teachers", { method: "POST", body: "{}" });
      assert.equal(response.status, status.state.kind === "unavailable" ? 503 : 401);
      assert.equal(calls.filter((call) => call.method === "POST").length, 0);
      assert.equal(calls.length, 1);
    }
    for (const reply of [rejectedFetch, new Response("not-json"), Response.json({})]) {
      mock([{ path: "/api/auth/status", reply }]);
      assert.equal((await fetchWithAccountAuth("/api/admin/teachers", { method: "POST", body: "{}" })).status, 503);
      assert.equal(calls.length, 1);
    }
  });
  await check("HTTP status read failure blocks business POST despite valid response shape", async () => {
    mock([statusStep(teacher, 503)]);
    const response = await fetchWithAccountAuth("/api/admin/teachers", { method: "POST", body: "{}" });
    assert.equal(response.status, 503);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  });
  await check("each write gets current-session CSRF without mutating caller headers or body", async () => {
    const headers = new Headers({ "content-type": "application/json", [CSRF_HEADER_NAME]: "stale-token" });
    const body = '{"account_id":"teacher"}';
    for (const sessionId of ["session-b", "session-c"]) {
      mock([statusStep(rotated(sessionId)), { path: "/api/admin/teachers", method: "POST", reply: Response.json({ ok: true }) }]);
      await fetchWithAccountAuth("/api/admin/teachers", { method: "post", headers, body });
      assert.equal(calls.length, 2);
      assert.equal(calls[1].headers.get(CSRF_HEADER_NAME), `csrf-${sessionId}`);
      assert.equal(calls[1].headers.get("content-type"), "application/json");
      assert.equal(calls[1].init?.body, body);
      assert.equal(calls[1].init?.credentials, "same-origin");
      assert.equal(headers.get(CSRF_HEADER_NAME), "stale-token");
    }
  });
  await check("failed writes returned once; auth notification never replays POST", async () => {
    for (const status of [401, 403, 409, 500, 503]) {
      const denied = Response.json({ error: "failed" }, { status });
      mock([statusStep(teacher), { path: "/api/admin/teachers", method: "POST", reply: denied }]);
      assert.equal(await fetchWithAccountAuth("/api/admin/teachers", { method: "POST", body: "{}" }), denied);
      assert.equal(calls.length, 2);
      assert.equal(calls.filter((call) => call.method === "POST").length, 1);
      assert.equal(authEvents, [401, 403, 503].includes(status) ? 1 : 0);
    }
  });
  await check("uncertain network write is thrown with no automatic retry", async () => {
    mock([statusStep(teacher), { path: "/api/admin/teachers", method: "POST", reply: rejectedFetch }]);
    await assert.rejects(() => fetchWithAccountAuth("/api/admin/teachers", { method: "POST", body: "{}" }), /mock network failure/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.length, 2);
  });
  await check("Request-input POST still requires status preflight and fresh CSRF", async () => {
    const input = new Request("https://app.invalid/api/admin/teachers", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    mock([statusStep(teacher), { path: "/api/admin/teachers", method: "POST", reply: Response.json({ ok: true }) }]);
    await fetchWithAccountAuth(input);
    assert.equal(calls[1].headers.get(CSRF_HEADER_NAME), teacher.csrf?.token);
  });
  await check("provider unavailable revalidation clears authenticated projection", async () => {
    const provider = providerCallbacks(teacher);
    mock([{ path: "/api/auth/status", reply: rejectedFetch }]);
    await provider.revalidate();
    assert.equal(provider.visible().state.kind, "unavailable");
    assert.equal(provider.current.current.state.kind, "unavailable");
    assert.equal(provider.refreshes(), 1);
  });
  await check("provider login requires valid authenticated response and keeps original password bytes", async () => {
    const provider = providerCallbacks(anonymous);
    mock([{ path: "/api/auth/login", method: "POST", reply: Response.json(teacher) }]);
    const result = await provider.login("teacher", " synthetic password ");
    assert.ok(typeof result === "object" && result !== null && "ok" in result && result.ok === true);
    assert.equal(calls[0].headers.get("x-cga-auth-request"), "1");
    assert.equal(calls[0].headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { username: "teacher", password: " synthetic password " });
    assert.equal(provider.visible().state.kind, "authenticated");
    assert.equal(provider.loading(), false);
  });
  await check("provider failed/malformed login cannot authenticate or replay", async () => {
    for (const reply of [Response.json({}), Response.json(teacher, { status: 401 }), Response.json(unavailableStatus, { status: 503 }), rejectedFetch]) {
      const provider = providerCallbacks(anonymous);
      mock([{ path: "/api/auth/login", method: "POST", reply }]);
      const result = await provider.login("teacher", "synthetic password");
      assert.ok(typeof result === "object" && result !== null && "ok" in result && result.ok === false);
      assert.notEqual(provider.visible().state.kind, "authenticated");
      assert.equal(calls.length, 1);
      assert.equal(provider.loading(), false);
    }
  });
  await check("provider logout uses fresh-session CSRF and clears only after successful POST", async () => {
    const provider = providerCallbacks(teacher);
    mock([statusStep(rotated("session-b")), { path: "/api/auth/logout", method: "POST", reply: Response.json(anonymous) }]);
    await provider.logout();
    assert.equal(calls[1].headers.get(CSRF_HEADER_NAME), "csrf-session-b");
    assert.equal(provider.visible().state.kind, "anonymous");
    assert.deepEqual(provider.replacements, ["/"]);
    assert.equal(calls.length, 2);
  });
  await check("provider failed logout stays uncertain/authenticated and never retries", async () => {
    for (const reply of [Response.json(unavailableStatus, { status: 503 }), rejectedFetch]) {
      const provider = providerCallbacks(teacher);
      mock([statusStep(teacher), { path: "/api/auth/logout", method: "POST", reply }]);
      await assert.rejects(() => provider.logout());
      assert.equal(provider.visible().state.kind, "authenticated");
      assert.equal(provider.loading(), false);
      assert.deepEqual(provider.replacements, []);
      assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    }
  });
  await check("older concurrent revalidation cannot replace newer session", async () => {
    const provider = providerCallbacks(teacher);
    const slow = deferredResponse();
    mock([{ path: "/api/auth/status", reply: () => slow.promise }, statusStep(rotated("session-b"))]);
    const earlier = provider.revalidate();
    await provider.revalidate();
    slow.resolve(Response.json(teacher));
    await earlier;
    assert.equal(provider.visible().session?.session_id, "session-b");
  });
  await check("pre-logout status response cannot restore authenticated projection after logout", async () => {
    const provider = providerCallbacks(teacher);
    const slow = deferredResponse();
    mock([{ path: "/api/auth/status", reply: () => slow.promise }, statusStep(teacher),
      { path: "/api/auth/logout", method: "POST", reply: Response.json(anonymous) }]);
    const earlier = provider.revalidate();
    await provider.logout();
    assert.equal(provider.visible().state.kind, "anonymous");
    slow.resolve(Response.json(teacher));
    await earlier;
    assert.equal(provider.visible().state.kind, "anonymous");
    assert.equal(provider.current.current.state.kind, "anonymous");
  });
  await check("revalidation overlapping login/logout cannot strand loading", async () => {
    const loadingStates: boolean[] = [];
    for (const operation of ["login", "logout"] as const) {
      const initial = operation === "login" ? anonymous : teacher;
      const provider = providerCallbacks(initial);
      const slow = deferredResponse();
      mock([
        operation === "login"
          ? { path: "/api/auth/login", method: "POST", reply: () => slow.promise }
          : { path: "/api/auth/status", reply: () => slow.promise },
        ...(operation === "logout" ? [{ path: "/api/auth/logout", method: "POST", reply: Response.json(anonymous) }] : []),
      ]);
      const pending = operation === "login" ? provider.login("teacher", "synthetic password") : provider.logout();
      assert.equal(provider.loading(), true);
      await provider.revalidate();
      assert.equal(calls.length, 1, "focus revalidation must not fetch while an account operation is pending");
      slow.resolve(Response.json(teacher));
      await pending;
      assert.equal(queue.length, 0);
      assert.equal(provider.refreshes(), 1, "the successful account operation owns the refresh");
      loadingStates.push(provider.loading());
    }
    assert.deepEqual(loadingStates, [false, false], "superseded login/logout must release loading after all callbacks finish");
  });
  await check("local login returns preserve route/query/hash and never become external", () => {
    for (const value of ["/", "/classes", "/children/child-a?tab=history#latest", "/observations?status=needs_input",
      "/children/%E7%B3%96%E7%B3%96", "/classes/../children", "/classes?next=https%3A%2F%2Fevil.example"]) {
      const result = safeLoginReturn(value);
      assert.equal(new URL(result, "https://app.invalid").origin, "https://app.invalid");
      assert.equal(result, new URL(value, "https://app.invalid").pathname + new URL(value, "https://app.invalid").search + new URL(value, "https://app.invalid").hash);
    }
  });
  await check("direct/encoded external, protocol-relative, backslash and control returns rejected", () => {
    for (const value of [undefined, "", "https://evil.example", "//evil.example", "///evil.example", "javascript:alert(1)",
      "https%3A%2F%2Fevil.example", "%2F%2Fevil.example", "%252F%252Fevil.example", "/\\evil.example", "/foo\nbar", "/foo\u0000bar"]) {
      assert.equal(safeLoginReturn(value), "/", `reject ${JSON.stringify(value)}`);
    }
  });
  await check("API login returns rejected including normalized dot paths", () => {
    for (const value of ["/api", "/api/auth/status", "/classes/../api/admin/teachers", "/classes/%2e%2e/api/auth/logout"]) {
      assert.equal(safeLoginReturn(value), "/");
    }
  });
  await check("raw dot normalization cannot produce external redirect target", () => {
    const result = safeLoginReturn("/.//evil.example");
    assert.equal(new URL(result, "https://app.invalid").origin, "https://app.invalid",
      `normalized return ${JSON.stringify(result)} changes origin on navigation`);
  });
  await check("encoded dot normalization cannot produce external redirect target", () => {
    for (const value of ["/%2e//evil.example", "/%2E%2E//evil.example", "/classes/%2e%2e//evil.example"]) {
      const result = safeLoginReturn(value);
      assert.equal(new URL(result, "https://app.invalid").origin, "https://app.invalid",
        `normalized return ${JSON.stringify(result)} changes origin on navigation`);
    }
  });
}

void main().catch((error: unknown) => {
  failures.push({ name: "test harness", message: error instanceof Error ? error.message : String(error) });
}).finally(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  console.log(JSON.stringify({ passed, total: passed + failures.length, failures,
    mock_fetch_only: true, provider_callbacks_only: true, real_browser: false, real_server: false, model_requests: 0 }));
  process.exitCode = failures.length ? 1 : 0;
});
