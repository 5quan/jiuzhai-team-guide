import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { buildContext, createChat } from '../lib/chat.mjs';
import { splitSegments } from '../lib/attachments.mjs';

const invite = 'test-invite-code-123456';
const encryptionKey = 'ab'.repeat(32);
const key = 'sk-test-only-secret-123456';
const memes = { name: '测试表情包', categories: [{ name: 'happy', description: '开心时用', files: ['a.png'] }, { name: 'sad', description: '难过时用', files: ['b.png'] }] };
async function fixture(t, fetchImpl = async () => Response.json({ choices: [{ message: { content: '你好，这是完整回复。' }, finish_reason: 'stop' }] }), extra = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jiuzhai-chat-'));
  const dbFile = path.join(directory, 'chat.sqlite');
  const options = { dbFile, encryptionKey, inviteCode: invite, publicOrigin: 'http://localhost', fetchImpl, segmentDelay: false, memes, search: { enabled: false }, ...extra };
  let server;
  let base;
  const start = async () => {
    server = createServer({ chat: options, rateLimit: { perIp: 2000, total: 2000 } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  await start();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const call = async (route, body, cookie = '', extra = {}) => {
    return new Promise((resolve, reject) => {
      const request = http.request(`${base}/api/chat${route}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Host: 'localhost', Origin: 'http://localhost', 'Content-Type': 'application/json', Cookie: cookie, ...extra }
      }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text),
          cookie: response.headers['set-cookie']?.[0].split(';')[0], headers: new Headers(Object.entries(response.headers).map(([key, value]) => [key, String(value)])) }));
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const register = async username => {
    const result = await call('/register', { username, password: 'test-password-123', invite });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.cookie;
  };
  const stream = (route, body, cookie) => new Promise((resolve, reject) => {
    const request = http.request(`${base}/api/chat${route}`, {
      method: 'POST',
      headers: { Host: 'localhost', Origin: 'http://localhost', 'Content-Type': 'application/json', Cookie: cookie, Accept: 'text/event-stream' }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        type: response.headers['content-type'],
        events: parseSse(text)
      }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
  return { call, register, stream, getServer: () => server, dbFile, base, restart: async () => { await stop(); await start(); } };
}

function parseSse(text) {
  return text.split('\n\n').map(frame => {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (!event || !data) return null;
    try { return { event, data: JSON.parse(data) }; } catch { return null; }
  }).filter(Boolean);
}

const sseResponse = chunks => new Response(
  chunks.map(chunk => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`).join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
);

test('registration, authentication, cookie protection and encrypted Key storage', async t => {
  const { call, register, dbFile } = await fixture(t);
  assert.equal((await call('/register', { username: 'alice', password: 'test-password-123', invite: 'wrong' })).status, 403);
  const cookie = await register('alice');
  assert.equal((await call('/login', { username: 'alice', password: 'wrong-password' })).status, 401);
  const login = await call('/login', { username: 'alice', password: 'test-password-123' });
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await call('/key', { key }, cookie)).status, 200);
  const me = await call('/me', undefined, cookie);
  assert.deepEqual(me.data, { username: 'alice', hasKey: true });
  assert.equal(me.headers.get('cache-control'), 'no-store');
  const db = new DatabaseSync(dbFile);
  const user = db.prepare('SELECT * FROM users').get();
  assert.ok(!user.password.includes('test-password'));
  assert.ok(!user.api_key.includes(key));
  db.close();
  assert.equal((await call('/logout', {}, cookie)).status, 200);
  assert.equal((await call('/me', undefined, cookie)).status, 401);
});

test('non-streaming sends full ordered history once, persists across restart, and isolates accounts', async t => {
  const requests = [];
  const { call, register, restart } = await fixture(t, async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    if (url.endsWith('/models')) return Response.json({ data: [] });
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: `回答${requests.length}` }, finish_reason: 'stop' }] });
  });
  const alice = await register('alice');
  const bob = await register('bob');
  await call('/key', { key }, alice);
  const first = { requestId: 'request-number-0001', content: '你好' };
  assert.equal((await call('/send', first, alice)).status, 200);
  assert.equal((await call('/send', first, alice)).status, 200);
  assert.equal(requests.length, 1);
  assert.equal((await call('/send', { requestId: 'request-number-0002', content: '接着说' }, alice)).status, 200);
  assert.equal(requests[1].stream, false);
  assert.deepEqual(requests[1].messages.slice(1), [{ role: 'user', content: '你好' }, { role: 'assistant', content: '回答1' }, { role: 'user', content: '接着说' }]);
  assert.deepEqual((await call('/messages?user_id=1', undefined, bob)).data.turns, []);
  assert.equal((await call('/me', undefined, bob)).data.hasKey, false);
  await restart();
  assert.equal((await call('/messages', undefined, alice)).data.turns.length, 2);
  assert.equal((await call('/send', { requestId: 'request-number-0003', content: '重启后继续' }, alice)).status, 200);
});

