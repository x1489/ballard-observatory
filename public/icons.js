// Ballard Live icon set: 24x24 line icons (1.8 px stroke, round caps), drawn with currentColor so they follow
// the theme. icon('bridge') -> inline <svg>. Use instead of emoji for a consistent look on every platform.
const P = {
  bridge: 'M3 18h18M5 18v-5m14 5v-5M5 13l6-5m8 5-6-5M3 13h2m14 0h2',
  fire: 'M12 3c1.2 3.2 4.5 4.7 4.5 9a4.5 4.5 0 0 1-9 0c0-1.8.8-3.1 1.8-4 .2 1.6 1.1 2.4 2.1 2.4-.4-2.9.2-5.6.6-7.4z',
  weather: 'M7 15a4 4 0 1 1 .8-7.9A5 5 0 0 1 17.5 8 3.5 3.5 0 0 1 17 15H7zm1 3-1 2m5-2-1 2m5-2-1 2',
  alert: 'M12 3.5 2.5 20h19L12 3.5zM12 10v4m0 3h.01',
  transit: 'M5 16V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v9M5 16h14M5 16v2m14-2v2M5 11h14M8 18.5v1m8-1v1M8.5 13.5h.01m7 0h.01',
  news: 'M4 5h13v14H6a2 2 0 0 1-2-2V5zm13 3h3v9a2 2 0 0 1-2 2M7 8h7m-7 4h7m-7 4h4',
  social: 'M4 5h16v10H9l-5 4V5z',
  power: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  air: 'M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8',
  quake: 'M2 12h4l2-6 3 12 3-9 2 3h6',
  locks: 'M12 7v14m-4-10h8M5 14a7 7 0 0 0 14 0M12 3a2 2 0 1 1 0 4 2 2 0 1 1 0-4z',
  traffic: 'M5 15l1.5-4.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 15M4 15h16v3H4zm3 3v1.5m10-1.5v1.5M7.5 15.5h.01m9 0h.01',
  event: 'M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4V7zm10 0v10',
  wildlife: 'M5 19c0-8 5-14 14-14 0 9-6 14-14 14zm0 0 9-9',
  helicopter: 'M3 4h16m-8 0v3m-5 5a5 5 0 0 1 5-5h2a4 4 0 0 1 4 4v1.5a.5.5 0 0 1-.5.5H6.5a.5.5 0 0 1-.5-.5V12zm11-1.5h5m0-2v4M7 17h10m-7.5-4v4m5-4v4',
  aircraft: 'M10.5 3.5c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5V9l7 4v2l-7-2v4.5l2 1.5V21l-3.5-1-3.5 1v-2l2-1.5V13l-7 2v-2l7-4V3.5z',
  water: 'M2 9c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M2 15c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2',
  sky: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5zM17 3l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7L17 3z',
  civic: 'M3 9l9-5 9 5M5 9v9m4.5-9v9m5-9v9M19 9v9M3 20h18',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4V8zm8 8.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-14v5l3 2',
  pin: 'M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zm0-9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  share: 'M12 3v12M7 8l5-5 5 5M5 13v6h14v-6',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0m-7 7v3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4-4',
  pause: 'M8 5v14m8-14v14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-2a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5z',
  bell: 'M6 16v-5a6 6 0 1 1 12 0v5l2 2H4l2-2zm4 4a2 2 0 0 0 4 0',
  expand: 'M4 9V4h5m11 5V4h-5M4 15v5h5m11-5v5h-5',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-14v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  sunrise: 'M3 19h18M7 19a5 5 0 0 1 10 0M12 3v7m-3-4 3-3 3 3M4.5 13.5l1.4 1.4m13.6-1.4-1.4 1.4',
  sunset: 'M3 19h18M7 19a5 5 0 0 1 10 0M12 10V3m-3 4 3 3 3-3M4.5 13.5l1.4 1.4m13.6-1.4-1.4 1.4',
  sparkle: 'M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8L12 3zm7 12 .8 2.2 2.2.8-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
  replay: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5m4-1v4l3 2',
  stories: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm-2-12 5 3-5 3V9z',
  close: 'M6 6l12 12M18 6 6 18',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  speaker: 'M4 10v4h4l5 4V6l-5 4H4zm12-1a4 4 0 0 1 0 6m2.5-8.5a7.5 7.5 0 0 1 0 11',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v5m0-8h.01',
  thermo: 'M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  wind: 'M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8',
  tide: 'M2 17c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M12 3v8m-3-3 3 3 3-3',
  person: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 10a7 7 0 0 1 14 0',
  heart: 'M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z',
  arrowUp: 'M12 19V5m-6 6 6-6 6 6',
  arrowDown: 'M12 5v14m6-6-6 6-6-6',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zm0 0v14m6-12v14',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  keyboard: 'M3 6h18v12H3zm4 4h.01M10 10h.01M13 10h.01M16 10h.01M7 14h10',
  download: 'M12 3v12m-5-5 5 5 5-5M5 19h14',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};
const FILLED = { play: 'M8 5v14l11-7L8 5z', dot: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' };

/** Inline SVG icon. opts: { size = 18, cls = '', title = '' }. Unknown names render an empty square. */
export function icon(name, { size = 18, cls = '', title = '' } = {}) {
  const t = title ? `<title>${String(title).replace(/[<&]/g, '')}</title>` : '';
  const aria = title ? 'role="img"' : 'aria-hidden="true"';
  if (FILLED[name]) return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" ${aria}>${t}<path d="${FILLED[name]}"/></svg>`;
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${aria}>${t}<path d="${P[name] || 'M4 4h16v16H4z'}"/></svg>`;
}

/** Activity kind -> [icon name, label]. */
export const KIND = {
  bridge: ['bridge', 'Bridges'], fire: ['fire', '911'], weather: ['weather', 'Weather'], alert: ['alert', 'Alerts'], transit: ['transit', 'Transit'],
  news: ['news', 'News'], social: ['social', 'Social'], power: ['power', 'Power'], air: ['air', 'Air'], quake: ['quake', 'Quakes'],
  locks: ['locks', 'Locks'], traffic: ['traffic', 'Traffic'], event: ['event', 'Events'], wildlife: ['wildlife', 'Wildlife'], aircraft: ['aircraft', 'Aircraft'],
  water: ['water', 'Water'], sky: ['sky', 'Sky'], civic: ['civic', 'Civic'],
};
export const kindIcon = (kind, opts) => icon((KIND[kind] || ['info'])[0], opts);
export const NAMES = Object.keys(P).concat(Object.keys(FILLED));
