# water, tides & the Locks

## noaa-tide-hilo-seattle (poll 21600)
URL: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9447130&product=predictions&begin_date=20260924&range=48&datum=MLLW&units=english&time_zone=lst_ldt&interval=hilo&format=json&application=ballard_dashboard
NOTES: No key. The server must build begin_date from the Pacific local date (YYYYMMDD); range=48 is in hours. Add application=<name> as NOAA asks. Errors come back as HTTP 200 with {"error":{"message":...}}, so check for the error key. Every value is a string.
FORMAT: JSON
FIELDS: predictions[].t = local time 'YYYY-MM-DD HH:mm' (lst_ldt = PST/PDT, no offset in string); predictions[].v = height in ft above MLLW (a string, so parseFloat it); predictions[].type = 'H' or 'L'. Next tide = the first entry with t > now.
SAMPLE: { "predictions" : [
{"t":"2026-09-24 03:42", "v":"9.258", "type":"H"},{"t":"2026-09-24 09:59", "v":"1.133", "type":"L"},{"t":"2026-09-24 16:46", "v":"10.899", "type":"H"},{"t":"2026-09-24 22:51", "v":"3.763", "type":"L"},{"t":"2026-09-25 04:27", "v":"9.73", "type":"H"},...]}
FRESH: Predictions, so always current. Covered 2026-09-24 00:00 to 2026-09-25 23:17 local; checked at 2026-09-25 02:33 UTC (2026-09-24 19:33 PDT).

## noaa-tide-hilo-shilshole (poll 21600)
URL: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9447265&product=predictions&begin_date=20260924&range=48&datum=MLLW&units=english&time_zone=lst_ldt&interval=hilo&format=json&application=ballard_dashboard
NOTES: Subordinate station (type S, reference 9447130). interval=6 returns an error here ('No Predictions data was found'), so draw the curve from Seattle 9447130's 6-minute predictions.
FORMAT: JSON
FIELDS: Same fields as the Seattle hilo source: predictions[].t (local), .v (ft MLLW, string), .type H/L
SAMPLE: { "predictions" : [
{"t":"2026-09-24 03:42", "v":"9.073", "type":"H"},{"t":"2026-09-24 09:58", "v":"1.122", "type":"L"},{"t":"2026-09-24 16:46", "v":"10.681", "type":"H"},{"t":"2026-09-24 22:50", "v":"3.726", "type":"L"},{"t":"2026-09-25 04:27", "v":"9.535", "type":"H"}...]}
FRESH: Predictions for 2026-09-24 and 2026-09-25, verified 2026-09-25 02:40 UTC

## noaa-tide-curve-seattle (poll 3600)
URL: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9447130&product=predictions&date=today&datum=MLLW&units=english&time_zone=lst_ldt&interval=6&format=json&application=ballard_dashboard
NOTES: date=today follows the time_zone parameter (local day). For a rolling 24h view use begin_date/range instead. Heights are the Seattle waterfront; Shilshole runs about 0.2 ft lower at highs.
FORMAT: JSON
FIELDS: predictions[].t (local 'YYYY-MM-DD HH:mm'), predictions[].v (ft MLLW, string). No type field.
SAMPLE: { "predictions" : [
{"t":"2026-09-24 00:00", "v":"5.586"},{"t":"2026-09-24 00:06", "v":"5.69"},{"t":"2026-09-24 00:12", "v":"5.799"},... {"t":"2026-09-24 23:54", "v":"4.256"}]}
FRESH: 240 points for 2026-09-24 local, verified 2026-09-25 02:33 UTC

## noaa-water-level-observed (poll 360)
URL: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9447130&product=water_level&date=latest&datum=MLLW&units=english&time_zone=lst_ldt&format=json&application=ballard_dashboard
NOTES: Data is preliminary (q=p). The gauge is on the downtown Seattle waterfront, about 8 km from Ballard. Salt water only: it does not reflect the Ship Canal or Salmon Bay above the Locks (see usace-lwsc-lake-level).
FORMAT: JSON
FIELDS: metadata.name/lat/lon; data[0].t (local time), data[0].v (ft MLLW, string), data[0].s (sigma), data[0].q ('p' = preliminary). For a curve, change date=latest to range=24 (239 points at 6-minute spacing). Compare with the prediction at the same t to get the surge or anomaly.
SAMPLE: {"metadata":{"id":"9447130","name":"Seattle","lat":"47.6026","lon":"-122.3393"},"data":[{"t":"2026-09-24 19:24", "v":"9.093", "s":"0.059", "f":"0,0,0,0", "q":"p"}]}
FRESH: Latest 2026-09-24 19:36 PDT, checked at 19:47 PDT (lag of about 10 minutes)

