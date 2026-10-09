/* PLATFORM-UX-FIX1. One production browser check; stdin credentials stay in memory. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const settings = JSON.parse(input);
  input = "";
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.base), "Only the owned loopback service is allowed");
  assert(path.isAbsolute(settings.out) && path.isAbsolute(settings.playwright), "Absolute evidence/dependency paths required");
  assert(settings.manifest.seed_id && settings.run && settings.credentials.teacher_a && settings.credentials.admin, "Owned seed manifest required");
  const { chromium } = require(path.join(settings.playwright, "playwright-core"));
  const results = [], coverage = [], network = [], layout = [], faults = [], advisories = [], initializations = [];
  let scope = "preflight", browser, completed = false;
  const check = (name, ok, detail) => {
    results.push({ scope, name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
    assert.ok(ok, name);
  };
  const m = settings.manifest, klass = m.classes.class_a, child = m.children.class_a_same_name;
  const classPath = `/classes/${klass.id}/evidence`;
  const roles = settings.protocol_recheck ? ["teacher", "admin"] : ["teacher", "admin", "guest"];
  const routes = (settings.copy_review ? [
    ["children", "/children"], ["child-new", "/children/new"], ["observation-new", "/observations/new"],
    ["review", `/observations/${m.observations.a1_h1.id}/review`], ["child-detail", `/children/${child.id}`],
    ["activities", "/activities"], ["reports", `/reports?child=${child.id}`], ["family-entry", "/family-communication"],
    ["teachers", "/admin/teachers"],
  ] : [
    ["home", "/"], ["classes", "/classes"], ["class-detail", `/classes/${klass.id}`],
    ["class-evidence", classPath], ["children", "/children"], ["child-detail", `/children/${child.id}`],
    ["child-evidence", `/children/${child.id}/evidence`], ["observations", "/observations"],
    ["activities", "/activities"], ["reports", `/reports?child=${child.id}`],
    ["family-entry", "/family-communication"], ["teachers", "/admin/teachers"],
  ]).filter(([name]) => !settings.protocol_recheck || name === "class-evidence" || name === "teachers");
  const copyPages = (role, name) => !settings.copy_review || (role === "teacher"
    ? name !== "teachers" : role === "admin" ? ["family-entry", "teachers", "child-new"].includes(name) : ["children", "observation-new"].includes(name));
  for (const role of roles) for (const [width, height] of [[1440, 900], [1024, 900], [768, 1024], [390, 844]]) {
    for (const [name] of routes.filter(([name]) => copyPages(role, name))) coverage.push({ role, width, height, page: name, status: "NOT_RUN", checks: 0,
      expected_outcome: role === "guest" && name !== "home" ? "login_required" : role === "teacher" && name === "teachers" ? "forbidden_role" : "authorized" });
  }
  const rootSelector = '[data-testid="class-evidence-overview"][data-client-ready="true"]';
  const goalsSelector = 'details[data-goal-id]';
  const controlSelector = 'button:not(:disabled), a[href], select:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), summary';
  async function settle(page) {
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function capture(page, name) {
    if (settings.protocol_recheck) return;
    // Viewport screenshots avoid multi-megabyte full catalog captures. No login-form capture.
    await page.screenshot({ path: path.join(settings.out, `${name}.png`), animations: "disabled", scale: "css" });
  }
  async function geometry(page) {
    check("no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const measurements = await page.locator(`main ${controlSelector.split(", ").join(", main ")}`).evaluateAll((nodes) => {
      const visible = (node) => node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && node.getClientRects().length > 0;
      return nodes.filter(visible).map((node, index) => {
        const label = node.id && document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
        const target = (["checkbox", "radio"].includes(node.getAttribute("role")) || ["checkbox", "radio"].includes(node.type)) && label ? label : node;
        const box = target.getBoundingClientRect();
        const style = getComputedStyle(node);
        const core = node.tagName !== "A" || node.getAttribute("data-slot") === "button" || node.getAttribute("role") === "button" || Boolean(node.closest("nav[aria-label]")) || ["flex", "grid", "block"].includes(style.display);
        return { index, tag: node.tagName, id: node.getAttribute("data-testid") || node.id || null, height: box.height, width: box.width, core };
      });
    });
    const core = measurements.filter((row) => row.core);
    check("visible core actions measured (folded descendants excluded)", core.length > 0);
    check("visible core controls at least 44px", core.every((row) => row.height >= 43.5 && row.width >= 43.5), {
      tested: core.length, undersized: core.filter((row) => row.height < 43.5 || row.width < 43.5),
    });
    const smallInline = measurements.filter((row) => !row.core && (row.height < 43.5 || row.width < 43.5));
    if (smallInline.length) advisories.push({ scope, kind: "existing_small_inline_links_not_a_new_FIX1_P1", measurements: smallInline });
  }
  async function hitSamples(page, width) {
    let tested = 0;
    for (const [position, fraction] of [["top", 0], ["middle", 0.5], ["bottom", 1]]) {
      await page.evaluate((value) => window.scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * value, behavior: "instant" }), fraction);
      await settle(page);
      const sample = await page.locator(`main ${controlSelector.split(", ").join(", main ")}`).evaluateAll((nodes) => {
        const hits = [];
        const headerBottom = Math.max(0, ...[...document.querySelectorAll("[data-yaya-app-shell] > div > header")].map((node) => node.getBoundingClientRect().bottom));
        nodes.forEach((node, index) => {
          const r = node.getBoundingClientRect(), s = getComputedStyle(node);
          if (!node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) || !node.getClientRects().length || !r.width || !r.height || s.visibility === "hidden" || s.display === "none") return;
          // Only a control whose center is in the visible main viewport is a center hit sample.
          if (r.left < 0 || r.right > innerWidth || r.top <= headerBottom || r.bottom >= document.documentElement.clientHeight) return;
          const x = r.x + r.width / 2;
          const y = r.y + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          const label = node.id && document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
          const hitLabel = label && hit && label.contains(hit);
          hits.push({ index, tag: node.tagName, id: node.getAttribute("data-testid") || node.id || null,
            ok: Boolean(hit && (node.contains(hit) || hitLabel)), blocked_by_launcher: Boolean(hit?.closest("[data-yaya-entry]")),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height }, hit_tag: hit?.tagName ?? null,
            hit_slot: hit?.closest("[data-slot]")?.getAttribute("data-slot") ?? null });
        });
        return { scroll_y: scrollY, hits };
      });
      // A viewport with prose only is reported as untested, not counted as a passed hit test.
      if (sample.hits.length) check(`${position} controls hit their own element`, sample.hits.every((hit) => hit.ok), sample);
      tested += sample.hits.length;
      layout.push({ scope, position, ...sample, coverage: sample.hits.length ? "tested" : "no_controls_in_viewport" });
      const overlap = await page.locator(`main ${controlSelector.split(", ").join(", main ")}`).evaluateAll((nodes) => {
        const launcher = document.querySelector("[data-yaya-entry]");
        if (!launcher) return { found: false, tested: 0, overlaps: [] };
        const a = launcher.getBoundingClientRect();
        const visible = nodes.filter((node) => node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && node.getClientRects().length > 0);
        return { found: true, tested: visible.length, overlaps: visible.flatMap((node, index) => {
          const b = node.getBoundingClientRect();
          return !b.width || !b.height || b.bottom <= 0 || b.top >= innerHeight || b.right <= a.left || b.left >= a.right || b.bottom <= a.top || b.top >= a.bottom ? [] : [{ index, tag: node.tagName, id: node.getAttribute("data-testid") || node.id || null }];
        }) };
      });
      check(`${position} launcher exists for overlap measurement`, overlap.found);
      layout.push({ scope, position, evidence: "rectangular_overlap", compact: width <= 1090, ...overlap });
      if (width <= 1090) check(`${position} compact launcher does not overlap main controls`, overlap.overlaps.length === 0, overlap);
      // Wide-screen floating overlaps are recorded; only center-hit obstruction is a failure.
    }
    check("at least one real center hit sample on this page", tested > 0, { tested });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await settle(page);
  }
  async function launcher(page, width, role) {
    const entry = page.locator("[data-yaya-entry]:visible");
    await entry.waitFor();
    await page.waitForFunction(() => { const entry = document.querySelector("[data-yaya-entry]"); return entry && !entry.disabled; });
    check("one visible launcher", await entry.count() === 1);
    const box = await entry.boundingBox();
    check("launcher at least 44px", box && box.width >= 43.5 && box.height >= 43.5);
    check("header navigation targets remain at least 44px and not covered", await page.locator("[data-yaya-app-shell] > div > header a:visible, [data-yaya-app-shell] > div > header button:visible").evaluateAll((nodes) => {
      const entry = document.querySelector("[data-yaya-entry]")?.getBoundingClientRect();
      const visible = nodes.filter((node) => node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
      return visible.length > 0 && visible.every((node) => {
        const r = node.getBoundingClientRect();
        return r.width >= 43.5 && r.height >= 43.5 && (node.hasAttribute("data-yaya-entry") || !entry || r.right <= entry.left || r.left >= entry.right || r.bottom <= entry.top || r.top >= entry.bottom);
      });
    }));
    check(width <= 1090 ? "compact launcher in header normal flow" : "desktop launcher kept floating", await entry.evaluate((element, compact) => {
      let fixed = false;
      for (let node = element; node; node = node.parentElement) fixed ||= getComputedStyle(node).position === "fixed";
      return compact ? Boolean(element.closest("header")) && !fixed : fixed;
    }, width <= 1090));
    await entry.click(); // Normal pointer action, never force.
    const panel = page.locator("[data-yaya-panel]:visible");
    await panel.waitFor();
    check("panel opens once without duplicate launcher", await panel.count() === 1 && await page.locator("[data-yaya-entry]:visible").count() === 0);
    check("panel does not create horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (role === "guest") check("guest has login gate, not model composer", await page.locator("[data-yaya-auth-gate]:visible").count() === 1 && await panel.locator("textarea:visible").count() === 0);
    if (await panel.getAttribute("aria-modal") !== "true") {
      const heading = page.locator("main h1:visible, main h2:visible").first();
      await heading.evaluate((node) => { node.dataset.uxTrustedClick = "false"; node.addEventListener("click", (event) => { node.dataset.uxTrustedClick = String(event.isTrusted); }, { once: true }); });
      await heading.click();
      check("nonmodal panel leaves main page pointer-operable", await heading.getAttribute("data-ux-trusted-click") === "true");
      await heading.evaluate((node) => { delete node.dataset.uxTrustedClick; });
    }
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "yaya-entry-button");
    check("Escape restores launcher focus", true);
    await page.locator("[data-yaya-entry]:visible").click();
    await page.locator("[data-yaya-panel]:visible [data-yaya-close]").click();
    await page.locator("[data-yaya-panel]:visible").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "yaya-entry-button");
    check("normal close button restores launcher focus", true);
  }
  async function currentOverview(context, page) {
    const url = new URL(page.url());
    const response = await context.request.get(`${settings.base}/api/classes/${klass.id}/evidence-overview${url.search}`);
    check("formal class GET authorized", response.status() === 200);
    return response.json();
  }
  async function verifyStats(root, dto) {
    const items = dto.goals.flatMap((goal) => goal.items);
    const actual = await root.locator("[data-testid=class-evidence-item]").evaluateAll((nodes) => nodes.map((node) => ({
      id: node.dataset.itemId, reliability: node.dataset.reliability, ratio: node.dataset.ratio,
      counts: Object.fromEntries([...node.querySelectorAll("[data-testid=item-distribution] [data-status]")]
        .map((entry) => [entry.dataset.status, Number(entry.querySelector("strong")?.textContent)])),
      behavioral_distribution: node.querySelector("[data-testid=item-distribution], [data-testid=item-ratio]") !== null,
    })));
    check("all formal items remain in DOM including folded/cross-age entries",
      JSON.stringify(actual.map((row) => row.id).sort()) === JSON.stringify(items.map((row) => row.item.id).sort()));
    const byId = new Map(actual.map((row) => [row.id, row]));
    const mismatches = [];
    for (const row of items) {
      const rendered = byId.get(row.item.id);
      if (!rendered || rendered.reliability !== row.reliability || rendered.ratio !== (row.confirmed_ratio === null ? "null" : String(row.confirmed_ratio))) mismatches.push(row.item.id);
      if (row.item.product_rules.counts_in_behavior_stats && row.reliability === "reliable" && row.total > 0) {
        for (const status of ["confirmed_observed", "has_clues", "no_records"]) if (rendered?.counts[status] !== row.counts[status]) mismatches.push(`${row.item.id}/${status}`);
      }
      if (!row.item.product_rules.counts_in_behavior_stats && rendered?.behavioral_distribution) mismatches.push(`${row.item.id}/reference_not_behavior`);
    }
    check("all item statistics match formal GET", mismatches.length === 0, { tested: items.length, mismatches });
  }
  async function classChecks(context, page, width, role) {
    const root = page.locator(rootSelector);
    await root.waitFor();
    const baseline = await currentOverview(context, page);
    const goals = root.locator(goalsSelector);
    const saved = await goals.evaluateAll((nodes) => nodes.map((node) => ({ id: node.dataset.goalId, open: node.open })));
    check("goal-level native disclosures present", saved.length > 1);
    check("first goal open, other goals closed by default", saved[0].open && saved.slice(1).every((row) => !row.open));
    check("each goal has a 44px summary", await goals.locator("summary[data-testid=goal-disclosure]").count() === saved.length &&
      await goals.locator("summary[data-testid=goal-disclosure]").evaluateAll((nodes) => nodes.every((node) => node.getBoundingClientRect().height >= 43.5)));
    const reference = root.locator("[data-testid=reference-library]");
    check("health references remain a separate collapsed library", await reference.count() === 1 && await reference.getAttribute("open") === null);
    await verifyStats(root, baseline);
    await capture(page, `${role}-class-default-${width}`);
    const defaultHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    // Layout-only comparison on the exact same DOM/DTO. No request, filter or DB mutation.
    await goals.evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
    await settle(page);
    const expandedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const reduction = 1 - defaultHeight / expandedHeight;
    layout.push({ scope, evidence: "DOM-only_same_page_layout_comparison", default_height: defaultHeight, all_goals_height: expandedHeight, reduction });
    try {
      check("default document at least 60 percent shorter than all goals open", reduction >= 0.6, { defaultHeight, expandedHeight, reduction });
      check("folding does not alter formal GET facts", JSON.stringify(await currentOverview(context, page)) === JSON.stringify(baseline));
      await verifyStats(root, baseline);
    } finally {
      await goals.evaluateAll((nodes, states) => nodes.forEach((node, index) => { node.open = states[index].open; }), saved);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await settle(page);
    }
    const last = goals.last(), lastSummary = last.locator("summary[data-testid=goal-disclosure]");
    await lastSummary.focus();
    await page.keyboard.press("Enter");
    check("deep goal reachable and opens with Enter", await last.getAttribute("open") !== null);
    await page.keyboard.press("Enter");
    check("deep goal closes with Enter", await last.getAttribute("open") === null);
    const target = root.locator(`[data-item-id="${m.guide_items.behavior_item_id}"]`);
    const targetGoal = target.locator("xpath=ancestor::details[@data-goal-id][1]");
    if (await targetGoal.getAttribute("open") === null) {
      await targetGoal.locator("summary[data-testid=goal-disclosure]").click();
    }
    const trigger = target.locator("[data-testid=item-disclosure]");
    await trigger.click();
    const panel = root.locator(`[data-current-item-id="${m.guide_items.behavior_item_id}"]`);
    await panel.waitFor();
    check("item roster preserves formal child entries", await panel.locator(`[data-child-id="${child.id}"]`).count() > 0);
    if (role === "admin") check("admin inspector has no teaching write controls", await panel.locator("[data-testid=record-observation], [data-testid=open-activity-support]").count() === 0);
    await panel.locator(`[data-child-id="${child.id}"] [data-testid=select-child-record]`).first().click();
    const quote = panel.locator("blockquote");
    await quote.waitFor();
    const bookResponse = await context.request.get(`${settings.base}/api/children/${child.id}/evidence-book${new URL(page.url()).search}`);
    check("formal child GET authorized", bookResponse.status() === 200);
    const book = await bookResponse.json();
    const quotes = book.goals.flatMap((goal) => goal.items).filter((row) => row.item.id === m.guide_items.behavior_item_id)
      .flatMap((row) => row.links).filter((link) => link.counts_toward_status).flatMap((link) => link.basis).filter((basis) => basis.valid).map((basis) => basis.quote);
    check("displayed quote comes from authorized formal evidence", quotes.includes(await quote.innerText()));
    const beforeDrill = new URL(page.url());
    await panel.getByRole("button", { name: `查看${child.name}证据册`, exact: true }).click();
    await page.locator('[data-testid="child-evidence-book"][data-client-ready="true"]').waitFor();
    const drill = new URL(page.url());
    check("real roster drilldown retains child and item", drill.pathname === `/children/${child.id}/evidence` && drill.searchParams.get("item_id") === m.guide_items.behavior_item_id);
    for (const [key, value] of beforeDrill.searchParams) check(`drilldown retains ${key}`, drill.searchParams.get(key) === value);
    if (baseline.scope.kind === "semester") check("drilldown retains applied semester", drill.searchParams.get("semester_id") === baseline.scope.semester_id);
    await page.goto(settings.base + classPath); await settle(page); await page.locator(rootSelector).waitFor();
    const filtersRoot = page.locator(rootSelector);
    const domainKeys = await filtersRoot.locator("[data-testid=domain-tab]").evaluateAll((nodes) => nodes.map((node) => node.dataset.domain));
    const ageKeys = await filtersRoot.locator("[data-testid=age-band-option]").evaluateAll((nodes) => nodes.map((node) => node.dataset.ageBand));
    check("all five domains plus all remain selectable", domainKeys.length === 6 && domainKeys.includes("all"));
    check("all and three reference ages remain selectable", ["all", "3-4", "4-5", "5-6"].every((key) => ageKeys.includes(key)));
    for (const [kind, keys, selector, attr] of [["domain", domainKeys, "domain-tab", "data-domain"], ["age", ageKeys, "age-band-option", "data-age-band"]]) {
      for (const key of keys) {
        const option = page.locator(rootSelector).locator(`[data-testid="${selector}"][${attr}="${key}"]`);
        await option.click();
        await page.waitForFunction(({ testid, attr, key }) => document.querySelector(`[data-testid="${testid}"][${attr}="${key}"]`)?.getAttribute("aria-pressed") === "true", { testid: selector, attr, key });
        await settle(page);
        const filtered = await currentOverview(context, page);
        check(`${kind}/${key} preserves roster and period`, JSON.stringify(filtered.roster) === JSON.stringify(baseline.roster) && JSON.stringify(filtered.scope) === JSON.stringify(baseline.scope));
        check(`${kind}/${key} notifies the formal filter`, (kind === "domain" ? filtered.filters.domain_code : filtered.filters.age_band) === (key === "all" ? null : key));
        await verifyStats(page.locator(rootSelector), filtered);
      }
      await page.locator(rootSelector).locator(`[data-testid="${selector}"][${attr}="all"]`).click();
      await page.waitForFunction(({ testid, attr }) =>
        document.querySelector(`[data-testid="${testid}"][${attr}="all"]`)?.getAttribute("aria-pressed") === "true" &&
        document.querySelector('[data-testid="class-evidence-overview"]')?.closest('[aria-busy]')?.getAttribute('aria-busy') !== "true",
      { testid: selector, attr });
      await settle(page);
    }
    check("all/ cross-age selection restored, not silently age-limited", (await currentOverview(context, page)).filters.age_band === null);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await settle(page);
  }
  async function copyChecks(context, page, name, role, width) {
    if (role === "guest") return;
    const surface = page.locator('main [data-platform-surface]').first();
    const visible = await surface.innerText();
    check("no targeted static technical noise in primary screen", !/不可改写的追溯依据|结构化分析卡片|AUTH_TRUSTED_ORIGINS|未配置教师口令|少量建议/.test(visible));
    if (name === "observation-new") {
      await page.locator("#child").click();
      const options = page.getByRole("option").filter({ hasText: child.name });
      const labels = await options.allTextContents();
      check("same-class same-name choices retain distinct complete dates", labels.length === 3 &&
        labels.filter((text) => text.includes(settings.copy_fixtures.class_name)).length === 2 &&
        labels.filter((text) => /出生/.test(text)).length === 2 && new Set(labels).size === 3);
      check("long child menu stays within viewport", await page.getByRole("listbox").evaluate((node) => {
        const r = node.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1;
      }));
      await capture(page, `copy2-same-name-menu-${width}`);
      await page.keyboard.press("Escape");
      check("original immutability still explained once", (await surface.innerText()).split("原文保存后不能修改").length === 2);
    }
    if (name === "review") {
      check("confirmed teacher content and original remain visible", visible.includes("教师确认稿（已归档）") && visible.includes(m.observations.a1_h1.raw_text));
      check("AI version is still explicitly labelled", visible.includes("AI 草稿（确认前）"));
      const info = page.getByRole("group").filter({ hasText: "整理信息" });
      if (await info.count()) check("model diagnostic not expanded by default", await info.first().getAttribute("open") === null);
    }
    if (name === "family-entry" && await page.locator("#parent-sharing-text").count()) {
      const measurements = await page.locator("#parent-sharing-text").evaluate((node) => {
        const s = getComputedStyle(node), b = node.getBoundingClientRect();
        return { font: parseFloat(s.fontSize), line: parseFloat(s.lineHeight), max: parseFloat(s.maxInlineSize), width: b.width };
      });
      check("sharing editor uses readable font, leading and bounded measure", measurements.font >= 16 && measurements.line / measurements.font >= 1.5 &&
        Number.isFinite(measurements.max) && measurements.width <= measurements.max + 1);
    } else if (name === "family-entry") {
      layout.push({ scope, evidence: "generated_editor_measure_deferred_to_family_fixture_flow", status: "NOT_RUN_in_empty_workspace" });
    }
    if (width === 390) {
      // DOM text-size stress is not native browser zoom or a physical phone.
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await settle(page);
      check("200 percent DOM text-size stress has no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      layout.push({ scope, evidence: "DOM_text_size_stress_not_native_zoom", scale: "200%", overflow: false });
      await capture(page, `copy2-${role}-${name}-text-stress-${width}`);
      await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
      await settle(page);
    }
  }
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const role of roles) {
      for (const [width, height] of [[1440, 900], [1024, 900], [768, 1024], [390, 844]]) {
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
        await context.route("**/*", async (route) => {
          const request = route.request(), url = new URL(request.url());
          if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
          const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method());
          const metadataInitialization = request.method() === "POST" && url.pathname === "/api/yaya/conversations";
          if (url.origin !== settings.base || (mutating && url.pathname !== "/api/auth/login" && !metadataInitialization)) {
            faults.push({ scope, kind: url.origin !== settings.base ? "external_request_denied" : "unexpected_write_denied", method: request.method(), path: url.origin === settings.base ? url.pathname : "[external]" });
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });
        context.on("response", (response) => {
          const url = new URL(response.url());
          if (url.origin === settings.base && url.pathname.startsWith("/api/")) network.push({ scope, method: response.request().method(), path: url.pathname, status: response.status() });
          if (url.origin === settings.base && url.pathname === "/api/yaya/conversations" && response.request().method() === "POST") {
            initializations.push({ scope, evidence: "private_chat_metadata_initialization_not_business_write", status: response.status() });
          }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        page.on("pageerror", (error) => faults.push({ scope, kind: "pageerror", name: error.name }));
        try {
          if (role !== "guest") {
            scope = `${role}/${width}/auth`;
            const login = await context.request.post(`${settings.base}/api/auth/login`, {
              headers: { origin: settings.base, "x-cga-auth-request": "1" }, data: settings.credentials[role === "teacher" ? "teacher_a" : "admin"],
            });
            check("real AUTH login", login.status() === 200);
          }
          for (const [name, url] of routes.filter(([name]) => copyPages(role, name))) {
            scope = `${role}/${width}/${name}`;
            const caseStart = results.length;
            const cell = coverage.find((row) => row.role === role && row.width === width && row.page === name);
            try {
              await page.goto(settings.base + url, { waitUntil: "domcontentloaded" });
              await settle(page);
              check("browser visibility API available", await page.evaluate(() => typeof Element.prototype.checkVisibility === "function"));
              if (cell.expected_outcome === "login_required") {
                const privateApi = name === "teachers" ? "/api/admin/teachers" : name === "class-evidence"
                  ? `/api/classes/${klass.id}/evidence-overview` : name === "child-evidence"
                    ? `/api/children/${child.id}/evidence-book` : "/api/children";
                const denied = await context.request.get(settings.base + privateApi);
                check("guest protected route shows login recovery and formal API denies access", denied.status() === 401 &&
                  await page.locator('main [role="alert"]:visible').count() > 0 &&
                  await page.locator('a[href*="/login"]:visible').count() > 0);
                cell.observed_outcome = "login_required";
              } else if (cell.expected_outcome === "forbidden_role") {
                check("teacher management is denied rather than empty", await page.getByText("仅管理员可管理教师", { exact: true }).isVisible() &&
                  await page.locator('[data-platform-surface="teachers"]:visible').count() === 0);
                const denied = await context.request.get(`${settings.base}/api/admin/teachers`);
                check("formal teacher-management GET is 403", denied.status() === 403);
                cell.observed_outcome = "forbidden_role_HTTP403";
              } else {
                check("authorized page does not masquerade as a permission/service failure", await page.locator('[data-platform-surface="read-failure"]:visible').count() === 0);
                cell.observed_outcome = role === "guest" ? "public_home" : "authorized";
              }
              if (!(role === "guest" && name === "observation-new")) {
                await geometry(page);
                await hitSamples(page, width);
              }
              await launcher(page, width, role);
              if (name === "class-evidence" && role !== "guest") await classChecks(context, page, width, role);
              if (name === "family-entry" && role !== "guest") {
                check("family entry does not generate or preselect child", await page.getByText("先选择一名幼儿", { exact: true }).isVisible());
                const childrenResponse = await context.request.get(`${settings.base}/api/children`);
                check("family picker uses authorized scoped child directory", childrenResponse.status() === 200);
                const directory = await childrenResponse.json();
                check("scoped child directory has explicit list shape", Array.isArray(directory.children));
                await page.locator("#communication-child").click();
                const allLabels = await page.getByRole("option").allTextContents();
                check("picker matches current scoped GET, not an assumed teacher scope", allLabels.length === directory.children.length &&
                  directory.children.every((entry) => allLabels.some((text) => text.includes(`${entry.name} · ${entry.current_class?.name ?? entry.class_name}`))));
                const duplicates = page.getByRole("option").filter({ hasText: child.name });
                const labels = await duplicates.allTextContents();
                const sameNameChildren = directory.children.filter((entry) => entry.name === child.name);
                check("same-name choices retain authorized class distinctions", labels.length === sameNameChildren.length && sameNameChildren.every((entry) =>
                  labels.some((text) => text.includes(entry.current_class?.name ?? entry.class_name))));
                check("open child picker stays within viewport", await page.getByRole("listbox").evaluate((node) => { const r = node.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; }));
                await page.keyboard.press("Escape");
              }
              if (name === "teachers" && role === "admin") {
                const account = page.getByText(m.accounts.teacher_a.username, { exact: false }).last();
                check("long synthetic account remains readable without horizontal overflow", await account.evaluate((node) => {
                  const r = node.getBoundingClientRect();
                  return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1;
                }));
              }
              if (settings.copy_review) await copyChecks(context, page, name, role, width);
              await capture(page, `${role}-${name}-${width}`);
              Object.assign(cell, { status: "PASS", checks: results.length - caseStart });
            } catch (error) {
              Object.assign(cell, { status: "FAIL", error_kind: error.name, checks: results.length - caseStart });
              await capture(page, `${role}-${name}-${width}-failure`).catch(() => {});
              // Keep collecting other pages; FAIL remains a failing process, not a skipped PASS.
              await page.locator("[data-yaya-panel]:visible [data-yaya-close]").click({ timeout: 1000 }).catch(() => {});
            }
          }
        } finally { await context.close(); }
      }
    }
    scope = "closeout";
    const expectedCases = roles.reduce((sum, role) => sum + routes.filter(([name]) => copyPages(role, name)).length * 4, 0);
    check("all selected roles, routes and 4 widths covered (no CHECK as PASS)", coverage.length === expectedCases && coverage.every((row) => row.status === "PASS"));
    check("no page exceptions or denied writes/external requests", faults.length === 0, { faults });
    check("automatic conversation metadata uses authenticated API without message or business writes", initializations.length > 0 && initializations.every((row) => row.status === 201));
    completed = true;
  } catch (error) {
    faults.push({ scope, kind: "runner_failure", name: error.name });
  } finally {
    let browserClosed = false;
    try { if (browser) await browser.close(); browserClosed = true; } catch { faults.push({ kind: "browser_cleanup_unverified" }); }
    const report = { run: settings.run, completed: completed && browserClosed, passed: results.filter((row) => row.ok).length,
      total: results.length, coverage, results, layout, faults, advisories, conversation_initializations: initializations, protocol_recheck: Boolean(settings.protocol_recheck), copy_review: Boolean(settings.copy_review), real_model_requests: 0, browser_closed: browserClosed,
      evidence: "production_Next+isolated_QA_seed+real_AUTH+Chrome; no model or family generation", NOT_RUN: ["real provider", "production", "physical devices", "screen reader", "family generation/edit/copy"] };
    fs.writeFileSync(path.join(settings.out, "results.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(settings.out, "network.json"), JSON.stringify(network, null, 2));
    // No bodies, credentials, Cookie, query strings, raw quotes or stack traces are persisted.
    console.log(JSON.stringify({ completed: report.completed, passed: report.passed, total: report.total, browser_closed: browserClosed }));
    if (!report.completed) process.exitCode = 1;
  }
}

void main().catch((error) => { console.error(JSON.stringify({ completed: false, preflight_error: error.name })); process.exitCode = 1; });
