// Built-in heads-up strip items (the alerts row at the top). Each is a registerHeadsup() def; core renders them
// in `order` on every batch and hides the strip when nothing returns markup.
import { registerHeadsup, hu, asOf, connection } from './core.js';
import { esc, isNum, r1, time, rel, dayLabel, aqiInfo, plural } from './util.js';
import { rainTimes } from './cards.js';

registerHeadsup({
  id: 'server-down', order: 0,
  render: () => (connection() === 'down'
    ? hu({ cls: 'danger', b: "Can't reach the dashboard server", small: 'Is <span class="mono">node server.mjs</span> running? Retrying…' })
    : null),
});

registerHeadsup({
  id: 'alerts', order: 100,
  render(D, { now }) {
    const al = D('alerts');
    const out = [];
    for (const a of (al && al.alerts) || []) {
      const until = isNum(a.ends) ? a.ends : a.expires;
      if (isNum(until) && until < now) continue; // already over; only a stale payload still lists it
      const sev = /extreme|severe/i.test(a.severity) ? 'danger' : 'warn';
      out.push(hu({ cls: sev, href: '#weather', title: a.headline || '', b: esc(a.event), small: `${a.marine ? 'Puget Sound' : 'Seattle'}${isNum(a.onset) && a.onset > now ? ` · starts ${esc(dayLabel(a.onset))} ${time(a.onset)}` : ''}${isNum(until) ? ` · until ${esc(dayLabel(until))} ${time(until)}` : ''}` }));
    }
    return out;
  },
});

registerHeadsup({
  id: 'bridges', order: 200,
  render(D) {
    const b = D('bridges');
    return ((b && b.bridges) || []).slice(0, 2).filter((x) => x.up)
      .map((x) => hu({ cls: 'warn', href: '#water', b: `${esc(x.name)} Bridge is UP`, small: `${x.sinceKnown && isNum(x.since) ? rel(x.since) : 'now'}${asOf('bridges')}` }));
  },
});

registerHeadsup({
  id: 'rain', order: 300,
  render(D, { now }) {
    const w = D('weather');
    const rainAt = w ? rainTimes(w, now).startsAt : null;
    return isNum(rainAt) && rainAt - now < 90 * 60000 ? hu({ cls: 'info', href: '#weather', b: `Rain ${rel(rainAt)}`, small: `around ${time(rainAt)}` }) : null;
  },
});

registerHeadsup({
  id: 'fire', order: 400,
  render(D) {
    const f = D('fire911');
    if (!(f && f.activeKnown !== false && f.activeCount)) return null; // activeKnown false: SFD's live page is down, flags unknown
    const act = (f.incidents || []).filter((x) => x.active);
    return hu({ cls: 'danger', href: '#safety', b: `${plural(act.length, 'active 911 incident')} nearby`, small: `${esc(act.slice(0, 2).map((x) => x.type).join(', '))}${asOf('fire911')}` });
  },
});

registerHeadsup({
  id: 'outages', order: 500,
  render(D) {
    const o = D('outages');
    return o && (o.ballard || []).length
      ? hu({ cls: 'danger', href: '#safety', b: 'Power outage in Ballard', small: `${plural(o.ballard.reduce((s, x) => s + (x.customers || 0), 0), 'customer')}${asOf('outages')}` }) : null;
  },
});

registerHeadsup({
  id: 'cso', order: 600,
  render(D) {
    const cso = D('cso');
    return cso && cso.overflowing ? hu({ cls: 'warn', href: '#water', b: 'Sewer overflow nearby', small: 'avoid water contact' }) : null;
  },
});

registerHeadsup({
  id: 'stoppages', order: 700,
  render(D) {
    const st = D('stoppages');
    return st && (st.active || []).length ? hu({ cls: 'warn', href: '#water', b: 'Locks chamber closed', small: esc(st.active[0].reason || '') }) : null;
  },
});

registerHeadsup({
  id: 'metro-alerts', order: 800,
  render(D) {
    const ma = D('metro-alerts');
    return ma && (ma.alerts || []).length
      ? hu({ cls: 'info', href: '#move', b: plural(ma.alerts.length, 'Metro alert'), small: ma.alerts.slice(0, 1).map((a) => (a.routes || []).join('/')).join('') }) : null;
  },
});

registerHeadsup({
  id: 'quakes', order: 900,
  render(D, { now }) {
    const q = D('quakes');
    const felt = q && (q.notable || []).find((e) => now - e.t < 24 * 3600e3);
    return felt ? hu({ cls: 'warn', href: '#safety', b: `M${r1(felt.mag)} earthquake`, small: `${esc(felt.place)} · ${rel(felt.t)}` }) : null;
  },
});

registerHeadsup({
  id: 'air', order: 1000,
  render(D) {
    const pa = D('purpleair');
    return pa && pa.medianAqi > 100 ? hu({ cls: 'warn', href: '#weather', b: `Air quality: ${esc(aqiInfo(pa.medianAqi).label)}`, small: `AQI ${pa.medianAqi}` }) : null;
  },
});
