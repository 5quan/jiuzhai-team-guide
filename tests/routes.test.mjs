import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGuide, validateGuide } from '../lib/guide.mjs';

const guideFile = new URL('../data/guide.json', import.meta.url);

test('every arrival, park and hotel event references a valid route', async () => {
  const guide = await loadGuide(guideFile);
  const routes = new Map(guide.routing.routes.map(route => [route.id, route]));
  assert.ok(guide.days.flatMap(day => day.events).every(event => routes.has(event.routeId)));
  assert.equal(routes.get('arrival-rail').legs[0].from, 'arrival-station');
  assert.equal(routes.get('station-hotel-transfer').legs.at(-1).to, 'station-hotel');
  assert.equal(routes.get('hotel-stay').locations[0], 'jiuzhai-hotel');
});

test('both park days preserve every reference-image duration and transport mode in order', async () => {
  const guide = await loadGuide(guideFile);
  const expected = [
    [[30,'bus'],[60,'visit'],[20,'walk'],[25,'visit'],[15,'walk'],[10,'visit'],[8,'bus'],[40,'rest'],[15,'walk'],[30,'visit'],[15,'walk'],[10,'bus'],[15,'visit'],[8,'bus'],[45,'visit'],[8,'bus'],[3,'walk'],[10,'visit'],[15,'bus']],
    [[40,'bus'],[30,'visit'],[20,'walk'],[10,'visit'],[10,'walk'],[30,'mixed'],[40,'rest'],[25,'bus'],[50,'visit'],[20,'bus'],[40,'visit'],[8,'bus'],[10,'visit'],[20,'bus'],[8,'bus'],[60,'walk'],[16,'bus']]
  ];
  for (const [index,day] of guide.days.slice(1).entries()) {
    const steps = day.events.filter(event => event.duration);
    assert.deepEqual(steps.map(event => [event.duration,event.mode]), expected[index]);
    assert.equal(steps.filter(event => event.mode === 'rest').length,1);
    assert.equal(steps.find(event => event.mode === 'rest').duration,40);
    assert.equal(day.startTime,'10:00');
    let minute=600;
    const clock=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
    for(const step of steps){const start=minute;minute+=step.duration;assert.equal(step.time,`${clock(start)}—${clock(minute)}`);}
    assert.equal(minute,index===0?982:1037);
  }
});

test('day one rides to Spark Lake and day two walks the inner boardwalk for 60 minutes', async () => {
  const guide = await loadGuide(guideFile);
  const first = guide.days[1].events;
  const second = guide.days[2].events;
  const ride = first.find(event => event.id === 'd1-spark-bus');
  assert.equal(ride.mode,'bus'); assert.equal(ride.duration,8);
  const walk = second.find(event => event.id === 'd2-inner');
  assert.equal(walk.mode,'walk'); assert.equal(walk.duration,60);
  assert.deepEqual(walk.spotIds,['shuzheng','shuzheng-inner','spark']);
  assert.ok(!first.some(event => event.mode==='walk' && event.spotIds.includes('shuzheng-inner')));
  assert.ok(second.indexOf(walk)>second.findIndex(event => event.id==='d2-panda'));
  assert.ok(second.indexOf(walk)<second.findIndex(event => event.id==='d2-exit'));
  assert.equal(guide.spots.find(spot=>spot.id==='shuzheng-inner').optional,false);
});

test('forest, Arrow Bamboo Lake and reference observation stops are scheduled rather than optional', async () => {
  const guide = await loadGuide(guideFile);
  const events = guide.days[2].events;
  assert.equal(events.find(event=>event.id==='d2-forest').duration,50);
  assert.equal(events.find(event=>event.id==='d2-arrow').duration,40);
  for(const id of ['forest','jianzhu-boardwalk','changhai-cypress','nuorilang-view','shuzheng-village','double-falls']) {
    assert.equal(guide.spots.find(spot=>spot.id===id).optional,false);
    assert.ok(guide.days.some(day=>day.spotIds.includes(id)));
  }
  const center=guide.routing.places.find(place=>place.id==='nuorilang-center');
  assert.notDeepEqual(center.position,guide.spots.find(spot=>spot.id==='nuorilang').position);
  const parking=guide.routing.places.find(place=>place.id==='mirror-parking');
  assert.notDeepEqual(parking.position,guide.spots.find(spot=>spot.id==='mirror').position);
});

test('panoramic map preserves 37 separate reference points and all lake outlines', async () => {
  const guide = await loadGuide(guideFile);
  assert.equal(guide.spots.length,32);
  assert.equal(guide.routing.places.filter(place=>place.scope==='park').length,5);
  assert.equal(guide.map.referencePoints.length,37);
  assert.ok(guide.map.canvas.width>guide.map.canvas.height);
  const water=new Map(guide.map.water.map(lake=>[lake.id,lake]));
  for(const id of ['changhai','wucaichi','jianzhuhai','panda','wuhuahai','mirror','rhino','tiger','shuzheng','spark','double-lake','reed']) assert.ok(water.has(id),`Missing lake: ${id}`);
  assert.equal(water.get('upper-seasonal').seasonal,true);
  assert.equal(water.get('lower-seasonal').seasonal,true);
  const position=id=>guide.spots.find(spot=>spot.id===id).position;
  assert.ok(position('changhai')[0]<position('forest')[0]);
  assert.ok(position('changhai')[1]<position('wucaichi')[1]);
  assert.ok(position('jianzhuhai')[1]<position('panda')[1]);
  assert.ok(position('rhino')[1]<position('shuzheng')[1]);
});

test('invalid timings, scenic references, geometry and route bindings are rejected', async () => {
  const original=await loadGuide(guideFile);
  const mutations=[
    copy=>{copy.days[1].events[1].duration=0;},
    copy=>{copy.days[1].events[1].duration=2.5;},
    copy=>{copy.days[1].events[1].mode='flying';},
    copy=>{copy.days[1].events[1].spotIds=['missing'];},
    copy=>{copy.days[1].events[2].id=copy.days[1].events[1].id;},
    copy=>{copy.days[1].startTime='29:00';},
    copy=>{copy.days[1].events[0].routeId='missing';},
    copy=>{copy.map.referencePoints.push('missing');},
    copy=>{copy.spots[0].position[0]=copy.map.canvas.width+1;},
    copy=>{copy.map.water[0].id='missing';},
    copy=>{copy.map.paths[0].d='';},
    copy=>{copy.routing.places[0].position=[200,200];},
    copy=>{copy.routing.routes[0].legs[0].to='missing';}
  ];
  for(const mutation of mutations){const guide=structuredClone(original);mutation(guide);assert.throws(()=>validateGuide(guide));}
});
