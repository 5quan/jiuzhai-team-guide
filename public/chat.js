const $ = id => document.getElementById(id);
let registration = false;
let user = null;
let turns = [];
let busy = false;
let pollTimer;
let pendingRequest = null;
let streaming = null;
let abortController = null;
let pendingImages = [];
let version = 0;

function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

async function api(route, body) {
  const response = await fetch(`/api/chat${route}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && user) showUser(null);
    throw new Error(result.error || '请求失败，请稍后重试。');
  }
  return result;
}

function controls() {
  const waiting = busy || turns.some(turn => turn.status === 'pending');
  $('send').disabled = waiting || !user?.hasKey;
  $('send').textContent = waiting ? '正在思考…' : '发送';
  $('message').disabled = !user?.hasKey;
  $('logout').disabled = busy;
  $('stop').hidden = !streaming;
  $('image-input').disabled = waiting || !user?.hasKey;
  $('attach').setAttribute('aria-disabled', String(waiting || !user?.hasKey));
  for (const button of $('key-form').querySelectorAll('button')) button.disabled = waiting;
  for (const button of $('messages').querySelectorAll('button')) button.disabled = waiting || !user?.hasKey;
}

function showUser(value) {
  version++;
  clearTimeout(pollTimer);
  user = value;
  turns = [];
  pendingRequest = null;
  streaming = null;
  pendingImages = [];
  abortController?.abort();
  abortController = null;
  $('message').value = '';
  $('attachments').replaceChildren();
  $('attachments').hidden = true;
  $('messages').replaceChildren();
  $('auth-form').reset();
  $('key-form').reset();
  $('auth').hidden = Boolean(user);
  $('account').hidden = !user;
  $('conversation').hidden = !user;
  $('username').textContent = user?.username || '';
  $('key-panel').open = Boolean(user && !user.hasKey);
  $('empty').hidden = false;
  $('load-more').hidden = true;
  controls();
  if (user) loadProactive();
}

function avatarNode() {
  const avatar = document.createElement('img');
  avatar.className = 'avatar';
  avatar.src = '/avatar.webp';
  avatar.alt = '';
  avatar.loading = 'lazy';
  return avatar;
}

function message(role, content, created, options = {}) {
  const item = document.createElement('article');
  item.className = `message ${role}${options.follow ? ' follow' : ''}`;
  const body = document.createElement('div');
  body.className = 'body';
  if (!options.follow) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const who = role === 'user' ? '你' : (options.name || '大肥鱼');
    meta.textContent = `${who} · ${new Date(created).toLocaleString('zh-CN')}`;
    body.append(meta);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  // Both model and user text are untrusted; never interpret as HTML.
  bubble.textContent = content;
  body.append(bubble);
  if (role === 'assistant' && !options.follow) item.append(avatarNode());
  item.append(body);
  return item;
}

function imageGrid(images) {
  const grid = document.createElement('div');
  grid.className = 'image-grid';
  for (const image of images) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '发送的图片';
    img.src = image.name ? `/api/chat/images/${encodeURIComponent(image.name)}` : image.preview;
    grid.append(img);
  }
  return grid;
}

function typingBubble(name) {
  const item = document.createElement('article');
  item.className = 'message assistant';
  const body = document.createElement('div');
  body.className = 'body';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${name || '大肥鱼'} · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble typing';
  bubble.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  body.append(meta, bubble);
  item.append(avatarNode(), body);
  return item;
}

function memeBubble(meme, created) {
  const item = document.createElement('article');
  item.className = 'message assistant follow';
  const bubble = document.createElement('div');
  bubble.className = 'bubble meme';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = `表情：${meme.category}`;
  img.src = meme.url;
  bubble.append(img);
  item.append(bubble);
  return item;
}

function render(scroll = false) {
  const list = document.createDocumentFragment();
  for (const turn of turns) {
    // 只有普通用户发言才渲染用户气泡；主动消息和开场白都没有提问。
    if (turn.kind === 'user') {
      const userItem = message('user', turn.prompt, turn.created);
      if (turn.images?.length) userItem.append(imageGrid(turn.images));
      list.append(userItem);
    }

    const segments = turn.segments?.length ? turn.segments : turn.reply ? [turn.reply] : [];
    for (const [index, segment] of segments.entries()) {
      list.append(message('assistant', segment, turn.created, { follow: index > 0, name: turn.name }));
    }
    if (turn.meme) list.append(memeBubble(turn.meme, turn.created));
    if (turn.status === 'pending' && !streaming) list.append(typingBubble(turn.name));
    if (turn.error) {
      const item = document.createElement('div');
      item.className = 'message';
      const text = document.createElement('p');
      text.className = 'error';
      text.textContent = turn.error;
      item.append(text);
      if (turn.status === 'failed' && turn.id === turns.at(-1).id) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试这条消息';
        retry.addEventListener('click', () => sendMessage({ requestId: turn.request_id, content: turn.prompt }));
        item.append(retry);
      }
      list.append(item);
    }
  }

  if (streaming) {
    const userItem = message('user', streaming.prompt, streaming.created);
    if (streaming.images.length) userItem.append(imageGrid(streaming.images));
    list.append(userItem);
    if (!streaming.segments.length) list.append(typingBubble(streaming.name));
    for (const [index, segment] of streaming.segments.entries()) {
      list.append(message('assistant', segment, streaming.created, { follow: index > 0, name: streaming.name }));
    }
    if (streaming.error) {
      const item = document.createElement('div');
      item.className = 'message';
      const text = document.createElement('p');
      text.className = 'error';
      text.textContent = streaming.error;
      item.append(text);
      list.append(item);
    }
  }

  $('messages').replaceChildren(list);
  $('empty').hidden = turns.length > 0 || Boolean(streaming);
  controls();
  if (scroll) $('history').scrollTop = $('history').scrollHeight;
}

function nearBottom() {
  const history = $('history');
  return history.scrollHeight - history.scrollTop - history.clientHeight < 120;
}

async function loadMessages(older = false, scroll = false) {
  const revision = version;
  const result = await api(`/messages${older && turns.length ? `?before=${turns[0].id}` : ''}`);
  if (revision !== version || !user) return;
  const height = $('history').scrollHeight;
  if (older) turns = [...result.turns, ...turns];
  else {
    const byId = new Map(turns.map(turn => [turn.id, turn]));
    for (const turn of result.turns) {
      // An earlier polling response must not replace an already received complete reply.
      if (byId.get(turn.id)?.status !== 'complete' || turn.status === 'complete') byId.set(turn.id, turn);
    }
    turns = [...byId.values()].sort((a, b) => a.id - b.id);
  }
  if (older || turns.length <= 50) $('load-more').hidden = !result.hasMore;
  render(scroll);
  if (older) $('history').scrollTop += $('history').scrollHeight - height;
  clearTimeout(pollTimer);
  if (turns.some(turn => turn.status === 'pending')) {
    pollTimer = setTimeout(() => loadMessages(false, false).catch(error => notice(`${error.message} 刷新可重新读取记录。`, true)), 5000);
  }
}

$('switch-auth').addEventListener('click', () => {
  registration = !registration;
  $('invite-label').hidden = !registration;
  $('auth-form').elements.invite.required = registration;
  $('auth-form').elements.password.autocomplete = registration ? 'new-password' : 'current-password';
  $('auth-submit').textContent = registration ? '注册并登录' : '登录';
  $('switch-auth').textContent = registration ? '已有账号？去登录' : '有邀请码？注册账号';
  notice();
});

$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('auth-submit').disabled = true;
  $('switch-auth').disabled = true;
  notice('正在验证…');
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    showUser(await api(registration ? '/register' : '/login', data));
    notice(user.hasKey ? '' : '请先保存自己的 DeepSeek Key。');
    await loadMessages(false, true);
    maybeOpen();
  } catch (error) { notice(error.message, true); }
  finally { $('auth-submit').disabled = false; $('switch-auth').disabled = false; }
});

$('logout').addEventListener('click', async () => {
  try { await api('/logout', {}); showUser(null); notice('已退出登录。'); }
  catch (error) { notice(error.message, true); }
});
$('settings').addEventListener('click', () => { $('key-panel').open = !$('key-panel').open; });

async function saveKey(key) {
  busy = true; controls(); notice(key ? '正在验证 Key…' : '正在移除 Key…');
  try {
    const result = await api('/key', { key });
    user.hasKey = result.hasKey;
    $('key-form').reset();
    $('key-panel').open = !user.hasKey;
    notice(user.hasKey ? 'Key 已验证并保存，可以开始聊天。' : 'Key 已移除，聊天记录仍保留。');
    if (user.hasKey) maybeOpen();
  } catch (error) { notice(error.message, true); }
  finally { busy = false; controls(); }
}
$('key-form').addEventListener('submit', event => { event.preventDefault(); saveKey(event.currentTarget.elements.key.value.trim()); });
$('remove-key').addEventListener('click', () => saveKey(''));

const readAsDataURL = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('读取图片失败。'));
  reader.readAsDataURL(file);
});

// 重编码成 JPEG：既压小体积，也顺手剥掉 EXIF（含拍摄地点）。
async function compressImage(file) {
  if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) throw new Error('只支持 JPEG、PNG、GIF 或 WebP 图片。');
  if (file.size > 4 * 1024 * 1024) throw new Error('单张图片不能超过 4MB。');
  if (file.type === 'image/gif') return readAsDataURL(file);
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('这张图片无法读取。');
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const encoded = canvas.toDataURL('image/jpeg', 0.85);
  if (encoded.length * 0.75 > 4 * 1024 * 1024) throw new Error('图片压缩后仍然过大，请换一张。');
  return encoded;
}

function renderAttachments() {
  $('attachments').replaceChildren(...pendingImages.map(image => {
    const wrap = document.createElement('div');
    wrap.className = 'attachment';
    const img = document.createElement('img');
    img.src = image.preview;
    img.alt = '待发送的图片';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '移除这张图片');
    remove.addEventListener('click', () => {
      pendingImages = pendingImages.filter(item => item !== image);
      renderAttachments();
      controls();
    });
    wrap.append(img, remove);
    return wrap;
  }));
  $('attachments').hidden = pendingImages.length === 0;
}

$('image-input').addEventListener('change', async event => {
  const files = [...event.currentTarget.files].slice(0, Math.max(0, 4 - pendingImages.length));
  event.currentTarget.value = '';
  for (const file of files) {
    try {
      const dataURL = await compressImage(file);
      pendingImages.push({ dataURL, preview: dataURL });
    } catch (error) { notice(error.message, true); }
  }
  renderAttachments();
  controls();
});

async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (!event || !data) continue;
      try { yield { event, data: JSON.parse(data) }; } catch { /* 忽略不完整的一帧 */ }
    }
  }
}

async function sendMessage(request) {
  if (busy) return;
  busy = true;
  const revision = version;
  const staged = pendingImages.slice();
  streaming = { prompt: request.content, created: Date.now(), segments: [], images: staged, error: '', name: '' };
  const images = request.images || staged.map(image => image.dataURL);
  pendingImages = [];
  renderAttachments();
  controls();
  notice('');
  render(true);

  abortController = new AbortController();
  try {
    const response = await fetch('/api/chat/send', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ ...request, images }),
      signal: abortController.signal
    });
    if (!response.ok || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || '请求失败，请稍后重试。');
    }
    if (revision !== version) return;
    for await (const { event, data } of sseEvents(response)) {
      if (revision !== version) return;
      if (event === 'ready') streaming.name = data.name;
      else if (event === 'segment') {
        streaming.segments.push(data.text);
        render(nearBottom());
      } else if (event === 'done') {
        const incoming = { ...data.turn, name: streaming?.name };
        if (incoming.images?.length) {
          incoming.images = incoming.images.map((image, index) => ({ ...image, preview: streaming?.images[index]?.preview }));
        }
        const existing = turns.findIndex(turn => turn.id === incoming.id);
        if (existing < 0) turns.push(incoming); else turns[existing] = incoming;
        streaming = null;
        if ($('message').value.trim() === request.content) $('message').value = '';
        pendingRequest = null;
        notice('');
        render(true);
      } else if (event === 'error') {
        const kept = streaming?.segments || [];
        const incoming = { ...data.turn };
        const existing = turns.findIndex(turn => turn.id === incoming.id);
        if (existing < 0) turns.push(incoming); else turns[existing] = incoming;
        const target = turns.find(turn => turn.id === incoming.id);
        if (target && !target.segments?.length && kept.length) target.segments = kept;
        streaming = null;
        render(true);
        notice(data.error, true);
      }
    }
  } catch (error) {
    if (revision === version) {
      notice(error.name === 'AbortError' ? '已停止生成。' : error.message, true);
      try {
        await loadMessages(false, true);
        if (turns.some(turn => turn.request_id === request.requestId)) {
          if ($('message').value.trim() === request.content) $('message').value = '';
          pendingRequest = null;
        }
      } catch { /* Keep the same request ID for an uncertain network retry. */ }
    }
  } finally {
    if (revision === version) {
      streaming = null;
      busy = false;
      abortController = null;
      render(true);
    }
  }
}

$('stop').addEventListener('click', () => { abortController?.abort(); });

$('send-form').addEventListener('submit', event => {
  event.preventDefault();
  const content = $('message').value.trim();
  if (!content || busy || !user?.hasKey) return;
  if (new TextEncoder().encode(content).length > 16000) { notice('单条消息过长，请缩短后发送。', true); return; }
  const request = pendingRequest?.content === content ? pendingRequest : { requestId: crypto.randomUUID(), content };
  sendMessage(request);
});
$('message').addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('send-form').requestSubmit(); }
});
$('load-more').addEventListener('click', async () => {
  $('load-more').disabled = true;
  try { await loadMessages(true); } catch (error) { notice(error.message, true); }
  finally { $('load-more').disabled = false; }
});
async function loadProactive() {
  try {
    const result = await api('/proactive');
    $('proactive-toggle').checked = Boolean(result.enabled);
    $('proactive-toggle').disabled = !result.available;
    $('proactive-hint').textContent = result.available ? '' : '管理员还没开启这个能力。';
  } catch { /* 开关读取失败不影响聊天 */ }
}

$('proactive-toggle').addEventListener('change', async event => {
  const enabled = event.currentTarget.checked;
  event.currentTarget.disabled = true;
  try {
    await api('/proactive', { enabled });
    notice(enabled ? '她会偶尔主动找你了。' : '她不会再主动发消息。');
  } catch (error) {
    event.currentTarget.checked = !enabled;
    notice(error.message, true);
  } finally { event.currentTarget.disabled = false; }
});

let pollTick;
async function maybeOpen() {
  if (!user?.hasKey || turns.length) return;
  notice('她正在打字…');
  try {
    const result = await api('/opener', {});
    if (result.opened && result.turn) {
      turns.push(result.turn);
      render(true);
    }
    notice('');
  } catch { notice(''); /* 开场白失败不阻塞聊天 */ }
}

async function pollNew() {
  if (document.visibilityState !== 'visible' || busy || !user) return;
  const lastId = turns.at(-1)?.id || 0;
  try {
    const result = await api('/messages');
    const fresh = result.turns.filter(turn => turn.id > lastId);
    if (!fresh.length) return;
    turns = [...turns, ...fresh].sort((a, b) => a.id - b.id);
    render(nearBottom());
    if (fresh.some(turn => turn.kind === 'proactive')) notice('她主动找你说话了。');
  } catch { /* 轮询失败静默，下次再试 */ }
}
pollTick = setInterval(pollNew, 60000);

window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
async function init() {
  if (!window.isSecureContext) { notice('请通过 HTTPS 打开此页面后再登录。', true); return; }
  try { showUser(await api('/me')); notice(user.hasKey ? '' : '请先保存自己的 DeepSeek Key。'); await loadMessages(false, true); maybeOpen(); }
  catch (error) { if (!user) showUser(null); notice(error.message, error.message !== '请先登录。'); }
}
init();
