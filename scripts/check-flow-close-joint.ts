import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import type { QueryResultRow } from "pg";

import {
  assertCleanupComplete,
  findListeningPids,
  modelGuardEnv,
  restoreGeneratedArtifacts,
  runCleanupSteps,
  snapshotGeneratedArtifacts,
  startIsolatedPostgres,
  startModelRequestGuard,
  stopTrackedChildTree,
  trackChildProcess,
  waitForVerifiedService,
} from "./harness-safety";
import type { IsolatedPostgres, ModelRequestGuard, TrackedChild } from "./harness-safety";

/**
 * CLOSE-QA1 联合链路（最小专属 runner）。
 *
 * 单条贯通路径：管理员页面创建教师并分配班级 → 管理员页面建档进入成长档案
 * → 教师真实登录 → 从指南条目进入记录 → 浏览器录入原始观察 → 整理步骤使用进程内替身
 * → 教师确认并提交指南决定（同一事务）→ 个人证据册展开引用 → 班级同期聚合 → 下钻保持幼儿/条目/期间。
 *
 * 环境：正式 Next 路由 + 真实园所账号/会话 CSRF + 本轮隔离 PostgreSQL（harness-safety）。
 * 模型：测试进程内替身（直接写入 ai_draft）；provider 凭证留空 + 守门服务器，真实请求必须为 0。
 * 端口：FLOW_CLOSE_PORT（默认 5031）；占用即退出，不杀任何已有进程。
 * playwright-core：FLOW_CLOSE_PLAYWRIGHT_CORE；Chrome：FLOW_CLOSE_CHROME。
 */

const ROOT = process.cwd();
const PORT = Number(process.env.FLOW_CLOSE_PORT ?? 5031);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_ID = `closeqa1-${process.pid}-${Date.now().toString(36)}`;
const EVIDENCE_DIR = process.env.FLOW_CLOSE_EVIDENCE_DIR ?? path.join(os.tmpdir(), `flow-close-joint-${RUN_ID}`);
const SHOTS = path.join(EVIDENCE_DIR, "shots");

const ADMIN_PASSWORD = randomBytes(18).toString("base64url");
const TEACHER_PASSWORD = randomBytes(18).toString("base64url");
const TEACHER_NAME = "联调教师";
const TEACHER_USERNAME = `jt${RUN_ID.replace(/[^a-z0-9]/gi, "").slice(-8)}`.toLowerCase();
const CLASS_NAME = "综合验收班";
const MAIN_ITEM = "item.moe.health.movement.1.3-4.3";
const RAW_MAIN =
  "户外游戏时，果果双脚连续向前跳过了三条地面标线，途中没有停下，还回头对同伴说：「你看我跳过去了。」";
const DRAFT_MAIN = {
  domain: "健康",
  sub_domain: "身体控制与协调",
  objective_description: "这件观察记录中出现双脚连续向前跳的动作过程。",
  highlights: ["连续跳过三条地面标线，途中没有停下。"],
  support_suggestions: ["提供不同间距的地面标线，让幼儿选择自己的尝试方式。"],
  highlight_quote: "双脚连续向前跳过了三条地面标线",
};

interface Results {
  name: string;
  ok: boolean;
  detail: string;
  evidence: string;
}

const results: Results[] = [];
const issues: string[] = [];
let screenshotCount = 0;

function check(name: string, ok: boolean, detail: string, evidence = "real_http+real_db+browser"): void {
  results.push({ name, ok: Boolean(ok), detail, evidence });
}

function resolvePlaywrightCore(): string {
  if (process.env.FLOW_CLOSE_PLAYWRIGHT_CORE) return process.env.FLOW_CLOSE_PLAYWRIGHT_CORE;
  const scratch = path.join(os.tmpdir(), "opencode", "g4-pw-core", "node_modules", "playwright-core");
  if (fs.existsSync(path.join(scratch, "package.json"))) return scratch;
  throw new Error("未找到 playwright-core；请设置 FLOW_CLOSE_PLAYWRIGHT_CORE 指向包目录");
}

