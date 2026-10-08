"use strict";
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
module.exports = async function checkFinalBrowser({ base, cookie, setMode, verifyObservation, out }) {
  const modules = process.env.YAYA_PW_CORE || path.join(os.tmpdir(), 'g3-browser-deps/node_modules/playwright-core');
  const { chromium } = require(modules);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const results = [], errors = [];
  try {
    for (const width of [1440, 1024, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
      const separator = cookie.indexOf('=');
      await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const scriptErrors = [];
      cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: detail }) => scriptErrors.push({
        url: detail.url, scriptId: detail.scriptId, line: detail.lineNumber, column: detail.columnNumber,
        description: detail.exception?.description || detail.text,
      }));
      await cdp.send('Runtime.enable');
      page.on('pageerror', error => errors.push(error.stack || error.message));
      const network = [];
      const requests = [];
      page.on('request', request => { if (request.url().includes('/api/yaya')) requests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
      page.on('response', response => { if (response.url().includes('/api/yaya')) network.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() }); });
      await page.goto(base + '/classes', { waitUntil: 'domcontentloaded' });
      const entry = page.getByRole('button', { name: /^打开芽芽助手/ });
      await entry.waitFor({ state: 'visible', timeout: 25000 });
      await entry.click();
      const panel = page.locator('[data-yaya-panel]:visible');
      try { await panel.locator('textarea').waitFor({ state: 'visible', timeout: 25000 }); }
      catch (error) {
        console.log(JSON.stringify({ width, errors, network, visible: (await page.locator('body').innerText()).slice(-3000) }));
        await page.screenshot({ path: path.join(out, 'panel-load-failure-' + width + '.png'), scale: 'css' });
        throw error;
      }
      if (await entry.isVisible()) throw Error('open panel retains floating entry');
      results.push({ name: 'open panel hides entry', width, passed: true });
      await panel.locator('textarea').fill('[合成]尚未发送的草稿');
      if (width >= 1024) {
        const geometry = await page.evaluate(() => {
          const p = document.querySelector('[data-yaya-panel]').getBoundingClientRect();
          const main = document.querySelector('main').getBoundingClientRect();
          return { mainRight: main.right, paneLeft: p.left, bodyPointer: getComputedStyle(document.body).pointerEvents };
        });
        if (geometry.mainRight > geometry.paneLeft + 1 || geometry.bodyPointer === 'none') throw Error('nonmodal dock blocks or overlaps main page');
        await page.getByRole('link', { name: '首页', exact: true }).click();
        await page.waitForURL(base + '/', { timeout: 20000 });
        if (await panel.locator('textarea').inputValue() !== '[合成]尚未发送的草稿') throw Error('navigation loses private draft');
        results.push({ name: 'main navigation remains clickable, docked, draft retained', width, passed: true });
      }
      let releaseReference;
      const referenceGate = new Promise(resolve => { releaseReference = resolve; });
      const gateReference = async route => { await referenceGate; await route.continue(); };
      if (width === 1440) await page.route('**/api/yaya/page-reference?*', gateReference);
      await panel.getByRole('button', { name: '引用页面或选中文字', exact: true }).click();
      await page.getByRole('button', { name: '引用当前页面', exact: true }).click();
      if (width === 1440) {
        try {
          await panel.getByRole('button', { name: '引用页面或选中文字', exact: true }).getByText('正在引用…').waitFor();
          const before = requests.filter(row => row.method === 'POST').length;
          await panel.locator('textarea').press('Enter');
          await page.waitForTimeout(300);
          if (requests.filter(row => row.method === 'POST').length !== before || await panel.locator('textarea').inputValue() !== '[合成]尚未发送的草稿') throw Error('Enter bypassed reference pending lock');
          results.push({ name: 'reference wait blocks keyboard submit without losing input', width, passed: true, fault: 'request delayed; actual route continued' });
        } finally { releaseReference(); }
      }
      await panel.locator('[data-yaya-page-quote]').waitFor({ timeout: 20000 });
      if (width === 1440) await page.unroute('**/api/yaya/page-reference?*', gateReference);
      await panel.getByRole('button', { name: '查看页面引用', exact: true }).click();
      await page.getByText('这是本条消息的关注线索，不会替芽芽指定工具或改变权限。切换页面不会改写此引用。', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      if (!await panel.isVisible()) throw Error('popover Escape closed entire panel');
      await panel.getByRole('button', { name: '移除页面引用', exact: true }).click();
      if (await panel.locator('[data-yaya-page-quote]').count()) throw Error('removed focus retained');
      results.push({ name: 'optional real page reference, preview, remove, nested Escape', width, passed: true });
      await panel.locator('textarea').fill('');
      if (await panel.getByRole('button', { name: '发送', exact: true }).isEnabled()) throw Error('empty composer can send');
      const beforeClose = network.filter(row => row.method === 'POST' && row.path.includes('/runs')).length;
      await panel.locator('textarea').fill('[合成]关闭后仍需保留');
      await panel.getByRole('button', { name: '关闭芽芽', exact: true }).click();
      await entry.waitFor({ state: 'visible', timeout: 5000 });
      await entry.click();
      await panel.locator('textarea').waitFor({ state: 'visible', timeout: 10000 });
      if (await panel.locator('textarea').inputValue() !== '[合成]关闭后仍需保留') throw Error('close/open loses draft');
      if (network.filter(row => row.method === 'POST' && row.path.includes('/runs')).length !== beforeClose) throw Error('open/reference/history sends a model request');
      if (width < 1024) {
        const focus = await panel.evaluate(el => el.contains(document.activeElement));
        if (!focus) throw Error('mobile focus outside dialog');
        await page.keyboard.press('Tab');
        if (!await panel.evaluate(el => el.contains(document.activeElement))) throw Error('mobile focus escapes');
      }
      await page.screenshot({ path: path.join(out, 'docked-panel-' + width + '.png'), scale: 'css' });
      if (width === 390) {
        const sharp = require(path.join(process.cwd(), 'node_modules/sharp'));
        const imageBytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 240, b: 230 } } }).png().toBuffer();
        const uploadIds = [];
        let firstUpload = true;
        const uploadFault = async route => {
          const body = route.request().postDataBuffer()?.toString() ?? '';
          const id = /name="client_batch_id"\r\n\r\n([^\r\n]+)/.exec(body)?.[1];
          if (id) uploadIds.push(id);
          if (firstUpload) { firstUpload = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'service_unavailable', message: '合成上传暂未完成' } }) }); }
          else await route.continue();
        };
        await page.route('**/api/yaya/uploads', uploadFault);
        await panel.locator('input[type="file"]').setInputFiles({ name: '合成图片.png', mimeType: 'image/png', buffer: imageBytes });
        const retry = panel.getByRole('button', { name: '重试上传 合成图片.png', exact: true });
        await retry.waitFor({ timeout: 15000 });
        const remove = panel.getByRole('button', { name: '移除 合成图片.png', exact: true }).first();
        const retryBox = await retry.boundingBox(), removeBox = await remove.boundingBox();
        if (!retryBox || !removeBox || retryBox.height < 44 || retryBox.y < removeBox.y + removeBox.height) throw Error('failed attachment retry/remove overlap or target is too small');
        await page.screenshot({ path: path.join(out, 'attachment-retry-mobile.png'), scale: 'css' });
        const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/yaya/uploads' && response.status() < 300);
        await retry.click();
        await retried;
        await retry.waitFor({ state: 'hidden' });
        if (uploadIds.length !== 2 || uploadIds[0] !== uploadIds[1]) throw Error('attachment retry identity observations: ' + JSON.stringify(uploadIds));
        await panel.locator('[data-yaya-attachment] [role="status"]').waitFor({ state: 'hidden' });
        if ((await panel.locator('[data-yaya-attachment]').innerText()).includes('上传中')) throw Error('uploaded composer image still shown as uploading');
        if (await panel.locator('textarea').inputValue() !== '[合成]关闭后仍需保留') throw Error('attachment retry lost the existing input');
        await remove.click();
        await panel.locator('[data-yaya-attachment]').waitFor({ state: 'hidden' });
        await page.unroute('**/api/yaya/uploads', uploadFault);
        results.push({ name: 'native attachment remove + real upload retry same identity + ready display + unclipped controls', width, passed: true, fault: 'first upload 503 response double; retry actual HTTP/local media/DB' });
        setMode('long');
        await panel.locator('textarea').fill('[合成]幼儿争抢积木时，教师可以怎样引导？');
        await panel.locator('textarea').press('Enter');
        await panel.getByText('长答完整结束标记。', { exact: true }).waitFor({ timeout: 20000 });
        const viewport = panel.locator('[data-yaya-thread]');
        await viewport.evaluate(element => { element.scrollTop = 0; });
        const latest = panel.getByRole('button', { name: '回到最新消息', exact: true });
        await latest.waitFor({ state: 'visible' });
        await page.screenshot({ path: path.join(out, 'long-answer-mobile.png'), scale: 'css' });
        await latest.click();
        await page.waitForTimeout(100);
        const visibleEnd = await panel.getByText('长答完整结束标记。', { exact: true }).evaluate(element => {
          const end = element.getBoundingClientRect(), view = element.closest('[data-yaya-thread]').getBoundingClientRect();
          return end.top >= view.top && end.bottom <= view.bottom;
        });
        if (!visibleEnd) throw Error('native scroll-to-bottom did not reach the complete answer');
        results.push({ name: 'native latest-message scroll + complete long mobile answer', width, passed: true });
        setMode('query');
      }
      await panel.getByRole('button', { name: '关闭芽芽', exact: true }).click();
      results.push({ name: 'empty send disabled, close/open draft intact, no model dispatch', width, passed: true });
      await page.goto(base + '/assistant', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700);
      try { await page.locator('textarea:visible').first().waitFor({ state: 'visible', timeout: 15000 }); }
      catch (error) {
        console.log('composer unavailable: ' + (await page.locator('body').innerText()).slice(0, 3500));
        console.log(JSON.stringify({ browser_errors: errors, network }));
        await page.screenshot({ path: path.join(out, 'composer-failure-' + width + '.png'), scale: 'css' });
        throw error;
      }
      console.log('browser visible snapshot ' + width + ': ' + (await page.locator('body').innerText()).slice(0, 450));
      await page.screenshot({ path: path.join(out, 'workspace-' + width + '.png'), scale: 'css' });
      const geometry = await page.evaluate(() => {
        const composer = document.querySelector('textarea')?.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, textboxes: document.querySelectorAll('textarea').length, composer_bottom: composer?.bottom, composer_visible: composer && composer.bottom <= window.innerHeight && composer.top >= 0 };
      });
      results.push({ width, geometry });
      if (width === 1440) {
        const newThread = page.getByRole('button', { name: '新会话', exact: true });
        if (await newThread.count()) await newThread.first().click();
        const composer = page.locator('textarea').first();
        await composer.waitFor({ state: 'visible', timeout: 15000 });
        setMode('query');
        await composer.fill('[合成]请查看我负责班级的名册。');
        await composer.press('Enter');
        try { await page.getByText('已读取当前负责班级的合成名册。', { exact: true }).first().waitFor({ timeout: 20000 }); }
        catch (error) {
          console.log('browser failure visible: ' + (await page.locator('body').innerText()).slice(-2400));
          await page.screenshot({ path: path.join(out, 'failure-1440.png'), scale: 'css' });
          throw error;
        }
        results.push({ name: 'real browser chat to real run/read/message route', passed: true });
        const renderedRead = page.locator('[data-yaya-tool-result]:visible').first();
        if (!(await renderedRead.innerText()).includes('幼儿名册') || (await renderedRead.innerText()).includes('list_children')) throw Error('raw tool name remains in conversation prose');
        const source = page.locator('[data-yaya-sources]:visible').first();
        if (await source.getAttribute('open') !== null) throw Error('reference details start expanded');
        await source.locator('summary').click();
        await source.getByText('来源标识：children:current_scope', { exact: true }).waitFor();
        await source.locator('summary').click();
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.getByRole('button', { name: '复制芽芽回答', exact: true }).first().click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        if (!copied.includes('已读取当前负责班级的合成名册。')) throw Error('native action bar copy lost answer text');
        results.push({ name: 'localized read status + source disclosure + native copy', width, passed: true });
        await page.screenshot({ path: path.join(out, 'chat-answer-1440.png'), scale: 'css' });
        setMode('create');
        await composer.fill('[合成]请为松果班王一诺记录今天在积木区的观察。');
        await composer.press('Enter');
        const selectable = page.getByRole('checkbox').first();
        await selectable.waitFor({ state: 'visible', timeout: 20000 });
        if (!await selectable.isEnabled()) throw Error('actual proposal is not reviewable');
        await page.locator('[data-yaya-proposal]:visible').first().getByText('批准只执行卡片中的操作；保存原文或整理草稿不等于确认归档。取消提案不会撤销已提交的业务。', { exact: true }).waitFor({ timeout: 5000 });
        await verifyObservation(false);
        await page.screenshot({ path: path.join(out, 'proposal-pending-1440.png'), scale: 'css' });
        await page.getByRole('button', { name: '更多提案操作', exact: true }).last().click();
        await page.getByRole('menuitem', { name: '撤销未执行批准', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        results.push({ name: 'secondary proposal actions remain keyboard accessible', width, passed: true });
        await selectable.click();
        await page.getByRole('button', { name: '确认已选 1 条', exact: true }).click();
        try { await page.locator('[data-yaya-proposal]:visible').first().getByText('已保存（服务端回执核对一致）', { exact: true }).waitFor({ timeout: 20000 }); }
        catch (error) {
          console.log('approval failure: ' + (await page.locator('body').innerText()).slice(-4500));
          fs.writeFileSync(path.join(out, 'browser-network-failure.json'), JSON.stringify(network, null, 2));
          await page.screenshot({ path: path.join(out, 'approval-failure.png'), scale: 'css' });
          throw error;
        }
        await verifyObservation(true);
        if (await page.getByRole('button', { name: '确认已选 0 条', exact: true }).count()) throw Error('completed card retains redundant approval controls');
        results.push({ name: 'verified saved card removes redundant submit controls', width, passed: true });
        await page.locator('[data-yaya-proposal]:visible').first().getByText('回执已核对', { exact: true }).waitFor({ timeout: 5000 });
        await page.locator('[data-yaya-proposal]:visible').first().getByText(/可提交 0.*已选 0.*受限\/待补 0/).waitFor({ timeout: 5000 });
        results.push({ name: 'native approval card + real operations POST + committed exact raw observation', passed: true });
        await page.screenshot({ path: path.join(out, 'chat-proposal-saved-1440.png'), scale: 'css' });
        // The SDK may initialize an empty conversation when opening the workspace.
        // Recovery must not resend messages/runs/approvals/operations, regardless.
        const posts = () => network.filter(row => row.method === 'POST' && row.path !== '/api/yaya/conversations').length;
        const beforeHistory = posts();
        await page.reload({ waitUntil: 'domcontentloaded' });
        const savedThread = page.getByRole('button', { name: /未命名会话[\s\S]*\d+\/\d+/ }).first();
        try {
          await savedThread.waitFor({ timeout: 45000 });
          await savedThread.click();
          await page.getByRole('button', { name: '核对原运行', exact: true }).last().waitFor({ timeout: 15000 });
        } catch (error) {
          console.log('history failure: ' + JSON.stringify({ errors, scriptErrors, network, visible: (await page.locator('body').innerText()).slice(0, 5500) }));
          fs.writeFileSync(path.join(out, 'browser-network-failure.json'), JSON.stringify(network, null, 2));
          await page.screenshot({ path: path.join(out, 'history-failure.png'), scale: 'css' });
          throw error;
        }
        await page.getByRole('button', { name: '核对原运行', exact: true }).last().click();
        await page.locator('p:visible').filter({ hasText: /回执已核实保存/ }).first().waitFor({ timeout: 15000 });
        if (posts() !== beforeHistory) throw Error('history recovery dispatched an execution/message POST');
        await verifyObservation(true);
        results.push({ name: 'history selects original thread, reads original operation receipt; no execution/message POST or duplicate observation', passed: true });
        await page.screenshot({ path: path.join(out, 'history-1440.png'), scale: 'css' });
        setMode('create');
        await page.locator('textarea:visible').first().fill('[合成]再准备一条观察，暂不保存。');
        await page.locator('textarea:visible').first().press('Enter');
        const nextCheckbox = page.getByRole('checkbox').first();
        await nextCheckbox.waitFor({ state: 'visible', timeout: 15000 });
        if (!await nextCheckbox.isEnabled()) throw Error('previous saved result hid new proposal controls');
        await page.getByRole('button', { name: '更多提案操作', exact: true }).last().click();
        await page.getByRole('menuitem', { name: '撤销未执行批准', exact: true }).focus();
        await page.keyboard.press('Enter');
        await page.locator('[data-yaya-review-panel]').getByText('没有待撤销的批准；提案仍可继续核对。', { exact: true }).waitFor();
        if (await page.locator('[data-yaya-review-panel]').getByText('已取消', { exact: true }).count()) throw Error('revoking no approval falsely closed the proposal');
        await verifyObservation(true);
        results.push({ name: 'next proposal remains actionable; keyboard pending-approval revocation has honest no-effect feedback and preserves saved observation', width, passed: true });
        setMode('query');
        fs.writeFileSync(path.join(out, 'browser-network.json'), JSON.stringify(network, null, 2));
      }
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify({ results, errors, real_provider: false, auth: 'real session staged from actual HTTP login', database: 'isolated real postgres', model: 'owned protocol double', true_mobile_keyboard: 'NOT_RUN' }, null, 2));
    if (errors.length) throw Error('browser runtime errors: ' + errors.join(';'));
    if (results.some(result => result.geometry?.overflow)) throw Error('horizontal overflow');
    if (results.some(result => result.geometry && !result.geometry.composer_visible)) throw Error('composer is clipped');
    return results;
  } finally { await browser.close(); }
};
