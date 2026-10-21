const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const modeNames = { bus: '观光车', walk: '步行', visit: '游览', rest: '午餐休息', mixed: '车＋步行' };
const state = { plan: 'two-days', day: 'day1', period: 'morning', step: 'd1-forest', spot: 'forest', compact: true, expandedStep: null, guidedSpot: null, view: 'home', layer: 'clouds', starts: new Map(), nowStep: null };
const planViews = new Map();
const weatherCache = new Map();
const phone = window.matchMedia('(max-width: 700px)');
const isMobile = () => phone.matches;
let guide;
let weatherRequest = 0;
let toastTimer;
let mapResize;
let rippleTimer;
let mapMoving = false;
let mapGeometry;
const mapLimits = { min: 1, max: 2 };
const mapOffset = { x: 0, y: 0 };
const mobileFocusZoom = 1.6;

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

function allDays() {
  return [...guide.days, ...(guide.referenceDays || [])];
}

function plans() {
  return guide.plans || [{ id: 'two-days', label: '两天慢游', dayIds: guide.days.filter(day => day.startTime).map(day => day.id) }];
}

function planDays() {
  const plan = plans().find(plan => plan.id === state.plan);
  return plan.dayIds.map(id => allDays().find(day => day.id === id));
}

function printDays() {
  return state.plan === 'two-days' ? guide.days : planDays();
}

function dayLabel(day) {
  return day.date ? `${day.shortDate} ${day.weekday}` : day.label;
}

