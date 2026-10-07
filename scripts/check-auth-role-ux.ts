import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
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

/**
 * AUTH-UX1 acceptance: isolated PostgreSQL container + real Next dev server + real Chrome.
 * No real model provider request is allowed (request guard env); passwords never reach artifacts.
 * Ports are probed before start; only this run's child processes/container are cleaned by identity.
 */

const root = process.cwd();
const port = Number(process.env.AUTH_UX_PORT ?? 5037);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "AUTH_UX_PORT must be a real port");
const base = `http://127.0.0.1:${port}`;
const runtimeRequire = createRequire(import.meta.url);

/* ------------------------------ browser adapters ------------------------------ */

interface BrowserLocator {
  first(): BrowserLocator;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  waitFor(options?: { state?: "visible" | "attached"; timeout?: number }): Promise<void>;
}
interface RouteLike {
  fetch(): Promise<{ status(): number; text(): Promise<string> }>;
  continue(): Promise<void>;
  fulfill(options: { status: number; contentType?: string; body: string }): Promise<void>;
}
interface BrowserPage {
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  getByText(text: string | RegExp): BrowserLocator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): BrowserLocator;
  locator(selector: string): BrowserLocator;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options?: { path?: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<T>(fn: string | (() => T | Promise<T>)): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  waitForURL(predicate: (url: { pathname: string; search: string; toString(): string }) => boolean, options?: { timeout?: number }): Promise<void>;
  reload(options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }): Promise<unknown>;
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  unroute(pattern: string): Promise<void>;
  url(): string;
  request: { get(url: string): Promise<{ status(): number; json(): Promise<unknown> }> };
}
interface BrowserContext { newPage(): Promise<BrowserPage>; close(): Promise<void> }
interface Browser { newContext(options?: { viewport?: { width: number; height: number } }): Promise<BrowserContext>; close(): Promise<void> }
interface Chromium { launch(options?: Record<string, unknown>): Promise<Browser> }
interface PlaywrightModule { chromium: Chromium }

function loadPlaywright(): PlaywrightModule {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR,
    path.join(root, "node_modules"),
    path.join(process.env.TEMP ?? "", "opencode", "pw-core", "node_modules"),
    path.join(process.env.TEMP ?? "", "g4-pw-core", "node_modules"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const dir of candidates) {
    try { return runtimeRequire(runtimeRequire.resolve("playwright-core", { paths: [dir] })) as PlaywrightModule; } catch { /* next */ }
  }
  throw new Error("playwright-core 不可用：请设置 PLAYWRIGHT_CORE_DIR 指向含 playwright-core 的 node_modules（不加入项目依赖）");
}
function resolveChrome(): string | undefined {
  const candidates = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => { try { return fs.existsSync(candidate); } catch { return false; } });
}

/* ------------------------------ assertions ------------------------------ */

