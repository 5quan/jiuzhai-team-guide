const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let guide;
const state = { view: 'home', nav: 'itinerary', mapDay: 'all', spot: 'wuhuahai', query: '', layer: 'clouds' };
const weatherCache = new Map();
let weatherRequest = 0;
let toastTimer;
let mapObserver;
let printOpen = [];
let printActive = false;
let mapInitialized = false;

function notify(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3000);
}

async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function external(url, text, classes = 'text-link') {
  return `<a class="${classes}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text} ↗</a>`;
}

function dayContent(day, index) {
  const brief = {
    arrival: '17:05 成都东 → 19:10 黄龙九寨',
    day1: '全天 · 日则沟 + 则查洼沟',
    day2: '14:00 沟口出发 → 成都 → 重庆',
    flight: '06:35 重庆 → 深圳'
  };
  return `<details class="day-card" id="day-${esc(day.id)}"><summary><span class="day-date"><strong>${esc(day.shortDate)}</strong><span>${esc(day.weekday)}</span></span><span class="day-overview"><span class="day-title"><span class="day-number">${index + 1}</span>${esc(day.label)}</span><span class="day-brief">${esc(brief[day.id] || day.subtitle)}</span><span class="day-stay">${esc(day.stay)}</span></span><span class="expand" aria-hidden="true">⌄</span></summary><div class="day-body"><ol class="timeline">${day.events.map(event => `<li><time>${esc(event.time)}</time><div><div class="event-title"><h3>${esc(event.title)}</h3><span class="status ${['待订', '待核验', '时间提醒'].includes(event.status) ? 'warning' : ''}">${esc(event.status)}</span></div><p>${esc(event.detail)}</p></div></li>`).join('')}</ol>${day.spotIds.length ? `<div class="route-shortcuts">${day.spotIds.map(id => `<button type="button" data-jump-spot="${esc(id)}">${esc(guide.spots.find(spot => spot.id === id).name)} ↗</button>`).join('')}</div>` : ''}</div></details>`;
}

function render() {
  $('#main').innerHTML = `
    <div data-view="home">
      <section id="itinerary" class="section itinerary" aria-labelledby="trip-title">
        <div class="trip-heading"><div><p class="eyebrow">2026.11.01 — 11.04 · ${guide.trip.people}人同行</p><h1 id="trip-title">九寨沟<span>四天三晚</span></h1></div><button class="icon-button" id="print-button" type="button" aria-label="打印全部行程">打印</button></div>
        <div class="trip-facts"><span>九寨沟沟外 <strong>2晚</strong></span><span>重庆机场附近 <strong>1晚</strong></span><span class="muted">酒店待定</span></div>
        <div class="days">${guide.days.map(dayContent).join('')}</div>
        <div class="departure-note"><strong>周二 14:00 从沟口出发</strong><span>周三 06:35起飞 · 目标04:35到航站楼</span></div>
        <a class="hours-line" href="#notes" data-nav="notes"><span>景区参考</span><strong>${esc(guide.park.open)}—${esc(guide.park.lastEntry)}入园 · ${esc(guide.park.close)}闭园</strong><span class="hours-note">以当日公告为准 ›</span></a>
      </section>
      <section id="route" class="section" aria-labelledby="map-title">
        <div class="section-heading"><h2 id="map-title">景点地图</h2>${external(guide.map.officialPage, '官方导览')}</div>
        <div class="map-filters segmented" role="group" aria-label="按游览日筛选地图"><button type="button" data-map-day="all" aria-pressed="true">全部</button><button type="button" data-map-day="1" aria-pressed="false">周一 · 上游两沟</button><button type="button" data-map-day="2" aria-pressed="false">周二 · 树正沟</button></div>
        <div class="map-layout"><div class="map-card"><div class="map-legend"><span><i></i>周一</span><span><i></i>周二</span><small>示意图 · 不用于导航</small></div><div id="schematic" class="map-viewport"></div></div><div class="map-side"><article class="spot-detail" id="spot-detail" aria-live="polite"></article><div class="spot-search"><label for="spot-search">查找景点</label><input id="spot-search" type="search" placeholder="景点 / 支沟" autocomplete="off"><div class="spot-list" id="spot-list"></div></div></div></div>
        <p class="footnote">实际开放、停靠站和游览方向听从现场调度。图中连线不代表可步行路线。</p>
      </section>
    </div>
    <section id="weather" class="section view" data-view="weather" aria-labelledby="weather-title" hidden>
      <div class="page-heading"><div><p class="eyebrow">四川 · 九寨沟景区</p><h1 id="weather-title" tabindex="-1">天气</h1></div>${external(guide.weather.fullUrl, '完整预报', 'button quiet')}</div>
      <p class="page-note">游览日：11月2—3日。请在图中选择日期，查看白天云量和降水。</p>
      <div class="weather-card"><div class="weather-toolbar"><div class="segmented" role="group" aria-label="天气图层"><button type="button" data-layer="clouds" aria-pressed="true">云量</button><button type="button" data-layer="rain" aria-pressed="false">降水</button><button type="button" data-layer="temp" aria-pressed="false">温度</button><button type="button" data-layer="wind" aria-pressed="false">风</button></div><button class="icon-button" id="reload-weather" type="button">重载</button></div><div id="weather-mount" class="weather-mount"></div></div>
      <p class="footnote">Windy 官方嵌入 · 33.20°N, 103.90°E。未进入预报时效的日期暂不可看；打不开时使用完整预报链接。</p>
      <div class="compact-card"><h2>出发前核对</h2><p>重点看07:30—16:00的云量、低云与降水，出发前3天再次核对。</p>${external(guide.sources.find(source => source.id === 'china-weather').url, '中国天气网 · 景区预报')}</div>
    </section>
    <section id="notes" class="section view" data-view="notes" aria-labelledby="notes-title" hidden>

    </section>`;
  weatherCache.set('clouds', guide.weather);
  mapInitialized = false;
  requestAnimationFrame(() => setTimeout(initMap, 0));
  $('#spot-search').addEventListener('input', event => { state.query = event.target.value.trim(); renderSpotList(); });
  $('#print-button').addEventListener('click', () => window.print());
  $('#reload-weather').addEventListener('click', () => switchWeather(state.layer, true));
  mapObserver?.disconnect();
  mapObserver = new IntersectionObserver(entries => {
    if (state.view === 'home' && entries[0].isIntersecting) setNav('route');
    else if (state.view === 'home' && $('#route').getBoundingClientRect().top > window.innerHeight * 0.5) setNav('itinerary');
  }, { rootMargin: '0px 0px -45% 0px' });
  mapObserver.observe($('#route'));
  navigate(location.hash.slice(1) || 'itinerary', false);
}

