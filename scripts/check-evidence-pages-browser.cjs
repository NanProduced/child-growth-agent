"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_child_process_1 = require("node:child_process");
const node_module_1 = require("node:module");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const pg_1 = require("pg");
const zod_1 = require("zod");
const seed_1 = require("./yaya/acceptance/seed");
const harness_safety_1 = require("./harness-safety");
const ROOT = process.cwd();
const RUN = "evidence-pages-" + (0, node_crypto_1.randomUUID)().slice(0, 8);
const OUT = node_path_1.default.join(ROOT, "output", "playwright", RUN);
const loadModule = (0, node_module_1.createRequire)(__filename);
const pwPath = process.env.PLAYWRIGHT_CORE_DIR;
if (!pwPath)
    throw new Error("Set PLAYWRIGHT_CORE_DIR to existing acceptance dependencies; no packages are installed.");
const { chromium } = loadModule(node_path_1.default.join(pwPath, "playwright-core"));
const credentialsSchema = zod_1.z.object({ accounts: zod_1.z.object({
        teacher_a: zod_1.z.object({ username: zod_1.z.string(), password: zod_1.z.string() }),
        teacher_b: zod_1.z.object({ username: zod_1.z.string(), password: zod_1.z.string() }),
        admin: zod_1.z.object({ username: zod_1.z.string(), password: zod_1.z.string() }),
    }) });
