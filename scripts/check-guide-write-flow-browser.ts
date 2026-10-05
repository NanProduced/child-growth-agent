import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";

import {
  assertCleanupComplete, findListeningPids, modelGuardEnv, restoreGeneratedArtifacts,
  runCleanupSteps, snapshotGeneratedArtifacts, startIsolatedPostgres, startModelRequestGuard,
  stopTrackedChildTree, trackChildProcess, waitForVerifiedService,
  type IsolatedPostgres, type ModelRequestGuard, type TrackedChild,
} from "./harness-safety";

/**
 * G6-WRITE1 浏览器验收（B0 基线：园所账号 + 会话 CSRF，旧口令已退役）。
 *
 * - 真实 next dev + 隔离 PostgreSQL + 真实登录/CSRF/API 写入；
 * - 模型：organize 的整理草稿由测试进程内直接写入（离线替身，等价于进程内模块替身）；
 *   真实 provider 出口指向守门服务器且凭证留空，结束时计数必须为 0；
 * - AI 建议：seed 待核对工作流建议（fixture，非正式状态），“请求建议”按钮的请求用响应改写验证；
 * - deferred / applied+detail_unavailable / basis_expired 使用响应替身，结果中单独标注；
 * - 权限：任教教师对照；其他班教师（越界）与管理员不得出现写控件；原班历史只读不挂载写客户端。
 *
 * 运行：pnpm exec tsx scripts/check-guide-write-flow-browser.ts
 * 环境：G6_PORT（默认 3220）、G6_EVIDENCE_DIR、G6_PLAYWRIGHT_CORE、G6_CHROME。
 */

const ROOT = process.cwd();
const PORT = Number(process.env.G6_PORT ?? 3220);
const BASE = `http://127.0.0.1:${PORT}`;
const EVIDENCE_DIR = process.env.G6_EVIDENCE_DIR ?? path.join(os.tmpdir(), "g6-write1-browser");
const RUN_ID = `g6write1-${process.pid}-${Date.now().toString(36)}`;
const SHOTS = path.join(EVIDENCE_DIR, "shots");

const TEACHER_PASSWORD = "g6-teacher-pass-1";
const OTHER_PASSWORD = "g6-other-pass-1";
const ADMIN_PASSWORD = "g6-admin-pass-1";
const HISTORY_PASSWORD = "g6-history-pass-1";

const MAIN_ITEM = "item.moe.health.movement.1.3-4.3";
const SUSTAINED_ITEM = "item.moe.health.physical.2.3-4.1";
const INDEPENDENCE_ITEM = "item.moe.language.reading_writing.1.3-4.1";
const SUGGESTED_ITEM = "item.moe.health.movement.1.3-4.1";
const HISTORY_OBSERVATION_ID = "e5e50000-0000-4000-8000-0000000000a1";

const RAW_MAIN =
  "户外游戏时，果果双脚连续向前跳过了三条地面标线，途中没有停下，还回头对同伴说：「你看我跳过去了。」";
const RAW_SECOND =
  "户外游戏时，果果双脚向前跳了一段，落到第二条标线前停了一下，又接着跳完，笑着拍了拍手。";
const DRAFT_MAIN = {
  domain: "健康",
  sub_domain: "身体控制与协调",
  objective_description: "这件观察记录中出现双脚连续向前跳的动作过程。",
  highlights: ["连续跳过三条地面标线，途中没有停下。"],
  support_suggestions: ["提供不同间距的地面标线，让幼儿选择自己的尝试方式。"],
  highlight_quote: "双脚连续向前跳过了三条地面标线",
};
const DRAFT_SECOND = {
  domain: "健康",
  sub_domain: "身体控制与协调",
  objective_description: "这件观察记录中出现双脚向前跳的动作过程。",
  highlights: ["跳过一段距离后能继续完成。"],
  support_suggestions: ["继续提供安全、有选择的跳跃空间。"],
  highlight_quote: "双脚向前跳了一段",
};

interface Results {
  name: string;
  ok: boolean;
  detail: string;
  evidence: string;
}

const results: Results[] = [];
const issues: string[] = [];

function check(name: string, ok: boolean, detail: string, evidence = "real_http+real_db+browser") {
  results.push({ name, ok: Boolean(ok), detail, evidence });
}

function resolvePlaywrightCore(): string {
  if (process.env.G6_PLAYWRIGHT_CORE) return process.env.G6_PLAYWRIGHT_CORE;
  const scratch = path.join(os.tmpdir(), "g4-pw-core", "node_modules", "playwright-core");
  if (fs.existsSync(path.join(scratch, "package.json"))) return scratch;
  throw new Error("未找到 playwright-core；请设置 G6_PLAYWRIGHT_CORE 指向包目录");
}

