#!/usr/bin/env node
/**
 * YAYA-UI1 浏览器 fixture 验收（组件/交互层，不接真实 API/数据库/模型）。
 *
 * 用法：node scripts/acceptance/check-yaya-ui.cjs --base-url http://127.0.0.1:PORT/yaya-preview --out <dir>
 *
 * 由 runner 启动 next dev 并创建临时预览路由；本脚本只：
 * - 在浏览器网络层拦截 /api/yaya/** 返回自建 fixture；
 * - 在 1440×900 / 768×1024 / 390×844 检查布局、交互、安全渲染与回执语义；
 * - 输出 results.json 与截图。真实后端 / 真实模型 / 真机软键盘均 NOT_RUN。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
  return fallback;
}

const BASE_URL = argValue("--base-url", "http://127.0.0.1:3213/yaya-preview");
const OUT = path.resolve(argValue("--out", path.join(os.tmpdir(), "yaya-ui1-browser")));
const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "yaya", "__fixtures__", "yaya-ui-fixtures.json"), "utf8")
);

fs.mkdirSync(OUT, { recursive: true });

const results = [];
const consoleErrors = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` :: ${detail}`}`);
}
async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  } catch (error) {
    results.push({ name: `screenshot ${name}`, ok: false, detail: String(error) });
  }
}

function normalizePlaywrightDir(dir) {
  if (dir === undefined || dir === "") return undefined;
  if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  const candidate = path.join(dir, "playwright-core");
  if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  return dir;
}

function resolvePlaywrightCore() {
  const fromEnv = normalizePlaywrightDir(process.env.YAYA_PW_CORE);
  if (fromEnv !== undefined) return fromEnv;
  try {
    return path.dirname(require.resolve("playwright-core/package.json"));
  } catch {
    /* 项目未安装，使用验收环境临时目录 */
  }
  const candidates = [
    path.join(os.tmpdir(), "g3-browser-deps", "node_modules", "playwright-core"),
    path.join(os.tmpdir(), "g4-pw-core", "node_modules", "playwright-core"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 playwright-core：设置 YAYA_PW_CORE 或临时安装（不加入项目依赖）");
}

function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const scenario = {
  runs: "answer_stream",
  operations: "success",
  upload: "success",
  conversationsStatus: 200,
};

function routeHandler(route, request) {
  const url = new URL(request.url());
  const p = url.pathname;
  const method = request.method();
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const text = (body, status = 200, contentType = "text/plain") =>
    route.fulfill({ status, contentType, body });

  if (p === "/api/auth/status" && method === "GET") return json(FIXTURES.auth_status);
  if (p === "/api/yaya/conversations" && method === "GET") {
    if (scenario.conversationsStatus !== 200) {
      return json({ error: "identity_unavailable", message: "身份服务暂时不可用，请稍后重试。" }, scenario.conversationsStatus);
    }
    return json(FIXTURES.conversation_list);
  }
  if (p === "/api/yaya/conversations" && method === "POST") return json(FIXTURES.new_conversation, 201);
  if (/^\/api\/yaya\/conversations\/[^/]+\/runs$/.test(p)) {
    if (method === "GET") return json(FIXTURES.run_lookup_in_progress);
    const lines = FIXTURES[scenario.runs];
    return text(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, 200, "application/x-ndjson; charset=utf-8");
  }
  if (/^\/api\/yaya\/conversations\/[^/]+\/messages$/.test(p)) {
    if (method === "GET") return json(FIXTURES.history);
    return json(
      {
        message: FIXTURES.history.messages[0],
        conversation: { ...FIXTURES.history.conversation, revision: FIXTURES.history.conversation.revision + 1 },
        replayed: false,
      },
      201
    );
  }
  if (/^\/api\/yaya\/conversations\/[^/]+$/.test(p)) {
    if (method === "PATCH") return json({ conversation: FIXTURES.history.conversation });
    if (method === "DELETE") {
      return json({
        conversation: FIXTURES.history.conversation,
        detached_attachment_ids: [],
        unreferenced_attachment_ids: [],
      });
    }
    return json({ conversation: FIXTURES.history.conversation });
  }
  if (p === "/api/yaya/proposals" && method === "GET") return json(FIXTURES.proposal_projection);
  if (/^\/api\/yaya\/proposals\/[^/]+\/approval$/.test(p)) return json(FIXTURES.approval, 201);
  if (p === "/api/yaya/operations" && method === "GET") return json(FIXTURES.operations_query_saved);
  if (p === "/api/yaya/operations" && method === "POST") {
    return json(scenario.operations === "unverified" ? FIXTURES.operations_unverified : FIXTURES.operations_success);
  }
  if (p === "/api/yaya/uploads" && method === "POST") {
    if (scenario.upload === "fail") {
      return json({ error: "file_too_large", message: "单张图片不能超过 10MiB，请压缩后再上传。" }, 413);
    }
    return json(FIXTURES.upload_success);
  }
  if (/^\/api\/yaya\/uploads\/[^/]+\/content$/.test(p)) return json({ error: "not_found", message: "fixture 无图片字节" }, 404);
  return json({ error: "fixture_not_routed", message: "验收 fixture 未覆盖该请求" }, 404);
}

async function noHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  check(
    `${label}: 无横向溢出`,
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `${overflow.scrollWidth}>${overflow.clientWidth}`
  );
}