const results = [];
function check(name, value, level = "real_http+real_db+browser") {
    results.push({ name, level, ok: Boolean(value) });
    strict_1.default.ok(value, name);
    console.log("PASS " + name);
}
async function controlsAreUncovered(root) {
    return root.locator("button:visible, select:visible, input:visible, summary:visible").evaluateAll((elements) => elements.every((element) => {
        const box = element.getBoundingClientRect();
        if (box.top < 0 || box.bottom > innerHeight || box.width === 0) return true;
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit !== null && element.contains(hit);
    }));
}
async function main() {
    node_fs_1.default.mkdirSync(OUT, { recursive: true });
    const snapshot = (0, harness_safety_1.snapshotGeneratedArtifacts)(ROOT);
    const guard = await (0, harness_safety_1.startModelRequestGuard)();
    let seed = null;
    let tracked = null;
    let database = null;
    let browser = null;
    const cleanupIssues = [];
    const errors = [];
    const expectedConsoleFailures = [];
    const network = [];
    let completed = false;
    let primaryFailure = null;
    try {
        seed = await (0, seed_1.createAcceptanceSeed)();
        check("owned acceptance seed fact verification", seed.verification.failed === 0, "real_db");
        database = new pg_1.Client({ connectionString: seed.database_url });
        await database.connect();
        const rawBefore = await database.query("SELECT id, raw_text FROM observations ORDER BY id");
        let port = 0;
        for (let offset = 0; offset < 40; offset++) {
            const candidate = 22500 + Math.floor(Math.random() * 4000);
            const listeners = (0, harness_safety_1.findListeningPids)(candidate);
            if (!listeners.ok)
                throw new Error(listeners.detail);
            if (listeners.pids.length === 0) {
                port = candidate;
                break;
            }
        }
        (0, strict_1.default)(port);
        const base = `http://127.0.0.1:${port}`;
        const logFile = node_path_1.default.join(OUT, "next.log");
        const mode = process.env.EVIDENCE_SERVER_MODE === "dev" ? ["dev", "--webpack"] : ["start"];
        const server = (0, node_child_process_1.spawn)(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "next", ...mode, "--hostname", "127.0.0.1", "--port", String(port)], {
            cwd: ROOT, shell: process.platform === "win32", windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"], env: (0, harness_safety_1.modelGuardEnv)(guard, {
                ...process.env, DATABASE_URL: seed.database_url, PGDATABASE_URL: "",
                AUTH_TRUSTED_ORIGINS: base, AUTH_SCHOOL_ID: seed.manifest.school_id,
                AUTH_COOKIE_SECURE: "false", MEDIA_ENVIRONMENT: "development", MEDIA_STORAGE_MODE: "local",
                MEDIA_LOCAL_ROOT: seed.object_root, NEXT_TELEMETRY_DISABLED: "1",
            }),
        });
        tracked = (0, harness_safety_1.trackChildProcess)(server, { logFile });
        server.stdout?.on("data", (chunk) => node_fs_1.default.appendFileSync(logFile, chunk));
        server.stderr?.on("data", (chunk) => node_fs_1.default.appendFileSync(logFile, chunk));
        await (0, harness_safety_1.waitForVerifiedService)({ base, port, child: tracked, timeoutMs: 180000 });
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
        const creds = credentialsSchema.parse(JSON.parse(node_fs_1.default.readFileSync(seed.credentials_path, "utf8"))).accounts;
        const klass = seed.manifest.classes.class_a;
        const child = seed.manifest.children.class_a_same_name;
        const itemId = seed.manifest.guide_items.behavior_item_id;
        const classPath = `/classes/${klass.id}/evidence?age_band=3-4`;
        const childPath = `/children/${child.id}/evidence?age_band=3-4`;
        for (const viewport of [
            { width: 1440, height: 900 }, { width: 1440, height: 1024 },
            { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 },
        ]) {
            const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
            await context.addInitScript(() => {
                window.__evidenceScriptErrors = [];
                window.addEventListener("error", (event) => window.__evidenceScriptErrors.push({ message: event.message, filename: event.filename, line: event.lineno, column: event.colno }));
            });
            const login = await context.request.post(base + "/api/auth/login", {
                headers: { origin: base, "x-cga-auth-request": "1", "content-type": "application/json" },
                data: creds.teacher_a,
            });
            check(`teacher login ${viewport.width}x${viewport.height}`, login.status() === 200);
            const page = await context.newPage();
            let faultInjectionActive = false;
            page.on("pageerror", (error) => errors.push(error.stack || error.message || String(error)));
            page.on("requestfailed", (request) => network.push({ method: request.method(), path: new URL(request.url()).pathname, failure: request.failure()?.errorText }));
            page.on("console", (message) => {
                if (message.type() !== "error") return;
                const text = message.text();
                const location = message.location();
                const controlledResourceFailure = /^Failed to load resource:.*status of (403|503) /.test(text) &&
                    location.url.startsWith(base + "/api/children/") && location.url.includes("/evidence-book?") && faultInjectionActive;
                (controlledResourceFailure ? expectedConsoleFailures : errors).push("console: " + text + " " + JSON.stringify(location));
            });
            page.on("response", (response) => { if (response.url().startsWith(base + "/api/"))
                network.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() }); });
            const overviewResponse = await context.request.get(base + `/api/classes/${klass.id}/evidence-overview?age_band=3-4`);
            check("formal class GET authorized", overviewResponse.status() === 200);
            const overview = await overviewResponse.json();
            check("real roster denominator 3, not design 20", overview.roster.child_count === 3);
            await page.goto(base + classPath, { waitUntil: "domcontentloaded" });
            const root = page.locator("[data-testid=class-evidence-overview]");
            await root.waitFor();
            await page.locator("[data-testid=class-evidence-overview][data-client-ready=true]").waitFor({ timeout: 60000 }).catch(async (error) => {
                await page.screenshot({ path: node_path_1.default.join(OUT, "class-client-failure.png"), scale: "css" });
                node_fs_1.default.writeFileSync(node_path_1.default.join(OUT, "class-client-failure.json"), JSON.stringify({ errors, scriptErrors: await page.evaluate(() => window.__evidenceScriptErrors), text: await page.locator("body").innerText() }, null, 2));
                throw error;
            });
            check(`class overflow ${viewport.width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            check("production component no hard-coded demo badge", !(await root.innerText()).includes("设计示例 · 合成数据"));
            check(`assistant return-toolbar dock never covers navigation ${viewport.width}`, await page.evaluate(() => {
                const entry = document.querySelector("[data-yaya-entry]")?.getBoundingClientRect();
                if (!entry) return false;
                return [...document.querySelectorAll("header nav a, header nav button")].every((node) => {
                    const r = node.getBoundingClientRect();
                    return r.right <= entry.left || r.left >= entry.right || r.bottom <= entry.top || r.top >= entry.bottom;
                });
            }));
            check("health reference is a separate collapsed entry", await root.locator("[data-testid=reference-library]").getAttribute("open") === null);
            if (viewport.width === 1440 && viewport.height === 900) {
                await root.locator("[data-testid=stats-help-button]").click();
                const help = root.locator("[data-testid=stats-help-content]");
                check("statistics help is inline and uses teacher language", await page.getByRole("dialog").count() === 0 && !/\b(reliable|partial|unavailable)\b/.test(await help.innerText()));
                await page.screenshot({ path: node_path_1.default.join(OUT, "class-help.png"), fullPage: true, scale: "css" });
                await root.locator("[data-testid=stats-help-button]").click();
            }
            await page.screenshot({ path: node_path_1.default.join(OUT, `class-${viewport.width}x${viewport.height}.png`), scale: "css" });
            const trigger = root.locator(`[data-item-id="${itemId}"] [data-testid=item-disclosure]`);
            await trigger.click();
            const panel = root.locator(`[data-current-item-id="${itemId}"]`);
            await panel.waitFor({ state: "visible" });
            check("single inspector", await root.locator("[data-current-item-id]").count() === 1);
            await panel.locator(`[data-child-id="${child.id}"] [data-testid=select-child-record]`).click();
            const quote = panel.locator("blockquote");
            await quote.waitFor({ state: "visible", timeout: 60000 });
            const bookResponse = await context.request.get(base + `/api/children/${child.id}/evidence-book?age_band=3-4`);
            const book = await bookResponse.json();
            const sourceQuotes = book.goals.flatMap((goal) => goal.items).filter((item) => item.item.id === itemId)
                .flatMap((item) => item.links).filter((link) => link.counts_toward_status).flatMap((link) => link.basis).filter((source) => source.valid).map((source) => source.quote);
            check("inspector quote matches formal authorized GET", sourceQuotes.includes(await quote.innerText()));
            check(`class controls not covered by assistant ${viewport.width}`, await controlsAreUncovered(panel));
            const contrast = await panel.locator('[data-testid=child-status-badge]').filter({ hasText: "暂无相关记录" }).first().evaluate((element) => {
                const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
                const ctx = canvas.getContext("2d");
                const luminance = (color) => {
                    ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
                    const pixels = ctx.getImageData(0, 0, 1, 1).data;
                    const channels = [pixels[0], pixels[1], pixels[2]].map((value) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
                    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
                };
                const style = getComputedStyle(element); const a = luminance(style.color); const b = luminance(style.backgroundColor);
                return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            });
            check(`no-record status contrast at least4.5 ${viewport.width}`, contrast >= 4.5);
            await page.screenshot({ path: node_path_1.default.join(OUT, `class-detail-${viewport.width}x${viewport.height}.png`), scale: "css" });
            if ((viewport.width === 1440 && viewport.height === 900) || viewport.width === 390) {
                const savedQuote = await quote.textContent();
                await quote.evaluate((element) => { element.textContent = "[排版测试，非业务记录] https://example.invalid/" + "a".repeat(220); });
                check(`long token quote wraps without overflow ${viewport.width}`, await quote.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "browser_dom_layout_double");
                await page.screenshot({ path: node_path_1.default.join(OUT, `class-long-token-${viewport.width}.png`), scale: "css" });
                await quote.evaluate((element, text) => { element.textContent = text; }, savedQuote);
            }
            await panel.getByRole("button", { name: "返回指南条目", exact: true }).click();
            check("close returns keyboard focus to original item", await trigger.evaluate((element) => document.activeElement === element));
            if (viewport.width === 1440 && viewport.height === 900) {
                await trigger.click();
                const other = root.locator(`[data-item-id="${seed.manifest.guide_items.sustained_item_id}"] [data-testid=item-disclosure]`);
                await other.click();
                check("selecting another item leaves one inspector", await root.locator("[data-current-item-id]").count() === 1);
                await root.locator("[data-current-item-id]").getByRole("button", { name: "返回指南条目", exact: true }).click();
                faultInjectionActive = true;
                for (const fault of ["wrong-child", "bad-shape", "forbidden", "unavailable"]) {
                    const handler = async (route) => {
                        const body = fault === "wrong-child" ? { ...book, child: { ...book.child, id: "wrong-child" } } : {};
                        await route.fulfill({ status: fault === "forbidden" ? 403 : fault === "unavailable" ? 503 : 200,
                            contentType: "application/json", body: JSON.stringify(body) });
                    };
                    await page.route("**/api/children/*/evidence-book?*", handler);
                    await trigger.click();
                    const text = fault === "forbidden" ? "当前账号不能读取这些记录。" : fault === "unavailable" ? "暂时读不到引用，请重新读取。" : "数据或所属范围已变化，请重新读取页面。";
                    await panel.getByText(text, { exact: true }).waitFor();
                    check(`source failure ${fault} never becomes a fabricated quote`, await panel.locator("blockquote").count() === 0, "real_browser+response_double");
                    await panel.getByRole("button", { name: "返回指南条目", exact: true }).click();
                    await page.unroute("**/api/children/*/evidence-book?*", handler);
                }
                faultInjectionActive = false;
                let releaseOld;
                let oldRequested;
                const oldGate = new Promise((resolve) => { releaseOld = resolve; });
                const requested = new Promise((resolve) => { oldRequested = resolve; });
                let firstRead = true;
                const heldHandler = async (route) => {
                    if (!firstRead) { await route.continue(); return; }
                    firstRead = false;
                    oldRequested();
                    await oldGate;
                    // The cancelled request may already be disposed by the browser.
                    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(book) }).catch(() => {});
                };
                await page.route("**/api/children/*/evidence-book?*", heldHandler);
                await trigger.click();
                await requested;
                const nextItemId = seed.manifest.guide_items.sustained_item_id;
                await root.locator(`[data-item-id="${nextItemId}"] [data-testid=item-disclosure]`).click();
                const nextPanel = root.locator(`[data-current-item-id="${nextItemId}"]`);
                await nextPanel.locator("blockquote").waitFor();
                const currentQuote = await nextPanel.locator("blockquote").innerText();
                releaseOld();
                await page.unroute("**/api/children/*/evidence-book?*", heldHandler);
                check("cancelled old source cannot replace the new item's quote", await nextPanel.locator("blockquote").innerText() === currentQuote && await root.locator("[data-current-item-id]").count() === 1, "real_browser+controlled_response_delay");
                await nextPanel.getByRole("button", { name: "返回指南条目", exact: true }).click();
            }
            await page.goto(base + childPath, { waitUntil: "domcontentloaded" });
            const childRoot = page.locator("[data-testid=child-evidence-book]");
            await childRoot.waitFor();
            await page.locator("[data-testid=child-evidence-book][data-client-ready=true]").waitFor({ timeout: 30000 }).catch(async (error) => {
                await page.screenshot({ path: node_path_1.default.join(OUT, "child-client-failure.png"), scale: "css" });
                node_fs_1.default.writeFileSync(node_path_1.default.join(OUT, "child-client-failure.json"), JSON.stringify({ errors, text: await page.locator("body").innerText(), scripts: await page.locator("script[src]").evaluateAll((elements) => elements.map((element) => element.getAttribute("src"))) }, null, 2));
                throw error;
            });
            check(`child overflow ${viewport.width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            check("child title is named friendly observation evidence", await childRoot.getByRole("heading", { name: child.name + "的观察证据", exact: true }).count() === 1);
            const childItem = childRoot.locator(`[data-item-id="${itemId}"]`);
            if (await childItem.locator("[data-testid=item-disclosure]").getAttribute("aria-expanded") !== "true")
                await childItem.locator("[data-testid=item-disclosure]").click();
            await childItem.locator("blockquote").first().waitFor({ state: "visible", timeout: 15000 }).catch(async (error) => {
                await page.screenshot({ path: node_path_1.default.join(OUT, "child-quote-failure.png"), scale: "css" });
                node_fs_1.default.writeFileSync(node_path_1.default.join(OUT, "child-quote-failure.json"), JSON.stringify({ expected: sourceQuotes, actual: await childItem.locator("blockquote").allTextContents(), expanded: await childItem.locator("[data-testid=item-disclosure]").getAttribute("aria-expanded"), text: await childItem.innerText() }, null, 2));
                throw error;
            });
            check("child renders exact stored observation quote", (await childItem.locator("blockquote").allTextContents()).some((value) => sourceQuotes.includes(value)));
            await page.evaluate(() => window.scrollTo(0, 0));
            if (viewport.width === 390) check("mobile first viewport includes a complete item and status", await childRoot.locator("[data-testid=evidence-item]").first().evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight && element.querySelector("[data-testid=item-top]") !== null));
            check(`child controls not covered by assistant ${viewport.width}`, await controlsAreUncovered(childRoot));
            await page.screenshot({ path: node_path_1.default.join(OUT, `child-${viewport.width}x${viewport.height}.png`), scale: "css" });
            if (viewport.width === 390) await page.screenshot({ path: node_path_1.default.join(OUT, "child-mobile-full.png"), fullPage: true, scale: "css" });
            const smallControls = await childRoot.locator("button:visible, select:visible, input:visible").evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().height < 43.5).map((element) => element.getAttribute("data-testid")));
            check(`child targets at least 44px ${viewport.width}`, smallControls.length === 0);
            await context.close();
        }
        const admin = await browser.newContext();
        const adminLogin = await admin.request.post(base + "/api/auth/login", { headers: { origin: base, "x-cga-auth-request": "1" }, data: creds.admin });
        check("admin real login", adminLogin.status() === 200);
        const adminPage = await admin.newPage();
        await adminPage.goto(base + childPath, { waitUntil: "domcontentloaded" });
        await adminPage.locator("[data-testid=child-evidence-book]").waitFor();
        check("admin child evidence has no record-writing button", await adminPage.locator("[data-testid=record-observation]").count() === 0);
        await adminPage.goto(base + classPath, { waitUntil: "domcontentloaded" });
        await adminPage.locator(`[data-item-id="${itemId}"] [data-testid=item-disclosure]`).click();
        check("admin class inspector has no teaching write buttons", await adminPage.locator("[data-testid=record-observation], [data-testid=open-activity-support]").count() === 0);
        await admin.close();
        const otherTeacher = await browser.newContext();
        await otherTeacher.request.post(base + "/api/auth/login", { headers: { origin: base, "x-cga-auth-request": "1" }, data: creds.teacher_b });
        check("other class teacher cannot read child book", (await otherTeacher.request.get(base + `/api/children/${child.id}/evidence-book`)).status() === 403);
        await otherTeacher.close();
        const rawAfter = await database.query("SELECT id, raw_text FROM observations ORDER BY id");
        check("read-only review leaves raw text byte-exact", JSON.stringify(rawAfter.rows) === JSON.stringify(rawBefore.rows), "real_db");
        check("browser runtime errors zero", errors.length === 0);
        check("model guard zero attempts", guard.hits === 0, "egress_guard");
        completed = true;
    }
    catch (error) {
        primaryFailure = error instanceof Error ? error.message : String(error);
        throw error;
    }
    finally {
        await (0, harness_safety_1.runCleanupSteps)([
            { label: "browser", run: async () => { await browser?.close(); } },
            { label: "next-tree", run: async () => { if (tracked)
                    return (0, harness_safety_1.stopTrackedChildTree)(tracked); } },
            { label: "database-client", run: async () => { await database?.end(); } },
            { label: "seed", run: async () => { await seed?.teardown(); } },
            { label: "model-guard", run: () => guard.close() },
            { label: "generated-artifacts", run: () => {
                    const restored = (0, harness_safety_1.restoreGeneratedArtifacts)(snapshot, ROOT);
                    cleanupIssues.push(...restored.issues);
                } },
        ], (label, detail) => cleanupIssues.push(`${label}: ${detail}`));
        node_fs_1.default.writeFileSync(node_path_1.default.join(OUT, "results.json"), JSON.stringify({ run: RUN, completed, primary_failure: primaryFailure, results, errors, expected_console_failures: expectedConsoleFailures, network, model_requests: 0, guard_attempts: guard.hits, cleanup_issues: cleanupIssues }, null, 2));
        (0, harness_safety_1.assertCleanupComplete)(cleanupIssues);
        console.log(JSON.stringify({ status: completed ? "PASS" : "FAIL", passed: results.filter((result) => result.ok).length, total: results.length, cleanup: "verified", model_requests: 0, out: OUT }));
    }
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : "Evidence review failed"); process.exitCode = 1; });
