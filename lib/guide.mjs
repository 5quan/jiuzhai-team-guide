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
  const canvas = guide.map.canvas;
  if (canvas && (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width < 1 || canvas.height < 1)) throw new Error('Invalid map canvas');
  const mapped = [...guide.spots, ...(guide.routing?.places || []).filter(place => place.scope === 'park')];
  for (const item of mapped) {
    if (item.parentId && !ids.includes(item.parentId)) throw new Error('Unknown map parent');
    if (item.optional !== undefined && typeof item.optional !== 'boolean') throw new Error('Invalid optional marker');
    if (item.kind && !['spot', 'walk', 'viewpoint', 'facility', 'passby'].includes(item.kind)) throw new Error('Invalid map marker kind');
    if (item.labelSide && !['left', 'right'].includes(item.labelSide)) throw new Error('Invalid label side');
    if (canvas && item.position && item.position.some((coordinate, index) => coordinate < 0 || coordinate > (index ? canvas.height : canvas.width))) throw new Error('Marker outside map canvas');
  }
  if (guide.map.referencePoints && (!Array.isArray(guide.map.referencePoints) || new Set(guide.map.referencePoints).size !== guide.map.referencePoints.length || guide.map.referencePoints.some(id => !mapped.some(item => item.id === id)))) throw new Error('Unknown reference map point');
  validateRouting(guide);
  weatherLinks(guide.weather);
  if (guide.ticket.entrance < 0 || guide.ticket.bus < 0) throw new Error('Invalid ticket prices');
  return guide;
}

export function validateRouting(guide) {
  const routing = guide.routing;
  if (!routing) {
    if (guide.days.some(day => day.events.some(event => event.routeId))) throw new Error('Route data is required for linked events');
    return;
  }
  if (!Array.isArray(routing.places) || !Array.isArray(routing.routes)) throw new Error('Invalid route data');
  const spots = new Set(guide.spots.map(spot => spot.id));
  const locations = new Set(spots);
  for (const place of routing.places) {
    if (!place.id || !place.name || locations.has(place.id) || !['park', 'outside'].includes(place.scope)) throw new Error('Invalid route place');
    if (place.scope === 'outside' && (place.position || place.anchorSpotId)) throw new Error('Outside places must not use park coordinates');
    if (place.scope === 'park') {
      const valid = place.anchorSpotId !== undefined ? spots.has(place.anchorSpotId) : Array.isArray(place.position) && place.position.length === 2 && place.position.every(Number.isFinite);
      if (!valid) throw new Error('Invalid park place marker');
    }
    locations.add(place.id);
  }
  const sources = new Set(guide.sources.map(source => source.id));
  if (!Array.isArray(routing.sourceIds) || routing.sourceIds.some(id => !sources.has(id))) throw new Error('Unknown routing source');
  const routes = new Set();
  const modes = new Set(['bus', 'walk', 'mixed', 'shuttle', 'rail', 'flight', 'pending']);
  for (const route of routing.routes) {
    if (!route.id || routes.has(route.id) || !Array.isArray(route.locations) || route.locations.some(id => !locations.has(id)) || !Array.isArray(route.legs) || (!route.locations.length && !route.legs.length)) throw new Error('Invalid route');
    routes.add(route.id);
    if (route.optionalLocations && (!Array.isArray(route.optionalLocations) || route.optionalLocations.some(id => !locations.has(id)))) throw new Error('Unknown optional route location');
    const legs = new Set();
    for (const [index, leg] of route.legs.entries()) {
      if (!leg.id || legs.has(leg.id) || !locations.has(leg.from) || !locations.has(leg.to) || (index > 0 && route.legs[index - 1].to !== leg.from)) throw new Error('Invalid route leg');
      legs.add(leg.id);
      if (!Array.isArray(leg.options) || !leg.options.length || !Number.isInteger(leg.recommended) || !leg.options[leg.recommended]) throw new Error('Invalid transport recommendation');
      for (const option of leg.options) {
        if (!modes.has(option.mode) || !option.label || !option.note || (option.via && (!Array.isArray(option.via) || option.via.some(id => !locations.has(id))))) throw new Error('Invalid transport option');
      }
    }
  }
  for (const day of guide.days) {
    if (day.events.some(event => !routes.has(event.routeId))) throw new Error('Unknown event route');
  }
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
