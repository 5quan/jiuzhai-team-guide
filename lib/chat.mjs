import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { createLimiter } from './security.mjs';
import { PERSONA, normalizePersona, composeSystem, buildScene } from './persona.mjs';
import { createAttachmentStore, decodeDataUrl, splitSegments, MAX_IMAGES } from './attachments.mjs';
import {
  ensureMemorySchema, ensureTrip, listFacts, listEpisodes, applyFacts, memoryBlock,
  saveEpisode, extractMemories, EXTRACT_BATCH, MAX_EXTRACT_TURNS
} from './memory.mjs';
import { memePrompt, extractMeme, createMemeStream } from './memes.mjs';
import { needsSearch, webSearch, searchBlock } from './search.mjs';

const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
// 人设、说话方式和硬边界由 lib/persona.mjs 拼装；这里只保留兜底，避免人设缺失时裸奔。
const FALLBACK = '你是一个普通 AI 助手。用用户使用的语言清晰回答，默认使用中文。不确定时如实说明。';
const SEGMENT_DELAY = [180, 520];
const STOPPED = 499;

const wait = (ms, signal) => {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
};

/** 文本 → 一条 message；有图片时用内容块数组，图片只能出现在 user 消息里。 */
export function buildUserContent(text, images = []) {
  if (!images.length) return text;
  return [
    { type: 'text', text },
    ...images.map(image => ({ type: 'image_url', image_url: { url: image.url, detail: 'low' } }))
  ];
}

// Deliberately preserve every completed turn; never silently truncate or summarize.
export function buildContext(turns, current, { system = FALLBACK, images = [] } = {}) {
  // 历史里只回放文字：图片每张最多 1024 tokens，逐轮重发会让上下文和费用指数增长。
  return [{ role: 'system', content: system }, ...turns.flatMap(turn => [
    { role: 'user', content: turn.prompt },
    { role: 'assistant', content: turn.reply }
  ]), { role: 'user', content: buildUserContent(current, images) }];
}

/** 解析 DeepSeek 的 SSE 正文，逐块产出 delta 文本。 */
async function* readDeltas(body) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).replace(/\r$/, '');
      buffered = buffered.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') return;
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw fail(502, 'DeepSeek 返回了无法解析的数据，请重试。'); }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (typeof delta === 'string' && delta) yield { text: delta, finish: choice.finish_reason || null };
      else if (choice.finish_reason) yield { text: '', finish: choice.finish_reason };
    }
  }
}