function daysForSpot(spot) {
  const days = planDays().filter(day => day.spotIds.includes(spot.id) || day.events.some(event => event.duration && event.spotIds.includes(spot.id)));
  return days.length || state.plan !== 'two-days' ? days : planDays().filter(day => day.id === `day${spot.day}`);
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
  const day = allDays().find(day => day.id === dayId);
  let current = minutes(state.starts.get(dayId) || day.startTime);
  const steps = day.events.filter(event => event.duration);
  const lunch = steps.findIndex(event => event.mode === 'rest');
  return steps.map((event, index) => {
    const start = current;
    current += event.duration;
    return { ...event, start, end: current, period: index <= lunch || start < 840 ? 'morning' : 'afternoon' };
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
        <div class="journey-title"><h1>九寨两日行记</h1><p class="travel-date">10.29—31 · 7人</p></div>
        <div class="journey-actions"><a class="quiet-button" href="/chat">AI 助手</a><details class="time-settings"><summary>设置</summary><div id="inscription-settings"><fieldset class="plan-setting"><legend>行程计划</legend>${plans().map(plan => `<label><input type="radio" name="plan" value="${esc(plan.id)}"${state.plan === plan.id ? ' checked' : ''}>${esc(plan.label)}</label>`).join('')}</fieldset><div class="entry-setting"><label for="entry-time">入园</label><input id="entry-time" type="time" min="${esc(guide.park.open)}" max="${esc(guide.park.lastEntry)}" step="300"><span id="exit-time"></span></div><p class="timing-warning" id="timing-warning" hidden></p></div></details><button class="quiet-button" id="share-button" type="button" aria-label="复制攻略链接">分享</button><button class="quiet-button" id="print-button" type="button">打印</button></div>
      </section>
      <section id="route" aria-label="两天休闲游地图与时间行程">
        <div class="day-switch" role="group" aria-label="选择游览日期">
        </div>
        <div class="landscape" id="landscape">
          <div class="mobile-artwork" aria-hidden="true"><img src="/paper-landscape-v1.webp" alt="" decoding="async"></div>
          <div class="map-viewport" id="schematic" tabindex="0" aria-label="九寨沟全景示意图，单指拖动，双指缩放，点按景点查看行程"></div>
          <div class="painting-title" aria-hidden="true"><span>九寨沟</span><small>循水慢游</small><i>两日</i></div>
          <aside class="itinerary-inscription" id="inscription" aria-label="当天时间行程">
            <div class="inscription-heading"><p id="inscription-date"></p><button class="quiet-button panel-toggle" data-toggle-panel type="button" aria-expanded="true" aria-controls="inscription-settings">简览</button></div>
            <div id="inscription-body"><div class="period-switch" role="group" aria-label="选择当天时段"><button type="button" data-period="morning">上午</button><button type="button" data-period="afternoon">下午</button></div><ol class="schedule-list" id="schedule-list" aria-label="按时间顺序排列的行程"></ol></div>
          </aside>
          <details class="map-search" id="map-search"><summary aria-label="找景点"><span class="search-label">找景点</span><span class="search-icon" aria-hidden="true">⌕</span></summary><div><label for="spot-search">景点、栈道或换乘点</label><input id="spot-search" type="search" placeholder="例如：五花海" autocomplete="off"><div id="spot-results" aria-live="polite"></div></div></details>
          <article class="map-caption" id="map-caption" aria-live="polite"></article>
          <section class="map-detail" id="map-detail" aria-label="所选行程详情" hidden></section>
          <div class="map-controls" role="group" aria-label="地图控制"><button type="button" data-zoom="in" aria-label="放大地图">＋</button><button type="button" data-zoom="out" aria-label="缩小地图">−</button><button type="button" id="map-follow">本段</button><output id="map-scale" aria-label="地图缩放比例">1×</output></div>
          <div class="map-legend" aria-label="地图图例"><span><i></i>当天行程</span><span><i></i>另一天</span><span><i></i>海子</span><small>可缩放、滑动</small></div>
        </div>
        <p class="map-footnote">三沟与蓝色湖泊为关系示意。开放栈道、车辆停靠与末班车以当天安排为准。${external(guide.map.officialPage, '官方导览')}</p>
      </section>
      <details class="journey-log"><summary><strong>抵达、住宿与晚间接送</strong><span>29日晚到达 · 31日晚搬到车站附近</span></summary><div class="travel-days">${guide.days.map(day => `<section><h3>${esc(day.shortDate)} ${esc(day.label)}</h3><p class="stay-note">${esc(day.stay)}</p>${day.events.filter(event => !event.duration).map(event => `<p><strong>${esc(event.time)} · ${esc(event.title)}</strong><span>${esc(event.detail)}</span></p>`).join('')}</section>`).join('')}</div><p class="return-note">${esc(guide.trip.returnNote)}</p></details>
      <section class="print-itinerary" id="print-itinerary" aria-label="打印用完整行程"></section>
    </div>
      <section class="secondary-view" data-view="weather" id="weather" hidden><div class="page-heading"><div><p id="weather-date">10月30日、31日游览参考</p><h1 id="weather-title" tabindex="-1">山间天气</h1></div>${external(guide.weather.fullUrl, '完整预报')}</div><p class="page-note">在预报图中选择日期，重点看云量、低云与降水。目标日期未进入预报时效时，请临近出行再查看。</p><div class="weather-toolbar"><div class="period-switch" role="group" aria-label="天气图层">${[['clouds','云量'],['rain','降水'],['temp','温度'],['wind','风']].map(([layer,label]) => `<button type="button" data-layer="${layer}" aria-pressed="${state.layer === layer}">${label}</button>`).join('')}</div><button class="quiet-button" id="reload-weather" type="button">重新加载</button></div><div id="weather-mount" class="weather-mount"></div><p class="map-footnote">实时天气由Windy提供。${external(guide.sources.find(source => source.id === 'china-weather').url, '中国天气网')}</p></section>
    <section class="secondary-view" data-view="notes" id="notes" hidden></section>`;
  weatherCache.set('clouds', guide.weather);
  renderPlan();
  renderMap();
  renderSchedule();
  renderCaption();
  renderSearch();
  $('#print-button').addEventListener('click', () => window.print());
  $('#share-button').addEventListener('click', shareGuide);
  $('#entry-time').addEventListener('change', event => {
    if (!event.target.validity.valid || !event.target.value) { event.target.value = state.starts.get(state.day) || allDays().find(day => day.id === state.day).startTime; notify('请选择当日参考入园时段内的时间。'); return; }
    state.starts.set(state.day, event.target.value);
    state.period = schedule().find(step => step.id === state.step)?.period || 'morning';
    renderSchedule();
    renderCaption();
  });
  $$('input[name="plan"]').forEach(input => input.addEventListener('change', () => choosePlan(input.value)));
  $('#spot-search').addEventListener('input', renderSearch);
  $('#map-follow').addEventListener('click', () => { compactItinerary(); focusStep(); rippleSpot(); });
  $('#reload-weather').addEventListener('click', () => switchWeather(state.layer, true));
  navigate(location.hash.slice(1) || 'itinerary', false);
}

function renderPlan() {
  const single = state.plan === 'one-day';
  $('.journey-heading h1').textContent = single ? '九寨一天精华游' : '九寨两日行记';
  $('.travel-date').textContent = single ? '约8小时' : '10.29—31 · 7人';
  document.title = `${single ? '九寨一天精华游' : '九寨两日行记'} · 地图与时间行程`;
  $('#route').setAttribute('aria-label', `${single ? '一天精华游' : '两天慢游'}地图与时间行程`);
  $('.day-switch').setAttribute('aria-label', single ? '当前行程计划' : '选择游览日期');
  $('.day-switch').innerHTML = single ? '<p class="plan-overview"><strong>一天精华游</strong><span>长海 · 五花海 · 树正群海</span></p>' : planDays().map((day, index) => `<button type="button" data-day="${esc(day.id)}" aria-pressed="${state.day === day.id}" aria-label="${esc(dayLabel(day))} ${esc(day.label)}"><strong>第${index === 0 ? '一' : '二'}天</strong><span>${esc(day.shortDate)}</span></button>`).join('');
  $('.painting-title i').textContent = single ? '一日' : '两日';
  $('.map-legend span:nth-child(2)').lastChild.textContent = single ? '计划外' : '另一天';
  $('.journey-log').hidden = single;
  $('#weather-date').textContent = single ? '按实际出行日期查看预报' : '10月30日、31日游览参考';
  let note = $('#plan-note');
  if (!note) { note = document.createElement('p'); note.id = 'plan-note'; note.className = 'map-footnote plan-note'; $('#route').append(note); }
  note.hidden = !single;
  note.textContent = single ? planDays()[0].note : '';
  $$('input[name="plan"]').forEach(input => { input.checked = input.value === state.plan; });
}

function choosePlan(id) {
  if (id === state.plan || !plans().some(plan => plan.id === id)) return;
  planViews.set(state.plan, { day: state.day, period: state.period, step: state.step, spot: state.spot });
  state.plan = id;
  const saved = planViews.get(id);
  state.day = saved?.day || planDays()[0].id;
  const first = schedule().find(step => step.mode === 'visit') || schedule()[0];
  Object.assign(state, saved || { period: 'morning', step: first.id, spot: stepSpot(first) }, { compact: true, expandedStep: null, guidedSpot: null, nowStep: null });
  try { localStorage.setItem('jiuzhai-plan', id); } catch { /* Private browsing may disable storage. */ }
  const url = new URL(location.href);
  url.searchParams.set('plan', id);
  history.replaceState(null, '', url.href);
  renderPlan();
  renderSchedule();
  revealStep();
  updateMap();
  renderCaption();
  renderPrint();
  resetDefaultMap();
}

function itineraryName(step) {
  const labels = {
    'd1-entry': '乘车到原始森林', 'd1-wuhua-bus': '乘车到五花海', 'd1-peacock': '徒步孔雀河道',
    'd1-parking': '步行到镜海停车场', 'd1-center': '乘车到诺日朗中心',
    'd1-walk-falls': '步行到诺日朗瀑布', 'd1-nuorilang': '诺日朗瀑布、观景台',
    'd1-falls-stop': '步行到上车点', 'd1-rhino-bus': '乘车到犀牛海',
    'd1-tree-bus': '乘车到树正寨', 'd1-tree': '树正寨、群海',
    'd1-spark-bus': '乘车到火花海', 'd1-double-walk': '步行到双龙海瀑布',
    'd1-exit': '乘车出沟', 'd2-entry': '乘车到长海',
    'd2-pool-walk': '步行到五彩池', 'd2-pool': '五彩池栈道',
    'd2-pool-stop': '步行到五彩池上车点', 'd2-center': '诺日朗中心换乘',
    'd2-arrow-bus': '乘车到箭竹海',
    'd2-panda-bus': '乘车到熊猫海', 'd2-center-return': '诺日朗中心换乘',
    'd2-tree-bus': '乘车到树正寨', 'd2-inner': '内侧栈道到火花海',
    'd2-exit': '乘车出沟'
  };
  return labels[step.id] || step.title;
}

function stepSpot(step) {
  if (step.mode !== 'visit') return step.to || step.spotIds.at(-1);
  return step.spotIds.map(locationInfo).filter(spot => step.title.includes(spot.name)).sort((a, b) => b.name.length - a.name.length)[0]?.id || step.spotIds[0];
}

function timelineSpot(step) {
  return { 'd1-peacock': 'peacock', 'd2-inner': 'shuzheng-inner', 's1-inner': 'shuzheng-inner' }[step.id] || stepSpot(step);
}

function timelinePlace(stop) {
  if (stop.step.mode === 'visit') return itineraryName(stop.step);
  return { 'd1-peacock': '孔雀河道', 'd2-inner': '内侧栈道→火花海', 's1-inner': '内侧栈道→火花海', 'd1-exit': '景区出口', 'd2-exit': '景区出口', 's1-exit': '景区出口' }[stop.step.id] || locationInfo(stop.spotId).mapLabel || locationInfo(stop.spotId).name;
}

function timelineTravel(step) {
  return `${step.estimated ? '预计' : ''}${step.mode === 'bus' ? '大巴' : modeNames[step.mode]}${step.duration}分钟`;
}

function timelineTravelMarkup(step) {
  const bus = '<svg class="travel-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="2" width="12" height="14" rx="2"/><path d="M4 9h12M7 16v2m6-2v2M8 5h4"/><circle cx="7" cy="12" r=".7"/><circle cx="13" cy="12" r=".7"/></svg>';
  const walk = '<svg class="travel-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="11" cy="3" r="1.6"/><path d="m8 7 3-1 2 4 3 1M8 7l-3 4m6-5-1 6-4 6m4-6 4 6"/></svg>';
  return `${step.mode === 'bus' ? bus : step.mode === 'walk' ? walk : step.mode === 'mixed' ? bus + walk : ''}${esc(timelineTravel(step))}`;
}

function renderSpotNotes(id) {
  const spot = locationInfo(id);
  const field = (label, values = []) => `<div${values.length ? '' : ' class="is-empty"'}><dt><span class="timeline-ink">${label}</span></dt><dd${values.length ? '' : ' class="note-empty" aria-label="' + label + '未填写"'}>${values.map(value => `<p><span class="timeline-ink">${esc(value)}</span></p>`).join('')}</dd></div>`;
  return `<dl class="spot-notes" aria-label="${esc(spot.name)}的看点与注意事项">${field('看点', spot.highlights)}${field('注意事项', spot.tips)}</dl>`;
}

function renderTimelineDetail(step, expanded) {
  const spotId = step.spotIds.includes(state.spot) ? state.spot : timelineSpot(step);
  return `<div class="step-detail" id="detail-${esc(step.id)}"${expanded ? '' : ' hidden'}><p class="detail-title">${esc(itineraryName(step))}</p>${step.spotIds.length > 1 ? `<div class="step-places" role="group" aria-label="本段地点">${step.spotIds.map(id => `<button type="button" data-spot="${esc(id)}" aria-pressed="${spotId === id}"><span class="timeline-ink">${esc(locationInfo(id).name)}</span></button>`).join('')}</div>` : ''}${renderSpotNotes(spotId)}</div>`;
}

function renderSchedule() {
  const day = allDays().find(day => day.id === state.day);
  const steps = schedule();
  $('#schedule-list').tabIndex = 0;
  $('#entry-time').value = state.starts.get(state.day) || day.startTime;
  $('#exit-time').textContent = `${clock(steps.at(-1).end)}出沟`;
  $('#timing-warning').hidden = steps.at(-1).end <= minutes(guide.park.close);
  $('#timing-warning').textContent = `预计出沟晚于参考闭园时间${guide.park.close}，请提前入园，并以当天安排为准。`;
  $$('.day-switch [data-day]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.day === state.day)));
  $$('[data-period]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.period === state.period)));
  const visible = steps.filter(step => step.period === state.period);
  $('#schedule-list').innerHTML = visible.length ? timelineStops(visible, timelineSpot).map(stop => {
    const step = stop.step;
    const moving = !['visit', 'rest'].includes(step.mode);
    const expanded = !state.compact && state.expandedStep === step.id;
    const active = stop.steps.some(item => item.id === state.step);
    const incoming = stop.steps.filter(item => item.id !== step.id).map(item => {
      const open = !state.compact && state.expandedStep === item.id;
      return `<div class="schedule-row${item.id === state.step ? ' selected' : ''}" data-step-row="${esc(item.id)}"><button type="button" class="schedule-leg" data-step="${esc(item.id)}" aria-label="${clock(item.start)} ${esc(timelineTravel(item))}至${esc(timelinePlace(stop))}" aria-pressed="${item.id === state.step}" aria-expanded="${open}" aria-controls="detail-${esc(item.id)}"><span class="timeline-ink">${timelineTravelMarkup(item)}${item.id === state.nowStep ? '<span class="step-now">现在</span>' : ''}</span></button>${renderTimelineDetail(item, open)}</div>`;
    }).join('');
    const duration = ['visit', 'rest'].includes(step.mode) ? ` · ${step.duration}分钟` : '';
    const time = moving ? `${clock(step.start)}—${clock(step.end)}` : clock(step.start);
    return `<li class="timeline-stop${active ? ' is-active' : ''}" data-node-id="${esc(step.id)}">${moving ? '' : `<div class="timeline-connection">${incoming}</div>`}<div class="schedule-row${step.id === state.step ? ' selected' : ''}" data-step-row="${esc(step.id)}"><button type="button" class="schedule-step${moving ? ' is-moving' : ''}" data-step="${esc(step.id)}" aria-pressed="${step.id === state.step}" aria-expanded="${expanded}" aria-controls="detail-${esc(step.id)}">${moving ? `<span class="timeline-self-leg"><span class="timeline-ink">${timelineTravelMarkup(step)}</span></span>` : ''}<span class="timeline-node"><span class="step-summary"><strong><span class="timeline-ink">${esc(timelinePlace(stop))}${step.id === state.nowStep ? '<span class="step-now">现在</span>' : ''}</span></strong><span class="step-meta"><span class="timeline-ink"><time>${time}</time>${duration}</span></span></span></span></button>${renderTimelineDetail(step, expanded)}</div></li>`;
  }).join('') : '<li class="empty">该时段没有安排，请切换其他时段。</li>';
  $('#inscription').classList.toggle('is-compact', state.compact);
  $('#inscription').classList.toggle('has-detail', !state.compact && Boolean(state.expandedStep));
  const detail = state.expandedStep && $(`#detail-${state.expandedStep}`);
  const detailPanel = $('#map-detail');
  detailPanel.replaceChildren();
  detailPanel.hidden = !detail || state.compact;
  if (detail && !state.compact) detailPanel.append(detail);
  $('.inscription-heading').hidden = state.compact;

  $('[data-toggle-panel]').setAttribute('aria-expanded', String(!state.compact));
  $('#inscription-date').innerHTML = `<span class="timeline-ink">${esc(dayLabel(day))}</span>`;
  $$('#inscription .period-switch button, #inscription [data-toggle-panel]').forEach(button => {
    if (!button.querySelector('.timeline-ink')) button.innerHTML = `<span class="timeline-ink">${esc(button.textContent)}</span>`;
  });
  fitTimelineWindow();
}

function fitTimelineWindow() {
  const list = $('#schedule-list');
  if (!list?.getBoundingClientRect().height) return;
  const tops = $$('.timeline-node', list).map(node => node.getBoundingClientRect().top);
  const spans = tops.slice(4).map((top, index) => top - tops[index]);
  if (spans.length) list.style.setProperty('--timeline-window', `${Math.floor(Math.min(...spans) - 1)}px`);
  else list.style.removeProperty('--timeline-window');
  const panel = $('#inscription');
  const frame = $('#schematic').getBoundingClientRect();
  const legend = $('.map-legend').getBoundingClientRect();
  const bottomSpace = legend.height ? frame.bottom - legend.top + 12 : 16;
  const lastTop = frame.height - panel.getBoundingClientRect().height - bottomSpace;
  panel.style.setProperty('--itinerary-top', `${Math.round(Math.max(8, Math.min(frame.height / 2, lastTop)))}px`);
}

function compactItinerary() {
  if (state.compact) return;
  state.compact = true;
  state.expandedStep = null;
  const scroll = $('#schedule-list').scrollTop;
  renderSchedule();
  $('#schedule-list').scrollTop = scroll;
}

function revealStep() {
  const row = $(`[data-step-row="${state.step}"]`);
  if (!row) return;
  const list = $('#schedule-list');
  const box = row.getBoundingClientRect();
  const frame = list.getBoundingClientRect();
  if (box.top < frame.top || box.bottom > frame.bottom) list.scrollTop += box.top - frame.top;
}

function chooseDay(id) {
  if (!planDays().some(day => day.id === id)) return;
  state.day = id;
  state.period = 'morning';
  const steps = schedule();
  const first = steps.find(step => step.mode === 'visit') || steps[0];
  state.step = first.id;
  state.spot = stepSpot(first);
  state.compact = true;
  state.expandedStep = null;
  renderSchedule();
  $('#schedule-list').scrollTop = 0;
  updateMap();
  renderCaption();
  state.guidedSpot = null;
  resetDefaultMap();
}

function chooseStep(id, fit = true) {
  const step = schedule().find(step => step.id === id);
  if (!step) return;
  const restoreFocus = document.activeElement?.dataset.step === id;
  const expand = state.compact || state.expandedStep !== id;
  state.step = id;
  state.spot = timelineSpot(step);
  state.period = step.period;
  state.compact = false;
  state.expandedStep = expand ? id : null;
  const scroll = $('#schedule-list').scrollTop;
  renderSchedule();
  $('#schedule-list').scrollTop = scroll;
  if (state.expandedStep === id) {
    const row = $(`[data-step-row="${id}"]`);
    const list = $('#schedule-list');
    if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 2;
  } else revealStep();
  updateMap();
  renderCaption();
  if (fit) focusStep();
  rippleSpot();
  if (restoreFocus) $(`[data-step="${id}"]`).focus({ preventScroll: true });
}

function chooseSpot(id, fromItinerary = false) {
  const spot = locationInfo(id);
  if (!spot?.position) return;
  const previousDay = state.day;
  const restoreMapFocus = document.activeElement?.classList.contains('spot-node');
  const restoreListFocus = fromItinerary && document.activeElement?.dataset.spot === id;
  let steps = schedule();
  if (!steps.some(step => step.spotIds.includes(id))) {
    const otherDay = planDays().find(day => day.events.some(event => event.duration && event.spotIds.includes(id)));
    if (otherDay) { state.day = otherDay.id; steps = schedule(); }
  }
  const step = currentStep()?.spotIds.includes(id) ? currentStep() : steps.find(step => step.mode === 'visit' && step.spotIds.includes(id)) || steps.find(step => step.spotIds.includes(id));
  if (step) { state.step = step.id; state.period = step.period; }
  else state.step = null;
  state.spot = id;
  state.compact = !fromItinerary;
  state.expandedStep = fromItinerary ? step?.id : null;
  const scroll = $('#schedule-list').scrollTop;
  renderSchedule();
  $('#schedule-list').scrollTop = scroll;
  revealStep();
  updateMap();
  renderCaption();
  $('#map-search').open = false;
  if (state.day !== previousDay) notify(`已切到${dayLabel(allDays().find(day => day.id === state.day))}的行程`);
  else if (!step && state.plan === 'one-day') notify('该地点不在一天精华游安排中，可自由查看地图。');
  focusPoints([spot.position]);
  rippleSpot();
  if (restoreMapFocus) $(`#schematic [data-spot="${esc(id)}"]`).focus({ preventScroll: true });
  if (restoreListFocus) $(`#map-detail [data-spot="${esc(id)}"]`)?.focus({ preventScroll: true });
}

function renderCaption() {
  const spot = locationInfo(state.spot);
  const step = currentStep();
  $('#map-caption').innerHTML = `<p>${step ? `${clock(step.start)}—${clock(step.end)} · ${step.estimated ? '预计' : ''}${modeNames[step.mode]}${step.duration}分钟` : state.plan === 'one-day' ? '本计划未安排' : '沿线景点'}</p><h3>${esc(spot.name)}</h3>`;
}

function renderSearch() {
  const query = $('#spot-search').value.trim();
  const points = locations().filter(spot => `${spot.name}${spot.valley || ''}`.includes(query));
  $('#spot-results').innerHTML = points.length ? points.map(spot => {
    const days = daysForSpot(spot);
    const label = state.plan === 'one-day' ? days.length ? '一天精华游' : '未安排' : `${days.length > 1 ? '两天' : `第${days[0]?.id === 'day2' ? '二' : '一'}天`}${days.length ? ` · ${days.map(day => day.shortDate).join('／')}` : ''}`;
    return `<button type="button" data-spot="${esc(spot.id)}"><span class="spot-key${days.some(day => day.id === state.day) ? ' is-today' : ''}" aria-hidden="true"></span>${esc(spot.name)}<small class="result-day">${esc(label)}</small></button>`;
  }).join('') : '<p class="empty">没有匹配地点，试试“长海”或“树正”。</p>';
}

function renderMapTerrain() {
  // Illustrative terrain follows the existing schematic, not surveyed geography.
  const contours = [
    'M422 99 Q482 115 459 225 T498 430 Q538 505 601 546 M443 93 Q507 119 482 235 T527 428 Q565 494 616 521',
    'M687 98 Q783 67 876 114 T1111 146 M713 157 Q804 121 905 167 T1089 193 M737 220 Q826 182 916 220 T1057 244 M763 285 Q840 250 915 284 T1009 302',
    'M1407 202 Q1431 267 1368 335 T1237 447 M1380 204 Q1392 273 1340 331 T1219 423',
    'M1006 713 Q1095 693 1141 770 T1178 970 M1033 739 Q1093 729 1121 790 T1155 963 M704 720 Q759 760 733 825 T655 950'
  ].map(d => `<path class="terrain-contour" d="${d}"/>`).join('');
  const rivers = [
    'M538 171 C554 196 570 213 591 227 S623 289 612 337 S643 422 660 450 S685 539 772 594',
    'M1288 146 Q1262 208 1221 282 T1177 349 Q1155 381 1115 414 L1109 468 Q1081 492 1056 506 T1009 537 Q926 569 855 546 T782 597',
    'M782 597 Q800 621 823 647 T863 719 Q895 776 876 810 T827 864 Q819 895 786 929 T747 976 Q715 1005 696 1035 L662 1092'
  ].map(d => `<path class="terrain-river-bank" d="${d}"/><path class="terrain-river" d="${d}"/>`).join('');
  const boardwalks = [['changhai','changhai-boardwalk'],['wucaichi','wucaichi-boardwalk'],['jianzhuhai','jianzhu-boardwalk'],['wuhuahai','wuhua-boardwalk'],['shuzheng','shuzheng-inner','spark']].map(ids => `<polyline class="terrain-boardwalk" points="${ids.map(id => locationInfo(id).position.join(',')).join(' ')}"/>`).join('');
  const hubs = locations().filter(spot => spot.kind === 'facility').map(spot => `<circle class="terrain-hub" cx="${spot.position[0]}" cy="${spot.position[1]}" r="27"/>`).join('');
  return `<g class="map-terrain" aria-hidden="true">${contours}${rivers}${boardwalks}${hubs}</g>`;
}

function renderMap() {
  const { width, height } = guide.map.canvas;
  const mainNames = new Set(['changhai','wucaichi','forest','jianzhuhai','panda','wuhuahai','peacock','pearl','mirror','nuorilang','rhino','tiger','shuzheng','shuzheng-village','spark','double-falls','double-lake','reed','park-gate','nuorilang-center']);
  const artwork = `<g class="map-artwork" aria-hidden="true"><image href="/paper-landscape-v1.webp" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></g>`;
  const waters = guide.map.water.map(water => `<path class="lake-shape${water.seasonal ? ' seasonal-lake' : ''}" data-water="${esc(water.id)}" d="${esc(water.d)}"><title>${esc(locationInfo(water.id).name)}水面示意</title></path>`).join('');
  const roads = guide.map.paths.map(path => `<path class="road-underlay" d="${esc(path.d)}"/><path class="route-line" d="${esc(path.d)}"/>`).join('');
  const nodes = locations().map(spot => {
    const [x, y] = spot.position;
    const left = spot.labelSide === 'left';
    return `<g class="spot-node${mainNames.has(spot.id) ? '' : ' node-detail'}${spot.kind === 'facility' ? ' node-facility' : ''}" data-spot="${esc(spot.id)}" role="button" tabindex="0" aria-label="${esc(spot.name)}" aria-pressed="false"><circle class="hit-target" cx="${x}" cy="${y}" r="30"/><circle class="route-dot" cx="${x}" cy="${y}" r="12"/><text class="spot-label" x="${x + (left ? -24 : 24)}" y="${y + 7}" text-anchor="${left ? 'end' : 'start'}">${esc(spot.mapLabel || spot.name)}</text></g>`;
  }).join('');
  $('#schematic').innerHTML = `<svg class="route-svg" viewBox="0 0 ${width} ${height}" role="group" aria-label="九寨沟三沟与湖泊全景示意图">${artwork}${renderMapTerrain()}<g class="map-geography" aria-hidden="true"><text x="580" y="370" transform="rotate(73 580 370)">则查洼沟</text><text x="1375" y="365" transform="rotate(-66 1375 365)">日则沟</text><text x="1050" y="850" transform="rotate(10 1050 850)">树正沟</text><text class="north-mark" x="1490" y="72">↑ 北</text></g><g class="map-water">${waters}</g><g aria-hidden="true">${roads}<path id="active-route" class="active-route"/></g>${nodes}<g id="map-ripple" aria-hidden="true" pointer-events="none"></g></svg><div class="location-pointer" id="location-pointer" aria-hidden="true" hidden><svg viewBox="0 0 24 40"><path d="M8 2H16V21H23L12 38L1 21H8Z"/></svg></div>`;
  bindMapGestures();
  updateMap();
}

function updateMap() {
  const dayIds = new Set(locations().filter(spot => daysForSpot(spot).some(day => day.id === state.day)).map(spot => spot.id));
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
  positionPointer();
  renderSearch();
}

function mapHomePose() {
  const frame = $('#schematic');
  const box = $('#schematic .route-svg').getBoundingClientRect();
  const referenceX = locationInfo('wuhuahai').position[0] / guide.map.canvas.width;
  return {
    left: isMobile() ? frame.clientWidth * .7 - referenceX * box.width : (frame.clientWidth - box.width) / 2,
    top: (frame.clientHeight - box.height) / 2,
    width: box.width,
    height: box.height
  };
}

function positionMap(x, y) {
  const container = $('#schematic');
  const svg = $('.route-svg', container);
  if (!mapMoving || !mapGeometry) {
    const frame = container.getBoundingClientRect();
    const box = svg.getBoundingClientRect();
    mapGeometry = { frame, width: box.width, height: box.height,
      baseLeft: box.left - frame.left - mapOffset.x,
      baseTop: box.top - frame.top - mapOffset.y, home: mapHomePose(),
      landmarks: guide.map.water.map(water => locationInfo(water.id)).filter(spot => spot?.position).map(spot => ({ x: spot.position[0] / guide.map.canvas.width * box.width, y: spot.position[1] / guide.map.canvas.height * box.height })) };
  }
  const { frame, baseLeft, baseTop, home, landmarks } = mapGeometry;
  const box = mapGeometry;
  const range = (origin, size, extent) => {
    const visible = Math.min(size, extent) / 2;
    return [Math.max(origin - size / 2, visible - size), Math.min(origin + size / 2, extent - visible)];
  };
  const xs = range(home.left, box.width, frame.width);
  const ys = range(home.top, box.height, frame.height);
  const clamp = (value, limits) => Math.max(limits[0], Math.min(limits[1], value));
  let left = clamp(baseLeft + x, xs);
  let top = clamp(baseTop + y, ys);
  // Keep a lake landmark inside the view when the blank margin of the drawing reaches a corner.
  const marginX = Math.min(56, frame.width * .15);
  const marginY = Math.min(56, frame.height * .1);
  if (!landmarks.some(point => point.x + left >= marginX && point.x + left <= frame.width - marginX && point.y + top >= marginY && point.y + top <= frame.height - marginY)) {
    const candidates = landmarks.map(point => {
      const xx = [Math.max(xs[0], marginX - point.x), Math.min(xs[1], frame.width - marginX - point.x)];
      const yy = [Math.max(ys[0], marginY - point.y), Math.min(ys[1], frame.height - marginY - point.y)];
      if (xx[0] > xx[1] || yy[0] > yy[1]) return null;
      const x = clamp(left, xx), y = clamp(top, yy);
      return { x, y, distance: (x - left) ** 2 + (y - top) ** 2 };
    }).filter(Boolean).sort((a, b) => a.distance - b.distance);
    if (candidates.length) { left = candidates[0].x; top = candidates[0].y; }
  }
  mapOffset.x = left - baseLeft;
  mapOffset.y = top - baseTop;
  svg.style.transform = `translate3d(${mapOffset.x}px, ${mapOffset.y}px, 0)`;
  if (!mapMoving) placeMapLabels();
  positionPointer();
}

function placeMapLabels() {
  const frame = $('#schematic').getBoundingClientRect();
  const box = $('#schematic .route-svg').getBoundingClientRect();
  const scale = box.width / guide.map.canvas.width;
  const labels = $$('#schematic .spot-label').map(label => ({ label, width: label.getComputedTextLength() }));
  labels.forEach(({ label, width }) => {
    const spot = locationInfo(label.parentElement.dataset.spot);
    const x = box.left - frame.left + spot.position[0] * scale;
    let left = spot.labelSide === 'left';
    const space = width * scale + 24 * scale + 8;
    if (x >= 8 && x <= frame.width - 8) {
      if (left && x < space) left = false;
      else if (!left && frame.width - x < space) left = true;
    }
    label.setAttribute('x', spot.position[0] + (left ? -24 : 24));
    label.setAttribute('text-anchor', left ? 'end' : 'start');
  });
}

function positionPointer(restart = false) {
  const pointer = $('#location-pointer');
  if (!pointer) return;
  const spot = locationInfo(state.guidedSpot);
  if (!spot?.position || state.guidedSpot !== state.spot) { pointer.hidden = true; return; }
  const cached = mapMoving && mapGeometry;
  const frame = cached ? cached.frame : $('#schematic').getBoundingClientRect();
  const svg = cached ? { left: frame.left + cached.baseLeft + mapOffset.x, top: frame.top + cached.baseTop + mapOffset.y, width: cached.width, height: cached.height } : $('#schematic .route-svg').getBoundingClientRect();
  const x = svg.left - frame.left + spot.position[0] / guide.map.canvas.width * svg.width;
  const y = svg.top - frame.top + spot.position[1] / guide.map.canvas.height * svg.height;
  pointer.hidden = x < 10 || x > frame.width - 10 || y < 10 || y > frame.height - 10;
  pointer.dataset.location = spot.id;
  pointer.classList.toggle('points-up', y < 60);
  pointer.style.left = `${x}px`;
  pointer.style.top = `${y < 60 ? y + 11 : y - 11}px`;
  if (restart && !pointer.hidden) {
    pointer.classList.remove('is-pointing');
    void pointer.offsetWidth;
    pointer.classList.add('is-pointing');
  }
}

function setMapZoom(value, anchor) {
  const container = $('#schematic');
  const svg = $('.route-svg', container);
  if (!svg || !container.clientWidth || !container.clientHeight) return;
  const zoom = Math.max(mapLimits.min, Math.min(mapLimits.max, value));
  const frame = container.getBoundingClientRect();
  const old = svg.getBoundingClientRect();
  const point = anchor || { x: frame.left + container.clientWidth / 2, y: frame.top + container.clientHeight / 2 };
  const rx = old.width ? (point.x - old.left) / old.width : .5;
  const ry = old.height ? (point.y - old.top) / old.height : .5;
  const box = svg.viewBox.baseVal;
  const baseWidth = Math.min(container.clientWidth, container.clientHeight * box.width / box.height);
  svg.style.width = `${baseWidth * zoom}px`;
  mapGeometry = null;
  container.dataset.zoom = zoom;
  const next = svg.getBoundingClientRect();
  positionMap(mapOffset.x + point.x - next.left - rx * next.width, mapOffset.y + point.y - next.top - ry * next.height);
  $('#map-scale').textContent = `${Number(zoom.toFixed(1))}×`;
  $('[data-zoom="out"]').disabled = zoom === mapLimits.min;
  $('[data-zoom="in"]').disabled = zoom === mapLimits.max;
}

function resetMap(zoom = mapLimits.min) {
  setMapZoom(zoom);
  const frame = $('#schematic').getBoundingClientRect();
  const svg = $('#schematic .route-svg').getBoundingClientRect();
  const home = mapHomePose();
  const left = zoom === mapLimits.min ? (frame.width - svg.width) / 2 : home.left;
  positionMap(mapOffset.x + frame.left + left - svg.left, mapOffset.y + frame.top + home.top - svg.top);
  positionPointer();
}

function resetDefaultMap() {
  resetMap(isMobile() ? mobileFocusZoom : mapLimits.min);
}

function focusPoints(points) {
  if (!points.length) return;
  const container = $('#schematic');
  const { width, height } = guide.map.canvas;
  const frame = container.getBoundingClientRect();
  const box = $('.route-svg', container).getBoundingClientRect();
  let targetX;
  let targetY;
  if (isMobile()) {
    const panel = $('#inscription').getBoundingClientRect();
    const left = Math.max(frame.left + frame.width * .55, panel.right + 18);
    targetX = Math.min(frame.right - 26, (left + frame.right - 26) / 2);
    targetY = Math.max(frame.top + 160, Math.min(frame.top + frame.height * .43, panel.top - 38));
  } else {
    const panel = $('#inscription').getBoundingClientRect();
    const panelOnLeft = panel.left + panel.width / 2 < frame.left + frame.width / 2;
    const left = panelOnLeft ? panel.right - frame.left + 35 : 30;
    const right = panelOnLeft ? frame.width - 30 : panel.left - frame.left - 35;
    const availableWidth = Math.max(100, right - left);
    const availableHeight = container.clientHeight - 110;
    targetX = frame.left + left + availableWidth / 2;
    targetY = frame.top + availableHeight / 2;
  }
  const cx = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  positionMap(mapOffset.x + targetX - box.left - cx / width * box.width, mapOffset.y + targetY - box.top - cy / height * box.height);
}

function focusStep() {
  const spot = locationInfo(state.spot);
  if (spot?.position) focusPoints([spot.position]);
}

function rippleSpot() {
  const spot = locationInfo(state.spot);
  const layer = $('#map-ripple');
  if (!spot?.position || !layer) return;
  state.guidedSpot = spot.id;
  positionPointer(true);
  clearTimeout(rippleTimer);
  layer.replaceChildren();
  layer.setAttribute('transform', `translate(${spot.position.join(' ')})`);
  layer.dataset.location = spot.id;
  for (let index = 0; index < 3; index++) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '18');
    circle.setAttribute('class', 'location-ripple');
    circle.style.animationDelay = `${index * 160}ms`;
    layer.append(circle);
  }
  rippleTimer = setTimeout(() => layer.replaceChildren(), 1800);
}

