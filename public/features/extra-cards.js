// Cards for the v2 sources: "Overhead now" (aircraft), "Wildlife sightings" (iNaturalist), and bridge-opening
// odds (with the 33 CFR 117.1051 rush-hour rule) added to the Drawbridges card, plus a glance tile and a heads-up.
import { icon } from '../icons.js';
export const css = false; // styles live in style.css (.ac-*, .wl-*, .odds*)

// kind -> [icon markup (tinted per kind in CSS), label]
const acIco = (kind, name) => `<span class="ac-ico k-${kind}" aria-hidden="true">${icon(name, { size: 16 })}</span>`;
const KIND = Object.fromEntries([['airliner', 'aircraft', 'Airliner'], ['seaplane', 'aircraft', 'Floatplane'], ['helicopter', 'helicopter', 'Helicopter'], ['military', 'aircraft', 'Military'], ['light', 'aircraft', 'Light aircraft'], ['unknown', 'aircraft', 'Aircraft']].map(([k, ic, label]) => [k, [acIco(k, ic), label]]));
const GROUPS = [['', 'All'], ['Aves', 'Birds'], ['Mammalia', 'Mammals'], ['Plantae', 'Plants'], ['Insecta', 'Insects'], ['Fungi', 'Fungi'], ['other', 'Other']];
const MAIN_GROUPS = new Set(['Aves', 'Mammalia', 'Plantae', 'Insecta', 'Fungi']);

