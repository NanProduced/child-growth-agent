import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { AccountsError } from "../src/lib/accounts/errors";
import type { AuthState, Principal } from "../src/lib/accounts/types";
import type { ScopedObservation } from "../src/lib/accounts/scoped-queries";
import type { ActivitySupport, Child, ChildClassEnrollment, GrowthProfile, SchoolClass } from "../src/lib/types";

/**
 * Offline role-entry projection checks: pages render with substituted identity/data I/O only.
 * No database, network, browser, server or model is used; server-side authorization is NOT re-proven here.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeRequire = createRequire(import.meta.url);
const overrides: Record<string, unknown> = {};
const moduleCache = new Map<string, unknown>();

function resolveFile(base: string): string | null {
  for (const candidate of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    try { readFileSync(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}
function resolveLocal(spec: string, fromFile: string): string | null {
  if (spec.startsWith("@/")) return resolveFile(path.join(root, "src", spec.slice(2)));
  if (spec.startsWith(".")) return resolveFile(path.resolve(path.dirname(fromFile), spec));
  return null;
}

function load<T>(file: string): T {
  const cached = moduleCache.get(file);
  if (cached !== undefined) return cached as T;
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const moduleObject = { exports: {} as unknown };
  moduleCache.set(file, moduleObject.exports);
  const localRequire = (name: string): unknown => {
    if (name in overrides) return overrides[name];
    const local = resolveLocal(name, file);
    return local ? load(local) : runtimeRequire(name);
  };
  const evaluate = runInThisContext(`(function(require, module, exports) { ${compiled}\n})`, { filename: file }) as
    (require: (name: string) => unknown, module: { exports: unknown }, exports: unknown) => void;
  evaluate(localRequire, moduleObject, moduleObject.exports);
  moduleCache.set(file, moduleObject.exports);
  return moduleObject.exports as T;
}
function loadSrc<T>(rel: string): T { return load<T>(path.join(root, rel)); }

/* ------------------------------- fixtures ------------------------------- */

const classA: SchoolClass = { id: "class-a", name: "芽芽班", stage: "small", school_year: "2026-2027", is_active: true, is_demo: true, created_at: "2026-09-01T00:00:00.000Z", updated_at: null };
const classB: SchoolClass = { id: "class-b", name: "苗苗班", stage: "middle", school_year: "2026-2027", is_active: true, is_demo: true, created_at: "2026-09-01T00:00:00.000Z", updated_at: null };
const child: Child = {
  id: "child-a", name: "小雨", gender: "女", birth_date: "2022-05-01", class_name: classA.name, class_id: classA.id,
  current_class: classA, class_stage: "small", class_school_year: classA.school_year, avatar_emoji: null, note: null,
  growth_profile: null, is_demo: true, created_at: "2026-09-01T00:00:00.000Z", updated_at: null,
};
function observation(overridesObservation: Partial<ScopedObservation>): ScopedObservation {
  return {
    id: "observation-a", child_id: child.id, class_id: classA.id, observed_class: classA, observed_at: "2026-09-30",
    context: "建构区", raw_text: "幼儿把积木排成一排。", status: "draft", agent_context: null, ai_draft: null,
    ai_model: null, ai_organized_at: null, confirmed_content: null, confirmed_at: null, is_demo: true,
    created_at: "2026-09-30T00:00:00.000Z", updated_at: null,
    access_projection: "full", can_write: true,
    ...overridesObservation,
  };
}

const activitySupport: ActivitySupport = {
  suggestions: [{
    title: "楼梯测量", purpose: "在真实情境中比较高低",
    steps: ["用积木搭出台阶", "给玩偶量身高并记录"], materials: ["积木", "软尺"],
    observe: "是否主动比较并说出理由", adaptation: "材料不够时改用椅子", evidence: ["童童连续跳过三条标线"],
  }, {
    title: "跳格子接力", purpose: "在游戏中练习连续跳跃",
    steps: ["用粉笔画出不同间距格子", "与同伴轮流跳完全程"], materials: ["粉笔"],
    observe: "落地是否稳定", adaptation: "缩小格子间距", evidence: ["连续跳过三条标线"],
  }],
  source_observation_ids: ["observation-confirmed"], ai_model: "fixture-model", generated_at: "2026-10-04T00:00:00.000Z",
};
const growthProfile: GrowthProfile = {
  summary: "童童喜欢用身体动作探索空间。", recent_change: "连续跳跃更稳定。", development_clues: ["连续跳跃"],
  next_support: "提供不同间距的标线。", next_focus: "落地方式。",
  source_observation_ids: ["observation-confirmed"], ai_model: "fixture-model", updated_at: "2026-10-04T00:00:00.000Z",
  activity_support: activitySupport,
};
const confirmedObservation = observation({ id: "observation-confirmed", status: "confirmed", can_write: true,
  class_id: classA.id, confirmed_content: {
    domain: "健康", sub_domain: "动作发展", objective_description: "幼儿连续跳过三条标线。",
    highlights: ["连续跳跃"], support_suggestions: ["提供不同间距的标线。"], highlight_quote: "连续跳过三条标线",
  } });
