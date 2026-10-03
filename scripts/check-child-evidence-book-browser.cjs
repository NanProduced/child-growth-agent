#!/usr/bin/env node
/**
 * G3 个人证据册浏览器验收（fixture 组件验收，非业务闭环）。
 *
 * 一条命令完成：临时预览搭建 → 启动 next dev → 运行断言 → 清理 → 输出结果。
 * 运行：node scripts/check-child-evidence-book-browser.cjs [证据目录]
 *
 * 前置：pnpm（仅在临时目录安装 playwright-core 时使用）、本机 Chrome 或 Edge、项目已 pnpm install。
 * - 预览路由 src/app/guide-preview/page.tsx 由本脚本从 scripts/__fixtures__/guide-preview-page.tsx
 *   复制创建；若目标已存在则拒绝运行，绝不覆盖；结束时只删除本次创建的文件与空目录。
 * - playwright-core 解析：环境变量 G3_PLAYWRIGHT_CORE → 项目 node_modules → 临时目录自动安装。
 * - 浏览器解析：环境变量 G3_CHROME → 常见 Chrome/Edge 路径 → playwright channel: chrome。
 * - 端口：环境变量 G3_PORT，默认 3100。
 * 不写数据库、不调用模型、不 push、不部署；不保留生产可访问的 mock 路由。
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(ROOT, "scripts", "__fixtures__", "guide-preview-page.tsx");
const ROUTE_DIR = path.join(ROOT, "src", "app", "guide-preview");
const ROUTE_FILE = path.join(ROUTE_DIR, "page.tsx");
const PORT = Number(process.env.G3_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}/guide-preview`;
const EVIDENCE = process.argv[2] || path.join(os.tmpdir(), "g3-evidence");
const SERVER_LOG = path.join(os.tmpdir(), "g3-preview-server.log");
const BOOK = "[data-testid=child-evidence-book]";
const itemRow = (id) => `${BOOK} [data-item-id="${id}"]`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
}

function resolvePlaywrightCore() {
  if (process.env.G3_PLAYWRIGHT_CORE) return process.env.G3_PLAYWRIGHT_CORE;
  try {
    return path.dirname(require.resolve("playwright-core/package.json"));
  } catch {
    /* 项目未安装时在临时目录安装，不改动项目 package.json */
  }
  const cacheDir = path.join(os.tmpdir(), "g3-browser-deps");
  fs.mkdirSync(cacheDir, { recursive: true });
  const pkgFile = path.join(cacheDir, "package.json");
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(pkgFile, JSON.stringify({ name: "g3-browser-deps", private: true, version: "0.0.0" }));
  }
  const packageFile = path.join(cacheDir, "node_modules", "playwright-core", "package.json");
  if (!fs.existsSync(packageFile)) {
    const install = spawnSync("pnpm", ["add", "playwright-core", "--prefer-offline"], {
      cwd: cacheDir,
      shell: true,
      stdio: "inherit",
    });
    if (install.status !== 0) {
      throw new Error("无法安装 playwright-core；请设置 G3_PLAYWRIGHT_CORE 指向已安装的包目录。");
    }
  }
  return path.join(cacheDir, "node_modules", "playwright-core");
}

function resolveChrome() {
  const candidates = [
    process.env.G3_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let createdRouteDir = false;
function setupRoute() {
  if (fs.existsSync(ROUTE_FILE)) {
    throw new Error(`预览路由已存在，拒绝覆盖：${ROUTE_FILE}（请先手动清理再重跑）`);
  }
  if (!fs.existsSync(TEMPLATE)) throw new Error(`缺少预览模板：${TEMPLATE}`);
  if (!fs.existsSync(ROUTE_DIR)) {
    fs.mkdirSync(ROUTE_DIR, { recursive: true });
    createdRouteDir = true;
  }
  fs.copyFileSync(TEMPLATE, ROUTE_FILE);
}

function cleanupRoute() {
  if (fs.existsSync(ROUTE_FILE)) fs.rmSync(ROUTE_FILE, { force: true });
  if (createdRouteDir && fs.existsSync(ROUTE_DIR) && fs.readdirSync(ROUTE_DIR).length === 0) {
    fs.rmSync(ROUTE_DIR, { recursive: true, force: true });
  }
  /* next dev 生成的类型文件可能引用已删除的临时路由；只清理引用它的生成文件，保证 ts-check 可复跑 */
  const nextDir = path.join(ROOT, ".next");
  if (!fs.existsSync(nextDir)) return;
  const stack = [nextDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && fs.readFileSync(full, "utf8").includes("guide-preview")) {
        fs.rmSync(full, { force: true });
      }
    }
  }
}

