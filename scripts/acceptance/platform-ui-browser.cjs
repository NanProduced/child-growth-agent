/* Two bounded passes: formal pages use owned AUTH/HTTP/PG; response and DOM doubles are labelled. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { Client } = require("pg");
const { createAcceptanceSeed } = require("../yaya/acceptance/seed");
const safety = require("../harness-safety");
const { chromium } = require(process.env.PLATFORM_UI_PLAYWRIGHT || path.join(os.tmpdir(), "g3-browser-deps/node_modules/playwright-core"));
const ROOT = process.cwd();
const PHASE = process.argv[2];
if (!["before", "after"].includes(PHASE)) throw new Error("Use before or after");
const OUT = path.join(ROOT, "docs/platform-review/ui-typeset", PHASE);
if (fs.existsSync(path.join(OUT, "results.json"))) throw new Error("Bounded pass already recorded; refuse another pass");
const widths = [1440, 1024, 768, 390];
const results = [], errors = [], checks = [], cleanupIssues = [];
const check = (name, ok, level = "real_auth_http_db_browser") => checks.push({ name, ok: Boolean(ok), level });

async function capture(page, name, level = "real_auth_http_db_browser") {
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate(() => {
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const openPanel = document.querySelector("[data-yaya-panel][data-state=open]");
    const controls = [...(openPanel || document.querySelector("main") || document).querySelectorAll("a,button,input,select,textarea,summary")].filter(visible);
    const hitBox = el => el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.contains(el) ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el);
    const small = controls.filter(el => { const r = hitBox(el).getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).map(el => ({ text: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.tagName).trim().slice(0, 65), w: Math.round(hitBox(el).getBoundingClientRect().width), h: Math.round(hitBox(el).getBoundingClientRect().height) }));
    const obscured = controls.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) return false;
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit && !el.contains(hit) && !hit.contains(el);
    }).map(el => (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 60));
    const types = [...document.querySelectorAll("h1,h2,main p,main label,[data-yaya-composer-input],[data-slot=input]")].filter(visible).slice(0, 80).map(el => { const s = getComputedStyle(el); return { tag: el.tagName, text: el.textContent.trim().slice(0, 45), size: s.fontSize, weight: s.fontWeight, leading: s.lineHeight, family: s.fontFamily, color: s.color }; });
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] / 255 + bg[i] * (1 - fg[3] / 255));
    const lum = rgb => rgb.map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((v, x, i) => v + x * [.2126, .7152, .0722][i], 0);
    const contrast = [...document.querySelectorAll("main p,main span,main strong,main h1,main h2,main label,[data-yaya-panel][data-state=open] p")].filter(el => visible(el) && [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())).map(el => {
      const ancestors = []; for (let node = el; node; node = node.parentElement) ancestors.unshift(node);
      let bg = [255, 255, 255]; for (const node of ancestors) bg = over(rgba(getComputedStyle(node).backgroundColor), bg);
      const s = getComputedStyle(el), fg = over(rgba(s.color), bg), a = lum(fg), b = lum(bg);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const large = parseFloat(s.fontSize) >= 24 || parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700;
      return { text: el.textContent.trim().slice(0, 50), ratio: Math.round(ratio * 100) / 100, threshold: large ? 3 : 4.5, class: String(el.className) };
    });
    return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1, small, obscured, types, contrast_failures: contrast.filter(x => x.ratio < x.threshold), title: document.title };
  });
  if (PHASE === "after" && /stress-|font-fallback/.test(name)) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "main h1" });
    if (nodeId) metrics.platform_fonts = (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
    await cdp.detach();
  }
  await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false, scale: "css" });
  results.push({ name, level, ...metrics });
  console.log("CAPTURE " + name + " overflow=" + metrics.overflow + " small=" + metrics.small.length);
}

async function markFixture(page) {
  await page.evaluate(() => { const note = document.createElement("p"); note.textContent = "响应替身：仅验证界面，不代表真实模型质量或已保存业务。"; note.style.cssText = "position:fixed;left:0;top:0;right:0;z-index:9999;margin:0;padding:4px;background:#fff3cd;color:#593c00;font:14px sans-serif;pointer-events:none"; document.body.append(note); });
}

async function chatFixtures(browser, base, credentials, accountId) {
  const original = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/yaya/__fixtures__/yaya-ui-fixtures.json"), "utf8"));
  const fixture = JSON.parse(JSON.stringify(original).replaceAll('"teacher-1"', JSON.stringify(accountId)));
  for (const width of [1440, 390]) {
    for (const [scenario, events, target] of [
      ["answer", fixture.answer_stream, "[data-yaya-message]"],
      ["proposal", fixture.proposal_stream, "[data-yaya-proposal]"],
      ["unknown", fixture.receipt_unknown_stream, '[data-yaya-card="receipt"]'],
    ]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      await context.request.post(base + "/api/auth/login", { headers: { origin: base, "x-cga-auth-request": "1" }, data: credentials });
      await context.route("**/api/yaya/**", route => {
        const request = route.request(), u = new URL(request.url()), p = u.pathname;
        const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        if (p === "/api/yaya/conversations") return json(request.method() === "POST" ? fixture.new_conversation : fixture.conversation_list, request.method() === "POST" ? 201 : 200);
        if (/\/runs$/.test(p)) return request.method() === "GET" ? json(fixture.run_lookup_in_progress) : route.fulfill({ status: 200, contentType: "application/x-ndjson; charset=utf-8", body: events.map(value => JSON.stringify(value)).join("\n") + "\n" });
        if (/\/messages$/.test(p)) return json(request.method() === "GET" ? { ...fixture.history, messages: [] } : { message: fixture.history.messages[0], conversation: fixture.history.conversation, replayed: false }, request.method() === "GET" ? 200 : 201);
        if (p === "/api/yaya/proposals") return json(fixture.proposal_projection);
        if (/\/conversations\/[^/]+$/.test(p)) return json({ conversation: fixture.history.conversation });
        return json({ error: "fixture_read_only", message: "响应替身仅用于排版，不执行真实写入。" }, 503);
      });
      const page = await context.newPage();
      await page.goto(base + "/assistant", { waitUntil: "networkidle" });
      try {
        await page.locator("[data-yaya-composer-input]").fill("[响应替身] 仅检查这张卡片的排版。");
        await page.getByRole("button", { name: /^发送(?:消息)?$/ }).click();
        await page.locator(target).last().waitFor({ timeout: 20000 });
        if (scenario === "answer") await page.getByText("为了覆盖长答展开", { exact: false }).first().waitFor({ timeout: 15000 });
        await markFixture(page);
        if (scenario !== "answer") await page.locator(target).filter({ visible: true }).first().scrollIntoViewIfNeeded();
        await capture(page, `chat-fixture-${scenario}-${width}`, "browser_response_fixture_no_model_no_business_write");
        check(`fixture ${scenario} renders ${width}`, true, "browser_response_fixture");
      } catch (error) {
        check(`fixture ${scenario} renders ${width}`, false, "browser_response_fixture");
        await markFixture(page);
        await capture(page, `chat-fixture-${scenario}-failure-${width}`, "browser_response_fixture_failed");
        errors.push({ fixture: scenario, width, error: error.message });
      } finally { await context.close(); }
    }
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const snapshot = safety.snapshotGeneratedArtifacts(ROOT);
  const guard = await safety.startModelRequestGuard();
  let seed, server, browser, db;
  try {
    seed = await createAcceptanceSeed();
    check("seed fact verification", seed.verification.failed === 0, "real_db");
    db = new Client({ connectionString: seed.database_url }); await db.connect();
    const rawBefore = await db.query("SELECT id,raw_text FROM observations ORDER BY id");
    const port = PHASE === "before" ? 24631 : 24632;
    const listeners = safety.findListeningPids(port);
    if (!listeners.ok || listeners.pids.length) throw new Error("Port occupied or unverifiable; no process was killed");
    const base = `http://127.0.0.1:${port}`;
    const logFile = path.join(OUT, "next.log");
    const proc = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: safety.modelGuardEnv(guard, { ...process.env, DATABASE_URL: seed.database_url, PGDATABASE_URL: "", AUTH_TRUSTED_ORIGINS: base, AUTH_SCHOOL_ID: seed.manifest.school_id, AUTH_COOKIE_SECURE: "false", MEDIA_ENVIRONMENT: "development", MEDIA_STORAGE_MODE: "local", MEDIA_LOCAL_ROOT: seed.object_root, NEXT_TELEMETRY_DISABLED: "1" }),
    });
    server = safety.trackChildProcess(proc, { logFile });
    proc.stdout.on("data", chunk => fs.appendFileSync(logFile, chunk));
    proc.stderr.on("data", chunk => fs.appendFileSync(logFile, chunk));
    await safety.waitForVerifiedService({ base, port, child: server, timeoutMs: 60000 });
    browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
    // Only this process's freshly generated synthetic credentials; never print or read .env.
    const credentials = JSON.parse(fs.readFileSync(seed.credentials_path, "utf8")).accounts;
    const m = seed.manifest;
    const routes = [
      ["home", "/"], ["classes", "/classes"], ["class", `/classes/${m.classes.class_a.id}`],
      ["class-evidence", `/classes/${m.classes.class_a.id}/evidence?age_band=3-4`],
      ["children", "/children"], ["child-new", "/children/new"], ["child", `/children/${m.children.class_a_same_name.id}`],
      ["child-evidence", `/children/${m.children.class_a_same_name.id}/evidence?age_band=3-4`],
      ["observations", "/observations"], ["observation-new", `/observations/new?child_id=${m.children.class_a_same_name.id}`],
      ["review", `/observations/${m.observations.b5_ai_organized.id}/review`],
      ["activities", "/activities"], ["reports", "/reports"], ["assistant", "/assistant"],
    ];
    for (const role of ["teacher_a", "admin", "teacher_c", "guest"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.route("**/*", route => { const u = new URL(route.request().url()); return u.origin === base || ["data:", "blob:"].includes(u.protocol) ? route.continue() : route.abort("blockedbyclient"); });
      if (role !== "guest") {
        const login = await context.request.post(base + "/api/auth/login", { headers: { origin: base, "x-cga-auth-request": "1" }, data: credentials[role] });
        check(role + " real login", login.status() === 200);
      }
      const page = await context.newPage();
      page.on("pageerror", err => errors.push({ role, error: err.message }));
      const chosen = role === "teacher_a" ? routes : role === "admin" ? [...routes.filter(([name]) => ["home", "classes", "children", "child", "child-evidence", "review", "assistant"].includes(name)), ["teachers", "/admin/teachers"]] : role === "guest" ? [["home", "/"], ["login", "/login"], ["children", "/children"], ["assistant", "/assistant"]] : [["home", "/"], ["classes", "/classes"], ["children", "/children"], ["assistant", "/assistant"]];
      for (const width of role === "teacher_a" ? widths : [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 });
        for (const [name, href] of chosen) {
          await page.goto(base + href, { waitUntil: "networkidle", timeout: 45000 });
          await capture(page, `${role}-${name}-${width}`);
          if (role === "teacher_a" && name === "class-evidence") {
            const trigger = page.locator(`[data-item-id="${m.guide_items.behavior_item_id}"] [data-testid=item-disclosure]`);
            if (await trigger.count()) { await trigger.click(); await page.locator("[data-current-item-id]").waitFor(); await capture(page, `${role}-class-inspector-${width}`); }
          }
          if (role === "teacher_a" && name === "home") {
            await page.locator("[data-yaya-entry]").click();
            await page.locator("[data-yaya-panel][data-state=open]").waitFor();
            await capture(page, `${role}-sidebar-${width}`);
            await page.keyboard.press("Escape");
            check(`sidebar Escape restores launcher focus ${width}`, await page.locator("[data-yaya-entry]").evaluate(el => el === document.activeElement));
          }
        }
      }
      if (role === "teacher_a") {
        // Fault fixtures are explicitly seeded; not invented successful business state.
        await page.setViewportSize({ width: 390, height: 844 });
        for (const key of ["fault_partial", "fault_unreadable", "class_a_trusted_empty"]) {
          await page.goto(`${base}/children/${m.children[key].id}/evidence?age_band=3-4`, { waitUntil: "networkidle" });
          await capture(page, "evidence-" + key, "real_auth_http_db_seeded_fault_or_empty");
        }
        // DOM stress is layout evidence only, never persisted child/observation truth.
        for (const [name, href] of routes.filter(([n]) => ["classes", "child", "child-evidence", "assistant"].includes(n))) {
          await page.setViewportSize({ width: 768, height: 900 });
          await page.goto(base + href, { waitUntil: "networkidle" });
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "200%";
            const h = document.querySelector("main h1"); if (h) h.textContent = "[排版替身] 龘靐齉成长观察册——连续多日探索与合作过程的完整观察证据";
            const p = document.querySelector("main p"); if (p) p.textContent = "[排版替身，非业务事实] " + "幼儿在搭建过程中邀请同伴一起尝试，并描述自己的发现。".repeat(6) + " 1 10 100";
          });
          await capture(page, `stress-${name}-200percent`, "browser_dom_text_scale_double");
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.route("**/assets/fonts/**", route => route.abort());
        await page.goto(base + "/", { waitUntil: "networkidle" });
        await page.evaluate(() => { for (const el of document.querySelectorAll("h1,h2,p,strong")) el.style.fontFamily = "'Microsoft YaHei', sans-serif"; });
        await capture(page, "font-fallback-390", "browser_font_fallback_double");
        await page.unroute("**/assets/fonts/**");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(base + "/children/new", { waitUntil: "networkidle" });
        await page.keyboard.press("Tab");
        check("keyboard focus visible", await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== "none" || s.boxShadow !== "none"; }));
        await capture(page, "keyboard-reduced-motion-390");
        if (PHASE === "after") {
          // Extra surfaces are inspected in this same final batch, never another rebuild cycle.
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await page.goto(base + "/children/new", { waitUntil: "networkidle" });
          await page.locator("#child-name").fill("[合成排版] 龘小芽");
          await page.locator("label[for='gender-女']").click();
          await page.locator("#birth-date").fill("2022-01-10");
          await page.getByRole("combobox", { name: "选择学段" }).click();
          await page.getByRole("option", { name: "小班", exact: true }).click();
          await page.getByRole("combobox", { name: "选择班级" }).click();
          await page.getByRole("option", { name: m.classes.class_a.name, exact: true }).click();
          await page.getByRole("button", { name: "下一步", exact: true }).click();
          await capture(page, "child-new-optional-390");
          await page.getByRole("button", { name: "下一步", exact: true }).click();
          await capture(page, "child-new-confirm-390");
          // No submit: layout review is not permission to change business workflow.
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await page.goto(base + "/classes", { waitUntil: "networkidle" });
            await page.evaluate(() => { document.body.style.zoom = "2"; });
            await capture(page, `classes-css-zoom200-${width}`, "browser_css_zoom_double");
          }
          for (const status of ["loading", 401, 403, 503, "empty"]) {
            await page.setViewportSize({ width: 390, height: 844 });
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            const handler = async route => {
              if (status === "loading") await gate;
              return route.fulfill({ status: typeof status === "number" ? status : 200, contentType: "application/json", body: JSON.stringify(status === "empty" || status === "loading" ? { classes: [] } : { error: "fixture", message: "响应替身：资料暂不可读取。" }) }).catch(() => {});
            };
            await page.route("**/api/classes", handler);
            await page.goto(base + "/children/new", { waitUntil: "domcontentloaded" });
            if (status === "loading") await page.getByText("班级加载中…", { exact: true }).waitFor();
            else await page.waitForLoadState("networkidle");
            await markFixture(page);
            await capture(page, `directory-${status}-390`, "browser_response_fixture");
            release(); await page.unroute("**/api/classes", handler);
          }
        }
      }
      if (role === "guest") check("anonymous API returns 401", (await context.request.get(base + "/api/children")).status() === 401);
      if (role === "teacher_c") check("unassigned API returns 403", (await context.request.get(base + "/api/children")).status() === 403);
      if (role === "admin" && PHASE === "after") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(base + "/classes", { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "新建班级", exact: true }).click();
        await capture(page, "class-dialog-390");
        await page.keyboard.press("Escape");
        await page.goto(base + "/admin/teachers", { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "添加教师", exact: true }).click();
        await capture(page, "teacher-create-390");
        await page.getByRole("button", { name: "收起新增表单", exact: true }).click();
        await page.getByRole("button", { name: /重置教师.*的密码/ }).first().click();
        await capture(page, "teacher-reset-dialog-390");
        await page.keyboard.press("Escape");
      }
      await context.close();
    }
    check("raw_text untouched", JSON.stringify(rawBefore.rows) === JSON.stringify((await db.query("SELECT id,raw_text FROM observations ORDER BY id")).rows), "real_db");
    check("provider guard attempts zero", guard.hits === 0, "egress_guard");
    if (PHASE === "after") {
      await chatFixtures(browser, base, credentials.teacher_a, m.accounts.teacher_a.account_id);
      const outage = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await outage.request.post(base + "/api/auth/login", { headers: { origin: base, "x-cga-auth-request": "1" }, data: credentials.teacher_a });
      const identity = safety.inspectOwnedContainer(seed.container_id, "yaya.qa-seed1");
      if (identity.state !== "verified" || identity.id !== seed.container_id || identity.label !== seed.seed_id) throw new Error("Own outage target identity mismatch");
      // Controlled fault in our disposable seed only; keep the PG process healthy.
      await db.query("ALTER TABLE app_sessions RENAME TO platform_ui_fault_sessions");
      check("owned DB identity-table fault yields real auth 503", (await outage.request.get(base + "/api/auth/status")).status() === 503, "real_auth_http_controlled_owned_db_fault");
      const page = await outage.newPage();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.goto(base + "/", { waitUntil: "networkidle" });
        await capture(page, `identity-unavailable-${width}`, "real_auth_http_controlled_owned_db_fault");
      }
      await outage.close();
    }
  } finally {
    await safety.runCleanupSteps([
      { label: "browser", run: () => browser?.close() },
      { label: "next-owned-tree", run: () => server && safety.stopTrackedChildTree(server) },
      { label: "database", run: () => db?.end() },
      { label: "seed", run: () => seed?.teardown() },
      { label: "guard", run: () => guard.close() },
      { label: "generated", run: () => { cleanupIssues.push(...safety.restoreGeneratedArtifacts(snapshot, ROOT).issues); } },
    ], (label, detail) => cleanupIssues.push(label + ": " + detail));
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ phase: PHASE, results, checks, errors, cleanup_issues: cleanupIssues, seed_id: seed?.seed_id, container_id: seed?.container_id, server: server && { pid: server.pid, startedAt: server.startedAt, stopped: server.stopped }, model_requests: 0, guard_attempts: guard.hits }, null, 2));
    safety.assertCleanupComplete(cleanupIssues);
    console.log(JSON.stringify({ phase: PHASE, captures: results.length, checks: checks.length, errors: errors.length, cleanup_issues: cleanupIssues.length }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
