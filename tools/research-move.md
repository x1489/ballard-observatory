# transit, traffic & getting around

## oba-arrivals-location (poll 45)
URL: https://api.pugetsound.onebusaway.org/api/where/arrivals-and-departures-for-location.json?key=TEST&lat=47.6680&lon=-122.3805&radius=650&minutesBefore=0&minutesAfter=45
NOTES: No special headers needed; works from Node 18 fetch and curl. RATE LIMIT: the TEST key is shared by everyone. Four or five concurrent requests passed, then HTTP 429 with body {"code":429,"text":"rate limit exceeded",...}. Sometimes the first request after a short gap also got 429. A retry after 2-4 s always worked. Put all OBA calls in one serial queue with at least 1.5 s between them, retry on 429 with backoff, and keep serving the last good cache. There is no multi-stop-ID batch parameter; this location endpoint is the batch option. The defaults (minutesBefore=5, minutesAfter=35) include buses that already left, so pass minutesBefore=0. A stop can appear more than once in stopIds. Some vehicleIds with 7+ digits (e.g. 1_8247382) show scheduleDeviation 0 and look like placeholder or block-level predictions, so treat them as lower confidence. Headsigns: D Line SB 'Downtown Seattle Uptown', NB 'Crown Hill'. 40 EB 'Downtown Seattle Fremont', WB 'Northgate Station'. 44 EB 'University Of Washington Medical Center Wallingford' or 'University District', WB 'Ballard Wallingford'. Route 17 runs only 4 weekday AM-peak trips to downtown (06:30-08:32 at 1_18120).
FORMAT: JSON (Content-Type application/json;charset=ISO-8859-1)
FIELDS: currentTime (epoch ms, server now). data.entry.arrivalsAndDepartures[]: stopId, routeId, routeShortName ('D Line','40','44','17'), tripHeadsign, predicted (bool), predictedArrivalTime (epoch ms; 0 = no realtime, fall back to scheduledArrivalTime), scheduledArrivalTime, predictedDepartureTime/scheduledDepartureTime, vehicleId ('1_6231'), distanceFromStop (meters), numberOfStopsAway, occupancyStatus ('EMPTY','MANY_SEATS_AVAILABLE' or ''), lastUpdateTime (epoch ms), situationIds[], tripStatus{position{lat,lon}, scheduleDeviation (s, + = late), lastUpdateTime}. data.entry.stopIds[] (has duplicates) and data.entry.limitExceeded. data.references.stops[] {id,name,direction,lat,lon,routeIds}, references.routes[] {id,shortName,description}, references.situations[] (alerts). Minutes away = (predictedArrivalTime||scheduledArrivalTime - currentTime)/60000.
SAMPLE: {"code":200,"currentTime":1790304037678,"data":{"entry":{"arrivalsAndDepartures":[{"routeId":"1_102581","routeShortName":"D Line","tripHeadsign":"Downtown Seattle Uptown","stopId":"1_13721","predicted":true,"predictedArrivalTime":1790304487000,"scheduledArrivalTime":1790304480000,"vehicleId":"1_6231","distanceFromStop":3057,"numberOfStopsAway":7,"occupancyStatus":"EMPTY","lastUpdateTime":1790303959000,"situationIds":[]},...],"stopIds":["1_13721",...],"limitExceeded":false},"references":{"stops":[...],"routes":[...],"situations":[]}}}
FRESH: Checked at 02:40 UTC 2026-09-25. currentTime matched `date -u`. Vehicle lastUpdateTime was 30-160 s old. 103 arrivals, all predicted=true, 212 KB.

