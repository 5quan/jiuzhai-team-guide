import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuide, validateGuide } from '../lib/guide.mjs';

const guide = await loadGuide(new URL('../data/guide.json', import.meta.url));
const single = guide.referenceDays[0];

test('one-day reference is undated and independent from the two dated park days', () => {
  assert.deepEqual(guide.plans.map(plan => [plan.id, plan.dayIds]), [['two-days', ['day1', 'day2']], ['one-day', ['essence']]]);
  assert.equal(single.label, '一天精华游');
  assert.equal(single.date, undefined);
  assert.equal(single.startTime, '10:00');
  assert.ok(!single.spotIds.includes('forest'));
  assert.ok(guide.days[1].spotIds.includes('forest'));
});

test('one-day timings match all 22 screenshot rows plus lunch, without extra waiting', () => {
  assert.deepEqual(single.events.map(event => [event.duration, event.mode]), [
    [40,'bus'],[30,'visit'],[20,'walk'],[10,'visit'],[10,'walk'],[30,'mixed'],[40,'rest'],
    [5,'bus'],[30,'visit'],[8,'bus'],[25,'visit'],[15,'walk'],[10,'bus'],[15,'walk'],
    [30,'visit'],[15,'walk'],[10,'bus'],[15,'visit'],[8,'bus'],[25,'visit'],[60,'walk'],[10,'visit'],[16,'bus']
  ]);
  const lunch = single.events.findIndex(event => event.mode === 'rest');
  assert.equal(single.events[lunch - 1].to, 'nuorilang-center');
  assert.equal(single.events[lunch].time, '12:20—13:00');
  assert.equal(single.events[lunch + 1].to, 'wuhuahai');
  let time = 600;
  const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  for (const event of single.events) {
    const start = time;
    time += event.duration;
    assert.equal(event.time, `${clock(start)}—${clock(time)}`);
  }
  assert.equal(time, 1077);
  assert.equal(time - 600, 477);
  assert.match(single.note, /镜海默认车览/);
  assert.match(single.note, /15分钟/);
  assert.ok(!single.events.some(event => event.spotIds.includes('mirror') && event.mode === 'visit'));
});

test('one-day events have independent valid routes with matching transport endpoints', () => {
  const routes = new Map(guide.routing.routes.map(route => [route.id, route]));
  const twoDayIds = new Set(guide.days.flatMap(day => day.events).map(event => event.id));
  for (const event of single.events) {
    assert.ok(!twoDayIds.has(event.id));
    const route = routes.get(event.routeId);
    assert.ok(route);
    if (['visit', 'rest'].includes(event.mode)) continue;
    assert.equal(route.legs[0].from, event.from);
    assert.equal(route.legs[0].to, event.to);
    assert.equal(route.legs[0].options[0].mode, event.mode);
    assert.deepEqual(route.legs[0].options[0].via, event.via);
  }
});

test('invalid plan references, duplicate event ids and dated reference days are rejected', () => {
  const mutations = [
    copy => { copy.plans[1].dayIds = ['missing']; },
    copy => { copy.plans[1].dayIds = ['essence', 'essence']; },
    copy => { copy.plans[1].id = copy.plans[0].id; },
    copy => { copy.referenceDays[0].date = '2026-10-30'; },
    copy => { copy.referenceDays[0].id = 'day1'; },
    copy => { copy.referenceDays[0].events[0].id = copy.days[1].events[1].id; },
    copy => { copy.referenceDays[0].events[0].routeId = 'missing'; },
    copy => { copy.referenceDays[0].events[0].spotIds = ['missing']; }
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(guide);
    mutate(copy);
    assert.throws(() => validateGuide(copy));
  }
});
