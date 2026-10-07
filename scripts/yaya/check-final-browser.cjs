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
      page.on('pageerror', error => errors.push(error.message));
      const network = [];
      page.on('response', response => { if (response.url().includes('/api/yaya')) network.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() }); });
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
        await page.screenshot({ path: path.join(out, 'chat-answer-1440.png'), scale: 'css' });
        setMode('create');
        await composer.fill('[合成]请为松果班王一诺记录今天在积木区的观察。');
        await composer.press('Enter');
        const selectable = page.getByRole('checkbox').first();
        await selectable.waitFor({ state: 'visible', timeout: 20000 });
        if (!await selectable.isEnabled()) throw Error('actual proposal is not reviewable');
        await page.locator('[data-yaya-proposal]:visible').first().getByText('批准只执行卡片中的操作；保存原文或整理草稿不等于确认归档。取消提案不会撤销已提交的业务。', { exact: true }).waitFor({ timeout: 5000 });
        await verifyObservation(false);
        await selectable.click();
        await page.getByRole('button', { name: '确认已选 1 条', exact: true }).click();
        try { await page.getByText(/已保存/).first().waitFor({ timeout: 20000 }); }
        catch (error) {
          console.log('approval failure: ' + (await page.locator('body').innerText()).slice(-4500));
          fs.writeFileSync(path.join(out, 'browser-network-failure.json'), JSON.stringify(network, null, 2));
          await page.screenshot({ path: path.join(out, 'approval-failure.png'), scale: 'css' });
          throw error;
        }
        await verifyObservation(true);
        await page.getByText('回执已核对', { exact: true }).first().waitFor({ timeout: 5000 });
        await page.getByText('可提交 0 · 已选 0 · 受限/待补 0', { exact: true }).first().waitFor({ timeout: 5000 });
        results.push({ name: 'native approval card + real operations POST + committed exact raw observation', passed: true });
        await page.screenshot({ path: path.join(out, 'chat-proposal-saved-1440.png'), scale: 'css' });
        // The SDK may initialize an empty conversation when opening the workspace.
        // Recovery must not resend messages/runs/approvals/operations, regardless.
        const posts = () => network.filter(row => row.method === 'POST' && row.path !== '/api/yaya/conversations').length;
        const beforeHistory = posts();
        await page.reload({ waitUntil: 'domcontentloaded' });
        const savedThread = page.getByRole('button', { name: /未命名会话[\s\S]*\d+\/\d+/ }).first();
        try {
          await savedThread.waitFor({ timeout: 15000 });
          await savedThread.click();
          await page.getByRole('button', { name: '核对原运行', exact: true }).last().waitFor({ timeout: 15000 });
        } catch (error) {
          console.log('history failure: ' + (await page.locator('body').innerText()).slice(0, 5500));
          fs.writeFileSync(path.join(out, 'browser-network-failure.json'), JSON.stringify(network, null, 2));
          await page.screenshot({ path: path.join(out, 'history-failure.png'), scale: 'css' });
          throw error;
        }
        await page.getByRole('button', { name: '核对原运行', exact: true }).last().click();
        await page.getByText(/回执已核实保存/).first().waitFor({ timeout: 15000 });
        if (posts() !== beforeHistory) throw Error('history recovery dispatched an execution/message POST');
        await verifyObservation(true);
        results.push({ name: 'history selects original thread, reads original operation receipt; no execution/message POST or duplicate observation', passed: true });
        await page.screenshot({ path: path.join(out, 'history-1440.png'), scale: 'css' });
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
