const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--base-url" || token === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error(`缺少 ${token} 的值`);
      args[token.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

const ARGS = parseArgs(process.argv.slice(2));
if (!ARGS["base-url"]) {
  console.error(
    "用法: node check-class-evidence-ui.cjs --base-url http://127.0.0.1:<port>/guide-preview-class [--out <目录>]",
  );
  process.exit(2);
}
const BASE_URL = ARGS["base-url"];
const EVIDENCE = path.resolve(ARGS.out || path.join(os.tmpdir(), "g4-class-evidence-ui-check"));
fs.mkdirSync(EVIDENCE, { recursive: true });

/** 项目不新增依赖：playwright-core 由验收环境提供（PLAYWRIGHT_CORE_DIR / 邻近 node_modules） */
function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_CORE_DIR) {
    candidates.push(path.join(process.env.PLAYWRIGHT_CORE_DIR, "playwright-core"));
  }
  candidates.push(path.join(__dirname, "node_modules", "playwright-core"));
  candidates.push(path.join(__dirname, "..", "..", "node_modules", "playwright-core"));
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* 继续尝试下一个位置 */
    }
  }
  try {
    return require("playwright-core");
  } catch {
    console.error(
      [
        "缺少 playwright-core（项目不新增依赖，需由验收环境提供）：",
        "  1) 临时安装到独立目录：pnpm --dir <scratch> add playwright-core@1.63.0",
        "  2) 运行时指定 -PlaywrightCoreDir <scratch>/node_modules 或设置 PLAYWRIGHT_CORE_DIR",
      ].join("\n"),
    );
    process.exit(2);
  }
}

const { chromium } = loadPlaywright();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
}
function snap(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

const OVERVIEW = "[data-testid=class-evidence-overview]";
const MAIN_ITEM = "item.ui.language.l1.3-4";
const EMPTY_ITEM = "item.ui.language.l1.4-5";
const HEALTH_REF_ITEM = "item.ui.health.h2.4-5";
const PARTIAL_ITEM = "item.ui.social.s1.4-5";
const UNAVAILABLE_ITEM = "item.ui.science.sc1.5-6";
const ARTS_ITEM = "item.ui.arts.a1.3-4";

async function openPage(browser, viewport, options = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: options.reducedMotion });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on("console", (msg) => {
    console.log(`[BROWSER ${msg.type().toUpperCase()}]`, msg.text(), JSON.stringify(msg.location()));
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      console.log("[FAILED RES]", res.status(), res.url());
    }
  });
  page.on("pageerror", (err) => console.error("[BROWSER PAGE_ERROR]", err.message, err.stack));
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForSelector(OVERVIEW + "[data-client-ready=true]", { timeout: 180000 });
  if (options.expandGroups !== false) {
    for (const group of await page.locator("details[data-goal-id]").all()) {
      if (await group.getAttribute("open") === null) await group.locator(":scope > summary").click();
    }
    const references = page.locator("[data-testid=reference-library]");
    if (await references.count() && await references.getAttribute("open") === null) await references.locator(":scope > summary").click();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
  return { context, page };
}

async function openScenario(browser, name) {
  const { context, page } = await openPage(browser, { width: 1440, height: 900 });
  const btn = page.getByRole("button", { name });
  await btn.click();
  await page.waitForTimeout(600);
  const ev = await lastEvent(page, "scenario");
  console.log("SCENARIO EVENT AFTER CLICK", name, ":", JSON.stringify(ev));
  return { context, page };
}

async function lastEvent(page, label) {
  return page.evaluate((wanted) => (window.__g4events || []).filter((e) => e.label === wanted).at(-1), label);
}

async function eventCount(page) {
  return page.evaluate(() => (window.__g4events || []).length);
}

async function textOr(locator, fallback) {
  return (await locator.count()) ? locator.innerText() : Promise.resolve(fallback);
}

/** 等待展开面板动画结束（opacity 到 1 或动画被减少动态关闭），避免截到半透明中间态 */
async function waitPanelSettled(page) {
  await page
    .waitForFunction(
      () => {
        const panels = document.querySelectorAll("[id^='class-evidence-panel-']");
        return [...panels].every((panel) => {
          const style = getComputedStyle(panel);
          return style.animationName === "none" || Number(style.opacity) >= 1;
        });
      },
      undefined,
      { timeout: 3000 },
    )
    .catch(() => {});
}

async function togglePanel(page, locator) {
  const goal = locator.locator("xpath=ancestor::details[@data-goal-id]");
  if (await goal.count() && await goal.getAttribute("open") === null) await goal.locator(":scope > summary").click();
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click();
  await waitPanelSettled(page);
  await page.waitForTimeout(200);
}

async function capture(page, fileName) {
  await waitPanelSettled(page);
  await page.screenshot({ path: path.join(EVIDENCE, fileName), fullPage: true });
}