function renderNotes() {
  const c = guide.costs;
  $('#notes').innerHTML = `      <div class="page-heading"><div><p class="eyebrow">票务 · 住宿 · 接驳</p><h1 id="notes-title" tabindex="-1">注意事项</h1></div><span class="updated">核对 ${esc(guide.checkedAt)}</span></div>
      <section class="note-section"><h2>待落实</h2><ul class="pending-list">${guide.pending.map(item => `<li><span class="pending-dot" aria-hidden="true"></span><div><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></div></li>`).join('')}</ul></section>
      <section class="note-section"><h2>开闭园与返程</h2><dl class="info-rows"><div><dt>入园参考</dt><dd>${esc(guide.park.open)}—${esc(guide.park.lastEntry)}</dd></div><div><dt>闭园参考</dt><dd>${esc(guide.park.close)}</dd></div><div><dt>周二出沟目标</dt><dd>12:30前 · 午餐、取行李</dd></div><div><dt>送站出发</dt><dd>14:00 从沟口出发</dd></div></dl><p>${esc(guide.park.note)}</p><p>支线末班车可能早于闭园时间，入园时确认。送站预留约3—3.5小时接驳与候车；返程高铁待订。</p>${external(guide.sources.find(source => source.id === 'hours').url, '官方开放时间公告')}</section>
      <section class="note-section"><h2>两天门票与观光车</h2><dl class="info-rows"><div><dt>每天每位成人</dt><dd>门票¥${guide.ticket.entrance} + 观光车¥${guide.ticket.bus}</dd></div><div><dt>两天每人</dt><dd>¥${c.perPersonTwoDays}</dd></div><div><dt>全队两天</dt><dd>¥${c.teamTwoDays.toLocaleString()}</dd></div></dl><p>${esc(guide.ticket.note)}</p><p>${esc(guide.ticket.validity)}</p>${external(guide.sources.find(source => source.id === 'tickets').url, '官方票务')}</section>
      <section class="note-section"><h2>住宿与酒店往返</h2><dl class="info-rows"><div><dt>九寨沟</dt><dd>沟外连住两晚 · 11.01—11.03</dd></div><div><dt>预算</dt><dd>¥${guide.trip.hotelBudgetPerPersonNight}/人/晚 · 全队¥${c.hotelTeamNight}/晚</dd></div><div><dt>重庆</dt><dd>11.03 机场附近住1晚 · 待订</dd></div></dl><p>${esc(guide.trip.hotel.note)} 两天进出共4段，周二中午需能回酒店取行李。确认晚到保留、供暖、早餐与行李寄存。</p><p>重庆酒店提前确认凌晨送机。航班号和航站楼待核验，按06:35起飞、04:35到航站楼准备。</p></section>
      <section class="note-section"><h2>交通费用</h2><div class="transport-list">${guide.transport.map(item => `<div><h3>${esc(item.title)}<span class="status">${esc(item.badge)}</span></h3><p>${esc(item.text)}</p></div>`).join('')}</div></section>
      <section class="note-section sources"><details><summary>资料来源与说明</summary><p>景点时长和接驳为规划参考，以预约页和当日调度为准。页面仅展示公共行程。</p>${guide.sources.map(source => `<div class="source-item">${external(source.url, esc(source.title))}<p>${esc(source.note)}</p></div>`).join('')}</details></section>`;
  $('#notes').dataset.loaded = 'true';
}

