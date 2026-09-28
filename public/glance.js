// Built-in glance tiles (the row of big numbers under the header). Each is a registerTile() def; core renders
// them in `order` on every batch and flashes values marked with a key when they change.
import { registerTile, tile, asOf } from './core.js';
import { esc, isNum, r0, r1, time, rel, wxIcon, wxText, aqiInfo, plural } from './util.js';
import { etaText, liveGroups, tideAt, nextTides, rainTimes, dailyFrom } from './cards.js';

/** '6 <small>min</small>', or just 'now' (not 'now min'). */
export const etaHtml = (t, now = Date.now()) => { const v = etaText(t, now); return v === 'now' ? v : `${v} <small>min</small>`; };

registerTile({
  id: 'weather', order: 100,
  render(D, { now }) {
    const w = D('weather');
    if (!(w && w.current)) return tile({ href: '#weather', k: 'Weather', v: '…', s: 'loading' });
    const d0 = dailyFrom(w, now)[0] || {};
    const rt = rainTimes(w, now);
    const rain = isNum(rt.startsAt) ? `rain ~${time(rt.startsAt)}` : isNum(rt.endsAt) ? `rain easing ~${time(rt.endsAt)}` : (w.current.precipIn > 0 ? 'raining' : 'dry next 3h');
    return tile({ href: '#weather', k: 'Weather', v: `${wxIcon(w.current.code, w.current.isDay)} ${r0(w.current.tempF)}°`, s: `${esc(wxText(w.current.code))} · H${r0(d0.hiF)} L${r0(d0.loF)} · ${rain}${asOf('weather')}`, key: 'weather' });
  },
});

registerTile({
  id: 'bridge', order: 200,
  render(D) {
    const b = D('bridges');
    const bb = b && (b.bridges || []).find((x) => /ballard/i.test(x.name));
    if (!bb) return tile({ href: '#water', k: 'Ballard Bridge', v: '…', s: 'loading' });
    return tile({
      href: '#water', k: 'Ballard Bridge', v: bb.up ? 'UP' : 'Down',
      s: (bb.up ? `Raised for boats${bb.sinceKnown ? ' · ' + rel(bb.since) : ''}` : `Open to traffic${bb.sinceKnown && isNum(bb.since) ? ' since ' + time(bb.since) : ''}`) + asOf('bridges'),
      cls: bb.up ? 'alert' : 'good', key: 'bridge',
    });
  },
});

registerTile({
  id: 'transit', order: 300,
  render(D, { now }) {
    const tr = D('transit');
    if (!tr) return tile({ href: '#move', k: 'Buses', v: '…', s: 'loading' });
    const g = liveGroups(tr, now);
    const dSouth = g.find((x) => x.route === 'D Line' && /downtown/i.test(x.dir || x.headsign || ''));
    const others = g.filter((x) => x !== dSouth && x.route !== 'D Line').slice(0, 2);
    const first = dSouth && dSouth.arrivals[0];
    // No live key: the ETA counts down on its own (data-eta), a flash every minute would be noise.
    return tile({
      href: '#move', k: 'D Line → Downtown', v: first ? `<span data-eta="${first.t}" data-eta-min="1">${etaHtml(first.t)}</span>` : '—',
      s: (others.map((x) => `${esc(x.route)} ${esc((x.dir || x.headsign || '').replace(/^to /, '→ '))} <span data-eta="${x.arrivals[0].t}" data-eta-unit="m">${etaText(x.arrivals[0].t)}${etaText(x.arrivals[0].t) === 'now' ? '' : 'm'}</span>`).join(' · ') || 'no other buses soon') + asOf('transit'),
    });
  },
});

registerTile({
  id: 'tide', order: 400,
  render(D, { now }) {
    const td = D('tides');
    if (!td) return null;
    const nx = nextTides(td, now)[0];
    const cur = tideAt(td, now);
    return tile({ href: '#water', k: 'Tide', v: `${r1(cur.ft)} <small>ft ${cur.trend === 'rising' ? '↑' : cur.trend === 'falling' ? '↓' : ''}</small>`, s: nx ? `${nx.type === 'H' ? 'High' : 'Low'} ${r1(nx.ft)} ft at ${time(nx.t)}` : '' });
  },
});

registerTile({
  id: 'air', order: 500,
  render(D) {
    const pa = D('purpleair'), an = D('airnow');
    const aqi = pa && isNum(pa.medianAqi) ? pa.medianAqi : an && (an.observed || []).find((o) => o.primary)?.aqi;
    if (!isNum(aqi)) return null;
    const i = aqiInfo(aqi);
    return tile({ href: '#weather', k: 'Air quality', v: `<span style="color:${i.color}">●</span> ${r0(aqi)}`, s: `${esc(i.label)} · AQI${asOf(pa && isNum(pa.medianAqi) ? 'purpleair' : 'airnow')}`, cls: aqi > 100 ? 'alert' : '', key: 'air' });
  },
});

registerTile({
  id: 'sun', order: 600,
  render(D, { now }) {
    const sky = D('sky');
    if (!(sky && sky.sun)) return null;
    const { rise, set } = sky.sun;
    let k = 'Sunset', t = set;
    if (isNum(rise) && now < rise) { k = 'Sunrise'; t = rise; } else if (isNum(set) && now > set) { k = 'Sunrise'; t = sky.tomorrowSun && sky.tomorrowSun.rise; }
    return tile({ href: '#weather', k, v: time(t), s: `${rel(t)}${sky.moon ? ` · moon ${r0(sky.moon.illum)}%` : ''}` });
  },
});

registerTile({
  id: 'locks', order: 700,
  render(D) {
    const lk = D('lockages'), lake = D('lake');
    if (!(lk || lake)) return null;
    return tile({ href: '#water', k: 'Ballard Locks', v: `${lk ? r0(lk.today && lk.today.total) : '–'} <small>lockages</small>`, s: `${lk && lk.queued ? plural(lk.queued, 'vessel') + ' waiting · ' : ''}lake ${lake && isNum(lake.ft) ? lake.ft.toFixed(2) + ' ft' : '–'}${asOf('lockages')}`, key: 'locks' });
  },
});

registerTile({
  id: 'fire', order: 800,
  render(D) {
    const f = D('fire911');
    if (!f) return null;
    if (f.activeKnown === false) return tile({ href: '#safety', k: 'Fire & medical 911', v: '– <small>active</small>', s: `active status unavailable · ${plural((f.incidents || []).length, 'call')} in 24h${asOf('fire911')}` });
    return tile({ href: '#safety', k: 'Fire & medical 911', v: `${f.activeCount || 0} <small>active</small>`, s: `${plural((f.incidents || []).length, 'call')} in 24h${f.incidents && f.incidents[0] ? ` · latest ${rel(f.incidents[0].t)}` : ''}${asOf('fire911')}`, cls: f.activeCount ? 'alert' : '', key: 'fire' });
  },
});