function resolveChrome(): string {
  const candidates = [
    process.env.G6_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("未找到 Chrome/Edge；请设置 G6_CHROME");
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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

  try {
    database = await startIsolatedPostgres({
      runId: RUN_ID,
      containerName: `cga-${RUN_ID}`,
      dbName: `cga_g6_${process.pid}_${Date.now().toString(36)}`,
      labelKey: "child-growth-agent.g6-write1",
      noteIssue: (label, detail) => issues.push(`${label}: ${detail}`),
    });
    process.env.DATABASE_URL = database.url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = BASE;
    process.env.AUTH_SCHOOL_ID = "g6-write1-school";

    client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(fs.readFileSync(path.join(ROOT, "scripts/initialize-demo-db.sql"), "utf8"));
    await client.query(fs.readFileSync(path.join(ROOT, "scripts/upgrade-auth-v1.sql"), "utf8"));

    const { listGuideItems } = await import("../src/lib/guide/catalog");
    const { hashPassword } = await import("../src/lib/accounts/password");
    const repository = await import("../src/lib/accounts/repository");

    const itemById = new Map((await listGuideItems()).map((item) => [item.id, item]));
    const focusItem = itemById.get(MAIN_ITEM);
    const sustainedItem = itemById.get(SUSTAINED_ITEM);
    const independenceItem = itemById.get(INDEPENDENCE_ITEM);
    assert.ok(focusItem && sustainedItem && independenceItem, "目录必须包含验收条目");

    const classes = await client.query<{ id: string; name: string; stage: string }>(
      "SELECT id, name, stage FROM classes ORDER BY name",
    );
    const smallClass = classes.rows.find((row) => row.stage === "small");
    const middleClass = classes.rows.find((row) => row.stage === "middle");
    const largeClass = classes.rows.find((row) => row.stage === "large");
    assert.ok(smallClass && middleClass && largeClass, "缺少演示班级");
    const roster = await client.query<{ child_id: string; name: string }>(
      `SELECT e.child_id, c.name FROM child_class_enrollments e JOIN children c ON c.id = e.child_id
        WHERE e.class_id = $1 AND e.end_date IS NULL ORDER BY c.created_at`,
      [smallClass.id],
    );
    assert.ok(roster.rows.length >= 1, "小班演示名单不能为空");
    const child = roster.rows[0];

    const admin = await repository.createInitialAdmin(
      { username: "g6admin", displayName: "G6 管理员", passwordHash: await hashPassword(ADMIN_PASSWORD) },
      "g6-write1-school",
    );
    await repository.createTeacherWithAssignments({
      username: "g6teacher",
      displayName: "G6 任教教师",
      passwordHash: await hashPassword(TEACHER_PASSWORD),
      classIds: [smallClass.id],
      assignedBy: admin.account_id,
    });
    await repository.createTeacherWithAssignments({
      username: "g6other",
      displayName: "G6 其他班教师",
      passwordHash: await hashPassword(OTHER_PASSWORD),
      classIds: [largeClass.id],
      assignedBy: admin.account_id,
    });
    await repository.createTeacherWithAssignments({
      username: "g6history",
      displayName: "G6 原班教师",
      passwordHash: await hashPassword(HISTORY_PASSWORD),
      classIds: [middleClass.id],
      assignedBy: admin.account_id,
    });

    // 原班历史只读 fixture：石头已在蒲公英班，留一条发生在向日葵班的已归档观察
    const historyChild = await client.query<{ id: string }>(
      "SELECT id FROM children WHERE class_name = '蒲公英班' LIMIT 1",
    );
    assert.ok(historyChild.rows[0], "缺少转班演示幼儿");
    await client.query(
      `INSERT INTO observations (id, child_id, class_id, observed_at, context, raw_text, status, confirmed_content, confirmed_at, class_context_snapshot, is_demo, created_at)
       VALUES ($1,$2,$3,'2026-09-15','建构区活动','石头在建构区里把长条积木一根一根排整齐，说这是给恐龙搭的桥。','confirmed',
         $4::jsonb, now(),
         $5::jsonb, true, now())
       ON CONFLICT (id) DO UPDATE SET status='confirmed', confirmed_content=EXCLUDED.confirmed_content, class_id=EXCLUDED.class_id`,
      [
        HISTORY_OBSERVATION_ID,
        historyChild.rows[0].id,
        middleClass.id,
        JSON.stringify({
          domain: "科学",
          sub_domain: "探究与解决问题",
          objective_description: "这件旧记录来自升班前，仅作历史回看。",
          highlights: ["把积木排整齐并说明用途。"],
          support_suggestions: ["继续提供建构材料。"],
          highlight_quote: "这是给恐龙搭的桥",
        }),
        JSON.stringify({
          class_id: middleClass.id,
          class_name: middleClass.name,
          stage: middleClass.stage,
          school_year: "2026-2027",
          captured_at: "2026-09-15T02:00:00.000Z",
          source: "legacy_import",
        }),
      ],
    );

    guard = await startModelRequestGuard();
    const env: NodeJS.ProcessEnv = modelGuardEnv(guard, process.env);
    env.DATABASE_URL = database.url;
    delete env.PGDATABASE_URL;
    env.AUTH_TRUSTED_ORIGINS = BASE;
    env.AUTH_SCHOOL_ID = "g6-write1-school";
    // 模型替身：凭证留空使 provider 调用在发网前失败；守门服务器作为第二道闸，命中数必须为 0
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
    const browser = await playwright.chromium.launch({ executablePath: resolveChrome(), headless: true });

    const sql = async (text: string, params: unknown[] = []) => client!.query(text, params);
    const context: TestContext = {
      ROOT, BASE, browser, sql, client,
      child, smallClass, middleClass, largeClass,
      focusItem, sustainedItem, independenceItem,
    };

    try {
      await runMainFlow(context);
      await runArchivedFlow(context);
      await runServerRuleProbes(context);
      await runDetailUnavailableFlow(context);
      await runPermissionChecks(context);
      await runResponsiveChecks(context);
    } finally {
      await browser.close();
    }

    check("真实模型请求计数为 0（凭证留空 + 守门服务器）", guard.hits === 0, `guard hits=${guard.hits}`, "model_guard");
    console.log(JSON.stringify({ real_model_requests: guard.hits, guard_paths: guard.requestPaths }));
  } finally {
    await runCleanupSteps(
      [
        { label: "browser-server", run: async () => (service ? stopTrackedChildTree(service) : undefined) },
        { label: "test-client", run: async () => { if (client) await client.end(); } },
        { label: "test-pool", run: async () => { await globalThis.__pgPool?.end(); } },
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
    JSON.stringify({ run_id: RUN_ID, passed: results.length - failed.length, total: results.length, failed, results }, null, 2),
  );
  console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, evidence_dir: EVIDENCE_DIR }));
  if (failed.length > 0) {
    for (const entry of failed) console.error(`FAIL ${entry.name}: ${entry.detail}`);
    process.exitCode = 1;
  }
}

/* --------------------------------- 类型 --------------------------------- */

interface BrowserContext {
  newPage(options?: Record<string, unknown>): Promise<Page>;
  addCookies(cookies: Array<Record<string, unknown>>): Promise<void>;
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

interface Browser {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface Locator {
  waitFor(options?: Record<string, unknown>): Promise<void>;
  click(options?: Record<string, unknown>): Promise<void>;
  fill(value: string): Promise<void>;
  count(): Promise<number>;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  filter(options: Record<string, unknown>): Locator;
  getAttribute(name: string): Promise<string | null>;
  boundingBox(): Promise<{ height: number; width: number } | null>;
  isVisible(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  focus(): Promise<void>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  locator(selector: string): Locator;
}

interface RequestLike {
  method(): string;
  url(): string;
  postDataJSON(): unknown;
}

interface ResponseLike {
  json(): Promise<unknown>;
}

interface Page {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  locator(selector: string): Locator;
  getByRole(role: string, options?: Record<string, unknown>): Locator;
  getByText(text: string | RegExp, options?: Record<string, unknown>): Locator;
  keyboard: { press(key: string): Promise<void> };
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  waitForURL(url: string | RegExp, options?: Record<string, unknown>): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction<T>(fn: (arg: T) => boolean, arg?: T, options?: Record<string, unknown>): Promise<void>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  route(
    url: string,
    handler: (route: Route, request: RequestLike) => Promise<void>,
    options?: { times?: number },
  ): Promise<void>;
  unroute(url: string): Promise<void>;
  on(event: string, handler: (arg: RequestLike) => void): void;
  screenshot(options: Record<string, unknown>): Promise<unknown>;
  waitForLoadState(state: string): Promise<void>;
}

interface Route {
  fetch(): Promise<ResponseLike>;
  fulfill(options: Record<string, unknown>): Promise<void>;
  continue(): Promise<void>;
}

interface TestContext {
  ROOT: string;
  BASE: string;
  browser: Browser;
  sql: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
  client: Client;
  child: { child_id: string; name: string };
  smallClass: { id: string; name: string; stage: string };
  middleClass: { id: string; name: string; stage: string };
  largeClass: { id: string; name: string; stage: string };
  focusItem: { id: string; text: string };
  sustainedItem: { id: string; text: string };
  independenceItem: { id: string; text: string };
}

/* --------------------------------- 工具 --------------------------------- */

function reviewUrl(observationId: string, query = ""): string {
  return `/observations/${observationId}/review${query}`;
}

async function loginAccount(page: Page, username: string, password: string): Promise<boolean> {
  return page.evaluate(async (credentials: { username: string; password: string }) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cga-auth-request": "1" },
      body: JSON.stringify(credentials),
      credentials: "same-origin",
    });
    return response.ok;
  }, { username, password });
}