test('full history is neither clipped nor capped at 100 turns, while UI pagination stays separate', async t => {
  let payload;
  const { call, register, dbFile } = await fixture(t, async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    const body = JSON.parse(options.body);
    // 记忆抽取是回复之后的独立调用（带 response_format），不参与“全量历史”断言。
    if (body.response_format) return Response.json({ choices: [{ message: { content: '{"add":[],"update":[],"forget":[]}' } }] });
    payload = body;
    return Response.json({ choices: [{ message: { content: '已收到全部历史' } }] });
  });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  const db = new DatabaseSync(dbFile);
  const insert = db.prepare("INSERT INTO turns(user_id,request_id,prompt,reply,status,created) VALUES (1,?,?,?,'complete',?)");
  for (let index = 0; index < 110; index++) insert.run(`seed-${index}`, `问题${index}${'内容'.repeat(150)}`, `答复${index}`, Date.now());
  db.close();
  await call('/send', { requestId: 'request-number-last', content: '继续' }, cookie);
  assert.equal(payload.messages.length, 222);
  assert.ok(payload.messages[1].content.startsWith('问题0'));
  assert.equal(payload.messages.at(-1).content, '继续');
  const page = (await call('/messages', undefined, cookie)).data;
  assert.equal(page.turns.length, 50);
  assert.equal(page.hasMore, true);
  assert.equal((await call(`/messages?before=${page.turns[0].id}`, undefined, cookie)).data.turns.length, 50);
  assert.equal(buildContext([{ prompt: '长'.repeat(60000), reply: '完整' }], '继续')[1].content.length, 60000);
});

test('failure is retained, retries reuse the same turn, and context overflow is explicit', async t => {
  let attempt = 0;
  const { call, register } = await fixture(t, async url => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    attempt++;
    if (attempt === 1) return Response.json({ error: { message: 'maximum context length exceeded' } }, { status: 400 });
    return Response.json({ choices: [{ message: { content: '成功' } }] });
  });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  const request = { requestId: 'request-number-0001', content: '测试' };
  const result = await call('/send', request, cookie);
  assert.equal(result.status, 422);
  assert.match(result.data.error, /不会自动压缩或截断/);
  assert.equal((await call('/messages', undefined, cookie)).data.turns[0].status, 'failed');
  assert.equal((await call('/send', request, cookie)).status, 200);
  assert.equal((await call('/messages', undefined, cookie)).data.turns.length, 1);
});

test('same-account concurrent sends are rejected without creating duplicate turns', async t => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { call, register } = await fixture(t, async url => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    started();
    await new Promise(resolve => { release = resolve; });
    return Response.json({ choices: [{ message: { content: '完整回复' } }] });
  });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  const first = call('/send', { requestId: 'request-number-0001', content: '第一条' }, cookie);
  await ready;
  try {
    assert.equal((await call('/send', { requestId: 'request-number-0002', content: '第二条' }, cookie)).status, 409);
    assert.equal((await call('/messages', undefined, cookie)).data.turns[0].status, 'pending');
  } finally { release(); }
  assert.equal((await first).status, 200);
});