function resolveChrome(): string {
  const candidates = [
    process.env.FLOW_CLOSE_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("未找到 Chrome/Edge；请设置 FLOW_CLOSE_CHROME");
}

interface Locator {
  waitFor(options?: Record<string, unknown>): Promise<void>;
  click(options?: Record<string, unknown>): Promise<void>;
  fill(value: string): Promise<void>;
  count(): Promise<number>;
  first(): Locator;
  filter(options: Record<string, unknown>): Locator;
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
  locator(selector: string): Locator;
}

interface Page {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  locator(selector: string): Locator;
  getByRole(role: string, options?: Record<string, unknown>): Locator;
  getByText(text: string | RegExp, options?: Record<string, unknown>): Locator;
  waitForURL(url: string | RegExp | ((url: URL) => boolean), options?: Record<string, unknown>): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction<T>(fn: (arg: T) => boolean, arg?: T, options?: Record<string, unknown>): Promise<void>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  content(): Promise<string>;
  screenshot(options: Record<string, unknown>): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
}

interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

interface Browser {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>;
  close(): Promise<void>;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).then(() => undefined),
  );
  await page.waitForTimeout(150);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
  screenshotCount += 1;
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.locator("#school-username").first().fill(username);
    await page.locator("#school-password").first().fill(password);
    await page.getByRole("button", { name: "登录" }).first().click();
    try {
      await page.waitForURL((url: URL) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function fillChildForm(page: Page, name: string, childClass: string): Promise<void> {
  await page.locator("#child-name").first().fill(name);
  await page.locator("#gender-女").first().click();
  await page.locator("#birth-date").first().fill("2023-03-01");
  await page.getByRole("combobox", { name: "选择学段" }).first().click();
  await page.getByRole("option", { name: "小班" }).first().click();
  await page.getByRole("combobox", { name: "选择班级" }).first().click();
  await page.getByRole("option", { name: childClass }).first().click();
  await page.getByRole("button", { name: "下一步" }).first().click();
  await page.getByRole("button", { name: "下一步" }).first().click();
}

async function waitForText(page: Page, text: string, timeout = 30_000): Promise<void> {
  await page.getByText(text).first().waitFor({ timeout });
}

async function main(): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  const listeners = findListeningPids(PORT);
  assert.ok(listeners.ok && listeners.pids.length === 0, `端口 ${PORT} 被占用或不可核实；不启动、不杀进程`);
  const artifacts = snapshotGeneratedArtifacts(ROOT);

  let database: IsolatedPostgres | null = null;
  let guard: ModelRequestGuard | null = null;
  let service: TrackedChild | null = null;
  let client: Client | null = null;
  let browser: Browser | null = null;

  try {
    database = await startIsolatedPostgres({
      runId: RUN_ID,
      containerName: `cga-${RUN_ID}`,
      dbName: `cga_closeqa1_${process.pid}_${Date.now().toString(36)}`,
      labelKey: "child-growth-agent.flow-close-joint",
      noteIssue: (label, detail) => issues.push(`${label}: ${detail}`),
    });
    process.env.DATABASE_URL = database.url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = BASE;
    process.env.AUTH_SCHOOL_ID = "close-qa1-school";
    process.env.AUTH_COOKIE_SECURE = "false";
    delete process.env.TEACHER_PASSCODE;

    client = new Client({ connectionString: database.url });
    await client.connect();
    const initialization = fs.readFileSync(path.join(ROOT, "scripts/initialize-demo-db.sql"), "utf8");
    const seedBoundary = initialization.indexOf("INSERT INTO children");
    assert.ok(seedBoundary > 0, "schema/seed boundary missing");
    await client.query(initialization.slice(0, seedBoundary));
    await client.query(fs.readFileSync(path.join(ROOT, "scripts/upgrade-auth-v1.sql"), "utf8"));

    // 测试前置 fixture：班级由 fixture 预置；教师与幼儿必须由管理员页面创建。
    const classId = randomUUID();
    await client.query(
      "INSERT INTO classes(id,name,stage,school_year,is_active,is_demo) VALUES($1,$2,'small','2026-2027',true,true)",
      [classId, CLASS_NAME],
    );

    const { hashPassword } = await import("../src/lib/accounts/password");
    const repository = await import("../src/lib/accounts/repository");
    const admin = await repository.createInitialAdmin(
      { username: "close-admin", displayName: "联调园长", passwordHash: await hashPassword(ADMIN_PASSWORD) },
      "close-qa1-school",
    );
    check("首位管理员由部署者脚本语义的 fixture 建立（非页面）", Boolean(admin.account_id), "fixture bootstrap", "fixture");

    guard = await startModelRequestGuard();
    const env: NodeJS.ProcessEnv = modelGuardEnv(guard, process.env);
    env.DATABASE_URL = database.url;
    delete env.PGDATABASE_URL;
    env.AUTH_TRUSTED_ORIGINS = BASE;
    env.AUTH_SCHOOL_ID = "close-qa1-school";
    env.AUTH_COOKIE_SECURE = "false";
    env.STEPFUN_API_KEY = "";
    env.COZE_API_KEY = "";
    const childProcess = spawn(
      process.execPath,
      [path.join(ROOT, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    service = trackChildProcess(childProcess);
    const serverLog = fs.createWriteStream(path.join(EVIDENCE_DIR, "dev-server.log"));
    childProcess.stdout?.on("data", (value: Buffer) => serverLog.write(value));
    childProcess.stderr?.on("data", (value: Buffer) => serverLog.write(value));
    await waitForVerifiedService({ base: BASE, port: PORT, child: service, timeoutMs: 180_000 });

    const playwright = createRequire(import.meta.url)(resolvePlaywrightCore()) as {
      chromium: { launch: (options: { executablePath: string; headless: boolean }) => Promise<Browser> };
    };
    browser = await playwright.chromium.launch({ executablePath: resolveChrome(), headless: true });

    const sql = async <T extends QueryResultRow = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<{ rows: T[]; rowCount: number | null }> => client!.query<T>(text, params);

    /* ---------- 1. 管理员页面创建教师并分配班级 ---------- */
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await adminContext.newPage();
    await login(adminPage, "close-admin", ADMIN_PASSWORD);
    check("管理员真实登录（正式登录页与会话）", true, "login form", "real_http+browser+real_db");

    await adminPage.goto(`${BASE}/admin/teachers`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await adminPage.getByRole("button", { name: "添加教师" }).first().click();
    await adminPage.locator("#teacher-display-name").first().fill(TEACHER_NAME);
    await adminPage.locator("#teacher-username").first().fill(TEACHER_USERNAME);
    await adminPage.locator("#teacher-password").first().fill(TEACHER_PASSWORD);
    await adminPage.getByRole("button", { name: "创建教师账号" }).first().click();
    await waitForText(adminPage, "已创建");
    const teacherRow = await sql<{ id: string; role: string; status: string }>(
      "SELECT id, role, status FROM app_accounts WHERE username=$1",
      [TEACHER_USERNAME],
    );
    check(
      "管理员页面创建教师真实落库（teacher/active）",
      teacherRow.rowCount === 1 && teacherRow.rows[0].role === "teacher" && teacherRow.rows[0].status === "active",
      JSON.stringify(teacherRow.rows[0] ?? null),
    );
    const teacherAccountId = teacherRow.rows[0].id;

    await adminPage.locator(`#assign-${teacherAccountId}`).first().click();
    await adminPage.getByRole("option", { name: new RegExp(CLASS_NAME) }).first().click();
    await adminPage.getByRole("button", { name: "确认添加" }).first().click();
    await waitForText(adminPage, "已为");
    const assignment = await sql<{ class_id: string }>(
      "SELECT class_id FROM teacher_class_assignments WHERE account_id=$1 AND class_id=$2 AND removed_at IS NULL",
      [teacherAccountId, classId],
    );
    check("管理员页面分配任教班级真实落库", assignment.rowCount === 1, JSON.stringify(assignment.rows[0] ?? null));
    await shoot(adminPage, "01-admin-teacher-created-assigned-1440.png");

    /* ---------- 2. 管理员页面建档，进入成长档案 ---------- */
    const childName = `综合验收幼儿${RUN_ID.slice(-4)}`;
    await adminPage.goto(`${BASE}/children/new`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await fillChildForm(adminPage, childName, CLASS_NAME);
    await adminPage.getByRole("button", { name: "建立成长档案" }).first().click();
    await adminPage.waitForURL(/\/children\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    const childId = adminPage.url().match(/\/children\/([0-9a-f-]{36})$/)?.[1] ?? "";
    await waitForText(adminPage, childName, 30_000);
    const createdChildRow = await sql<{ id: string; class_id: string; start_date: string }>(
      `SELECT c.id, e.class_id, e.start_date::text AS start_date FROM children c
       JOIN child_class_enrollments e ON e.child_id = c.id
       WHERE c.id=$1 AND e.end_date IS NULL`,
      [childId],
    );
    check(
      "管理员建档进入成长档案且幼儿与班级归属真实落库",
      Boolean(childId) && createdChildRow.rowCount === 1 && createdChildRow.rows[0].class_id === classId,
      `child=${childId} class=${createdChildRow.rows[0]?.class_id ?? "none"}`,
    );
    check(
      "管理员档案页无教学写控件（无记录观察、无生成活动支持）",
      (await adminPage.getByRole("button", { name: /记录一次观察|再记一条|生成活动支持|重新生成|再试一次/ }).count()) === 0,
      "admin read-only",
    );
    await shoot(adminPage, "02-admin-created-child-profile-1440.png");

    /* ---------- 3. 教师登录，从指南条目进入记录 ---------- */
    const teacherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const teacherPage = await teacherContext.newPage();
    await login(teacherPage, TEACHER_USERNAME, TEACHER_PASSWORD);
    check("新教师账号真实登录成功", true, "login form", "real_http+browser+real_db");

    const evidenceUrl = `${BASE}/children/${childId}/evidence?domain=health&age_band=3-4`;
    await teacherPage.goto(evidenceUrl, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await teacherPage.locator("[data-testid=child-evidence-book]").waitFor({ timeout: 120_000 });
    const itemRow = teacherPage.locator(`[data-item-id="${MAIN_ITEM}"]`);
    await itemRow.waitFor({ timeout: 90_000 });
    await itemRow.locator('[data-testid="item-disclosure"]').click();
    await itemRow.locator("[data-testid=record-observation]").waitFor({ timeout: 30_000 });
    await shoot(teacherPage, "03-teacher-guide-item-entry-1440.png");
    await itemRow.locator("[data-testid=record-observation]").click();
    await teacherPage.waitForURL(/\/observations\/new\?/, { timeout: 90_000 });
    const newUrl = new URL(teacherPage.url());
    check(
      "从指南条目进入记录携带 child_id/item_id/return_to",
      newUrl.searchParams.get("child_id") === childId &&
        newUrl.searchParams.get("item_id") === MAIN_ITEM &&
        Boolean(newUrl.searchParams.get("return_to")),
      newUrl.search,
    );

    /* ---------- 4. 浏览器录入原始观察 ---------- */
    await teacherPage.locator("[data-testid=focus-note]").waitFor({ timeout: 90_000 });
    await teacherPage.locator("#raw").fill(RAW_MAIN);
    await teacherPage.waitForFunction(
      () => !document.body.innerText.includes("正在按分班历史核对"),
      undefined,
      { timeout: 90_000 },
    );
    await teacherPage.locator("[data-testid=save-observation]").click();
    await teacherPage.waitForURL(/\/observations\/[^/]+\/review/, { timeout: 90_000 });
    const observationId = teacherPage.url().match(/\/observations\/([^/]+)\/review/)?.[1] ?? "";
    const savedRaw = await sql<{ raw_text: string; status: string }>(
      "SELECT raw_text, status FROM observations WHERE id=$1",
      [observationId],
    );
    check(
      "浏览器录入原始观察真实落库且 raw_text 原文保存",
      savedRaw.rowCount === 1 && savedRaw.rows[0].raw_text === RAW_MAIN,
      `obs=${observationId}`,
    );

    /* ---------- 5. 整理步骤：测试进程内替身 ---------- */
    await sql(
      `UPDATE observations SET status='ai_organized', ai_draft=$2::jsonb, ai_model='offline-substitute',
         ai_organized_at=now(), updated_at=now() WHERE id=$1`,
      [observationId, JSON.stringify(DRAFT_MAIN)],
    );
    check("整理步骤使用测试进程内替身（非真实模型）", true, "ai_draft injected", "in_process_substitute");

    /* ---------- 6. 教师确认并提交指南决定（同一事务） ---------- */
    await teacherPage.goto(teacherPage.url(), { waitUntil: "domcontentloaded" });
    await teacherPage.locator("[data-testid=guide-association-section]").waitFor({ timeout: 120_000 });
    await teacherPage.locator('[data-testid="guide-manual-add"]').click();
    const editor = teacherPage.locator('[data-testid="decision-editor"]');
    await editor.waitFor({ timeout: 30_000 });
    if ((await teacherPage.locator('[data-testid="guide-item-search"]').count()) > 0) {
      await teacherPage.locator('[data-testid="guide-item-search"]').fill("双脚");
      await teacherPage.locator('[data-testid="guide-item-option"]').filter({ hasText: "双脚" }).first().click();
    }
    await teacherPage.locator('[data-testid="decision-performance"]').click();
    const chip = teacherPage.locator('[data-testid="basis-quote-choice"]').filter({ hasText: "户外游戏" }).first();
    if ((await chip.count()) > 0) {
      await chip.click();
    } else {
      await teacherPage.locator('[data-testid="basis-quote-input"]').first().fill("户外游戏");
    }
    await teacherPage.locator('[data-testid="decision-save"]').click();
    await teacherPage.locator("[data-testid=pending-decisions]").waitFor({ timeout: 30_000 });
    check("指南决定先进入待提交区（未归档宿主不提前生效）", true, "pending chip", "real_http+browser");
    await shoot(teacherPage, "04-teacher-review-pending-decision-1440.png");

    await teacherPage.locator("[data-testid=confirm-archive]").click();
    await teacherPage.waitForURL(/\/children\/.*\/evidence/, { timeout: 120_000 });
    check(
      "确认归档返回原条目与期间",
      teacherPage.url().includes(MAIN_ITEM) && teacherPage.url().includes("age_band=3-4"),
      teacherPage.url(),
    );
    const confirmed = await sql<{
      status: string;
      confirmed_content: Record<string, unknown> | null;
      confirmed_at: string;
      class_context_snapshot: Record<string, unknown> | null;
      guide_evidence: { revision: number; links: Array<Record<string, unknown>> } | null;
    }>(
      `SELECT status, confirmed_content, confirmed_at, class_context_snapshot, guide_evidence
       FROM observations WHERE id=$1`,
      [observationId],
    );
    const row = confirmed.rows[0];
    const link = row?.guide_evidence?.links?.[0] as Record<string, unknown> | undefined;
    const basis = (link?.basis as Array<Record<string, unknown>> | undefined)?.[0];
    check(
      "观察归档与指南关联同事务生效（confirmed + confirmed_performance/manual）",
      row?.status === "confirmed" && link?.status === "confirmed_performance" && link?.origin === "manual",
      JSON.stringify(link ?? null),
    );
    check(
      "依据快照版本与来源 confirmed_at 一致",
      Boolean(basis?.source_confirmed_at) &&
        new Date(String(basis?.source_confirmed_at)).getTime() === new Date(row?.confirmed_at ?? 0).getTime(),
      String(basis?.source_confirmed_at ?? "none"),
      "real_db",
    );
    check(
      "发生时班级快照阶段来自服务端（small）",
      row?.class_context_snapshot?.stage === "small" && row?.class_context_snapshot?.class_id === classId,
      JSON.stringify(row?.class_context_snapshot ?? null),
      "real_db",
    );
    check("容器 revision=1（首次写入）", row?.guide_evidence?.revision === 1, String(row?.guide_evidence?.revision), "real_db");

    /* ---------- 7. 个人证据册展开引用 ---------- */
    await teacherPage.goto(evidenceUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const evidenceRow = teacherPage.locator(`[data-item-id="${MAIN_ITEM}"]`);
    await evidenceRow.waitFor({ timeout: 90_000 });
    check(
      "个人证据册显示“已确认观察到”",
      (await evidenceRow.getAttribute("data-status")) === "confirmed_observed",
      String(await evidenceRow.getAttribute("data-status")),
    );
    await evidenceRow.locator('[data-testid="item-disclosure"]').click();
    const linkBlock = evidenceRow.locator("[data-testid=evidence-link]").first();
    await linkBlock.waitFor({ timeout: 30_000 });
    check(
      "证据来源可展开核对（逐字引用可见）",
      ((await linkBlock.textContent()) ?? "").includes("跳过了三条") === true,
      "quote visible",
    );
    await shoot(teacherPage, "05-child-evidence-confirmed-expanded-1440.png");

    /* ---------- 8. 班级同期聚合与下钻 ---------- */
    await teacherPage.goto(`${BASE}/classes/${classId}/evidence?domain=health&age_band=3-4`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    const classRow = teacherPage.locator(`[data-testid=class-evidence-item][data-item-id="${MAIN_ITEM}"]`);
    await classRow.waitFor({ timeout: 90_000 });
    await classRow.locator('[data-testid="item-disclosure"]').click();
    const classChildRow = classRow.locator(`[data-testid=child-row][data-child-id="${childId}"]`).first();
    await classChildRow.waitFor({ timeout: 30_000 });
    check(
      "班级同期聚合反映该幼儿为“已确认观察到”",
      (await classChildRow.getAttribute("data-status")) === "confirmed_observed" &&
        ((await classRow.textContent()) ?? "").includes("已确认观察到") === true,
      "class rollup",
    );
    await shoot(teacherPage, "06-class-rollup-1440.png");
    await classChildRow.locator("[data-testid=open-child-item]").click();
    await teacherPage.waitForURL(/\/children\/[0-9a-f-]{36}\/evidence\?/, { timeout: 60_000 });
    const drillUrl = new URL(teacherPage.url());
    const drilledRow = teacherPage.locator(`[data-item-id="${MAIN_ITEM}"]`);
    await drilledRow.waitFor({ timeout: 90_000 });
    check(
      "班级下钻保持幼儿、条目与期间",
      drillUrl.pathname === `/children/${childId}/evidence` &&
        drillUrl.searchParams.get("item_id") === MAIN_ITEM &&
        (drillUrl.searchParams.has("semester_id") || drillUrl.searchParams.get("scope") !== null) &&
        (await drilledRow.getAttribute("data-status")) === "confirmed_observed",
      drillUrl.pathname + drillUrl.search,
    );
    await shoot(teacherPage, "07-drilldown-child-evidence-1440.png");

    /* ---------- 9. 教师建档仍进入录入观察（A 项补充） ---------- */
    const teacherChildName = `教师建档幼儿${RUN_ID.slice(-4)}`;
    await teacherPage.goto(`${BASE}/children/new`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await fillChildForm(teacherPage, teacherChildName, CLASS_NAME);
    await teacherPage.getByRole("button", { name: "建立成长档案并记录观察" }).first().click();
    await teacherPage.waitForURL(/\/observations\/new\?/, { timeout: 60_000 });
    check("教师建档后仍进入录入观察", teacherPage.url().includes("child_id="), teacherPage.url());

    check("真实模型请求计数为 0（凭证留空 + 守门服务器）", guard.hits === 0, `guard hits=${guard.hits}`, "model_guard");

    await adminContext.close();
    await teacherContext.close();
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      issues.push("browser: close failed");
    }
    await runCleanupSteps(
      [
        { label: "joint-server", run: async () => (service ? stopTrackedChildTree(service) : undefined) },
        { label: "joint-client", run: async () => { if (client) await client.end(); } },
        { label: "joint-pool", run: async () => { await globalThis.__pgPool?.end(); } },
        { label: "model-guard", run: async () => { if (guard) await guard.close(); } },
        { label: "isolated-database", run: () => database?.teardown() },
        {
          label: "generated-artifacts",
          run: () => {
            const restored = restoreGeneratedArtifacts(artifacts, ROOT);
            return { ok: restored.issues.length === 0, detail: restored.issues.join("; ") };
          },
        },
      ],
      (label, detail) => issues.push(`${label}: ${detail}`),
    );
    assertCleanupComplete(issues);
  }

  const failed = results.filter((entry) => !entry.ok);
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "results.json"),
    JSON.stringify(
      {
        run_id: RUN_ID,
        base_url: BASE,
        isolated_database: true,
        real_model_requests: guard?.hits ?? 0,
        git_sha: (() => {
          try {
            return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
          } catch {
            return null;
          }
        })(),
        screenshots: screenshotCount,
        passed: results.length - failed.length,
        total: results.length,
        failed,
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: results.length - failed.length,
      total: results.length,
      real_model_requests: guard?.hits ?? 0,
      evidence_dir: EVIDENCE_DIR,
    }),
  );
  if (failed.length > 0) {
    for (const entry of failed) console.error(`FAIL ${entry.name}: ${entry.detail}`);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error((error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "<redacted>"));
  process.exitCode = 1;
});
