// The briefing: what the observatory has found in years of public records, in plain language: what's unusual this
// week, patterns, new businesses, the biggest housing projects, City Hall decisions that name Ballard, your saved
// places; plus the finding and place pages. Evidence lives in the analyst console (/pro).
import { esc, num, date, ago, isNum, titleCase } from '../fmt.js';
import { icon } from './icons.js';

const BALLARD = { lat: 47.6687, lon: -122.3847 };
const CAT = { safety: ['Safety', 'shield', '#ff7a6b'], neighborhood: ['Neighborhood', 'pin', '#7dd3fc'], 'getting-around': ['Getting around', 'bus', '#fbbf24'], building: ['Building', 'building', '#a78bfa'],
  weather: ['Weather & water', 'wave', '#5ac8fa'], community: ['Community', 'gov', '#34d399'], data: ['Data', 'chart', '#a3b0bf'] };
const distKm = (a, b) => { const R = 6371, t = Math.PI / 180; const dl = (b.lat - a.lat) * t, dn = (b.lon - a.lon) * t; const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
export function aerial(lat, lon, { w = 240, h = 240, halfM = 85 } = {}) {
  const dy = halfM / 111320, dx = (halfM / (111320 * Math.cos((lat * Math.PI) / 180))) * (w / h);
  return `https://gismaps.kingcounty.gov/arcgis/rest/services/BaseMaps/KingCo_Aerial_2025/MapServer/export?bbox=${(lon - dx).toFixed(6)},${(lat - dy).toFixed(6)},${(lon + dx).toFixed(6)},${(lat + dy).toFixed(6)}&bboxSR=4326&imageSR=3857&size=${w * 2},${h * 2}&format=jpg&f=image`;
}
export function normAddr(a) {
  return String(a || '').toUpperCase().replace(/\s+(#|UNIT|STE|SUITE|APT|BLDG|FL|SPC|RM)\s*[A-Z0-9-]*\s*$/, '').replace(/\bNORTHWEST\b/g, 'NW')
    .replace(/\bAVENUE\b/g, 'AVE').replace(/\bSTREET\b/g, 'ST').replace(/\bPLACE\b/g, 'PL').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}
export const prettyAddr = (a) => titleCase(a).replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (m, d, s) => d + s.toLowerCase()).replace(/^(\d+)xx+ block of /i, (m, d) => `${d}00 block of `);
async function shard(k) { const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(k)); return new Uint8Array(b)[0].toString(16).padStart(2, '0'); }
const SAVED = 'ballard-places';
export const saved = () => { try { return JSON.parse(localStorage.getItem(SAVED) || '[]'); } catch { return []; } };
const setSaved = (v) => { try { localStorage.setItem(SAVED, JSON.stringify(v.slice(0, 12))); } catch { /* private */ } };

export function createBriefing(app) {
  const D = {};
  async function load() {
    if (D.ins) return D;
    const [ins, places, civic, quant] = await Promise.all([app.store.obs('insights.json'), app.store.obs('places.json').catch(() => ({})), app.store.obs('civic.json').catch(() => ({ matters: [] })), app.store.obs('nearby_quantiles.json').catch(() => ({}))]);
    Object.assign(D, { ins: ins.insights || [], places, civic, quant });
    return D;
  }
  const consumer = () => (D.ins || []).filter((i) => i.plain && i.plain.headline && i.confidence !== 'low')
    .filter((i) => !isNum(i.plain.lat) || distKm(BALLARD, { lat: i.plain.lat, lon: i.plain.lon }) < 3.2)
    .sort((a, b) => (b.plain.relevance || 0) - (a.plain.relevance || 0));
  function card(i) {
    const p = i.plain, [label, , color] = CAT[p.category] || ['Ballard', 'pin', '#7dd3fc'];
    return `<button class="icard" data-go="insight:${esc(i.id)}"><div class="ph" style="${isNum(p.lat) ? `background-image:url('${aerial(p.lat, p.lon, { w: 152, h: 152, halfM: 90 })}')` : `background:${color}22`}"></div>
      <div><div class="c" style="color:${color}">${esc(label)}</div><div class="h">${esc(p.headline)}</div><div class="b">${esc(p.summary)}</div></div></button>`;
  }
  async function home(root) {
    root.innerHTML = '<div class="list-h"><h2>Briefing</h2><p>Loading what the observatory found…</p></div>';
    await load().catch(() => {});
    const ins = consumer();
    const week = ins.filter((i) => ['hotspot', 'anomaly', 'change'].includes(i.type) && i.plain.category !== 'data').slice(0, 6);
    const facts = ins.filter((i) => ['relationship', 'near_repeat', 'cascade'].includes(i.type) && !i.known_mechanism).slice(0, 5);
    const pl = D.places || {}, openings = ((pl.openings || {}).new_licenses || []).slice(0, 10), pipe = pl.pipeline || {};
    const projects = [...(pipe.in_review || []).map((r) => ({ ...Object.fromEntries(pipe.in_review_cols.map((c, i) => [c, r[i]])), stage: 'Proposed' })),
      ...(pipe.issued_12m || []).map((r) => ({ ...Object.fromEntries(pipe.issued_cols.map((c, i) => [c, r[i]])), stage: 'Permit issued' }))]
      .filter((x) => isNum(x.lat) && (x.units_added || 0) > 0).sort((a, b) => (b.units_added || 0) - (a.units_added || 0)).slice(0, 8);
    const sv = saved();
    root.innerHTML = `<div class="list-h"><h2>Briefing</h2><p>Found in ${esc('years')} of public records, checked against chance. Updated hourly.</p></div>
      <div class="sec" style="padding:0 8px"><h3 style="padding:0 10px">This week in Ballard <span>what's unusual</span></h3>${week.map(card).join('') || '<div class="empty">Nothing unusual detected this week.</div>'}</div>
      ${facts.length ? `<div class="sec" style="padding:0 8px"><h3 style="padding:0 10px">Patterns <span>hidden in the records</span></h3>${facts.map(card).join('')}</div>` : ''}
      <div class="sec" style="padding:0 18px"><h3>Your places</h3>${sv.length ? `<div class="rows" style="padding:0">${sv.map((p) => `<button class="row" data-go="place:${esc(p.k)}"><div class="b" style="background:rgba(90,200,250,.14);color:var(--air)">${icon('star')}</div><div><div class="t">${esc(prettyAddr(p.label))}</div><div class="s">${esc(p.note || 'Saved place')}</div></div><div></div></button>`).join('')}</div>`
        : '<div class="fine" style="margin-top:0">Search an address (⌘K) and save it to follow what happens around it: permits, complaints, inspections, 911 calls nearby.</div>'}</div>
      ${openings.length ? `<div class="sec"><h3 style="padding:0 18px">New in Ballard <span>licensed in the last 90 days</span></h3><div class="hsc">${openings.map((o) => `<button class="glass" data-go="addr:${esc(o[2])}" style="width:190px;border-radius:14px;padding:10px;text-align:left"><div style="color:#34d399">${icon('store')}</div><div class="t" style="font-weight:700;margin-top:4px">${esc(prettyAddr(o[0]))}</div><div class="s" style="color:var(--muted);font-size:12px">${esc((o[1] || '').replace(/\s*\(.*$/, '').slice(0, 40))}</div><div class="s" style="color:var(--faint);font-size:11.5px">since ${esc(date(o[4]))}</div></button>`).join('')}</div></div>` : ''}
      ${projects.length ? `<div class="sec"><h3 style="padding:0 18px">Building Ballard <span>largest housing projects</span></h3><div class="hsc">${projects.map((x) => `<button class="glass" data-go="addr:${esc(x.address)}" style="width:190px;border-radius:14px;overflow:hidden;text-align:left"><div style="height:90px;background:#0b1016 url('${aerial(x.lat, x.lon, { w: 190, h: 90, halfM: 55 })}') center/cover"></div><div style="padding:8px 10px"><div style="font-weight:700">${num(x.units_added)} homes · ${esc(x.stage)}</div><div style="color:var(--muted);font-size:12px">${esc(prettyAddr(x.address))}</div></div></button>`).join('')}</div></div>` : ''}
      ${(D.civic.matters || []).length ? `<div class="sec" style="padding:0 18px"><h3>City Hall <span>legislation naming Ballard</span></h3><div class="rows" style="padding:0">${D.civic.matters.slice(0, 5).map((m) => `<a class="row" href="https://seattle.legistar.com/LegislationDetail.aspx?ID=${esc(m.id)}&GUID=${esc(m.guid || '')}" target="_blank" rel="noopener"><div class="b" style="background:rgba(52,211,153,.14);color:#34d399">${icon('gov')}</div><div><div class="t" style="white-space:normal">${esc(m.title.length > 96 ? `${m.title.slice(0, 93)}…` : m.title)}</div><div class="s">${esc(m.type)} · ${esc(m.status)} · ${esc(date(m.introduced))}</div></div><div></div></a>`).join('')}</div></div>` : ''}
      <div class="fine" style="padding:0 18px 22px"><a href="/pro">Analyst console</a> · <a href="/pro#/methods">How this works</a> · <a href="https://huggingface.co/datasets/x1489/ballard-observatory" target="_blank" rel="noopener">Open data</a></div>`;
  }
  async function insight(root, id) {
    await load().catch(() => {});
    const i = (D.ins || []).find((x) => x.id === id);
    if (!i) { root.innerHTML = '<div class="card"><h1>Finding</h1><p class="h-sub">This finding is no longer current.</p></div>'; return null; }
    const p = i.plain || { headline: i.title, summary: i.statement, sure: '', category: 'data' };
    const [label, , color] = CAT[p.category] || ['Ballard', 'pin', '#7dd3fc'];
    const lat = p.lat ?? (i.scope && i.scope.lat), lon = p.lon ?? (i.scope && i.scope.lon);
    root.innerHTML = `<div class="card"><div class="kind" style="color:${color}">${icon('chart')} ${esc(label)}</div><h1 style="font-size:24px">${esc(p.headline)}</h1>
      <p class="h-sub" style="font-size:15px;color:var(--text);line-height:1.5">${esc(p.summary)}</p>
      ${isNum(lat) ? `<div class="photo" style="background-image:url('${aerial(lat, lon, { w: 404, h: 217, halfM: 160 })}')"><span class="credit">Aerial · King County 2025</span></div>` : ''}
      ${i.caveat ? `<div class="fine" style="color:var(--warn)">${esc(i.caveat)}</div>` : ''}
      <div class="sec"><h3>How sure are we <span>${esc(i.confidence || 'medium')} confidence</span></h3><div class="h-sub">${esc(p.sure || '')}</div></div>
      <div class="actions"><a class="btn" href="/pro#/insights/${esc(i.id)}">${icon('chart')} Full analysis</a></div>
      <p class="fine">${esc(i.statement)}</p></div>`;
    return isNum(lat) ? { lon, lat } : null;
  }
  async function place(root, k) {
    root.innerHTML = '<div class="card"><h1>…</h1></div>';
    await load().catch(() => {});
    const data = await app.store.obs(`places/${await shard(k)}.json`).catch(() => ({}));
    const p = data[k];
    if (!p) { root.innerHTML = `<div class="card"><div class="kind">${icon('pin')} Place</div><h1>${esc(prettyAddr(k))}</h1><p class="h-sub">No public records found for this address yet.</p></div>`; return null; }
    const near = p.nearby_12m || {}, Q = D.quant || {};
    const pct = (kind, v) => { const q = Q[kind]; if (!q) return null; let i = 0; while (i < q.length && q[i] <= v) i++; return Math.max(0, Math.min(100, (i - 1) * 5)); };
    const NEAR = [['police_call', 'Police calls'], ['fire_ems', '911 fire & medical'], ['crime', 'Crimes reported'], ['311', '311 requests'], ['illegal_dumping', 'Illegal dumping'], ['encampment_report', 'Encampment reports']];
    const groups = { 'Businesses here': ['Business license', 'Liquor license', 'Liquor license notice', 'Food inspection'], 'Construction & permits': ['Building permit', 'Land use permit'], Complaints: ['Code complaint'], 'Short-term rentals': ['Short-term rental'] };
    const isSaved = saved().some((x) => x.k === k);
    root.innerHTML = `<div class="card"><div class="kind">${icon('pin')} Place</div><h1 style="font-size:26px">${esc(prettyAddr(p.address || k))}</h1>
      ${isNum(p.lat) ? `<div class="photo" style="background-image:url('${aerial(p.lat, p.lon, { w: 404, h: 217, halfM: 70 })}')"><span class="credit">Aerial · King County 2025</span></div>` : ''}
      <div class="actions"><button class="btn ${isSaved ? 'on' : 'primary'}" data-act="save-place">${icon('star')} ${isSaved ? 'Saved' : 'Save place'}</button><a class="btn" href="/pro#/places/search/${encodeURIComponent(k)}">${icon('chart')} Full record</a></div>
      ${isNum(p.lat) ? `<div class="sec"><h3>Around this address <span>~100 m, last 12 months</span></h3>${NEAR.map(([kk, l]) => { const v = near[kk] || 0, pc = pct(kk, v);
        return `<div style="margin:9px 0"><div style="display:flex;justify-content:space-between"><span>${esc(l)}</span><b class="num">${num(v)}</b></div><div style="height:5px;border-radius:3px;background:rgba(255,255,255,.08);margin-top:4px"><i style="display:block;height:100%;border-radius:3px;width:${pc ?? 0}%;background:${pc >= 80 ? 'var(--alert)' : pc >= 50 ? 'var(--warn)' : 'var(--ok)'}"></i></div>
          <div class="fine" style="margin-top:2px">${pc == null ? '' : pc >= 50 ? `More than ${pc}% of Ballard addresses` : `Fewer than ${100 - pc}% of Ballard addresses`}</div></div>`; }).join('')}</div>` : ''}
      ${Object.entries(groups).map(([g, kinds]) => { const rs = p.records.filter((r) => kinds.includes(r.kind)).slice(0, 8); if (!rs.length) return '';
        return `<div class="sec"><h3>${esc(g)} <span>${rs.length}</span></h3>${rs.map((r) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><div style="font-weight:600">${esc(r.summary || r.kind)}</div><div class="fine" style="margin:2px 0 0">${esc(r.kind)}${r.d ? ` · ${esc(date(r.d))}` : ''}${r.detail ? ` · ${esc(String(r.detail).slice(0, 90))}` : ''}</div></div>`).join('')}</div>`; }).join('')}
      <p class="fine">Records from SDCI, Seattle's business license registry, the WA Liquor and Cannabis Board, King County Public Health and the short-term rental registry, matched by normalized street address.</p></div>`;
    root.querySelector('[data-act="save-place"]').onclick = () => {
      const cur = saved();
      if (cur.some((x) => x.k === k)) setSaved(cur.filter((x) => x.k !== k)); else setSaved([{ k, label: p.address || k, note: `${num(p.records.length)} records on file` }, ...cur]);
      place(root, k);
    };
    return isNum(p.lat) ? { lon: p.lon, lat: p.lat } : null;
  }
  return { load, home, insight, place, consumer };
}