async function waitForServer(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(BASE, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      /* 尚未监听 */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`dev server 未在 ${timeoutMs}ms 内就绪；日志见 ${SERVER_LOG}`);
}

async function openPage(browser, viewport, options = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: options.reducedMotion });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForSelector(BOOK, { timeout: 180000 });
  await page.waitForTimeout(300);
  return { context, page };
}

async function lastEvent(page, label) {
  return page.evaluate((wanted) => (window.__g3events || []).filter((event) => event.label === wanted).at(-1), label);
}

async function eventCount(page) {
  return page.evaluate(() => (window.__g3events || []).length);
}

async function auditViewport(browser, width, height, label, evidenceDir) {
  const { context, page } = await openPage(browser, { width, height });
  const overflow = await page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const book = document.querySelector("[data-testid=child-evidence-book]");
    return {
      docScroll: doc.scrollWidth,
      inner: window.innerWidth,
      bookScroll: book ? book.scrollWidth : 0,
      bookClient: book ? book.clientWidth : 0,
    };
  });
  check(
    `${label}: 无横向溢出`,
    overflow.docScroll <= overflow.inner + 1 && overflow.bookScroll <= overflow.bookClient + 1,
    JSON.stringify(overflow),
  );
  const smallTargets = await page.evaluate(() => {
    const nodes = document.querySelectorAll(
      "[data-testid=child-evidence-book] button, [data-testid=child-evidence-book] select, [data-testid=child-evidence-book] input",
    );
    return [...nodes]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        tag: el.tagName,
        testid: el.dataset.testid || "",
        h: Math.round(el.getBoundingClientRect().height * 10) / 10,
        text: (el.textContent || "").trim().slice(0, 12),
      }))
      .filter((entry) => entry.h < 43.5);
  });
  check(`${label}: 核心目标 ≥44px`, smallTargets.length === 0, JSON.stringify(smallTargets));
  await page.screenshot({ path: path.join(evidenceDir, `rich-${label}.png`), fullPage: true });
  await context.close();
}

