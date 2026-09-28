// Push alerts from the edge: subscriptions live in the Hub's storage; events detected as feeds update (a drawbridge
// going up or down, a fire or rescue call near Ballard, an aircraft squawking an emergency) are queued and sent a
// few at a time (the free plan allows ~50 outbound requests per invocation). Only known browser push services are
// accepted as endpoints.
import { sendPush } from './gen/sources/webpush.mjs';

export const TOPICS = {
  brief: 'Morning brief at 7:30 am',
  'bridge:Ballard': 'Ballard Bridge up / down', 'bridge:Fremont': 'Fremont Bridge up / down',
  fire: 'Fire and rescue calls near Ballard', emergency: 'Aircraft emergencies overhead',
};
const TZ = 'America/Los_Angeles';
const pacific = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute }; };
const hm = (t) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(t).replace(' AM', ' am').replace(' PM', ' pm');
const WX = (c) => (c === 0 ? 'clear' : c <= 1 ? 'mostly clear' : c === 2 ? 'partly cloudy' : c === 3 ? 'cloudy' : c <= 48 ? 'foggy' : c <= 57 ? 'drizzly' : c <= 67 ? 'rainy' : c <= 77 ? 'snowy' : c <= 82 ? 'showery' : 'stormy');
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|notify\.windows\.com|push\.apple\.com)$/;
const MAX_SUBS = 5000, PER_TICK = 30;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join(''); }
function distKm(lat1, lon1, lat2, lon2) { const R = 6371, t = Math.PI / 180, a = Math.sin(((lat2 - lat1) * t) / 2) ** 2 + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(((lon2 - lon1) * t) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); }

