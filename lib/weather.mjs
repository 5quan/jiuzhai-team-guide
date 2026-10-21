// 逐小时天气：用 Open-Meteo 的免费接口，不需要额外的 Key。
// 只取"现在"和"接下来两小时"，给主页一条短提示用。

const CODES = new Map([
  [0, '晴'], [1, '晴'], [2, '多云'], [3, '阴'],
  [45, '雾'], [48, '雾'],
  [51, '小雨'], [53, '小雨'], [55, '小雨'],
  [56, '冻雨'], [57, '冻雨'],
  [61, '雨'], [63, '雨'], [65, '大雨'],
  [66, '冻雨'], [67, '冻雨'],
  [71, '雪'], [73, '雪'], [75, '大雪'], [77, '雪粒'],
  [80, '阵雨'], [81, '阵雨'], [82, '强阵雨'],
  [85, '阵雪'], [86, '阵雪'],
  [95, '雷雨'], [96, '雷雨'], [99, '雷雨']
]);

export const weatherText = code => CODES.get(Number(code)) || '—';

const round = value => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);

export async function fetchWeatherNow({ fetchImpl = fetch, lat, lon, timeZone = 'Asia/Shanghai', signal } = {}) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) throw new Error('缺少坐标');
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current', 'temperature_2m,weather_code');
  url.searchParams.set('hourly', 'temperature_2m,weather_code');
  url.searchParams.set('timezone', timeZone);
  url.searchParams.set('forecast_days', '2');

  const response = await fetchImpl(url.toString(), {
    redirect: 'error',
    signal: signal || AbortSignal.timeout(8000)
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`weather ${response.status}`); }

  let data;
  try { data = await response.json(); } catch { throw new Error('weather invalid'); }
  const current = data?.current;
  if (!current || round(current.temperature_2m) === null) throw new Error('weather empty');

  const times = Array.isArray(data.hourly?.time) ? data.hourly.time : [];
  const codes = Array.isArray(data.hourly?.weather_code) ? data.hourly.weather_code : [];
  const temps = Array.isArray(data.hourly?.temperature_2m) ? data.hourly.temperature_2m : [];
  const stamp = typeof current.time === 'string' ? `${current.time.slice(0, 13)}:00` : '';
  const index = times.indexOf(stamp);

  const next = [];
  for (let step = 1; step <= 2 && index >= 0; step++) {
    const position = index + step;
    if (position >= times.length) break;
    next.push({
      time: times[position].slice(11, 16),
      temp: round(temps[position]),
      code: Number(codes[position]),
      text: weatherText(codes[position])
    });
  }

  return {
    now: { temp: round(current.temperature_2m), code: Number(current.weather_code), text: weatherText(current.weather_code) },
    next,
    updatedAt: current.time || ''
  };
}