const childWithSupport: Child = { ...child, growth_profile: growthProfile };

const admin: Principal = { account_id: "admin-a", username: "admin", display_name: "园长", role: "admin", account_status: "active", scope: { kind: "school", school_id: "school-a" } };
const teacher: Principal = { account_id: "teacher-a", username: "teacher", display_name: "林老师", role: "teacher", account_status: "active", scope: { kind: "classes", class_ids: [classA.id] } };
const unassigned: Principal = { account_id: "teacher-u", username: "unassigned", display_name: "待分班老师", role: "teacher", account_status: "active", scope: { kind: "none", reason: "no_assignment" } };

const scenario = {
  auth: { kind: "authenticated", principal: admin } as AuthState,
  classes: [classA, classB] as SchoolClass[],
  children: [child] as Child[],
  observations: [] as ScopedObservation[],
  klass: classA as SchoolClass | null,
  classChildren: [child] as Child[],
  child: child as Child | null,
  enrollments: [] as ChildClassEnrollment[],
  failure: null as unknown,
  viewer: admin as Principal | null,
  canCreateProfiles: true,
};

const Link = ({ children, href, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href }, children);
overrides["next/link"] = { __esModule: true, default: Link };
overrides["next/navigation"] = {
  notFound: (): never => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
};
overrides["@/lib/accounts/errors"] = { AccountsError };
overrides["@/lib/accounts/access"] = {
  resolveServerAuth: async () => ({ state: scenario.auth, session: null, csrf: null, token: null }),
};
function scoped<T>(value: T): Promise<T> {
  if (scenario.failure) return Promise.reject(scenario.failure);
  return Promise.resolve(value);
}
overrides["@/lib/accounts/scoped-queries"] = {
  scopedListClasses: () => scoped(scenario.classes),
  scopedListChildren: () => scoped(scenario.children),
  scopedListObservations: () => scoped(scenario.observations),
  scopedGetClass: () => scoped(scenario.klass),
  scopedGetClassChildren: () => scoped(scenario.classChildren),
  scopedGetChild: () => scoped(scenario.child),
  scopedListEnrollments: () => scoped(scenario.enrollments),
};
overrides["@/components/class-dialogs"] = {
  ClassFormDialog: (props: { label: string }) => createElement("button", { type: "button" }, props.label),
  TransferClassDialog: () => createElement("button", { type: "button" }, "转班"),
};
overrides["@/components/growth-profile-retry"] = { GrowthProfileRetry: () => null };
overrides["@/lib/accounts/client"] = {
  authIdentityKey: () => "identity",
  fetchWithAccountAuth: async () => { throw new Error("offline check performs no network"); },
};
overrides["@/components/teacher-provider"] = {
  useTeacher: () => ({
    loading: false, configured: true, isTeacher: scenario.viewer?.role === "teacher",
    canManageClasses: scenario.viewer?.role === "admin", canCreateProfiles: scenario.canCreateProfiles,
    principal: scenario.viewer, auth: { state: scenario.auth, session: null, csrf: null },
    login: async () => ({ ok: true }), logout: async () => undefined, revalidate: async () => undefined,
  }),
};

