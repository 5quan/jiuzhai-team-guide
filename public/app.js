const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const modeNames = { bus: '观光车', walk: '步行', visit: '游览', rest: '午餐休息', mixed: '车＋步行' };
const state = { day: 'day1', period: 'morning', step: 'd1-wuhua', spot: 'wuhuahai', panel: true, view: 'home', layer: 'clouds', starts: new Map() };
const weatherCache = new Map();
let guide;
let weatherRequest = 0;
let toastTimer;
let mapResize;

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3000);
}

async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function external(url, label, classes = 'text-link') {
  return `<a class="${classes}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

function locationInfo(id) {
  return guide.spots.find(spot => spot.id === id) || guide.routing.places.find(place => place.id === id);
}

function locations() {
  return guide.map.referencePoints.map(locationInfo).filter(Boolean);
}

function symbolFor(spot) {
  return spot.kind === 'facility' ? spot.id === 'park-gate' ? '入' : '车' : String(guide.map.referencePoints.filter(id => locationInfo(id).kind !== 'facility').indexOf(spot.id) + 1);
}

function minutes(value) {
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}

function clock(value) {
  const normalized = value % 1440;
  return `${value >= 1440 ? '次日' : ''}${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function schedule(dayId = state.day) {
  const day = guide.days.find(day => day.id === dayId);
  let current = minutes(state.starts.get(dayId) || day.startTime);
  return day.events.filter(event => event.duration).map(event => {
    const start = current;
    current += event.duration;
    return { ...event, start, end: current, period: event.mode === 'rest' ? 'noon' : start < 720 ? 'morning' : start < 840 ? 'noon' : 'afternoon' };
  });
}

function currentStep() {
  return schedule().find(step => step.id === state.step);
}

function routeFor(step) {
  return guide.routing.routes.find(route => route.id === step?.routeId);
}

function render() {
  $('#main').innerHTML = `
    <div data-view="home">
      <section class="journey-heading" id="itinerary">
        <div><p class="travel-date">2026年10月29—31日 · 7人同行</p><h1>九寨两日行记</h1></div>
        <div class="journey-stay"><span>29日、30日晚 · 景区周边镇子</span><span>31日游玩后 · 黄龙九寨站附近</span></div>
        <button class="quiet-button" id="print-button" type="button">打印行程</button>
      </section>
      <section id="route" aria-label="两天休闲游地图与时间行程">
        <div class="day-switch" role="group" aria-label="选择游览日期">
          ${guide.days.filter(day => day.startTime).map((day, index) => `<button type="button" data-day="${esc(day.id)}" aria-pressed="${state.day === day.id}"><span>${esc(day.shortDate)} ${esc(day.weekday)}</span><strong>第${index === 0 ? '一' : '二'}天</strong><span>${esc(day.label)}</span></button>`).join('')}
        </div>
        <div class="landscape" id="landscape">
          <div class="map-viewport" id="schematic" tabindex="0" aria-label="九寨沟全景示意图，可用方向键滑动，加减号缩放"></div>
          <div class="painting-title" aria-hidden="true"><span>九寨沟</span><small>循水慢游</small><i>两日</i></div>
          <aside class="itinerary-inscription" id="inscription" aria-label="当天时间行程">
            <div class="inscription-heading"><div><p id="inscription-date"></p><h2 id="inscription-title"></h2></div><button class="quiet-button" data-toggle-panel type="button" aria-expanded="true" aria-controls="inscription-body">收起</button></div>
            <div id="inscription-body"><div class="entry-setting"><label for="entry-time">预计入园</label><input id="entry-time" type="time" min="${esc(guide.park.open)}" max="${esc(guide.park.lastEntry)}" step="300"><span id="exit-time"></span></div><p class="timing-note">以参考图10:00起算，可改入园时间；下方钟点为预计。</p><p class="timing-warning" id="timing-warning" hidden></p><div class="period-switch" role="group" aria-label="选择当天时段"><button type="button" data-period="morning">上午</button><button type="button" data-period="noon">午间</button><button type="button" data-period="afternoon">下午</button><button type="button" data-period="all">全天</button></div><ol class="schedule-list" id="schedule-list" aria-label="按时间顺序排列的行程"></ol><p class="reference-note">顺序、交通和分钟数依据两天休闲版；含40分钟午餐。</p></div>
          </aside>
          <details class="map-search" id="map-search"><summary>找景点 <span aria-hidden="true">⌕</span></summary><div><label for="spot-search">景点、栈道或换乘点</label><input id="spot-search" type="search" placeholder="例如：五花海" autocomplete="off"><div id="spot-results" aria-live="polite"></div></div></details>
          <article class="map-caption" id="map-caption" aria-live="polite"></article>
          <div class="map-controls" role="group" aria-label="地图控制"><button type="button" data-zoom="in" aria-label="放大地图">＋</button><button type="button" data-zoom="out" aria-label="缩小地图">−</button><button type="button" id="map-extent">全图</button><button type="button" id="map-follow">本段</button><output id="map-scale" aria-label="地图缩放比例">1×</output></div>
          <div class="map-legend" aria-label="地图图例"><span><i></i>第一天</span><span><i></i>第二天</span><span><i></i>海子</span><small>可缩放、滑动</small></div>
        </div>
        <p class="map-footnote">三沟与蓝色湖泊为关系示意。开放栈道、车辆停靠与末班车以当天安排为准。${external(guide.map.officialPage, '官方导览')}</p>
      </section>
      <details class="journey-log"><summary><strong>抵达、住宿与晚间接送</strong><span>29日晚到达 · 31日晚搬到车站附近</span></summary><div class="travel-days">${guide.days.map(day => `<section><h3>${esc(day.shortDate)} ${esc(day.label)}</h3><p class="stay-note">${esc(day.stay)}</p>${day.events.filter(event => !event.duration).map(event => `<p><strong>${esc(event.time)} · ${esc(event.title)}</strong><span>${esc(event.detail)}</span></p>`).join('')}</section>`).join('')}</div><p class="return-note">${esc(guide.trip.returnNote)}</p></details>
      <section class="print-itinerary" id="print-itinerary" aria-label="打印用完整行程"></section>
    </div>
    <section class="secondary-view" data-view="weather" id="weather" hidden><div class="page-heading"><div><p>10月30日、31日游览参考</p><h1 id="weather-title" tabindex="-1">山间天气</h1></div>${external(guide.weather.fullUrl, '完整预报')}</div><p class="page-note">在预报图中选择日期，重点看云量、低云与降水。目标日期未进入预报时效时，请临近出行再查看。</p><div class="weather-toolbar"><div class="period-switch" role="group" aria-label="天气图层">${[['clouds','云量'],['rain','降水'],['temp','温度'],['wind','风']].map(([layer,label]) => `<button type="button" data-layer="${layer}" aria-pressed="${state.layer === layer}">${label}</button>`).join('')}</div><button class="quiet-button" id="reload-weather" type="button">重新加载</button></div><div id="weather-mount" class="weather-mount"></div><p class="map-footnote">实时天气由Windy提供。${external(guide.sources.find(source => source.id === 'china-weather').url, '中国天气网')}</p></section>
    <section class="secondary-view" data-view="notes" id="notes" hidden></section>`;
  weatherCache.set('clouds', guide.weather);
  renderMap();
  renderSchedule();
  renderCaption();
  renderSearch();
  $('#print-button').addEventListener('click', () => window.print());
  $('#entry-time').addEventListener('change', event => {
    if (!event.target.validity.valid || !event.target.value) { event.target.value = state.starts.get(state.day) || guide.days.find(day => day.id === state.day).startTime; notify('请选择当日参考入园时段内的时间。'); return; }
    state.starts.set(state.day, event.target.value);
    state.period = schedule().find(step => step.id === state.step)?.period || 'all';
    renderSchedule();
    renderCaption();
  });
  $('#spot-search').addEventListener('input', renderSearch);
  $('#map-extent').addEventListener('click', () => { setMapZoom(1); $('#schematic').scrollTo(0, 0); });
  $('#map-follow').addEventListener('click', () => focusStep());
  $('#reload-weather').addEventListener('click', () => switchWeather(state.layer, true));
  navigate(location.hash.slice(1) || 'itinerary', false);
}

function renderSchedule() {
  const day = guide.days.find(day => day.id === state.day);
  const steps = schedule();
  const filtered = state.period === 'all' ? steps : steps.filter(step => step.period === state.period);
  $('#inscription-date').textContent = `${day.shortDate} ${day.weekday}`;
  $('#inscription-title').textContent = state.day === 'day1' ? '五花海与群海' : '长海与上游';
  $('#entry-time').value = state.starts.get(state.day) || day.startTime;
  $('#exit-time').textContent = `约${clock(steps.at(-1).end)}出沟`;
  $('#timing-warning').hidden = steps.at(-1).end <= minutes(guide.park.close);
  $('#timing-warning').textContent = `预计出沟晚于参考闭园时间${guide.park.close}，请提前入园，并以当天安排为准。`;
  $$('.day-switch [data-day]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.day === state.day)));
  $$('[data-period]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.period === state.period)));
  $('#schedule-list').innerHTML = filtered.length ? filtered.map(step => `<li class="schedule-row${step.id === state.step ? ' selected' : ''}" data-step-row="${esc(step.id)}"><button type="button" class="schedule-step" data-step="${esc(step.id)}" aria-pressed="${step.id === state.step}"><time>${clock(step.start)}<small>— ${clock(step.end)}</small></time><span><strong>${esc(step.title)}</strong><span class="step-mode mode-${step.mode}">${modeNames[step.mode]} ${step.duration}分钟</span></span></button>${step.id === state.step ? `<div class="step-detail"><p>${esc(step.detail)}</p><div class="step-places" role="group" aria-label="本段地点">${step.spotIds.map(id => `<button type="button" data-spot="${esc(id)}" aria-pressed="${state.spot === id}">${esc(locationInfo(id).name)}</button>`).join('')}</div></div>` : ''}</li>`).join('') : '<li class="empty">该时段没有安排，可查看全天行程。</li>';
  $('#inscription').classList.toggle('is-collapsed', !state.panel);
  $('#inscription-body').hidden = !state.panel;
  $('[data-toggle-panel]').textContent = state.panel ? '收起' : '展开';
  $('[data-toggle-panel]').setAttribute('aria-expanded', String(state.panel));
}

function chooseDay(id) {
  if (!guide.days.some(day => day.id === id && day.startTime)) return;
  state.day = id;
  state.period = 'morning';
  state.step = schedule().find(step => step.mode === 'visit')?.id || schedule()[0].id;
  state.spot = currentStep().spotIds[0];
  state.panel = true;
  renderSchedule();
  $('#schedule-list').scrollTop = 0;
  updateMap();
  renderCaption();
  setMapZoom(1);
  $('#schematic').scrollTo(0, 0);
  if (window.innerWidth <= 700) focusStep();
}

function chooseStep(id, fit = true) {
  const step = schedule().find(step => step.id === id);
  if (!step) return;
  const restoreFocus = document.activeElement?.dataset.step === id;
  state.step = id;
  state.spot = step.spotIds[0];
  if (state.period !== 'all') state.period = step.period;
  const scroll = $('#schedule-list').scrollTop;
  renderSchedule();
  $('#schedule-list').scrollTop = scroll;
  const selectedRow = $(`[data-step-row="${id}"]`);
  if (selectedRow) $('#schedule-list').scrollTop += selectedRow.getBoundingClientRect().top - $('#schedule-list').getBoundingClientRect().top;
  updateMap();
  renderCaption();
  if (fit) focusStep();
  if (restoreFocus) $(`[data-step="${id}"]`).focus({ preventScroll: true });
}

function chooseSpot(id) {
  const spot = locationInfo(id);
  if (!spot?.position) return;
  const restoreMapFocus = document.activeElement?.classList.contains('spot-node');
  let steps = schedule();
  if (!steps.some(step => step.spotIds.includes(id))) {
    const otherDay = guide.days.find(day => day.startTime && day.events.some(event => event.duration && event.spotIds.includes(id)));
    if (otherDay) { state.day = otherDay.id; steps = schedule(); }
  }
  const step = currentStep()?.spotIds.includes(id) ? currentStep() : steps.find(step => step.mode === 'visit' && step.spotIds.includes(id)) || steps.find(step => step.spotIds.includes(id));
  if (step) { state.step = step.id; state.period = step.period; }
  else state.step = null;
  state.spot = id;
  state.panel = true;
  const scroll = $('#schedule-list').scrollTop;
  renderSchedule();
  $('#schedule-list').scrollTop = scroll;
  updateMap();
  renderCaption();
  $('#map-search').open = false;
  focusPoints([spot.position], true);
  const row = $(`[data-step-row="${state.step}"]`);
  if (row && step) $('#schedule-list').scrollTop += row.getBoundingClientRect().top - $('#schedule-list').getBoundingClientRect().top - 8;
  if (restoreMapFocus) $(`#schematic [data-spot="${esc(id)}"]`).focus({ preventScroll: true });
}

function renderCaption() {
  const spot = locationInfo(state.spot);
  const step = currentStep();
  $('#map-caption').innerHTML = `<p>${step ? `${clock(step.start)}—${clock(step.end)} · ${modeNames[step.mode]}${step.duration}分钟` : '沿线景点'}</p><h3><span>${symbolFor(spot)}</span>${esc(spot.name)}</h3><p>${esc(spot.travel || spot.note)}</p>`;
}

function renderSearch() {
  const query = $('#spot-search').value.trim();
  const points = locations().filter(spot => `${spot.name}${spot.valley || ''}`.includes(query));
  $('#spot-results').innerHTML = points.length ? points.map(spot => `<button type="button" data-spot="${esc(spot.id)}"><span>${symbolFor(spot)}</span>${esc(spot.name)}</button>`).join('') : '<p class="empty">没有匹配地点，试试“长海”或“树正”。</p>';
}

function renderMap() {
  const { width, height } = guide.map.canvas;
  const mainNames = new Set(['changhai','wucaichi','forest','jianzhuhai','panda','wuhuahai','peacock','pearl','mirror','nuorilang','rhino','tiger','shuzheng','shuzheng-village','spark','double-falls','double-lake','reed','park-gate','nuorilang-center']);
  const mountains = '<g class="mountain-wash" aria-hidden="true"><path d="M0 400 Q90 270 180 340 L280 180 Q340 280 415 260 L515 100 Q600 280 700 350 L740 520 L0 580Z"/><path d="M60 450 L240 305 L340 400 L415 340 L570 510 L660 580 L60 650Z"/><path d="M750 185 L860 82 L940 140 L1040 40 L1180 140 L1240 65 L1430 240 L1600 300 L1600 440 L750 400Z"/><path d="M950 820 L1055 690 L1140 755 L1260 610 L1380 740 L1455 665 L1600 840 L1600 1050 L950 1030Z"/><path class="mountain-ridge" d="M78 410 L277 181 L340 290 L415 262 M808 183 L860 85 L940 144 L1040 44 L1120 145 M1048 824 L1260 614 L1340 741"/></g>';
  const waters = guide.map.water.map(water => `<path class="lake-shape${water.seasonal ? ' seasonal-lake' : ''}" data-water="${esc(water.id)}" d="${esc(water.d)}"><title>${esc(locationInfo(water.id).name)}水面示意</title></path>`).join('');
  const roads = guide.map.paths.map(path => `<path class="road-underlay" d="${esc(path.d)}"/><path class="route-line" d="${esc(path.d)}"/>`).join('');
  const nodes = locations().map(spot => {
    const [x, y] = spot.position;
    const left = spot.labelSide === 'left';
    const shape = spot.kind === 'facility' ? `<rect class="route-dot" x="${x - 12}" y="${y - 12}" width="24" height="24" rx="3"/>` : `<circle class="route-dot" cx="${x}" cy="${y}" r="13"/>`;
    return `<g class="spot-node${mainNames.has(spot.id) ? '' : ' node-detail'}${spot.kind === 'facility' ? ' node-facility' : ''}" data-spot="${esc(spot.id)}" data-day="${spot.day}" role="button" tabindex="0" aria-label="${symbolFor(spot)} ${esc(spot.name)}" aria-pressed="false"><circle class="hit-target" cx="${x}" cy="${y}" r="22"/>${shape}<text class="route-number" x="${x}" y="${y}">${symbolFor(spot)}</text><text class="spot-label" x="${x + (left ? -24 : 24)}" y="${y + 7}" text-anchor="${left ? 'end' : 'start'}">${esc(spot.mapLabel || spot.name)}</text></g>`;
  }).join('');
  $('#schematic').innerHTML = `<svg class="route-svg" viewBox="0 0 ${width} ${height}" role="group" aria-label="九寨沟三沟与湖泊全景示意图"><defs><linearGradient id="mountain-tone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ccdbd5" stop-opacity=".62"/><stop offset="1" stop-color="#edf3f0" stop-opacity=".05"/></linearGradient></defs>${mountains}<g class="map-geography" aria-hidden="true"><text x="580" y="370" transform="rotate(73 580 370)">则查洼沟</text><text x="1375" y="365" transform="rotate(-66 1375 365)">日则沟</text><text x="1050" y="850" transform="rotate(10 1050 850)">树正沟</text><text class="north-mark" x="1490" y="72">↑ 北</text></g><g class="map-water">${waters}</g><g aria-hidden="true">${roads}<path id="active-route" class="active-route"/></g>${nodes}</svg>`;
  bindMapGestures();
  updateMap();
  requestAnimationFrame(() => { if (window.innerWidth <= 700) focusStep(); });
}

function updateMap() {
  const dayIds = new Set(schedule().flatMap(step => step.spotIds));
  const step = currentStep();
  const active = new Set(step?.spotIds || []);
  $$('#schematic .spot-node').forEach(node => {
    const id = node.dataset.spot;
    node.classList.toggle('is-today', dayIds.has(id));
    node.classList.toggle('is-active', active.has(id));
    node.classList.toggle('selected', id === state.spot);
    node.setAttribute('aria-pressed', String(id === state.spot));
  });
  $$('#schematic [data-water]').forEach(node => node.classList.toggle('active-water', node.dataset.water === state.spot));
  const route = routeFor(step);
  const ids = route?.legs.length ? route.legs.flatMap(leg => [leg.from, ...(leg.options[leg.recommended].via || []), leg.to]) : [];
  const points = ids.map(locationInfo).filter(spot => spot?.position).map(spot => spot.position);
  $('#active-route').setAttribute('d', points.length > 1 ? points.map(([x,y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ') : '');
  const selected = $(`#schematic .spot-node[data-spot="${state.spot}"]`);
  if (selected) selected.parentElement.append(selected);
}

function setMapZoom(value, anchor) {
  const container = $('#schematic');
  const svg = $('svg', container);
  if (!svg || !container.clientWidth || !container.clientHeight) return;
  const zoom = Math.max(1, Math.min(5, value));
  const frame = container.getBoundingClientRect();
  const old = svg.getBoundingClientRect();
  const point = anchor || { x: frame.left + container.clientWidth / 2, y: frame.top + container.clientHeight / 2 };
  const rx = old.width ? (point.x - old.left) / old.width : .5;
  const ry = old.height ? (point.y - old.top) / old.height : .5;
  const box = svg.viewBox.baseVal;
  const baseWidth = Math.min(container.clientWidth, container.clientHeight * box.width / box.height);
  svg.style.width = `${baseWidth * zoom}px`;
  svg.style.transform = 'none';
  container.dataset.zoom = zoom;
  const next = svg.getBoundingClientRect();
  container.scrollLeft += next.left + rx * next.width - point.x;
  container.scrollTop += next.top + ry * next.height - point.y;
  $('#map-scale').textContent = `${Number(zoom.toFixed(1))}×`;
  $('[data-zoom="out"]').disabled = zoom === 1;
  $('[data-zoom="in"]').disabled = zoom === 5;
}

function focusPoints(points, single = false) {
  const container = $('#schematic');
  const { width, height } = guide.map.canvas;
  const mobile = window.innerWidth <= 700;
  const frame = container.getBoundingClientRect();
  const panel = $('#inscription').getBoundingClientRect();
  const left = !mobile && state.panel ? Math.max(0, panel.right - frame.left + 35) : 20;
  const availableWidth = container.clientWidth - left - 30;
  const availableHeight = mobile && state.panel ? Math.max(180, panel.top - frame.top - 45) : container.clientHeight - 100;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const baseWidth = Math.min(container.clientWidth, container.clientHeight * width / height);
  const scale = Math.min(availableWidth / Math.max(single ? 280 : 350, Math.max(...xs) - Math.min(...xs) + 200), availableHeight / Math.max(single ? 210 : 280, Math.max(...ys) - Math.min(...ys) + 170));
  setMapZoom(Math.max(mobile && single ? 2.1 : 1, Math.min(4, scale * width / baseWidth)));
  const element = $('svg', container);
  const svg = element.getBoundingClientRect();
  const targetX = frame.left + left + availableWidth / 2;
  const targetY = frame.top + (mobile ? availableHeight / 2 + 20 : container.clientHeight / 2);
  container.scrollLeft += svg.left + cx / width * svg.width - targetX;
  container.scrollTop += svg.top + cy / height * svg.height - targetY;
  const next = element.getBoundingClientRect();
  element.style.transform = `translate(${targetX - next.left - cx / width * next.width}px, ${targetY - next.top - cy / height * next.height}px)`;
}

function focusStep() {
  const points = currentStep()?.spotIds.map(locationInfo).filter(spot => spot.position).map(spot => spot.position);
  if (points?.length) focusPoints(points);
}

function bindMapGestures() {
  const container = $('#schematic');
  const pointers = new Map();
  let moved = false;
  let origin;
  const span = () => {
    const [a,b] = [...pointers.values()];
    return b && { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  container.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (!pointers.size) { moved = false; origin = { x: event.clientX, y: event.clientY }; }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  container.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const before = span();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 6 || pointers.size > 1) moved = true;
    if (moved && !container.hasPointerCapture(event.pointerId)) container.setPointerCapture(event.pointerId);
    if (pointers.size > 1) {
      const after = span();
      if (before?.distance && after.distance) setMapZoom(Number(container.dataset.zoom || 1) * after.distance / before.distance, after);
      if (before) { container.scrollLeft += before.x - after.x; container.scrollTop += before.y - after.y; }
    } else { container.scrollLeft += previous.x - event.clientX; container.scrollTop += previous.y - event.clientY; }
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) container.addEventListener(type, event => {
    if (type !== 'lostpointercapture' || event.target === container) pointers.delete(event.pointerId);
  });
  container.addEventListener('click', event => { if (moved) { event.preventDefault(); event.stopPropagation(); moved = false; } }, true);
  container.addEventListener('keydown', event => {
    if (event.target !== container || !['+','=','-'].includes(event.key)) return;
    event.preventDefault();
    setMapZoom(Number(container.dataset.zoom || 1) * (event.key === '-' ? 1 / 1.4 : 1.4));
  });
  mapResize?.disconnect();
  mapResize = new ResizeObserver(() => setMapZoom(Number(container.dataset.zoom || 1)));
  mapResize.observe(container);
  setMapZoom(1);
}

function renderNotes() {
  const costs = guide.costs;
  $('#notes').innerHTML = `<div class="page-heading"><div><p>住宿、交通与票务</p><h1 id="notes-title" tabindex="-1">出行须知</h1></div><span class="checked">核对 ${esc(guide.checkedAt)}</span></div><section class="note-section"><h2>待落实</h2><ul class="pending-list">${guide.pending.map(item => `<li><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></li>`).join('')}</ul></section><section class="note-section"><h2>两天游览与当天开放</h2><p>${esc(guide.park.note)}</p><p>${esc(guide.schedule.note)} 按10:00入园累计，第一天约16:22出沟，第二天约17:17出沟；实际可能因车流、观景和开放情况变化。</p></section><section class="note-section"><h2>两天门票与观光车</h2><p>每天每位成人：门票¥${guide.ticket.entrance}＋观光车¥${guide.ticket.bus}。两天每人¥${costs.perPersonTwoDays}，7人共¥${costs.teamTwoDays}。</p><p>${esc(guide.ticket.note)} ${esc(guide.ticket.validity)}</p>${external(guide.sources.find(source => source.id === 'tickets').url, '官方票务')}</section><section class="note-section"><h2>三晚住宿</h2><p>10月29、30日：${esc(guide.trip.hotel.name)}。${esc(guide.trip.hotel.note)}</p><p>前两晚预算每人每晚¥${guide.trip.hotelBudgetPerPersonNight}，全队两晚¥${costs.hotelTeamTwoNights}。</p><p>10月31日：${esc(guide.trip.stationHotel.name)}。${esc(guide.trip.stationHotel.note)} 第三晚及道路接送费用另行确认。</p></section><section class="note-section"><h2>道路接送与返程</h2>${guide.transport.map(item => `<div class="transport-item"><h3>${esc(item.title)}<small>${esc(item.badge)}</small></h3><p>${esc(item.text)}</p></div>`).join('')}<p>${esc(guide.trip.returnNote)}</p></section><details class="sources note-section"><summary>资料来源与地图说明</summary><p>${esc(guide.map.note)}</p>${guide.sources.map(source => `<div class="source-item">${external(source.url, source.title)}<p>${esc(source.note)}</p></div>`).join('')}</details>`;
}

function navigate(target, focus = true) {
  if (!['itinerary','route','weather','notes'].includes(target)) target = 'itinerary';
  state.view = ['weather','notes'].includes(target) ? target : 'home';
  if (target === 'notes') renderNotes();
  $$('[data-view]').forEach(view => { view.hidden = view.dataset.view !== state.view; });
  $$('.bottom-nav [data-nav]').forEach(link => {
    if (link.dataset.nav === target) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  });
  if (state.view !== 'weather') { weatherRequest++; $('#weather-mount').replaceChildren(); }
  else if (!$('#windy-frame')) switchWeather(state.layer);
  if (target === 'itinerary') { state.panel = true; renderSchedule(); window.scrollTo(0,0); }
  else if (target === 'route') $('#route').scrollIntoView({ block:'start' });
  else { window.scrollTo(0,0); if (focus) $(`#${target}-title`).focus({ preventScroll:true }); }
}

async function switchWeather(layer, force = false) {
  const request = ++weatherRequest;
  state.layer = layer;
  $$('[data-layer]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layer === layer)));
  $('#weather-mount').setAttribute('aria-busy','true');
  let status = $('#weather-status');
  if (!status) { status = document.createElement('p'); status.id = 'weather-status'; status.className = 'weather-status'; status.setAttribute('role','status'); $('#weather-mount').prepend(status); }
  status.hidden = false;
  status.textContent = '正在加载Windy，较慢时可打开完整预报。';
  try {
    const weather = weatherCache.get(layer) || await getJSON(`/api/weather?layer=${encodeURIComponent(layer)}`);
    if (request !== weatherRequest || state.view !== 'weather') return;
    weatherCache.set(layer, weather);
    let frame = $('#windy-frame');
    if (!frame) { frame = document.createElement('iframe'); frame.id = 'windy-frame'; frame.className = 'weather-frame'; frame.title = 'Windy九寨沟实时天气地图'; frame.referrerPolicy = 'strict-origin-when-cross-origin'; frame.allowFullscreen = true; frame.addEventListener('load', () => { status.hidden = true; }); $('#weather-mount').append(frame); }
    if (force || frame.getAttribute('src') !== weather.embedUrl) frame.src = weather.embedUrl;
  } catch { if (request === weatherRequest && state.view === 'weather') status.textContent = '天气暂时无法加载，请重新加载或打开完整预报。'; }
  finally { if (request === weatherRequest) $('#weather-mount').removeAttribute('aria-busy'); }
}

function renderPrint() {
  $('#print-itinerary').innerHTML = guide.days.map(day => `<section><h2>${esc(day.shortDate)} ${esc(day.weekday)} ${esc(day.label)}</h2><p>${esc(day.stay)}</p><ol>${day.events.map(event => {
    const timed = day.startTime && event.duration ? schedule(day.id).find(step => step.id === event.id) : null;
    return `<li><time>${timed ? `${clock(timed.start)}—${clock(timed.end)}` : esc(event.time)}</time><strong>${esc(event.title)}</strong>${event.duration ? `<span>${modeNames[event.mode]} ${event.duration}分钟</span>` : ''}<p>${esc(event.detail)}</p></li>`;
  }).join('')}</ol></section>`).join('');
}

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-nav]');
  if (nav && guide) { event.preventDefault(); const target = nav.dataset.nav; if (location.hash !== `#${target}`) history.pushState(null,'',`#${target}`); navigate(target); return; }
  const day = event.target.closest('.day-switch [data-day]');
  if (day) { chooseDay(day.dataset.day); return; }
  const period = event.target.closest('[data-period]');
  if (period) { state.period = period.dataset.period; const next = schedule().find(step => state.period === 'all' || step.period === state.period); if (next && !schedule().some(step => step.id === state.step && (state.period === 'all' || step.period === state.period))) { state.step = next.id; state.spot = next.spotIds[0]; } renderSchedule(); $('#schedule-list').scrollTop = 0; updateMap(); renderCaption(); return; }
  const step = event.target.closest('[data-step]');
  if (step) { chooseStep(step.dataset.step); return; }
  const spot = event.target.closest('[data-spot]');
  if (spot) { chooseSpot(spot.dataset.spot); return; }
  const zoom = event.target.closest('[data-zoom]');
  if (zoom) { setMapZoom(Number($('#schematic').dataset.zoom || 1) * (zoom.dataset.zoom === 'in' ? 1.4 : 1 / 1.4)); return; }
  if (event.target.closest('[data-toggle-panel]')) { state.panel = !state.panel; renderSchedule(); return; }
  const layer = event.target.closest('[data-layer]');
  if (layer && layer.dataset.layer !== state.layer) switchWeather(layer.dataset.layer);
});
document.addEventListener('keydown', event => {
  const node = event.target.closest('.spot-node');
  if (node && ['Enter',' '].includes(event.key)) { event.preventDefault(); chooseSpot(node.dataset.spot); }
});
window.addEventListener('popstate', () => { if (guide) navigate(location.hash.slice(1) || 'itinerary', false); });
window.addEventListener('hashchange', () => { if (guide) navigate(location.hash.slice(1) || 'itinerary', false); });
window.addEventListener('beforeprint', () => { if (guide) renderPrint(); });
$('#share-button').addEventListener('click', async () => { try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(location.href.split('#')[0]); notify('攻略链接已复制'); } catch { notify('请复制地址栏链接分享'); } });
async function boot() {
  try { guide = await getJSON('/api/guide'); render(); }
  catch { $('#main').innerHTML = '<div class="error-box"><h1>行程暂时无法加载</h1><p>请检查连接，再重新加载。</p><button class="quiet-button" id="retry" type="button">重新加载</button></div>'; $('#retry').addEventListener('click', boot, {once:true}); }
}
boot();
