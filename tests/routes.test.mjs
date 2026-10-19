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
  assert.equal(morning.find(leg => leg.id === 'wuhua-pearl').options[0].mode, 'walk');
  assert.equal(morning.find(leg => leg.id === 'pearl-mirror').to, 'mirror-parking');
  assert.ok(guide.routing.places.find(place => place.id === 'nuorilang-center').note.includes('不是同一个点'));
});

test('Tuesday defaults to buses while walking alternatives carry deadline warning', async () => {
  const guide = await loadGuide(guideFile);
  const morning = guide.routing.routes.find(route => route.id === 'shuzheng-morning');
  const choice = morning.legs[1];
  assert.equal(choice.options[choice.recommended].mode, 'bus');
  assert.deepEqual(choice.options.find(option => option.mode === 'walk').via, ['tiger']);
  const exit = guide.routing.routes.find(route => route.id === 'tuesday-exit').legs[0];
  assert.equal(exit.options[exit.recommended].mode, 'bus');
  assert.ok(exit.options.find(option => option.mode === 'mixed').warning.includes('14:00'));
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
