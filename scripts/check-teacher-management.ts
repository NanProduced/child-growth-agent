import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { authIdentityKey } from "../src/lib/accounts/client";
import { AccountsError } from "../src/lib/accounts/errors";
import { authorizeAction } from "../src/lib/accounts/authorize";
import type { AccessAction, AuthStatusResponse, Principal, TeacherAccountSummary } from "../src/lib/accounts/types";
import type { ResourceRef } from "../src/lib/accounts/access";
import type { TeacherClass } from "../src/components/accounts/teacher-management";

// Runs only owned source with substituted I/O: no env files, DB, server or model.
const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeRequire = createRequire(import.meta.url);
function loadOwned<T>(path: string, overrides: Record<string, unknown>): T {
  const source = readFileSync(`${root}${path}`, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const loadedModule = { exports: {} as unknown };
  const evaluate = runInThisContext(`(function(require, module, exports) { ${compiled}\n})`, { filename: path }) as
    (require: (name: string) => unknown, module: { exports: unknown }, exports: unknown) => void;
  evaluate((name) => name in overrides ? overrides[name]
    : runtimeRequire(name.startsWith("@/") ? `${root}src/${name.slice(2)}` : name), loadedModule, loadedModule.exports);
  return loadedModule.exports as T;
}

const admin: Principal = {
  account_id: "admin-fixture", username: "admin-fixture", display_name: "管理员",
  role: "admin", account_status: "active", scope: { kind: "school", school_id: "school-fixture" },
};
let uiAuth: AuthStatusResponse = {
  state: { kind: "authenticated", principal: admin },
  session: { session_id: "session-fixture", created_at: "2026-10-04", expires_at: "2026-10-05" },
  csrf: { header_name: "x-csrf-token", token: "offline-fixture" },
};
const teacher: TeacherAccountSummary = {
  account_id: "teacher /长名", username: "teacher-name", display_name: "一位有很长姓名需要在窄屏完整换行的教师",
  role: "teacher", status: "active", class_ids: ["class /甲"], created_at: "2026-10-04", updated_at: null,
};
const classes: TeacherClass[] = [
  { id: "class /甲", name: "一个需要在三百九十像素屏幕完整换行的长名称班级", stage: "small", school_year: "2026—2027", is_active: true },
  { id: "class /乙", name: "乙班", stage: "middle", school_year: "2026—2027", is_active: false },
];
const requests: { path: string; init: RequestInit }[] = [];
let respond: (path: string, init: RequestInit) => Promise<Response> = async () => Response.json({ teacher });
const Link = ({ children, href, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href }, children);
const client = loadOwned<typeof import("../src/components/accounts/teacher-management")>("src/components/accounts/teacher-management.tsx", {
  "next/link": { __esModule: true, default: Link },
  "@/components/teacher-provider": { useTeacher: () => ({
    auth: uiAuth, principal: uiAuth.state.kind === "authenticated" ? uiAuth.state.principal : null,
    loading: false, revalidate: async () => undefined,
  }) },
  "@/lib/accounts/client": { authIdentityKey, fetchWithAccountAuth: async (path: string, init: RequestInit = {}) => {
    requests.push({ path, init }); return respond(path, init);
  } },
});

let guardPrincipal = admin;
let guardError: AccountsError | null = null;
let readError = false;
let guardCallbackActive = false;
let scopedClassCalls = 0;
const reads: string[] = [];
const page = loadOwned<typeof import("../src/app/admin/teachers/page")>("src/app/admin/teachers/page.tsx", {
  "next/link": { __esModule: true, default: Link },
  "@/lib/accounts/errors": { AccountsError },
  "@/components/accounts/teacher-management": client,
  "@/lib/accounts/access": { withBusinessRead: async (
    _request: undefined, action: AccessAction, resource: ResourceRef, read: (principal: Principal) => Promise<unknown>,
  ) => {
    reads.push("guard"); assert.equal(action, "teacher.manage"); assert.equal(resource.kind, "school");
    if (guardError) throw guardError;
    const allowed = authorizeAction(guardPrincipal, action, { kind: "school", school_id: "school-fixture" });
    if (!allowed.allowed) throw new AccountsError("forbidden_role", "仅管理员");
    reads.push("authorized");
    assert.equal(guardCallbackActive, false, "must not open a nested administrator read");
    guardCallbackActive = true;
    try { return await read(guardPrincipal); }
    finally { guardCallbackActive = false; }
  } },
  "@/lib/accounts/repository": { listTeachers: async () => {
    assert.equal(guardCallbackActive, true); reads.push("teachers");
    if (readError) throw new Error("PRIVATE_DATABASE_DETAIL"); return [teacher];
  } },
  "@/lib/queries": { listClasses: async () => {
    assert.equal(guardCallbackActive, true, "class directory must use the existing fresh administrator read");
    reads.push("classes"); return classes;
  } },
  "@/lib/accounts/scoped-queries": { scopedListClasses: async () => {
    scopedClassCalls += 1;
    assert.equal(guardCallbackActive, false, "scopedListClasses must not acquire a second client inside the guard callback");
    reads.push("scoped-classes"); return classes;
  } },
});

let passed = 0;
async function check(label: string, work: () => void | Promise<void>) {
  requests.length = 0; reads.length = 0; scopedClassCalls = 0;
  try { await work(); } catch { throw new Error(`Failed: ${label}`); }
  passed += 1;
}
async function changeRejects(kind: "auth" | "rejected" | "uncertain") {
  await assert.rejects(client.persistTeacherChange({ kind: "assign", account_id: teacher.account_id, class_id: "class /乙" }),
    (error: unknown) => error instanceof client.TeacherChangeError && error.kind === kind);
  assert.equal(requests.length, 1);
}

async function main() {
  await check("administrator guard precedes both server reads", async () => {
    const element = await page.default();
    assert.equal(reads[0], "guard"); assert.equal(reads[1], "authorized");
    assert.ok(reads.includes("teachers") && reads.includes("classes"));
    assert.equal(element.type, client.TeacherManagement);
    assert.equal(element.props.adminAccountId, admin.account_id);
  });
  await check("guard callback uses unscoped classes without a nested read", async () => {
    const element = await page.default();
    assert.equal(element.type, client.TeacherManagement);
    assert.deepEqual(reads, ["guard", "authorized", "teachers", "classes"]);
    assert.equal(scopedClassCalls, 0);
    assert.equal(guardCallbackActive, false);
  });
  await check("teacher denied before private directories are read", async () => {
    guardPrincipal = { ...admin, role: "teacher", scope: { kind: "classes", class_ids: [classes[0].id] } };
    const html = renderToStaticMarkup(await page.default());
    assert.deepEqual(reads, ["guard"]); assert.ok(html.includes("仅管理员")); assert.ok(!html.includes(teacher.username));
    guardPrincipal = admin;
  });
  for (const code of ["unauthenticated", "account_disabled", "identity_unavailable"] as const) {
    await check(`${code} prevents private reads`, async () => {
      guardError = new AccountsError(code, "PRIVATE_IDENTITY_DETAIL");
      const html = renderToStaticMarkup(await page.default());
      assert.deepEqual(reads, ["guard"]); assert.ok(!html.includes("PRIVATE_IDENTITY_DETAIL"));
      assert.ok(!html.includes(teacher.username)); guardError = null;
    });
  }
  await check("read failure is not empty or raw database detail", async () => {
    readError = true; const html = renderToStaticMarkup(await page.default()); readError = false;
    assert.ok(html.includes("不能据此判断教师名单为空")); assert.ok(!html.includes("PRIVATE_DATABASE_DETAIL"));
  });
  await check("assignment posts exactly one class with encoded teacher path", async () => {
    respond = async () => Response.json({ teacher: { ...teacher, class_ids: [...teacher.class_ids, "class /乙"] }, password_hash: "DISCARD" });
    const result = await client.persistTeacherChange({ kind: "assign", account_id: teacher.account_id, class_id: "class /乙" });
    assert.equal(requests.length, 1); assert.equal(requests[0].path, `/api/admin/teachers/${encodeURIComponent(teacher.account_id)}/assignments`);
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { account_id: teacher.account_id, class_id: "class /乙" });
    assert.ok(!("password_hash" in result));
  });
  await check("removal uses DELETE and exact class identity", async () => {
    respond = async () => Response.json({ teacher: { ...teacher, class_ids: [] } });
    await client.persistTeacherChange({ kind: "remove", account_id: teacher.account_id, class_id: "class /甲" });
    assert.equal(requests.length, 1); assert.equal(requests[0].init.method, "DELETE");
    assert.ok(requests[0].path.endsWith(encodeURIComponent("class /甲")));
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { account_id: teacher.account_id, class_id: "class /甲" });
  });
  await check("disable uses persisted status and actual revocation count", async () => {
    respond = async () => Response.json({ teacher: { ...teacher, status: "disabled" }, revoked_session_count: 3 });
    const result = await client.persistTeacherChange({ kind: "status", account_id: teacher.account_id, status: "disabled" });
    assert.equal(requests[0].init.method, "PATCH"); assert.equal(result.revoked_session_count, 3);
    assert.equal(result.teacher.status, "disabled");
  });
  await check("enable is persisted separately from assignments", async () => {
    respond = async () => Response.json({ teacher, revoked_session_count: 0 });
    const result = await client.persistTeacherChange({ kind: "status", account_id: teacher.account_id, status: "active" });
    assert.equal(requests.length, 1); assert.equal(result.teacher.status, "active");
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { account_id: teacher.account_id, status: "active" });
  });
  await check("create normalizes username without altering the password", async () => {
    respond = async () => Response.json({ teacher: { ...teacher, username: "teacher-name", class_ids: [] } }, { status: 201 });
    await client.persistTeacherChange({ kind: "create", username: " ＴＥＡＣＨＥＲ-NAME ", display_name: ` ${teacher.display_name} `, initial_password: "  offline-fixture  " });
    const body: unknown = JSON.parse(String(requests[0].init.body));
    assert.ok(body && typeof body === "object" && "username" in body && body.username === "teacher-name");
    assert.ok("initial_password" in body && body.initial_password === "  offline-fixture  ");
    assert.ok(!("role" in body) && !("class_ids" in body)); assert.equal(requests.length, 1);
    const pending = client.pendingTeacherChange({ kind: "create", username: "TEACHER-NAME", display_name: teacher.display_name, initial_password: "offline-fixture" });
    assert.ok(!("initial_password" in pending)); assert.ok(client.teacherChangeObserved(pending, [teacher]));
  });
  for (const status of [401, 403, 409, 503]) {
    await check(`${status} does not replay the mutation`, async () => {
      respond = async () => Response.json({ error: "username_taken", message: "UNTRUSTED_DETAIL" }, { status });
      await changeRejects(status === 401 || status === 403 ? "auth" : status === 503 ? "uncertain" : "rejected");
    });
  }
  await check("lost response stays uncertain with one mutation attempt", async () => {
    respond = async () => { throw new Error("offline transport interruption"); }; await changeRejects("uncertain");
  });
  for (const body of [{ teacher: { ...teacher, account_id: "wrong-target" } }, { teacher }, { teacher: { ...teacher, role: "admin" } }]) {
    await check("uncorroborated success cannot update assignments", async () => {
      respond = async () => Response.json(body); await changeRejects("uncertain");
    });
  }
  await check("missing revocation count is uncertain rather than invented zero", async () => {
    respond = async () => Response.json({ teacher: { ...teacher, status: "disabled" } });
    await assert.rejects(client.persistTeacherChange({ kind: "status", account_id: teacher.account_id, status: "disabled" }),
      (error: unknown) => error instanceof client.TeacherChangeError && error.kind === "uncertain");
    assert.equal(requests.length, 1);
  });
  await check("reconciliation requires the requested current state", () => {
    assert.ok(!client.teacherChangeObserved({ kind: "assign", account_id: teacher.account_id, class_id: "class /乙" }, [teacher]));
    assert.ok(client.teacherChangeObserved({ kind: "remove", account_id: teacher.account_id, class_id: "class /乙" }, [teacher]));
    assert.ok(!client.teacherChangeObserved({ kind: "status", account_id: teacher.account_id, status: "disabled" }, [teacher]));
  });
  await check("directory reconciliation issues GETs only and strips extra fields", async () => {
    respond = async (path) => Response.json(path.includes("teachers") ? { teachers: [{ ...teacher, password_hash: "DISCARD" }] } : { classes });
    const directory = await client.readTeacherDirectory();
    assert.equal(requests.length, 2); assert.ok(requests.every(({ init }) => init.method === undefined && init.body === undefined));
    assert.ok(!("password_hash" in directory.teachers[0]));
  });
  await check("directory auth denial cannot display a partial private list", async () => {
    respond = async (path) => path.includes("teachers") ? Response.json({ teachers: [teacher] }) : Response.json({}, { status: 403 });
    await assert.rejects(client.readTeacherDirectory(), (error: unknown) => error instanceof client.TeacherChangeError && error.kind === "auth");
  });
  await check("an explicit auth denial wins over the other read's transport failure", async () => {
    respond = async (path) => {
      if (path.includes("teachers")) return Response.json({}, { status: 401 });
      throw new Error("offline transport interruption");
    };
    await assert.rejects(client.readTeacherDirectory(), (error: unknown) => error instanceof client.TeacherChangeError && error.kind === "auth");
    assert.equal(requests.length, 2);
  });
  await check("malformed directory cannot appear as empty success", async () => {
    respond = async (path) => Response.json(path.includes("teachers") ? { teachers: [] } : { classes: "invalid" });
    await assert.rejects(client.readTeacherDirectory());
  });
  await check("server markup preserves long names and named controls", () => {
    const html = renderToStaticMarkup(createElement(client.TeacherManagement, { adminAccountId: admin.account_id, initialTeachers: [teacher], initialClasses: classes }));
    assert.ok(html.includes(teacher.display_name) && html.includes(classes[0].name));
    assert.ok(html.includes("撤销任教") && html.includes("停用账号") && html.includes("min-h-11"));
    assert.ok(html.includes("overflow-wrap:anywhere"));
  });
  await check("client identity mismatch hides the private directory", () => {
    uiAuth = { ...uiAuth, state: { kind: "authenticated", principal: { ...admin, account_id: "different-admin" } } };
    const html = renderToStaticMarkup(createElement(client.TeacherManagement, { adminAccountId: admin.account_id, initialTeachers: [teacher], initialClasses: classes }));
    assert.ok(!html.includes(teacher.username) && !html.includes(teacher.display_name));
  });
  console.log(`Teacher management offline checks: ${passed}/${passed} passed (substituted I/O; browser/API acceptance not run).`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Teacher management offline check failed.");
  process.exitCode = 1;
});
