// Formatting for the live app (Pacific time, US units).
export const TZ = 'America/Los_Angeles';
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const tfs = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' });
const df = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const dfl = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
export const time = (t) => (isNum(t) ? tf.format(t).replace(' AM', ' am').replace(' PM', ' pm') : '–');
export const timeS = (t) => (isNum(t) ? tfs.format(t).replace(' AM', ' am').replace(' PM', ' pm') : '–');
export const day = (t) => (isNum(t) ? df.format(t) : '–');
export const date = (t) => { const x = typeof t === 'string' ? Date.parse(t) : t; return isNum(x) ? dfl.format(x) : '–'; };
export const num = (v, d = 0) => (isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
export function ago(t, now = Date.now()) {
  if (!isNum(t)) return '–';
  const s = Math.round((now - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function inMin(t, now = Date.now()) {
  if (!isNum(t)) return '–';
  const m = Math.round((t - now) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export function dur(sec) {
  if (!isNum(sec)) return '–';
  const s = Math.round(Math.abs(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const miles = (m) => (isNum(m) ? (m / 1609.344 < 10 ? (m / 1609.344).toFixed(1) : Math.round(m / 1609.344)) : '–');
export const feet = (m) => (isNum(m) ? Math.round(m / 0.3048 / 10) * 10 : null);
export const compass = (deg) => (isNum(deg) ? ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] : '');
export const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Nw|Ne|Sw|Se|Ii|Iii)\b/g, (m) => m.toUpperCase());
// ICAO airline designator -> IATA code, for airlines seen over Seattle.
const IATA = { ASA: 'AS', QXE: 'QX', SWA: 'WN', DAL: 'DL', UAL: 'UA', AAL: 'AA', SKW: 'OO', FDX: 'FX', UPS: '5X', JBU: 'B6', FFT: 'F9', NKS: 'NK', HAL: 'HA',
  ACA: 'AC', JZA: 'QK', WJA: 'WS', WEN: 'WR', KAL: 'KE', AAR: 'OZ', ANA: 'NH', JAL: 'JL', BAW: 'BA', DLH: 'LH', AFR: 'AF', KLM: 'KL', CPA: 'CX', EVA: 'BR',
  CAL: 'CI', UAE: 'EK', QTR: 'QR', ICE: 'FI', RPA: 'YX', ENY: 'MQ', SCX: 'SY', VXP: 'XP', ASH: 'YV', SIA: 'SQ', THY: 'TK', SAS: 'SK', FIN: 'AY', CSN: 'CZ',
  CES: 'MU', CCA: 'CA', GTI: '5Y', ABX: 'GB', CKS: 'K4', PAC: 'PO', AMX: 'AM', VOI: 'Y4', CPZ: 'CP', GJS: 'G7', TSC: 'TS', PAL: 'PR', HVN: 'VN', SVA: 'SV', ETD: 'EY', IBE: 'IB', VIR: 'VS', AIC: 'AI' };
/** "ASA1085" -> "AS 1085" (IATA flight number) when the airline is known. */
export function flightNo(callsign, iata) {
  if (!callsign) return null;
  const m = /^([A-Z]{3})(\d{1,4}[A-Z]?)$/.exec(callsign);
  const code = iata || (m && IATA[m[1]]);
  if (m && code) return `${code} ${m[2]}`;
  return callsign;
}
export const WX = (c) => (c === 0 ? 'Clear' : c <= 1 ? 'Mostly clear' : c === 2 ? 'Partly cloudy' : c === 3 ? 'Overcast' : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : c <= 86 ? 'Snow showers' : 'Thunderstorms');
