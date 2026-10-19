const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let guide;
const state = { day: 'day1', mapDay: 'all', spot: 'wuhuahai', query: '', mapMode: 'route', layer: 'clouds' };
let weatherRequest = 0;
let toastTimer;

function notify(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3500);
}

async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function external(url, text, classes = '') {
  return `<a class="${classes}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function heroArt() {
  return `<svg class="hero-art" viewBox="0 0 620 370" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#356454"/><stop offset="1" stop-color="#173f36"/></linearGradient><linearGradient id="lake" x2="0" y2="1"><stop stop-color="#7eb2a2"/><stop offset="1" stop-color="#375c50"/></linearGradient></defs>
    <path fill="url(#sky)" d="M0 0h620v370H0z"/><circle cx="445" cy="75" r="34" fill="#ded5a0"/>
    <path d="M0 240 100 135 147 170 237 60 330 178 370 130 460 215 540 135 620 220V370H0Z" fill="#739283"/>
    <path d="m190 116 47-56 58 75-34-16-18 8-16-26-12 22z" fill="#d1dac7"/>
    <path d="M0 280 80 225 140 247 230 179 306 258 390 192 475 270 580 220 620 255V370H0Z" fill="#456e5d"/>
    <path d="M0 314c110-59 210-16 299-38s183-23 321 22v72H0Z" fill="#254f40"/>
    <path d="M110 320c45-23 105-5 155-16s77-11 125-1c-56 13-81 22-86 32 42 13 67 16 122 35H85c40-22 91-21 94-29-16-10-43-9-69-21Z" fill="url(#lake)"/>
    <g fill="#bda663"><path d="m83 220-24 70h48z"/><path d="m118 242-23 68h47z"/><path d="m447 212-27 83h54z"/><path d="m484 234-22 73h44z"/></g>
    <g fill="#1b4132"><path d="m39 200-34 123h68z"/><path d="m537 190-33 134h66z"/><path d="m588 214-36 125h72z"/></g>
    <g stroke="#afc4aa" stroke-width="1" opacity=".35"><path d="M204 319h85m-113 29h105m18 13h70m-95-29h48"/></g>
    <path d="M0 358q60-24 109 12H0" fill="#bd8948"/><path d="M620 347q-79-27-139 23h139" fill="#9e874b"/>
    <text x="350" y="335" fill="#cbd7bc" font-family="Georgia,serif" font-size="13" letter-spacing="5">JIUZHAIGOU</text>
  </svg>`;
}

function sectionTop(number, title, description, action = '') {
  return `<div class="section-top"><div><span class="section-number">${number} / FIELD NOTES</span><h2>${title}</h2><p class="section-description">${description}</p></div>${action}</div>`;
}

function render() {
  const c = guide.costs;
  $('#main').innerHTML = `
    <section class="hero" aria-label="行程概览"><div class="hero-copy"><span class="eyebrow">七人同行 · 一天半游览 · 沟外住两晚</span><h1>把秋天，走成一条路。</h1><p>一起看海子、彩林和远山。天气、路线与集合时间，出发前看这一页就好。</p><div class="hero-actions"><a class="button light" href="#itinerary">翻开我们的日程 ↓</a><span class="hero-date">2026.11.01 — 11.04</span></div></div>${heroArt()}<span class="art-credit">OUR AUTUMN, TOGETHER.</span></section>
    <div class="facts"><div class="fact"><span class="fact-label">同行人数</span><strong class="fact-value">${guide.trip.people} 位旅伴</strong><span class="fact-note">一起行动，留出集合时间</span></div><div class="fact"><span class="fact-label">九寨沟住宿</span><strong class="fact-value">沟外 · 2 晚</strong><span class="fact-note">11月1日入住，3日退房</span></div><div class="fact"><span class="fact-label">入园时间 · 公告参考</span><strong class="fact-value">${guide.park.open}—${guide.park.lastEntry}</strong><span class="fact-note">${guide.park.close}闭园，出发前复核</span></div><div class="fact"><span class="fact-label">周二返程集合</span><strong class="fact-value">14:00 出发</strong><span class="fact-note">从沟口出发，不是高铁时刻</span></div></div>
    <section id="route" class="section">${sectionTop('01', '三条沟，慢慢看。', '先认清三沟关系，再决定在哪个海子多待一会儿。', `<div class="section-actions"><button class="button quiet" id="map-mode" type="button">查看官方原图 ↗</button></div>`)}
      <div class="map-layout"><div class="map-card"><div class="map-toolbar"><div class="segmented" role="group" aria-label="按游览日筛选地图"><button data-map-day="all" aria-pressed="true">全部景点</button><button data-map-day="1" aria-pressed="false">周一 · 上游</button><button data-map-day="2" aria-pressed="false">周二 · 树正沟</button></div><span class="map-caption">路线示意 · 不按比例<br>点击圆点查看景点</span></div><div class="map-viewport" id="schematic"></div><div id="official-map" class="official-map" hidden><p>九寨沟管理局官方导览图 · 图片来自景区官网</p><img id="official-image" alt="九寨沟景区官方导览图" loading="lazy">${external(guide.map.officialPage, '在景区官网查看原图 ↗', 'button quiet')}<p id="map-image-error" hidden>图片暂时无法载入，请通过上方链接打开官方导览页。</p></div><div class="map-bottom"><div class="legend"><span><i></i> 周一建议</span><span><i></i> 周二建议</span></div><span>景区入口在图下方 ↑</span></div></div><div class="map-side"><article class="spot-detail" id="spot-detail" aria-live="polite"></article><div class="spot-list-box"><label class="sr-label" for="spot-search">查找景点</label><input class="search" id="spot-search" type="search" placeholder="查找海子、瀑布或支沟…" autocomplete="off"><div class="spot-list" id="spot-list"></div></div></div></div><p class="map-disclaimer">${esc(guide.map.note)} ${external(guide.map.officialPage, '对照官方导览 ↗')}</p>
    </section>
    <section id="itinerary" class="section">${sectionTop('02', '我们的四天三晚。', '到达的晚上不赶路打卡；两晚都住沟外，周二中午开始收尾。', '<button class="button quiet" id="print-button" type="button">打印 / 保存 PDF ↗</button>')}<div class="day-tabs" role="tablist" aria-label="选择行程日期">${guide.days.map(day => `<button class="day-tab" id="tab-${day.id}" data-day="${day.id}" role="tab" aria-controls="day-panel" aria-selected="${day.id === state.day}" tabindex="${day.id === state.day ? 0 : -1}"><span class="date">${day.shortDate}<span class="week">${day.weekday}</span></span><span class="day-label">${day.label}</span></button>`).join('')}</div><div class="itinerary-panel" id="day-panel" role="tabpanel" aria-labelledby="tab-day1"></div><div class="print-only" id="all-days-print"></div></section>
    <section id="weather" class="section">${sectionTop('03', '给晴天留一点期待。', 'Windy 实时图层已定位九寨沟景区区域；切换云量、降水与温度查看。', external(guide.weather.fullUrl, '打开 Windy 完整预报 ↗', 'button quiet'))}<div class="weather-layout"><div class="weather-card"><div class="weather-toolbar"><div class="segmented" role="group" aria-label="天气图层"><button data-layer="clouds" aria-pressed="true">云量</button><button data-layer="rain" aria-pressed="false">降水</button><button data-layer="temp" aria-pressed="false">温度</button><button data-layer="wind" aria-pressed="false">风</button></div><small>四川 · 九寨沟 / 33.20°N, 103.90°E</small></div><iframe class="weather-frame" id="windy-frame" title="Windy九寨沟实时天气地图" src="${esc(guide.weather.embedUrl)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe><div class="weather-foot"><span>由 Windy 提供；可在图内切换预报时间。</span><button class="button quiet" id="reload-weather" type="button">重新加载 ↻</button></div></div><aside class="weather-aside"><span class="eyebrow">LOOK AT THE SKY</span><h3>想看蓝绿湖水，<br>也要看白天的云。</h3><div class="weather-point"><strong>先看日照，再看晴雨图标</strong><p>关注游览时段的云量、低云与降水。没有下雨，也可能是阴天。</p></div><div class="weather-point"><strong>出发前 3 天，再核对一次</strong><p>11月2—3日是目标游览日，不代表当前地图已经显示那两天。按 Windy 可用时效选择预报时间。</p></div><div class="weather-point"><strong>网页没加载出来？</strong><p>Windy 需要外部网络。可重新加载，或打开完整预报；本页的日程和示意地图仍可使用。</p></div>${external('https://www.weather.com.cn/weather/10127190601A.shtml', '对照中国天气网景区预报 ↗', 'button quiet')}</aside></div><p class="print-only">天气请在线查看 Windy：https://www.windy.com/33.200/103.900。天气为动态数据，本打印件不提供实时预报。</p></section>
    <section id="stay" class="section">${sectionTop('04', '住在沟外，来回有数。', '酒店还没定，先把位置、预算和每一段接送说清楚。')}<div class="stay-grid"><article class="stay-card green"><span class="eyebrow">TWO NIGHTS OUTSIDE THE PARK</span><h3>${esc(guide.trip.hotel.name)}</h3><p class="sub">11.01 入住 → 11.03 退房 · 两晚不换酒店</p><div class="budget-number">¥ ${c.hotelTeamNight.toLocaleString()} <small>/ 全队每晚预算</small></div><div class="split-row"><span>每人每晚</span><strong>¥${guide.trip.hotelBudgetPerPersonNight}</strong></div><div class="split-row"><span>4间房的平均上限</span><strong>¥${c.hotelTeamNight / 4} / 间</strong></div><div class="split-row"><span>两晚全队预算</span><strong>¥${c.hotelTeamTwoNights.toLocaleString()}</strong></div><p class="stay-tip">${esc(guide.trip.hotel.note)}<br>需落实晚到保留房间、供暖、早早餐和周二退房后的行李寄存。</p></article><article class="stay-card"><span class="eyebrow">TICKETS & RIDES</span><h3>两天进沟，分别预约。</h3><p class="sub">11月2日、3日均属旺季 · 普通观光车</p><div class="budget-number">¥ ${c.perPersonTwoDays} <small>/ 成人两日门票与车票</small></div><div class="split-row"><span>每天门票 + 观光车</span><strong>¥${guide.ticket.entrance} + ¥${guide.ticket.bus}</strong></div><div class="split-row"><span>${guide.trip.people}位成人两日合计</span><strong>¥${c.teamTwoDays.toLocaleString()}</strong></div><div class="split-row"><span>周二只玩上午</span><strong>仍需当天票 ¥${c.perDay}</strong></div><p class="stay-tip">${esc(guide.ticket.note)}<br>${esc(guide.ticket.validity)} ${external(guide.sources.find(s => s.id === 'tickets').url, '官方票务 ↗')}</p></article></div><div class="transport-grid">${guide.transport.map(item => `<article class="transport-card"><span class="pill">${esc(item.badge)}</span><h3>${esc(item.title)}</h3><p>${esc(item.text)}</p></article>`).join('')}</div></section>
    <section class="pending-box" aria-label="出发前待确定事项"><div><span class="eyebrow">BEFORE WE GO</span><h3>出发前，<br>还差这几件事。</h3><p>这里是待确认提醒，<br>不代表已经完成预订。</p></div><div class="pending-list">${guide.pending.map((item, i) => `<div class="pending-item"><span class="pending-index">0${i + 1}</span><div><strong>${esc(item.title)}</strong><p>${esc(item.detail)}</p></div></div>`).join('')}</div></section>
    <section class="sources"><details><summary>资料来源与使用说明 <small>内容核对：${guide.checkedAt} · 展开查看官方资料 ↗</small></summary><p class="map-disclaimer">本页是团队行程参考，不提供实时票量、营业确认或导航。游览时段与停留时长为建议；普通观光车调度、栈道开放与当日公告优先。仅展示公共行程，不收集队员姓名、证件或联系方式。</p><p class="map-disclaimer">${esc(guide.park.note)}</p><div class="source-grid">${guide.sources.map(source => `<div class="source-item">${external(source.url, `${esc(source.title)} ↗`)}<small>${esc(source.type)} · ${esc(source.note)}</small></div>`).join('')}</div></details></section>`;
  renderMap();
  renderDetail();
  renderSpotList();
  renderDay();
  $('#all-days-print').innerHTML = guide.days.map(day => `<article class="print-day">${dayContent(day, false)}</article>`).join('');
  bindEvents();
}

function renderMap() {
  const group = guide.spots.map((spot, i) => {
    const [x, y] = spot.position;
    const left = spot.valley === '则查洼沟';
    return `<g class="spot-node ${state.spot === spot.id ? 'selected' : ''} ${state.mapDay !== 'all' && spot.day !== Number(state.mapDay) ? 'dimmed' : ''}" data-spot="${spot.id}" role="button" tabindex="0" aria-label="查看${esc(spot.name)}" aria-pressed="${state.spot === spot.id}"><circle cx="${x}" cy="${y}" r="19" class="route-dot" fill="${spot.day === 1 ? '#3e8895' : '#bd7935'}"/><text class="route-number" x="${x}" y="${y}">${i + 1}</text><text class="spot-label" x="${x + (left ? -32 : 32)}" y="${y + 7}" text-anchor="${left ? 'end' : 'start'}">${esc(spot.name.replace(' / 树正寨', ''))}</text></g>`;
  }).join('');
  $('#schematic').innerHTML = `<svg class="route-svg" viewBox="0 0 800 1190" role="group" aria-label="九寨沟三沟景点关系互动示意图"><defs><pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#b9cbb1" opacity=".3"/></pattern></defs><rect width="800" height="1190" fill="url(#dots)"/>
    <g class="contour"><path d="M-40 240Q10-20 200 20T400 200T750 180T850 480"/><path d="M-30 270Q30 10 200 50T380 230T740 210T830 480"/><path d="M-20 300Q45 50 200 80T360 260T730 240T810 480"/><path d="M-50 770Q110 550 160 650T360 730T600 500T850 850"/><path d="M-50 800Q100 590 155 680T360 760T610 530T850 880"/><path d="M-50 830Q90 630 150 710T360 790T620 560T850 910"/><path d="M0 1100Q160 850 230 1020T550 1050T850 1040"/><path d="M0 1130Q160 890 230 1050T550 1080T850 1070"/></g>
    <g fill="#d5e2cb" opacity=".7"><path d="m75 330 40-70 40 70z"/><path d="m90 340 45-85 45 85z"/><path d="m615 740 48-85 48 85z"/><path d="m650 755 40-76 40 76z"/></g>
    <text class="valley-label" x="55" y="430" transform="rotate(-60 55 430)">则查洼沟</text><text class="valley-label" x="650" y="390" transform="rotate(60 650 390)">日则沟</text><text class="valley-label" x="470" y="850" transform="rotate(85 470 850)">树正沟</text>
    <path class="route-line line-day1" d="M190 100Q185 155 230 200T245 370T330 580"/><path class="route-line line-day1" d="M600 80Q600 115 555 180T535 270T505 365T470 455T410 515T330 580"/>
    <path class="route-line line-day2" d="M330 580Q375 630 350 680T340 765T310 855T290 940T320 1020T330 1115"/>
    <g><ellipse cx="168" cy="95" rx="40" ry="15" fill="#8fbab2" opacity=".65" transform="rotate(-32 168 95)"/><ellipse cx="525" cy="362" rx="45" ry="20" fill="#8ab9b2" opacity=".6"/><ellipse cx="360" cy="677" rx="44" ry="15" fill="#8fbab2" opacity=".6" transform="rotate(-18 360 677)"/></g>
    ${group}<g><rect x="264" y="1100" width="133" height="42" rx="10" fill="#173f36"/><text x="330" y="1127" text-anchor="middle" fill="#f8f6e8" font-size="19">景区入口</text><text class="route-note" x="330" y="1174" text-anchor="middle">沟外酒店 · 步行 / 接送</text></g><text class="route-note" x="555" y="1125">不按比例 · 非导航图</text></svg>`;
}

function renderDetail() {
  const spot = guide.spots.find(item => item.id === state.spot);
  $('#spot-detail').innerHTML = `<div class="detail-top"><span class="pill ${spot.day === 2 ? 'amber' : ''}">${spot.day === 1 ? '周一 · 第1游览日' : '周二 · 半日游览'}</span><span class="eyebrow">${esc(spot.valley)}</span></div><h3>${esc(spot.name)}</h3><p class="detail-tag">${esc(spot.tag)}</p><p class="detail-description">${esc(spot.description)}</p><div class="detail-meta"><div><span>建议停留</span><strong>${esc(spot.minutes)}</strong></div><div><span>位置参考</span><strong>${esc(spot.altitude)}</strong></div></div><p class="detail-travel">↳ ${esc(spot.travel)}</p>`;
}

function renderSpotList() {
  const filtered = guide.spots.filter(spot => (state.mapDay === 'all' || spot.day === Number(state.mapDay)) && `${spot.name}${spot.valley}`.includes(state.query));
  $('#spot-list').innerHTML = filtered.length ? filtered.map(spot => `<button class="${state.spot === spot.id ? 'active' : ''}" data-spot="${spot.id}" data-day="${spot.day}" aria-pressed="${state.spot === spot.id}"><span class="list-dot"></span>${esc(spot.name.replace(' / 树正寨', ''))}</button>`).join('') : '<p class="empty">没有匹配景点，试试“海”或切换全部景点。</p>';
}

function dayContent(day, shortcuts = true) {
  return `<div class="day-heading"><div><h3>${day.shortDate} ${day.weekday} · ${esc(day.label)}</h3><p>${esc(day.subtitle)}</p></div><span class="pill">${esc(day.stay)}</span></div><div class="timeline">${day.events.map(event => `<div class="timeline-item"><span class="timeline-time">${esc(event.time)}</span><div class="timeline-rail" aria-hidden="true"></div><div><div class="event-title"><h4>${esc(event.title)}</h4><span class="pill ${['待订', '待核验', '时间提醒'].includes(event.status) ? 'amber' : ''}">${esc(event.status)}</span></div><p class="event-detail">${esc(event.detail)}</p></div></div>`).join('')}</div>${shortcuts && day.spotIds.length ? `<div class="route-shortcuts">${day.spotIds.map(id => `<button data-jump-spot="${id}">${esc(guide.spots.find(s => s.id === id).name)} ↗</button>`).join('')}</div>` : ''}`;
}

function renderDay() {
  const day = guide.days.find(day => day.id === state.day);
  $('#day-panel').innerHTML = dayContent(day);
  $('#day-panel').setAttribute('aria-labelledby', `tab-${day.id}`);
  $$('.day-tab').forEach(button => {
    const active = button.dataset.day === state.day;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
}

function selectSpot(id) {
  if (!guide.spots.some(spot => spot.id === id)) return;
  state.spot = id;
  $$('.spot-node').forEach(node => {
    node.classList.toggle('selected', node.dataset.spot === id);
    node.setAttribute('aria-pressed', String(node.dataset.spot === id));
  });
  renderDetail();
  renderSpotList();
}

function filterMap(day) {
  state.mapDay = day;
  const selected = guide.spots.find(s => s.id === state.spot);
  if (day !== 'all' && selected.day !== Number(day)) state.spot = guide.spots.find(s => s.day === Number(day)).id;
  $$('[data-map-day]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mapDay === day)));
  renderMap(); renderDetail(); renderSpotList();
}

async function switchWeather(layer) {
  const request = ++weatherRequest;
  try {
    const weather = await getJSON(`/api/weather?layer=${encodeURIComponent(layer)}`);
    if (request !== weatherRequest) return;
    state.layer = layer;
    $('#windy-frame').src = weather.embedUrl;
    $$('[data-layer]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layer === layer)));
  } catch { notify('图层切换失败，请重试或打开 Windy 完整预报。'); }
}

function bindEvents() {
  $('#main').addEventListener('click', event => {
    const spot = event.target.closest('[data-spot]');
    if (spot) selectSpot(spot.dataset.spot);
    const mapDay = event.target.closest('[data-map-day]');
    if (mapDay) filterMap(mapDay.dataset.mapDay);
    const day = event.target.closest('.day-tab');
    if (day) { state.day = day.dataset.day; renderDay(); }
    const jump = event.target.closest('[data-jump-spot]');
    if (jump) { filterMap('all'); selectSpot(jump.dataset.jumpSpot); setMapMode('route'); $('#route').scrollIntoView({ behavior: 'smooth' }); }
    const layer = event.target.closest('[data-layer]');
    if (layer) switchWeather(layer.dataset.layer);
  });
  $('#schematic').addEventListener('keydown', event => {
    const target = event.target.closest('[data-spot]');
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectSpot(target.dataset.spot); }
  });
  $('.day-tabs').addEventListener('keydown', event => {
    const tabs = $$('.day-tab');
    const index = tabs.indexOf(event.target);
    if (index < 0 || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    state.day = tabs[next].dataset.day;
    renderDay(); tabs[next].focus();
  });
  $('#spot-search').addEventListener('input', event => { state.query = event.target.value.trim(); renderSpotList(); });
  $('#map-mode').addEventListener('click', () => setMapMode(state.mapMode === 'route' ? 'official' : 'route'));
  $('#official-image').addEventListener('error', () => { $('#map-image-error').hidden = false; $('#official-image').hidden = true; });
  $('#reload-weather').addEventListener('click', () => { switchWeather(state.layer); notify('已重新请求 Windy 图层；加载速度取决于外部网络。'); });
  $('#print-button').addEventListener('click', () => window.print());
}

function setMapMode(mode) {
  state.mapMode = mode;
  $('#schematic').hidden = mode !== 'route';
  $('#official-map').hidden = mode !== 'official';
  $('#map-mode').textContent = mode === 'route' ? '查看官方原图 ↗' : '返回互动示意图 ↩';
  if (mode === 'official' && !$('#official-image').getAttribute('src')) {
    if (guide.map.officialImage) $('#official-image').src = guide.map.officialImage;
    else {
      $('#official-image').hidden = true;
      $('#map-image-error').textContent = '官网原图当前无法直接加载，请通过上方链接查看官方导览页；互动示意图仍可正常使用。';
      $('#map-image-error').hidden = false;
    }
  }
}

$('#share-button').addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(location.href.split('#')[0]);
    notify('链接已复制；分享给队友前，请确保网址可从他们的设备访问。');
  } catch { notify('浏览器暂不支持复制，请复制地址栏的网址分享。'); }
});

async function boot() {
  try { guide = await getJSON('/api/guide'); render(); }
  catch {
    $('#main').innerHTML = '<div class="error-box"><h1>攻略暂时没有加载出来</h1><p>请检查服务是否运行，稍后再试。</p><button class="button" id="retry">重新加载</button></div>';
    $('#retry').addEventListener('click', boot, { once: true });
  }
}
boot();
