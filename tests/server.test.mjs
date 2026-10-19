import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';
import { loadGuide, publicGuide, validateGuide, weatherLinks } from '../lib/guide.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let origin;
const guideFile = fileURLToPath(new URL('../data/guide.json', import.meta.url));

before(async () => {
  server = createServer({ guideFile });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

test('itinerary keeps the confirmed dates, 7 travellers and Tuesday departure distinct from train time', async () => {
  const response = await fetch(`${origin}/api/guide`);
  assert.equal(response.status, 200);
  const guide = await response.json();
  assert.equal(guide.trip.people, 7);
  assert.deepEqual(guide.days.map(day => day.date), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  assert.ok(guide.days[2].events.some(event => event.time === '14:00' && event.title.includes('沟口')));
  assert.ok(guide.days[3].events.some(event => event.time === '06:35'));
  assert.equal(guide.costs.teamTwoDays, 3920);
  assert.equal(guide.costs.perPersonTwoDays, 560);
  assert.equal(guide.costs.hotelTeamNight, 1400);
  assert.ok(guide.park.note.includes('9月28日'));
});

test('Windy links are first-party, use Celsius and Sichuan park coordinates, not Hunan', async () => {
  for (const layer of ['clouds', 'rain', 'temp', 'wind']) {
    const response = await fetch(`${origin}/api/weather?layer=${layer}`);
    assert.equal(response.status, 200);
    const weather = await response.json();
    const url = new URL(weather.embedUrl);
    assert.equal(url.origin, 'https://embed.windy.com');
    assert.equal(url.searchParams.get('lat'), '33.2');
    assert.equal(url.searchParams.get('lon'), '103.9');
    assert.equal(url.searchParams.get('metricTemp'), '°C');
    assert.equal(url.searchParams.get('overlay'), layer);
    assert.equal(weather.forecast, undefined);
  }
});

test('unknown weather layer is rejected rather than embedded', async () => {
  const response = await fetch(`${origin}/api/weather?layer=javascript:alert(1)`);
  assert.equal(response.status, 400);
  assert.throws(() => weatherLinks({ lat: 91, lon: 103.9 }));
});

test('every itinerary spot exists and has a stable unique identifier', async () => {
  const response = await fetch(`${origin}/api/spots`);
  const spots = await response.json();
  assert.equal(response.status, 200);
  assert.equal(new Set(spots.map(spot => spot.id)).size, spots.length);
  const guide = await loadGuide(guideFile);
  assert.ok(guide.days.every(day => day.spotIds.every(id => spots.some(spot => spot.id === id))));
  const malformed = structuredClone(guide);
  malformed.days[0].spotIds.push('nonexistent');
  assert.throws(() => validateGuide(malformed));
});

test('write endpoints are not exposed on a shared read-only website', async () => {
  const response = await fetch(`${origin}/api/guide`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('private configuration and traversal paths cannot be downloaded', async () => {
  for (const url of ['/data/guide.json', '/server.mjs', '/package.json', '/%2e%2e%5cdata%5cguide.json', '/%252e%252e%252fdata%252fguide.json']) {
    const response = await fetch(origin + url);
    assert.ok([400, 404].includes(response.status), `${url} returned ${response.status}`);
  }
});

test('assets, HEAD requests, CSP and conditional caching work', async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /九寨同行/);
  assert.match(response.headers.get('content-security-policy'), /frame-src https:\/\/embed.windy.com/);
  const etag = response.headers.get('etag');
  const cached = await fetch(origin, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);
  const head = await fetch(`${origin}/app.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.match(head.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${origin}/api/missing`)).status, 404);
});

test('changing the mounted data file updates the shared guide without rebuilding', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'jiuzhai-guide-test-'));
  const config = path.join(temporary, 'guide.json');
  const original = await loadGuide(guideFile);
  await writeFile(config, JSON.stringify(original));
  const changingServer = createServer({ guideFile: config, cacheTtlMs: 0 });
  await new Promise(resolve => changingServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${changingServer.address().port}`;
  try {
    const before = await fetch(`${base}/api/guide`);
    original.trip.hotel.name = '已选定的测试酒店';
    await writeFile(config, JSON.stringify(original));
    const after = await fetch(`${base}/api/guide`);
    assert.notEqual(before.headers.get('etag'), after.headers.get('etag'));
    assert.equal((await after.json()).trip.hotel.name, '已选定的测试酒店');
    assert.equal(publicGuide(original).costs.teamTwoDays, 3920);
  } finally {
    await new Promise(resolve => changingServer.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