const classesPage = loadSrc<{ default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement> }>("src/app/classes/page.tsx");
const classDetailPage = loadSrc<{ default: (props: { params: Promise<{ id: string }> }) => Promise<ReactElement> }>("src/app/classes/[id]/page.tsx");
const childrenPage = loadSrc<{ default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement> }>("src/app/children/page.tsx");
const childDetailPage = loadSrc<{ default: (props: { params: Promise<{ id: string }> }) => Promise<ReactElement> }>("src/app/children/[id]/page.tsx");
const childNewPage = loadSrc<{ default: () => ReactElement }>("src/app/children/new/page.tsx");
const observationsPage = loadSrc<{ default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement> }>("src/app/observations/page.tsx");
const reportsPage = loadSrc<{ default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement> }>("src/app/reports/page.tsx");
const activitiesPage = loadSrc<{ default: () => Promise<ReactElement> }>("src/app/activities/page.tsx");
const activitySupportSection = loadSrc<{ ActivitySupportSection: (props: {
  childId: string; confirmedObservationCount: number; initialSupport: ActivitySupport | null;
  hasStaleSupport?: boolean; readOnly?: boolean;
}) => ReactElement }>("src/components/activity-support-section.tsx");

async function render(page: { default: (props: never) => ReactElement | Promise<ReactElement> }, props: unknown): Promise<string> {
  return renderToStaticMarkup(await page.default(props as never));
}
function reset(next: Partial<typeof scenario>) {
  Object.assign(scenario, {
    auth: { kind: "authenticated", principal: admin }, classes: [classA, classB], children: [child],
    observations: [], klass: classA, classChildren: [child], child, enrollments: [], failure: null,
    viewer: admin, canCreateProfiles: true,
  }, next);
}