/** 每个场景独立浏览器上下文 + 真实园所账号登录（登录页为 B0 正式入口） */
async function newAccountContext(
  ctx: TestContext,
  username: string,
  password: string,
  viewport?: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await ctx.browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await page.goto(`${ctx.BASE}/login`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  const ok = await loginAccount(page, username, password);
  if (!ok) throw new Error(`园所账号登录失败：${username}`);
  return { context, page };
}

interface ApiResult {
  status: number;
  json: Record<string, unknown>;
}

/** 浏览器内真实 POST；withCsrf=false 用于验证 CSRF 保护仍然生效 */
async function apiPost(
  page: Page,
  url: string,
  body: unknown,
  withCsrf = true,
): Promise<ApiResult> {
  return page.evaluate(async (input: { url: string; body: unknown; withCsrf: boolean }) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (input.withCsrf) {
      const status = await fetch("/api/auth/status", { credentials: "same-origin" }).then((response) => response.json());
      const token = status?.csrf?.token;
      if (typeof token === "string" && token.length > 0) headers["x-csrf-token"] = token;
    }
    const response = await fetch(input.url, {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
      credentials: "same-origin",
    });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  }, { url, body, withCsrf });
}

/** 失败时保留现场（URL、notice、草稿错误、截图）便于定位 */
async function debugDump(page: Page, step: string) {
  const notice = await page.locator("[data-testid=guide-association-notice]").first().textContent().catch(() => null);
  const draftError = await page.locator("[data-testid=decision-error]").first().textContent().catch(() => null);
  const editorCount = await page.locator("[data-testid=decision-editor]").count().catch(() => -1);
  const manualCount = await page.locator("[data-testid=guide-manual-add]").count().catch(() => -1);
  const body = (await page.locator("body").textContent()) ?? "";
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `debug-${step}.json`),
    JSON.stringify({ url: page.url(), notice, draftError, editorCount, manualCount, tail: body.slice(-2000) }, null, 2),
  );
  await page.screenshot({ path: path.join(SHOTS, `debug-${step}.png`), fullPage: true }).catch(() => undefined);
  console.error(`[g6] step '${step}' failed: notice=${String(notice)} draftError=${String(draftError)} editor=${editorCount} manual=${manualCount}`);
}

/** 等待界面提示；失败时保留现场 */
async function waitForText(page: Page, text: string, step: string, timeout = 30_000) {
  try {
    await page.getByText(text).waitFor({ timeout });
  } catch (error) {
    await debugDump(page, step);
    throw error;
  }
}

async function clickWithDebug(page: Page, selector: string, step: string) {
  try {
    await page.locator(selector).click();
  } catch (error) {
    await debugDump(page, step);
    throw error;
  }
}

async function waitEditorClosed(page: Page, step: string) {
  try {
    await page.locator('[data-testid="decision-editor"]').waitFor({ state: "detached", timeout: 30_000 });
  } catch (error) {
    await debugDump(page, step);
    throw error;
  }
}

/** 已归档决定保存：编辑器关闭是服务端写入成功的唯一前置信号（避免匹配到旧提示） */
async function saveArchivedDecision(page: Page, step: string) {
  await clickWithDebug(page, '[data-testid="decision-save"]', `${step}_save`);
  await waitEditorClosed(page, step);
  await waitForText(page, "关联已按当前依据写入", `${step}_notice`);
}

async function openAssociation(page: Page) {
  const disclosure = page.locator("[data-testid=guide-association-disclosure]");
  await disclosure.waitFor({ timeout: 90_000 });
  if ((await disclosure.getAttribute("aria-expanded")) !== "true") {
    await disclosure.click();
  }
}

async function openEvidenceItem(page: Page, itemId: string) {
  await page.locator(`[data-item-id="${itemId}"]`).waitFor({ timeout: 90_000 });
  await page.locator(`[data-item-id="${itemId}"] [data-testid="item-disclosure"]`).click();
  await page.locator(`[data-item-id="${itemId}"] [data-testid="record-observation"]`).waitFor({ timeout: 20_000 });
}

async function addPendingManualDecision(
  page: Page,
  options: { keyword: string; performance: boolean; clue?: boolean },
) {
  await page.locator('[data-testid="guide-manual-add"]').click();
  const editor = page.locator('[data-testid="decision-editor"]');
  await editor.waitFor({ timeout: 20_000 });
  // 编辑器可能已预选关注条目；没有预选时按关键词搜索
  if ((await page.locator('[data-testid="guide-item-search"]').count()) > 0) {
    await page.locator('[data-testid="guide-item-search"]').fill(options.keyword);
    await page.locator('[data-testid="guide-item-option"]').filter({ hasText: options.keyword }).first().click();
  }
  if (options.performance) {
    await page.locator('[data-testid="decision-performance"]').click();
  } else if (options.clue) {
    await editor.locator("label").filter({ hasText: "已有相关线索" }).click();
  }
  const chip = page.locator('[data-testid="basis-quote-choice"]').filter({ hasText: options.keyword }).first();
  if ((await chip.count()) > 0) {
    await chip.click();
  } else {
    await page.locator('[data-testid="basis-quote-input"]').first().fill(options.keyword);
  }
  await page.locator('[data-testid="decision-save"]').click();
}

/* --------------------------------- 主流程 --------------------------------- */