test('origin, host, body size and input validation protect write endpoints', async t => {
  const { call, register } = await fixture(t);
  const cookie = await register('alice');
  assert.equal((await call('/key', { key }, cookie, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/key', { key }, cookie, { Host: 'evil.example' })).status, 403);
  assert.equal((await call('/key', { key: 'x'.repeat(25000) }, cookie)).status, 413);
  assert.equal((await call('/messages?before=-1', undefined, cookie)).status, 400);
  assert.throws(() => createChat({ dbFile: 'unused.sqlite', encryptionKey, inviteCode: invite, publicOrigin: 'http://47.111.21.130' }), /HTTPS/);
});

test('private chat assets exist and service worker never caches chat APIs', async () => {
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.ok(!sw.includes("'/api/chat"));
  const script = await readFile(new URL('../public/chat.js', import.meta.url), 'utf8');
  assert.ok(!script.includes('innerHTML'));
});

test('restart recovers pending turns and incorrect encryption keys fail closed', async t => {
  const { call, register, dbFile, restart } = await fixture(t);
  const cookie = await register('alice');
  const db = new DatabaseSync(dbFile);
  db.prepare("INSERT INTO turns(user_id,request_id,prompt,status,created) VALUES (1,'interrupted-request','中断的问题','pending',?)").run(Date.now());
  db.close();
  assert.throws(() => createChat({ dbFile, encryptionKey: 'ef'.repeat(32), inviteCode: invite, publicOrigin: 'http://localhost' }), /does not match/);
  await restart();
  const turn = (await call('/messages', undefined, cookie)).data.turns[0];
  assert.equal(turn.status, 'failed');
  assert.match(turn.error, /重启/);
});

test('facts extracted from replies are injected into later system prompts and can be reviewed', async t => {
  const systems = [];
  let extractionCalls = 0;
  const { call, register } = await fixture(t, async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    const body = JSON.parse(options.body);
    if (body.response_format) {
      extractionCalls++;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          episode: '在长海站了很久，说五彩池比照片蓝，走了六小时说腿疼。',
          add: [{ subject: '她', predicate: '怕高', value: '是', confidence: 0.9 }],
          update: [], forget: []
        }) } }]
      });
    }
    systems.push(body.messages[0].content);
    return Response.json({ choices: [{ message: { content: `回答${systems.length}` } }] });
  });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  for (let index = 1; index <= 5; index++) {
    assert.equal((await call('/send', { requestId: `request-number-000${index}`, content: `第${index}句` }, cookie)).status, 200);
  }

  // 抽取是异步的：轮询记忆接口直到事实落库。
  let facts = [];
  for (let attempt = 0; attempt < 60 && !facts.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    facts = (await call('/memory', undefined, cookie)).data.facts;
  }
  assert.ok(extractionCalls >= 1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].predicate, '怕高');

  // 下一轮的系统指令里必须带上这条记忆。
  assert.equal((await call('/send', { requestId: 'request-number-0006', content: '今天走不动了' }, cookie)).status, 200);
  assert.match(systems.at(-1), /长期记忆/);
  assert.match(systems.at(-1), /怕高/);

  // 用户自己删掉这条记忆。
  const review = (await call('/memory', undefined, cookie)).data;
  assert.match(review.block, /怕高/);
  assert.equal(review.episodes.length, 1);
  assert.match(review.episodes[0].content, /五彩池/);
  assert.match(systems.at(-1), /五彩池/);
  const removed = await call('/memory', { forget: [facts[0].id] }, cookie);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.changes.forgotten, 1);
  assert.equal(removed.data.facts.filter(fact => fact.status === 'active').length, 0);
});

test('one account cannot review or delete another account memories', async t => {
  const { call, register } = await fixture(t);
  const alice = await register('alice');
  const bob = await register('bob');
  await call('/key', { key }, alice);
  const dbOnly = await call('/memory', undefined, alice);
  assert.deepEqual(dbOnly.data.facts, []);
  assert.equal(dbOnly.data.episodes.length, 0);
  // bob 删除 alice 的（不存在的）事实不应产生任何变化。
  const result = await call('/memory', { forget: [1, 2, 3] }, bob);
  assert.equal(result.status, 200);
  assert.equal(result.data.changes.forgotten, 0);
  assert.equal(result.data.changes.rejected, 3);
});

