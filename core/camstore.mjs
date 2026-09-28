// Camera time-lapse store. After each refresh of the `cameras` source the server calls capture(); every OK
// camera whose Last-Modified changed has its still saved as <dir>/<camId>/<t>.jpg, keeping the newest `keep`
// frames per camera (~3 h at the 2-minute refresh). Frames are immutable, so they're served with long caching.
//   list(labels?) -> { cameras: [{ id, label, frames: [t, ...] }] }     file(id, t) -> absolute path | null
import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9-]{1,32}$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function createCamStore({ dir, keep = 90, fetchImage, minBytes = 31000, log = console } = {}) {
  const index = new Map(); // id -> ascending [t]
  let busy = false;

  function load() {
    index.clear();
    let ids = [];
    try { ids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name); } catch { return; }
    for (const id of ids) {
      let files = [];
      try { files = fs.readdirSync(path.join(dir, id)); } catch { continue; }
      const ts = files.map((f) => /^(\d{10,14})\.jpg$/.exec(f)).filter(Boolean).map((m) => +m[1]).sort((a, b) => a - b);
      index.set(id, ts);
    }
  }

  function prune(id) {
    const ts = index.get(id) || [];
    while (ts.length > keep) {
      const t = ts.shift();
      fs.promises.unlink(path.join(dir, id, `${t}.jpg`)).catch(() => {});
    }
  }

  /** Save new stills for the given cameras ([{ id, url, lastModified, ok }]). Returns the number saved. */
  async function capture(cameras) {
    if (busy || !Array.isArray(cameras) || typeof fetchImage !== 'function') return 0;
    busy = true;
    let saved = 0;
    try {
      for (const c of cameras) {
        if (!c || !c.ok || !ID_RE.test(String(c.id)) || !isNum(c.lastModified) || !c.url) continue;
        const ts = index.get(c.id) || [];
        if (ts.includes(c.lastModified)) continue;
        let buf;
        try { buf = await fetchImage(c.url); } catch (err) { log.warn(`[cams] ${c.id}: ${err && err.message || err}`); continue; }
        // A real JPEG, and not SDOT's small "camera under maintenance" placeholder.
        if (!buf || buf.length < minBytes || buf[0] !== 0xff || buf[1] !== 0xd8) continue;
        const d = path.join(dir, c.id);
        await fs.promises.mkdir(d, { recursive: true });
        const file = path.join(d, `${c.lastModified}.jpg`);
        await fs.promises.writeFile(`${file}.tmp`, buf);
        await fs.promises.rename(`${file}.tmp`, file);
        ts.push(c.lastModified);
        ts.sort((a, b) => a - b);
        index.set(c.id, ts);
        prune(c.id);
        saved++;
      }
    } finally {
      busy = false;
    }
    return saved;
  }

  function list(labels = {}) {
    return { cameras: [...index.entries()].map(([id, frames]) => ({ id, label: labels[id] || id, frames: frames.slice() })) };
  }

  function file(id, t) {
    if (!ID_RE.test(String(id)) || !/^\d{10,14}$/.test(String(t))) return null;
    const ts = index.get(id);
    if (!ts || !ts.includes(+t)) return null;
    return path.join(dir, id, `${t}.jpg`);
  }

  return { load, capture, list, file, get size() { let n = 0; for (const ts of index.values()) n += ts.length; return n; } };
}
