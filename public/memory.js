const $ = id => document.getElementById(id);
let busy = false;

function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

async function api(route, body) {
  const response = await fetch(`/api/chat${route}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || '请求失败，请稍后重试。'), { status: response.status });
  return result;
}

const when = value => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });

function factLine(fact) {
  const item = document.createElement('li');
  const text = document.createElement('div');
  text.className = 'text';
  const head = document.createElement('strong');
  head.textContent = `${fact.subject}：${fact.predicate}`;
  const value = document.createElement('span');
  value.textContent = ` → ${fact.value}`;
  const meta = document.createElement('span');
  meta.className = 'when';
  meta.textContent = `${when(fact.updated)} 确认 · 置信度 ${Math.round(fact.confidence * 100)}%`;
  text.append(head, value, meta);
  item.append(text);

  if (fact.status === 'active') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '删掉';
    remove.addEventListener('click', () => forget(fact, remove));
    item.append(remove);
  }
  return item;
}

function episodeLine(episode) {
  const item = document.createElement('li');
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = episode.content;
  const meta = document.createElement('span');
  meta.className = 'when';
  meta.textContent = `${when(episode.created)} · 第 ${episode.from_turn}–${episode.to_turn} 轮`;
  text.append(meta);
  item.append(text);
  return item;
}

async function forget(fact, button) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  notice(`正在删除「${fact.predicate}」…`);
  try {
    const result = await api('/memory', { forget: [fact.id] });
    renderFacts(result.facts.filter(item => item.status === 'active'), result.facts.filter(item => item.status === 'superseded'));
    notice('已删除。它不会再被提起。');
  } catch (error) {
    notice(error.message, true);
    button.disabled = false;
  } finally { busy = false; }
}

function renderFacts(active, superseded) {
  $('facts').replaceChildren(...active.map(factLine));
  $('history').replaceChildren(...superseded.map(factLine));
  $('facts-empty').hidden = active.length > 0;
  $('history-empty').hidden = superseded.length > 0;
  $('facts-count').textContent = active.length ? `（${active.length}）` : '';
  $('history-count').textContent = superseded.length ? `（${superseded.length}）` : '';
}

function render(data) {
  renderFacts(
    data.facts.filter(fact => fact.status === 'active'),
    data.facts.filter(fact => fact.status === 'superseded')
  );
  $('episodes').replaceChildren(...data.episodes.map(episodeLine));
  $('episodes-empty').hidden = data.episodes.length > 0;
  $('episodes-count').textContent = data.episodes.length ? `（${data.episodes.length}）` : '';
  if (data.trip) {
    $('trip').textContent = `${data.trip.label} · ${data.trip.start || '日期未定'} 至 ${data.trip.end || '日期未定'} · ${({ active: '进行中', done: '已结束', planned: '未开始' })[data.trip.status] || data.trip.status}`;
  } else {
    $('trip').textContent = '还没有关联到行程。';
  }
}

async function init() {
  try {
    const me = await api('/me');
    $('username').textContent = me.username;
    const data = await api('/memory');
    $('denied').hidden = true;
    $('memory').hidden = false;
    render(data);
    notice(data.facts.length || data.episodes.length ? '' : '还没有记住任何东西，先去聊天吧。');
  } catch (error) {
    if (error.status === 401) {
      $('denied').hidden = false;
      $('memory').hidden = true;
      notice('');
      return;
    }
    notice(error.message, true);
  }
}

init();
