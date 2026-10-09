/* Browser runner: only stdin-scoped isolated resources; never loads .env. */
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
let passed = 0;
const check = (name, value) => { assert.ok(value, name); passed++; };
async function main() {
  let stdin = ""; for await (const part of process.stdin) stdin += part;
  const settings = JSON.parse(stdin);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.base)) throw Error("Only loopback acceptance server allowed");
  const playwrightPath = settings.playwright || "C:/Users/nanpr/AppData/Local/Temp/opencode/g4-pw-core/node_modules/playwright-core";
  const { chromium } = require(playwrightPath);
  const credentials = JSON.parse(fs.readFileSync(settings.credentials_path, "utf8")).accounts;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [], network = [];
  const diagnostic = await context.newCDPSession(page);
  await diagnostic.send("Runtime.enable");
  diagnostic.on("Runtime.exceptionThrown", ({ exceptionDetails }) => errors.push({ kind: "runtime_location", text: exceptionDetails.text, url: exceptionDetails.url, line: exceptionDetails.lineNumber, column: exceptionDetails.columnNumber, stack: exceptionDetails.exception?.description }));
  page.on("pageerror", (error) => errors.push({ message: error.message, stack: String(error.stack).replace(/([?&]password=)[^&\s]*/gi, "$1[redacted]") }));
  page.on("response", (response) => { const url = new URL(response.url()); if (url.origin === settings.base && url.pathname.startsWith("/api/family-communications")) network.push({ method: response.request().method(), path: url.pathname, status: response.status() }); });
  const target = `${settings.base}/family-communication?child=${settings.child}&kind=month&value=${settings.month}`;
  const text = page.getByLabel("给家长的分享文字", { exact: true });
  async function ready() { await page.getByRole("heading", { name: "这段时间的小故事" }).waitFor(); await page.getByRole("button", { name: /生成分享草稿|重新生成/, exact: true }).waitFor(); await page.waitForFunction(() => !document.body.innerText.includes("正在读取已确认观察…")); }
  async function capture(name) { await page.screenshot({ path: path.join(settings.out, `${name}.png`), fullPage: true, animations: "disabled" }); }
  try {
    await page.goto(`${settings.base}/login`);
    await page.getByLabel("账号", { exact: true }).fill(credentials.teacher_a.username);
    await page.getByLabel("密码", { exact: true }).fill(credentials.teacher_a.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL((url) => url.pathname !== "/login");
    check("real login", true);
    await page.goto(`${settings.base}/family-communication`);
    await page.getByText("先选择一名幼儿", { exact: true }).waitFor();
    check("home entry does not silently choose a child", await page.getByRole("button", { name: "生成分享草稿", exact: true }).isDisabled());
    await page.goto(target); await ready();
    check("five confirmed sources present", (await page.locator('[role="checkbox"]').count()) === 3);
    check("three visible rows and two folded", await page.getByRole("button", { name: "展开另外 2 条" }).isVisible());
    check("not generated cannot copy", await page.getByRole("button", { name: "我已核对，复制文字" }).count() === 0);
    await page.getByRole("button", { name: "展开另外 2 条" }).click();
    await page.locator('[role="checkbox"]').nth(3).uncheck(); await page.locator('[role="checkbox"]').nth(4).uncheck();
    await page.getByRole("button", { name: "收起记录" }).click();
    check("selection count is actual", (await page.locator('section[aria-label="选择幼儿和时间"]').innerText()).includes("已选择 3 条"));
    await page.getByRole("button", { name: "生成分享草稿", exact: true }).click();
    await page.getByText("分享草稿已保存，请核对事实和称呼。").waitFor({ timeout: 90000 });
    const generated = await text.inputValue();
    check("real run generated readable body", generated.includes("这次小车能过去了") && generated.includes("林小禾"));
    check("complete signature is previewed", generated.includes("合成教师A") && generated.includes("松果班"));
    const count = network.filter((request) => request.method === "POST").length;
    await page.reload(); await ready();
    check("refresh restores private draft", (await text.inputValue()) === generated);
    check("history load does not regenerate", network.filter((request) => request.method === "POST").length === count);
    await capture("draft-desktop-1440");
    await text.fill(generated + "\n欢迎您和我们聊聊她在家里的小故事。");
    check("editing clears reviewed claim", await page.getByText("修改未保存", { exact: true }).isVisible());
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page.getByText("修改已保存。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "我已核对，复制文字" }).click();
    await page.getByText("已复制核对后的文字。请自行发送给家长。").waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check("clipboard is checked final text", copied.includes("欢迎您和我们聊聊") && !copied.includes("observation_id"));
    check("clipboard matches exactly the full preview", copied.replace(/\r\n/g, "\n") === (await text.inputValue()).replace(/\r\n/g, "\n"));
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async () => { throw Error("fixture clipboard denied"); } }); });
    await page.getByRole("button", { name: "我已核对，复制文字" }).click();
    await page.getByText("文字已保存并核对，但浏览器没有允许复制。请复制编辑框里的文字。").waitFor();
    check("clipboard fallback selects complete signature and body", await text.evaluate((element) => element.selectionStart === 0 && element.selectionEnd === element.value.length && element.value.includes("合成教师A")));
    await capture("clipboard-denied");
    await page.evaluate(() => { delete navigator.clipboard.writeText; });
    await page.getByRole("button", { name: "我已核对，复制文字" }).click();
    await page.getByText("已复制核对后的文字。请自行发送给家长。").waitFor();
    check("copy does not say sent", await page.getByText("文字已核对，可自行发给家长。").isVisible());
    await capture("desktop-1440");
    for (const [width, height] of [[1440, 1024], [1024, 900], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height }); await ready();
      check(`no horizontal overflow ${width}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      const measure = await text.evaluate((node) => {
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        return { font: parseFloat(style.fontSize), line: parseFloat(style.lineHeight), max: parseFloat(style.maxInlineSize), width: box.width };
      });
      check(`editor font and measure ${width}`, measure.font >= 16 && measure.line / measure.font >= 1.5 && Number.isFinite(measure.max) && measure.width <= measure.max + 1);
      const geometry = await page.locator('[data-platform-surface="family-communication"] button, [data-platform-surface="family-communication"] input, [data-platform-surface="family-communication"] summary, [data-platform-surface="family-communication"] a').evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().height && getComputedStyle(node).visibility !== "hidden").map((node) => {
        const label = node.id && document.querySelector(`label[for="${node.id}"]`);
        const box = (node.getAttribute("role") === "checkbox" && label ? label : node).getBoundingClientRect();
        return { tag: node.tagName, height: box.height };
      }));
      check(`44px targets ${width}`, geometry.every((item) => item.height >= 43.9));
      await capture(`workspace-${width}`);
      if (width === 390) {
        check("mobile selected facts are collapsed first", !await page.locator('[role="checkbox"]').first().isVisible());
        await page.getByRole("button", { name: "查看观察", exact: true }).click();
        check("mobile can expand facts", await page.locator('[role="checkbox"]').first().isVisible());
        await capture("mobile-facts-expanded");
        await page.getByRole("button", { name: "收起", exact: true }).click();
      }
    }
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    check("reduced motion", await page.evaluate(() => Array.from(document.querySelectorAll('[data-platform-surface="family-communication"] *')).every((node) => getComputedStyle(node).animationName === "none")));
    await text.focus(); await page.keyboard.press("Tab");
    check("keyboard moves to following control", await page.evaluate(() => document.activeElement.tagName === "SUMMARY"));
    await page.keyboard.press("Enter"); check("keyboard expands optional note", await page.locator("details").getAttribute("open") !== null);
    await page.getByRole("button", { name: "近一年", exact: true }).click(); await ready();
    await page.reload(); await ready(); check("refresh preserves period", await page.getByRole("button", { name: "近一年", exact: true }).getAttribute("aria-pressed") === "true");
    await page.goto(target); await ready();
    await fetch(`${settings.modelBase}/test-control`);
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await page.getByRole("button", { name: "核验原请求", exact: true }).waitFor();
    await page.getByRole("button", { name: "核验原请求", exact: true }).click();
    await page.getByText(/原请求明确没有生成可用草稿/).waitFor();
    await page.reload(); await ready(); check("provider failure preserves prior draft", (await text.inputValue()).includes("欢迎您和我们聊聊"));
    await capture("generation-failure-restored");
    let drop = true;
    await page.route("**/api/family-communications", async (route) => {
      if (route.request().method() === "POST" && drop) { drop = false; await route.fetch(); await route.abort(); } else await route.continue();
    });
    await page.getByRole("button", { name: "重新生成", exact: true }).click(); await page.getByRole("button", { name: "核验原请求" }).waitFor();
    const postCount = network.filter((item) => item.method === "POST").length;
    check("unknown generation blocks second write", await page.getByRole("button", { name: "重新生成", exact: true }).isDisabled());
    await page.getByRole("button", { name: "核验原请求" }).click(); await page.getByText("已读取原草稿的保存结果，请核对后复制。").waitFor();
    check("unknown recovery is GET only", network.filter((item) => item.method === "POST").length === postCount);
    await page.unroute("**/api/family-communications"); await capture("original-request-recovered");
    await page.goto(`${target.replace(settings.child, settings.empty)}`); await ready();
    check("trusted empty explicit", await page.getByText("这段时间还没有已确认的观察", { exact: true }).isVisible());
    check("empty no model action", await page.getByRole("button", { name: "生成分享草稿", exact: true }).isDisabled()); await capture("trusted-empty");
    await page.route("**/api/family-communications?*", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "service_unavailable", message: "资料暂时无法读取，请稍后重试。" }) }));
    await page.goto(target); await page.getByText("记录暂未读取", { exact: true }).waitFor();
    check("503 not presented as empty", await page.getByText("这段时间还没有已确认的观察", { exact: true }).count() === 0);
    await capture("service-unavailable"); await page.unroute("**/api/family-communications?*");
    await context.clearCookies(); await page.goto(`${settings.base}/login`);
    await page.getByLabel("账号", { exact: true }).fill(credentials.admin.username); await page.getByLabel("密码", { exact: true }).fill(credentials.admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await page.waitForURL((url) => url.pathname !== "/login");
    await page.goto(target); await page.getByText(/管理员可以查阅观察/).waitFor();
    check("admin has no teaching write action", await page.getByRole("button", { name: "我已核对，复制文字" }).count() === 0 && await page.getByRole("button", { name: "生成分享草稿" }).count() === 0); await capture("admin-read-only");
    check("no page runtime errors", errors.length === 0);
    fs.writeFileSync(path.join(settings.out, "results.json"), JSON.stringify({ passed, errors, provider: "protocol_double", real_model_requests: 0 }, null, 2));
    fs.writeFileSync(path.join(settings.out, "network.json"), JSON.stringify(network, null, 2));
    console.log(JSON.stringify({ passed, errors, screenshots: settings.out }));
  } catch (error) {
    fs.writeFileSync(path.join(settings.out, "failed-run.json"), JSON.stringify({ passed, errors, failure: String(error.message).replace(/([?&]password=)[^&\s]*/gi, "$1[redacted]") }, null, 2));
    throw Error(String(error.message).replace(/([?&]password=)[^&\s]*/gi, "$1[redacted]"));
  } finally { await browser.close(); }
}
void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