async function runMainFlow(ctx: TestContext): Promise<void> {
  const { context, page } = await newAccountContext(ctx, "g6teacher", TEACHER_PASSWORD, {
    width: 1440,
    height: 900,
  });
  const confirmPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/confirm")) confirmPosts.push(request.url());
  });

  const evidenceUrl = `${ctx.BASE}/children/${ctx.child.child_id}/evidence?domain=health&age_band=3-4`;
  await page.goto(evidenceUrl, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator("[data-testid=child-evidence-book]").waitFor({ timeout: 120_000 });
  await openEvidenceItem(page, ctx.focusItem.id);
  check("证据页出现“记录相关观察”入口（任教教师）", (await page.locator("[data-testid=record-observation]").count()) >= 1, "in-scope teacher", "real_http+browser+real_db");
  await page.locator(`[data-item-id="${ctx.focusItem.id}"] [data-testid="record-observation"]`).click();
  await page.waitForURL(/\/observations\/new\?/, { timeout: 90_000 });
  const newUrl = new URL(page.url());
  check(
    "录入链接携带 child_id 与 item_id 及返回上下文",
    newUrl.searchParams.get("child_id") === ctx.child.child_id &&
      newUrl.searchParams.get("item_id") === ctx.focusItem.id &&
      Boolean(newUrl.searchParams.get("return_to")),
    newUrl.search,
    "real_http+browser",
  );
  try {
    await page.locator("[data-testid=focus-note]").waitFor({ timeout: 90_000 });
  } catch (error) {
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    fs.writeFileSync(path.join(EVIDENCE_DIR, "new-page-debug.html"), html);
    await page.screenshot({ path: path.join(SHOTS, "debug-new-observation.png"), fullPage: true });
    throw error;
  }
  await page.locator("#raw").fill(RAW_MAIN);
  await page.waitForFunction(() => !document.body.innerText.includes("正在按分班历史核对"), undefined, { timeout: 90_000 });
  await page.locator("[data-testid=save-observation]").click();
  await page.waitForURL(/\/observations\/[^/]+\/review/, { timeout: 90_000 });
  const observationId = page.url().match(/\/observations\/([^/]+)\/review/)?.[1] ?? "";
  const reviewFocusUrl = page.url();
  check("浏览器录入新观察并进入 Review", Boolean(observationId), observationId, "real_http+browser+real_db");
  await page.locator("[data-testid=guide-association-section]").waitFor({ timeout: 90_000 });
  check("Review 保留关注点（区段自动展开并展示关注条目）", await page.locator("[data-testid=focus-item]").isVisible(), "focus banner", "real_http+browser");

  // 模型替身：把整理草稿写入数据库（等价于进程内 organize 替身，不触达 provider）
  await ctx.sql(
    `UPDATE observations SET status='ai_organized', ai_draft=$2::jsonb, ai_model='offline-substitute',
       ai_organized_at=now(), updated_at=now() WHERE id=$1`,
    [observationId, JSON.stringify(DRAFT_MAIN)],
  );
  check("整理步骤使用测试进程内替身（非真实模型）", true, "ai_draft injected", "in_process_substitute");

  await page.goto(reviewFocusUrl, { waitUntil: "domcontentloaded" });
  await page.locator("[data-testid=guide-association-section]").waitFor({ timeout: 120_000 });

  await addPendingManualDecision(page, { keyword: "户外游戏", performance: true });
  await page.locator("[data-testid=pending-decisions]").waitFor({ timeout: 20_000 });
  check("未归档观察的选择进入待提交区（未显示已生效）", (await page.locator("[data-testid=pending-decisions]").count()) === 1, "pending chip", "interface_double");
  check("关注条目只作为表单预选，不自动成为关联", (await ctx.sql("SELECT guide_evidence FROM observations WHERE id=$1", [observationId])).rows[0].guide_evidence === null, "guide_evidence still null", "real_db");

  // deferred 替身：确认返回 deferred，待提交选择必须保留
  await page.route("**/api/observations/*/confirm", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        observation: {
          id: observationId, child_id: ctx.child.child_id, class_id: ctx.smallClass.id, observed_class: null,
          observed_at: todayInShanghai(), context: "户外自主游戏", raw_text: RAW_MAIN, status: "ai_organized",
          agent_context: null, ai_draft: DRAFT_MAIN, ai_model: "offline-substitute",
          ai_organized_at: new Date().toISOString(), confirmed_content: null, confirmed_at: null,
          class_context_snapshot: null, guide_evidence: null, is_demo: false,
          created_at: new Date().toISOString(), updated_at: null,
        },
        requiresAgentConfirmation: true,
        agentReview: { decision: "accept", summary: "已理解当前内容", change_summary: [], fact_check: "supported", question: "" },
        guideEvidence: { status: "deferred" },
      }),
    });
  }, { times: 1 });
  await page.getByRole("button", { name: "确认归档" }).click();
  await waitForText(page, "关联选择已保留", "deferred");
  check("deferred 保留待提交选择且不显示已生效", (await page.locator("[data-testid=pending-decisions]").count()) === 1, "pending remains", "interface_double");
  check("deferred 未写入数据库", (await ctx.sql("SELECT status FROM observations WHERE id=$1", [observationId])).rows[0].status === "ai_organized", "still ai_organized", "real_db");
  await page.unroute("**/api/observations/*/confirm");

  // basis_expired 替身：409 后保留选择、提示重新核对
  await page.route("**/api/observations/*/confirm", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "basis_expired", message: "引用依据在归档前已更新，请重新核对。" }),
    });
  }, { times: 1 });
  await page.getByRole("button", { name: "确认归档" }).click();
  await waitForText(page, "请重新读取后核对", "basis_expired");
  check("依据过期时保留选择并要求重新核对（不自动重放）", (await page.locator("[data-testid=pending-decisions]").count()) === 1, "pending remains", "interface_double");
  await page.unroute("**/api/observations/*/confirm");

  // 真实归档 + 关联（同一事务；园所账号 + 会话 CSRF）
  await page.getByRole("button", { name: "确认归档" }).click();
  await page.waitForURL(/\/children\/.*\/evidence/, { timeout: 120_000 });
  check("归档成功返回原条目与期间（return_to 起点）", page.url().includes(ctx.focusItem.id) && page.url().includes("age_band=3-4"), page.url(), "real_http+browser");
  const row = await ctx.sql<{ status: string; guide_evidence: Record<string, unknown> }>(
    "SELECT status, guide_evidence FROM observations WHERE id=$1",
    [observationId],
  );
  const container = row.rows[0].guide_evidence as { revision: number; links: Array<Record<string, unknown>> };
  const link = container?.links?.[0] as Record<string, unknown>;
  check("归档与关联同事务写入数据库", row.rows[0].status === "confirmed" && link?.status === "confirmed_performance" && link?.origin === "manual", JSON.stringify(link), "real_http+real_db");
  const basis = (link?.basis as Array<Record<string, unknown>>)?.[0];
  const confirmedAt = (await ctx.sql<{ confirmed_at: string }>("SELECT confirmed_at FROM observations WHERE id=$1", [observationId])).rows[0].confirmed_at;
  check("依据快照含来源版本（confirmed_at 一致）", Boolean(basis?.source_confirmed_at) && new Date(String(basis.source_confirmed_at)).getTime() === new Date(confirmedAt).getTime(), String(basis?.source_confirmed_at), "real_db");
  check(
    "确认尝试 3 次（deferred/basis 替身各 1 + 真实归档 1；数据库只归档一次）",
    confirmPosts.filter((url) => url.includes(observationId)).length === 3 && row.rows[0].status === "confirmed",
    `posts=${confirmPosts.filter((url) => url.includes(observationId)).length}`,
    "real_http+interface_double",
  );

  // 证据页呈现正式状态
  await page.goto(evidenceUrl, { waitUntil: "domcontentloaded" });
  const evidenceRow = page.locator(`[data-item-id="${ctx.focusItem.id}"]`);
  await evidenceRow.waitFor({ timeout: 90_000 });
  check("个人证据册出现“已确认观察到”", (await evidenceRow.getAttribute("data-status")) === "confirmed_observed", String(await evidenceRow.getAttribute("data-status")), "real_http+real_db+browser");
  await evidenceRow.locator('[data-testid="item-disclosure"]').click();
  const linkBlock = evidenceRow.locator("[data-testid=evidence-link]").first();
  await linkBlock.waitFor({ timeout: 20_000 });
  check("证据来源可展开核对（引用与日期）", (await linkBlock.textContent())?.includes("跳过了三条") === true, "quote visible", "real_http+real_db+browser");
  await page.screenshot({ path: path.join(SHOTS, "01-child-evidence-after-confirm.png"), fullPage: true });

  // 班级聚合：同期间人数变化
  await page.goto(`${ctx.BASE}/classes/${ctx.smallClass.id}/evidence?domain=health&age_band=3-4`, { waitUntil: "domcontentloaded" });
  const classRow = page.locator(`[data-testid=class-evidence-item][data-item-id="${ctx.focusItem.id}"]`);
  await classRow.waitFor({ timeout: 90_000 });
  await classRow.locator('[data-testid="item-disclosure"]').click();
  const childRow = classRow.locator(`[data-testid=child-row][data-child-id="${ctx.child.child_id}"]`).first();
  await childRow.waitFor({ timeout: 20_000 });
  check("班级同期聚合反映人数变化", (await childRow.getAttribute("data-status")) === "confirmed_observed" && (await classRow.textContent())?.includes("已确认观察到") === true, "class rollup", "real_http+real_db+browser");
  await page.screenshot({ path: path.join(SHOTS, "02-class-rollup-after-confirm.png"), fullPage: true });
  await context.close();
  (globalThis as Record<string, unknown>).__mainObservationId = observationId;
}

