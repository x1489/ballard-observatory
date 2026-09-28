// The live 3D scene: King County's 2025 aerial photography on real terrain, 3D buildings, a sky and lighting that
// follow the actual sun (and go dark at night, with the street grid glowing), weather radar, and a deck.gl layer
// stack for everything that moves, drawn every animation frame. Camera helpers follow, chase or ride along with a
// tracked object.
import { lookAt, sunPosition, BALLARD } from './sun.js';
import { metersPerPixel, offset, wrap360, angDiff, toRad } from './geo.js';

export const CENTER = [BALLARD.lon, BALLARD.lat];
const AERIAL = (y) => `https://gismaps.kingcounty.gov/arcgis/rest/services/BaseMaps/KingCo_Aerial_${y}/MapServer/tile/{z}/{y}/{x}`;
export const AERIAL_YEARS = [2025, 2023, 2021, 2019, 2017, 2015, 2013, 2012, 2009, 2007, 2005, 2002, 2000, 1998, 1936];

function style(year) {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18,
        attribution: 'Regional imagery: Esri, Maxar, Earthstar Geographics' },
      aerial: { type: 'raster', tiles: [AERIAL(year)], tileSize: 256, minzoom: 8, maxzoom: 20, bounds: [-122.55, 47.08, -121.06, 47.80],
        attribution: 'Aerial imagery © EagleView Technologies, Inc. / King County' },
      dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 15, encoding: 'terrarium',
        attribution: 'Terrain: Mapzen / AWS Open Data' },
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© OpenStreetMap contributors · OpenFreeMap' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#070b12' } },
      { id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-fade-duration': 0 } },
      { id: 'aerial', type: 'raster', source: 'aerial', paint: { 'raster-fade-duration': 150, 'raster-resampling': 'linear' } },
      // Night: the street grid glows (sodium/LED) over the darkened photograph.
      { id: 'streetlight', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 10,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']]],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['match', ['get', 'class'], ['motorway', 'trunk'], '#ffc27a', ['primary', 'secondary'], '#ffd9a0', '#ffe8c4'],
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 2.2, 0.8], 17, ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], 26, 12]],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 11, 2, 17, 14], 'line-opacity': 0.32 } },
      { id: 'streetlight-core', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']]],
        layout: { visibility: 'none', 'line-cap': 'round' },
        paint: { 'line-color': '#fff1d6', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.4, 17, 2.2], 'line-blur': 0.8, 'line-opacity': 0.55 } },
      // Only buildings of three storeys and up are extruded: houses read better as the real rooftops and gardens in the
      // aerial photograph than as white boxes, while apartment blocks and warehouses rise as massing.
      { id: 'buildings', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 13.5,
        filter: ['all', ['!=', ['get', 'hide_3d'], true], ['>=', ['coalesce', ['get', 'render_height'], 0], 9]],
        paint: { 'fill-extrusion-color': '#e1e4e8', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 7],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, 0.96], 'fill-extrusion-vertical-gradient': true } },
      { id: 'water-names', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 11,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 12.5, 'text-letter-spacing': 0.06 },
        paint: { 'text-color': 'rgba(214,236,255,.85)', 'text-halo-color': 'rgba(6,12,20,.7)', 'text-halo-width': 1.2 } },
      { id: 'place-names', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 16,
        filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter']]],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-transform': 'uppercase', 'text-letter-spacing': 0.14 },
        paint: { 'text-color': 'rgba(255,255,255,.9)', 'text-halo-color': 'rgba(6,10,16,.75)', 'text-halo-width': 1.4 } },
      { id: 'road-names', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 16,
        filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary', 'trunk']]],
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-max-angle': 30 },
        paint: { 'text-color': 'rgba(244,247,251,.9)', 'text-halo-color': 'rgba(8,12,18,.8)', 'text-halo-width': 1.2 } },
    ],
    terrain: { source: 'dem', exaggeration: 1.0 },
    sky: { 'sky-color': '#6aa4dc', 'horizon-color': '#d6e6f4', 'fog-color': '#e4ebf2', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.9, 'atmosphere-blend': 0.85 },
  };
}