async function minTarget(page, selector, label, min = 44) {
  const box = await page.locator(selector).first().boundingBox().catch(() => null);
  check(`${label}: 触控目标 ≥${min}px`, box !== null && box.width >= min && box.height >= min, JSON.stringify(box));
}

async function selectFixtureConversation(page) {
  await page.locator('[aria-label="查看历史会话"]').click();
  await page.locator('[data-yaya-panel][data-state="open"]').getByText("积木区观察", { exact: false }).first().click();
  await page.locator('[aria-label="返回会话"]').click();
  await page.waitForSelector("text=帮我整理小满搭长桥的观察。", { timeout: 20000 });
}

async function openPanel(page, base, view = "panel") {
  await page.goto(`${base}?view=${view}`, { waitUntil: "domcontentloaded" });
  if (view === "panel") {
    await page.waitForSelector('[data-yaya-panel][data-state="open"]', { timeout: 30000 });
  } else {
    await page.waitForSelector("[data-yaya-review-panel]", { timeout: 30000 });
  }
  await page.waitForSelector('[data-yaya-thread], [data-yaya-review-panel], [data-yaya-thread-unavailable]', {
    timeout: 30000,
  });
}

async function sendMessage(page, text) {
  const input = page.locator("[data-yaya-composer-input]").first();
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function waitStream(page, selector, timeout = 20000) {
  await page.waitForSelector(selector, { timeout });
}

async function runPanelDesktop(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.route("**/api/**", routeHandler);
  const page = await context.newPage();
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/yaya/") && (response.status() < 200 || response.status() >= 300)) {
      console.log(`[http] ${response.status()} ${response.request().method()} ${url.pathname}${url.search}`);
    }
  });
  await openPanel(page, BASE_URL, "panel");
  await selectFixtureConversation(page);

  const historyText = await page.locator("[data-yaya-thread]").innerText();
  check("1440: 历史消息加载", historyText.includes("帮我整理小满搭长桥"));
  check("1440: metadata_only 图片不冒充可读", historyText.includes("仅保留元数据"));
  check("1440: 历史未知操作标记保留", historyText.includes("结果未知") || historyText.includes("按原操作"));
  await noHorizontalOverflow(page, "1440 panel");
  await minTarget(page, '[aria-label="关闭芽芽"]', "1440 关闭按钮");
  await minTarget(page, '[aria-label="发送"]', "1440 发送按钮");
  await shot(page, "1440-panel-history");

  // 1) 长答 + Markdown 安全
  scenario.runs = "answer_stream";
  await sendMessage(page, "小满搭积木很专注，帮我整理一下观察记录");
  await waitStream(page, "text=先说结论");
  const answerText = await page.locator("[data-yaya-thread]").innerText();
  check("1440: 长答完整呈现", answerText.includes("互不混淆") && answerText.includes("不等于发展结论"));
  const xssExecuted = await page.evaluate(() => window.__yayaXss === true);
  check("1440: 原始 HTML 未执行", xssExecuted === false);
  check("1440: script 文本按普通文本显示", answerText.includes("window.__yayaXss"));
  const dangerousLinks = await page.locator('a[href^="javascript:"]').count();
  check("1440: 危险协议链接不渲染", dangerousLinks === 0);
  const safeLink = await page.locator('a[href="https://example.com/guides"]').count();
  check("1440: https 链接正常渲染", safeLink >= 1);
  const expand = page.getByRole("button", { name: /展开全文/ }).first();
  check("1440: 长答提供展开全文", (await expand.count()) > 0);
  if ((await expand.count()) > 0) {
    await expand.click();
    await page.waitForSelector("text=收起", { timeout: 5000 });
    check("1440: 展开后可收起", true);
  }
  await shot(page, "1440-panel-long-answer");

  // 2) 结果未知 → 只查询原 operation
  scenario.runs = "receipt_unknown_stream";
  await sendMessage(page, "把刚才的观察保存一下");
  await waitStream(page, "[data-yaya-card=receipt]", 20000);
  const receiptText = await page.locator("[data-yaya-card=receipt]").first().innerText();
  check("1440: 未知回执不显示已保存", receiptText.includes("结果未知") && !receiptText.includes("已保存"));
  await page.locator("[data-yaya-card=receipt]").first().getByRole("button", { name: "重新读取核对" }).click();
  await page.waitForSelector("text=操作已保存", { timeout: 10000 });
  const rechecked = await page.locator("[data-yaya-card=receipt]").first().innerText();
  check("1440: 重读后按回执显示成功", rechecked.includes("操作已保存") && rechecked.includes("不代表幼儿发展达标"));
  await shot(page, "1440-panel-receipt-recheck");

  // 3) 上传失败：文字与其他内容保留
  scenario.upload = "fail";
  await page.setInputFiles('[data-yaya-panel][data-state="open"] input[type="file"]', {
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await page.waitForSelector("text=上传失败", { timeout: 10000 });
  const inputValue = await page.locator("[data-yaya-composer-input]").first().inputValue();
  await page.locator("[data-yaya-composer-input]").first().fill("这张图帮忙看看");
  check("1440: 上传失败保留文字", (await page.locator("[data-yaya-composer-input]").first().inputValue()).includes("帮忙看看"));
  await page.locator('[data-yaya-panel][data-state="open"] [data-yaya-attachment] [aria-label^="移除"]').first().click();
  await page.waitForTimeout(200);
  check(
    "1440: 可移除失败附件",
    (await page.locator('[data-yaya-panel][data-state="open"] [data-yaya-attachment]').count()) === 0,
    `input was ${JSON.stringify(inputValue)}`
  );
  await page.locator("[data-yaya-composer-input]").first().fill("");
  scenario.upload = "success";

  // 4) 提案 → 只提交选中且完整的项 → 回执成功
  scenario.runs = "proposal_stream";
  scenario.operations = "success";
  await sendMessage(page, "帮我分别记录小满和阿依的观察");
  await waitStream(page, "[data-yaya-proposal]", 20000);
  await page.waitForSelector("[data-yaya-proposal-item]", { timeout: 10000 });
  const items = await page.locator("[data-yaya-proposal-item]").count();
  check("1440: 多幼儿独立子卡", items === 2, String(items));
  const boxes = await page.locator("[data-yaya-proposal-item] [role=checkbox]").count();
  check("1440: 仅完整项可选（受限项无勾选框）", boxes === 1, String(boxes));
  const beforeText = await page.locator("[data-yaya-proposal]").first().innerText();
  check("1440: 确认前不画成功", !beforeText.includes("已保存（服务端回执核对一致）"));
  await page.locator("[data-yaya-proposal-item] [role=checkbox]").first().click();
  await page.getByRole("button", { name: /确认已选 1 条/ }).first().click();
  await page.waitForTimeout(3500);
  const afterText = await page.locator("[data-yaya-proposal]").first().innerText();
  check(
    "1440: 执行回执核验后才显示已保存",
    afterText.includes("已保存（服务端回执核对一致）"),
    afterText.slice(0, 300)
  );
  await shot(page, "1440-panel-proposal-saved");

  // 5) 回执未证明成功 → 拒绝
  scenario.operations = "unverified";
  await sendMessage(page, "再准备一次观察");
  await waitStream(page, "[data-yaya-proposal]", 20000);
  await page.waitForSelector("[data-yaya-proposal-item] [role=checkbox]", { timeout: 10000 });
  await page.locator("[data-yaya-proposal-item] [role=checkbox]").first().click();
  await page.getByRole("button", { name: /确认已选 1 条/ }).last().click();
  await page.waitForSelector("text=执行回执未通过核验", { timeout: 20000 });
  const rejectText = await page.locator("[data-yaya-proposal]").last().innerText();
  check("1440: unverified 回执不显示成功", rejectText.includes("执行回执未通过核验") && !rejectText.includes("已保存（服务端回执核对一致）"));
  scenario.operations = "success";

  // 6) Escape 关闭并保持非模态语义
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-yaya-panel][data-state="closed"]', { timeout: 5000 });
  check("1440: Escape 关闭侧栏", true);

  await context.close();
}

