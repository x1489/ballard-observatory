// The 3D operational map: King County aerial photography (2025 by default, any survey back to 1936) draped on
// real terrain, 3D buildings from OpenStreetMap heights lit from the actual current sun position, a sky colored by
// the actual solar elevation, and live/analytic layers. Aircraft are drawn in 3D at their reported altitude (deck.gl).
import { esc, num, dateTime, ago } from './ui.js';
import { createAircraft } from '../live/layers/aircraft.js';
import { createBuses } from '../live/layers/buses.js';
import { loadTransit } from '../live/transit-data.js';
import { lookAt } from '../live/sun.js';
import { metersPerPixel } from '../live/geo.js';

export const CENTER = [-122.3847, 47.6687];
export const AERIAL_YEARS = [2025, 2023, 2021, 2019, 2017, 2015, 2013, 2012, 2009, 2007, 2005, 2002, 2000, 1998, 1936];
const aerialURL = (y) => `https://gismaps.kingcounty.gov/arcgis/rest/services/BaseMaps/KingCo_Aerial_${y}/MapServer/tile/{z}/{y}/{x}`;

// ------------------------------------------------------------ solar position (NOAA algorithm, ~0.5°)
export function sunPosition(t = Date.now(), lat = CENTER[1], lon = CENTER[0]) {
  const RAD = Math.PI / 180;
  const d = t / 86400000 + 2440587.5 - 2451545.0;
  const g = ((357.529 + 0.98560028 * d) % 360) * RAD;
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst + lon / 15) * 15) * RAD - ra;
  const la = lat * RAD;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  let az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha)) / RAD;
  return { elevation: el / RAD, azimuth: (az + 360) % 360 };
}

function skyFor(el) {
  // Colors approximating clear-sky appearance for the given solar elevation (degrees).
  if (el > 12) return { sky: '#6fa8dc', horizon: '#cfe3f3', fog: '#dfe9f2', intensity: 0.45, lightColor: '#ffffff' };
  if (el > 0) return { sky: '#5b8fc4', horizon: '#f1c9a0', fog: '#e8d6c6', intensity: 0.38, lightColor: '#ffe2c4' };
  if (el > -6) return { sky: '#2c4a78', horizon: '#d98e6b', fog: '#6b5f6e', intensity: 0.25, lightColor: '#ffb99a' };
  if (el > -12) return { sky: '#141f3a', horizon: '#3a3f63', fog: '#262b40', intensity: 0.15, lightColor: '#a8b8ff' };
  return { sky: '#070b16', horizon: '#141a2c', fog: '#0c1120', intensity: 0.1, lightColor: '#8fa2ff' };
}

