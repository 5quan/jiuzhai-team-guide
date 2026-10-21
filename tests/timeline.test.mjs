import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/timeline.js', import.meta.url), 'utf8');
const timelineStops = runInNewContext(`${source}\ntimelineStops`);
const guide = JSON.parse(await readFile(new URL('../data/guide.json', import.meta.url), 'utf8'));
const days = guide.days.filter(day => day.startTime);
const pointFor = step => ({ 'd1-peacock': 'peacock', 'd1-pearl': 'pearl', 'd2-inner': 'shuzheng-inner' }[step.id] || (['visit', 'rest'].includes(step.mode) ? step.spotIds[0] : step.to || step.spotIds.at(-1)));
const build = steps => Array.from(timelineStops(steps, pointFor));

test('arrival and the following visit share one place node, retaining both actions', () => {
  const steps = days[0].events.filter(step => step.duration);
  const nodes = build(steps);
  assert.equal(nodes[0].spotId, 'forest');
  assert.equal(nodes[0].step.id, 'd1-forest');
  assert.deepEqual(Array.from(nodes[0].steps, step => step.id), ['d1-entry', 'd1-forest']);
  assert.equal(nodes[1].step.id, 'd1-wuhua');
  assert.deepEqual(Array.from(nodes[1].steps, step => step.id), ['d1-wuhua-bus', 'd1-wuhua']);
  assert.equal(nodes[2].step.id, 'd1-peacock');
  assert.equal(nodes[3].step.id, 'd1-pearl');
});

test('grouping preserves every original action exactly once and leaves duration totals unchanged', () => {
  for (const [index, day] of days.entries()) {
    const steps = day.events.filter(step => step.duration);
    const before = JSON.stringify(steps);
    const grouped = build(steps).flatMap(node => Array.from(node.steps));
    assert.deepEqual(grouped.map(step => step.id), steps.map(step => step.id));
    assert.equal(new Set(grouped.map(step => step.id)).size, steps.length);
    assert.equal(grouped.reduce((sum, step) => sum + step.duration, 0), [492, 367][index]);
    assert.equal(JSON.stringify(steps), before);
  }
});

test('lunch shares the arrival point while separate later returns and the exit stay accessible', () => {
  const steps = days[1].events.filter(step => step.duration);
  const nodes = build(steps);
  const lunch = nodes.find(node => node.step.id === 'd2-lunch');
  assert.equal(lunch.spotId, 'nuorilang-center');
  assert.deepEqual(Array.from(lunch.steps, step => step.id), ['d2-center', 'd2-lunch']);
  assert.ok(nodes.some(node => node.step.id === 'd2-center-return'));
  assert.equal(nodes.at(-1).step.id, 'd2-exit');
});

test('walk-through sightseeing keeps its travel duration once, without adding a fictitious stop', () => {
  const steps = days[0].events.filter(step => step.duration);
  const node = build(steps).find(item => item.step.id === 'd1-peacock');
  assert.equal(node.step.mode, 'walk');
  assert.equal(node.steps.length, 1);
  assert.equal(node.steps[0].duration, 20);
});

test('an arrival and a visit to its boardwalk use one node rather than duplicate the same place', () => {
  const arrival = { id: 'walk', mode: 'walk', duration: 20, to: 'pool', spotIds: ['lake', 'pool'] };
  const visit = { id: 'visit', mode: 'visit', duration: 10, to: 'pool-boardwalk', spotIds: ['pool', 'pool-boardwalk'] };
  const nodes = timelineStops([arrival, visit], step => step.to);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].step.id, 'visit');
  assert.deepEqual(Array.from(nodes[0].steps, step => step.id), ['walk', 'visit']);
});

test('one-day grouping preserves all actions and the 40-minute lunch at the center', () => {
  const steps = guide.referenceDays[0].events;
  const nodes = build(steps);
  const grouped = nodes.flatMap(node => Array.from(node.steps));
  assert.deepEqual(grouped.map(step => step.id), steps.map(step => step.id));
  assert.equal(grouped.reduce((sum, step) => sum + step.duration, 0), 477);
  assert.deepEqual(Array.from(nodes.find(node => node.step.id === 's1-lunch').steps, step => step.id), ['s1-center', 's1-lunch']);
  assert.equal(nodes[0].step.id, 's1-changhai');
  assert.equal(nodes.at(-1).step.id, 's1-exit');
});