let passed = 0;
async function check(label: string, work: () => Promise<void> | void) {
  try { await work(); } catch (error: unknown) {
    throw new Error(`Failed: ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  passed += 1;
}

async function main() {
  await check("classes page hides class management from teachers", async () => {
    reset({ viewer: teacher, auth: { kind: "authenticated", principal: teacher } });
    const html = await render(classesPage, { searchParams: Promise.resolve({}) });
    assert.ok(!html.includes("新建班级"));
    assert.ok(html.includes(classA.name) && html.includes(classB.name));
  });
  await check("classes page keeps class management for administrators", async () => {
    reset({});
    const html = await render(classesPage, { searchParams: Promise.resolve({}) });
    assert.ok(html.includes("新建班级"));
  });
  await check("empty classes outcome is honest for administrators and managed by teachers", async () => {
    reset({ classes: [], children: [] });
    const adminHtml = await render(classesPage, { searchParams: Promise.resolve({}) });
    assert.ok(adminHtml.includes("还没有班级") && adminHtml.includes("新建班级"));
    reset({ classes: [], children: [], viewer: teacher, auth: { kind: "authenticated", principal: teacher } });
    const teacherHtml = await render(classesPage, { searchParams: Promise.resolve({}) });
    assert.ok(teacherHtml.includes("请联系管理员"));
    assert.ok(!teacherHtml.includes("新建班级"));
  });
  await check("lost session never renders an empty class list", async () => {
    reset({ auth: { kind: "anonymous" } });
    const html = await render(classesPage, { searchParams: Promise.resolve({}) });
    assert.ok(html.includes("请先登录园所账号"));
    assert.ok(!html.includes("还没有班级"));
  });
  await check("empty scope and identity outage are distinct from an empty class list", async () => {
    scenario.auth = { kind: "authenticated", principal: teacher };
    reset({ auth: { kind: "authenticated", principal: teacher }, failure: new AccountsError("empty_scope", "PRIVATE_SCOPE_DETAIL") });
    const denied = await render(classesPage, { searchParams: Promise.resolve({}) });
    assert.ok(denied.includes("当前账号没有访问权限"));
    assert.ok(!denied.includes("还没有班级") && !denied.includes("PRIVATE_SCOPE_DETAIL"));
    reset({ failure: new AccountsError("identity_unavailable", "PRIVATE_IDENTITY_DETAIL") });
    const unavailable = await render(classesPage, { searchParams: Promise.resolve({}) });
    assert.ok(unavailable.includes("资料服务暂时不可用"));
    assert.ok(!unavailable.includes("还没有班级") && !unavailable.includes("PRIVATE_IDENTITY_DETAIL"));
    reset({ failure: new Error("PRIVATE_DATABASE_DETAIL") });
    const broken = await render(classesPage, { searchParams: Promise.resolve({}) });
    assert.ok(broken.includes("数据库暂不可用"));
    assert.ok(!broken.includes("还没有班级") && !broken.includes("PRIVATE_DATABASE_DETAIL"));
  });

  await check("class detail gates observation entry to teachers and management to administrators", async () => {
    reset({ observations: [], classChildren: [] });
    const adminHtml = await render(classDetailPage, { params: Promise.resolve({ id: classA.id }) });
    assert.ok(adminHtml.includes("编辑班级"));
    assert.ok(!adminHtml.includes("记录一次观察"));
    assert.ok(!adminHtml.includes("去创建班级"));
    reset({ viewer: teacher, auth: { kind: "authenticated", principal: teacher }, observations: [], classChildren: [] });
    const teacherHtml = await render(classDetailPage, { params: Promise.resolve({ id: classA.id }) });
    assert.ok(teacherHtml.includes("记录一次观察"));
    assert.ok(!teacherHtml.includes("编辑班级"));
  });
  await check("class detail shows no teaching entry when the session is gone", async () => {
    reset({ auth: { kind: "invalid_session", reason: "expired" } });
    const html = await render(classDetailPage, { params: Promise.resolve({ id: classA.id }) });
    assert.ok(html.includes("请先登录园所账号"));
    assert.ok(!html.includes("记录一次观察") && !html.includes("编辑班级"));
  });

  await check("child detail gates transfer to administrators and observation writes to teachers", async () => {
    reset({ observations: [], enrollments: [] });
    const adminHtml = await render(childDetailPage, { params: Promise.resolve({ id: child.id }) });
    assert.ok(adminHtml.includes("转班"));
    assert.ok(!adminHtml.includes("记录一次观察") && !adminHtml.includes("再记一条"));
    assert.ok(adminHtml.includes("还没有活动支持建议"));
    assert.ok(!adminHtml.includes(">生成活动支持</button>") && !adminHtml.includes(">重新生成</button>") && !adminHtml.includes(">再试一次</button>"));
    reset({ viewer: teacher, auth: { kind: "authenticated", principal: teacher }, observations: [], enrollments: [] });
    const teacherHtml = await render(childDetailPage, { params: Promise.resolve({ id: child.id }) });
    assert.ok(teacherHtml.includes("记录一次观察"));
    assert.ok(teacherHtml.includes("先确认一条观察"));
    assert.ok(!teacherHtml.includes("转班"));
  });
  await check("administrators read full saved activity support without write controls", () => {
    const render = (props: Parameters<typeof activitySupportSection.ActivitySupportSection>[0]) =>
      renderToStaticMarkup(createElement(activitySupportSection.ActivitySupportSection, props));
    const readOnlyHtml = render({ childId: child.id, confirmedObservationCount: 1, initialSupport: activitySupport, readOnly: true });
    for (const text of ["楼梯测量", "在真实情境中比较高低", "用积木搭出台阶", "积木", "软尺", "是否主动比较并说出理由", "材料不够时改用椅子", "童童连续跳过三条标线", "跳格子接力", "粉笔"]) {
      assert.ok(readOnlyHtml.includes(text), `missing read-only content: ${text}`);
    }
    assert.ok(!readOnlyHtml.includes(">生成活动支持</button>") && !readOnlyHtml.includes(">重新生成</button>") && !readOnlyHtml.includes(">再试一次</button>"));
    const staleHtml = render({ childId: child.id, confirmedObservationCount: 1, initialSupport: null, hasStaleSupport: true, readOnly: true });
    assert.ok(staleHtml.includes("请由教师重新生成"));
    assert.ok(!staleHtml.includes(">重新生成</button>"));
    const emptyHtml = render({ childId: child.id, confirmedObservationCount: 0, initialSupport: null, readOnly: true });
    assert.ok(emptyHtml.includes("还没有活动支持建议") && emptyHtml.includes("由教师"));
    assert.ok(!emptyHtml.includes("先确认一条观察") && !emptyHtml.includes(">生成活动支持</button>"));
    scenario.viewer = teacher;
    const teacherHtml = render({ childId: child.id, confirmedObservationCount: 1, initialSupport: activitySupport });
    assert.ok(teacherHtml.includes("重新生成"));
  });
  await check("admin child detail shows the saved activity support body read-only", async () => {
    reset({ child: childWithSupport, observations: [confirmedObservation], enrollments: [] });
    const adminHtml = await render(childDetailPage, { params: Promise.resolve({ id: child.id }) });
    assert.ok(adminHtml.includes("楼梯测量") && adminHtml.includes("用积木搭出台阶") && adminHtml.includes("软尺"));
    assert.ok(!adminHtml.includes(">重新生成</button>") && !adminHtml.includes(">生成活动支持</button>"));
    reset({ child: childWithSupport, observations: [confirmedObservation], viewer: teacher, auth: { kind: "authenticated", principal: teacher }, enrollments: [] });
    const teacherHtml = await render(childDetailPage, { params: Promise.resolve({ id: child.id }) });
    assert.ok(teacherHtml.includes("楼梯测量") && teacherHtml.includes("重新生成"));
  });
  await check("child detail read failure is not an empty profile", async () => {
    reset({ failure: new AccountsError("out_of_scope", "PRIVATE_SCOPE_DETAIL") });
    const html = await render(childDetailPage, { params: Promise.resolve({ id: child.id }) });
    assert.ok(html.includes("当前账号没有访问权限"));
    assert.ok(!html.includes("还没有观察记录") && !html.includes("PRIVATE_SCOPE_DETAIL"));
  });

  await check("observations page gives administrators browse-only copy", async () => {
    reset({ observations: [], children: [], classes: [] });
    const adminHtml = await render(observationsPage, { searchParams: Promise.resolve({}) });
    assert.ok(!adminHtml.includes("开始记录"));
    assert.ok(adminHtml.includes("管理员查看全园观察记录"));
    reset({ observations: [], children: [], classes: [], viewer: teacher, auth: { kind: "authenticated", principal: teacher } });
    const teacherHtml = await render(observationsPage, { searchParams: Promise.resolve({}) });
    assert.ok(teacherHtml.includes("开始记录"));
  });

  await check("reports todo entry only targets currently writable records", async () => {
    const historicalDraft = observation({ id: "observation-historical", status: "draft", access_projection: "historical_read_only", can_write: false });
    reset({ viewer: teacher, auth: { kind: "authenticated", principal: teacher }, observations: [historicalDraft] });
    const historyHtml = await render(reportsPage, { searchParams: Promise.resolve({ child: child.id }) });
    assert.ok(!historyHtml.includes("继续整理观察"));
    assert.ok(historyHtml.includes("记录一次观察"));
    const writableDraft = observation({ id: "observation-writable", status: "draft", can_write: true });
    reset({ viewer: teacher, auth: { kind: "authenticated", principal: teacher }, observations: [historicalDraft, writableDraft] });
    const writableHtml = await render(reportsPage, { searchParams: Promise.resolve({ child: child.id }) });
    assert.ok(writableHtml.includes("继续整理观察"));
    assert.ok(writableHtml.includes(`/observations/${writableDraft.id}/review`));
    const confirmable = observation({ id: "observation-confirmable", status: "ai_organized", can_write: true });
    reset({ viewer: teacher, auth: { kind: "authenticated", principal: teacher }, observations: [writableDraft, confirmable] });
    const priorityHtml = await render(reportsPage, { searchParams: Promise.resolve({ child: child.id }) });
    assert.ok(priorityHtml.includes("先确认一条观察"));
    assert.ok(priorityHtml.includes(`/observations/${confirmable.id}/review`));
  });
  await check("reports keeps administrators out of teaching entries", async () => {
    const aiOrganized = observation({ id: "observation-admin", status: "ai_organized", can_write: false });
    reset({ observations: [aiOrganized] });
    const pendingHtml = await render(reportsPage, { searchParams: Promise.resolve({ child: child.id }) });
    assert.ok(!pendingHtml.includes("先确认一条观察") && !pendingHtml.includes("继续整理观察"));
    assert.ok(pendingHtml.includes("查看成长档案"));
    const confirmed = observation({ id: "observation-confirmed", status: "confirmed", can_write: false, confirmed_content: {
      domain: "健康", sub_domain: "动作发展", objective_description: "幼儿连续跳过三条标线。",
      highlights: ["连续跳跃"], support_suggestions: ["提供不同间距的标线。"], highlight_quote: "连续跳过三条标线",
    } });
    reset({ observations: [confirmed] });
    const profileHtml = await render(reportsPage, { searchParams: Promise.resolve({ child: child.id }) });
    assert.ok(!profileHtml.includes("去生成活动支持"));
    assert.ok(profileHtml.includes("由教师从已确认观察整理生成"));
  });
  await check("reports read failure never becomes an empty profile", async () => {
    reset({ failure: new AccountsError("identity_unavailable", "PRIVATE_IDENTITY_DETAIL") });
    const html = await render(reportsPage, { searchParams: Promise.resolve({}) });
    assert.ok(html.includes("资料服务暂时不可用"));
    assert.ok(!html.includes("还没有成长档案") && !html.includes("PRIVATE_IDENTITY_DETAIL"));
  });

  await check("children and activities read failures never render empty states", async () => {
    reset({ failure: new AccountsError("empty_scope", "PRIVATE_SCOPE_DETAIL") });
    const childrenDenied = await render(childrenPage, { searchParams: Promise.resolve({}) });
    assert.ok(childrenDenied.includes("当前账号没有访问权限"));
    assert.ok(!childrenDenied.includes("还没有成长档案") && !childrenDenied.includes("PRIVATE_SCOPE_DETAIL"));
    const activitiesDenied = await render(activitiesPage, {});
    assert.ok(activitiesDenied.includes("当前账号没有访问权限"));
    assert.ok(!activitiesDenied.includes("还没有成长档案") && !activitiesDenied.includes("PRIVATE_SCOPE_DETAIL"));
    reset({ failure: new Error("PRIVATE_DATABASE_DETAIL") });
    const childrenBroken = await render(childrenPage, { searchParams: Promise.resolve({}) });
    assert.ok(childrenBroken.includes("数据库暂不可用"));
    assert.ok(!childrenBroken.includes("还没有成长档案") && !childrenBroken.includes("PRIVATE_DATABASE_DETAIL"));
    const activitiesBroken = await render(activitiesPage, {});
    assert.ok(activitiesBroken.includes("数据库暂不可用"));
    assert.ok(!activitiesBroken.includes("还没有成长档案") && !activitiesBroken.includes("PRIVATE_DATABASE_DETAIL"));
  });
  await check("unassigned teacher gets contact-admin guidance without a class shortcut", () => {
    reset({ viewer: unassigned, canCreateProfiles: false, auth: { kind: "authenticated", principal: unassigned } });
    const html = renderToStaticMarkup(createElement(childNewPage.default));
    assert.ok(html.includes("尚未分配任教班级"));
    assert.ok(html.includes("请联系管理员"));
    assert.ok(!html.includes("去创建班级"));
  });
  await check("logged-out visitor sees login state, not an empty class picker", () => {
    reset({ viewer: null, canCreateProfiles: false, auth: { kind: "anonymous" } });
    const html = renderToStaticMarkup(createElement(childNewPage.default));
    assert.ok(html.includes("需要园所账号登录"));
    assert.ok(html.includes("/login?returnTo=%2Fchildren%2Fnew"));
    assert.ok(!html.includes("还没有可用班级"));
  });
  await check("expired session gets the login entry", () => {
    reset({ viewer: null, canCreateProfiles: false, auth: { kind: "invalid_session", reason: "revoked" } });
    const html = renderToStaticMarkup(createElement(childNewPage.default));
    assert.ok(html.includes("需要园所账号登录") && html.includes("/login?returnTo=%2Fchildren%2Fnew"));
  });
  await check("identity outage is distinct from login and does not ask for credentials", () => {
    reset({ viewer: null, canCreateProfiles: false, auth: { kind: "unavailable", reason: "identity_service_unavailable" } });
    const html = renderToStaticMarkup(createElement(childNewPage.default));
    assert.ok(html.includes("账号服务暂时不可用") && html.includes("重新核验"));
    assert.ok(html.includes("重复输入账号密码"));
    assert.ok(!html.includes("需要园所账号登录") && !html.includes("尚未分配任教班级"));
  });
  await check("late directory responses are generation-guarded and identity changes clear the projection", () => {
    const source = readFileSync(path.join(root, "src/app/children/new/page.tsx"), "utf8");
    assert.ok(source.includes("directoryGeneration"));
    assert.ok(source.includes("requestGeneration === directoryGeneration.current"));
    assert.ok(source.includes("requestGeneration !== directoryGeneration.current"));
    assert.ok(/directoryGeneration\.current \+= 1;[\s\S]{0,120}setDirectory\(\{ status: 'loading' \}\)/.test(source));
  });

  console.log(`Role entry projection checks: ${passed}/${passed} passed (substituted identity/data; server authorization and browser not run).`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Role entry check failed.");
  process.exitCode = 1;
});
