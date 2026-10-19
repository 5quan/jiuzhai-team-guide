const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let guide;
const state = { view: 'home', nav: 'itinerary', mapDay: 'all', spot: 'wuhuahai', query: '', layer: 'clouds', eventKey: null, legId: null, inlinePlace: null, routeChoices: new Map() };
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

function eventContext(key = state.eventKey) {
  if (!key || !guide.routing) return null;
  const [dayId, index] = key.split(':');
  const day = guide.days.find(item => item.id === dayId);
  const event = day?.events[Number(index)];
  const route = guide.routing.routes.find(item => item.id === event?.routeId);
  return route ? { day, event, route } : null;
}

function locationInfo(id) {
  const spot = guide.spots.find(item => item.id === id);
  if (spot) return { ...spot, scope: 'park', note: spot.travel };
  return guide.routing?.places.find(place => place.id === id);
}

function mapAnchor(id) {
  const place = locationInfo(id);
  if (!place || place.scope !== 'park') return null;
  if (place.anchorSpotId) return { id: place.anchorSpotId, position: locationInfo(place.anchorSpotId).position };
  return { id, position: place.position };
}

function legChoice(route, leg) {
  return leg.options[state.routeChoices.get(`${route.id}/${leg.id}`) ?? leg.recommended] || leg.options[leg.recommended];
}

function routeLocations(context) {
  if (!context) return [];
  const ids = [...context.route.locations];
  for (const leg of context.route.legs) ids.push(leg.from, ...(legChoice(context.route, leg).via || []), leg.to);
  return [...new Set(ids)];
}

function routeAnchors(context) {
  return [...new Map(routeLocations(context).map(mapAnchor).filter(Boolean).map(point => [point.id, point])).values()];
}

function dayEvent(day, event, index) {
  const key = `${day.id}:${index}`;
  const linked = guide.routing?.routes.some(route => route.id === event.routeId);
  const time = linked ? `<button class="time-link" type="button" data-event-route="${esc(key)}" aria-expanded="false" aria-controls="event-map-${day.id}-${index}"><time>${esc(event.time)}</time><span>地图与交通 ⌄</span></button>` : `<time>${esc(event.time)}</time>`;
  return `<li>${time}<div><div class="event-title"><h3>${esc(event.title)}</h3><span class="status ${['待订', '待核验', '时间提醒'].includes(event.status) ? 'warning' : ''}">${esc(event.status)}</span></div><p>${esc(event.detail)}</p></div>${linked ? `<section class="event-route-panel" id="event-map-${day.id}-${index}" aria-label="${esc(event.time)}地图与交通" hidden></section>` : ''}</li>`;
}

function closeEventRoute() {
  if (!state.eventKey) return;
  const button = $(`[data-event-route="${state.eventKey}"]`);
  const panel = button && document.getElementById(button.getAttribute('aria-controls'));
  if (panel) { panel.hidden = true; panel.replaceChildren(); }
  button?.setAttribute('aria-expanded', 'false');
  button?.closest('.day-card').classList.remove('with-route');
  state.eventKey = null;
  state.legId = null;
  updateMapSelection();
}

function openEventRoute(key) {
  const button = $(`[data-event-route="${key}"]`);
  if (!button) return;
  if (state.eventKey === key) { closeEventRoute(); button.focus({ preventScroll: true }); return; }
  closeEventRoute();
  state.eventKey = key;
  const context = eventContext();
  if (!context) return;
  initMap();
  state.legId = context.route.legs[0]?.id || null;
  state.inlinePlace = routeAnchors(context)[0]?.id || null;
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  panel.innerHTML = `<div class="inline-heading"><div><strong>${esc(context.day.shortDate)} ${esc(context.event.time)}</strong><p>${esc(context.event.title)}</p></div><button class="icon-button" type="button" data-close-event aria-label="收起地图与交通">收起</button></div><div class="inline-layout"><div class="inline-map-side"><div class="inline-map-slot"></div><div class="inline-place-buttons" role="group" aria-label="本时段位置"></div><div class="inline-place-info" aria-live="polite"></div><div class="outside-places"></div></div><div class="inline-transit"><h4>本段怎么走</h4><ol class="leg-list">${context.route.legs.map((leg, index) => `<li class="leg-card" data-leg-card="${esc(leg.id)}"><div class="leg-heading"><button type="button" class="leg-focus" data-leg-focus="${esc(leg.id)}" aria-pressed="${index === 0}"><span class="leg-index">${index + 1}</span><span class="leg-endpoints"></span></button><span class="mode-badge"></span></div>${leg.options.length > 1 ? `<label class="transport-label">交通方式<select data-transport="${esc(leg.id)}" aria-label="${esc(locationInfo(leg.from).name)}到${esc(locationInfo(leg.to).name)}交通方式">${leg.options.map((option, optionIndex) => `<option value="${optionIndex}">${esc(option.label)}${optionIndex === leg.recommended && option.mode !== 'pending' ? '（推荐）' : ''}</option>`).join('')}</select></label>` : ''}<p class="leg-note"></p><p class="leg-warning" hidden></p></li>`).join('')}</ol>${context.route.legs.length ? '' : '<p class="venue-note">本时段在同一地点活动，暂无景点间交通。</p>'}<p class="route-context-note">${esc(context.route.note)}</p><details class="route-basis"><summary>交通依据与位置说明</summary><p>${esc(guide.routing.note)}</p><p>沟内观光车使用当天车票；酒店、车站与机场接驳另计。小地图只提示所在区域，不用于步行导航。</p>${guide.routing.sourceIds.map(id => { const source = guide.sources.find(item => item.id === id); return external(source.url, esc(source.title)); }).join('')}</details></div></div>`;
  panel.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  button.closest('.day-card').classList.add('with-route');
  buildInlineMap(panel, context);
  updateInlineRoute();
  const bounds = button.getBoundingClientRect();
  if (bounds.top < 0 || bounds.bottom > window.innerHeight - 84) button.scrollIntoView({ block: 'nearest' });
}