## noaa-air-pressure-seattle (poll 600)
URL: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9447130&product=air_pressure&date=latest&units=english&time_zone=lst_ldt&format=json&application=ballard_dashboard
NOTES: Units are mb even with units=english.
FORMAT: JSON
FIELDS: data[0].t (local), data[0].v (mb/hPa, string, even with units=english)
SAMPLE: {"metadata":{"id":"9447130","name":"Seattle","lat":"47.6026","lon":"-122.3393"},"data":[{"t":"2026-09-24 19:24", "v":"1008.0", "f":"0,0,0"}]}
FRESH: 2026-09-24 19:24 PDT, checked at 19:33 PDT

## ndbc-wpow1-west-point (poll 600)
URL: https://www.ndbc.noaa.gov/data/realtime2/WPOW1.txt
NOTES: Times are UTC. No key. Parse by splitting on whitespace and skip lines that start with #.
FORMAT: Whitespace-delimited text. Two header lines start with #; newest row first; about 45 days of rows (1085 lines).
FIELDS: Columns: YY MM DD hh mm (UTC) WDIR(degT) WSPD(m/s) GST(m/s) WVHT DPD APD MWD PRES(hPa) ATMP(degC) WTMP DEWP VIS PTDY(hPa pressure tendency) TIDE. 'MM' = missing. Convert m/s to kt (x1.944) or mph (x2.237), and C to F. For 10-minute wind use https://www.ndbc.noaa.gov/data/realtime2/WPOW1.cwind (YY MM DD hh mm WDIR WSPD GDR GST GTIME; 999/99.0 = missing). A human-readable latest is at https://www.ndbc.noaa.gov/data/latest_obs/wpow1.txt.
SAMPLE: #YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 09 25 02 00 360  4.6  4.6    MM    MM    MM  MM 1009.2  13.4    MM    MM   MM -1.1    MM
2026 09 25 01 00  10  5.7  6.2    MM    MM    MM  MM 1009.5  13.7    MM    MM   MM -0.8    MM
FRESH: Latest row 2026-09-25 02:00 UTC, checked at 02:36 UTC

