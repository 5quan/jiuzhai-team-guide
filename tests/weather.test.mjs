import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWeatherNow, weatherText } from '../lib/weather.mjs';

const sample = {
  current: { time: '2026-10-21T15:30', temperature_2m: 8.4, weather_code: 2 },
  hourly: {
    time: ['2026-10-21T15:00', '2026-10-21T16:00', '2026-10-21T17:00', '2026-10-21T18:00'],
    weather_code: [2, 3, 61, 0],
    temperature_2m: [8.4, 9.1, 9.6, 10.2]
  }
};

test('weather codes are translated to short Chinese labels', () => {
  assert.equal(weatherText(0), '晴');
  assert.equal(weatherText(2), '多云');
  assert.equal(weatherText(3), '阴');
  assert.equal(weatherText(61), '雨');
  assert.equal(weatherText(71), '雪');
  assert.equal(weatherText(95), '雷雨');
  assert.equal(weatherText(999), '—');
});

test('now and the next two hours are returned with rounded temperatures', async () => {
  const data = await fetchWeatherNow({
    lat: 33.2, lon: 103.9,
    fetchImpl: async url => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('timezone'), 'Asia/Shanghai');
      assert.equal(parsed.searchParams.get('latitude'), '33.2');
      return Response.json(sample);
    }
  });
  assert.deepEqual(data.now, { temp: 8, code: 2, text: '多云' });
  assert.deepEqual(data.next.map(item => [item.time, item.text, item.temp]), [
    ['16:00', '阴', 9],
    ['17:00', '雨', 10]
  ]);
});

test('a failed or malformed upstream throws so the route can answer 503', async () => {
  await assert.rejects(() => fetchWeatherNow({ lat: 1, lon: 2, fetchImpl: async () => new Response('nope', { status: 500 }) }), /weather 500/);
  await assert.rejects(() => fetchWeatherNow({ lat: 1, lon: 2, fetchImpl: async () => new Response('not json') }), /weather invalid/);
  await assert.rejects(() => fetchWeatherNow({ lat: 1, lon: 2, fetchImpl: async () => Response.json({}) }), /weather empty/);
  await assert.rejects(() => fetchWeatherNow({ fetchImpl: async () => Response.json(sample) }), /缺少坐标/);
});

test('missing hourly data still returns current conditions', async () => {
  const data = await fetchWeatherNow({
    lat: 1, lon: 2,
    fetchImpl: async () => Response.json({ current: { time: '2026-10-21T15:30', temperature_2m: 3, weather_code: 0 } })
  });
  assert.deepEqual(data.next, []);
  assert.equal(data.now.text, '晴');
});
