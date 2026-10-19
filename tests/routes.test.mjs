import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGuide, validateGuide } from '../lib/guide.mjs';

const guideFile = new URL('../data/guide.json', import.meta.url);

test('all 18 itinerary times reference valid routes and transport legs', async () => {
  const guide = await loadGuide(guideFile);
  const routes = new Map(guide.routing.routes.map(route => [route.id, route]));
  const events = guide.days.flatMap(day => day.events);
  assert.equal(events.length, 18);
  assert.ok(events.every(event => routes.has(event.routeId)));
  assert.equal(routes.get('hotel-stay').locations[0], 'jiuzhai-hotel');
  assert.equal(routes.get('return-shuttle').legs[0].to, 'huanglong-station');
});

test('reference-image walking sections and transfer regions stay distinct', async () => {
  const guide = await loadGuide(guideFile);
  const routes = new Map(guide.routing.routes.map(route => [route.id, route]));
  const afternoon = routes.get('zechawa-afternoon').legs;
  assert.equal(afternoon[0].from, 'nuorilang-center');
  assert.equal(afternoon[0].options[0].mode, 'bus');
  assert.deepEqual(afternoon.find(leg => leg.id === 'changhai-pool').options.map(option => option.mode), ['walk']);
  const morning = routes.get('rize-morning').legs;
  assert.equal(morning.find(leg => leg.id === 'wuhua-peacock').options[0].mode, 'walk');
  assert.equal(morning.find(leg => leg.id === 'wuhua-peacock').to, 'peacock');
  assert.equal(morning.find(leg => leg.id === 'peacock-shoal').to, 'pearl-shoal');
  assert.equal(morning.find(leg => leg.id === 'shoal-waterfall').to, 'pearl');
  assert.equal(morning.find(leg => leg.id === 'pearl-mirror').to, 'mirror-parking');
  assert.ok(guide.routing.places.find(place => place.id === 'nuorilang-center').note.includes('不是同一个点'));
});

test('Tuesday defaults to buses while walking alternatives carry deadline warning', async () => {
  const guide = await loadGuide(guideFile);
  const morning = guide.routing.routes.find(route => route.id === 'shuzheng-morning');
  const choice = morning.legs[1];
  assert.equal(choice.options[choice.recommended].mode, 'bus');
  assert.deepEqual(choice.options.find(option => option.mode === 'walk').via, ['tiger', 'shuzheng-waterfall']);
  const exit = guide.routing.routes.find(route => route.id === 'tuesday-exit').legs[0];
  assert.equal(exit.options[exit.recommended].mode, 'bus');
  assert.ok(exit.options.find(option => option.mode === 'mixed').warning.includes('14:00'));
});

test('both reference images are covered by 32 scenic details and five distinct facilities', async () => {
  const guide = await loadGuide(guideFile);
  assert.equal(guide.spots.length, 32);
  const facilities = guide.routing.places.filter(place => place.scope === 'park');
  assert.equal(facilities.length, 5);
  assert.equal(guide.map.referencePoints.length, 37);
  const names = new Set([...guide.spots, ...facilities].map(point => point.name));
  for (const name of ['孔雀河道', '珍珠滩', '珍珠滩瀑布', '镜海停车场', '诺日朗中心站', '诺日朗群海', '诺日朗瀑布', '诺日朗观景台', '树正寨', '树正群海', '树正群海观景台', '树正瀑布', '犀牛海观景台', '双龙海', '双龙海瀑布', '独臂老人柏', '长海临湖栈道', '五彩池临湖栈道', '箭竹海临湖栈道', '树正内侧栈道', '上季节海', '下季节海']) assert.ok(names.has(name), `Missing reference point: ${name}`);
  assert.notDeepEqual(facilities.find(point => point.id === 'nuorilang-center').position, guide.spots.find(point => point.id === 'nuorilang').position);
  assert.notDeepEqual(facilities.find(point => point.id === 'mirror-parking').position, guide.spots.find(point => point.id === 'mirror').position);
});

test('optional previews do not expand the fixed itinerary and map references are validated', async () => {
  const guide = await loadGuide(guideFile);
  assert.equal(guide.days.flatMap(day => day.events).length, 18);
  assert.ok(guide.days[2].events.some(event => event.time === '14:00'));
  for (const id of ['changhai-cypress', 'nuorilang-view', 'shuzheng-village', 'double-falls']) {
    assert.equal(guide.spots.find(spot => spot.id === id).optional, true);
    assert.ok(!guide.days.some(day => day.spotIds.includes(id)));
  }
  for (const mutation of [copy => copy.map.referencePoints.push('missing'), copy => { copy.spots[0].position[0] = copy.map.canvas.width + 1; }, copy => { copy.spots[0].parentId = 'missing'; }, copy => copy.routing.routes[0].optionalLocations = ['missing']]) {
    const copy = structuredClone(guide);
    mutation(copy);
    assert.throws(() => validateGuide(copy));
  }
});

test('bad event bindings, transport references and fabricated outside pins are rejected', async () => {
  const original = await loadGuide(guideFile);
  const mutations = [
    guide => { guide.days[1].events[0].routeId = 'missing'; },
    guide => { guide.routing.routes[1].legs[0].to = 'missing'; },
    guide => { guide.routing.routes[1].legs[0].recommended = 8; },
    guide => { guide.routing.routes[1].legs[0].options[0].via = ['missing']; },
    guide => { guide.routing.places[0].position = [330, 100]; },
    guide => { const place = guide.routing.places.find(item => item.scope === 'park'); place.anchorSpotId = 'missing'; },
    guide => { guide.routing.sourceIds.push('missing'); }
  ];
  for (const mutate of mutations) {
    const guide = structuredClone(original);
    mutate(guide);
    assert.throws(() => validateGuide(guide));
  }
});
