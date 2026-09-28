// Feature loader. Imports a fixed list of optional modules; a missing or broken one is logged with console.info
// and skipped, never breaking the page. Each module: `export default function init(api) { ... }` (see FRONTEND.md).
// After a module imports, features/<name>.css is linked too, unless the module exports `css = false`
// (a missing stylesheet is dropped quietly).
export const FEATURES = ['activity', 'summary', 'hero', 'notify', 'prefs', 'kiosk', 'shortcuts', 'trends', 'extra-cards', 'ask', 'stories', 'foryou', 'replay', 'share'];

function linkCSS(name) {
  const id = `bl-feature-css-${name}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = new URL(`./${name}.css`, import.meta.url).href;
  link.onerror = () => link.remove();
  document.head.appendChild(link);
}

/**
 * Import every feature in parallel, then run their init(api) one by one in FEATURES order (so a later feature
 * can rely on an earlier one's registrations). Resolves with the names that initialized.
 */
export async function loadFeatures(api) {
  const mods = await Promise.all(FEATURES.map((name) => import(`./${name}.js`).then(
    (mod) => ({ name, mod }),
    (err) => ({ name, err }),
  )));
  const loaded = [];
  for (const { name, mod, err } of mods) {
    if (err) { console.info(`[features] ${name}: not loaded (${err && err.message ? err.message : err})`); continue; }
    if (mod.css !== false) linkCSS(name);
    if (typeof mod.default !== 'function') { console.info(`[features] ${name}: no default init(api) export`); continue; }
    try {
      const r = mod.default(api);
      if (r && typeof r.then === 'function') r.catch((e) => console.info(`[features] ${name}: init failed (${e && e.message ? e.message : e})`, e));
      loaded.push(name);
    } catch (e) {
      console.info(`[features] ${name}: init failed (${e && e.message ? e.message : e})`, e);
    }
  }
  return loaded;
}
