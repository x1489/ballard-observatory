// API reference for the platform's public endpoints.
import { esc } from '../ui.js';

const EP = [
  ['GET /api/obs/insights.json', 'All findings, ranked, with evidence, provenance and caveats.'],
  ['GET /api/obs/hotspots.geojson', 'Active emerging clusters (GeoJSON polygons with observed, expected, relative risk, p).'],
  ['GET /api/obs/density.geojson', 'Events per H3 resolution-9 cell over the last 90 days, by kind.'],
  ['GET /api/obs/series.json', 'Every daily series (values and metadata) used by the engines.'],
  ['GET /api/obs/relations.json', 'Every significant pairwise relationship with its test statistics.'],
  ['GET /api/obs/interactions.json', 'Every space-time interaction test (near-repeats, cascades).'],
  ['GET /api/obs/places.json', 'Development pipeline, new businesses, problem locations, restaurant inspections.'],
  ['GET /api/obs/place_index.json', 'Address index (normalized key, coordinates, record counts, sources).'],
  ['GET /api/obs/places/{shard}.json', 'Address dossiers; shard = first two hex digits of SHA-1(normalized address).'],
  ['GET /api/obs/catalog.json', 'Lake catalog: lineage, coverage, freshness, removed fields.'],
  ['GET /api/obs/concordance.json', 'Cross-agency agreement for series that record the same incidents.'],
  ['GET /api/sources', 'Live feed registry with refresh intervals and health.'],
  ['GET /api/{feed}', 'One live feed envelope: { id, title, ttl, fetchedAt, stale, error, data }.'],
  ['GET /api/stream', 'Server-sent events: hello, source, activity, metric.'],
  ['GET /api/history?keys=a,b&hours=24', 'Per-minute metric history (48 h).'],
  ['GET /api/activity?limit=200&since=t', 'Detected events from the live feeds.'],
];

export async function mount(root, { setCrumb }) {
  setCrumb('public endpoints');
  root.innerHTML = `<div class="page"><div class="page-head"><div><h2>API</h2><p>Every view in this console is built on these endpoints. Responses are JSON (GeoJSON where noted), gzip-compressed, with ETags. The full archive is also published as open Parquet.</p></div></div>
    <div class="panel"><table class="tbl"><thead><tr><th style="width:360px">Endpoint</th><th>Returns</th></tr></thead><tbody>
    ${EP.map(([e, d]) => `<tr><td class="mono">${esc(e)}</td><td>${esc(d)}</td></tr>`).join('')}</tbody></table></div>
    <div class="panel" style="margin-top:14px"><div class="panel-b prose"><h3>Querying the archive directly</h3>
    <p>The lake is plain Parquet. With DuckDB, for example: <code>SELECT kind, count(*) FROM read_parquet('lake/*/current.parquet', union_by_name=true) GROUP BY 1</code>. The typed views and the unified <code>events</code> view are defined in <code>platform/bo/views.py</code>.</p></div></div></div>`;
}