function buildInlineMap(panel, context) {
  const points = routeAnchors(context);
  const mount = $('.inline-map-slot', panel);
  if (!points.length) { mount.innerHTML = '<p class="outside-map-note">本段在沟外，地点信息列在下方。</p>'; return; }
  const svg = $('.route-svg').cloneNode(true);
  svg.classList.add('mini-map');
  svg.setAttribute('aria-label', `${context.event.time}相关景点小地图`);
  const xs = points.map(point => point.position[0]);
  const ys = points.map(point => point.position[1]);
  const width = Math.max(420, Math.min(800, Math.max(...xs) + 245) - Math.max(0, Math.min(...xs) - 190));
  const height = Math.max(320, Math.min(1190, Math.max(...ys) + 90) - Math.max(0, Math.min(...ys) - 75));
  const left = Math.min(800 - width, Math.max(0, Math.min(...xs) - 190));
  const top = Math.min(1190 - height, Math.max(0, Math.min(...ys) - 75));
  svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);
  $$('.spot-node', svg).forEach(node => {
    node.dataset.inlinePlace = node.dataset.spot;
    node.removeAttribute('data-spot');
  });
  const entrance = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  entrance.classList.add('spot-node', 'gate-node');
  entrance.dataset.inlinePlace = 'park-gate';
  entrance.setAttribute('role', 'button');
  entrance.setAttribute('tabindex', '0');
  entrance.setAttribute('aria-label', '查看景区入口');
  entrance.innerHTML = '<rect x="245" y="1095" width="170" height="50" rx="9" fill="transparent" stroke="currentColor" stroke-width="6"/>';
  svg.append(entrance);
  mount.append(svg);
}

function updateInlineRoute() {
  const context = eventContext();
  if (!context) return;
  const panel = $('.event-route-panel:not([hidden])');
  if (!panel) return;
  const refs = routeLocations(context);
  const points = routeAnchors(context);
  const activeLeg = context.route.legs.find(leg => leg.id === state.legId);
  const legIds = activeLeg ? [activeLeg.from, ...(legChoice(context.route, activeLeg).via || []), activeLeg.to].map(mapAnchor).filter(Boolean).map(point => point.id) : [];
  for (const leg of context.route.legs) {
    const card = $(`[data-leg-card="${leg.id}"]`, panel);
    const option = legChoice(context.route, leg);
    const names = [leg.from, ...(option.via || []), leg.to].map(id => locationInfo(id).name);
    $('.leg-endpoints', card).textContent = names.join(' → ');
    $('.mode-badge', card).textContent = option.label;
    $('.mode-badge', card).dataset.mode = option.mode;
    $('.leg-note', card).textContent = option.note;
    $('.leg-warning', card).hidden = !option.warning;
    $('.leg-warning', card).textContent = option.warning || '';
    $('.leg-focus', card).setAttribute('aria-pressed', String(leg.id === state.legId));
    card.classList.toggle('active-leg', leg.id === state.legId);
    const select = $('select', card);
    if (select) select.value = String(state.routeChoices.get(`${context.route.id}/${leg.id}`) ?? leg.recommended);
  }
  if (!points.some(point => point.id === state.inlinePlace)) state.inlinePlace = points[0]?.id || null;
  const aliasName = id => {
    const original = refs.includes(id);
    const aliases = refs.map(locationInfo).filter(place => place.anchorSpotId === id);
    return original || !aliases.length ? locationInfo(id).name : `${locationInfo(id).name.replace('瀑布', '')}区域`;
  };
  $$('.mini-map .spot-node', panel).forEach(node => {
    const id = node.dataset.inlinePlace;
    const inRoute = points.some(point => point.id === id);
    node.classList.toggle('in-time', inRoute);
    node.classList.toggle('active-leg', legIds.includes(id));
    node.classList.toggle('selected', state.inlinePlace === id);
    node.classList.remove('dimmed');
    node.setAttribute('aria-pressed', String(state.inlinePlace === id));
    node.tabIndex = inRoute ? 0 : -1;
    const label = $('.spot-label', node);
    if (label && inRoute) label.textContent = aliasName(id).replace(' / 树正寨', '');
  });
  const placeButtons = $('.inline-place-buttons', panel);
  const signature = points.map(point => point.id).join('/');
  if (placeButtons.dataset.places !== signature) {
    placeButtons.innerHTML = points.map(point => `<button type="button" data-inline-place="${esc(point.id)}">${esc(aliasName(point.id))}</button>`).join('');
    placeButtons.dataset.places = signature;
  }
  $$('[data-inline-place]', placeButtons).forEach(button => button.setAttribute('aria-pressed', String(button.dataset.inlinePlace === state.inlinePlace)));
  const related = refs.map(locationInfo).filter(place => mapAnchor(place.id)?.id === state.inlinePlace);
  $('.inline-place-info', panel).innerHTML = related.length ? `<strong>${related.map(place => esc(place.name)).join(' / ')}</strong>${related.map(place => `<p>${esc(place.note)}</p>`).join('')}` : '';
  $('.outside-places', panel).innerHTML = refs.map(locationInfo).filter(place => place.scope === 'outside').map(place => `<div class="outside-place"><strong>${esc(place.name)}</strong><p>${esc(place.note)}</p></div>`).join('');
  updateMapSelection();
}