async function runChecks(browser, evidenceDir) {
  /* ================= 三断点：布局、溢出、触控目标、截图 ================= */
  await auditViewport(browser, 1440, 900, "1440x900", evidenceDir);
  await auditViewport(browser, 768, 1024, "768x1024", evidenceDir);
  await auditViewport(browser, 390, 844, "390x844", evidenceDir);

  /* ================= 完整示例：正常路径 + 可靠性 + 展示 + 筛选 ================= */
  const { context, page } = await openPage(browser, { width: 1440, height: 900 });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  const statuses = await page.$$eval(`${BOOK} [data-testid=evidence-item]`, (els) =>
    els.map((el) => el.dataset.status),
  );
  check(
    "三种正式状态齐备",
    ["confirmed_observed", "has_clues", "no_records"].every((status) => statuses.includes(status)),
    statuses.join(","),
  );
  const bookText = await page.locator(BOOK).innerText();
  check("无百分比符号", !bookText.includes("%"), "");
  check("无完成度/雷达字样", !/完成\s*\d|雷达|达标/.test(bookText), "");
  check("资料参考标签存在", bookText.includes("资料参考"), "");
  check("AI 待核对流程标签存在", bookText.includes("AI 待核对"), "");
  check("指南参考年龄段提示存在", bookText.includes("不等于“确定发生在小班时期”"), "");

  /* 语言 3-4 条目：正式依据落入期间 + 撤回审计 */
  const langItem = page.locator(itemRow("item.ui.language.1.3-4"));
  await langItem.locator("[data-testid=item-disclosure]").click();
  const langText = await langItem.innerText();
  check("正式依据落在所选期间内", langText.includes("2026年9月5日") && !langText.includes("最近 2025年"), "");
  check("正式依据发生时班级来自快照", langText.includes("2026年9月5日 · 示例中一班 · 中班 · 原始观察原文"), "");
  check("正式依据分区存在", langText.includes("计入当前状态的依据"), "");
  check("流程与审计分区存在", langText.includes("流程与审计记录（不计入状态）"), "");
  check("撤回信息展示", langText.includes("撤回原因：复核后发现该片段指向另一条表现。"), "");
  check("撤回依据保留发生时班级快照", langText.includes("示例小一班 · 小班"), "");

  /* 键盘：Enter 收起再展开；Tab 进入面板操作 */
  await langItem.locator("[data-testid=item-disclosure]").focus();
  await page.keyboard.press("Enter");
  check(
    "键盘 Enter 收起",
    (await langItem.locator("[data-testid=item-disclosure]").getAttribute("aria-expanded")) === "false",
    "",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const focusedTestId = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") || document.activeElement?.tagName,
  );
  check("展开后 Tab 焦点进入记录操作", focusedTestId === "record-observation", focusedTestId);

  /* 记录相关观察回调 */
  await langItem.locator("[data-testid=record-observation]").click();
  const recordEvent = await lastEvent(page, "record");
  check(
    "记录相关观察回调带出儿童与条目",
    recordEvent &&
      recordEvent.payload.child_id === "fixture-ui-child-xiaoyu" &&
      recordEvent.payload.item_id === "item.ui.language.1.3-4",
    JSON.stringify(recordEvent),
  );

  /* 同源多片段：全部显示、各自成行 */
  const l1b = page.locator(itemRow("item.ui.language.1.4-5"));
  await l1b.locator("[data-testid=item-disclosure]").click();
  const l1bText = await l1b.innerText();
  check("同源多片段全部显示", l1bText.includes("是不是周末下雨了") && l1bText.includes("我妈妈说下雨要带伞"), "");
  const basisCount = await l1b.locator("[data-testid=basis-row]").count();
  check("同源多片段各自成行", basisCount === 2, String(basisCount));
  check("成人帮助如实标注", l1bText.includes("本次有成人帮助 · 教师说明：帮助方式：教师重复问题并等待幼儿回应。"), "");

  /* 保健参考：资料展示分支（收起与展开分别断言） */
  const healthRow = page.locator(itemRow("item.ui.health.1.3-4"));
  check("保健参考行不渲染行为状态徽章", (await healthRow.locator("[data-testid=item-status]").count()) === 0, "");
  check(
    "保健参考行显示资料参考",
    (await healthRow.locator("[data-testid=item-reference]").innerText()).trim() === "资料参考",
    await healthRow.locator("[data-testid=item-reference]").innerText(),
  );
  check("保健参考行使用收录文案", (await healthRow.innerText()).includes("收录 1 条参考资料"), "");
  check("保健参考保留内部状态用于审计", (await healthRow.getAttribute("data-status")) === "confirmed_observed", "");
  await healthRow.locator("[data-testid=item-disclosure]").click();
  const healthText = await healthRow.innerText();
  check("保健参考展开不出现表现确认徽章", !healthText.includes("已确认观察到"), "");
  check("保健参考分组为可查阅资料", healthText.includes("可查阅的参考资料"), "");
  check(
    "保健参考关联显示教师核对",
    healthText.includes("教师核对关联") && healthText.includes("资料已核对"),
    "",
  );
  check("保健参考规则不构成发展确认", healthText.includes("不构成发展确认") && !healthText.includes("可确认表现"), "");
  check("保健参考支持标签为资料措辞", healthText.includes("单次资料"), "");
  check("保健参考无达成式反馈", !/已掌握|达成|完成度/.test(healthText), "");

  const healthEmptyRow = page.locator(itemRow("item.ui.health.1.4-5"));
  check("保健参考空态使用资料措辞", (await healthEmptyRow.innerText()).includes("暂无已核验的参考资料"), "");
  await healthEmptyRow.locator("[data-testid=item-disclosure]").click();
  const healthEmptyText = await healthEmptyRow.innerText();
  check(
    "保健参考空态展开不冒充普通观察空态",
    healthEmptyText.includes("还没有可查阅的参考资料") && !healthEmptyText.includes("还没有与该条目相关的观察记录"),
    "",
  );

  /* partial + links=[]：不断言“没有记录” */
  const partialEmpty = page.locator(itemRow("item.ui.language.2.4-5"));
  check(
    "partial 空样本提示位于行首",
    (await partialEmpty.evaluate((el) => el.firstElementChild?.getAttribute("data-testid"))) === "reliability-note",
    await partialEmpty.evaluate((el) => el.firstElementChild?.getAttribute("data-testid")),
  );
  const partialEmptyCollapsed = await partialEmpty.innerText();
  check("partial 空样本不断言普通无记录", !partialEmptyCollapsed.includes("还没有计入状态的观察证据"), "");
  check("partial 空样本说明已核验依据", partialEmptyCollapsed.includes("暂无计入状态的已核验依据"), "");
  check("partial 提示改为未计入当前状态", !partialEmptyCollapsed.includes("未纳入本次呈现"), "");
  await partialEmpty.locator("[data-testid=item-disclosure]").click();
  const partialEmptyText = await partialEmpty.innerText();
  check(
    "partial 空样本展开不断言无观察",
    partialEmptyText.includes("当前没有可计入状态的已核验依据") &&
      !partialEmptyText.includes("还没有与该条目相关的观察记录"),
    "",
  );
  check("partial 空样本展开说明未计入状态", partialEmptyText.includes("未计入当前状态"), "");

  /* partial + 仅失效审计关联：提示行首、区分核验、审计区保留 */
  const partialRow = page.locator(itemRow("item.ui.social.1.3-4"));
  check(
    "partial 提示位于行首",
    (await partialRow.evaluate((el) => el.firstElementChild?.getAttribute("data-testid"))) === "reliability-note",
    await partialRow.evaluate((el) => el.firstElementChild?.getAttribute("data-testid")),
  );
  const partialText = await partialRow.innerText();
  check(
    "partial 区分已核验与未核验资料",
    partialText.includes("只依据已核验的资料") && partialText.includes("未通过核对"),
    "",
  );
  check("partial 不把期间排除写成数据异常", !partialText.includes("期间"), partialText);
  await partialRow.locator("[data-testid=item-disclosure]").click();
  const partialExpanded = await partialRow.innerText();
  check("partial 失效关联仍在审计区", partialExpanded.includes("流程与审计记录（不计入状态）"), "");
  check("partial 审计区无正式依据分组", !partialExpanded.includes("计入当前状态的依据"), "");
  check("失效依据原因展示", partialExpanded.includes("该依据未通过核对：片段无法在声明位置逐字核对"), "");
  check("失效依据保留审计展示", partialExpanded.includes("仅保留审计展示"), "");

  /* reliable 正常空态与 partial/unavailable 保持区别 */
  const reliableEmpty = page.locator(itemRow("item.ui.arts.1.4-5"));
  check("reliable 正常空态保持普通文案", (await reliableEmpty.innerText()).includes("还没有计入状态的观察证据"), "");
  await reliableEmpty.locator("[data-testid=item-disclosure]").click();
  check(
    "reliable 空态展开为普通文案",
    (await reliableEmpty.innerText()).includes("还没有与该条目相关的观察记录"),
    "",
  );

  /* 期间排除：不降可靠性、无核验提示、不计入正式状态 */
  const periodRow = page.locator(itemRow("item.ui.social.1.4-5"));
  check("期间排除不降可靠性", (await periodRow.getAttribute("data-reliability")) === "reliable", "");
  check("期间排除无核验提示", (await periodRow.locator("[data-testid=reliability-note]").count()) === 0, "");
  check(
    "跨期不计入正式状态",
    (await periodRow.getAttribute("data-status")) === "no_records" &&
      !(await periodRow.innerText()).includes("相关证据"),
    "",
  );
  await periodRow.locator("[data-testid=item-disclosure]").click();
  check(
    "跨期排除原因展示",
    (await periodRow.innerText()).includes("未计入当前状态：依据的观察日期不在所选期间内"),
    "",
  );

  /* 历史未知 + 连续纪要 */
  const unknownItem = page.locator(itemRow("item.ui.science.1.4-5"));
  await unknownItem.locator("[data-testid=item-disclosure]").click();
  const unknownText = await unknownItem.innerText();
  check("历史班级未知不回填", unknownText.includes("发生班级未知（历史记录未保存）"), "");
  check("连续观察纪要展示", unknownText.includes("连续观察纪要（2026-09-15 至 2026-09-20）"), "");

  /* AI 待核对理由 */
  const pendingItem = page.locator(itemRow("item.ui.language.2.3-4"));
  await pendingItem.locator("[data-testid=item-disclosure]").click();
  check("AI 待核对理由展示", (await pendingItem.innerText()).includes("AI 建议理由："), "");

  /* 领域与年龄段筛选 */
  await page.locator('[data-domain="language"]').click();
  const languageIds = await page.$$eval(`${BOOK} [data-testid=evidence-item]`, (els) =>
    els.map((el) => el.dataset.itemId),
  );
  check(
    "领域筛选只显示语言条目",
    languageIds.length === 4 && languageIds.every((id) => id.startsWith("item.ui.language")),
    languageIds.join(","),
  );
  const filterEvent = await lastEvent(page, "filters");
  check("领域筛选回调 domain_code=language", filterEvent && filterEvent.payload.domain_code === "language", JSON.stringify(filterEvent));
  check(
    "选定领域后不重复领域定位",
    !(await page.locator('h3[id^="goal-"]').first().innerText()).includes("语言 · 倾听与表达"),
    await page.locator('h3[id^="goal-"]').first().innerText(),
  );

  await page.locator('[data-age-band="4-5"]').click();
  const ageIds = await page.$$eval(`${BOOK} [data-testid=evidence-item]`, (els) => els.map((el) => el.dataset.itemId));
  check(
    "参考年龄段筛选生效",
    ageIds.length === 2 &&
      ageIds.includes("item.ui.language.1.4-5") &&
      ageIds.includes("item.ui.language.2.4-5"),
    ageIds.join(","),
  );

  await page.locator('[data-domain="all"]').click();
  await page.locator('[data-age-band="all"]').click();
  await page.waitForTimeout(50);
  check(
    "全部领域模式显示领域/子领域定位",
    (await page.locator('h3[id^="goal-"]').first().innerText()).includes("语言 · 倾听与表达"),
    await page.locator('h3[id^="goal-"]').first().innerText(),
  );

  /* goal_id：范围说明、解除入口、切“全部”清空 */
  await page.locator("[data-testid=inject-goal]").click();
  await page.waitForSelector("[data-testid=goal-scope-banner]");
  const bannerText = await page.locator("[data-testid=goal-scope-banner]").innerText();
  check("限定目标显示范围说明", bannerText.includes("愿意讲话并能清楚地表达"), bannerText);
  check("限定目标只显示该目标", (await page.locator('h3[id^="goal-"]').count()) === 1, "");

  await page.locator('[data-domain="all"]').click();
  const clearEvent = await lastEvent(page, "filters");
  check(
    "点击全部清空 goal_id",
    clearEvent && clearEvent.payload.domain_code === null && clearEvent.payload.goal_id === null,
    JSON.stringify(clearEvent),
  );
  await page.waitForTimeout(50);
  check("清空后解除目标范围", (await page.locator("[data-testid=goal-scope-banner]").count()) === 0, "");

  await page.locator("[data-testid=inject-goal]").click();
  await page.waitForSelector("[data-testid=goal-scope-banner]");
  await page.locator("[data-testid=goal-scope-release]").click();
  const releaseEvent = await lastEvent(page, "filters");
  check("解除入口发出 goal_id=null", releaseEvent && releaseEvent.payload.goal_id === null, JSON.stringify(releaseEvent));
  await page.waitForTimeout(50);
  check("解除后不再限定目标", (await page.locator("[data-testid=goal-scope-banner]").count()) === 0, "");

  /* 受控期间：草稿、未应用、父级拒绝、外部切换 */
  const select = page.locator("[data-testid=scope-select]");
  const draftStatus = page.locator("[data-testid=draft-status]");
  check("初始期间控件反映生效范围", (await select.inputValue()) === "semester:2026-2027-1", await select.inputValue());

  await select.selectOption("custom_range");
  await page.waitForTimeout(50);
  check("选择自定义后控件仍显示生效范围", (await select.inputValue()) === "semester:2026-2027-1", await select.inputValue());
  check("草稿标注尚未应用", (await draftStatus.innerText()).includes("尚未应用"), "");

  await page.locator("[data-testid=range-from]").fill("2026-09-01");
  await page.locator("[data-testid=range-to]").fill("2026-09-30");
  const itemCountBefore = await page.locator(`${BOOK} [data-testid=evidence-item]`).count();
  check("日期未应用：控件值不变", (await select.inputValue()) === "semester:2026-2027-1", await select.inputValue());
  check("日期未应用：数据范围不变", (await page.locator(`${BOOK} [data-testid=evidence-item]`).count()) === itemCountBefore, "");
  check("日期未应用：草稿仍标注尚未应用", (await draftStatus.innerText()).includes("尚未应用"), "");

  await page.locator("[data-testid=range-from]").evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "2026-02-30");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const sanitized = await page.locator("[data-testid=range-from]").inputValue();
  check("非法日历日期被浏览器拒绝（值为空）", sanitized === "", sanitized);
  const beforeInvalid = await eventCount(page);
  await page.getByRole("button", { name: "应用日期" }).click();
  check("非法日期不发回调", (await eventCount(page)) === beforeInvalid, `${beforeInvalid}->${await eventCount(page)}`);
  check("非法日期给出错误提示", (await page.locator(`${BOOK} [role=alert]`).count()) > 0, "");
  await page.locator("[data-testid=range-from]").fill("2026-09-01");

  await page.locator("[data-testid=reject-scope]").check();
  const beforeReject = await eventCount(page);
  await page.getByRole("button", { name: "应用日期" }).click();
  const rejectEvent = await lastEvent(page, "scope");
  check(
    "父级拒绝仍发出意图且参数正确",
    (await eventCount(page)) === beforeReject + 1 &&
      rejectEvent.payload.kind === "custom_range" &&
      rejectEvent.payload.from === "2026-09-01" &&
      rejectEvent.payload.to === "2026-09-30",
    JSON.stringify(rejectEvent),
  );
  check("父级拒绝后控件保持生效范围", (await select.inputValue()) === "semester:2026-2027-1", await select.inputValue());
  check("父级拒绝后草稿尚未应用", (await draftStatus.innerText()).includes("尚未应用"), "");

  await page.locator("[data-testid=reject-scope]").uncheck();
  await page.getByRole("button", { name: "应用日期" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=scope-select]")?.value === "custom_range");
  check("应用后控件切换到自定义范围", (await select.inputValue()) === "custom_range", await select.inputValue());
  check("应用后草稿标记已应用", (await draftStatus.innerText()).includes("已应用"), "");

  await page.locator('[data-testid=external-scope][data-scope=all_history]').click();
  await page.waitForFunction(() => document.querySelector("[data-testid=scope-select]")?.value === "all_history");
  check("外部切换全部历史：控件跟随", (await select.inputValue()) === "all_history", await select.inputValue());
  check("外部切换后草稿不冒充数据范围", (await draftStatus.innerText()).includes("尚未应用"), "");

  await page.locator('[data-testid=external-scope][data-scope=semester]').click();
  await page.waitForFunction(() => document.querySelector("[data-testid=scope-select]")?.value === "semester:2026-2027-1");
  check("外部恢复学期：控件跟随", (await select.inputValue()) === "semester:2026-2027-1", await select.inputValue());

  await page.locator('[data-testid=external-scope][data-scope=custom]').click();
  await page.waitForFunction(() => document.querySelector("[data-testid=scope-select]")?.value === "custom_range");
  check("外部自定义范围：草稿同步为已应用", (await draftStatus.innerText()).includes("已应用"), "");

  /* 自定义范围切换失败后仍可编辑（R2） */
  await page.locator("[data-testid=reject-scope]").check();
  await select.selectOption("all_history");
  await page.waitForTimeout(80);
  const rejectedAll = await lastEvent(page, "scope");
  check("custom→all_history 被拒仍发意图", rejectedAll && rejectedAll.payload.kind === "all_history", JSON.stringify(rejectedAll));
  check("被拒后控件保持 custom", (await select.inputValue()) === "custom_range", await select.inputValue());
  check(
    "被拒后日期编辑区仍可达",
    (await page.locator("[data-testid=custom-range-draft]").count()) === 1 &&
      (await page.locator("[data-testid=range-from]").isVisible()),
    "",
  );
  await page.locator("[data-testid=range-from]").fill("2026-10-01");
  check("被拒后日期仍可编辑", (await page.locator("[data-testid=range-from]").inputValue()) === "2026-10-01", "");
  check("被拒后新草稿不标已应用", (await draftStatus.innerText()).includes("尚未应用"), "");

  await select.selectOption("semester:2026-2027-1");
  await page.waitForTimeout(80);
  const rejectedSemester = await lastEvent(page, "scope");
  check(
    "custom→semester 被拒仍发意图",
    rejectedSemester && rejectedSemester.payload.kind === "semester" && rejectedSemester.payload.semester_id === "2026-2027-1",
    JSON.stringify(rejectedSemester),
  );
  check("被拒后控件保持 custom（学期）", (await select.inputValue()) === "custom_range", await select.inputValue());
  check("被拒后编辑区仍可达（学期）", await page.locator("[data-testid=range-from]").isVisible(), "");

  await page.locator("[data-testid=reject-scope]").uncheck();
  await select.selectOption("all_history");
  await page.waitForFunction(() => document.querySelector("[data-testid=scope-select]")?.value === "all_history");
  check("成功切换后控件为 all_history", (await select.inputValue()) === "all_history", await select.inputValue());
  check(
    "成功切换后草稿保留且未应用",
    (await draftStatus.innerText()).includes("尚未应用") &&
      (await page.locator("[data-testid=range-from]").inputValue()) === "2026-10-01",
    "",
  );

  await page.locator('[data-testid=external-scope][data-scope=custom]').click();
  await page.waitForFunction(() => document.querySelector("[data-testid=scope-select]")?.value === "custom_range");
  check(
    "外部恢复自定义后草稿同步已应用",
    (await draftStatus.innerText()).includes("已应用") &&
      (await page.locator("[data-testid=range-from]").inputValue()) === "2026-09-01",
    "",
  );

  check(
    "无重复 React key 警告",
    !consoleErrors.some((text) => /same key|unique "key"/i.test(text)),
    consoleErrors.filter((text) => /same key|unique "key"/i.test(text)).join(" | ").slice(0, 300),
  );

  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidenceDir, "rich-1440-expanded.png"), fullPage: true });
  await context.close();

  /* ================= 减少动态偏好 ================= */
  const reduced = await openPage(browser, { width: 1440, height: 900 }, { reducedMotion: "reduce" });
  await reduced.page.locator(`${itemRow("item.ui.language.1.3-4")} [data-testid=item-disclosure]`).click();
  const motion = await reduced.page.evaluate(() => {
    const panel = document.querySelector('[id^="evidence-panel-"]');
    const segment = document.querySelector("[data-testid=domain-tab]");
    return {
      animation: panel ? getComputedStyle(panel).animationName : "missing",
      transition: segment ? getComputedStyle(segment).transitionDuration : "missing",
    };
  });
  check("减少动态：面板无动画", motion.animation === "none", JSON.stringify(motion));
  check("减少动态：筛选按钮无过渡", motion.transition === "0s", JSON.stringify(motion));
  await reduced.context.close();

  /* ================= 记录不可读场景 ================= */
  const unavailable = await openPage(browser, { width: 1440, height: 900 });
  await unavailable.page.getByRole("button", { name: "记录不可读" }).click();
  await unavailable.page.waitForSelector(`${BOOK} [data-reliability=unavailable]`);
  const unavailableRow = unavailable.page.locator(itemRow("item.ui.unavailable.language.1.3-4"));
  const unavailableWithoutNote = await unavailableRow.evaluate((el) => {
    const note = el.querySelector('[data-testid="reliability-note"]');
    const noteText = note ? note.textContent || "" : "";
    return (el.textContent || "").split(noteText).join("");
  });
  check("unavailable 行不显示普通暂无状态", !unavailableWithoutNote.includes("暂无相关记录"), unavailableWithoutNote.slice(0, 120));
  check("unavailable 行不显示确定性空态", !unavailableWithoutNote.includes("还没有计入状态的观察证据"), "");
  check(
    "unavailable 提示位于行首",
    (await unavailableRow.evaluate((el) => el.firstElementChild?.getAttribute("data-testid"))) === "reliability-note",
    await unavailableRow.evaluate((el) => el.firstElementChild?.getAttribute("data-testid")),
  );
  const unavailableText = await unavailableRow.innerText();
  check(
    "unavailable 先呈现资料不可读",
    unavailableText.includes("资料暂不可读") && unavailableText.includes("不能按「暂无相关记录」理解"),
    "",
  );
  check("unavailable 无普通状态徽章", (await unavailableRow.locator("[data-testid=item-status]").count()) === 0, "");
  await unavailableRow.locator("[data-testid=item-disclosure]").click();
  const unavailableExpanded = await unavailableRow.innerText();
  check("unavailable 展开不显示确定性空态", !unavailableExpanded.includes("还没有与该条目相关的观察记录"), "");
  check("unavailable 展开说明无法读取", unavailableExpanded.includes("相关记录暂时无法读取，无法核对"), "");
  const normalRow = unavailable.page.locator(itemRow("item.ui.unavailable.language.1.4-5"));
  check(
    "同页正常条目仍显示正式状态",
    (await normalRow.innerText()).includes("暂无相关记录") &&
      (await normalRow.locator("[data-testid=reliability-note]").count()) === 0,
    "",
  );
  check(
    "不可读场景通知展示",
    (await unavailable.page.locator(BOOK).innerText()).includes("部分观察的指南关联暂时无法读取"),
    "",
  );
  await unavailable.page.waitForTimeout(250);
  await unavailable.page.screenshot({ path: path.join(evidenceDir, "unavailable-1440.png"), fullPage: true });
  await unavailable.context.close();

  /* ================= 大目录场景 ================= */
  const large = await openPage(browser, { width: 1440, height: 900 });
  await large.page.getByRole("button", { name: "大目录" }).click();
  await large.page.waitForSelector(`${BOOK} [data-testid=evidence-item]`);
  const largeCount = await large.page.locator(`${BOOK} [data-testid=evidence-item]`).count();
  const largeOverflow = await large.page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    return { doc: doc.scrollWidth, inner: window.innerWidth };
  });
  check("大目录条目数量", largeCount >= 60, String(largeCount));
  check("大目录无横向溢出", largeOverflow.doc <= largeOverflow.inner + 1, JSON.stringify(largeOverflow));
  await large.page.screenshot({ path: path.join(evidenceDir, "large-1440.png"), fullPage: true });
  await large.context.close();

  /* ================= 390 长文本展开 ================= */
  const narrow = await openPage(browser, { width: 390, height: 844 });
  const longItem = narrow.page.locator(itemRow("item.ui.arts.1.3-4"));
  await longItem.locator("[data-testid=item-disclosure]").click();
  const narrowOverflow = await narrow.page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const book = document.querySelector("[data-testid=child-evidence-book]");
    return { doc: doc.scrollWidth, inner: window.innerWidth, book: book.scrollWidth, bookClient: book.clientWidth };
  });
  check(
    "390 长文本展开无横向溢出",
    narrowOverflow.doc <= narrowOverflow.inner + 1 && narrowOverflow.book <= narrowOverflow.bookClient + 1,
    JSON.stringify(narrowOverflow),
  );
  check("长文本完整展示", (await longItem.innerText()).includes("这是晚上的河，灯一亮，小船就不会迷路了"), "");
  await narrow.page.waitForTimeout(250);
  await narrow.page.screenshot({ path: path.join(evidenceDir, "rich-390-longtext.png"), fullPage: true });
  await narrow.context.close();
}