test('streaming pushes each sentence as its own event and persists the segments', async t => {
  const { call, register, stream } = await fixture(t, async url => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    return sseResponse(['第一句。', '第二句。']);
  });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  const result = await stream('/send', { requestId: 'stream-request-0001', content: '你好' }, cookie);
  assert.equal(result.status, 200);
  assert.match(result.type, /text\/event-stream/);

  const segments = result.events.filter(event => event.event === 'segment').map(event => event.data.text);
  assert.deepEqual(segments, ['第一句。', '第二句。']);
  const ready = result.events.find(event => event.event === 'ready');
  assert.equal(ready.data.name, '大肥鱼');
  const done = result.events.find(event => event.event === 'done');
  assert.equal(done.data.turn.reply, '第一句。第二句。');
  assert.deepEqual(done.data.turn.segments, ['第一句。', '第二句。']);

  const stored = (await call('/messages', undefined, cookie)).data.turns;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'complete');
  assert.deepEqual(stored[0].segments, ['第一句。', '第二句。']);
});

test('a meme tag is stripped from the reply and stored as a picture reference', async t => {
  const { call, register } = await fixture(t, async url => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    return Response.json({ choices: [{ message: { content: '草 绷不住了<meme:happy>' }, finish_reason: 'stop' }] });
  });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  const turn = (await call('/send', { requestId: 'meme-request-0001', content: '给你看个乐子' }, cookie)).data.turn;
  assert.equal(turn.reply, '草 绷不住了');
  assert.equal(turn.segments[0], '草 绷不住了');
  assert.equal(turn.meme.category, 'happy');
  assert.equal(turn.meme.url, '/memes/happy/a.png');
  // 标记不能漏进历史上下文，否则模型会学着自己复读。
  const stored = (await call('/messages', undefined, cookie)).data.turns[0];
  assert.ok(!stored.reply.includes('<meme:'));
});

test('proactive messages only go to opted-in accounts and respect the daily cap', async t => {
  const { call, register, getServer } = await fixture(t, async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    const body = JSON.parse(options.body);
    if (body.response_format) return Response.json({ choices: [{ message: { content: '{"episode":"","add":[],"update":[],"forget":[]}' } }] });
    return Response.json({ choices: [{ message: { content: '你在哪儿呢' } }] });
  }, { proactive: { enabled: true, minGapHours: 0, quietHours: [0, 0], dailyMax: 1, checkMinutes: 0 } });

  const alice = await register('alice');
  const bob = await register('bob');
  await call('/key', { key }, alice);
  await call('/key', { key }, bob);

  // 默认关闭：两个人都不该收到主动消息。
  assert.equal((await call('/proactive', undefined, alice)).data.enabled, false);
  assert.equal(await getServer().chatService.runProactive(), 0);

  await call('/proactive', { enabled: true }, alice);
  assert.equal((await call('/proactive', undefined, alice)).data.enabled, true);
  assert.equal(await getServer().chatService.runProactive(), 1);

  const turns = (await call('/messages', undefined, alice)).data.turns;
  assert.equal(turns.at(-1).kind, 'proactive');
  assert.equal(turns.at(-1).reply, '你在哪儿呢');
  assert.equal((await call('/messages', undefined, bob)).data.turns.length, 0);

  // 同一天已经发过一条，达到上限后不再发。
  assert.equal(await getServer().chatService.runProactive(), 0);
});

test('real-time questions trigger a search whose results enter the system prompt', async t => {
  let searched = null;
  let system = '';
  const { call, register } = await fixture(t, async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    if (url.endsWith('/v1/tools/search')) {
      searched = JSON.parse(options.body);
      return Response.json({ results: [
        { title: '九寨沟景区公告', summary: '旺季 7:00 开园，18:00 停止入园。', site_name: '景区官网', authority: 4, date: '2026-10-20T00:00:00Z' }
      ] });
    }
    const body = JSON.parse(options.body);
    if (body.response_format) return Response.json({ choices: [{ message: { content: '{"episode":"","add":[],"update":[],"forget":[]}' } }] });
    system = body.messages[0].content;
    return Response.json({ choices: [{ message: { content: '七点开园 六点停止入园' } }] });
  }, { search: { enabled: true } });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  await call('/send', { requestId: 'search-request-0001', content: '景区几点关门' }, cookie);
  assert.equal(searched.query, '景区几点关门');
  assert.match(system, /刚查到的资料/);
  assert.match(system, /7:00 开园/);
  assert.match(system, /不要念来源列表/);
});

