// Methods: how every number on the platform is produced, with the statistical safeguards and their calibration.
import { esc } from '../ui.js';

export async function mount(root, { args, setCrumb }) {
  setCrumb('methodology');
  root.innerHTML = `<div class="page"><div class="page-head"><div><h2>Methods</h2><p>How the platform turns raw public records into findings, and the safeguards that keep false discoveries rare.</p></div></div>
  <div class="panel"><div class="panel-b prose">
  <h3 id="pipeline">Data pipeline</h3>
  <p>Connectors pull each public source on a schedule. Event datasets are backfilled month by month from their first record, then refreshed over a rolling window that also covers the running month; snapshot datasets (licenses, rosters) are pulled whole and diffed, so openings and closures are recorded as they happen. Every pull is stored as an immutable, change-only Parquet batch (a record is stored again only when its content hash changes), compacted into a current table, and typed in SQL views. Personal fields (for example liquor-license applicants' names and birthdates, sole proprietors' names, phone numbers) are dropped before anything is written. Upstream redactions (for example SPD's redacted locations) are preserved.</p>
  <h3 id="series">Series</h3>
  <p>Events are aggregated into daily series per category (police calls by type group, crimes by NIBRS group, fire dispatches by type, 311 requests, permits, bridge openings) and joined with weather, tides, bike counts, parking payments and attention (Wikipedia) series. Outside a dataset's coverage a value is unknown, never zero. Police call types are grouped by ordered patterns (officer-initiated activity and alarms first) to avoid mixing categories.</p>
  <h3 id="relationships">Relationships (all pairs)</h3>
  <ul><li>Residuals: counts are variance-stabilized (Anscombe); slow drift and seasons are removed with a 57-day local-linear smoother; weekday effects are removed locally (the same weekday over ±8 weeks, also local-linear) so weekday patterns that change with the season can't leak through; federal holidays are adjusted; residuals are winsorized at ±4 SD.</li>
  <li>Test: the maximum cross-correlation over lags −7…+7 days, compared with a null built from circular shifts of one series by multiples of 7 days (≥ 30 days away), which preserves each series' full autocorrelation and weekday alignment. The p-value uses the null's spread with a Šidák correction for the 15 lags tried, and the empirical exceedance rate when that is larger.</li>
  <li>Multiple testing: Benjamini–Hochberg FDR over every pair tested (q ≤ 0.01 to report).</li>
  <li>Replication: the same sign and significance (p &lt; 0.05) must hold in both halves of the overlapping record for high confidence.</li>
  <li>Common drivers: the partial correlation after removing temperature, rain, rain hours, cloud, sunshine, wind and holidays is reported; associations mostly explained by weather are labeled.</li>
  <li>Excluded by design: a total vs its own parts; weather-vs-weather physics; one bridge's openings vs its minutes open; and the same incidents recorded by two agencies (reported separately as concordance).</li>
  <li>Calibration (automated tests): independent series with strong persistence (AR 0.9) and shared seasonality produce ≤ 9 % rejections at α = 0.05 (a naive Pearson test rejects > 30 %); independent series sharing a season-varying weekend pattern produce ≤ 10 %; a planted two-day lag is found with p &lt; 10⁻⁴.</li></ul>
  <h3 id="anomalies">Anomalies (recent unusual activity)</h3>
  <p>For each count series, a quasi-Poisson model of the previous three years (weekday, two annual harmonics, trend frozen at the end of training) gives the expected count for the last 7 and 28 complete days; tails use the fitted overdispersion; BH-FDR across all series and windows (q ≤ 0.05, and at least ±25 %). Crime counts by offense date are nowcast: the expected value for recent days is multiplied by the share of offenses normally reported by then (from the empirical offense-to-report delay distribution). Near-total drops are labeled as possible reporting outages or closures.</p>
  <h3 id="changes">Structural changes</h3>
  <p>Monthly aggregates over five years, adjusted for month-of-year effects; the single most likely level shift (a CUSUM-type statistic) is tested against 999 block permutations (blocks of 3 months). Reported when p ≤ 0.01, the shift is at least 15 % and it began within 24 months. If the category's parent total did not move correspondingly, the shift is flagged as possibly reflecting categorization or response-policy changes.</p>
  <h3 id="hotspots">Emerging hotspots</h3>
  <p>The prospective space-time permutation scan statistic (Kulldorff et al., PLoS Medicine 2005): H3 resolution-9 cells (~0.1 km²) and their k-ring neighborhoods (k = 0–2), windows ending at the most recent complete day (3, 7, 14, 28 days), expected counts from space and time marginals of the last 365 days (no population data needed), a Poisson likelihood ratio, and 199 Monte Carlo replicates in which event dates are shuffled among events. Non-overlapping clusters with p ≤ 0.05 are reported with their recurrence interval.</p>
  <h3 id="space-time">Near-repeats and cascades</h3>
  <p>The Knox space-time interaction test: pairs of events within a distance and time window are counted and compared with 199 permutations of event dates (locations fixed), which keeps where and when things happen but breaks any link between them. For complaint-type data, pairs at the same spot (&lt; 30 m) are excluded so that repeated reports of one problem don't count as spread. Near-repeats use one event type; cascades use two. BH-FDR across all tests (q ≤ 0.01, ratio ≥ 1.1).</p>
  <h3 id="places">Place intelligence</h3>
  <p>Addresses are normalized (case, suffixes, directionals, unit numbers) so that records from different agencies about the same building line up; each address gets a dossier of every agency's records plus incident volumes within ~100 m (its H3 resolution-10 cell and neighbors) over the last 12 months. Persistent problem locations have ≥ 3 events in at least 3 of the last 4 quarters; emerging ones have a last quarter far above their own history (Poisson p &lt; 0.001).</p>
  <h3 id="rendering">Map rendering</h3>
  <p>King County orthophotography (EagleView, 2025; historical surveys back to 1936) draped on Mapzen terrain; buildings extruded from OpenStreetMap heights; scene light positioned at the actual solar azimuth and elevation over Ballard and updated every minute; sky color from the solar elevation; aircraft drawn at their reported barometric altitude from ADS-B; weather radar from NEXRAD. No element of the scene is synthetic.</p>
  <h3 id="limits">Limitations</h3>
  <ul><li>Associations are not causes; unmeasured common drivers remain possible.</li><li>Public records carry their agencies' coverage, lags and coding practices; redacted locations are absent from spatial analyses.</li>
  <li>Real-time history (bus delays, travel times, live bridge state) accumulates from the moment the platform began archiving it.</li></ul>
  </div></div></div>`;
  if (args[0]) { const el = root.querySelector(`#${CSS.escape(args[0])}`); if (el) el.scrollIntoView({ block: 'start' }); }
}