export class Push {
  constructor(storage, env) {
    this.st = storage; this.env = env; this.subs = null; this.queue = []; this.sent = new Set();
  }
  vapid() {
    if (!this.env.VAPID_PUBLIC || !this.env.VAPID_PRIVATE_JWK) return null;
    try { return { publicKey: this.env.VAPID_PUBLIC, privateJwk: JSON.parse(this.env.VAPID_PRIVATE_JWK), subject: this.env.SITE_URL || 'https://ballard-observatory.ballard-observatory-edge.workers.dev' }; } catch { return null; }
  }
  async load() {
    if (this.subs) return this.subs;
    this.subs = new Map();
    for (const [k, v] of await this.st.list({ prefix: 'ps:' })) this.subs.set(k.slice(3), v);
    return this.subs;
  }
  async subscribe(body) {
    const sub = body && body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { error: 'bad subscription', status: 400 };
    let host;
    try { const u = new URL(sub.endpoint); if (u.protocol !== 'https:') throw new Error(); host = u.hostname; } catch { return { error: 'bad endpoint', status: 400 }; }
    if (!PUSH_HOSTS.test(host)) return { error: 'unsupported push service', status: 400 };
    const topics = [...new Set((body.topics || []).filter((t) => t in TOPICS))];
    // Bus stop alerts: "tell me when a bus is about 5 minutes from this stop" (optionally one route).
    const watch = (Array.isArray(body.watch) ? body.watch : []).filter((w) => w && /^\d{1,7}$/.test(String(w.stop)) && (!w.route || /^\d{1,7}$/.test(String(w.route))))
      .slice(0, 5).map((w) => ({ stop: String(w.stop), route: w.route ? String(w.route) : null, name: String(w.name || '').slice(0, 80), label: String(w.label || '').slice(0, 14) }));
    const subs = await this.load();
    const id = await sha(sub.endpoint);
    if (!topics.length && !watch.length) { subs.delete(id); await this.st.delete(`ps:${id}`); this.hot = null; return { ok: true, topics: [], watch: [] }; }
    if (!subs.has(id) && subs.size >= MAX_SUBS) return { error: 'alerts are full right now', status: 503 };
    const rec = { sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }, topics, watch, created: (subs.get(id) || {}).created || Date.now() };
    subs.set(id, rec);
    this.hot = null;
    await this.st.put(`ps:${id}`, rec);
    return { ok: true, topics, watch };
  }
  async status(endpoint) {
    const subs = await this.load();
    const rec = subs.get(await sha(String(endpoint || '')));
    return { topics: rec ? rec.topics : [], watch: rec ? rec.watch || [] : [] };
  }
  /** A test notification to one subscriber (the "send me a test" button), at most once a minute. */
  async test(endpoint) {
    const vapid = this.vapid();
    if (!vapid) return { error: 'alerts not configured', status: 404 };
    const subs = await this.load();
    const id = await sha(String(endpoint || ''));
    const rec = subs.get(id);
    if (!rec) return { error: 'not subscribed', status: 404 };
    this.lastTest = this.lastTest || new Map();
    if (Date.now() - (this.lastTest.get(id) || 0) < 60e3) return { error: 'one test a minute', status: 429 };
    this.lastTest.set(id, Date.now());
    const r = await sendPush(rec.sub, { title: 'Ballard alerts are on', body: `You'll hear about: ${rec.topics.map((t) => TOPICS[t]).join(', ')}.`, url: '/#/alerts', tag: 'test' }, vapid, { ttl: 300 });
    if (r.gone) { subs.delete(id); await this.st.delete(`ps:${id}`); }
    return { ok: r.ok, status: r.ok ? 200 : 502, pushStatus: r.status };
  }
  /** Source ids to keep refreshing at their active rate because someone has an alert that depends on them. */
  async keepFresh() {
    if (this.hot) return this.hot;
    const subs = await this.load(), hot = new Set();
    for (const r of subs.values()) {
      if (r.topics.includes('fire')) hot.add('fire911');
      if (r.topics.includes('emergency')) hot.add('aircraft');
      if ((r.watch || []).length) hot.add('buses');
    }
    this.hot = hot;
    return hot;
  }
  /** Compare a source's previous and new data; queue alerts for what changed. */
  async observe(id, prev, next) {
    if (!next) return;
    const now = Date.now();
    if (id === 'bridges' && prev) {
      for (const b of next.bridges || []) {
        const was = (prev.bridges || []).find((x) => x.name === b.name);
        if (!was || was.up === b.up || !(`bridge:${b.name}` in TOPICS)) continue;
        this.enqueue(`bridge:${b.name}`, { title: `${b.name} Bridge ${b.up ? 'is going up' : 'is back down'}`,
          body: b.up ? 'Raised for a vessel; expect a short wait at the bridge.' : 'Open to traffic again.', url: `/#/bridge/${b.name}`, tag: `bridge-${b.name}` }, `br:${b.name}:${b.up}:${Math.floor(now / 60e3)}`);
      }
    }
    if (id === 'fire911') {
      const seen = new Set(((prev && prev.incidents) || []).map((x) => x.id));
      for (const x of next.incidents || []) {
        if (!x.active || seen.has(x.id) || !prev) continue;
        if (!/fire|smoke|rescue|explosion|hazmat/i.test(x.type || '') || /alarm/i.test(x.type || '')) continue;
        if (!isNum(x.lat) || distKm(x.lat, x.lon, 47.6687, -122.3847) > 2.2) continue;
        this.enqueue('fire', { title: x.type, body: `${x.address || 'Ballard'}${x.units ? ` · ${String(x.units).split(/\s+/).length} units` : ''}`, url: `/#/incident/sfd-${x.id}`, tag: `sfd-${x.id}` }, `fire:${x.id}`);
      }
    }
    if (id === 'buses') {
      const subs = await this.load();
      const watching = [...subs.entries()].filter(([, r]) => (r.watch || []).length);
      if (watching.length) {
        for (const v of next.vehicles || []) {
          for (const [stopId, , t, delay] of v.next || []) {
            const min = (t - now) / 60e3;
            if (!(min >= 3.5 && min < 7)) continue;
            const ids = watching.filter(([, r]) => r.watch.some((w) => w.stop === stopId && (!w.route || w.route === v.route))).map(([sid]) => sid);
            if (!ids.length) continue;
            const w = subs.get(ids[0]).watch.find((x) => x.stop === stopId && (!x.route || x.route === v.route));
            const late = isNum(delay) && delay >= 120 ? ` · ${Math.round(delay / 60)} min late` : '';
            this.enqueue(`stop:${stopId}`, { title: `${w.label || 'Your bus'} in ${Math.round(min)} min`, body: `${w.name || 'Your stop'}${late}`, url: `/#/bus/${v.id}`, tag: `stop-${stopId}` },
              `bus:${v.trip}:${stopId}`, ids);
          }
        }
      }
    }
    if (id === 'aircraft') {
      const had = new Set(((prev && prev.aircraft) || []).filter((a) => a.emergency).map((a) => `${a.hex}:${a.squawk}`));
      for (const a of next.aircraft || []) {
        if (!a.emergency || had.has(`${a.hex}:${a.squawk}`) || !prev || (a.distKm ?? 99) > 30) continue;
        this.enqueue('emergency', { title: `${a.callsign || a.reg || a.hex.toUpperCase()} squawking ${a.squawk}`, body: `${a.emergency} · ${a.altFt ? `${Math.round(a.altFt / 100) * 100} ft` : ''} near Ballard`,
          url: `/#/aircraft/${a.hex}`, tag: `em-${a.hex}` }, `em:${a.hex}:${a.squawk}`);
      }
    }
  }
  /** Once a day at 7:30 am Pacific: the morning brief for 'brief' subscribers. data(id) reads a live feed. */
  async morning(data, insights) {
    const now = Date.now(), p = pacific(now);
    if (p.h * 60 + p.m < 7 * 60 + 30 || p.h >= 11) return;
    if ((await this.st.get('brief:last')) === p.date) return;
    const subs = await this.load();
    if (![...subs.values()].some((r) => r.topics.includes('brief'))) { await this.st.put('brief:last', p.date); return; }
    const parts = [];
    const w = data('weather');
    if (w && w.current) {
      const d0 = (w.daily || [])[0] || {};
      parts.push(`${Math.round(w.current.tempF)}°, ${WX(w.current.code)}${isNum(d0.hiF) ? `, high ${Math.round(d0.hiF)}°` : ''}${w.rainStartsAt ? `; rain from about ${hm(w.rainStartsAt)}` : ''}`);
    }
    const odds = data('bridge-odds');
    if (odds && odds.restrictionText) parts.push(`Ballard Bridge: ${odds.restrictionText.toLowerCase()}`);
    const fire = data('fire911');
    const night = ((fire && fire.incidents) || []).filter((x) => now - x.t < 10 * 3600e3 && /fire|smoke|rescue/i.test(x.type || '') && !/alarm/i.test(x.type || ''));
    if (night.length) parts.push(`${night.length} fire or rescue call${night.length > 1 ? 's' : ''} overnight`);
    if (insights && insights.headline) parts.push(`Unusual: ${insights.headline}`);
    await this.st.put('brief:last', p.date);
    if (!parts.length) return;
    this.enqueue('brief', { title: 'Good morning, Ballard', body: parts.join(' · ').slice(0, 240), url: '/#/briefing', tag: `brief-${p.date}` }, `brief:${p.date}`);
  }
  enqueue(topic, payload, key, ids = null) {
    if (this.sent.has(key)) return;
    this.sent.add(key);
    if (this.sent.size > 4000) this.sent = new Set([...this.sent].slice(-2000));
    this.queue.push({ topic, payload, ids, idx: 0, at: Date.now() });
  }
  pending() { return this.queue.length > 0; }
  /** Send up to PER_TICK notifications; called from the Hub's alarm. */
  async drain() {
    const vapid = this.vapid();
    if (!vapid || !this.queue.length) return 0;
    const subs = [...(await this.load()).entries()];
    let budget = PER_TICK, sent = 0;
    while (this.queue.length && budget > 0) {
      const job = this.queue[0];
      if (Date.now() - job.at > 15 * 60e3) { this.queue.shift(); continue; } // stale news
      const targets = job.ids ? subs.filter(([sid]) => job.ids.includes(sid)) : subs.filter(([, r]) => r.topics.includes(job.topic));
      const batch = targets.slice(job.idx, job.idx + budget);
      await Promise.all(batch.map(async ([id, r]) => {
        try {
          const res = await sendPush(r.sub, job.payload, vapid, { ttl: 900, urgency: job.topic === 'emergency' || job.topic === 'fire' ? 'high' : 'normal', topic: job.payload.tag });
          if (res.gone) { this.subs.delete(id); this.hot = null; await this.st.delete(`ps:${id}`); } else if (res.ok) sent++;
        } catch { /* try the next one */ }
      }));
      budget -= batch.length; job.idx += batch.length;
      if (job.idx >= targets.length) this.queue.shift();
    }
    return sent;
  }
}