export function createScene(container, { year = 2025, onPick, onHover, onUserMove, camera = {}, sunTime = null } = {}) {
  const maplibregl = window.maplibregl, D = window.deck;
  const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
  // Four tile hosts (aerials, Esri, terrain, vector) load in parallel; don't let the photo tiles starve the terrain.
  try {
    maplibregl.config.MAX_PARALLEL_IMAGE_REQUESTS = 24;
    maplibregl.config.MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME = /[?&]qa=1/.test(location.search) ? 256 : 16;
  } catch { /* older build */ }
  const map = new maplibregl.Map({
    container, style: style(year), center: camera.center || [-122.3905, 47.6665], zoom: camera.zoom ?? 15.3, pitch: camera.pitch ?? 62, bearing: camera.bearing ?? 28,
    maxPitch: 85, hash: false, attributionControl: false, pixelRatio: Math.min(devicePixelRatio || 1, mobile ? 2 : 2),
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false }, fadeDuration: 150,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true,
    customAttribution: '<a href="/models/credits.txt" target="_blank" rel="noopener">3D aircraft models: CC BY 4.0 (credits)</a>' }), 'bottom-right');

  const lights = { ambient: new D.AmbientLight({ color: [255, 255, 255], intensity: 1 }), sun: new D.DirectionalLight({ color: [255, 255, 255], intensity: 1.5, direction: [-1, -1, -1] }) };
  const lighting = new D.LightingEffect(lights);
  const overlay = new D.MapboxOverlay({
    interleaved: true, layers: [], effects: [lighting], pickingRadius: mobile ? 14 : 6, useDevicePixels: mobile ? 1.5 : true,
    onClick: (info, ev) => { if (onPick) onPick(info && info.object ? info : null, ev); },
    onHover: (info) => { if (onHover) onHover(info && info.object ? info : null); },
    getCursor: ({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
  });
  map.addControl(overlay);

  const producers = new Map();
  // The style is usable (layers exist) long before every tile has loaded; don't wait for 'load'.
  const styleReady = () => !!(map.style && map.style._loaded);
  const S = { quality: 0, sunTime, look: lookAt(sunPosition(sunTime ?? Date.now()).elevation), sun: sunPosition(sunTime ?? Date.now()), cloud: 0, follow: null, fps: 0, frames: 0, paused: false, lastFrame: 0,
    radar: { frames: [], idx: 0, on: false, t0: 0 }, elevCache: new Map() };

  // ---------------------------------------------------------------- the look (sun-driven grading)
  const sunNow = () => (S.sunTime != null ? S.sunTime : Date.now());
  function applyLook(force = false) {
    const sun = sunPosition(sunNow());
    const look = lookAt(sun.elevation, S.cloud);
    S.sun = sun; S.look = look;
    if (!styleReady() && !force) return;
    try {
      map.setPaintProperty('aerial', 'raster-brightness-max', look.bright);
      map.setPaintProperty('aerial', 'raster-saturation', look.sat);
      map.setPaintProperty('aerial', 'raster-contrast', look.contrast);
      map.setPaintProperty('esri', 'raster-brightness-max', look.bright);
      map.setPaintProperty('esri', 'raster-saturation', look.sat - 0.1);
      map.setPaintProperty('buildings', 'fill-extrusion-color', buildingColor(look));
      const glow = look.glow > 0.05;
      for (const id of ['streetlight', 'streetlight-core']) map.setLayoutProperty(id, 'visibility', glow ? 'visible' : 'none');
      if (glow) { map.setPaintProperty('streetlight', 'line-opacity', 0.34 * look.glow); map.setPaintProperty('streetlight-core', 'line-opacity', 0.6 * look.glow); }
      map.setLight({ anchor: 'map', position: [1.5, sun.azimuth, Math.max(10, Math.min(88, 90 - Math.max(sun.elevation, 2)))], color: look.light, intensity: look.li });
      map.setSky({ 'sky-color': look.sky, 'horizon-color': look.horizon, 'fog-color': look.fog, 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.9, 'atmosphere-blend': look.night ? 0.2 : 0.85 });
    } catch { /* style not ready */ }
    // model lighting: the real sun direction; moonlight-ish at night
    const el = Math.max(sun.elevation, -4), az = toRad(sun.azimuth), e = toRad(Math.max(el, 3));
    lights.sun.direction = [-Math.sin(az) * Math.cos(e), -Math.cos(az) * Math.cos(e), -Math.sin(e)];
    lights.sun.intensity = look.sunI;
    lights.sun.color = hexRGB(look.light);
    lights.ambient.intensity = look.amb;
    lights.ambient.color = look.night ? [150, 165, 210] : [255, 255, 255];
    overlay.setProps({ effects: [new D.LightingEffect(lights)] });
  }
  const hexRGB = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  // Building massing: a light, warm architectural-model tone graded by the light (golden at sunset, dark at night),
  // a touch cooler for taller buildings so the skyline reads.
  function buildingColor(look) {
    const tint = hexRGB(look.bldg);
    const shade = (f) => `rgb(${tint.map((v) => Math.round(Math.min(255, v * f))).join(',')})`;
    return ['step', ['coalesce', ['get', 'render_height'], 7], shade(0.98), 7, shade(0.95), 16, shade(0.92), 32, shade(0.9)];
  }

  // ---------------------------------------------------------------- radar loop (IEM NEXRAD, 50 minutes)
  function setRadar(frames, on) {
    S.radar.on = !!on;
    if (!styleReady()) { map.once('style.load', () => setRadar(frames, on)); return; }
    const urls = (frames || []).map((f) => f.tileUrl);
    const have = S.radar.frames.map((f) => f.url).join('|');
    if (urls.length && urls.join('|') !== have) {
      for (const f of S.radar.frames) { if (map.getLayer(f.id)) map.removeLayer(f.id); if (map.getSource(f.id)) map.removeSource(f.id); }
      S.radar.frames = urls.map((url, i) => ({ id: `radar-${i}`, url, label: frames[i].label }));
      for (const f of S.radar.frames) {
        map.addSource(f.id, { type: 'raster', tiles: [f.url], tileSize: 256, maxzoom: 12, attribution: 'Radar: NEXRAD via Iowa Environmental Mesonet' });
        map.addLayer({ id: f.id, type: 'raster', source: f.id, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0 } } }, 'buildings');
      }
    }
    for (const f of S.radar.frames) map.setLayoutProperty(f.id, 'visibility', S.radar.on ? 'visible' : 'none');
    S.radar.t0 = performance.now();
  }
  function stepRadar(ts) {
    const R = S.radar;
    if (!R.on || !R.frames.length) return;
    const per = 420, hold = 2200, n = R.frames.length;
    const t = (ts - R.t0) % (per * (n - 1) + hold);
    const idx = Math.min(n - 1, Math.floor(t / per));
    if (idx !== R.idx) {
      R.idx = idx;
      R.frames.forEach((f, i) => map.setPaintProperty(f.id, 'raster-opacity', i === idx ? 0.62 : 0));
    }
  }

  // ---------------------------------------------------------------- terrain elevation (cached on a ~20 m grid)
  function ground(lon, lat) {
    const k = `${Math.round(lon * 5000)}:${Math.round(lat * 5000)}`;
    const c = S.elevCache.get(k);
    if (c !== undefined) return c;
    let e = null;
    try { e = map.queryTerrainElevation([lon, lat]); } catch { e = null; }
    if (e == null || !Number.isFinite(e)) return 0;
    if (S.elevCache.size > 60000) S.elevCache.clear();
    S.elevCache.set(k, e);
    return e;
  }
  map.on('sourcedata', (e) => { if (e.sourceId === 'dem' && e.isSourceLoaded) S.elevCache.clear(); });

  // ---------------------------------------------------------------- camera follow / chase / cockpit
  function follow(getTarget, mode = 'track', opts = {}) {
    S.follow = getTarget ? { get: getTarget, mode, opts, started: performance.now(), zoom0: map.getZoom() } : null;
    if (!getTarget) { try { map.setCenterClampedToGround(true); } catch { /* older */ } }
  }
  function stepFollow() {
    const F = S.follow;
    if (!F) return;
    const t = F.get();
    if (!t) { follow(null); return; }
    const air = t.alt != null && t.alt > 30;
    try { map.setCenterClampedToGround(!air); } catch { /* ignore */ }
    const k = Math.min(1, (performance.now() - F.started) / 1400);
    const ease = k * k * (3 - 2 * k);
    if (F.mode === 'cockpit' && air) {
      const ahead = offset(t.lon, t.lat, Math.sin(toRad(t.heading)) * 6, Math.cos(toRad(t.heading)) * 6);
      const cam = map.calculateCameraOptionsFromCameraLngLatAltRotation({ lng: ahead[0], lat: ahead[1] }, t.alt + 3, t.heading, 84 + (t.pitch || 0) * 0.5, -(t.bank || 0) * 0.6);
      map.jumpTo(cam);
      return;
    }
    const opts = { center: [t.lon, t.lat] };
    if (air) opts.elevation = t.alt;
    if (F.mode === 'chase') {
      const b = map.getBearing();
      opts.bearing = b + angDiff(b, t.heading) * (0.04 + 0.2 * (1 - ease));
      opts.pitch = map.getPitch() + (72 - map.getPitch()) * 0.05;
      const want = F.opts.zoom ?? 17.2;
      opts.zoom = map.getZoom() + (want - map.getZoom()) * 0.05;
    }
    if (ease < 1) {
      const c = map.getCenter();
      opts.center = [c.lng + (t.lon - c.lng) * (0.08 + 0.5 * ease), c.lat + (t.lat - c.lat) * (0.08 + 0.5 * ease)];
    }
    map.jumpTo(opts);
  }
  // A person moving the map takes the camera back (except zooming or rotating while tracking).
  const userMoved = (e) => {
    if (!e.originalEvent || !S.follow) return;
    if (S.follow.mode === 'track' && (e.type === 'zoomstart' || e.type === 'rotatestart' || e.type === 'pitchstart')) return;
    follow(null);
    if (onUserMove) onUserMove();
  };
  for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) map.on(ev, userMoved);

  // ---------------------------------------------------------------- the frame loop
  // Frame budget: 60 fps on desktops, 40 on phones; after a minute without a touch, 24 (things still glide, the
  // battery lasts). Any input restores the full rate.
  let lastInput = performance.now();
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) addEventListener(ev, () => { lastInput = performance.now(); }, { passive: true });
  function frame(ts) {
    requestAnimationFrame(frame);
    if (S.paused || document.hidden) return;
    const idle = ts - lastInput > 60_000 && !S.follow && !document.body.classList.contains('director');
    const minGap = idle ? 1000 / 24 : mobile ? 1000 / 40 : 0;
    if (minGap && ts - S.lastFrame < minGap) return;
    const dt = ts - S.lastFrame;
    S.lastFrame = ts;
    S.frames++;
    S.fps = S.fps * 0.95 + (dt > 0 ? 1000 / dt : 60) * 0.05;
    const now = S.clock ? S.clock() : Date.now(); // Rewind swaps in the replay clock
    const zoom = map.getZoom();
    const center = map.getCenter();
    const ctx = { now, ts, zoom, center, pitch: map.getPitch(), bearing: map.getBearing(), mpp: metersPerPixel(zoom, center.lat), sun: S.sun, look: S.look,
      night: S.look.night, glow: S.look.glow, ground, mobile, quality: S.quality };
    const layers = [];
    for (const [name, fn] of producers) {
      try { const ls = fn(ctx); if (ls) layers.push(...ls.filter(Boolean)); } catch (err) { console.error(`[scene] ${name}`, err); }
    }
    overlay.setProps({ layers });
    stepFollow();
    stepRadar(ts);
  }

  // Adaptive quality: phones that can't keep up step down resolution, then terrain, rather than stutter; they step
  // back up when there's headroom. (Off in QA runs, which render in software.)
  const QA = /[?&]qa=1/.test(location.search);
  const LEVELS = [{ px: Math.min(devicePixelRatio || 1, 2), deckPx: mobile ? 1.5 : true, terrain: true }, { px: 1.5, deckPx: 1, terrain: true },
    { px: 1, deckPx: 1, terrain: true }, { px: 1, deckPx: 1, terrain: false }];
  let level = 0, slow = 0, fast = 0;
  function setLevel(n) {
    level = Math.max(0, Math.min(LEVELS.length - 1, n));
    const L = LEVELS[level];
    try { map.setPixelRatio(L.px); } catch { /* older build */ }
    overlay.setProps({ useDevicePixels: L.deckPx });
    const hasTerrain = !!map.getTerrain();
    if (L.terrain !== hasTerrain) { map.setTerrain(L.terrain ? { source: 'dem', exaggeration: 1 } : null); S.elevCache.clear(); }
    S.quality = level;
  }
  if (!QA) setInterval(() => {
    if (document.hidden || S.paused || !S.lastFrame || performance.now() - S.lastFrame > 1000) return;
    if (performance.now() - lastInput > 60_000) return; // idle frame cap in force: nothing to judge
    const cap = mobile ? 40 : 60;
    if (S.fps < cap * 0.45) { fast = 0; if (++slow >= 2 && level < LEVELS.length - 1) { setLevel(level + 1); slow = 0; } }
    else if (S.fps > cap * 0.85) { slow = 0; if (++fast >= 4 && level > 0) { setLevel(level - 1); fast = 0; } }
    else { slow = 0; fast = 0; }
  }, 4000);

  const ready = new Promise((resolve) => { if (styleReady()) resolve(); else map.once('style.load', resolve); });
  ready.then(() => { applyLook(true); requestAnimationFrame(frame); });
  setInterval(() => applyLook(), 60_000);

  return {
    map, overlay, ready, state: S,
    add(name, fn) { producers.set(name, fn); },
    remove(name) { producers.delete(name); },
    follow, following: () => S.follow,
    setCloud(c) { S.cloud = c; applyLook(); },
    setSunTime(t) { S.sunTime = t; applyLook(); },
    setClock(fn) { S.clock = fn || null; },
    setRadar,
    setYear(y) { const s = map.getSource('aerial'); if (s && s.setTiles) s.setTiles([AERIAL(y)]); },
    setBuildings(on) { map.setLayoutProperty('buildings', 'visibility', on ? 'visible' : 'none'); },
    ground, look: () => S.look, sun: () => S.sun, fps: () => Math.round(S.fps), quality: () => S.quality,
    pause(p) { S.paused = !!p; },
    /** Screen position of a 3D point (for HUD brackets and labels). */
    project(lon, lat, alt = 0) {
      const vp = overlay._deck && overlay._deck.getViewports && overlay._deck.getViewports()[0];
      if (vp) { const [x, y] = vp.project([lon, lat, alt]); return [x, y]; }
      const p = map.project([lon, lat]); return [p.x, p.y];
    },
    flyTo(o) { follow(null); map.flyTo({ speed: 1.1, curve: 1.5, ...o }); },
    applyLook,
  };
}