function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;
  renderMap();
  renderDetail();
  renderSpotList();
}

function renderMap() {
  const nodes = guide.spots.map((spot, index) => {
    const [x, y] = spot.position;
    const left = spot.valley === '则查洼沟';
    return `<g class="spot-node ${state.spot === spot.id ? 'selected' : ''}" data-spot="${esc(spot.id)}" data-day="${spot.day}" role="button" tabindex="0" aria-label="查看${esc(spot.name)}" aria-pressed="${state.spot === spot.id}"><circle class="hit-target" cx="${x}" cy="${y}" r="44"/><circle class="route-dot" cx="${x}" cy="${y}" r="23"/><text class="route-number" x="${x}" y="${y}">${index + 1}</text><text class="spot-label" x="${x + (left ? -36 : 36)}" y="${y + 9}" text-anchor="${left ? 'end' : 'start'}">${esc(spot.name.replace(' / 树正寨', ''))}</text></g>`;
  }).join('');
  $('#schematic').innerHTML = `<svg class="route-svg" viewBox="0 0 800 1190" role="group" aria-label="九寨沟三沟景点关系示意图"><text class="valley-label" x="55" y="420">则查洼沟</text><text class="valley-label" x="615" y="420">日则沟</text><text class="valley-label" x="560" y="855">树正沟</text><path class="route-line line-day1" d="M190 100Q185 155 230 200T245 370T330 580"/><path class="route-line line-day1" d="M600 80Q600 115 555 180T535 270T505 365T470 455T410 515T330 580"/><path class="route-line line-day2" d="M330 580Q375 630 350 680T340 765T310 855T290 940T320 1020T330 1115"/>${nodes}<rect x="245" y="1095" width="170" height="50" rx="9" fill="#24594a"/><text x="330" y="1128" class="entrance-label" text-anchor="middle">景区入口</text></svg>`;
  updateMapSelection();
}

function renderDetail() {
  const spot = guide.spots.find(item => item.id === state.spot);
  $('#spot-detail').innerHTML = `<div class="detail-heading"><h3>${esc(spot.name)}</h3><span class="status ${spot.day === 2 ? 'warning' : ''}">${spot.day === 1 ? '周一' : '周二'}</span></div><p class="detail-meta">${esc(spot.valley)} · ${esc(spot.minutes)} · ${esc(spot.altitude)}</p><p>${esc(spot.description)}</p><details class="spot-extra"><summary>乘车与游览提示</summary><p>${esc(spot.travel)}</p></details>`;
}

function renderSpotList() {
  const filtered = guide.spots.filter(spot => (state.mapDay === 'all' || spot.day === Number(state.mapDay)) && `${spot.name}${spot.valley}`.includes(state.query));
  $('#spot-list').innerHTML = filtered.length ? filtered.map(spot => `<button type="button" class="${state.spot === spot.id ? 'active' : ''}" data-spot="${esc(spot.id)}" data-day="${spot.day}" aria-pressed="${state.spot === spot.id}"><i></i>${esc(spot.name.replace(' / 树正寨', ''))}</button>`).join('') : '<p class="empty">没有匹配景点</p>';
}

function updateMapSelection() {
  $$('.spot-node').forEach(node => {
    const selected = node.dataset.spot === state.spot;
    node.classList.toggle('selected', selected);
    node.classList.toggle('dimmed', state.mapDay !== 'all' && node.dataset.day !== state.mapDay);
    node.setAttribute('aria-pressed', String(selected));
  });
}

function selectSpot(id) {
  if (!guide.spots.some(spot => spot.id === id)) return;
  state.spot = id;
  updateMapSelection();
  renderDetail();
  renderSpotList();
}