/* --------------------------------- 已归档操作 --------------------------------- */

async function runArchivedFlow(ctx: TestContext): Promise<void> {
  const observationId = (globalThis as Record<string, unknown>).__mainObservationId as string;
  const { context, page } = await newAccountContext(ctx, "g6teacher", TEACHER_PASSWORD, {
    width: 1440,
    height: 900,
  });
  await page.goto(`${ctx.BASE}${reviewUrl(observationId)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await openAssociation(page);
  await page.locator("[data-testid=guide-active-links]").waitFor({ timeout: 120_000 });
  check("已归档观察出现关联操作区与撤回入口", (await page.locator("[data-testid=guide-withdraw]").count()) >= 1, "withdraw visible", "real_http+browser");

  // 撤回：终态保留审计，不原地复活
  await page.locator("[data-testid=guide-withdraw]").first().click();
  await page.locator('input[placeholder="撤回原因（选填）"]').fill("教师复核后决定撤回，改用更充分的依据。");
  await page.getByRole("button", { name: "确认撤回" }).click();
  await waitForText(page, "已撤回这条关联", "withdraw");
  const withdrawn = await ctx.sql<{ guide_evidence: { links: Array<Record<string, unknown>> } }>(
    "SELECT guide_evidence FROM observations WHERE id=$1",
    [observationId],
  );
  const withdrawnLink = (withdrawn.rows[0].guide_evidence?.links ?? []).find((entry) => entry.status === "withdrawn") as Record<string, unknown> | undefined;
  check("撤回真实写入并保留 support/依据/撤回信息", Boolean(withdrawnLink?.withdrawn_at) && withdrawnLink?.support === "single_event" && Array.isArray(withdrawnLink?.basis), String(withdrawnLink?.withdrawn_at), "real_http+real_db");

  // 终态后通过新关联恢复
  await clickWithDebug(page, '[data-testid="guide-manual-add"]', "reassociate_open");
  await page.locator('[data-testid="guide-item-search"]').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="guide-item-search"]').fill("双脚连续向前跳");
  await page.locator('[data-testid="guide-item-option"]').filter({ hasText: "双脚连续向前跳" }).first().click();
  await page.locator('[data-testid="decision-performance"]').click();
  await page.locator('[data-testid="basis-quote-choice"]').filter({ hasText: "户外游戏" }).first().click();
  await saveArchivedDecision(page, "reassociate");
  const restored = await ctx.sql<{ guide_evidence: { links: Array<Record<string, unknown>> } }>(
    "SELECT guide_evidence FROM observations WHERE id=$1",
    [observationId],
  );
  const links = restored.rows[0].guide_evidence?.links ?? [];
  check("撤回后通过新关联恢复（旧审计保留，新 link 生效）", links.length >= 2 && links.some((entry) => entry.status === "confirmed_performance" && entry.id !== withdrawnLink?.id), `links=${links.length}`, "real_http+real_db");

  // AI 建议工作流：seed 一条待核对建议，走真实“不采用”
  const seeded = await ctx.sql("SELECT guide_evidence FROM observations WHERE id=$1", [observationId]);
  void seeded;
  const suggestion = {
    id: `g6-suggested-${Date.now()}`,
    item_id: SUGGESTED_ITEM,
    catalog_version: "moe-3-6-2012.v1",
    origin: "ai",
    status: "ai_suggested",
    support: null,
    sustained_note: null,
    adult_help_used: false,
    basis: [{ observation_id: observationId, observed_at: todayInShanghai(), quote: "双脚连续向前跳过了三条地面标线", quote_source: "raw_text", quote_field: null, class_context: null, source_confirmed_at: null }],
    ai_reason: "测试替身：出现与条目相关的动作片段。",
    teacher_note: null,
    revision: 1,
    created_at: new Date().toISOString(),
    decided_at: null,
    withdrawn_at: null,
    withdrawn_reason: null,
  };
  await ctx.sql("UPDATE observations SET guide_evidence = jsonb_set(COALESCE(guide_evidence, '{}'::jsonb), '{links}', COALESCE(guide_evidence->'links', '[]'::jsonb) || $2::jsonb, true) WHERE id=$1", [
    observationId,
    JSON.stringify([suggestion]),
  ]);
  check("AI 待核对建议以工作流状态预置（不计入正式状态，来源为测试 fixture）", true, "ai_suggested seeded", "fixture");

  await page.goto(`${ctx.BASE}${reviewUrl(observationId)}`, { waitUntil: "domcontentloaded" });
  await openAssociation(page);
  await page.locator("[data-testid=guide-suggestion]").waitFor({ timeout: 90_000 });
  check("AI 建议展示理由与待核对状态", (await page.locator("[data-testid=guide-suggestion]").textContent())?.includes("测试替身") === true, "ai reason", "real_http+browser");
  check("打开页面不自动调用 AI（请求按钮可见但无自动请求）", (await page.locator("[data-testid=guide-suggest]").count()) === 1, "manual trigger only", "real_http+browser");

  // 请求 AI 建议按钮：路由改写为失败提示（接口替身；provider 凭证留空，不触达模型）
  let suggestCalls = 0;
  await page.route("**/api/observations/*/guide-evidence", async (route, request) => {
    const body = request.postDataJSON() as { action?: string } | null;
    if (body?.action === "suggest") {
      suggestCalls += 1;
      const response = await route.fetch();
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      json.notice = { code: "ai_link_failed", severity: "warning", message: "AI 建议替身：模型不可用（测试环境不调用真实 provider）。" };
      await route.fulfill({ response, json });
      return;
    }
    await route.continue();
  });
  await page.locator("[data-testid=guide-suggest]").click();
  await waitForText(page, "AI 建议替身", "suggest");
  check("AI 建议由教师主动请求（替身响应，真实 provider 未调用）", suggestCalls === 1, `suggest calls=${suggestCalls}`, "interface_double");
  await page.unroute("**/api/observations/*/guide-evidence");

  await page.locator("[data-testid=guide-suggestion-reject]").first().click();
  await page.locator('input[placeholder="不采用原因（选填）"]').fill("证据片段不足以对应这条表现，先不采用。");
  await page.getByRole("button", { name: "确认不采用" }).click();
  await waitForText(page, "已不采用这条 AI 建议", "reject");
  const rejected = await ctx.sql<{ guide_evidence: { links: Array<Record<string, unknown>> } }>(
    "SELECT guide_evidence FROM observations WHERE id=$1",
    [observationId],
  );
  const rejectedLink = (rejected.rows[0].guide_evidence?.links ?? []).find((entry) => entry.status === "rejected") as Record<string, unknown> | undefined;
  check("不采用真实写入：终态、support=null、理由保留", rejectedLink?.support === null && rejectedLink?.teacher_note === "证据片段不足以对应这条表现，先不采用。", JSON.stringify(rejectedLink?.teacher_note), "real_http+real_db");

  // 持续性条件：单日依据 + 结构化纪要，真实写入
  await clickWithDebug(page, '[data-testid="guide-manual-add"]', "sustained_open");
  await page.locator('[data-testid="guide-item-search"]').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="guide-item-search"]').fill("情绪比较稳定");
  await page.locator('[data-testid="guide-item-option"]').filter({ hasText: "情绪比较稳定" }).first().click();
  await page.locator('[data-testid="decision-performance"]').click();
  await page.locator('[data-testid="basis-quote-choice"]').filter({ hasText: "户外游戏" }).first().click();
  const dateInputs = page.locator('[data-testid="decision-editor"] input[type="date"]');
  await dateInputs.nth(0).fill(todayInShanghai());
  await dateInputs.nth(1).fill(todayInShanghai());
  await page
    .locator('[data-testid="decision-editor"] textarea[placeholder*="事实说明"]')
    .fill("本次户外游戏期间连续观察到情绪稳定、能继续参与活动。");
  await saveArchivedDecision(page, "sustained");
  const sustained = await ctx.sql<{ guide_evidence: { links: Array<Record<string, unknown>> } }>(
    "SELECT guide_evidence FROM observations WHERE id=$1",
    [observationId],
  );
  const sustainedLink = (sustained.rows[0].guide_evidence?.links ?? []).find((entry) => entry.item_id === SUSTAINED_ITEM) as Record<string, unknown> | undefined;
  check("持续性条件按既有规则采集（结构纪要真实写入）", sustainedLink?.status === "confirmed_performance" && sustainedLink?.support === "sustained" && Boolean((sustainedLink?.sustained_note as Record<string, unknown>)?.description), JSON.stringify(sustainedLink?.support), "real_http+real_db");

  // 成人帮助：requires_independence 条目禁用表现确认，线索仍可写入
  await clickWithDebug(page, '[data-testid="guide-manual-add"]', "adult_help_open");
  await page.locator('[data-testid="guide-item-search"]').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="guide-item-search"]').fill("主动要求成人讲故事");
  await page.locator('[data-testid="guide-item-option"]').filter({ hasText: "主动要求成人讲故事" }).first().click();
  await page.locator('[data-testid="decision-performance"]').click();
  const helpToggle = page.locator('[data-testid="adult-help-toggle"]');
  check("要求独立的条目在表现决定下禁用成人帮助选项", await helpToggle.isDisabled(), "checkbox disabled", "real_http+browser");
  await page.locator('[data-testid="decision-editor"] label').filter({ hasText: "已有相关线索" }).click();
  await helpToggle.click();
  await page.locator("#guide-teacher-note").fill("老师提示后他主动拿书请老师讲。");
  await page.locator('[data-testid="basis-quote-choice"]').filter({ hasText: "户外游戏" }).first().click();
  await saveArchivedDecision(page, "adult_help");
  const clue = await ctx.sql<{ guide_evidence: { links: Array<Record<string, unknown>> } }>(
    "SELECT guide_evidence FROM observations WHERE id=$1",
    [observationId],
  );
  const clueLink = (clue.rows[0].guide_evidence?.links ?? []).find((entry) => entry.item_id === INDEPENDENCE_ITEM) as Record<string, unknown> | undefined;
  check("有成人帮助时独立条目只能确认线索（真实写入）", clueLink?.status === "confirmed_clue" && clueLink?.adult_help_used === true, JSON.stringify(clueLink?.status), "real_http+real_db");
  await page.screenshot({ path: path.join(SHOTS, "03-archived-association.png"), fullPage: true });
  await context.close();
}

/* --------------------------------- 服务端规则直探 --------------------------------- */

async function runServerRuleProbes(ctx: TestContext): Promise<void> {
  const observationId = (globalThis as Record<string, unknown>).__mainObservationId as string;
  const { context, page } = await newAccountContext(ctx, "g6teacher", TEACHER_PASSWORD);
  await page.goto(`${ctx.BASE}${reviewUrl(observationId)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator("[data-testid=guide-association-section]").waitFor({ timeout: 120_000 });

  const revisionRow = await ctx.sql<{ revision: number }>(
    "SELECT COALESCE((guide_evidence->>'revision')::int, 0) AS revision FROM observations WHERE id=$1",
    [observationId],
  );
  const revision = revisionRow.rows[0].revision;
  const url = `/api/observations/${observationId}/guide-evidence`;

  const invalidHelp = await apiPost(page, url, {
    action: "confirm",
    expected_guide_revision: revision,
    decisions: [{ item_id: INDEPENDENCE_ITEM, support: "single_event", adult_help_used: true, teacher_note: "牵手完成", basis: [{ observation_id: observationId, quote: "双脚连续向前跳过了三条地面标线", quote_source: "raw_text" }] }],
  });
  check("服务端拒绝“要求独立 + 成人帮助 + 确认表现”（400）", invalidHelp.status === 400 && invalidHelp.json.error === "invalid_request", `${invalidHelp.status} ${String(invalidHelp.json.message)}`, "real_http+real_db");

  const invalidSustained = await apiPost(page, url, {
    action: "confirm",
    expected_guide_revision: revision,
    decisions: [{ item_id: SUSTAINED_ITEM, support: "single_event", basis: [{ observation_id: observationId, quote: "双脚连续向前跳过了三条地面标线", quote_source: "raw_text" }] }],
  });
  check("服务端拒绝持续性条目用单次支持确认表现（400）", invalidSustained.status === 400, `${invalidSustained.status} ${String(invalidSustained.json.message)}`, "real_http+real_db");

  const stale = await apiPost(page, url, {
    action: "confirm",
    expected_guide_revision: revision + 99,
    decisions: [{ item_id: SUGGESTED_ITEM, support: "clue_only", basis: [{ observation_id: observationId, quote: "双脚连续向前跳过了三条地面标线", quote_source: "raw_text" }] }],
  });
  check("过期 revision 返回 409 state_conflict（不静默覆盖）", stale.status === 409 && stale.json.error === "state_conflict", `${stale.status} ${String(stale.json.error)}`, "real_http+real_db");

  const noCsrf = await apiPost(page, url, { action: "suggest" }, false);
  check("缺少会话 CSRF 的写请求被拒绝（B0 保护未被绕过）", noCsrf.status === 403 && noCsrf.json.error === "csrf_rejected", `${noCsrf.status} ${String(noCsrf.json.error)}`, "real_http+real_db");
  await context.close();
}

/* --------------------------------- 已保存但详情读取失败 --------------------------------- */

async function runDetailUnavailableFlow(ctx: TestContext): Promise<void> {
  const { context, page } = await newAccountContext(ctx, "g6teacher", TEACHER_PASSWORD);
  await page.goto(`${ctx.BASE}/observations/new?child_id=${ctx.child.child_id}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator("#raw").waitFor({ timeout: 90_000 });
  await page.locator("#raw").fill(RAW_SECOND);
  await page.waitForFunction(() => !document.body.innerText.includes("正在按分班历史核对"), undefined, { timeout: 90_000 });
  await page.locator("[data-testid=save-observation]").click();
  await page.waitForURL(/\/observations\/[^/]+\/review/, { timeout: 90_000 });
  const secondId = page.url().match(/\/observations\/([^/]+)\/review/)?.[1] ?? "";
  check("第二条观察经真实录入 API 创建（园所账号 + CSRF）", Boolean(secondId), secondId, "real_http+real_db");
  await ctx.sql(
    "UPDATE observations SET status='ai_organized', ai_draft=$2::jsonb, ai_model='offline-substitute', ai_organized_at=now(), updated_at=now() WHERE id=$1",
    [secondId, JSON.stringify(DRAFT_SECOND)],
  );

  let confirmCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(secondId) && request.url().includes("/confirm")) confirmCount += 1;
  });
  let patched = false;
  await page.route("**/api/observations/*/confirm", async (route) => {
    if (patched) {
      await route.continue();
      return;
    }
    patched = true;
    const response = await route.fetch();
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (json.guideEvidence) {
      const guide = json.guideEvidence as Record<string, unknown>;
      json.guideEvidence = {
        status: "applied",
        revision: guide.revision ?? 1,
        detail_unavailable: true,
        message: "观察与关联决定已保存；证据详情暂时无法读取，请刷新查看，不要重复提交。",
      };
    }
    await route.fulfill({ response, json });
  });

  await page.goto(`${ctx.BASE}${reviewUrl(secondId)}`, { waitUntil: "domcontentloaded" });
  await openAssociation(page);
  await page.locator('[data-testid="guide-manual-add"]').click();
  await page.locator('[data-testid="guide-item-search"]').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="guide-item-search"]').fill("双脚连续向前跳");
  await page.locator('[data-testid="guide-item-option"]').filter({ hasText: "双脚连续向前跳" }).first().click();
  await page.locator('[data-testid="decision-performance"]').click();
  await page.locator('[data-testid="basis-quote-choice"]').filter({ hasText: "户外游戏" }).first().click();
  await page.locator('[data-testid="decision-save"]').click();
  await page.locator('[data-testid="pending-decisions"]').waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认归档" }).click();
  await page.getByText("证据详情暂时无法读取").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  check("applied + detail_unavailable 明确告知已保存且只提交一次", confirmCount === 1, `confirm posts=${confirmCount}`, "real_write+response_double");
  const second = await ctx.sql<{ status: string; guide_evidence: Record<string, unknown> }>(
    "SELECT status, guide_evidence FROM observations WHERE id=$1",
    [secondId],
  );
  check("真实归档与关联已写入（详情失败不改报失败）", second.rows[0].status === "confirmed" && Array.isArray((second.rows[0].guide_evidence as { links?: unknown[] })?.links), second.rows[0].status, "real_http+real_db");
  await context.close();
}

/* --------------------------------- 只读权限 --------------------------------- */

async function runPermissionChecks(ctx: TestContext): Promise<void> {
  const observationId = (globalThis as Record<string, unknown>).__mainObservationId as string;

  // 任教教师：有写入口（对照）
  {
    const { context, page } = await newAccountContext(ctx, "g6teacher", TEACHER_PASSWORD, { width: 1280, height: 800 });
    await page.goto(`${ctx.BASE}/children/${ctx.child.child_id}/evidence?domain=health&age_band=3-4`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid=child-evidence-book]").waitFor({ timeout: 90_000 });
    await page.locator(`[data-item-id="${ctx.focusItem.id}"] [data-testid="item-disclosure"]`).click();
    check("任教教师：个人证据册出现记录入口", (await page.locator(`[data-item-id="${ctx.focusItem.id}"] [data-testid="record-observation"]`).count()) >= 1, "record visible", "real_http+real_db+browser");
    await page.goto(`${ctx.BASE}${reviewUrl(observationId)}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid=guide-association-section]").waitFor({ timeout: 90_000 });
    await page.locator("[data-testid=guide-association-disclosure]").click();
    check("任教教师：Review 出现关联写入口", (await page.locator("[data-testid=guide-manual-add]").count()) >= 1, "manual add visible", "real_http+real_db+browser");
    await context.close();
  }

  // 其他班教师：越界不可读、无写控件
  {
    const { context, page } = await newAccountContext(ctx, "g6other", OTHER_PASSWORD, { width: 1280, height: 800 });
    await page.goto(`${ctx.BASE}/children/${ctx.child.child_id}/evidence?domain=health&age_band=3-4`, { waitUntil: "domcontentloaded" });
    await page.getByText("资料暂时不可读").waitFor({ timeout: 60_000 }).catch(() => undefined);
    const body = (await page.locator("body").textContent()) ?? "";
    check("其他班教师：越界证据页不泄露数据且无写入口", body.includes("资料暂时不可读") && (await page.locator("[data-testid=record-observation]").count()) === 0, body.slice(0, 60), "real_http+real_db+browser");
    await page.goto(`${ctx.BASE}${reviewUrl(observationId)}`, { waitUntil: "domcontentloaded" });
    await page.getByText("资料暂时不可读").waitFor({ timeout: 60_000 }).catch(() => undefined);
    check("其他班教师：Review 越界无写控件", (await page.locator("[data-testid=guide-association-section]").count()) === 0, "no association section", "real_http+real_db+browser");
    await context.close();
  }

  // 管理员：可读但没有教学写控件
  {
    const { context, page } = await newAccountContext(ctx, "g6admin", ADMIN_PASSWORD, { width: 1280, height: 800 });
    await page.goto(`${ctx.BASE}/children/${ctx.child.child_id}/evidence?domain=health&age_band=3-4`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid=child-evidence-book]").waitFor({ timeout: 90_000 });
    await page.locator(`[data-item-id="${ctx.focusItem.id}"] [data-testid="item-disclosure"]`).click();
    check("管理员：个人证据册无记录写入口", (await page.locator(`[data-item-id="${ctx.focusItem.id}"] [data-testid="record-observation"]`).count()) === 0, "no record entry", "real_http+real_db+browser");
    await page.goto(`${ctx.BASE}${reviewUrl(observationId)}`, { waitUntil: "domcontentloaded" });
    await page.getByText("观察记录 · 管理员只读").waitFor({ timeout: 60_000 });
    const body = (await page.locator("body").textContent()) ?? "";
    check("管理员：Review 显式只读且无写控件", body.includes("管理员只读") && (await page.locator("[data-testid=guide-association-section]").count()) === 0, "admin read-only", "real_http+real_db+browser");
    await page.goto(`${ctx.BASE}/observations/new`, { waitUntil: "domcontentloaded" });
    const gate = (await page.locator("body").textContent()) ?? "";
    check("管理员：录入页不渲染表单", gate.includes("管理员没有教学操作权限") && !gate.includes("观察原文"), "write gate", "real_http+browser");
    await context.close();
  }

  // 原班历史只读：转班幼儿的旧观察不挂载写客户端
  {
    const { context, page } = await newAccountContext(ctx, "g6history", HISTORY_PASSWORD, { width: 1280, height: 800 });
    await page.goto(`${ctx.BASE}${reviewUrl(HISTORY_OBSERVATION_ID)}`, { waitUntil: "domcontentloaded" });
    await page.getByText("原班历史观察 · 只读回看").waitFor({ timeout: 60_000 });
    check("原班历史只读：显式只读回看且无写控件", (await page.locator("[data-testid=guide-association-section]").count()) === 0, "historical read-only", "real_http+real_db+browser");
    await context.close();
  }
}

/* --------------------------------- 响应式与键盘 --------------------------------- */

async function runResponsiveChecks(ctx: TestContext): Promise<void> {
  const observationId = (globalThis as Record<string, unknown>).__mainObservationId as string;
  const { context, page } = await newAccountContext(ctx, "g6teacher", TEACHER_PASSWORD, { width: 1440, height: 900 });
  const viewports = [
    { width: 1440, height: 900, label: "1440x900" },
    { width: 768, height: 1024, label: "768x1024" },
    { width: 390, height: 844, label: "390x844" },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${ctx.BASE}${reviewUrl(observationId)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.locator("[data-testid=guide-association-disclosure]").waitFor({ timeout: 90_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${viewport.label}：无横向溢出`, overflow <= 1, `overflow=${overflow}px`, "real_http+browser");
    const disclosureBox = await page.locator("[data-testid=guide-association-disclosure]").boundingBox();
    check(`${viewport.label}：关联区段触控目标 ≥44px`, (disclosureBox?.height ?? 0) >= 44, `height=${disclosureBox?.height}`, "real_http+browser");
    await page.locator("[data-testid=guide-association-disclosure]").focus();
    const before = await page.locator("[data-testid=guide-association-disclosure]").getAttribute("aria-expanded");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const after = await page.locator("[data-testid=guide-association-disclosure]").getAttribute("aria-expanded");
    check(`${viewport.label}：键盘可操作（Enter 切换）`, before !== after, `${before} -> ${after}`, "real_http+browser");
    if (viewport.width === 390) {
      await page.screenshot({ path: path.join(SHOTS, "04-mobile-review.png"), fullPage: true });
    }
  }
  // 错误提示可感知：空引用直接提交出现 role=alert
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${ctx.BASE}${reviewUrl(observationId)}`, { waitUntil: "domcontentloaded" });
  await openAssociation(page);
  await page.locator('[data-testid="guide-manual-add"]').click();
  await page.locator('[data-testid="guide-item-search"]').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="guide-item-search"]').fill("双脚连续向前跳");
  await page.locator('[data-testid="guide-item-option"]').filter({ hasText: "双脚连续向前跳" }).first().click();
  await page.locator('[data-testid="decision-save"]').click();
  const role = await page.locator("[data-testid=decision-error]").getAttribute("role");
  check("错误提示可感知（role=alert）", role === "alert", String(role), "real_http+browser");
  await context.close();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "<redacted>"));
  process.exitCode = 1;
});