export function createMap(container, { onPick, year = 2025 } = {}) {
  const maplibregl = window.maplibregl;
  const sun = sunPosition();
  const sk = skyFor(sun.elevation);
  const map = new maplibregl.Map({
    container,
    center: CENTER, zoom: 14.7, pitch: 52, bearing: -12, maxPitch: 78, hash: false, attributionControl: false,
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
    style: {
      version: 8,
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: {
        esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18,
          attribution: 'Regional imagery: Esri, Maxar, Earthstar Geographics' },
        aerial: { type: 'raster', tiles: [aerialURL(year)], tileSize: 256, minzoom: 8, maxzoom: 20, bounds: [-122.55, 47.08, -121.06, 47.80],
          attribution: 'Aerial imagery © EagleView Technologies, Inc. / King County' },
        dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 15, encoding: 'terrarium',
          attribution: 'Terrain: Mapzen Terrain Tiles (AWS Open Data)' },
        omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© OpenStreetMap contributors · OpenFreeMap' },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0b1016' } },
        { id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-fade-duration': 0 } },
        { id: 'aerial', type: 'raster', source: 'aerial', paint: { 'raster-fade-duration': 120 } },
        { id: 'buildings', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14,
          filter: ['!=', ['get', 'hide_3d'], true],
          paint: { 'fill-extrusion-color': '#d7dce2', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            // fade the massing as you zoom in, so street-level views show the real rooftops in the aerial photo
            'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.72, 16, 0.5, 17.5, 0.22, 19, 0.1], 'fill-extrusion-vertical-gradient': true } },
        { id: 'road-names', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14.5,
          layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-max-angle': 30 },
          paint: { 'text-color': '#f4f7fb', 'text-halo-color': 'rgba(10,14,19,.85)', 'text-halo-width': 1.4 } },
        { id: 'place-names', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter']]],
          layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 },
          paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10,14,19,.9)', 'text-halo-width': 1.6 } },
        { id: 'water-names', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
          layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 12 },
          paint: { 'text-color': '#cfe8ff', 'text-halo-color': 'rgba(10,14,19,.8)', 'text-halo-width': 1.2 } },
      ],
      terrain: { source: 'dem', exaggeration: 1.0 },
      light: { anchor: 'map', position: [1.5, sun.azimuth, Math.max(0, Math.min(88, 90 - sun.elevation))], color: sk.lightColor, intensity: sk.intensity },
      sky: { 'sky-color': sk.sky, 'horizon-color': sk.horizon, 'fog-color': sk.fog, 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.8 },
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  // Live 3D traffic: the same models, motion and lighting as the live app (public/live/layers): aircraft as 3D
  // models of their type at their real altitude, dead-reckoned between reports; King County Metro buses as 3D buses
  // following their routes. Rendered every animation frame through deck.gl, interleaved with the map.
  const D = window.deck;
  const lights = { ambient: new D.AmbientLight({ color: [255, 255, 255], intensity: 1 }), sun: new D.DirectionalLight({ color: [255, 255, 255], intensity: 1.5, direction: [-1, -1, -1] }) };
  const overlay = new D.MapboxOverlay({ interleaved: true, layers: [], effects: [new D.LightingEffect(lights)], pickingRadius: 6,
    onClick: (info) => {
      const o = info && info.object;
      if (!o || !onPick) return;
      if (o.kind === 'aircraft') onPick({ type: 'aircraft', data: o.o.rec });
      else if (o.kind === 'bus') onPick({ type: 'transit', data: { route: o.o.route ? o.o.route.short : '', headsign: o.o.info ? o.o.info.headsign : '', delay: Number.isFinite(o.o.rec.delay) ? (Math.abs(o.o.rec.delay) < 90 ? 'on time' : o.o.rec.delay > 0 ? `${Math.round(o.o.rec.delay / 60)} min late` : `${Math.round(-o.o.rec.delay / 60)} min early`) : null }, lngLat: { lng: o.pos[0], lat: o.pos[1] } });
    } });
  map.addControl(overlay);
  const live = { air: createAircraft(), buses: null, pendingBuses: null, show: { aircraft: true, transit: true }, elev: new Map(), look: lookAt(sunPosition().elevation) };
  loadTransit().then((t) => { live.buses = createBuses(t); if (live.pendingBuses) live.buses.ingest(live.pendingBuses); }).catch(() => {});
  function ground(lon, lat) {
    const k = `${Math.round(lon * 5000)}:${Math.round(lat * 5000)}`;
    if (live.elev.has(k)) return live.elev.get(k);
    let e = null;
    try { e = map.queryTerrainElevation([lon, lat]); } catch { e = null; }
    if (e == null || !Number.isFinite(e)) return 0;
    if (live.elev.size > 60000) live.elev.clear();
    live.elev.set(k, e);
    return e;
  }
  map.on('sourcedata', (e) => { if (e.sourceId === 'dem' && e.isSourceLoaded) live.elev.clear(); });
  function lighting() {
    const s = sunPosition(), L = lookAt(s.elevation), az = (s.azimuth * Math.PI) / 180, el = (Math.max(s.elevation, 3) * Math.PI) / 180;
    lights.sun.direction = [-Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), -Math.sin(el)];
    lights.sun.intensity = L.sunI; lights.ambient.intensity = L.amb;
    live.look = L;
    overlay.setProps({ effects: [new D.LightingEffect(lights)] });
  }
  lighting();
  const lightTimer = setInterval(lighting, 60_000);
  let raf = 0, lastTs = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || ts - lastTs < 1000 / 45) return;
    lastTs = ts;
    const zoom = map.getZoom(), center = map.getCenter(), sun = sunPosition();
    const ctx = { now: Date.now(), ts, zoom, center, pitch: map.getPitch(), bearing: map.getBearing(), mpp: metersPerPixel(zoom, center.lat), sun, look: live.look,
      night: live.look.night, glow: live.look.glow, ground, mobile: false, quality: 0 };
    const layers = [];
    try { if (live.show.transit && live.buses) layers.push(...live.buses.produce(ctx)); } catch (e) { console.error(e); }
    try { if (live.show.aircraft) layers.push(...live.air.produce(ctx)); } catch (e) { console.error(e); }
    overlay.setProps({ layers });
  }
  raf = requestAnimationFrame(frame);
  function setAircraft(list) { live.air.ingest({ aircraft: list }); }
  function setBuses(data) { if (live.buses) live.buses.ingest(data); else live.pendingBuses = data; }

  // GeoJSON overlay layers (draped on terrain)
  const LAYERS = {
    radar: { type: 'raster' },
    density: { type: 'geojson' }, hotspots: { type: 'geojson' }, development: { type: 'geojson' }, incidents: { type: 'geojson' },
    transit: { type: 'geojson' }, bridges: { type: 'geojson' }, cameras: { type: 'geojson' },
  };
  const ready = new Promise((resolve) => map.on('load', resolve));
  ready.then(() => {
    map.addSource('radar', { type: 'raster', tiles: ['https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png'], tileSize: 256,
      attribution: 'Radar: NEXRAD via Iowa Environmental Mesonet' });
    map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.55 }, layout: { visibility: 'none' } }, 'buildings');
    for (const id of ['density', 'hotspots', 'development', 'incidents', 'transit', 'bridges', 'cameras']) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'density', type: 'fill-extrusion', source: 'density', layout: { visibility: 'none' },
      paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'z'], 0, '#1d4877', 0.35, '#1b8a5a', 0.6, '#fbb021', 0.8, '#f68838', 1, '#ee3e32'],
        'fill-extrusion-height': ['*', ['get', 'z'], 260], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.72 } }, 'road-names');
    map.addLayer({ id: 'hotspots-fill', type: 'fill', source: 'hotspots', paint: { 'fill-color': '#f25555', 'fill-opacity': 0.18 } }, 'road-names');
    map.addLayer({ id: 'hotspots-line', type: 'line', source: 'hotspots', paint: { 'line-color': '#ff6b6b', 'line-width': 2, 'line-dasharray': [2, 1] } }, 'road-names');
    map.addLayer({ id: 'hotspots-label', type: 'symbol', source: 'hotspots',
      layout: { 'text-field': ['concat', ['get', 'label'], '\n', ['to-string', ['get', 'observed']], ' vs ', ['to-string', ['round', ['get', 'expected']]], ' expected'],
        'text-font': ['Noto Sans Bold'], 'text-size': 11.5 }, paint: { 'text-color': '#ffd5d5', 'text-halo-color': 'rgba(10,14,19,.9)', 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'development', type: 'circle', source: 'development', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'units'], 0], 0, 5, 50, 12, 300, 20], 'circle-color': ['match', ['get', 'stage'], 'review', '#a78bfa', '#3b9eff'],
        'circle-opacity': 0.85, 'circle-stroke-color': '#0b1016', 'circle-stroke-width': 1.5, 'circle-pitch-alignment': 'map' } });
    map.addLayer({ id: 'incidents', type: 'circle', source: 'incidents',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'age_h'], 0, 8, 24, 4], 'circle-color': ['match', ['get', 'cat'], 'medical', '#4aa3ff', 'fire', '#ff5a4f', 'collision', '#ffb020', 'police', '#b58cff', '#9aa7b4'],
        'circle-opacity': ['interpolate', ['linear'], ['get', 'age_h'], 0, 0.95, 24, 0.45], 'circle-stroke-color': ['case', ['get', 'active'], '#ffffff', '#0b1016'],
        'circle-stroke-width': ['case', ['get', 'active'], 2.5, 1], 'circle-pitch-alignment': 'map' } });
    map.addLayer({ id: 'transit', type: 'circle', source: 'transit',
      paint: { 'circle-radius': 7, 'circle-color': ['match', ['get', 'route'], 'D Line', '#e03c31', '#0f7fbf'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-pitch-alignment': 'map' } });
    map.addLayer({ id: 'transit-label', type: 'symbol', source: 'transit', minzoom: 14,
      layout: { 'text-field': ['get', 'route'], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-offset': [0, 1.3] },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10,14,19,.9)', 'text-halo-width': 1.4 } });
    map.addLayer({ id: 'bridges', type: 'circle', source: 'bridges',
      paint: { 'circle-radius': 9, 'circle-color': ['case', ['get', 'up'], '#f25555', '#2fbf71'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'bridges-label', type: 'symbol', source: 'bridges',
      layout: { 'text-field': ['concat', ['get', 'name'], ' Bridge · ', ['case', ['get', 'up'], 'OPEN TO BOATS', 'down']], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.5] },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10,14,19,.9)', 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'cameras', type: 'circle', source: 'cameras', layout: { visibility: 'none' },
      paint: { 'circle-radius': 6, 'circle-color': '#e6edf3', 'circle-stroke-color': '#0b1016', 'circle-stroke-width': 2 } });
    for (const id of ['hotspots-fill', 'development', 'incidents', 'transit', 'bridges', 'cameras', 'density']) {
      map.on('click', id, (e) => { const f = e.features && e.features[0]; if (f && onPick) onPick({ type: id.replace('-fill', ''), data: f.properties, lngLat: e.lngLat }); });
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
  });

  // Keep the light and sky on the real sun as time passes.
  const sunTimer = setInterval(() => {
    const s = sunPosition();
    const k = skyFor(s.elevation);
    try {
      map.setLight({ anchor: 'map', position: [1.5, s.azimuth, Math.max(0, Math.min(88, 90 - s.elevation))], color: k.lightColor, intensity: k.intensity });
      map.setSky({ 'sky-color': k.sky, 'horizon-color': k.horizon, 'fog-color': k.fog, 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.8 });
    } catch { /* style not ready */ }
  }, 60_000);

  const vis = (id, on) => { for (const l of [id, `${id}-label`, `${id}-fill`, `${id}-line`]) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none'); };
  return {
    map, ready,
    setData: (id, fc) => ready.then(() => map.getSource(id)?.setData(fc)),
    setVisible: (id, on) => {
      if (id === 'aircraft' || id === 'transit') { live.show[id] = on; if (id === 'transit') ready.then(() => vis(id, false)); return; }
      if (id === 'buildings') { map.setLayoutProperty('buildings', 'visibility', on ? 'visible' : 'none'); return; }
      if (id === 'terrain') { map.setTerrain(on ? { source: 'dem', exaggeration: 1.0 } : null); return; }
      ready.then(() => vis(id, on));
    },
    setYear: (y) => { const s = map.getSource('aerial'); if (s && s.setTiles) s.setTiles([aerialURL(y)]); },
    setAircraft, setBuses,
    setView: (mode) => map.easeTo(mode === '2d' ? { pitch: 0, bearing: 0, duration: 800 } : { pitch: 52, bearing: -12, duration: 800 }),
    flyTo: (lon, lat, zoom = 17) => map.flyTo({ center: [lon, lat], zoom, pitch: 55, speed: 1.2 }),
    sun: () => sunPosition(),
    destroy: () => { clearInterval(sunTimer); clearInterval(lightTimer); cancelAnimationFrame(raf); try { map.remove(); } catch { /* ignore */ } },
  };
}

// ------------------------------------------------------------ popup HTML
export function popupHTML(pick) {
  const d = pick.data || {};
  switch (pick.type) {
    case 'incidents': return `<div class="pop"><div class="pop-t">${esc(d.type)}</div><div class="pop-s">${esc(d.address || '')}</div><div class="pop-s">${esc(dateTime(d.t))} · ${esc(ago(d.t))}${d.active ? ' · <b style="color:var(--alert)">active</b>' : ''}</div></div>`;
    case 'transit': return `<div class="pop"><div class="pop-t">${esc(d.route)} ${d.headsign ? `→ ${esc(d.headsign)}` : ''}</div><div class="pop-s">${d.delay != null ? `${esc(d.delay)}` : ''}</div></div>`;
    case 'bridges': return `<div class="pop"><div class="pop-t">${esc(d.name)} Bridge</div><div class="pop-s">${d.up ? 'Raised for vessel traffic' : 'Down, open to road traffic'}${d.since ? ` since ${esc(dateTime(+d.since))}` : ''}</div></div>`;
    case 'cameras': return `<div class="pop"><div class="pop-t">${esc(d.label)}</div><div class="pop-s">SDOT traffic camera · updated ${esc(ago(+d.lastModified))}</div><img alt="" src="${esc(d.img)}"></div>`;
    case 'hotspots': return `<div class="pop"><div class="pop-t">Emerging cluster: ${esc(d.label)}</div><div class="pop-s">${esc(d.observed)} observed vs ${esc(num(+d.expected, 1))} expected in ${esc(d.window_days)} days · p = ${esc((+d.p).toFixed(3))}</div></div>`;
    case 'development': return `<div class="pop"><div class="pop-t">${esc(d.address)}</div><div class="pop-s">${esc(d.stageLabel)} · ${esc(d.type || '')}${d.units ? ` · ${esc(d.units)} units` : ''}</div><div class="pop-s">${esc((d.description || '').slice(0, 180))}</div></div>`;
    case 'density': return `<div class="pop"><div class="pop-t">${esc(d.label)}</div><div class="pop-s">${esc(d.n)} in the last 90 days (${esc(num(+d.per_week, 1))} a week)</div></div>`;
    case 'aircraft': return `<div class="pop"><div class="pop-t">${esc(d.callsign || d.reg || d.hex)}</div><div class="pop-s">${esc([d.operator, d.type].filter(Boolean).join(' · '))}</div><div class="pop-s">${num(d.altFt)} ft · ${num(d.gsKt)} kt · heading ${num(d.track)}°</div></div>`;
    default: return `<div class="pop">${esc(JSON.stringify(d).slice(0, 300))}</div>`;
  }
}