test('search failures and non-real-time messages fall back without blocking the reply', async t => {
  let searchCalls = 0;
  const { call, register } = await fixture(t, async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    if (url.endsWith('/v1/tools/search')) { searchCalls++; return new Response('down', { status: 503 }); }
    const body = JSON.parse(options.body);
    if (body.response_format) return Response.json({ choices: [{ message: { content: '{"episode":"","add":[],"update":[],"forget":[]}' } }] });
    return Response.json({ choices: [{ message: { content: '好' } }] });
  }, { search: { enabled: true } });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  // 搜索服务挂掉也要正常回。
  assert.equal((await call('/send', { requestId: 'search-request-0002', content: '今天天气怎么样' }, cookie)).status, 200);
  assert.equal(searchCalls, 1);
  // 日常闲聊不触发搜索。
  assert.equal((await call('/send', { requestId: 'search-request-0003', content: '我有点累了' }, cookie)).status, 200);
  assert.equal(searchCalls, 1);
});

test('a leading question mark never splits a bubble', () => {
  assert.deepEqual(splitSegments('?真的假的'), ['?真的假的']);
  assert.deepEqual(splitSegments('诶 ?你叫什么'), ['诶 ?你叫什么']);
  assert.deepEqual(splitSegments('第一句。第二句。'), ['第一句。', '第二句。']);
  assert.deepEqual(splitSegments('真的吗？'), ['真的吗？']);
});

test('scenic knowledge is injected into the system prompt for the current day', async t => {
  let system = '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const guide = { days: [{ date: today, spotIds: ['wuhuahai'] }], referenceDays: [] };
  const knowledge = { spots: { wuhuahai: '九寨精华，水色分层。' }, tips: ['海拔高，慢慢走。'] };
  const { call, register } = await fixture(t, async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    const body = JSON.parse(options.body);
    if (body.response_format) return Response.json({ choices: [{ message: { content: '{"episode":"","add":[],"update":[],"forget":[]}' } }] });
    system = body.messages[0].content;
    return Response.json({ choices: [{ message: { content: '好' } }] });
  }, { guide, knowledge });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  await call('/send', { requestId: 'knowledge-request-001', content: '五花海有什么好看的' }, cookie);
  assert.match(system, /景区常识/);
  assert.match(system, /九寨精华/);
  assert.match(system, /海拔高/);
});

test('the opener asks once, requires a key, and never repeats', async t => {
  let modelCalls = 0;
  const { call, register } = await fixture(t, async url => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    modelCalls++;
    return Response.json({ choices: [{ message: { content: '诶 ?你叫什么' } }] });
  });
  const cookie = await register('alice');
  assert.equal((await call('/opener', {}, cookie)).status, 400);
  await call('/key', { key }, cookie);
  assert.equal(modelCalls, 0);

  const first = await call('/opener', {}, cookie);
  assert.equal(first.status, 200);
  assert.equal(first.data.opened, true);
  assert.equal(first.data.turn.kind, 'opener');
  assert.equal(first.data.turn.reply, '诶 ?你叫什么');

  const second = await call('/opener', {}, cookie);
  assert.equal(second.data.opened, false);
  assert.equal(modelCalls, 1);

  // 已经有记录的用户不会再次触发。
  const turns = (await call('/messages', undefined, cookie)).data.turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, 'opener');
});

test('streaming failure is reported as an event and keeps generated text', async t => {
  const { call, register, stream } = await fixture(t, async url => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    return Response.json({ error: { message: 'maximum context length exceeded' } }, { status: 400 });
  });
  const cookie = await register('alice');
  await call('/key', { key }, cookie);
  const result = await stream('/send', { requestId: 'stream-request-0002', content: '你好' }, cookie);
  assert.equal(result.status, 200);
  const failure = result.events.find(event => event.event === 'error');
  assert.ok(failure, 'should emit an error event');
  assert.match(failure.data.error, /上下文上限/);
  assert.equal(failure.data.turn.status, 'failed');
});