function selectInlinePlace(id) {
  if (!routeAnchors(eventContext()).some(point => point.id === id)) return;
  state.inlinePlace = id;
  updateInlineRoute();
}

function focusLeg(id) {
  const context = eventContext();
  const leg = context?.route.legs.find(item => item.id === id);
  if (!leg) return;
  state.legId = id;
  state.inlinePlace = mapAnchor(leg.from)?.id || mapAnchor(leg.to)?.id || null;
  updateInlineRoute();
}


function dayContent(day, index) {
  const brief = {
    arrival: '17:05 成都东 → 19:10 黄龙九寨',
    day1: '全天 · 日则沟 + 则查洼沟',
    day2: '14:00 沟口出发 → 成都 → 重庆',
    flight: '06:35 重庆 → 深圳'
  };
  return `<details class="day-card" id="day-${esc(day.id)}"><summary><span class="day-date"><strong>${esc(day.shortDate)}</strong><span>${esc(day.weekday)}</span></span><span class="day-overview"><span class="day-title"><span class="day-number">${index + 1}</span>${esc(day.label)}</span><span class="day-brief">${esc(brief[day.id] || day.subtitle)}</span><span class="day-stay">${esc(day.stay)}</span></span><span class="expand" aria-hidden="true">⌄</span></summary><div class="day-body"><ol class="timeline">${day.events.map((event, eventIndex) => dayEvent(day, event, eventIndex)).join('')}</ol>${day.spotIds.length ? `<div class="route-shortcuts">${day.spotIds.map(id => `<button type="button" data-jump-spot="${esc(id)}">${esc(guide.spots.find(spot => spot.id === id).name)} ↗</button>`).join('')}</div>` : ''}</div></details>`;
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
  const context = eventContext();
  const activeIds = routeAnchors(context).map(point => point.id);
  $$('#schematic .spot-node').forEach(node => {
    const selected = node.dataset.spot === state.spot;
    node.classList.toggle('selected', selected);
    node.classList.toggle('in-time', activeIds.includes(node.dataset.spot));
    node.classList.toggle('dimmed', activeIds.length ? !activeIds.includes(node.dataset.spot) : state.mapDay !== 'all' && node.dataset.day !== state.mapDay);
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
  closeEventRoute();
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
  const time = event.target.closest('[data-event-route]');
  if (time) { openEventRoute(time.dataset.eventRoute); return; }
  if (event.target.closest('[data-close-event]')) { const key = state.eventKey; closeEventRoute(); $(`[data-event-route="${key}"]`)?.focus({ preventScroll: true }); return; }
  const inlinePlace = event.target.closest('[data-inline-place]');
  if (inlinePlace) { selectInlinePlace(inlinePlace.dataset.inlinePlace); return; }
  const leg = event.target.closest('[data-leg-focus]');
  if (leg) { focusLeg(leg.dataset.legFocus); return; }
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
  if (node && ['Enter', ' '].includes(event.key)) { event.preventDefault(); if (node.dataset.inlinePlace) selectInlinePlace(node.dataset.inlinePlace); else selectSpot(node.dataset.spot); }
});
document.addEventListener('change', event => {
  const select = event.target.closest('[data-transport]');
  const context = eventContext();
  const leg = context?.route.legs.find(item => item.id === select?.dataset.transport);
  const index = Number(select?.value);
  if (!leg || !Number.isInteger(index) || !leg.options[index]) return;
  state.routeChoices.set(`${context.route.id}/${leg.id}`, index);
  focusLeg(leg.id);
});
document.addEventListener('toggle', event => {
  if (event.target.matches('.day-card') && !event.target.open && state.eventKey && event.target.contains($(`[data-event-route="${state.eventKey}"]`))) closeEventRoute();
}, true);
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
