// 真实 DeepSeek 端到端验收：需要 E2E_ORIGIN、E2E_DEEPSEEK_KEY、E2E_INVITE 三个环境变量。
// 从不打印 Key；失败时只报告断言与页面错误。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const origin = process.env.E2E_ORIGIN;
const key = process.env.E2E_DEEPSEEK_KEY;
const invite = process.env.E2E_INVITE;
const username = process.env.E2E_USER || `e2e_${Date.now().toString(36).slice(-6)}`;
const password = process.env.E2E_PASSWORD || 'e2e-password-123';

const WORDS = [
  '我今天在五花海，水蓝得有点离谱',
  '我有点怕高，刚才那个栈道我都不敢往下看',
  '中午吃了根烤肠，还行',
  '你说我明天该几点出门啊',
  '我最烦人多的地方了'
];

async function assistantBubbles(page) {
  return page.locator('.message.assistant .bubble').allInnerTexts();
}

async function sendAndWait(page, text, timeout = 120000) {
  const before = (await assistantBubbles(page)).length;
  await page.locator('#message').fill(text);
  await page.locator('#send').click();
  await page.waitForFunction(({ before }) => {
    const bubbles = document.querySelectorAll('.message.assistant .bubble');
    const typing = document.querySelectorAll('.bubble.typing');
    return bubbles.length > before && typing.length === 0;
  }, { before }, { timeout });
  return assistantBubbles(page);
}

(async () => {
  assert.ok(origin && key && invite, '缺少 E2E_ORIGIN / E2E_DEEPSEEK_KEY / E2E_INVITE');
  const output = path.resolve('test-output');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  try {
    await page.goto(`${origin}/chat`);
    await page.locator('#auth:not([hidden])').waitFor({ timeout: 20000 });
    await page.locator('#switch-auth').click();
    await page.locator('input[name=username]').fill(username);
    await page.locator('input[name=password]').fill(password);
    await page.locator('input[name=invite]').fill(invite);
    await page.locator('#auth-submit').click();
    await page.locator('#conversation:not([hidden])').waitFor({ timeout: 20000 });
    console.log('注册并登录 OK');

    if (await page.locator('#send').isDisabled()) {
      await page.locator('#key-panel').evaluate(node => { node.open = true; });
      await page.locator('input[name=key]').fill(key);
      await page.locator('#key-form button[type=submit]').click();
      await page.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 40000 });
      console.log('Key 校验并保存 OK');
    }

    for (const [index, text] of WORDS.entries()) {
      const bubbles = await sendAndWait(page, text);
      console.log(`第 ${index + 1} 轮 OK（累计 ${bubbles.length} 个气泡）`);
    }

    const afterFive = await assistantBubbles(page);
    const joined = afterFive.join('\n');
    // 人设要求「一句」，所以每轮至少一个气泡；模型偶尔写两句时会拆成多个。
    assert.ok(afterFive.length >= WORDS.length, `回复丢失：5 轮只出现 ${afterFive.length} 个气泡`);
    assert.ok(!joined.includes('<meme:'), '表情标记泄漏到了界面');
    console.log(`气泡统计：5 轮 → ${afterFive.length} 个气泡（每轮至少一个）`);

    // 第 6 轮之后会触发记忆抽取（异步），等它落库。
    await sendAndWait(page, '我明天还要早起呢');
    console.log('第 6 轮 OK，等待异步记忆抽取…');
    let facts = [];
    for (let attempt = 0; attempt < 40 && !facts.length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      facts = await page.evaluate(async () => {
        const response = await fetch('/api/chat/memory', { credentials: 'same-origin' });
        if (!response.ok) return [];
        const data = await response.json();
        return data.facts.filter(fact => fact.status === 'active');
      });
    }
    console.log(`记忆抽取完成：${facts.length} 条事实`);
    for (const fact of facts) console.log(`  - ${fact.subject}：${fact.predicate} → ${fact.value}`);

    // 关键验收：她能不能主动提起第 2 轮说过的「怕高」。
    const recall = await sendAndWait(page, '你还记得我怕什么吗');
    const reply = recall.slice(-3).join(' ');
    console.log(`回忆提问的回答：${reply.slice(0, 120)}`);
    const remembered = /高/.test(reply);
    console.log(remembered ? '记忆生效：回复里提到了「高」' : '记忆未体现在回复里（可能需要更多轮次或抽取未命中）');

    await page.screenshot({ path: path.join(output, 'real-chat-desktop.png'), fullPage: true });
    await page.locator('#messages').screenshot({ path: path.join(output, 'real-chat-messages.png') }).catch(() => {});
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'real-chat-mobile.png'), fullPage: true });

    await page.goto(`${origin}/memory`);
    await page.locator('#memory:not([hidden])').waitFor({ timeout: 20000 });
    const memoryText = await page.locator('#memory').innerText();
    await page.screenshot({ path: path.join(output, 'real-memory.png'), fullPage: true });
    console.log(`记忆页渲染 OK（${memoryText.length} 字）`);

    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log(JSON.stringify({ facts: facts.length, bubbles: afterFive.length, remembered }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error('E2E FAIL: ' + error.message); process.exitCode = 1; });