export default function init(api) {
  const u = api.util;
  const { esc, href, isNum, r0, time, dayLabel, countdownEl, liveNum, live } = u;
  const has = (id) => !!api.meta(id);
  const mi = (km) => (isNum(km) ? `${(km * 0.621).toFixed(km < 1.6 ? 1 : 0)} mi` : '');
  const ft = (a) => (isNum(a) ? (a < 100 ? 'near ground' : `${Math.round(a).toLocaleString()} ft`) : '–');
  const vs = (v) => (isNum(v) && Math.abs(v) >= 300 ? (v > 0 ? ' ↗' : ' ↘') : '');
  const arrow = (deg) => (isNum(deg) ? `<span class="ac-arrow" style="transform:rotate(${deg}deg)" aria-hidden="true">↑</span>` : '');

  // ------------------------------------------------ aircraft
  api.registerCard('aircraft', {
    deps: ['aircraft'], title: 'Overhead now', section: 'live', order: 20,
    render(D) {
      if (!has('aircraft')) return api.store.sources().length ? '<div class="empty">The aircraft feed isn\'t available on this server yet.</div>' : null;
      const a = D('aircraft');
      if (!a) return null;
      const air = (a.aircraft || []).filter((x) => !x.onGround);
      if (!air.length) return `<div class="row"><div class="big">0</div><div class="small muted">No aircraft within ${a.radiusNm || 8} nm right now. The ADS-B feed updates every 15 seconds.</div></div>`;
      const n = a.nearest || air[0];
      const [ico, kindName] = KIND[n.kind] || KIND.unknown;
      const name = esc(n.callsign || n.reg || n.hex.toUpperCase());
      const emerg = air.filter((x) => x.emergency);
      return `${emerg.map((x) => `<div class="ac-emerg">${icon('alert', { size: 15, cls: 'ic-inline' })} <b>${esc(x.callsign || x.reg || x.hex)}</b> squawking ${esc(x.squawk || '')} (${esc(x.emergency)})</div>`).join('')}
        <div class="row between wrap"><div class="row"><div class="big">${liveNum('n', air.length)}</div><div class="small muted">aircraft within ${a.radiusNm || 8} nm<br>of Market St</div></div>
        <div class="ac-nearest"><div class="label">Nearest</div><div class="ac-name">${ico} <b>${name}</b> ${arrow(n.track)}</div>
          <div class="small">${esc([n.operator, n.desc || n.type, ['seaplane', 'helicopter', 'military'].includes(n.kind) ? kindName.toLowerCase() : null].filter(Boolean).join(' · ') || kindName)}</div>
          <div class="small muted">${live('alt', ft(n.altFt))}${vs(n.vrFpm)} · ${isNum(n.gsKt) ? `${r0(n.gsKt)} kt` : '–'} · ${mi(n.distKm)} away</div></div></div>
        <ul class="list ac-list">${air.slice(0, 12).map((x) => {
          const [ic, kn] = KIND[x.kind] || KIND.unknown;
          return `<li class="${x.emergency ? 'ac-row-emerg' : ''}"><span title="${esc(kn)}">${ic}</span>
            <div class="grow"><a href="${href(`https://globe.adsb.lol/?icao=${x.hex}`)}" target="_blank" rel="noopener" class="title">${esc(x.callsign || x.reg || x.hex.toUpperCase())}</a>
            <div class="sub">${esc([x.operator, x.type, ['seaplane', 'helicopter', 'military'].includes(x.kind) ? kn.toLowerCase() : null].filter(Boolean).join(' · ') || kn)}</div></div>
            <div class="t num" style="text-align:right">${ft(x.altFt)}${vs(x.vrFpm)}<br>${mi(x.distKm)} ${arrow(x.track)}</div></li>`;
        }).join('')}</ul>
        <div class="tiny faint" style="margin-top:6px">ADS-B positions via ${esc(a.provider || 'adsb.lol')} · on the map they glide between updates.</div>`;
    },
  });
  api.registerTile({
    id: 'aircraft', order: 850,
    render: (D) => {
      const a = D('aircraft');
      if (!a) return null;
      const n = a.nearest;
      return api.tile({ href: '#live', k: 'Overhead', v: `${a.airborne ?? a.count} <small>aircraft</small>`, s: n ? `nearest ${esc(n.callsign || n.reg || n.hex.toUpperCase())} · ${mi(n.distKm)} · ${ft(n.altFt)}` : 'quiet skies', key: 'aircraft' });
    },
  });

  // ------------------------------------------------ wildlife
  api.registerCard('wildlife', {
    deps: ['wildlife'], title: 'Wildlife sightings', section: 'community', order: 15, wide: true,
    render(D, ctx) {
      if (!has('wildlife')) return api.store.sources().length ? '<div class="empty">The wildlife feed isn\'t available on this server yet.</div>' : null;
      const w = D('wildlife');
      if (!w) return null;
      const g = ctx.ui['wildlife.group'] || '';
      const obs = (w.observations || []).filter((o) => !g || (g === 'other' ? !MAIN_GROUPS.has(o.taxon && o.taxon.iconic) : o.taxon && o.taxon.iconic === g));
      const c = w.counts || {};
      const seg = `<div class="seg wl-seg" role="group" aria-label="Group">${GROUPS.map(([v, l]) => `<button type="button" data-set="wildlife.group=${v}" class="${g === v ? 'on' : ''}" aria-pressed="${g === v}">${l}</button>`).join('')}</div>`;
      const grid = obs.slice(0, 24).map((o) => {
        const name = (o.taxon && (o.taxon.common || o.taxon.name)) || 'Observation';
        const photo = o.photo && /^https:\/\/[\w.-]+\/[\w/.%~-]+$/.test(o.photo) ? o.photo : null;
        return `<a class="wl-card" href="${href(o.url)}" target="_blank" rel="noopener" title="${esc(name)}${o.taxon && o.taxon.common ? ` (${esc(o.taxon.name)})` : ''}${o.photoCredit ? ` · photo ${esc(o.photoCredit)}` : ''}">
          ${photo ? `<img src="${esc(photo)}" alt="${esc(name)}" loading="lazy">` : `<span class="wl-noimg" aria-hidden="true">${icon('wildlife', { size: 26 })}</span>`}
          <span class="wl-cap"><b>${esc(name)}</b><span>${o.t ? esc(dayLabel(o.t)) : ''}${o.place ? ` · ${esc(o.place.replace(/, Seattle, WA, US$|, WA, US$|, US$/, ''))}` : ''}</span></span></a>`;
      }).join('');
      return `<div class="row between wrap" style="margin-bottom:8px"><span class="small">${isNum(c.total) ? `<b>${c.total.toLocaleString()}</b> observations of <b>${(c.species || 0).toLocaleString()}</b> species` : ''} <span class="muted">around Ballard, last ${w.days || 14} days</span></span>${seg}</div>
        ${grid ? `<div class="wl-grid">${grid}</div>` : '<div class="empty">No recent sightings in this group.</div>'}
        <div class="tiny faint" style="margin-top:8px">Community observations from iNaturalist (photos by their observers). Turn on the <b>Wildlife</b> map layer to see where.</div>`;
    },
  });

  // ------------------------------------------------ bridge odds (added to the Drawbridges card)
  function oddsHTML(o, now) {
    if (!o || !o.now) return '';
    const n = o.now;
    const pctv = Math.round((n.chanceNext30Min || 0) * 100);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(now);
    let html = '';
    if (n.restricted) {
      html = `<div class="odds restricted"><b>${icon('clock', { size: 15, cls: 'ic-inline' })} Rush-hour rule</b>: the Ballard Bridge need not open for boats under 1,000 tons${isNum(o.next) ? ` until <b>${time(o.next)}</b> (${countdownEl(o.next)})` : ''}.</div>`;
    } else {
      html = `<div class="odds"><div class="row between"><span>Chance of an opening in the next 30 min</span><b class="num">${live('odds', pctv + '%')}</b></div>
        <div class="odds-bar" aria-hidden="true"><span style="width:${Math.min(100, pctv)}%"></span></div>
        <div class="small muted">Usually ~${(n.expectedPerHour || 0).toFixed(1)} openings/hr on ${esc(day)}s at this hour${isNum(n.typicalMinutes) ? `, about ${r0(n.typicalMinutes)} min each` : ''} (last ${Math.round((o.windowDays || 84) / 7)} weeks).</div>
        ${o.fremont && o.fremont.now ? `<div class="small muted">Fremont Bridge: ${Math.round((o.fremont.now.chanceNext30Min || 0) * 100)}%</div>` : ''}
        ${isNum(o.next) && o.nextStarts && o.next - now < 3 * 3600e3 ? `<div class="small">Rush-hour closure to most boats from <b>${time(o.next)}</b> (${countdownEl(o.next)})</div>` : ''}
        ${n.night ? '<div class="small muted">Overnight (11 pm–7 am) openings need an hour\'s notice to the drawtender.</div>' : ''}</div>`;
    }
    return html;
  }
  const base = api.getCard('bridges');
  if (base) {
    api.registerCard('bridges', {
      ...base,
      deps: [...new Set([...(base.deps || []), 'bridge-odds'])],
      clock: true,
      render(D, ctx) {
        const h = base.render(D, ctx);
        if (h == null) return h;
        let x = '';
        try { x = oddsHTML(D('bridge-odds'), ctx.now); } catch (err) { console.error('bridge odds', err); }
        return x ? `${h}<div class="divider"></div>${x}` : h;
      },
    });
  }
  api.registerHeadsup({
    id: 'bridge-odds', order: 250,
    render: (D) => {
      const o = D('bridge-odds');
      const b = D('bridges');
      const up = b && (b.bridges || []).some((x) => /ballard/i.test(x.name) && x.up);
      if (!o || !o.now || up || o.now.restricted || (o.now.chanceNext30Min || 0) < 0.5) return null;
      return api.hu({ cls: 'info', href: '#water', b: 'Ballard Bridge opening likely', small: `${Math.round(o.now.chanceNext30Min * 100)}% in the next 30 min` });
    },
  });
}
