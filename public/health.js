// Feed health: the header pill (#health-pill), the summary line and the per-feed table (#health-body).
// Rows come from core's store.sources() (/api/sources, the stream's hello, and every envelope that arrives).
import { $, esc, time, relEl } from './util.js';
import { store, connection, setHTML, on } from './core.js';

const GROUPS = { weather: 'Weather & sky', water: 'Water & Locks', move: 'Getting around', civic: 'Safety & community', extra: 'Extras' };
const every = (ttl) => (ttl >= 3600 ? Math.round(ttl / 3600) + 'h' : ttl >= 60 ? Math.round(ttl / 60) + 'm' : ttl + 's');

export function renderHealth() {
  const rows = store.sources();
  if (!rows.length) return;
  const info = store.server();
  const serverDown = connection() === 'down';
  const ok = rows.filter((s) => s.fetchedAt && !s.error).length;
  const failing = rows.filter((s) => s.error);
  const pill = $('#health-pill');
  // While the server is unreachable these rows are a snapshot from before it went away; don't show them as live.
  if (pill) {
    pill.textContent = serverDown ? 'Server offline' : `${ok}/${rows.length} feeds live`;
    pill.className = `health-pill ${serverDown || failing.length ? 'warn' : ok === rows.length ? 'ok' : ''}`;
  }
  const loadErrors = info.loadErrors || [];
  const sum = $('#health-summary');
  if (sum) {
    sum.textContent = serverDown ? `Can't reach the dashboard server. Status below is from ${info.now ? time(info.now) : 'before it went offline'}.`
      : `${ok} of ${rows.length} live${failing.length ? `, ${failing.length} with errors` : ''}${loadErrors.length ? ` · ${loadErrors.length} module load errors` : ''}`;
  }
  setHTML($('#health-body'), `<div class="health-wrap"><table class="health"><thead><tr><th>Feed</th><th>Group</th><th>Status</th><th>Updated</th><th>Refresh</th><th>Fetch</th></tr></thead><tbody>
    ${loadErrors.map((l) => `<tr><td colspan="6" class="err-note">Module ${esc(l.file)} failed to load: ${esc(l.error)}</td></tr>`).join('')}
    ${rows.map((s) => `<tr><td><b>${esc(s.title)}</b> <span class="mono tiny faint">${esc(s.id)}</span></td><td class="muted">${esc(GROUPS[s.group] || s.group)}</td>
      <td>${s.error ? `<span class="tag danger" title="${esc(s.error)}">error</span> <span class="tiny muted">${esc(String(s.error).slice(0, 90))}</span>` : s.fetchedAt ? '<span class="tag ok">ok</span>' : '<span class="tag">pending</span>'}</td>
      <td class="nowrap">${s.fetchedAt ? relEl(s.fetchedAt) : '–'}</td><td class="muted nowrap">every ${every(s.ttl)}</td>
      <td class="muted nowrap">${s.ms ? s.ms + ' ms' : ''}</td></tr>`).join('')}</tbody></table></div>`);
}

on('render', renderHealth);