async function auditViewport(browser, width, height, label) {
  const { context, page } = await openPage(browser, { width, height }, { expandGroups: false });
  const groups = page.locator("details[data-goal-id]");
  check(`${label}: 默认只展开首个目标`, await groups.count() > 1 && await groups.locator("[data-testid=goal-disclosure]").count() === await groups.count() && await page.locator("details[data-goal-id][open]").count() === 1);
  const overflow = await page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const overview = document.querySelector("[data-testid=class-evidence-overview]");
    return {
      docScroll: doc.scrollWidth,
      inner: window.innerWidth,
      overviewScroll: overview ? overview.scrollWidth : 0,
      overviewClient: overview ? overview.clientWidth : 0,
    };
  });
  check(
    `${label}: 无横向溢出`,
    overflow.docScroll <= overflow.inner + 1 && overflow.overviewScroll <= overflow.overviewClient + 1,
    JSON.stringify(overflow),
  );

  const smallTargets = await page.evaluate(() => {
    const nodes = document.querySelectorAll(
      "[data-testid=class-evidence-overview] button, [data-testid=class-evidence-overview] select, [data-testid=class-evidence-overview] input, [data-testid=class-evidence-overview] summary",
    );
    return [...nodes]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        testid: el.dataset.testid || "",
        h: Math.round(el.getBoundingClientRect().height * 10) / 10,
      }))
      .filter((entry) => entry.h < 43.5);
  });
  check(`${label}: 核心目标 ≥44px`, smallTargets.length === 0, JSON.stringify(smallTargets));

  await capture(page, `main-${label}.png`);
  await context.close();
}