function nearestSpot(clientX, clientY) {
  const svg = $('#schematic .route-svg');
  if (!svg) return null;
  const box = svg.getBoundingClientRect();
  if (!box.width) return null;
  const scaleX = box.width / guide.map.canvas.width;
  const scaleY = box.height / guide.map.canvas.height;
  let best = null;
  let bestDistance = Infinity;
  for (const spot of locations()) {
    if (!spot.position) continue;
    const x = box.left + spot.position[0] * scaleX;
    const y = box.top + spot.position[1] * scaleY;
    const distance = Math.hypot(clientX - x, clientY - y);
    if (distance < bestDistance) { bestDistance = distance; best = spot; }
  }
  return bestDistance <= 44 ? best : null;
}

function bindMapGestures() {
  const container = $('#schematic');
  const pointers = new Map();
  let moved = false;
  let origin;
  let lastTap = null;
  let suppressClick = false;
  let pendingFrame = 0;
  let pendingX = 0, pendingY = 0, pendingZoom = 1, pendingAnchor;
  const flush = () => {
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
    if (pendingZoom !== 1) setMapZoom(Number(container.dataset.zoom || 1) * pendingZoom, pendingAnchor);
    if (pendingX || pendingY) positionMap(mapOffset.x + pendingX, mapOffset.y + pendingY);
    pendingX = pendingY = 0;
    pendingZoom = 1;
  };
  const finish = () => {
    flush();
    if (pointers.size) return;
    mapMoving = false;
    mapGeometry = null;
    container.classList.remove('is-moving');
    placeMapLabels();
    positionPointer();
  };
  const span = () => {
    const [a,b] = [...pointers.values()];
    return b && { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  container.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!pointers.size) { moved = false; origin = { x: event.clientX, y: event.clientY }; }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  container.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const before = span();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8 || pointers.size > 1) moved = true;
    if (!moved) return;
    if (!mapMoving) {
      compactItinerary();
      mapMoving = true;
      mapGeometry = null;
      container.classList.add('is-moving');
    }
    if (!container.hasPointerCapture(event.pointerId)) container.setPointerCapture(event.pointerId);
    if (pointers.size > 1) {
      const after = span();
      if (before?.distance && after.distance) { pendingZoom *= after.distance / before.distance; pendingAnchor = after; }
      if (before) { pendingX += after.x - before.x; pendingY += after.y - before.y; }
    } else { pendingX += event.clientX - previous.x; pendingY += event.clientY - previous.y; }
    if (!pendingFrame) pendingFrame = requestAnimationFrame(flush);
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) container.addEventListener(type, event => {
    if (type !== 'lostpointercapture' || event.target === container) {
      pointers.delete(event.pointerId);
      if (mapMoving) finish();
    }
  });
  // Double tap toggles between the whole map and a close view around the tapped point.
  container.addEventListener('pointerup', event => {
    if (moved || pointers.size > 1 || event.target.closest('.map-search, .map-controls, button, summary, a')) return;
    const now = performance.now();
    const tap = { x: event.clientX, y: event.clientY, time: now };
    if (lastTap && now - lastTap.time < 330 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 32) {
      lastTap = null;
      suppressClick = true;
      if (Number(container.dataset.zoom || 1) > 1.25) resetMap(mapLimits.min);
      else setMapZoom(1.9, tap);
      rippleSpot();
    } else lastTap = tap;
  });
  container.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
    if (moved) { moved = false; event.preventDefault(); event.stopPropagation(); return; }
    if (event.target.closest('.spot-node, button, summary, a, .map-controls, .map-search')) return;
    const hit = nearestSpot(event.clientX, event.clientY);
    if (hit) { event.preventDefault(); event.stopPropagation(); chooseSpot(hit.id); }
  }, true);
  container.addEventListener('wheel', event => {
    event.preventDefault();
    compactItinerary();
    if (event.ctrlKey || event.metaKey) setMapZoom(Number(container.dataset.zoom || 1) * Math.exp(-event.deltaY * .005), { x: event.clientX, y: event.clientY });
    else positionMap(mapOffset.x - event.deltaX, mapOffset.y - event.deltaY);
  }, { passive: false });
  container.addEventListener('keydown', event => {
    if (event.target !== container || !['+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    compactItinerary();
    const moves = { ArrowLeft: [50,0], ArrowRight: [-50,0], ArrowUp: [0,50], ArrowDown: [0,-50] };
    if (moves[event.key]) positionMap(mapOffset.x + moves[event.key][0], mapOffset.y + moves[event.key][1]);
    else setMapZoom(Number(container.dataset.zoom || 1) * (event.key === '-' ? 1 / 1.25 : 1.25));
  });
  mapResize?.disconnect();
  mapResize = new ResizeObserver(() => {
    fitTimelineWindow();
    mapGeometry = null;
    setMapZoom(Number(container.dataset.zoom || 1));
  });
  mapResize.observe(container);
  resetMap();
}

function renderNotes() {
  const costs = guide.costs;
  const single = state.plan === 'one-day';
  const estimates = planDays().map(day => `${day.date ? day.shortDate : day.label}：${state.starts.get(day.id) || day.startTime}入园，预计${clock(schedule(day.id).at(-1).end)}出沟`).join('；');
  const tripNotes = single ? '' : `<section class="note-section"><h2>待落实</h2><ul class="pending-list">${guide.pending.map(item => `<li><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></li>`).join('')}</ul></section>`;
  const accommodation = single ? '' : `<section class="note-section"><h2>三晚住宿</h2><p>10月29、30日：${esc(guide.trip.hotel.name)}。${esc(guide.trip.hotel.note)}</p><p>前两晚预算每人每晚¥${guide.trip.hotelBudgetPerPersonNight}，全队两晚¥${costs.hotelTeamTwoNights}。</p><p>10月31日：${esc(guide.trip.stationHotel.name)}。${esc(guide.trip.stationHotel.note)} 第三晚及道路接送费用另行确认。</p></section><section class="note-section"><h2>道路接送与返程</h2>${guide.transport.map(item => `<div class="transport-item"><h3>${esc(item.title)}<small>${esc(item.badge)}</small></h3><p>${esc(item.text)}</p></div>`).join('')}<p>${esc(guide.trip.returnNote)}</p></section>`;
  $('#notes').innerHTML = `<div class="page-heading"><div><p>${single ? '一天精华游参考' : '住宿、交通与票务'}</p><h1 id="notes-title" tabindex="-1">出行须知</h1></div><span class="checked">核对 ${esc(guide.checkedAt)}</span></div>${tripNotes}<section class="note-section"><h2>行程与当天开放</h2><p>${esc(single ? '开放时段、栈道与末班车以实际游览当天的预约页和现场公告为准。' : guide.park.note)}</p><p>${esc(single ? planDays()[0].note : guide.schedule.note)}</p><p>${esc(estimates)}。实际用时随车流、观景和开放情况变化。</p></section><section class="note-section"><h2>${single ? '当天' : '两天'}门票与观光车</h2><p>${single ? '现有旺季成人价格参考：' : '每天每位成人：'}门票¥${guide.ticket.entrance}＋观光车¥${guide.ticket.bus}。${single ? `当天每人¥${costs.perDay}。` : `两天每人¥${costs.perPersonTwoDays}，${guide.trip.people}人共¥${costs.teamTwoDays}。`}</p><p>${esc(single ? '请按实际出行日期及优惠资格核对官方票价并预约。' : guide.ticket.note)} ${single ? '' : esc(guide.ticket.validity)}</p>${external(guide.sources.find(source => source.id === 'tickets').url, '官方票务')}</section>${accommodation}<details class="sources note-section"><summary>资料来源与地图说明</summary><p>${esc(guide.map.note)}</p>${guide.sources.map(source => `<div class="source-item">${external(source.url, source.title)}<p>${esc(source.note)}</p></div>`).join('')}</details>`;
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
  if (target === 'itinerary') {
    renderSchedule();
    if (isMobile()) revealStep(); else window.scrollTo(0,0);
  } else if (target === 'route') {
    if (isMobile()) { compactItinerary(); revealStep(); } else $('#route').scrollIntoView({ block:'start' });
  } else {
    window.scrollTo(0,0);
    if (focus) $(`#${target}-title`).focus({ preventScroll:true });
  }
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
  $('#print-itinerary').innerHTML = printDays().map(day => `<section><h2>${esc(dayLabel(day))}${day.date ? ` ${esc(day.label)}` : ''}</h2><p>${esc(day.stay || day.note)}</p><ol>${day.events.map(event => {
    const timed = day.startTime && event.duration ? schedule(day.id).find(step => step.id === event.id) : null;
    return `<li><time>${timed ? `${clock(timed.start)}—${clock(timed.end)}` : esc(event.time)}</time><strong>${esc(event.title)}</strong>${event.duration ? `<span>${modeNames[event.mode]} ${event.duration}分钟</span>` : ''}<p>${esc(event.detail)}</p></li>`;
  }).join('')}</ol></section>`).join('');
}

function tripMoment() {
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const day = planDays().find(item => item.date === iso);
  if (!day) return null;
  const minute = now.getHours() * 60 + now.getMinutes();
  const steps = schedule(day.id);
  return {
    day,
    steps,
    current: steps.find(step => minute >= step.start && minute < step.end) || null,
    next: steps.find(step => step.start > minute) || null
  };
}

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-nav]');
  if (nav && guide) { event.preventDefault(); const target = nav.dataset.nav; if (location.hash !== `#${target}`) history.pushState(null,'',`#${target}`); navigate(target); return; }
  const day = event.target.closest('.day-switch [data-day]');
  if (day) { chooseDay(day.dataset.day); return; }
  const period = event.target.closest('[data-period]');
  if (period) {
    state.period = period.dataset.period;
    state.expandedStep = null;
    const next = schedule().find(step => step.period === state.period);
    if (next && currentStep()?.period !== state.period) { state.step = next.id; state.spot = stepSpot(next); }
    renderSchedule();
    $('#schedule-list').scrollTop = 0;
    updateMap();
    renderCaption();
    if (next) focusStep();
    return;
  }

  const step = event.target.closest('[data-step]');
  if (step) { chooseStep(step.dataset.step); return; }
  const spot = event.target.closest('[data-spot]');
  if (spot) { chooseSpot(spot.dataset.spot, Boolean(spot.closest('#inscription, #map-detail'))); return; }
  const zoom = event.target.closest('[data-zoom]');
  if (zoom) { compactItinerary(); setMapZoom(Number($('#schematic').dataset.zoom || 1) * (zoom.dataset.zoom === 'in' ? 1.4 : 1 / 1.4)); return; }
  if (event.target.closest('[data-toggle-panel]')) { compactItinerary(); return; }
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
phone.addEventListener('change', () => {
  if (!guide) return;
  renderSchedule();
  resetDefaultMap();
});
async function shareGuide() { try { if (!navigator.clipboard?.writeText) throw new Error(); const url = new URL(location.href); url.hash = ''; url.searchParams.set('plan', state.plan); await navigator.clipboard.writeText(url.href); notify('攻略链接已复制'); } catch { notify('请复制地址栏链接分享'); } }
function registerOffline() {
  if (!('serviceWorker' in navigator)) return;
  if (!(location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
async function boot() {
  try {
    guide = await getJSON('/api/guide');
    try { const saved = localStorage.getItem('jiuzhai-plan'); if (plans().some(plan => plan.id === saved)) state.plan = saved; } catch { /* Storage is optional. */ }
    const sharedPlan = new URLSearchParams(location.search).get('plan');
    if (plans().some(plan => plan.id === sharedPlan)) state.plan = sharedPlan;
    if (state.plan !== 'two-days') {
      state.day = planDays()[0].id;
      const first = schedule().find(step => step.mode === 'visit') || schedule()[0];
      state.step = first.id;
      state.spot = stepSpot(first);
    }
    const moment = tripMoment();
    if (moment) {
      state.day = moment.day.id;
      const target = moment.current || moment.next;
      if (target) { state.step = target.id; state.spot = stepSpot(target); state.period = target.period; state.nowStep = moment.current?.id || null; }
    }
    render();
    resetDefaultMap();
    if (moment) {
      setMapZoom(mobileFocusZoom);
      const position = locationInfo(state.spot)?.position;
      if (position) focusPoints([position]);
    }
    registerOffline();
  } catch { $('#main').innerHTML = '<div class="error-box"><h1>行程暂时无法加载</h1><p>请检查连接，再重新加载。</p><button class="quiet-button" id="retry" type="button">重新加载</button></div>'; $('#retry').addEventListener('click', boot, {once:true}); }
}
boot();