## noaa-currents-west-point (poll 21600)
URL: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=PUG1515&bin=1&product=currents_predictions&begin_date=20260924&range=48&units=english&time_zone=lst_ldt&interval=MAX_SLACK&format=json&application=ballard_dashboard
NOTES: The bin parameter is required for this multi-bin station. Velocity_Major is a number, unlike tide v values.
FORMAT: JSON
FIELDS: current_predictions.cp[].Time (local), .Type ('slack'|'flood'|'ebb'), .Velocity_Major (knots; + = flood, - = ebb), .meanFloodDir / .meanEbbDir (deg true), .Depth (ft)
SAMPLE: {"current_predictions":{"units":"feet, knots","cp":[{"Type":"slack","meanFloodDir":228,"Bin":"1","meanEbbDir":21,"Time":"2026-09-24 03:07","Depth":"108","Velocity_Major":-0},{"Type":"ebb",...,"Time":"2026-09-24 05:06","Velocity_Major":-0.41},{"Type":"flood",...,"Time":"2026-09-24 12:19","Velocity_Major":0.88}...]}
FRESH: Predictions for 2026-09-24 to 2026-09-25 (15 events, last 2026-09-25 20:09)

## usace-lwsc-lake-level (poll 900)
URL: https://www.nwd-wc.usace.army.mil/dd/common/web_service/webexec/getjson?query=%5B%22LWSC.Elev-Lake.Inst.15Minutes.0.IRIDIUM-REV%22%2C%22LWSC.Flow.Ave.~1Day.1Day.CENWS-COMPUTED-RAW%22%5D&backward=2d&timezone=GMT
NOTES: Timezone quirk: without a timezone parameter, or with timezone=UTC, times come back in fixed PST (UTC-8, no DST) even though the label says 'UTC'. Only timezone=GMT gives real UTC. Timestamps have no offset suffix. The query value is a URL-encoded JSON array of tsids. Catalog: ?tscatalog=["LWSC"]. The national CWMS Data API (cwms-data.usace.army.mil) has no NWS-office data, so use this endpoint.
FORMAT: JSON
FIELDS: LWSC.timeseries['LWSC.Elev-Lake.Inst.15Minutes.0.IRIDIUM-REV'].values[] = [isoTime, value_ft, qualityInt]. Take the last element for the current lake level in ft (USACE local datum; readings were about 20.15 ft). The .units, .end_timestamp, .min_value and .max_value fields also exist. LWSC.timeseries['LWSC.Flow.Ave.~1Day.1Day.CENWS-COMPUTED-RAW'].values[] = [isoTime, cfs, q] gives the daily average outflow through the Locks (226.7 cfs for the day ending 2026-09-24T07:00Z). Other tsids: LWSC.Elev-Lake.Ave.1Hour.1Hour.IRIDIUM-REV (hourly average), LWSC.Flow-In.Ave.~1Day.1Day.CENWS-COMPUTED-RAW (daily inflow, which can be negative), LWSC.Elev-Lake-0000h.Inst.~1Day.0.CENWS-MANUAL-RAW (daily manual reading).
SAMPLE: {"LWSC":{"name":"Lake Washington Ship Canal","coordinates":{"latitude":47.6649153,"longitude":-122.3945712},"elevation":{"datum":"LOCAL","value":20.0},"timezone":"GMT","timeseries":{"LWSC.Elev-Lake.Inst.15Minutes.0.IRIDIUM-REV":{"units":"ft","end_timestamp":"2026-09-25T02:00:00","values":[...,["2026-09-25T01:30:00",20.15,0],["2026-09-25T02:00:00",20.15,0]]},"LWSC.Flow.Ave.~1Day.1Day.CENWS-COMPUTED-RAW":{"units":"cfs","values":[["2026-09-24T07:00:00",226.728701,0]]}}}}
FRESH: Latest elevation 2026-09-25T02:00Z, checked at 02:47Z (47 minutes). Daily flow is about one day behind.

## usace-lpms-chittenden-lockages (poll 300)
URL: https://ndc.ops.usace.army.mil/ords/lpms/json/lock_queue_json?in_river=WS&in_lock=01
NOTES: RATE LIMIT: 5 requests per minute per IP across all LPMS endpoints; over the limit you get {"error": "Rate limit exceeded. Maximum 5 requests per minute allowed."}. The payload is about 240 KB, so cache it server-side. The timezone field says 'PST', but the times are Pacific local wall-clock (PDT in summer): 19:22 was already in the past at 19:33 PDT. Dates use 2-digit years. Lock 02 (small chamber) returns []. The old host corpslocks.usace.army.mil no longer resolves; the service moved to ndc.ops.usace.army.mil/ords.
FORMAT: JSON array (served with Content-Type text/html)
FIELDS: [].vesselName (e.g. 'RECREATIONAL VESSEL' with vesselNo 9999999, 'COMM OTHER' with 5555555, or a real name such as 'POLAR RANGER '; trim it), [].vesselNo, [].MMSI (number or null), [].direction ('U' = upbound into the Ship Canal/Lake, 'D' = downbound to Puget Sound), [].arrivalDate, [].SOLdate (start of lockage), [].endOfLockage ('MM/DD/YY HH:mm'; null while a vessel is still queued or locking), [].numBarges, [].timezone. The array is NOT sorted, so sort by arrivalDate descending. Derived widgets: last lockage, lockages today by direction, vessels waiting (endOfLockage null), average wait (SOL minus arrival). Companion endpoints (same 5 req/min limit): https://ndc.ops.usace.army.mil/ords/lpms/lock_delay_json gives the 4h and 24h average delay; its JSON is malformed (a missing quote after the four-hour value), so pull it out with a regex on '"riverCode": "WS"'. https://ndc.ops.usace.army.mil/ords/lpms/json/traffic_report?in_river=WS&in_lock=01 is the same data with lockName 'HIRAM M CHITTENDEN LOCKS'.
SAMPLE: [{"vesselName":"POLAR RANGER ","vesselNo":"0569925","direction":"U","numBarges":0,"SOLdate":"09/19/26 09:36","arrivalDate":"09/19/26 09:30","endOfLockage":"09/19/26 10:04","timezone":"PST","MMSI":367090860}, ... {"vesselName":"RECREATIONAL VESSEL","vesselNo":"9999999","direction":"D","numBarges":0,"SOLdate":"09/24/26 19:07","arrivalDate":"09/24/26 19:04","endOfLockage":"09/24/26 19:22","timezone":"PST","MMSI":null}]
FRESH: Latest endOfLockage 09/24/26 19:22 local, checked at 19:33 PDT (2026-09-25 02:33 UTC)

## usace-lpms-stoppages (poll 1800)
URL: https://ndc.ops.usace.army.mil/ords/lpms/stall_stoppage_json
NOTES: Shares the 5 req/min LPMS limit. The optional begin_date and end_date use DDMMYYYY and the range must be under 6 months, otherwise the plain-text reply is 'Please select a date range of less than 6 months!'.
FORMAT: JSON array (nationwide, about 7 KB with no parameters)
FIELDS: Filter riverCode=='WS'. Fields: eroc ('G3' = Seattle District), lockNumber, chamberNumber, beginStopDate / endStopDate ('MM/DD/YYYY HH:mm:ss PDT', with the zone in the string), isScheduled, reasonCode, trafficStopped ('Y'/'N'), refreshDate (GMT).
SAMPLE: {"eroc": "G3", "riverCode": "WS", "lockNumber": "01", "chamberNumber": "4", "beginStopDate": "03/31/2026 18:00:00 PDT", "endStopDate": "04/01/2026 04:18:00 PDT", "isScheduled": "Yes", "reasonCode": "Maintaining lock or lock equipment", "numHwCycles": 2, "year": 2026, "refreshDate": "09/25/2026 02:59:14 GMT", "trafficStopped": "Y"}
FRESH: refreshDate 2026-09-25 02:59:14 GMT (live at the time of the probe); no active WS stoppage right now

## sdot-bridge-status-live (poll 20)
URL: https://web.seattle.gov/Travelers/api/Map/GetBridgeData
NOTES: No key. Sent a browser-like User-Agent (Mozilla/5.0). Cache-Control is no-cache. There is no timestamp, so the server should record transition times itself to show 'opened N min ago'. The same array is served at /Travelers/api/Map/GetBridgesByNeighborhood?neighborhood=Ballard. Seattle bridges generally do not open for recreational boats during weekday rush hours, so expect Closed then.
FORMAT: JSON, double-encoded: the body is a JSON string that contains a JSON array
FIELDS: JSON.parse(JSON.parse(body)) returns []. Each item has .BridgeID (2 = Ballard, 3 = Fremont, 4 = Montlake, 1 = 1st Ave S, 29 = South Park), .DisplayName, .Latitude, .Longitude, .Name, .Status. Status 'Open' means raised: open to boats, closed to traffic. 'Closed' means down: open to cars.
SAMPLE: "[{\"BridgeID\":2,\"DisplayName\":\"Ballard\",\"Latitude\":47.659815735813133,\"Longitude\":-122.37618949046208,\"Name\":\"Bridge_Ballard.Input01\",\"Status\":\"Closed\"},{\"BridgeID\":3,\"DisplayName\":\"Fremont\",\"Latitude\":47.64760335277019,\"Longitude\":-122.34973031435234,\"Name\":\"Bridge_Fremont.Input01\",\"Status\":\"Open\"},...]"
FRESH: Real-time (state only, no timestamp). A status change was observed at 2026-09-25 02:56 UTC.

## sdot-drawbridge-history (poll 3600)
URL: https://data.seattle.gov/resource/gm8h-9449.json?$where=entityname%20in('Ballard','Fremont')&$order=opendatetime%20DESC&$limit=50
NOTES: No app token needed at low volume. URL-encode the $ parameters. Per the dataset notes, sensors can record one opening as several open/close events. SDOT's note says openings are not checked before publishing and some may be missing.
FORMAT: JSON (Socrata SODA)
FIELDS: [].entityname ('Ballard'|'Fremont'|'Montlake'|'University'|'1st Ave South'|'South Park'|'Lower Spokane St'), .entityid, .entitytype, .opendatetime (floating local time, no zone), .closedatetime, .minutesopen (string), .latitude, .longitude. Aggregate with $select=date_trunc_ymd(opendatetime) as day, entityname, count(*) as n&$group=day,entityname.
SAMPLE: [{"entitytype":"Bridge","entityname":"Fremont","entityid":"3","opendatetime":"2026-09-23T22:35:00.000","closedatetime":"2026-09-23T22:39:00.000","minutesopen":"4","latitude":"47.64760208129883","longitude":"-122.3497314453125"},{"entitytype":"Bridge","entityname":"Ballard","entityid":"2","opendatetime":"2026-09-23T22:20:00.000","closedatetime":"2026-09-23T22:23:00.000","minutesopen":"3",...}]
FRESH: Newest row 2026-09-23 22:35 local. rowsUpdatedAt 2026-09-24 10:02 UTC (03:02 PDT). About 1 day behind.

## wdfw-ballard-salmon-counts (poll 21600)
URL: https://wdfw.wa.gov/fishing/reports/counts/lake-washington
NOTES: No key. Sent a browser-like User-Agent. The data year is the table caption. Mark counts preliminary. Sockeye also has a JSON feed (see wdfw-sockeye-json) but coho and Chinook do not.
FORMAT: HTML (Drupal)
FIELDS: Three tables by id: table#lw-coho-counts, table#lw-chinook-counts, table#lw-sockeye-counts. Each has caption '2026 daily counts' and tbody rows of <td>Date M/D</td><td>Daily Count</td><td>Running Total</td>. Numbers use comma thousands separators. The first row can be a range such as '6/12-8/31' (coho) or '6/18-6/30' (Chinook). Future dates are pre-filled with empty daily-count cells: coho repeats the running total in them, Chinook leaves both blank. So latest count = last row whose 2nd cell is non-empty. There is also an 'Annual sockeye counts' table (Year, Total Count, 1972-2025) with no id.
SAMPLE: <table id="lw-coho-counts"><caption>2026 daily counts</caption>... parsed rows: ['6/12-8/31','420','420'], ... ['9/19','123','10,284'], ['9/20','151','10,435'], ['9/21','','10,435'] ... | lw-chinook-counts: ... ['9/18','76','14,444'], ['9/19','0','14,444'], ['9/20','0','14,444'], ['9/21','',''] | lw-sockeye-counts: ... ['9/10','0','31,302']
FRESH: Latest counted day 9/20/2026, checked on 9/24 (about a 4-day posting lag). Page Last-Modified 2026-09-25 02:15 GMT (cache max-age 900).

## kc-cso-status (poll 600)
URL: https://your.kingcounty.gov/dnrp/library/wastewater/cso/img/CSO_metadata.CSV
NOTES: Served as application/octet-stream. At probe time every real outfall was NoRecentOverflow or NoData, which is normal in dry weather. Only the dummy legend rows showed overflow states. Found through the ArcGIS web map 'Combined Sewer Overflow Status- Operating' (item 6de3cae45d914326a32ed120b5ace4f8).
FORMAT: CSV with header row
FIELDS: CSO_TagName, X_COORD (lon), Y_COORD (lat), Name ('King County CSO: Ballard' or 'Seattle CSO'), DSN (outfall number), DateTime ('MM/DD/YYYY HH:mm' Pacific local), Status: 'CurrentlyOverflowing' | 'OverflowLast48hrs' | 'NoRecentOverflow' | 'NoData'. Drop the first 4 legend rows (CSO_TagName CSO_Status1..4, Name Dummy1..4, X=-120.0). Filter Ballard with lat 47.64-47.71 and lon -122.43 to -122.34.
SAMPLE: CSO_TagName,X_COORD,Y_COORD,Name,DSN,DateTime,Status
CSO_Status1,-120.0,47.66,Dummy1,DSN,09/24/2026 19:40,CurrentlyOverflowing
...
BALL,-122.382333,47.663916,King County CSO: Ballard,3,09/24/2026 19:40,NoRecentOverflow
11TH,-122.370774,47.659491,King County CSO: 11th Ave NW,4,09/24/2026 19:40,NoRecentOverflow
NPDES060,-122.4077581,47.66783263,Seattle CSO,60,09/24/2026 19:40,NoRecentOverflow
FRESH: DateTime 09/24/2026 19:50 local, Last-Modified 2026-09-25 02:50:10 GMT, checked at about 02:52 UTC