(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  let server = null;
  let logFd = null;
  let routeCreated = false;
  let fatal = null;
  let browser = null;

  try {
    setupRoute();
    routeCreated = true;
    const playwrightCorePath = resolvePlaywrightCore();
    const { chromium } = require(playwrightCorePath);
    const chromePath = resolveChrome();

    logFd = fs.openSync(SERVER_LOG, "w");
    server = spawn(
      process.execPath,
      [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT), "--hostname", "127.0.0.1"],
      { cwd: ROOT, stdio: ["ignore", logFd, logFd] },
    );
    await waitForServer(180000);

    const launchOptions = { headless: true };
    if (chromePath) launchOptions.executablePath = chromePath;
    else launchOptions.channel = "chrome";
    browser = await chromium.launch(launchOptions);
    try {
      await runChecks(browser, EVIDENCE);
    } finally {
      await browser.close();
      browser = null;
    }
  } catch (error) {
    fatal = error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && !server.killed) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        server.kill("SIGTERM");
      }
    }
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* 已关闭 */
      }
    }
    if (routeCreated) cleanupRoute();
  }

  const failed = results.filter((entry) => !entry.ok);
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify(results, null, 2), "utf8");
  for (const entry of results) {
    console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.ok ? "" : ` :: ${entry.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`evidence: ${EVIDENCE}`);
  if (fatal) {
    console.error("SCRIPT_ERROR", fatal);
    if (fs.existsSync(SERVER_LOG)) {
      const tail = fs.readFileSync(SERVER_LOG, "utf8").split("\n").slice(-20).join("\n");
      console.error(`--- server log tail ---\n${tail}`);
    }
    process.exit(2);
  }
  process.exit(failed.length === 0 ? 0 : 1);
})();