(async () => {
  const chromeCandidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const launchOptions = { headless: true };
  for (const candidate of chromeCandidates) {
    if (fs.existsSync(candidate)) {
      launchOptions.executablePath = candidate;
      break;
    }
  }
  if (!launchOptions.executablePath) launchOptions.channel = "chrome";
  const browser = await chromium.launch(launchOptions);

  try {
    await auditViewport(browser, 1440, 900, "1440x900");
    await auditViewport(browser, 1024, 900, "1024x900");
    await auditViewport(browser, 768, 1024, "768x1024");
    await auditViewport(browser, 390, 844, "390x844");

    const { context, page } = await openPage(browser, { width: 1440, height: 900 });

    /* ---- 头部、口径与通知 ---- */
    await page.locator("[data-testid=stats-help-button]").click();
    const methods = await page.locator("[data-testid=stats-help-content]").innerText();
    const summary = (await page.locator("[data-testid=class-summary]").innerText()) + " " + methods;
    check("摘要含当前在班名单 20 人", summary.includes("当前在班名单") && summary.includes("20 人"), snap(summary));
    check("摘要含统计期间", summary.includes("2026-2027学年第一学期") && summary.includes("含首尾"), "");
    check("摘要含指南参考年龄", summary.includes("全部年龄段"), "");
    const overviewText = await page.locator(OVERVIEW).innerText();
    check("班级名与学年展示", overviewText.includes("太阳花融合教育实验中二班") && overviewText.includes("2026-2027学年"), "");
    check("历史期间口径提示", methods.includes("不能还原历史名册"), "");
    check("期间外证据为正常口径", methods.includes("所选期间之外的证据不计入本次统计") && methods.includes("不属于数据问题"), "");
    await page.locator("[data-testid=stats-help-button]").click();
    await page.locator("details").filter({ has: page.getByText("有些记录暂时无法核对 · 查看说明", { exact: true }) }).locator("summary").click();
    const notices = await page.locator("[data-testid=class-notice]").allTextContents();
    const noticeCodes = await page.$$eval("[data-testid=class-notice]", (els) => els.map((el) => el.dataset.code));
    check("通知数量与环境", notices.length === 5, noticeCodes.join(","));
    check("转班前来源与排除理由按通知展示", notices.some((t) => t.includes("转入前的小班班级") && t.includes("按发生班级保留并计入")), "");
    check("不可读记录按通知直显", notices.some((t) => t.includes("暂时无法读取")), "");

    /* ---- 全领域目标定位 ---- */
    const goalGroupCount = await page.locator(`${OVERVIEW} [data-testid=goal-group]`).count();
    const goalPathCount = await page.locator(`${OVERVIEW} [data-testid=goal-path]`).count();
    const firstGoalPath = goalPathCount > 0 ? await page.locator(`${OVERVIEW} [data-testid=goal-path]`).first().innerText() : "";
    check("全领域下每个目标组有定位", goalGroupCount > 0 && goalPathCount === goalGroupCount, `groups=${goalGroupCount} paths=${goalPathCount}`);
    check("目标定位含领域与子领域", firstGoalPath.includes("健康") && firstGoalPath.includes("生活习惯与生活能力"), firstGoalPath);

    /* ---- 保健参考 reliable：收起/展开 ---- */
    const healthRef = page.locator(`[data-item-id="${HEALTH_REF_ITEM}"]`);
    const healthRefPanel = page.locator(`[id="class-evidence-panel-${HEALTH_REF_ITEM}"]`);
    const healthRefCollapsed = snap(await healthRef.innerText());
    check("保健参考为体态/身高体重示意", healthRefCollapsed.includes("身高") && healthRefCollapsed.includes("体重"), healthRefCollapsed);
    check("保健参考不渲染行为分布", (await healthRef.locator("[data-testid=item-distribution]").count()) === 0, "");
    check("保健参考不显示占比行", (await healthRef.locator("[data-testid=item-ratio]").count()) === 0, "");
    check("保健参考无百分比", !healthRefCollapsed.includes("%"), healthRefCollapsed);
    check("保健参考显示参考说明", (await healthRef.locator("[data-testid=reference-note]").count()) === 1 && healthRefCollapsed.includes("不参与行为表现统计"), "");
    check("reliable 参考无可靠性警告", (await healthRef.locator("[data-testid=reference-caveat]").count()) === 0, "");
    check("保健参考收起态无达成式状态徽章", !/(已确认观察到|已有相关线索|暂无相关记录)/.test(healthRefCollapsed), healthRefCollapsed);
    await togglePanel(page, healthRef.locator("[data-testid=item-disclosure]"));
    const healthRefExpanded = snap(await healthRefPanel.innerText());
    check("保健参考展开无三类行为分组", (await healthRefPanel.locator("[data-testid=status-group]").count()) === 0, "");
    check("保健参考展开无成人帮助确认规则", !healthRefExpanded.includes("成人帮助") && !healthRefExpanded.includes("帮助后可确认表现"), "");
    check("保健参考展开无达成式状态徽章", !/(已确认观察到|已有相关线索|暂无相关记录)/.test(healthRefExpanded), healthRefExpanded);
    check("保健参考提供已核验查阅列表", (await healthRefPanel.locator("[data-testid=reference-records]").count()) === 1, "");
    check("保健参考查阅行可用", (await healthRefPanel.locator("[data-testid=reference-records] [data-testid=child-row]").count()) > 0, "");
    check("保健参考待核对建议单独列出", (await healthRefPanel.locator("[data-testid=reference-pending]").count()) === 1, "");
    check("待核对建议明示未成为资料", healthRefExpanded.includes("尚未成为已核验资料") && healthRefExpanded.includes("不计入已核验资料"), "");
    check("待核对行使用工作流标签而非状态徽章", (await healthRefPanel.locator("[data-testid=reference-pending] [data-testid=child-pending-chip]").count()) === 1 && (await healthRefPanel.locator("[data-testid=reference-pending] [data-testid=child-status-badge]").count()) === 0, "");
    await capture(page, "health-reference-expanded-1440.png");
    await togglePanel(page, healthRef.locator("[data-testid=item-disclosure]"));

    /* ---- reliable 20 人 6/4/10 主条目 ---- */
    const main = page.locator(`[data-item-id="${MAIN_ITEM}"]`);
    const mainPanel = page.locator(`[id="class-evidence-panel-${MAIN_ITEM}"]`);
    check("主条目 reliability=reliable", (await main.getAttribute("data-reliability")) === "reliable", "");
    check("主条目 ratio=0.3（DTO 原样）", (await main.getAttribute("data-ratio")) === "0.3", "");
    const mainLegend = snap(await main.locator("[data-testid=item-distribution]").innerText());
    check("可靠条目完整三类分布 6/4/10", mainLegend.includes("已确认观察到 6 人") && mainLegend.includes("已有相关线索 4 人") && mainLegend.includes("暂无相关记录 10 人"), mainLegend);
    check("分布条有 3 段（非饼图）", (await main.locator("[data-testid=distribution-segment]").count()) === 3, "");
    const mainRatio = await main.locator("[data-testid=item-ratio]").innerText();
    check("占比同时显示 X/N 人与期间", mainRatio.includes("30%") && mainRatio.includes("6/20 人") && mainRatio.includes("2026-2027学年第一学期"), mainRatio);
    const emptyRatio = await page.locator(`[data-item-id="${EMPTY_ITEM}"] [data-testid=item-ratio]`).innerText();
    check("全部无记录显示 0%（0/20 人）", emptyRatio.includes("0%（0/20 人"), emptyRatio);
    check("暂无相关记录不是“不会”", !/不会/.test(await page.locator(OVERVIEW).innerText()), "");

    /* ---- partial：不画完整三类分布，只给可核验依据摘要 ---- */
    const partial = page.locator(`[data-item-id="${PARTIAL_ITEM}"]`);
    const partialPanel = page.locator(`[id="class-evidence-panel-${PARTIAL_ITEM}"]`);
    check("partial 条目 reliability=partial", (await partial.getAttribute("data-reliability")) === "partial", "");
    check("partial 不渲染完整三类分布", (await partial.locator("[data-testid=item-distribution]").count()) === 0, "");
    check("partial 显示可核验依据摘要", (await partial.locator("[data-testid=partial-verified-summary]").count()) === 1, "");
    const partialSummary = snap(await textOr(partial.locator("[data-testid=partial-verified-summary]"), ""));
    check(
      "partial 摘要含分母与可确认表现/线索下限",
      partialSummary.includes("在班名单 20 人") && partialSummary.includes("已确认观察到 3 人") && partialSummary.includes("已有相关线索 2 人") && partialSummary.includes("可确认下限"),
      partialSummary,
    );
    check("partial 摘要不把含未知的 no_records 说成已核验无记录", !/暂无相关记录\s*\d+\s*人/.test(partialSummary) && !partialSummary.includes("15 人"), partialSummary);
    check("partial 摘要明示其余暂无法确认", partialSummary.includes("暂无法确认"), "");
    check("partial 占比为 null 不显示 0%", (await partial.getAttribute("data-ratio")) === "null" && !(await partial.locator("[data-testid=item-ratio]").innerText()).includes("%"), "");
    check("partial 不把期间排除描述成完整性失败", !snap(await partial.innerText()).includes("不在统计期间"), "");
    check("可靠条目仍保持完整分布（恢复 reliable 对照）", (await main.locator("[data-testid=item-distribution]").count()) === 1 && (await main.locator("[data-testid=distribution-segment]").count()) === 3, "");

    /* ---- unavailable 收起态 ---- */
    const unavailable = page.locator(`[data-item-id="${UNAVAILABLE_ITEM}"]`);
    const unavailablePanel = page.locator(`[id="class-evidence-panel-${UNAVAILABLE_ITEM}"]`);
    check("unavailable 条目不渲染分布条", (await unavailable.locator("[data-testid=item-distribution]").count()) === 0, "");
    const unavailableText = snap(await unavailable.innerText());
    check("unavailable 显示核验提示", unavailableText.includes("相关记录暂时无法读取") && unavailableText.includes("不能按「暂无相关记录」理解"), "");
    check("unavailable 保留名单分母", unavailableText.includes("20 人仍作为分母保留"), "");
    await togglePanel(page, unavailable.locator("[data-testid=item-disclosure]"));
    const unavailablePanelText = snap(await unavailablePanel.innerText());
    check("unavailable 展开无普通状态分组", (await unavailablePanel.locator("[data-testid=status-group]").count()) === 0, "");
    check("unavailable 展开无普通暂无分组", !unavailablePanelText.includes("暂无相关记录 20 人"), unavailablePanelText.slice(0, 220));
    check("unavailable 展开有受限名单", (await unavailablePanel.locator("[data-testid=restricted-group]").count()) === 1, "");
    check("unavailable 保留当前名单与入口", (await unavailablePanel.locator("[data-testid=restricted-group] [data-testid=child-row]").count()) === 20 && (await unavailablePanel.locator("[data-testid=open-child-item]").count()) === 20, "");
    await capture(page, "unavailable-expanded-1440.png");
    await togglePanel(page, unavailable.locator("[data-testid=item-disclosure]"));

    const disc = partial.locator("[data-testid=item-disclosure]");
    await disc.scrollIntoViewIfNeeded().catch(() => {});
    const box = await disc.boundingBox();
    const hit = await page.evaluate((b) => {
      if (!b) return null;
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return el ? { tag: el.tagName, className: el.className, testid: el.dataset.testid, text: el.innerText?.slice(0, 50) } : null;
    }, box);
    await togglePanel(page, partial.locator("[data-testid=item-disclosure]"));
    const mixedGroups = await partialPanel.locator("[data-testid=status-group]").evaluateAll((els) =>
      els.map((el) => `${el.dataset.status}:${el.querySelectorAll("[data-testid=child-row]").length}`),
    );
    console.log("MIXED GROUPS:", mixedGroups);
    check("partial 普通三组名单", mixedGroups.join(",") === "confirmed_observed:3,has_clues:2,no_records:13", mixedGroups.join(","));
    check("partial 明示普通名单只覆盖已读取记录", (await partialPanel.locator("[data-testid=partial-list-limit]").count()) === 1 && snap(await partialPanel.innerText()).includes("只覆盖已读取记录"), "");
    const noRecordsHeading = snap(await partialPanel.locator('[data-testid=status-group][data-status=no_records] h4').innerText());
    check("partial 无记录组标注已读取范围", noRecordsHeading.includes("暂无相关记录（已读取范围）"), noRecordsHeading);
    const ordinaryNoRecords = await partialPanel.locator('[data-testid=status-group][data-status=no_records] [data-testid=child-row]').evaluateAll((els) => els.map((el) => el.dataset.reliability));
    check("普通无记录组不含不可读取/受限幼儿", ordinaryNoRecords.length === 13 && ordinaryNoRecords.every((r) => r === "reliable"), ordinaryNoRecords.join(","));
    const observedPartial = partialPanel.locator('[data-testid=status-group][data-status=confirmed_observed] [data-testid=child-row][data-reliability=partial]');
    check("partial 可核验表现仍展示并带限制", (await observedPartial.count()) === 1 && snap(await observedPartial.innerText()).includes("可确认下限"), "");
    check("partial 混合条目有受限分组", (await partialPanel.locator("[data-testid=restricted-group]").count()) === 1, "");
    const restrictedRows = await partialPanel.locator("[data-testid=restricted-group] [data-testid=child-row]").evaluateAll((els) =>
      els.map((el) => ({ status: el.dataset.status, reliability: el.dataset.reliability })),
    );
    check(
      "受限名单覆盖不可读取与 partial+no_records",
      restrictedRows.length === 2 &&
        restrictedRows.some((r) => r.reliability === "unavailable") &&
        restrictedRows.some((r) => r.reliability === "partial" && r.status === "no_records"),
      JSON.stringify(restrictedRows),
    );
    check("受限行无普通状态徽章", (await partialPanel.locator("[data-testid=restricted-group] [data-testid=child-status-badge]").count()) === 0, "");
    check("受限分组不把未知画成普通暂无", (await partialPanel.locator("[data-testid=restricted-group] [data-testid=child-restricted-chip]").count()) === 2 && !/暂无相关记录（已读取范围）/.test(snap(await partialPanel.locator("[data-testid=restricted-group]").innerText())), "");
    await capture(page, "mixed-partial-expanded-1440.png");
    await togglePanel(page, partial.locator("[data-testid=item-disclosure]"));

    /* ---- reliable 展开三类名单 + 键盘 + 回调 ---- */
    await togglePanel(page, main.locator("[data-testid=item-disclosure]"));
    const groupCounts = await mainPanel.locator("[data-testid=status-group]").evaluateAll((els) =>
      els.map((el) => `${el.dataset.status}:${el.querySelectorAll("[data-testid=child-row]").length}`),
    );
    check("reliable 各组人数 6/4/10", groupCounts.join(",") === "confirmed_observed:6,has_clues:4,no_records:10", groupCounts.join(","));
    check("名单覆盖全部 20 人", (await mainPanel.locator("[data-testid=child-row]").count()) === 20, "");
    check("多记录按幼儿去重（1 人计 2 条）", (await mainPanel.locator('[data-child-id$="-01"]').innerText()).includes("计入证据 2 条"), "");
    const pendingRow = mainPanel.locator('[data-child-id$="-20"]');
    check("待核对不计入正式状态", (await pendingRow.getAttribute("data-status")) === "no_records" && (await pendingRow.innerText()).includes("AI 关联待核对 1 条（不计入人数）"), "");
    check("展开面板不捏造来源细节", (await mainPanel.locator("blockquote").count()) === 0 && snap(await mainPanel.innerText()).includes("可进入个人证据册核对相关记录"), "");
    await main.locator("[data-testid=item-disclosure]").focus();
    await page.keyboard.press("Enter");
    check("键盘 Enter 收起", (await main.locator("[data-testid=item-disclosure]").getAttribute("aria-expanded")) === "false", "");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "select-child-record");
    await page.keyboard.press("Tab");
    const focusedTestId = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") || document.activeElement?.tagName);
    check("展开后 Tab 焦点进入名单操作", focusedTestId === "open-child-item", String(focusedTestId));
    const firstChildRow = mainPanel.locator("[data-testid=status-group][data-status=confirmed_observed] [data-testid=child-row]").first();
    await firstChildRow.locator("[data-testid=open-child-item]").click();
    const drilldown = await lastEvent(page, "drilldown");
    check("钻取回调：儿童 + 条目 + 同一筛选范围", drilldown && drilldown.payload.child_id === "fixture-class-mid2-child-01" && drilldown.payload.item_id === MAIN_ITEM && drilldown.payload.scope.label === "2026-2027学年第一学期", JSON.stringify(drilldown));
    await capture(page, "expanded-1440.png");

    /* 目标折叠不留下独立详情，也不删除其他参考年龄条目。 */
    const mainGoal = main.locator("xpath=ancestor::details[@data-goal-id]");
    const goalSummary = mainGoal.locator(":scope > summary");
    await goalSummary.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-current-item-id="item.ui.language.l1.3-4"]') === null);
    check("目标可用键盘收起", await mainGoal.getAttribute("open") === null);
    check("收起目标同步关闭独立详情", await mainPanel.count() === 0);
    await page.keyboard.press("Enter");
    check("重新展开保留跨年龄条目", await mainGoal.locator("[data-testid=class-evidence-item]").count() === 2);
    check("重新展开人数比例未改变且不自动打开名单", await main.getAttribute("data-ratio") === "0.3" && await main.locator("[data-testid=item-disclosure]").getAttribute("aria-expanded") === "false");
    await togglePanel(page, main.locator("[data-testid=item-disclosure]"));

    /* ---- 期间受控（保留 R1 场景） ---- */
    await page.locator("[data-testid=scope-select]").selectOption("custom_range");
    check("草稿态选择器仍显示已应用期间", (await page.locator("[data-testid=scope-select]").inputValue()) === "semester:2026-2027-1", "");
    check("草稿态显示未应用说明", (await page.locator("[data-testid=range-pending]").count()) === 1, "");
    await page.locator("[data-testid=cancel-range]").click();
    check("取消后仍为实际期间", (await page.locator("[data-testid=scope-select]").inputValue()) === "semester:2026-2027-1", "");
    await page.locator("[data-testid=scope-select]").selectOption("custom_range");
    await page.locator("[data-testid=range-from]").fill("");
    const beforeMissing = await eventCount(page);
    await page.locator("[data-testid=apply-range]").click();
    check("缺失日期提示且不发意图", snap(await page.locator(`${OVERVIEW} [role=alert]`).innerText()).includes("请选择开始和结束日期") && (await eventCount(page)) === beforeMissing, "");
    await page.locator("[data-testid=range-from]").fill("2026-06-01");
    await page.locator("[data-testid=range-to]").fill("2026-05-01");
    const beforeReversed = await eventCount(page);
    await page.locator("[data-testid=apply-range]").click();
    check("倒序区间提示且不发意图", snap(await page.locator(`${OVERVIEW} [role=alert]`).innerText()).includes("开始日期不能晚于结束日期") && (await eventCount(page)) === beforeReversed, "");
    await page.locator("[data-testid=range-from]").fill("2026-05-01");
    await page.locator("[data-testid=range-to]").fill("2026-06-01");
    await page.locator("[data-testid=apply-range]").click();
    await page.waitForTimeout(200);
    const customEvent = await lastEvent(page, "scope");
    check("自定义日期回调", customEvent && customEvent.payload.kind === "custom_range" && customEvent.payload.from === "2026-05-01", JSON.stringify(customEvent));
    check("应用后摘要期间一致", (await page.locator("[data-testid=scope-select]").inputValue()) === "custom_range", "");
    await mainPanel.locator('[data-testid=status-group][data-status=confirmed_observed] [data-testid=open-child-item]').first().click();
    const customDrilldown = await lastEvent(page, "drilldown");
    check("钻取携带已应用自定义期间", customDrilldown && customDrilldown.payload.scope.start_date === "2026-05-01" && customDrilldown.payload.scope.end_date === "2026-06-01", JSON.stringify(customDrilldown && customDrilldown.payload.scope));
    await page.locator("[data-testid=scope-select]").selectOption("custom_range");
    await page.getByRole("button", { name: "历史期间" }).click();
    await page.waitForTimeout(150);
    check("custom_range → semester：选择器/摘要一致", (await page.locator("[data-testid=scope-select]").inputValue()) === "semester:2025-2026-1" && (await page.locator("[data-testid=scope-select] option:checked").innerText()).includes("2025-2026学年第一学期"), "");
    await page.locator("[data-testid=scope-select]").selectOption("all_history");
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: "历史期间" }).click();
    await page.waitForTimeout(150);
    check("all_history → semester：选择器显示实际期间", (await page.locator("[data-testid=scope-select]").inputValue()) === "semester:2025-2026-1", "");
    await page.locator("[data-testid=accept-intent-toggle]").click();
    const beforeReject = await eventCount(page);
    await page.locator("[data-testid=scope-select]").selectOption("semester:2026-2027-1");
    await page.waitForTimeout(150);
    check("父级拒绝：意图已发出但展示不变", (await eventCount(page)) === beforeReject + 1 && (await page.locator("[data-testid=scope-select]").inputValue()) === "semester:2025-2026-1", "");
    await page.locator("[data-testid=accept-intent-toggle]").click();

    /* ---- goal_id 与领域筛选 ---- */
    await page.getByRole("button", { name: "目标筛选" }).click();
    await page.waitForTimeout(150);
    const goalFilter = page.locator("[data-testid=goal-filter]");
    check("goal_id 生效时显示目标筛选条", (await goalFilter.count()) === 1 && (await goalFilter.getAttribute("data-goal-id")) === "goal.ui.language.1", "");
    await page.locator("[data-testid=clear-goal-filter]").click();
    await page.waitForTimeout(150);
    check("清除目标筛选回调 goal_id=null", (await lastEvent(page, "filters"))?.payload.goal_id === null, "");
    await page.getByRole("button", { name: "20 人班级" }).click();
    await page.waitForTimeout(150);
    await page.locator('[data-domain="language"]').click();
    await page.waitForTimeout(150);
    const languageIds = await page.$$eval("[data-testid=class-evidence-item]", (els) => els.map((el) => el.dataset.itemId));
    check("领域筛选后只显示语言条目", languageIds.length === 2 && languageIds.every((id) => id.startsWith("item.ui.language")), languageIds.join(","));
    await page.locator('[data-age-band="4-5"]').click();
    await page.waitForTimeout(150);
    const ageIds = await page.$$eval("[data-testid=class-evidence-item]", (els) => els.map((el) => el.dataset.itemId));
    check("参考年龄段筛选生效", ageIds.length === 1 && ageIds[0] === EMPTY_ITEM, ageIds.join(","));
    const bodyText = await page.locator("body").innerText();
    check("无达标率/完成率/排名/雷达/能力总分", !/达标率|完成率|排名|雷达|能力总分|弱项/.test(bodyText), "");
    check("未出现生成班级 AI 方案按钮", !/生成.*班级.*(AI )?方案/.test(bodyText), "");
    await context.close();

    /* ---- 保健参考 × unavailable ---- */
    const refUnavailable = await openScenario(browser, "参考不可读");
    const ruItem = refUnavailable.page.locator(`[data-item-id="${HEALTH_REF_ITEM}"]`);
    const ruInspector = refUnavailable.page.locator(`[id="class-evidence-panel-${HEALTH_REF_ITEM}"]`);
    const ruCollapsed = snap(await ruItem.innerText());
    check("参考不可读：收起态保留说明与核验警告", ruCollapsed.includes("不参与行为表现统计") && ruCollapsed.includes("相关资料暂时无法读取") && ruCollapsed.includes("不能按「暂无相关资料」理解"), ruCollapsed);
    check("参考不可读：不渲染行为分布与占比", (await ruItem.locator("[data-testid=item-distribution]").count()) === 0 && (await ruItem.locator("[data-testid=item-ratio]").count()) === 0, "");
    await togglePanel(refUnavailable.page, ruItem.locator("[data-testid=item-disclosure]"));
    const ruPanel = snap(await ruInspector.innerText());
    check("参考不可读：展开不断言没有记录", !ruPanel.includes("还没有可供查阅") && (await ruInspector.locator("[data-testid=reference-empty]").count()) === 0, "");
    check("参考不可读：展开显示不可读提示与受限名单", (await ruInspector.locator("[data-testid=reference-unavailable]").count()) === 1 && (await ruInspector.locator("[data-testid=restricted-group] [data-testid=child-row]").count()) === 20, "");
    check("参考不可读：保留个人证据入口", (await ruInspector.locator("[data-testid=open-child-item]").count()) === 20, "");
    check("参考不可读：无行为三类分组或状态徽章", (await ruInspector.locator("[data-testid=status-group]").count()) === 0 && (await ruInspector.locator("[data-testid=child-status-badge]").count()) === 0, "");
    await capture(refUnavailable.page, "health-reference-unavailable-expanded-1440.png");
    await refUnavailable.context.close();

    /* ---- 保健参考 × partial ---- */
    const refPartial = await openScenario(browser, "参考核验受限");
    const rpItem = refPartial.page.locator(`[data-item-id="${HEALTH_REF_ITEM}"]`);
    const rpInspector = refPartial.page.locator(`[id="class-evidence-panel-${HEALTH_REF_ITEM}"]`);
    const rpCollapsed = snap(await rpItem.innerText());
    check("参考 partial：收起态提示只反映已核对范围", rpCollapsed.includes("部分资料未通过核对或无法读取") && rpCollapsed.includes("只反映已读取并核对的资料范围"), rpCollapsed);
    await togglePanel(refPartial.page, rpItem.locator("[data-testid=item-disclosure]"));
    const rpPanel = snap(await rpInspector.innerText());
    check("参考 partial：已核验资料与受限名单并存", (await rpInspector.locator("[data-testid=reference-records] [data-testid=child-row]").count()) === 3 && (await rpInspector.locator("[data-testid=restricted-group] [data-testid=child-row]").count()) === 1, "");
    check("参考 partial：不断言不存在其他资料", rpPanel.includes("不代表不存在其他资料") && !rpPanel.includes("还没有可供查阅"), "");
    check("参考 partial：无行为分布与状态徽章", (await rpItem.locator("[data-testid=item-distribution]").count()) === 0 && (await rpInspector.locator("[data-testid=child-status-badge]").count()) === 0, "");
    await capture(refPartial.page, "health-reference-partial-expanded-1440.png");
    await refPartial.context.close();

    /* ---- 保健参考 × 仅待核对建议 ---- */
    const refPending = await openScenario(browser, "参考待核对");
    const rqItem = refPending.page.locator(`[data-item-id="${HEALTH_REF_ITEM}"]`);
    const rqInspector = refPending.page.locator(`[id="class-evidence-panel-${HEALTH_REF_ITEM}"]`);
    check("参考待核对：条目顶部工作流提示不计入人数", snap(await rqItem.innerText()).includes("AI 关联待核对 1 条（不计入人数）"), "");
    await togglePanel(refPending.page, rqItem.locator("[data-testid=item-disclosure]"));
    const rqPanel = snap(await rqInspector.innerText());
    check("参考待核对：待核对建议单独列出", (await rqInspector.locator("[data-testid=reference-pending] [data-testid=child-row]").count()) === 1, "");
    check("参考待核对：确定性空态不掩盖待核对", (await rqInspector.locator("[data-testid=reference-empty]").count()) === 0 && !rqPanel.includes("还没有可供查阅"), "");
    check("参考待核对：建议不冒充已核验资料", rqPanel.includes("尚未成为已核验资料") && (await rqItem.locator("[data-testid=child-reference-chip]").count()) === 0, "");
    check("参考待核对：无行为分布与状态徽章", (await rqItem.locator("[data-testid=item-distribution]").count()) === 0 && (await rqInspector.locator("[data-testid=child-status-badge]").count()) === 0, "");
    await capture(refPending.page, "health-reference-pending-expanded-1440.png");
    await refPending.context.close();

    /* ---- 空名单 ---- */
    const emptyRoster = await openPage(browser, { width: 1440, height: 900 });
    await emptyRoster.page.getByRole("button", { name: "空名单" }).click();
    await emptyRoster.page.waitForTimeout(600);
    const ev = await lastEvent(emptyRoster.page, "scenario");
    console.log("EMPTY ROSTER EVENT:", JSON.stringify(ev));
    const emptyText = await emptyRoster.page.locator(OVERVIEW).innerText();
    check("空名单：0 人与原因说明", emptyText.includes("当前在班名单") && emptyText.includes("0 人") && !emptyText.includes("%"), "");
    check("空名单：empty_roster 通知", (await emptyRoster.page.locator('[data-testid=class-notice][data-code=empty_roster]').count()) === 1, "");
    check("空名单：无 NaN/Infinity/undefined", !/NaN|Infinity|undefined/.test(emptyText), "");
    await capture(emptyRoster.page, "empty-roster-1440.png");
    await emptyRoster.context.close();

    /* ---- 减少动态 ---- */
    const reduced = await openPage(browser, { width: 1440, height: 900 }, { reducedMotion: "reduce" });
    await togglePanel(reduced.page, reduced.page.locator(`[data-item-id="${MAIN_ITEM}"] [data-testid=item-disclosure]`));
    const motion = await reduced.page.evaluate(() => {
      const panel = document.querySelector("[id^='class-evidence-panel-']");
      const segment = document.querySelector("[data-testid=domain-tab]");
      return { animation: panel ? getComputedStyle(panel).animationName : "missing", transition: segment ? getComputedStyle(segment).transitionDuration : "missing" };
    });
    check("减少动态：面板无动画", motion.animation === "none", JSON.stringify(motion));
    check("减少动态：筛选按钮无过渡", motion.transition === "0s", JSON.stringify(motion));
    await reduced.context.close();

    /* ---- 390 窄屏 ---- */
    const narrow = await openPage(browser, { width: 390, height: 844 });
    const toggle = narrow.page.locator("[data-testid=info-notice-toggle]");
    check("390：提示汇总入口可见且含数量", (await toggle.isVisible()) && snap(await textOr(toggle, "")).includes("其他提示 3 条"), "");
    await narrow.page.locator("details").filter({ has: narrow.page.getByText("有些记录暂时无法核对 · 查看说明", { exact: true }) }).locator("summary").click();
    check("390：warning/error 可按汇总入口查看", (await narrow.page.locator("[data-testid=class-notice][data-code=basis_invalid]").isVisible()) && (await narrow.page.locator("[data-testid=class-notice][data-code=guide_evidence_unreadable]").isVisible()), "");
    check("390：info 通知默认收起", !(await narrow.page.locator('[data-testid=class-notice][data-code=out_of_stage_evidence]').isVisible()), "");
    if (await toggle.count()) {
      await toggle.click();
      await narrow.page.waitForTimeout(100);
    }
    check("390：展开后 info 通知可见", await narrow.page.locator('[data-testid=class-notice][data-code=out_of_stage_evidence]').isVisible(), "");
    await capture(narrow.page, "narrow-390-notices.png");
    const arts = narrow.page.locator(`[data-item-id="${ARTS_ITEM}"]`);
    await togglePanel(narrow.page, arts.locator("[data-testid=item-disclosure]"));
    const narrowOverflow = await narrow.page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement;
      const overview = document.querySelector("[data-testid=class-evidence-overview]");
      return { doc: doc.scrollWidth, inner: window.innerWidth, overview: overview.scrollWidth, overviewClient: overview.clientWidth };
    });
    check("390 长文本展开无横向溢出", narrowOverflow.doc <= narrowOverflow.inner + 1 && narrowOverflow.overview <= narrowOverflow.overviewClient + 1, JSON.stringify(narrowOverflow));
    await capture(narrow.page, "narrow-longtext-390.png");
    await narrow.context.close();

    /* ---- 768 ---- */
    const tablet = await openPage(browser, { width: 768, height: 1024 });
    await togglePanel(tablet.page, tablet.page.locator(`[data-item-id="${MAIN_ITEM}"] [data-testid=item-disclosure]`));
    const tabletOverflow = await tablet.page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement;
      const overview = document.querySelector("[data-testid=class-evidence-overview]");
      return { doc: doc.scrollWidth, inner: window.innerWidth, overview: overview.scrollWidth, overviewClient: overview.clientWidth };
    });
    check("768 展开名单无横向溢出", tabletOverflow.doc <= tabletOverflow.inner + 1 && tabletOverflow.overview <= tabletOverflow.overviewClient + 1, JSON.stringify(tabletOverflow));
    await capture(tablet.page, "tablet-expanded-768.png");
    await tablet.context.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify(results, null, 2), "utf8");
  for (const entry of results) {
    console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.ok ? "" : ` :: ${entry.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error("SCRIPT_ERROR", error);
  process.exit(2);
});