const passed: string[] = [];
const screenshots: string[] = [];
function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  passed.push(name);
  console.log(`ok ${name}`);
}
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function login(page: BrowserPage, username: string, password: string): Promise<void> {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  // The login form is hydrated client-side; give React a beat before submitting.
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.locator("#school-username").first().fill(username);
    await page.locator("#school-password").first().fill(password);
    await page.getByRole("button", { name: "登录" }).first().click();
    try {
      await page.waitForURL((url: { pathname: string }) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

/* ------------------------------ main ------------------------------ */

async function main(): Promise<void> {
  const listeners = findListeningPids(port);
  assert.ok(listeners.ok && listeners.pids.length === 0, `端口 ${port} 被占用或无法核实；不清理任何已有进程`);
  const artifacts = snapshotGeneratedArtifacts(root);
  const runId = `authux1-${process.pid}-${Date.now().toString(36)}`;
  const outDir = path.join(root, "logs", `auth-role-ux-${runId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const issues: string[] = [];
  const noteIssue = (label: string, detail: string) => issues.push(`${label}: ${detail}`);
  const results: Record<string, unknown> = { run_id: runId, base_url: base, isolated_database: true, real_model_requests: 0, checks: [], screenshots: [] };

  let db: IsolatedPostgres | null = null;
  let guard: ModelRequestGuard | null = null;
  let service: TrackedChild | null = null;
  let browser: Browser | null = null;
  let verifier: Client | null = null;
  let seeds: {
    admin: { username: string; password: string; account_id: string };
    teacher: { username: string; password: string; account_id: string; display_name: string };
    other: { username: string; password: string };
    unassigned: { username: string; password: string };
    classes: { a: string; b: string; c: string };
    children: { c1: string; c2: string };
  } | null = null;
  let failure: unknown = null;

  try {
    db = await startIsolatedPostgres({ runId, containerName: `cga-${runId}`, dbName: `cga_authux_${process.pid}_${Date.now().toString(36)}`, labelKey: "child-growth-agent.auth-role-ux", noteIssue });
    process.env.DATABASE_URL = db.url;
    process.env.AUTH_TRUSTED_ORIGINS = base;
    process.env.AUTH_SCHOOL_ID = "single-school";
    process.env.AUTH_COOKIE_SECURE = "false";
    delete process.env.PGDATABASE_URL;
    delete process.env.TEACHER_PASSCODE;

    const client = new Client({ connectionString: db.url });
    await client.connect();
    const initialization = fs.readFileSync(path.join(root, "scripts/initialize-demo-db.sql"), "utf8");
    const seedBoundary = initialization.indexOf("INSERT INTO children");
    assert.ok(seedBoundary > 0, "schema/seed boundary missing");
    await client.query(initialization.slice(0, seedBoundary));
    await client.query(fs.readFileSync(path.join(root, "scripts/upgrade-auth-v1.sql"), "utf8"));

    const classA = randomUUID(); const classB = randomUUID(); const classC = randomUUID();
    const classes = [[classA, "芽芽班", "small"], [classB, "苗苗班", "middle"], [classC, "星星班", "large"]] as const;
    for (const [id, name, stage] of classes) {
      await client.query("INSERT INTO classes(id,name,stage,school_year,is_active,is_demo) VALUES($1,$2,$3,'2026-2027',true,true)", [id, name, stage]);
    }
    const child1 = randomUUID(); const child2 = randomUUID(); const child3 = randomUUID();
    const childRows = [[child1, "童童", "2023-05-18"], [child2, "阿依", "2023-06-18"], [child3, "星辰", "2022-01-18"]] as const;
    for (const [id, name, birth] of childRows) {
      await client.query("INSERT INTO children(id,name,gender,birth_date,class_name,is_demo) VALUES($1,$2,'女',$3,'芽芽班',true)", [id, name, birth]);
    }
    await client.query("INSERT INTO child_class_enrollments(child_id,class_id,start_date) VALUES($1,$2,'2026-09-01'),($3,$2,'2026-09-01'),($4,$5,'2026-09-01')", [child1, classA, child2, child3, classC]);
    const observation1 = randomUUID(); const observation2 = randomUUID(); const observation3 = randomUUID();
    const draft1 = { domain: "社会", sub_domain: "同伴交往", objective_description: "幼儿照顾布娃娃。", highlights: ["邀请同伴"], support_suggestions: ["提供角色游戏材料"], highlight_quote: "一起照顾她吧" };
    const confirmed3 = { domain: "健康", sub_domain: "动作发展", objective_description: "幼儿连续跳过三条标线。", highlights: ["连续跳跃"], support_suggestions: ["提供不同间距的标线。"], highlight_quote: "连续跳过三条标线" };
    const activitySupport = {
      suggestions: [{
        title: "楼梯测量", purpose: "在真实情境中比较高低",
        steps: ["用积木搭出台阶", "给玩偶量身高并记录"], materials: ["积木", "软尺"],
        observe: "是否主动比较并说出理由", adaptation: "材料不够时改用椅子", evidence: ["连续跳过三条标线"],
      }, {
        title: "跳格子接力", purpose: "在游戏中练习连续跳跃",
        steps: ["用粉笔画出不同间距格子", "与同伴轮流跳完全程"], materials: ["粉笔"],
        observe: "落地是否稳定", adaptation: "缩小格子间距", evidence: ["连续跳过三条标线"],
      }],
      source_observation_ids: [observation3], ai_model: "fixture-model", generated_at: "2026-10-04T00:00:00.000Z",
    };
    const growthProfile = {
      summary: "童童喜欢用身体动作探索空间。", recent_change: "连续跳跃更稳定。", development_clues: ["连续跳跃"],
      next_support: "提供不同间距的标线。", next_focus: "落地方式。",
      source_observation_ids: [observation3], ai_model: "fixture-model", updated_at: "2026-10-04T00:00:00.000Z",
      activity_support: activitySupport,
    };
    await client.query(
      "INSERT INTO observations(id,child_id,class_id,observed_at,context,raw_text,status,ai_draft,ai_model,ai_organized_at,confirmed_content,confirmed_at,is_demo) VALUES" +
      "($1,$2,$3,'2026-09-28','娃娃家','AI-ORGANIZED-C1 幼儿给布娃娃盖好毯子并邀请同伴一起照顾。','ai_organized',$4,'fixture-model','2026-09-28T10:00:00+08:00',null,null,true)," +
      "($5,$6,$3,'2026-09-29','建构区','HIST-ONLY-C2 幼儿把长积木架在两个方积木上试了三次。','draft',null,null,null,null,null,true)," +
      "($7,$2,$3,'2026-09-30','户外游戏','SUPPORT-C1 幼儿连续跳过三条标线。','confirmed',null,null,null,$8,'2026-09-30T10:00:00+08:00',true)",
      [observation1, child1, classA, JSON.stringify(draft1), observation2, child2, observation3, JSON.stringify(confirmed3)]);
    await client.query("UPDATE children SET growth_profile=$2 WHERE id=$1", [child1, JSON.stringify(growthProfile)]);
    await client.end();
    verifier = new Client({ connectionString: db.url });
    await verifier.connect();

    const adminPassword = randomBytes(18).toString("base64url");
    const teacherPassword = randomBytes(18).toString("base64url");
    const teacherNewPassword = randomBytes(18).toString("base64url");
    const otherPassword = randomBytes(18).toString("base64url");
    const unassignedPassword = randomBytes(18).toString("base64url");
    const admin = await createInitialAdmin({ username: "ux-admin", displayName: "王园长", passwordHash: await hashPassword(adminPassword) }, "single-school");
    const teacher = await createTeacherWithAssignments({ username: "ux-teacher", displayName: "林小满", passwordHash: await hashPassword(teacherPassword), classIds: [classA, classB], assignedBy: admin.account_id });
    const other = await createTeacherWithAssignments({ username: "ux-other", displayName: "陈老师", passwordHash: await hashPassword(otherPassword), classIds: [classC], assignedBy: admin.account_id });
    const unassigned = await createTeacherWithAssignments({ username: "ux-unassigned", displayName: "待分班老师", passwordHash: await hashPassword(unassignedPassword), classIds: [], assignedBy: admin.account_id });
    seeds = {
      admin: { username: "ux-admin", password: adminPassword, account_id: admin.account_id },
      teacher: { username: "ux-teacher", password: teacherPassword, account_id: teacher.account_id, display_name: "林小满" },
      other: { username: "ux-other", password: otherPassword },
      unassigned: { username: "ux-unassigned", password: unassignedPassword },
      classes: { a: classA, b: classB, c: classC },
      children: { c1: child1, c2: child2 },
    };

    guard = await startModelRequestGuard();
    const environment = modelGuardEnv(guard);
    environment.DATABASE_URL = db.url;
    environment.AUTH_TRUSTED_ORIGINS = base;
    environment.AUTH_SCHOOL_ID = "single-school";
    environment.AUTH_COOKIE_SECURE = "false";
    delete environment.PGDATABASE_URL;
    delete environment.TEACHER_PASSCODE;
    const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    service = trackChildProcess(child);
    child.stdout?.on("data", (value: Buffer) => process.stdout.write(value));
    child.stderr?.on("data", (value: Buffer) => process.stderr.write(value));
    await waitForVerifiedService({ base, port, child: service, timeoutMs: 120_000 });

    const playwright = loadPlaywright();
    const launchOptions: Record<string, unknown> = { headless: true };
    const chromePath = resolveChrome();
    if (chromePath) launchOptions.executablePath = chromePath;
    browser = await playwright.chromium.launch(launchOptions);

    const settle = async (page: BrowserPage) => {
      // Wait for dialog/transition animations so screenshots never capture mid-transition frames.
      await page.evaluate(() => Promise.race([
        Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]).then(() => undefined));
      await page.waitForTimeout(150);
    };
    const shoot = async (page: BrowserPage, name: string) => {
      await settle(page);
      const file = path.join(outDir, name);
      await page.screenshot({ path: file, fullPage: false });
      screenshots.push(name);
    };
    const fillChildForm = async (page: BrowserPage, name: string, childClass: string) => {
      await page.locator("#child-name").first().fill(name);
      await page.locator("#gender-女").first().click();
      await page.locator("#birth-date").first().fill("2023-03-01");
      await page.getByRole("combobox", { name: "选择学段" }).first().click();
      await page.getByRole("option", { name: "小班" }).first().click();
      await page.getByRole("combobox", { name: "选择班级" }).first().click();
      await page.getByRole("option", { name: childClass }).first().click();
      await page.getByRole("button", { name: "下一步" }).first().click();
      await page.getByRole("button", { name: "下一步" }).first().click();
    };
    const noOverflow = async (page: BrowserPage, name: string) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${name} 无横向溢出`, overflow <= 1, `scrollWidth-innerWidth=${overflow}`);
    };

    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const teacherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await adminContext.newPage();
    const teacherPage = await teacherContext.newPage();

    await login(adminPage, seeds.admin.username, seeds.admin.password);
    await login(teacherPage, seeds.teacher.username, seeds.teacher.password);
    check("管理员与多班教师可登录", true);

    /* ---- password reset through the real management UI ---- */
    await adminPage.goto(`${base}/admin/teachers`, { waitUntil: "networkidle" });
    check("教师管理页显示目标教师与任教班级", (await adminPage.content()).includes(seeds.teacher.display_name));
    await shoot(adminPage, "01-admin-teacher-management-1440.png");
    await adminPage.getByRole("button", { name: `重置教师${seeds.teacher.display_name}的密码` }).first().click();
    const dialog = adminPage.getByText(/重置「林小满」的登录密码？/).first();
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    const dialogContent = await adminPage.content();
    check("重置对话框明确对象并提示撤销全部会话", dialogContent.includes(seeds.teacher.username) && dialogContent.includes("撤销"));
    await shoot(adminPage, "02-admin-reset-dialog-1440.png");
    await adminPage.locator("#teacher-reset-password").first().fill(teacherNewPassword);
    await adminPage.getByRole("button", { name: "确认重置密码" }).first().click();
    await waitFor(async () => (await adminPage.content()).includes("已重置"), 30_000, "重置成功提示");
    const afterReset = await adminPage.content();
    check("重置成功提示包含撤销会话数量且不回显密码", /已重置「林小满」的登录密码/.test(afterReset) && /撤销 \d+ 个登录会话/.test(afterReset) && !afterReset.includes(teacherNewPassword));
    const providerStorage = await adminPage.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
    check("浏览器存储不保存重置密码", !providerStorage.includes(teacherNewPassword));
    check("管理员自身会话未被重置影响", afterReset.includes("教师与任教班级"));
    await shoot(adminPage, "03-admin-reset-done-1440.png");

    /* ---- revoked session, old password, new password ---- */
    const revokedStatus = await teacherPage.request.get(`${base}/api/auth/status`);
    const revokedBody = await revokedStatus.json() as { state: { kind: string; reason?: string } };
    check("旧教师会话在重置后失效", revokedBody.state.kind === "invalid_session", JSON.stringify(revokedBody.state));
    const oldPasswordContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const oldPasswordPage = await oldPasswordContext.newPage();
    await oldPasswordPage.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await oldPasswordPage.locator("#school-username").first().fill(seeds.teacher.username);
    await oldPasswordPage.locator("#school-password").first().fill(seeds.teacher.password);
    await oldPasswordPage.getByRole("button", { name: "登录" }).first().click();
    await waitFor(async () => ((await oldPasswordPage.locator("#login-error").first().textContent()) ?? "").trim().length > 0, 20_000, "旧密码登录失败提示");
    check("旧密码不能登录", true);
    await oldPasswordContext.close();
    const newPasswordContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const newPasswordPage = await newPasswordContext.newPage();
    await login(newPasswordPage, seeds.teacher.username, teacherNewPassword);
    check("新密码可以登录", true);
    await newPasswordContext.close();
    await login(teacherPage, seeds.teacher.username, teacherNewPassword);

    /* ---- administrator: no teaching write entries ---- */
    await adminPage.goto(`${base}/observations`, { waitUntil: "networkidle" });
    const adminObservations = await adminPage.content();
    check("管理员观察页无开始记录 CTA", !adminObservations.includes("开始记录") && adminObservations.includes("管理员查看全园观察记录"));
    await shoot(adminPage, "04-admin-observations-1440.png");
    await adminPage.goto(`${base}/classes/${classA}`, { waitUntil: "networkidle" });
    const adminClass = await adminPage.content();
    check("管理员班级页无记录观察入口且有班级管理", !adminClass.includes("记录一次观察") && adminClass.includes("编辑班级"));
    await shoot(adminPage, "05-admin-class-detail-1440.png");
    await adminPage.goto(`${base}/children/${child1}`, { waitUntil: "networkidle" });
    const adminChild = await adminPage.content();
    check("管理员档案页可转班、无记录观察入口", adminChild.includes("转班") && !adminChild.includes("记录一次观察") && !adminChild.includes("再记一条"));
    check("管理员可读已有活动支持正文", ["楼梯测量", "跳格子接力", "用积木搭出台阶", "软尺", "粉笔", "材料不够时改用椅子"].every((text) => adminChild.includes(text)));
    check("管理员活动支持无生成/重生成/重试控件", (await adminPage.getByRole("button", { name: /生成活动支持|重新生成|再试一次/ }).count()) === 0);
    await shoot(adminPage, "06-admin-child-detail-1440.png");
    await adminPage.goto(`${base}/reports?child=${child1}`, { waitUntil: "networkidle" });
    const adminReports = await adminPage.content();
    check("管理员成长回顾无教学待办入口", !adminReports.includes("先确认一条观察") && !adminReports.includes("继续整理观察") && !adminReports.includes("去生成活动支持") && adminReports.includes("查看成长档案"));
    await shoot(adminPage, "07-admin-reports-1440.png");

    /* ---- teacher: allowed entries only ---- */
    await teacherPage.goto(`${base}/classes`, { waitUntil: "networkidle" });
    const teacherClasses = await teacherPage.content();
    check("多班教师看到全部任教班级且无建班入口", teacherClasses.includes("芽芽班") && teacherClasses.includes("苗苗班") && !teacherClasses.includes("新建班级"));
    await shoot(teacherPage, "08-teacher-classes-1440.png");
    await teacherPage.goto(`${base}/classes/${classA}`, { waitUntil: "networkidle" });
    const teacherClass = await teacherPage.content();
    check("教师班级页有记录观察且无编辑班级", teacherClass.includes("记录一次观察") && !teacherClass.includes("编辑班级"));
    await teacherPage.goto(`${base}/children/${child1}`, { waitUntil: "networkidle" });
    const teacherChild = await teacherPage.content();
    check("教师档案页无转班入口", !teacherChild.includes("转班") && teacherChild.includes("记录一次观察"));
    check("教师仍可重新生成活动支持", (await teacherPage.getByRole("button", { name: "重新生成", exact: true }).count()) === 1);
    await teacherPage.goto(`${base}/reports?child=${child1}`, { waitUntil: "networkidle" });
    const teacherReports = await teacherPage.content();
    check("教师成长回顾展示已确认观察且无教学写入口", teacherReports.includes("成长回顾") && !teacherReports.includes("先确认一条观察"));
    await shoot(teacherPage, "09-teacher-reports-1440.png");
    await teacherPage.goto(`${base}/reports?child=${child2}`, { waitUntil: "networkidle" });
    const teacherPending = await teacherPage.content();
    check("教师成长回顾待办指向可整理记录", teacherPending.includes("继续整理观察") && teacherPending.includes(`/observations/${observation2}/review`));
    await teacherPage.goto(`${base}/admin/teachers`, { waitUntil: "networkidle" });
    check("教师不能进入管理教师操作", (await teacherPage.content()).includes("仅管理员可管理教师"));

    /* ---- administrator creation lands on the profile; teacher keeps the observation path ---- */
    const adminChildName = `管理员建的${runId.slice(-4)}`;
    await adminPage.goto(`${base}/children/new`, { waitUntil: "networkidle" });
    await fillChildForm(adminPage, adminChildName, "芽芽班");
    await adminPage.getByRole("button", { name: "建立成长档案" }).first().click();
    await adminPage.waitForURL((url) => /^\/children\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 30_000 });
    await waitFor(async () => (await adminPage.content()).includes(adminChildName), 20_000, "管理员建档后档案页显示幼儿");
    check("管理员建档后进入成长档案而非观察页", !adminPage.url().includes("/observations/"));
    const saved = await verifier.query<{ id: string }>("SELECT id FROM children WHERE name=$1", [adminChildName]);
    check("管理员建档数据真实落库", saved.rowCount === 1);
    await shoot(adminPage, "15-admin-created-child-profile-1440.png");

    const teacherChildName = `教师建的${runId.slice(-4)}`;
    await teacherPage.goto(`${base}/children/new`, { waitUntil: "networkidle" });
    await fillChildForm(teacherPage, teacherChildName, "芽芽班");
    await teacherPage.getByRole("button", { name: "建立成长档案并记录观察" }).first().click();
    await teacherPage.waitForURL((url) => url.pathname === "/observations/new", { timeout: 30_000 });
    check("教师建档后保持进入观察录入页", teacherPage.url().includes("child_id="));

    /* ---- unassigned teacher ---- */
    const unassignedContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const unassignedPage = await unassignedContext.newPage();
    await login(unassignedPage, seeds.unassigned.username, seeds.unassigned.password);
    await unassignedPage.goto(`${base}/children/new`, { waitUntil: "networkidle" });
    const unassignedNew = await unassignedPage.content();
    check("未分配教师建档页引导联系管理员且无建班捷径", unassignedNew.includes("尚未分配任教班级") && unassignedNew.includes("请联系管理员") && !unassignedNew.includes("去创建班级"));
    await shoot(unassignedPage, "10-unassigned-children-new-1440.png");
    await unassignedPage.goto(`${base}/classes`, { waitUntil: "networkidle" });
    const unassignedClasses = await unassignedPage.content();
    check("未分配教师班级页是权限提示而非空态", unassignedClasses.includes("当前账号没有访问权限") && !unassignedClasses.includes("还没有班级"));
    await unassignedPage.goto(`${base}/observations`, { waitUntil: "networkidle" });
    const unassignedObservations = await unassignedPage.content();
    check("未分配教师观察页是权限提示而非空态", unassignedObservations.includes("当前账号没有访问权限") && !unassignedObservations.includes("还没有观察记录"));
    await unassignedPage.goto(`${base}/reports`, { waitUntil: "networkidle" });
    const unassignedReports = await unassignedPage.content();
    check("未分配教师成长回顾是权限提示而非空态", unassignedReports.includes("当前账号没有访问权限") && !unassignedReports.includes("还没有成长档案"));
    await unassignedContext.close();

    /* ---- transfer child2 from A to C through the real session ---- */
    const transfer = await adminPage.evaluate(async ({ classId, childId }: { classId: string; childId: string }) => {
      const status = await (await fetch("/api/auth/status", { cache: "no-store" })).json() as { csrf?: { header_name: string; token: string } };
      if (!status.csrf) return { status: 0, body: null };
      const response = await fetch(`/api/classes/${classId}/children`, { method: "POST",
        headers: { "content-type": "application/json", [status.csrf.header_name]: status.csrf.token },
        body: JSON.stringify({ child_id: childId }) });
      return { status: response.status, body: await response.json().catch(() => null) as unknown };
    }, { classId: classC, childId: child2 });
    check("管理员真实会话完成转班", transfer.status === 200, `status=${transfer.status} body=${JSON.stringify(transfer.body)}`);

    await teacherPage.goto(`${base}/observations`, { waitUntil: "networkidle" });
    const teacherHistory = await teacherPage.content();
    check("原班教师仍可读到历史观察", teacherHistory.includes("HIST-ONLY-C2"));
    const historyProfile = await teacherPage.evaluate(async ({ childId }: { childId: string }) => {
      const response = await fetch(`/api/children/${childId}/evidence-book`, { cache: "no-store" });
      return response.status;
    }, { childId: child2 });
    check("转走幼儿不向原班教师开放整份档案", historyProfile === 403, `status=${historyProfile}`);
    await teacherPage.goto(`${base}/children/${child2}`, { waitUntil: "networkidle" });
    const teacherOutOfScope = await teacherPage.content();
    check("转走幼儿档案页是权限提示而非空态", teacherOutOfScope.includes("当前账号没有访问权限") && !teacherOutOfScope.includes("还没有观察记录"));

    const otherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const otherPage = await otherContext.newPage();
    await login(otherPage, seeds.other.username, seeds.other.password);
    await otherPage.goto(`${base}/children/${child2}`, { waitUntil: "networkidle" });
    const otherChild = await otherPage.content();
    check("转入班教师可按当前归属记录观察", otherChild.includes("记录一次观察") && otherChild.includes("HIST-ONLY-C2"));
    await otherPage.goto(`${base}/reports?child=${child2}`, { waitUntil: "networkidle" });
    check("转入班教师获得可整理待办入口", (await otherPage.content()).includes("继续整理观察"));
    await otherContext.close();

    /* ---- responsive checks ---- */
    await adminPage.setViewportSize({ width: 768, height: 1024 });
    await adminPage.goto(`${base}/admin/teachers`, { waitUntil: "networkidle" });
    await adminPage.waitForTimeout(500);
    await noOverflow(adminPage, "教师管理 768×1024");
    await shoot(adminPage, "11-admin-teacher-management-768.png");
    await adminPage.goto(`${base}/children/${child1}`, { waitUntil: "networkidle" });
    await adminPage.waitForTimeout(500);
    await noOverflow(adminPage, "管理员档案（活动支持只读）768×1024");
    await shoot(adminPage, "16-admin-child-detail-768.png");
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await adminPage.goto(`${base}/admin/teachers`, { waitUntil: "networkidle" });
    await adminPage.waitForTimeout(500);
    await noOverflow(adminPage, "教师管理 390×844");
    await shoot(adminPage, "12-admin-teacher-management-390.png");
    await adminPage.goto(`${base}/children/${child1}`, { waitUntil: "networkidle" });
    await adminPage.waitForTimeout(500);
    await noOverflow(adminPage, "管理员档案（活动支持只读）390×844");
    await shoot(adminPage, "17-admin-child-detail-390.png");
    await teacherPage.setViewportSize({ width: 390, height: 844 });
    await teacherPage.goto(`${base}/children/new`, { waitUntil: "networkidle" });
    await teacherPage.waitForTimeout(800);
    await noOverflow(teacherPage, "建立档案 390×844");
    await shoot(teacherPage, "13-teacher-children-new-390.png");
    await teacherPage.goto(`${base}/classes/${classA}`, { waitUntil: "networkidle" });
    await teacherPage.waitForTimeout(500);
    await noOverflow(teacherPage, "班级详情 390×844");
    await shoot(teacherPage, "14-teacher-class-detail-390.png");

    /* ---- scope change drops the old class projection; a late response must not restore it ---- */
    let holdFirstClassRequest = true;
    await teacherPage.route("**/api/classes", async (route) => {
      if (!holdFirstClassRequest) return route.continue();
      holdFirstClassRequest = false;
      const response = await route.fetch(); // real server response with the old scope
      const body = await response.text();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.fulfill({ status: response.status(), contentType: "application/json", body });
    });
    await teacherPage.goto(`${base}/children/new`, { waitUntil: "domcontentloaded" });
    await waitFor(async () => (await teacherPage.content()).includes("班级加载中"), 10_000, "目录请求进行中");
    const removal = await adminPage.evaluate(async ({ accountId, classIds }: { accountId: string; classIds: string[] }) => {
      const status = await (await fetch("/api/auth/status", { cache: "no-store" })).json() as { csrf?: { header_name: string; token: string } };
      if (!status.csrf) return { results: [0] };
      const results: number[] = [];
      for (const classId of classIds) {
        const response = await fetch(`/api/admin/teachers/${accountId}/assignments/${classId}`, { method: "DELETE",
          headers: { "content-type": "application/json", [status.csrf.header_name]: status.csrf.token },
          body: JSON.stringify({ account_id: accountId, class_id: classId }) });
        results.push(response.status);
      }
      return { results };
    }, { accountId: seeds.teacher.account_id, classIds: [classA, classB] });
    check("管理员撤销任教成功", removal.results.every((status) => status === 200), JSON.stringify(removal.results));
    await teacherPage.evaluate(() => window.dispatchEvent(new Event("cga:auth-changed")));
    await waitFor(async () => (await teacherPage.content()).includes("尚未分配任教班级"), 20_000, "范围变化后显示未分配");
    await teacherPage.waitForTimeout(3000); // allow the held old-scope response to arrive
    const afterLateResponse = await teacherPage.content();
    check("迟到目录响应不能恢复过时班级投影", !afterLateResponse.includes("芽芽班") && !afterLateResponse.includes("苗苗班"));
    await teacherPage.unroute("**/api/classes");

    results.checks = passed;
    results.screenshots = screenshots;
    check("真实模型请求为 0", guard.hits === 0, `hits=${guard.hits}`);
  } catch (error: unknown) {
    failure = error;
  } finally {
    try { if (browser) await browser.close(); } catch { noteIssue("browser", "close failed"); }
    await runCleanupSteps([
      { label: "auth-ux-server", run: async () => service ? stopTrackedChildTree(service) : undefined },
      { label: "auth-ux-verifier", run: async () => { if (verifier) await verifier.end(); } },
      { label: "auth-ux-pool", run: async () => { await globalThis.__pgPool?.end(); } },
      { label: "auth-ux-guard", run: async () => { if (guard) await guard.close(); } },
      { label: "auth-ux-db", run: () => db?.teardown() },
      { label: "auth-ux-generated-types", run: () => { const restored = restoreGeneratedArtifacts(artifacts, root); return { ok: restored.issues.length === 0, detail: restored.issues.join("; ") }; } },
    ], noteIssue);
    results.real_model_requests = guard?.hits ?? 0;
    results.git_sha = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(); } catch { return null; } })();
    results.checks = passed;
    results.screenshots = screenshots;
    results.passed = passed;
    results.failed = failure instanceof Error ? failure.message : failure ? String(failure) : null;
    results.playwright_core_env = Boolean(process.env.PLAYWRIGHT_CORE_DIR) ? "env" : "candidate";
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
    assertCleanupComplete(issues);
    if (failure) console.error(failure instanceof Error ? failure.message : String(failure));
  }
  if (failure) process.exitCode = 1;
  else console.log(JSON.stringify({ passed: passed.length, screenshots: screenshots.length, out_dir: outDir, real_model_requests: guard?.hits ?? 0 }));
}

void main().catch((error: unknown) => {
  console.error((error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "<redacted>"));
  process.exitCode = 1;
});