async function runViewports(browser) {
  for (const viewport of [
    { width: 768, height: 1024, name: "768" },
    { width: 390, height: 844, name: "390" },
  ]) {
    const context = await browser.newContext({ viewport, locale: "zh-CN" });
    await context.route("**/api/**", routeHandler);
    const page = await context.newPage();
    await openPanel(page, BASE_URL, "panel");
    const panelBox = await page.locator('[data-yaya-panel][data-state="open"]').boundingBox();
    const fullScreen =
      panelBox !== null &&
      Math.abs(panelBox.width - viewport.width) <= 2 &&
      Math.abs(panelBox.height - viewport.height) <= 2;
    check(`${viewport.name}: 全屏会话页（<1024px）`, fullScreen, JSON.stringify(panelBox));
    await noHorizontalOverflow(page, `${viewport.name} panel`);
    await minTarget(page, '[aria-label="返回"]', `${viewport.name} 返回按钮`);
    await minTarget(page, '[aria-label="发送"]', `${viewport.name} 发送按钮`);
    await minTarget(page, "[data-yaya-composer-input]", `${viewport.name} 输入框`, 44);
    await shot(page, `${viewport.name}-panel`);
    await context.close();
  }
}

async function runWorkspace(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.route("**/api/**", routeHandler);
  const page = await context.newPage();
  await openPanel(page, BASE_URL, "workspace");
  scenario.runs = "proposal_stream";
  await sendMessage(page, "帮我分别记录小满和阿依的观察");
  await page.waitForSelector("[data-yaya-review-panel] [data-yaya-proposal]", { timeout: 20000 });
  const visibleCards = await page.locator("[data-yaya-proposal]:visible").count();
  check("1440 workspace: 宽屏仅核对台展示提案卡", visibleCards === 1, String(visibleCards));
  const reviewText = await page.locator("[data-yaya-review-panel]").innerText();
  check("1440 workspace: 批量核对台标题与规则", reviewText.includes("核对记录") && reviewText.includes("一项待补充不会阻塞其他项"));
  await noHorizontalOverflow(page, "1440 workspace");
  await shot(page, "1440-workspace");
  await context.close();
}

