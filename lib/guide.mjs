import { readFile } from 'node:fs/promises';

const allowedLayers = new Set(['clouds', 'rain', 'temp', 'wind']);

export function weatherLinks(weather, layer = 'clouds') {
  if (!allowedLayers.has(layer)) throw new Error('Unsupported weather layer');
  const { lat, lon, zoom = 11 } = weather;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error('Invalid weather coordinates');
  }
  const params = new URLSearchParams({
    type: 'map', location: 'coordinates', lat: String(lat), lon: String(lon),
    detailLat: String(lat), detailLon: String(lon), zoom: String(zoom),
    level: 'surface', overlay: layer, product: 'ecmwf',
    metricTemp: '°C', metricRain: 'mm', metricWind: 'km/h', marker: 'true', detail: 'true'
  });
  return {
    layer,
    provider: 'Windy 官方嵌入',
    embedUrl: `https://embed.windy.com/embed.html?${params}`,
    fullUrl: `https://www.windy.com/${lat}/${lon}?${layer},${lat},${lon},${zoom}`,
    lat, lon,
    note: '区域天气参考；实时数据由 Windy 提供，本网站不生成或缓存晴雨预报。'
  };
}

export function validateGuide(guide) {
  if (!Number.isInteger(guide.trip?.people) || guide.trip.people < 1) throw new Error('Invalid team size');
  if (!Array.isArray(guide.days) || guide.days.length !== 4) throw new Error('Four itinerary days are required');
  const ids = guide.spots?.map(spot => spot.id) ?? [];
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Spot identifiers must be unique');
  for (const spot of guide.spots) {
    if (!spot.name || ![1, 2].includes(spot.day) || !Array.isArray(spot.position) || spot.position.length !== 2 || spot.position.some(n => !Number.isFinite(n))) {
      throw new Error(`Invalid spot: ${spot.id}`);
    }
  }
  for (const day of guide.days) {
    if (!Array.isArray(day.events) || !Array.isArray(day.spotIds) || day.spotIds.some(id => !ids.includes(id))) throw new Error(`Invalid day: ${day.id}`);
  }
  for (const source of guide.sources) {
    if (new URL(source.url).protocol !== 'https:') throw new Error('Sources must use HTTPS');
  }
  weatherLinks(guide.weather);
  if (guide.ticket.entrance < 0 || guide.ticket.bus < 0) throw new Error('Invalid ticket prices');
  return guide;
}

export async function loadGuide(file) {
  return validateGuide(JSON.parse(await readFile(file, 'utf8')));
}

export function publicGuide(guide) {
  const perDay = guide.ticket.entrance + guide.ticket.bus;
  return {
    ...guide,
    costs: {
      perDay,
      perPersonTwoDays: perDay * 2,
      teamTwoDays: perDay * 2 * guide.trip.people,
      hotelTeamNight: guide.trip.people * guide.trip.hotelBudgetPerPersonNight,
      hotelTeamTwoNights: guide.trip.people * guide.trip.hotelBudgetPerPersonNight * 2
    },
    weather: { ...guide.weather, ...weatherLinks(guide.weather) }
  };
}