function filterMap(day) {
  state.mapDay = day;
  const selected = guide.spots.find(spot => spot.id === state.spot);
  if (day !== 'all' && selected.day !== Number(day)) state.spot = guide.spots.find(spot => spot.day === Number(day)).id;
  $$('[data-map-day]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mapDay === day)));
  updateMapSelection();
  renderDetail();
  renderSpotList();
}

function setNav(nav) {
  state.nav = nav;
  $$('.bottom-nav a').forEach(link => {
    if (link.dataset.nav === nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function navigate(target, focus = true) {
  if (!['itinerary', 'route', 'weather', 'notes'].includes(target)) target = 'itinerary';
  state.view = ['weather', 'notes'].includes(target) ? target : 'home';
  if (target === 'notes' && !$('#notes').dataset.loaded) renderNotes();
  if (target === 'route') initMap();
  $$('[data-view]').forEach(view => { view.hidden = view.dataset.view !== state.view; });
  setNav(target);
  if (state.view !== 'weather') {
    weatherRequest++;
    $('#weather-mount').replaceChildren();
  } else if (!$('#windy-frame')) switchWeather(state.layer);
  if (target === 'route') $('#route').scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 0);
  if (focus && state.view !== 'home') $(`#${target}-title`).focus({ preventScroll: true });
}

async function switchWeather(layer, force = false) {
  const request = ++weatherRequest;
  state.layer = layer;
  $$('[data-layer]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layer === layer)));
  $('#weather-mount').setAttribute('aria-busy', 'true');
  let status = $('#weather-status');
  if (!status) {
    status = document.createElement('p');
    status.id = 'weather-status';
    status.className = 'weather-status';
    status.setAttribute('role', 'status');
    $('#weather-mount').prepend(status);
  }
  status.hidden = false;
  status.textContent = '正在加载 Windy，较慢时可打开完整预报。';
  try {
    const weather = weatherCache.get(layer) || await getJSON(`/api/weather?layer=${encodeURIComponent(layer)}`);
    if (request !== weatherRequest || state.view !== 'weather') return;
    weatherCache.set(layer, weather);
    let frame = $('#windy-frame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'windy-frame';
      frame.className = 'weather-frame';
      frame.title = 'Windy九寨沟实时天气地图';
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.allowFullscreen = true;
      frame.addEventListener('load', () => { status.hidden = true; });
      $('#weather-mount').append(frame);
    }
    if (force || frame.getAttribute('src') !== weather.embedUrl) frame.src = weather.embedUrl;
  } catch {
    if (request === weatherRequest && state.view === 'weather') {
      status.textContent = '暂时无法加载，请重试或打开完整预报。';
      notify('天气加载失败，请重试或打开完整预报。');
    }
  } finally {
    if (request === weatherRequest) $('#weather-mount').removeAttribute('aria-busy');
  }
}

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-nav]');
  if (nav && guide) {
    event.preventDefault();
    const target = nav.dataset.nav;
    if (location.hash !== `#${target}`) history.pushState(null, '', `#${target}`);
    navigate(target);
    return;
  }
  const spot = event.target.closest('[data-spot]');
  if (spot) selectSpot(spot.dataset.spot);
  const filter = event.target.closest('[data-map-day]');
  if (filter) filterMap(filter.dataset.mapDay);
  const jump = event.target.closest('[data-jump-spot]');
  if (jump) {
    filterMap('all');
    selectSpot(jump.dataset.jumpSpot);
    history.pushState(null, '', '#route');
    navigate('route');
  }
  const layer = event.target.closest('[data-layer]');
  if (layer && layer.dataset.layer !== state.layer) switchWeather(layer.dataset.layer);
});

document.addEventListener('keydown', event => {
  const node = event.target.closest('.spot-node');
  if (node && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectSpot(node.dataset.spot); }
});
window.addEventListener('popstate', () => { if (guide) navigate(location.hash.slice(1) || 'itinerary', false); });
window.addEventListener('hashchange', () => { if (guide) navigate(location.hash.slice(1) || 'itinerary', false); });
window.addEventListener('beforeprint', () => {
  if (printActive) return;
  printActive = true;
  printOpen = $$('.day-card').map(card => card.open);
  $$('.day-card').forEach(card => { card.open = true; });
});
window.addEventListener('afterprint', () => {
  if (!printActive) return;
  $$('.day-card').forEach((card, index) => { card.open = printOpen[index]; });
  printActive = false;
});
$('#share-button').addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(location.href.split('#')[0]);
    notify('链接已复制');
  } catch { notify('请复制地址栏链接分享'); }
});

async function boot() {
  try { guide = await getJSON('/api/guide'); render(); }
  catch {
    $('#main').innerHTML = '<div class="error-box"><h1>行程加载失败</h1><button class="button" id="retry" type="button">重试</button></div>';
    $('#retry').addEventListener('click', boot, { once: true });
  }
}
boot();