## oba-arrivals-stop (poll 60)
URL: https://api.pugetsound.onebusaway.org/api/where/arrivals-and-departures-for-stop/1_18090.json?key=TEST&minutesBefore=0&minutesAfter=60
NOTES: Same 429 behavior as the batch endpoint; share one serialized queue. Also verified: stops-for-location.json?key=TEST&lat=47.6687&lon=-122.3800&radius=900 (stop discovery, limitExceeded=false), routes-for-location.json?...&radius=2000, and schedule-for-stop/1_18120.json (today's timetable per route and headsign, handy for showing route 17 peak times). Fetch those once a day at most.
FORMAT: JSON
FIELDS: Same arrival fields as the location batch, under data.entry.arrivalsAndDepartures[]. data.entry.stopId, data.entry.situationIds[], data.entry.nearbyStopIds[]. data.references.situations[]: {id ('1_92121'), summary.value, description.value, severity, reason, activeWindows[{from,to}] (epoch ms), allAffects[{routeId,stopId}]}.

KEY BALLARD STOP IDs (id | name | dir | lat,lon | routes):
1_13721 | 15th Ave NW & NW Market St | S (to downtown) | 47.668907,-122.376312 | D Line
1_14230 | 15th Ave NW & NW Market St | N (to Crown Hill) | 47.66848,-122.376114 | D Line
1_13760 / 1_14200 | 15th Ave NW & NW Leary Way | S / N | 47.663143,-122.37648 / 47.663437,-122.375977 | D Line, 17
1_18120 | NW Market St & Ballard Ave NW | E | 47.668606,-122.385345 | 40 (to Fremont/downtown), 44 (to Wallingford/UW), 17 (AM peak to downtown)
1_18740 | NW Market St & Ballard Ave NW | W | 47.668747,-122.386124 | 40 (to Northgate), 44 (to Ballard terminus), 17
1_18145 / 1_18720 | Leary Ave NW & NW Vernon Pl | SE / NW | 47.667316,-122.383018 / 47.667164,-122.382584 | 40
1_29215 / 1_29700 | NW Market St & 15th Ave NW | E / W | 47.668594,-122.375603 / 47.668735,-122.377136 | 44
1_18090 | NW 54th St & 30th Ave NW (Ballard Locks entrance) | E | 47.667637,-122.39653 | 44
1_18770 | NW 54th St & NW Market St (Locks) | SW | 47.668381,-122.395302 | 17
1_28210 / 1_28470 | 8th Ave NW & NW Market St | S / N | 47.668419,-122.366287 / 47.668934,-122.366081 | 28
1_17951 | Loyal Ave NW & Golden Gardens Dr NW | S | 47.693848,-122.399498 | 17
1_35530 | Loyal Way NW & NW 85th St | NW | 47.690208,-122.397842 | 45
Route IDs: D Line 1_102581, 40 1_102574, 44 1_100224, 17 1_100062, 28 1_100169. Routes 18 and 29 no longer serve Ballard (routes-for-location within 2 km returned 17, 24, 28, 31, 32, 33, 40, 44 and D Line).
SAMPLE: 1_18090 at 02:40 UTC: 44 'University District' predicted=true 7.2 min; 44 'University Of Washington Medical Center Wallingford' 22.2 min ... || situation example (stop 1_6840): {"id":"1_92121","summary":{"lang":"en","value":"Stop #6840 Greenwood Ave N & N 134th St (NB) closed from Mon Jul 27 through Thu Oct 22 due to construction."},"severity":"noImpact","reason":"UNKNOWN_CAUSE","activeWindows":[{"from":1785150000000,"to":1792753140000}],"allAffects":[{"agencyId":"1","routeId":"1_100229","stopId":"1_6840"}]}
FRESH: Live at 02:33-02:41 UTC. For example, the D Line bus at 1_13721 was 398 m away, lastUpdateTime 63 s before currentTime.

## oba-trips-for-route (poll 90)
URL: https://api.pugetsound.onebusaway.org/api/where/trips-for-route/1_102581.json?key=TEST&includeStatus=true&includeSchedule=false
NOTES: The list includes trips on the same vehicle block that interline with other routes (the D Line list showed 'Aurora Village Transit Center', an E Line headsign). Look up status.activeTripId in references.trips and keep only entries whose routeId matches. Filter positions to the Ballard bbox if desired.
FORMAT: JSON
FIELDS: data.list[]: tripId, status{vehicleId, activeTripId, position{lat,lon}, lastKnownLocation{lat,lon}, orientation (deg), scheduleDeviation (s), predicted, lastUpdateTime (epoch ms), nextStop, closestStop, phase, occupancyStatus}. data.references.trips[] {id, routeId, tripHeadsign}. Route IDs: 1_102574 (40), 1_100224 (44).
SAMPLE: 27 trips; e.g. vehicle 1_6073 pos [47.69109,-122.37681] scheduleDeviation 209 s, headsign 'Ballard Uptown', lastUpdate 161 s old; 1_6085 pos [47.71915,-122.34494] dev -28 s headsign 'Aurora Village Transit Center'
FRESH: At 02:39 UTC, position ages were 51-161 s

## kcm-alerts (poll 300)
URL: https://s3.amazonaws.com/kcm-alerts-realtime-prod/alerts_enhanced.json
NOTES: About 210 KB. alerts.json returns 403; use alerts_enhanced.json. Protobuf versions (alerts.pb, tripupdates.pb, vehiclepositions.pb) also exist in the same bucket and are fresh, but they need a protobuf decoder, so skip them in a zero-dependency server.
FORMAT: JSON (GTFS-realtime FeedMessage as JSON)
FIELDS: header.timestamp (epoch s). entity[]: id, alert.effect ('DETOUR','NO_SERVICE',...), alert.severity_level, alert.header_text.translation[0].text, alert.description_text.translation[0].text, alert.short_header_text, alert.service_effect_text, alert.timeframe_text, alert.url, alert.active_period[{start,end}] (epoch s), alert.informed_entity[{route_id,stop_id}]. route_id/stop_id have no agency prefix: OBA 1_102581 = route_id '102581'. Filter on route_id in {102581 (D), 102574 (40), 100224 (44), 100062 (17), 100169 (28)} or on the Ballard stop IDs listed above without the '1_' prefix.
SAMPLE: {"header":{"gtfs_realtime_version":"2.0","incrementality":"FULL_DATASET","timestamp":1790303916},"entity":[{"id":"94974","alert":{"effect":"NO_SERVICE","severity_level":"WARNING","active_period":[{"start":1790305200,"end":1790337600}],"header_text":{"translation":[{"text":"Stop #19440 Denny Way & Queen Anne Ave N (WB) closed from Thu Sep 24 at 8:00 PM to Fri Sep...","language":"en"}]},"informed_entity":[{"agency_id":"1","route_type":3,"route_id":"100132","stop_id":"19440"}],"last_modified_timestamp":1790303401}}]}
FRESH: Last-Modified 02:38:37 UTC and header.timestamp 02:38:36 when checked at 02:38:49 UTC. 68 alerts citywide, none on Ballard routes right now.

## sdot-camera-list (poll 86400)
URL: https://web.seattle.gov/Travelers/api/Map/Data?zoomId=18&type=2
NOTES: zoomId=13 returns fewer features (314 vs 633) but almost the same number of cameras (653 vs 655); use 18. There is no camera on the Ballard Bridge deck, at Shilshole, or at Leary & 8th.
FORMAT: JSON
FIELDS: Features[]: PointCoordinate [lat, lon], Cameras[] {Id ('CMR-0322'), Description, ImageUrl (filename), Type ('sdot'|'wsdot')}. Image URL = 'https://www.seattle.gov/trafficcams/images/' + ImageUrl for Type sdot ('https://images.wsdot.wa.gov/nw/' + ImageUrl for wsdot, none of which are in Ballard). Alternative without coordinates: https://web.seattle.gov/Travelers/api/Map/GetCamerasByNeighborhood?neighborhood=Ballard (the body is a JSON string that holds JSON, so JSON.parse twice).
SAMPLE: { "Features": [{ "PointCoordinate": [47.526783365445,-122.392755787503],"Cameras": [{"Id": "CMR-0112","Description": "Fauntleroy Way SW & SW Cloverdale St","ImageUrl": "Fauntleroy_SW_Cloverdale_NS.jpg","Type": "sdot"}]},{ "PointCoordinate": [47.6686786935195,-122.387576485923],"Cameras": [{"Id": "CMR-0322","Description": "24th Ave NW & NW Market St","ImageUrl": "24_NW_Market_EW.jpg","Type": "sdot"}]},...
FRESH: Static inventory, HTTP 200 at 02:34 UTC

## sdot-camera-images (poll 120)
URL: https://www.seattle.gov/trafficcams/images/15_NW_Market_1.jpg
NOTES: No UA needed. Proxy the bytes through the server, or just let the browser load them directly (img tags are not blocked by CORS) with a ?t= cache-buster. Mark a camera offline when the response is not image/jpeg, is a 3xx, or Last-Modified is more than 30 min old. The maintenance placeholder is small (about 30 KB, 352x240), which can serve as a heuristic. Send If-Modified-Since to save bandwidth.
FORMAT: image/jpeg (1280x720 or 720x480)
FIELDS: HTTP headers: Last-Modified (capture time), ETag, Cache-Control public max-age=300. WORKING (id | label | lat,lon | URL):
CMR-0011 | 15th Ave NW & NW Market St (N-S view) | 47.66851,-122.37621 | https://www.seattle.gov/trafficcams/images/15_NW_Market_1.jpg
CMR-0322 | 24th Ave NW & NW Market St | 47.66868,-122.38758 | .../24_NW_Market_EW.jpg
CMR-0009 | 15th Ave NW & NW Leary Way | 47.66365,-122.37530 | .../15_NW_Leary_EW.jpg
CMR-0390 | 15th Ave W & W Nickerson St, south approach looking north toward the Ballard Bridge | 47.65347,-122.37618 | .../15_W_Nickerson.jpg
CMR-0013 | 15th Ave W & W Emerson St (south of the bridge) | 47.65389,-122.37626 | .../15_W_Emerson_NS.jpg
CMR-0253 | Leary Way NW & NW 43rd St (closest camera to Leary & 8th) | 47.65894,-122.36472 | .../Leary_NW_43_EW.jpg
CMR-0007 | 15th Ave NW & NW 65th St | 47.67636,-122.37676 | .../15_NW_65_1.jpg
CMR-0008 | 15th Ave NW & NW 85th St | 47.69061,-122.37681 | .../15_NW_85_NS.jpg
BROKEN: CMR-0010 15_NW_Market_2.jpg returns 200 but it is a 352x240 'CAMERA UNDER MAINTENANCE' placeholder with Last-Modified 01:01 UTC (stale). CMR-0006 15_NW_65_2.jpg returns 302 to http://www.seattle.gov/x9045.xml.
SAMPLE: HEAD 15_NW_Market_1.jpg -> HTTP/2 200 content-type: image/jpeg content-length: 56794 cache-control: public, max-age=300 last-modified: Fri, 25 Sep 2026 02:30:04 GMT (checked 02:34:35 UTC); rechecked 02:42 -> last-modified 02:39:05, x-cache: Hit from cloudfront, age: 33
FRESH: At 02:41:31 UTC, Last-Modified was 02:39:05-02:39:54 on all working cameras (under 3 min old)

## sdot-bridge-status (poll 30)
URL: https://web.seattle.gov/Travelers/api/Map/GetBridgeData
NOTES: No key, no UA needed, about 860 bytes, fast (about 20 ms). Keep your own 'status since' timestamp by tracking transitions, since the feed has none. Filter to BridgeID 2 (Ballard) and optionally 3 (Fremont).
FORMAT: JSON-encoded string that contains JSON (JSON.parse twice)
FIELDS: [] of {BridgeID (2 = Ballard), DisplayName ('Ballard'), Latitude, Longitude, Name ('Bridge_Ballard.Input01'), Status}. Status 'Closed' = bridge DOWN (open to cars). Any other value = bridge UP (open to boats). SDOT's own bridge.js: name + ' Bridge is currently ' + ((status == 'Closed') ? 'down' : 'up').
SAMPLE: "[{\"BridgeID\":1,\"DisplayName\":\"1st Ave S\",...,\"Status\":\"Closed\"},{\"BridgeID\":2,\"DisplayName\":\"Ballard\",\"Latitude\":47.659815735813133,\"Longitude\":-122.37618949046208,\"Name\":\"Bridge_Ballard.Input01\",\"Status\":\"Closed\"},{\"BridgeID\":3,\"DisplayName\":\"Fremont\",...,\"Status\":\"Closed\"},...]"
FRESH: Polled every 30 s from 02:39 to 02:43 UTC: HTTP 200 each time, all bridges 'Closed' (down). The payload has no timestamp, and I did not see an opening during the window, so a state change is not directly verified.

## sdot-travel-times (poll 120)
URL: https://web.seattle.gov/Travelers/api/Map/LinksBySiteID?siteId=1991
NOTES: GetTravelLinksByNeighborhood?neighborhood=Ballard lists the same links, but with Status 0 and Value 0, so it cannot supply values; use LinksBySiteID for 1991 and 1990. Values are seconds, not minutes.
FORMAT: JSON (plain, not double-encoded)
FIELDS: [] of {LinkDisplayName ('DOWNTOWN','AURORA BR','I-5/DENNY','LW QN ANN'), LinkID, SrcSiteID, SrcSiteName ('15th Ave NW & NW 61st St'), Status (1 = valid, otherwise show N/A), Value (SECONDS; SDOT displays round(Value/60) + ' MIN', or '1 MIN' when under 30)}. Second Ballard site: siteId=1990 'Holman Rd NW & 14th Ave NW' with DOWNTOWN/INTERBAY/LWR QN ANN/SEA CNTR. Link geometry: https://web.seattle.gov/Travelers/api/Map/LinkInfoByLinkID?linkId=48797 (a double-encoded string holding Features[].LineCoordinates, a flat lat,lon array).
SAMPLE: [{"LinkDisplayName":"AURORA BR","LinkID":"48802","LinkProviderID":0,"SiteProviderID":0,"SrcSiteID":"1991","SrcSiteName":"15th Ave NW & NW 61st St","Status":1,"Value":468.0},{"LinkDisplayName":"DOWNTOWN","LinkID":"48797",...,"Status":1,"Value":1044.0},{"LinkDisplayName":"I-5/DENNY",...,"Value":1020.0},{"LinkDisplayName":"LW QN ANN",...,"Value":492.0}]
FRESH: Values changed across polls between 02:37 and 02:43 UTC (DOWNTOWN 1044 -> 1008 s, I-5/DENNY 1020 -> 996, AURORA BR 468 -> 420). No timestamp field.

## sdot-incidents (poll 180)
URL: https://web.seattle.gov/Travelers/api/Map/Data?zoomId=18&type=1
NOTES: Cache-Control: no-cache. Descriptions can contain mis-decoded UTF-8 (e.g. 'â€“' for an en dash), so fix it on display. Use a slightly larger radius, such as bbox plus 1 km, so events on the Ballard Bridge and at 15th/Nickerson show up. The type=5 variant (Data?zoomId=18&type=5) returns only travel-time site locations without values.
FORMAT: JSON
FIELDS: Features[]: PointCoordinate [lat, lon], Incidents[] {Id, Description, Type ('Collision','Construction',...), StartDateTime, EndDateTime, Direction, StartLocationDescription, EndLocationDescription (optional), Url (usually an x.com/SDOTtraffic post)}. The StartDateTime/EndDateTime strings are in local Pacific time, formatted 'M/D/YYYY h:mm:ss AM' with no zone.
SAMPLE: { "Features": [{ "PointCoordinate": [47.70953765,-122.33277575],"Incidents": [{"Id": "41593","Description": "Collision on Aurora Ave N at N 112th St blocking NB & SB left lanes. Use caution.","Type": "Collision","StartDateTime": "9/24/2026 5:18:00 PM","EndDateTime": "9/24/2026 11:59:00 PM","Direction": "NB and SB","StartLocationDescription": "N 112th St","Url": "https://x.com/SDOTtraffic/status/2103277846475244001?s=20"}]},...]}
FRESH: At 02:41 UTC there were 6 active citywide items, the newest a collision posted 5:18 PM PDT today (00:18 UTC). None were inside the Ballard bbox.

## lime-gbfs (poll 90)
URL: https://data.lime.bike/api/partners/v2/gbfs/seattle/free_bike_status
NOTES: The response is large (about 3.0 MB) and served with cache-control no-store. Fetch it server-side at most once a minute, reduce it to Ballard vehicles plus counts, and send the browser only the small JSON. bike_id rotates per GBFS privacy rules, so do not track individual vehicles. The v1 feed (…/v1/gbfs/seattle/free_bike_status.json, 1.8 MB) also works but lacks range and uses a string vehicle_type.
FORMAT: JSON (GBFS 2.2)
FIELDS: last_updated (epoch s), ttl (s). data.bikes[] {bike_id, lat, lon, is_reserved (bool), is_disabled (bool), current_range_meters, vehicle_type_id, last_reported (epoch s), vehicle_type}. Vehicle types from https://data.lime.bike/api/partners/v2/gbfs/seattle/vehicle_types: '1' = scooter (24 km max range), '2' = scooter (40 km), '3' = e-assist bicycle (85 km), '4' = human-powered bicycle. Count with haversine distance at most 800 m from 47.6687,-122.3847, excluding is_disabled and is_reserved.
SAMPLE: {"last_updated":1790303762,"ttl":60,"version":"2.2","data":{"bikes":[{"bike_id":"fb96aa94-78d7-443a-b523-0bd5e593b1bf","lat":47.617767,"lon":-122.347093,"is_reserved":false,"is_disabled":false,"current_range_meters":29354,"vehicle_type_id":"2","last_reported":1790303754,"vehicle_type":"scooter"},...]}}
FRESH: At 02:36:01 UTC, last_updated was 02:36:02, i.e. real time. 13,218 vehicles citywide, 689 in the Ballard bbox, 217 within 800 m of center (133 scooters of type 2, 84 e-bikes of type 3, 0 disabled or reserved).

## seattle-fire-mvi (poll 300)
URL: https://data.seattle.gov/resource/kzjm-xkqj.json?$where=within_circle(report_location,47.6687,-122.3847,3000)%20AND%20type%20like%20'%25MVI%25'&$order=datetime%20DESC&$limit=20
NOTES: URL-encode $where. Socrata without an app token is throttled per IP but fine at this rate. Treat datetime as America/Los_Angeles.
FORMAT: JSON (Socrata SODA)
FIELDS: [] {address, type ('MVI - Motor Vehicle Incident'), datetime (local Pacific floating time 'YYYY-MM-DDTHH:MM:SS.000', no zone), latitude, longitude (strings), incident_number}
SAMPLE: [{"address":"8th Ave Nw / Nw Market St","type":"MVI - Motor Vehicle Incident","datetime":"2026-09-24T17:22:00.000","latitude":"47.668653","longitude":"-122.366178","report_location":{"type":"Point","coordinates":[-122.366178,47.668653]},"incident_number":"F260136957"},{"address":"Nw Market St / Nw 52nd St","type":"MVI - Motor Vehicle Incident","datetime":"2026-09-22T20:30:00.000",...}]
FRESH: At 02:40 UTC the newest record citywide was 19:30 PDT (02:30 UTC), about 10 min lag. The newest Ballard MVI was 17:22 PDT today.
