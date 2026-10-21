const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

(async () => {
  const { createServer } = await import('../server.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiuzhai-chat-browser-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer({ chat: {
    dbFile: path.join(directory, 'chat.sqlite'), encryptionKey: 'cd'.repeat(32), inviteCode: 'browser-test-invite', publicOrigin: origin,
    segmentDelay: false,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return Response.json({ data: [] });
      const body = JSON.parse(options.body);
      // 记忆抽取是回复之后的独立调用，别把它当聊天请求。
      if (body.response_format) {
        return Response.json({ choices: [{ message: { content: '{"episode":"","add":[],"update":[],"forget":[]}' } }] });
      }
      assert.equal(body.stream, true);
      const chunks = ['你好！', '这是一次完整的 AI 回复。', '\n<img src=x onerror=alert(1)>\n可以继续聊。'];
      const payload = chunks.map(chunk => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`).join('');
      return new Response(`${payload}data: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
  } });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const output = path.resolve('test-output');
  await fs.mkdir(output, { recursive: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('link', { name: 'AI 助手' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'guide-chat-entry-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('link', { name: 'AI 助手' }).click();
    await page.locator('#auth:not([hidden])').waitFor();
    await page.screenshot({ path: path.join(output, 'chat-login-desktop.png'), fullPage: true });
    await page.locator('#switch-auth').click();
    await page.locator('input[name=username]').fill('browser_user');
    await page.locator('input[name=password]').fill('browser-password-123');
    await page.locator('input[name=invite]').fill('browser-test-invite');
    await page.locator('#auth-submit').click();
    await page.locator('#conversation:not([hidden])').waitFor();
    assert.equal(await page.locator('#send').isDisabled(), true);
    await page.locator('input[name=key]').fill('sk-browser-test-key');
    await page.locator('#key-form button[type=submit]').click();
    await page.waitForFunction(() => !document.getElementById('send').disabled);
    await page.locator('#message').fill('你好，我想了解这个聊天功能。');
    await page.locator('#send').click();
    // 每一句独立成气泡，而不是一大段。
    await page.waitForFunction(() => document.getElementById('messages').textContent.includes('这是一次完整的 AI 回复'));
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant .bubble').length >= 3);
    assert.equal(await page.locator('#messages img').count(), 0);
    assert.equal(await page.locator('#message').inputValue(), '');
    assert.equal(await page.locator('.bubble.typing').count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('messages').textContent.includes('这是一次完整的 AI 回复'));
    assert.ok(await page.locator('.message.assistant .bubble').count() >= 3);
    await page.screenshot({ path: path.join(output, 'chat-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'chat-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#logout').click();
    await page.locator('#auth:not([hidden])').waitFor();
    assert.equal(await page.locator('#messages').innerText(), '');
    await page.locator('input[name=username]').fill('browser_user');
    await page.locator('input[name=password]').fill('browser-password-123');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => document.getElementById('messages').textContent.includes('这是一次完整的 AI 回复'));
    assert.deepEqual(errors, []);
    console.log('PASS: registration, Key, streaming segmented bubbles, safe rendering, persistence, logout/login and mobile layout.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