async function runServiceFailure(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.route("**/api/**", routeHandler);
  const page = await context.newPage();
  scenario.conversationsStatus = 503;
  await openPanel(page, BASE_URL, "panel");
  await page.waitForSelector("[data-yaya-thread-unavailable]", { timeout: 30000 });
  const unavailableText = await page.locator('[data-yaya-panel][data-state="open"]').innerText();
  check(
    "1440: 503 不显示 fixture 数据/不冒充空数据",
    !unavailableText.includes("帮我整理小满搭长桥") && unavailableText.includes("会话读取暂未完成"),
    unavailableText.slice(0, 120)
  );
  await shot(page, "1440-panel-service-failure");
  scenario.conversationsStatus = 200;
  await context.close();
}

async function main() {
  const playwrightCore = resolvePlaywrightCore();
  const { chromium } = require(playwrightCore);
  const chromePath = resolveChrome();
  const browser = await chromium.launch({
    headless: true,
    ...(chromePath === undefined ? {} : { executablePath: chromePath }),
  });
  try {
    await runPanelDesktop(browser);
    await runViewports(browser);
    await runWorkspace(browser);
    await runServiceFailure(browser);
  } finally {
    await browser.close();
  }

  const pageErrors = consoleErrors.filter((entry) => entry.includes("Uncaught"));
  check("无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | "));

  const summary = {
    base_url: BASE_URL,
    out: OUT,
    total: results.length,
    passed: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    not_run: ["真实后端 HTTP/DB", "真实模型/搜索/对象存储", "真机软键盘与真机截图"],
    results,
  };
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`\ncheck-yaya-ui: ${summary.passed}/${summary.total} passed`);
  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("check-yaya-ui crashed:", error);
  process.exit(1);
});