export function createChat({
  dbFile, encryptionKey, inviteCode, publicOrigin, model = 'deepseek-flash',
  fetchImpl = fetch, timeoutMs = 90000, firstTokenMs = 20000, streaming = true,
  persona = PERSONA, guide = null, memes = null, segmentDelay = true, now = () => new Date(), timeZone = 'Asia/Shanghai',
  proactive = { enabled: false, minGapHours: 6, quietHours: [23, 8], dailyMax: 2, checkMinutes: 10 },
  search = { enabled: true }
} = {}) {
  if (!dbFile || !/^[a-f0-9]{64}$/i.test(encryptionKey || '') || (inviteCode || '').length < 16) {
    throw new Error('Chat requires CHAT_DB, a 64-hex CHAT_ENCRYPTION_KEY and CHAT_INVITE_CODE (16+ characters).');
  }
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('CHAT_ORIGIN must be an HTTPS origin (HTTP is allowed only on localhost).');
  }
  const secure = origin.protocol === 'https:';
  const secret = Buffer.from(encryptionKey, 'hex');
  mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
  const attachments = createAttachmentStore(path.join(path.dirname(dbFile), 'images'));
  const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, api_key TEXT, created INTEGER NOT NULL);    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
      prompt TEXT NOT NULL, reply TEXT, status TEXT NOT NULL, error TEXT, created INTEGER NOT NULL,
      images TEXT, segments TEXT, persona TEXT, meme TEXT, UNIQUE(user_id, request_id));
    CREATE INDEX IF NOT EXISTS turns_user ON turns(user_id, id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_turn ON turns(user_id) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS images (name TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), turn_id INTEGER,
      mime TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL);`);
  // 旧库补列：只加可空列，不重建表，确保已有聊天记录不受影响。
  const columns = new Set(db.prepare('PRAGMA table_info(turns)').all().map(column => column.name));
  for (const column of ['images', 'segments', 'persona', 'meme']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE turns ADD COLUMN ${column} TEXT`);
  }
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!userColumns.has('proactive')) db.exec('ALTER TABLE users ADD COLUMN proactive INTEGER NOT NULL DEFAULT 0');
  const turnColumns = new Set(db.prepare('PRAGMA table_info(turns)').all().map(column => column.name));
  if (!turnColumns.has('kind')) db.exec("ALTER TABLE turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'");
  ensureMemorySchema(db);
  // Detect a changed encryption key immediately, without exposing or destroying stored keys.
  db.exec('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const fingerprint = hash(encryptionKey);
  const previous = db.prepare("SELECT value FROM metadata WHERE name='key_fingerprint'").get();
  if (previous && previous.value !== fingerprint) { db.close(); throw new Error('CHAT_ENCRYPTION_KEY does not match the existing database.'); }
  db.prepare("INSERT OR IGNORE INTO metadata VALUES ('key_fingerprint', ?)").run(fingerprint);
  db.exec("UPDATE turns SET status='failed', error='服务重启中断了回复，请重试。' WHERE status='pending'");
  const authLimit = createLimiter({ perIp: 12, total: 60, windowMs: 60000 });
  const chatLimit = createLimiter({ perIp: 10, total: 60, windowMs: 60000 });
  const active = new Set();
  let authActive = 0;
  let requests = 0;
  let closing = false;
  const seal = (value, userId) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(Buffer.from(String(userId)));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  };
  const unseal = (value, userId) => {
    const buffer = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', secret, buffer.subarray(0, 12));
    cipher.setAAD(Buffer.from(String(userId)));
    cipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
  };
  const cookie = (token, maxAge) => `chat_session=${token}; Path=/api/chat; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const personaOf = () => {
    const stored = db.prepare("SELECT value FROM metadata WHERE name='persona'").get();
    return normalizePersona(stored ? JSON.parse(stored.value) : persona);
  };
  const systemOf = (userId, lookup = '') => composeSystem(personaOf(), {
    scene: buildScene(guide, { now: now(), timeZone }),
    memory: memoryBlock(listFacts(db, userId, { includeHistory: true }), listEpisodes(db, userId)),
    extras: memePrompt(memes),
    search: lookup
  });
  const extracting = new Set();
  /**
   * 记忆抽取是增强功能：异步、限流、失败静默。用完即忘，绝不阻塞聊天或冒泡到用户。
   */
  const maybeExtract = user => {
    if (extracting.has(user.id) || !user.api_key) return;
    const state = db.prepare('SELECT last_turn FROM memory_state WHERE user_id=?').get(user.id);
    const after = state?.last_turn ?? 0;
    const rows = db.prepare("SELECT id,prompt,reply FROM turns WHERE user_id=? AND status='complete' AND id>? ORDER BY id ASC LIMIT ?")
      .all(user.id, after, MAX_EXTRACT_TURNS);
    if (rows.length < EXTRACT_BATCH) return;
    extracting.add(user.id);
    (async () => {
      try {
        const facts = listFacts(db, user.id, { includeHistory: true });
        const result = await extractMemories({
          fetchImpl, model, turns: rows, facts,
          key: unseal(user.api_key, user.id), now
        });
        if (!result) return;
        applyFacts(db, user.id, result.ops, { sourceTurn: rows.at(-1).id, now: now().getTime() });
        // 情景和事实来自同一次调用，不额外花钱。
        const episode = typeof result.ops.episode === 'string' ? result.ops.episode : '';
        if (episode.trim()) {
          saveEpisode(db, user.id, {
            fromTurn: rows[0].id, toTurn: rows.at(-1).id, content: episode, now: now().getTime()
          });
        }
        db.prepare('INSERT INTO memory_state(user_id,last_turn) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_turn=excluded.last_turn')
          .run(user.id, rows.at(-1).id);
      } catch { /* 记忆失败不影响聊天，下次轮次会再试 */ }
      finally { extracting.delete(user.id); }
    })();
  };
  const publicTurn = turn => ({
    id: turn.id, request_id: turn.request_id, prompt: turn.prompt, reply: turn.reply,
    status: turn.status, error: turn.error, created: turn.created,
    images: turn.images ? JSON.parse(turn.images) : [],
    segments: turn.segments ? JSON.parse(turn.segments) : null,
    meme: turn.meme ? JSON.parse(turn.meme) : null,
    kind: turn.kind || 'user'
  });
  const readTurn = id => publicTurn(db.prepare('SELECT * FROM turns WHERE id=?').get(id));
  const attachImages = async (userId, turnId, decoded) => {
    const list = [];
    for (const image of decoded) {
      const name = await attachments.save(image.bytes, image.ext);
      db.prepare('INSERT INTO images(name,user_id,turn_id,mime,bytes,created) VALUES (?,?,?,?,?,?)')
        .run(name, userId, turnId, image.mime, image.bytes.length, Date.now());
      list.push({ name, mime: image.mime, bytes: image.bytes.length });
    }
    return list;
  };
  const imageDataUrl = async image => {
    const bytes = await attachments.read(image.name);
    return bytes ? { url: `data:${image.mime};base64,${bytes.toString('base64')}`, detail: 'low' } : null;
  };
  const hourOf = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(now()));
  const insideQuiet = hour => {
    const [start, end] = proactive.quietHours || [23, 8];
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  };
  /**
   * 主动发一条消息。用的是用户自己的 Key，所以只对显式开启主动消息的账号执行。
   * 内容走同一套人设与情景，保证它像同一个人的随手一句，而不是推送。
   */
  const proactiveMessage = async user => {
    const history = db.prepare("SELECT prompt,reply FROM turns WHERE user_id=? AND status='complete' ORDER BY id DESC LIMIT 20").all(user.id).reverse();
    const scene = buildScene(guide, { now: now(), timeZone });
    const instruction = [
      '现在没有人跟你说话，是你自己想找她。',
      scene,
      '你可以问她现在到哪了、提醒她时间、或者接着上次没说完的话题。',
      '要求：只说一句话，不超过 25 个字，像微信随手发的。不要问「在吗」，不要自我介绍，不要解释你为什么突然说话。'
    ].filter(Boolean).join('\n');
    const response = await upstream('/chat/completions', unseal(user.api_key, user.id), {
      model, messages: buildContext(history, instruction, { system: systemOf(user.id) }),
      stream: false, thinking: { type: 'disabled' }, max_tokens: 120
    });
    let payload;
    try { payload = await response.json(); } catch { return null; }
    const raw = payload.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const parsed = extractMeme(raw, memes);
    if (!parsed.text.trim()) return null;
    const created = now().getTime();
    const inserted = db.prepare("INSERT INTO turns(user_id,request_id,prompt,reply,status,created,kind,segments,meme) VALUES (?,?,'',?,'complete',?,'proactive',?,?)")
      .run(user.id, `proactive-${created}-${user.id}`, parsed.text.trim(), created, JSON.stringify(splitSegments(parsed.text)), parsed.meme ? JSON.stringify(parsed.meme) : null);
    return readTurn(Number(inserted.lastInsertRowid));
  };
  const runProactive = async () => {
    if (!proactive.enabled) return 0;
    if (insideQuiet(hourOf())) return 0;
    const users = db.prepare('SELECT * FROM users WHERE proactive=1 AND api_key IS NOT NULL').all();
    const cutoff = now().getTime() - proactive.minGapHours * 3600000;
    const dayCutoff = now().getTime() - 24 * 3600000;
    let sent = 0;
    for (const user of users) {
      if (active.has(user.id)) continue;
      const last = db.prepare('SELECT created FROM turns WHERE user_id=? ORDER BY id DESC LIMIT 1').get(user.id);
      if (last && last.created > cutoff) continue;
      const count = db.prepare("SELECT COUNT(*) AS total FROM turns WHERE user_id=? AND kind='proactive' AND created>?").get(user.id, dayCutoff).total;
      if (count >= proactive.dailyMax) continue;
      try { if (await proactiveMessage(user)) sent++; } catch { /* 主动消息失败不影响聊天 */ }
    }
    return sent;
  };
  let proactiveTimer = null;
  if (proactive.enabled && proactive.checkMinutes > 0) {
    proactiveTimer = setInterval(() => { runProactive().catch(() => {}); }, proactive.checkMinutes * 60000);
    proactiveTimer.unref?.();
  }
  const sseHeaders = res => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
  };
  const sse = (res, event, data) => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };
  const readBody = async (req, limit = 24000) => {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '请使用 JSON 请求。');
    let size = 0;
    const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) { req.resume(); throw fail(413, '提交内容过长。'); }
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw fail(400, '请求格式不正确。'); }
  };
  const upstream = async (endpoint, key, body, signal) => {
    let response;
    try {
      response = await fetchImpl(`https://api.deepseek.com${endpoint}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal || AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw fail(STOPPED, '已停止生成。');
      if (error?.name === 'TimeoutError') throw fail(504, 'DeepSeek 响应超时，请稍后重试。');
      throw fail(504, 'DeepSeek 连接失败或超时，请稍后重试。');
    }
    if (response.ok) return response;
    const messages = { 401: 'DeepSeek Key 无效，请重新设置。', 402: 'DeepSeek 余额不足，请充值后重试。', 429: 'DeepSeek 请求繁忙，请稍后重试。' };
    if (response.status === 400 || response.status === 413) {
      let detail;
      try { detail = await response.json(); } catch { /* Do not expose upstream request details or keys. */ }
      const reason = String(detail?.error?.message || detail?.error?.code || '');
      if (response.status === 413 || /context|maximum.*token|token.*limit|too.*long/i.test(reason)) {
        throw fail(422, '完整聊天记录已超过 DeepSeek 的上下文上限。本次未生成回复，记录仍保留；系统不会自动压缩或截断历史。');
      }
      throw fail(502, 'DeepSeek 未接受本次请求，请联系管理员检查模型配置。');
    }
    await response.body?.cancel();
    throw fail(502, messages[response.status] || 'DeepSeek 暂时无法回复，请稍后重试。');
  };

  const handle = async (req, res, url) => {
    requests++;
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      if (!['GET', 'POST'].includes(req.method)) throw fail(405, '不支持的请求方法。');
      // The reverse proxy must be the only public entry. Never trust forwarded headers.
      if (req.headers.host !== origin.host) throw fail(403, '请求地址不匹配。');
      if (req.method === 'POST' && req.headers.origin !== publicOrigin) throw fail(403, '请求来源不匹配，请刷新页面。');
      const route = url.pathname.slice('/api/chat'.length);
      if (req.method === 'POST' && ['/register', '/login'].includes(route)) {
        if (authLimit(req.socket.remoteAddress || 'unknown') || authActive >= 2) throw fail(429, '登录或注册过于频繁，请稍后重试。');
        const body = await readBody(req);
        const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
        if (!/^[a-z0-9_]{3,32}$/.test(username) || typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) {
          throw fail(400, '用户名为 3–32 位字母、数字或下划线；密码为 10–128 位。');
        }
        authActive++;
        let user;
        try {
          if (route === '/register') {
            if (typeof body.invite !== 'string' || !timingSafeEqual(Buffer.from(hash(body.invite)), Buffer.from(hash(inviteCode)))) throw fail(403, '邀请码不正确。');
            const salt = randomBytes(16).toString('hex');
            const password = `${salt}:${(await derive(body.password, salt, 64)).toString('hex')}`;
            try { db.prepare('INSERT INTO users(username,password,created) VALUES (?,?,?)').run(username, password, Date.now()); }
            catch (error) { if (error.code?.startsWith('ERR_SQLITE') && db.prepare('SELECT id FROM users WHERE username=?').get(username)) throw fail(409, '该用户名已被使用。'); throw error; }
            user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
          } else {
            user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
            const [salt, expected] = (user?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
            const actual = await derive(body.password, salt, 64);
            if (!user || !timingSafeEqual(actual, Buffer.from(expected, 'hex'))) throw fail(401, '用户名或密码不正确。');
          }
        } finally { authActive--; }
        db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), user.id, Date.now() + 7 * 86400000);
        // Limit retained sessions per account.
        db.prepare('DELETE FROM sessions WHERE user_id=? AND token NOT IN (SELECT token FROM sessions WHERE user_id=? ORDER BY expires DESC LIMIT 10)').run(user.id, user.id);
        res.setHeader('Set-Cookie', cookie(token, 7 * 86400));
        send(200, { username: user.username, hasKey: Boolean(user.api_key) });
        return;
      }
      const token = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('chat_session='))?.slice(13) || '';
      const user = db.prepare('SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE sessions.token=? AND expires>?').get(hash(token), Date.now());
      if (!user) throw fail(401, '请先登录。');
      if (req.method === 'GET' && route === '/me') { send(200, { username: user.username, hasKey: Boolean(user.api_key) }); return; }
      if (req.method === 'GET' && route === '/persona') {
        const profile = personaOf();
        send(200, { name: profile.name, id: profile.id, version: profile.version, system: systemOf(user.id), core: profile.core, personality: profile.personality, speech: profile.speech, travel: profile.travel, boundaries: profile.boundaries, examples: profile.examples });
        return;
      }
      if (req.method === 'GET' && route === '/memory') {
        const facts = listFacts(db, user.id, { includeHistory: true });
        const episodes = listEpisodes(db, user.id, 20);
        let trip = null;
        if (guide) { try { trip = ensureTrip(db, user.id, guide, { now: now() }); } catch { trip = null; } }
        send(200, {
          facts: facts.map(fact => ({
            id: fact.id, subject: fact.subject, predicate: fact.predicate, value: fact.value,
            confidence: fact.confidence, status: fact.status, created: fact.created, updated: fact.updated
          })),
          episodes: episodes.map(episode => ({
            id: episode.id, from_turn: episode.from_turn, to_turn: episode.to_turn,
            content: episode.content, created: episode.created
          })),
          trip, block: memoryBlock(facts, episodes)
        });
        return;
      }
      if (req.method === 'GET' && route === '/proactive') {
        send(200, { enabled: Boolean(user.proactive), available: Boolean(proactive.enabled) });
        return;
      }
      if (req.method === 'GET' && route.startsWith('/images/')) {
        const image = db.prepare('SELECT * FROM images WHERE name=? AND user_id=?').get(route.slice('/images/'.length), user.id);
        const bytes = image && await attachments.read(image.name);
        if (!bytes) throw fail(404, '图片不存在。');
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=86400' });
        res.end(bytes);
        return;
      }
      if (req.method === 'GET' && route === '/messages') {
        const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
        if (!Number.isSafeInteger(before) || before < 1) throw fail(400, '无效的分页位置。');
        const rows = db.prepare('SELECT * FROM turns WHERE user_id=? AND id<? ORDER BY id DESC LIMIT 51').all(user.id, before);
        const hasMore = rows.length > 50;
        const turns = rows.slice(0, 50).reverse().map(publicTurn);
        send(200, { turns, hasMore }); return;
      }
      if (req.method !== 'POST') throw fail(404, '接口不存在。');
      // 带图片的消息才需要大请求体；其余接口维持 24KB 上限，避免被超长请求拖住。
      const body = await readBody(req, route === '/send' ? 20 * 1024 * 1024 : 24000);
      if (route === '/logout') {
        db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));
        res.setHeader('Set-Cookie', cookie('', 0)); send(200, { ok: true }); return;
      }
      // 用户自己改记忆：不需要调模型，也不占用生成锁。
      if (route === '/memory') {
        const changes = applyFacts(db, user.id, {
          forget: Array.isArray(body.forget) ? body.forget : [],
          update: Array.isArray(body.update) ? body.update : []
        }, { now: Date.now() });
        send(200, {
          ok: true, changes,
          facts: listFacts(db, user.id, { includeHistory: true }).map(fact => ({
            id: fact.id, subject: fact.subject, predicate: fact.predicate, value: fact.value,
            confidence: fact.confidence, status: fact.status, created: fact.created, updated: fact.updated
          }))
        });
        return;
      }
      if (route === '/proactive') {
        db.prepare('UPDATE users SET proactive=? WHERE id=?').run(body.enabled ? 1 : 0, user.id);
        send(200, { enabled: Boolean(body.enabled) });
        return;
      }
      if (!['/key', '/send'].includes(route)) throw fail(404, '接口不存在。');
      if (active.has(user.id)) throw fail(409, '正在处理上一条请求，请等待完成。');
      if (chatLimit(String(user.id)) || active.size >= 4) throw fail(429, '请求较多，请稍后再试。');
      active.add(user.id);
      req.setTimeout(timeoutMs + 10000);
      try {
        if (route === '/key') {
          if (body.key === '') { db.prepare('UPDATE users SET api_key=NULL WHERE id=?').run(user.id); send(200, { hasKey: false }); return; }
          if (typeof body.key !== 'string' || !/^[\x21-\x7e]{10,256}$/.test(body.key)) throw fail(400, 'Key 格式不正确。');
          await upstream('/models', body.key);
          db.prepare('UPDATE users SET api_key=? WHERE id=?').run(seal(body.key, user.id), user.id);
          send(200, { hasKey: true }); return;
        }
        if (!user.api_key) throw fail(400, '请先设置 DeepSeek Key。');
        if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId) || typeof body.content !== 'string' || !body.content.trim() || Buffer.byteLength(body.content) > 16000) throw fail(400, '消息不能为空，长度不能超过 16000 字节。');
        const decoded = (Array.isArray(body.images) ? body.images : []).map(value => decodeDataUrl(value));
        if (decoded.length > MAX_IMAGES) throw fail(400, `一次最多发送 ${MAX_IMAGES} 张图片。`);
        let turn = db.prepare('SELECT * FROM turns WHERE user_id=? AND request_id=?').get(user.id, body.requestId);
        if (turn && turn.prompt !== body.content.trim()) throw fail(409, '重试消息内容不匹配。');
        if (turn?.status === 'complete') { send(200, { turn: publicTurn(turn) }); return; }
        const latest = db.prepare('SELECT id,status FROM turns WHERE user_id=? ORDER BY id DESC LIMIT 1').get(user.id);
        if (turn && latest?.id !== turn.id) throw fail(409, '只能重试最后一条消息，请重新发送问题。');
        if (turn) db.prepare("UPDATE turns SET status='pending',error=NULL WHERE id=?").run(turn.id);
        else {
          db.prepare("INSERT INTO turns(user_id,request_id,prompt,status,created) VALUES (?,?,?,'pending',?)").run(user.id, body.requestId, body.content.trim(), Date.now());
          turn = db.prepare('SELECT * FROM turns WHERE user_id=? AND request_id=?').get(user.id, body.requestId);
        }
        // 同一 requestId 重试时图片已经落盘，不重复存储也不会错配。
        const storedImages = turn.images ? JSON.parse(turn.images) : [];
        if (decoded.length && storedImages.length !== decoded.length) {
          const images = await attachImages(user.id, turn.id, decoded);
          db.prepare('UPDATE turns SET images=? WHERE id=?').run(JSON.stringify(images), turn.id);
          turn = db.prepare('SELECT * FROM turns WHERE id=?').get(turn.id);
        }
        const profile = personaOf();
        if (guide) { try { ensureTrip(db, user.id, guide, { now: now() }); } catch { /* 行程数据缺失不影响聊天 */ } }
        db.prepare('UPDATE turns SET persona=? WHERE id=?').run(profile.id, turn.id);
        const history = db.prepare("SELECT prompt,reply,images FROM turns WHERE user_id=? AND status='complete' AND id<? ORDER BY id ASC").all(user.id, turn.id)
          .map(row => ({ ...row, images: row.images ? JSON.parse(row.images) : [] }));
        const images = (await Promise.all((turn.images ? JSON.parse(turn.images) : []).map(imageDataUrl))).filter(Boolean);
        // 只有问的是实时信息才联网；搜索失败就当没搜过，继续正常聊。
        let lookup = '';
        if (search.enabled && needsSearch(turn.prompt)) {
          try {
            lookup = searchBlock(await webSearch({ fetchImpl, key: unseal(user.api_key, user.id), query: turn.prompt }));
          } catch { lookup = ''; }
        }
        const messages = buildContext(history, turn.prompt, { system: systemOf(user.id, lookup), images });
        const wantsStream = streaming && (body.stream === true || /text\/event-stream/i.test(req.headers.accept || ''));
        if (wantsStream) {
          const controller = new AbortController();
          const onClose = () => { if (!res.writableEnded) controller.abort(); };
          res.on('close', onClose);
          let text = '';
          let finish = null;
          let committed = 0;
          let firstToken = true;
          const segments = [];
          // 表情标记可能被切在两段之间，交给剥离器跨段处理。
          const memeStream = createMemeStream(memes);
          try {
            sseHeaders(res);
            sse(res, 'ready', { id: turn.id, name: profile.name });
            const timeout = AbortSignal.timeout(timeoutMs);
            // 首 token 超时计时器必须在 upstream 抛错时也被清掉，否则会空挂 20 秒。
            const firstTimer = setTimeout(() => { if (firstToken) controller.abort(new Error('first-token')); }, firstTokenMs);
            try {
              const upstreamRes = await upstream('/chat/completions', unseal(user.api_key, user.id), {
                model, messages, stream: true, thinking: { type: 'disabled' }, max_tokens: 4096
              }, AbortSignal.any([controller.signal, timeout]));
              for await (const delta of readDeltas(upstreamRes.body)) {
                if (firstToken && delta.text) { firstToken = false; clearTimeout(firstTimer); }
                if (delta.finish) finish = delta.finish;
                if (!delta.text) continue;
                text += delta.text;
                if (text.length > 100000) throw fail(502, '回复过长，已停止。');
                // 边生成边按句推送：模型还在写下一句，前一句已经发出去了。
                const complete = splitSegments(text);
                complete.pop();
                const ready = complete.slice(committed);
                committed = complete.length;
                for (const segment of ready) {
                  const clean = memeStream.feed(segment).trim();
                  if (!clean) continue;
                  segments.push(clean);
                  sse(res, 'segment', { text: clean });
                  if (segmentDelay) await wait(SEGMENT_DELAY[0] + Math.random() * (SEGMENT_DELAY[1] - SEGMENT_DELAY[0]), controller.signal);
                  if (controller.signal.aborted) throw fail(STOPPED, '已停止生成。');
                }
              }
            } finally { clearTimeout(firstTimer); }
            // 收尾：committed 是「已发送的段数」，不能拿去切字符串，否则会重复推送。
            const remainder = splitSegments(text).slice(committed).join('').trim();
            const tail = `${memeStream.feed(remainder)}${memeStream.flush()}`.trim();
            if (tail) { segments.push(tail); sse(res, 'segment', { text: tail }); }
            const reply = segments.join('');
            if (!reply.trim()) throw fail(502, 'DeepSeek 未返回有效文字，请重试。');
            const note = finish === 'length' ? '回复达到长度上限，你可以发送“请继续”。' : null;
            db.prepare("UPDATE turns SET reply=?,status='complete',error=?,segments=?,meme=? WHERE id=?")
              .run(reply, note, JSON.stringify(segments), memeStream.meme ? JSON.stringify(memeStream.meme) : null, turn.id);
            sse(res, 'done', { turn: readTurn(turn.id) });
            maybeExtract(user);
            res.end();
            return;
          } catch (error) {
            const partial = text.trim();
            const stopped = controller.signal.aborted && (error.status === STOPPED || error.name === 'AbortError');
            const message = stopped ? '已停止生成。' : (error.status ? error.message : '回复失败，请重试。');
            const detail = partial ? `${message}（已生成的部分保留）` : message;
            db.prepare("UPDATE turns SET status='failed',error=?,reply=? WHERE id=?").run(detail, partial || null, turn.id);
            if (!res.headersSent) throw error;
            sse(res, 'error', { error: detail, turn: readTurn(turn.id) });
            res.end();
            return;
          } finally {
            res.off('close', onClose);
          }
        }
        try {
          const response = await upstream('/chat/completions', unseal(user.api_key, user.id), {
            model, messages, stream: false, thinking: { type: 'disabled' }, max_tokens: 4096
          });
          let result;
          try { result = await response.json(); }
          catch { throw fail(502, 'DeepSeek 返回了无效响应，请重试。'); }
          const choice = result.choices?.[0];
          const raw = choice?.message?.content;
          if (typeof raw !== 'string' || !raw.trim() || raw.length > 100000) throw fail(502, 'DeepSeek 未返回有效文字，请重试。');
          const parsed = extractMeme(raw, memes);
          if (!parsed.text.trim()) throw fail(502, 'DeepSeek 未返回有效文字，请重试。');
          const note = choice.finish_reason === 'length' ? '回复达到长度上限，你可以发送“请继续”。' : null;
          db.prepare("UPDATE turns SET reply=?,status='complete',error=?,segments=?,meme=? WHERE id=?")
            .run(parsed.text, note, JSON.stringify(splitSegments(parsed.text)), parsed.meme ? JSON.stringify(parsed.meme) : null, turn.id);
          send(200, { turn: readTurn(turn.id) });
          maybeExtract(user);
        } catch (error) {
          db.prepare("UPDATE turns SET status='failed',error=? WHERE id=?").run(error.status ? error.message : '回复失败，请重试。', turn.id);
          throw error;
        }
      } finally { active.delete(user.id); }
    } catch (error) {
      if (req.method === 'POST' && !req.readableEnded) { res.setHeader('Connection', 'close'); req.resume(); }
      if (res.headersSent || res.writableEnded) { res.end?.(); return; }
      send(error.status || 500, { error: error.status ? error.message : '服务暂时不可用，请稍后重试。' });
    } finally {
      requests--;
      if (closing && requests === 0) db.close();
    }
  };
  return {
    handle,
    runProactive,
    close: () => {
      closing = true;
      if (proactiveTimer) clearInterval(proactiveTimer);
      if (requests === 0) db.close();
    }
  };
}
