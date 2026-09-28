# public safety, civic & community

## sfd-fire-911-socrata (poll 180)
URL: https://data.seattle.gov/resource/kzjm-xkqj.json?$where=within_circle(report_location,47.6687,-122.3847,2000)%20AND%20datetime%20%3E%20'2026-09-23T19:30:00'&$order=datetime%20DESC&$limit=100
NOTES: No key is needed. Unauthenticated SODA requests are IP-throttled, which is fine at this rate. The server must build the time filter itself: take now in America/Los_Angeles minus 24h and format it as YYYY-MM-DDTHH:MM:SS with no Z, because datetime is floating local time. Do not compare it to UTC. within_circle(report_location, lat, lon, meters) works. Any UA gets 200 (tested with 'node'). The metadata endpoint https://data.seattle.gov/api/views/kzjm-xkqj.json has rowsUpdatedAt (epoch seconds). The rows carry no status field and no units; get those from sfd-realtime911-html.
FORMAT: JSON array (Socrata SODA 2.0)
FIELDS: [].incident_number (e.g. F260136975, unique id; also the join key to sfd-realtime911-html); [].type (e.g. 'Aid Response','MVI - Motor Vehicle Incident','Rubbish Fire','Auto Fire Alarm'); [].datetime (floating_timestamp in PACIFIC LOCAL time, no offset, e.g. '2026-09-24T17:55:00.000'); [].address; [].latitude / [].longitude (strings, need parseFloat); [].report_location {type:Point, coordinates:[lon,lat]}. The geo column is report_location (point) and the time column is datetime.
SAMPLE: [{"address":"2421 W COMMODORE WAY","type":"Aid Response","datetime":"2026-09-24T17:55:00.000","latitude":"47.660987","longitude":"-122.387727","report_location":{"type":"Point","coordinates":[-122.387727,47.660987]},"incident_number":"F260136975"},{"address":"8th Ave Nw / Nw Market St","type":"MVI - Motor Vehicle Incident","datetime":"2026-09-24T17:22:00.000","latitude":"47.668653","longitude":"-122.366178",...,"incident_number":"F260136957"}] (16 rows in 24h)
FRESH: At 2026-09-25 02:42Z (19:42 PDT) the newest citywide row was 2026-09-24T19:30 local, so 12 min behind. At 02:33Z it was 19:25, 8 min behind. Response header X-SODA2-Truth-Last-Modified moved 02:30:54Z to 02:40:57Z.

## sfd-realtime911-html (poll 60)
URL: https://web.seattle.gov/sfd/realtime911/getRecsForDatePub.asp?action=Today&incDate=&rad1=des
NOTES: Parse with a regex over <tr>/<td> and strip tags. Only web.seattle.gov works (web6.seattle.gov returns 404). action=Today covers the current Pacific calendar day only, so the list is short right after midnight; incDate=M/D/YYYY with action=Previous-style params may fetch other days (not tested). To locate incidents in Ballard, join on incident_number with sfd-fire-911-socrata (which lags about 10 min). For incidents newer than that, fall back to address text (' Nw ', 'Ballard', 'Leary', 'Shilshole') or to units seen on Ballard calls (E18, M18, L8, E35), which is a heuristic. HTTP 200 with UA 'Mozilla/5.0 (compatible; BallardDash/0.1)'.
FORMAT: HTML (about 165 KB, ~300 table rows for the current day, newest first)
FIELDS: Each <tr id=row_N> has 6 <td>s: [0] datetime 'M/D/YYYY h:mm:ss AM/PM' (Pacific local), [1] incident number (F2601370xx, same as Socrata incident_number), [2] level, [3] units (space-separated, e.g. 'E20 M18'), [4] location/address, [5] type. td class="active" marks an Active Incident (legend 'grsq.gif = Active Incident') and class="closed" a closed one. There were 72 active cells / 6 = 12 active incidents citywide at probe time.
SAMPLE: <tr id=row_1 ...><td class="active" width=16% valign="top">9/24/2026 7:42:10 PM</td><td class="active" ...>F260137015</td><td class="active" ...>1</td><td class="active" ...>M1</td><td class="active" ...>334 1st Ave N</td><td class="active" ...>Single Medic Unit</td></tr>  Ballard rows seen: ['9/24/2026 5:22:01 PM','F260136957','1','L8','8th Ave Nw / Nw Market St','MVI - Motor Vehicle Incident'], ['9/24/2026 2:21:33 PM','F260136882','1','E18','1521 Nw 54th St','Rubbish Fire']
FRESH: Newest row 7:42:10 PM PDT, fetched at 19:43 PDT (02:43Z), so about 1 min behind real time

## spd-call-data (poll 3600)
URL: https://data.seattle.gov/resource/33kz-ixgy.json?$select=cad_event_number,cad_event_original_time_queued,initial_call_type,final_call_type,priority,dispatch_beat,dispatch_neighborhood,dispatch_address,dispatch_latitude,dispatch_longitude,cad_event_clearance_description&$where=dispatch_neighborhood%20in('BALLARD%20NORTH','BALLARD%20SOUTH')%20AND%20cad_event_original_time_queued%20%3E%20'2026-09-20T00:00:00'&$order=cad_event_original_time_queued%20DESC&$limit=500
NOTES: This corrects the prompt's assumptions. In this dataset, dispatch_sector uses names, not letters: 'BOY' (beats B1-B3), 'JOHN', 'NORA', 'LINCOLN', 'UNION' in precinct 'NORTH'. Ballard South is beats B1 and B2. Ballard North is beats J1 and J2, plus a few N1. B3 is Wallingford/Fremont, not Ballard, and B2 also covers Fremont/Phinney. The best filter is dispatch_neighborhood IN ('BALLARD NORTH','BALLARD SOUTH'); a beat filter pulls in Fremont and Greenwood. Timestamps are floating Pacific. Sensitive calls (DV and similar) have REDACTED location.
FORMAT: JSON array (Socrata)
FIELDS: cad_event_number (dedupe on this: there is one row per dispatched unit, e.g. 200 rows had 112 unique events); cad_event_original_time_queued (floating Pacific local); initial_call_type, final_call_type; priority ('1' is highest); dispatch_beat; dispatch_neighborhood; dispatch_address (block-level, e.g. '54XX BLOCK OF BALLARD AV NW', or 'REDACTED'); dispatch_latitude and dispatch_longitude (TEXT, may be 'REDACTED', so within_circle is not possible); cad_event_clearance_description
SAMPLE: [{"cad_event_number":"2026000282384","cad_event_original_time_queued":"2026-09-21T21:46:23.000","final_call_type":"THEFT - SHOPLIFT","initial_call_type":"SHOPLIFT - THEFT","priority":"2","dispatch_beat":"B1","dispatch_neighborhood":"BALLARD SOUTH","dispatch_address":"54XX BLOCK OF BALLARD AV NW","dispatch_latitude":"47.66814081","dispatch_longitude":"-122.38557986","cad_event_clearance_description":"UNABLE TO LOCATE INCIDENT OR COMPLAINANT"},{..."dispatch_beat":"N1","dispatch_neighborhood":"BALLARD NORTH","dispatch_address":"REDACTED","dispatch_latitude":"REDACTED"...}]
FRESH: max(cad_event_original_time_queued) = 2026-09-21T23:55:16 local, checked at 2026-09-24 19:33 PDT, so about 2.8 days behind. rowsUpdatedAt 2026-09-24 20:01Z (loaded daily).

## spd-crime-data (poll 3600)
URL: https://data.seattle.gov/resource/tazs-3rd5.json?$select=report_number,report_date_time,offense_date,offense_sub_category,nibrs_offense_code_description,block_address,latitude,longitude,beat,neighborhood&$where=neighborhood%20in('BALLARD%20NORTH','BALLARD%20SOUTH')%20AND%20report_date_time%20%3E%20'2026-09-17T00:00:00'&$order=report_date_time%20DESC&$limit=200
NOTES: Sector codes here are single letters (B/J), unlike Call Data (BOY/JOHN). The neighborhood filter is reliable. Lat/lon are strings. Dedupe or group by report_number when showing incidents.
FORMAT: JSON array (Socrata)
FIELDS: report_number (a report can have several offense rows); report_date_time and offense_date (floating Pacific; offense_date can be weeks earlier); nibrs_offense_code_description (e.g. 'Shoplifting'); offense_sub_category; nibrs_crime_against_category (PROPERTY/PERSON/SOCIETY); block_address; latitude and longitude (TEXT); beat; sector (single letters here: 'B','J'); neighborhood
SAMPLE: [{"report_number":"2026-284662","report_date_time":"2026-09-23T22:34:03.000","offense_date":"2026-09-23T21:46:00.000","offense_sub_category":"PROPERTY OFFENSES (INCLUDES STOLEN, DESTRUCTION)","nibrs_offense_code_description":"Destruction/Damage/Vandalism of Property","block_address":"83XX BLOCK OF 15TH AVE NW","latitude":"47.68966674","longitude":"-122.376802784339","beat":"J2","neighborhood":"BALLARD NORTH"}] (68 Ballard rows in the last 7 days)
FRESH: max(report_date_time) = 2026-09-24T00:06 local, about 19.5h behind at 19:35 PDT. rowsUpdatedAt 2026-09-24 15:45Z.

## usgs-quakes-150km (poll 180)
URL: https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=47.6687&longitude=-122.3847&maxradiuskm=150&starttime=NOW-7days&orderby=time
NOTES: starttime=NOW-7days works (verified). Returns HTTP 200 for any UA. Magnitudes are mostly tiny, so the dashboard may want minmagnitude=1 for display.
FORMAT: GeoJSON FeatureCollection
FIELDS: metadata.count, metadata.generated (epoch ms); features[].id; features[].properties.mag, .magType, .place, .time (epoch ms UTC), .updated, .url (event page), .felt, .cdi, .mmi, .alert, .tsunami, .status ('automatic'/'reviewed'); features[].geometry.coordinates [lon, lat, depth_km]
SAMPLE: {"type":"FeatureCollection","metadata":{"generated":1790304284000,...,"status":200,"api":"2.7.0","count":38},"features":[{"type":"Feature","properties":{"mag":0.32,"place":"18 km SSE of Carbonado, Washington","time":1790290162460,"updated":1790291544780,"url":"https://earthquake.usgs.gov/earthquakes/eventpage/uw714108592","felt":null,"alert":null,"status":"reviewed","tsunami":0,"magType":"ml",...},"geometry":{"type":"Point","coordinates":[-121.950833,46.930667,4.73]},"id":"uw714108592"}]}
FRESH: Newest event 2026-09-24 22:49:22Z, about 3.7h before the probe. metadata.generated = probe time. 38-43 events in 7 days, mostly M<1.5.

## usgs-quakes-felt-300km (poll 300)
URL: https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=47.6687&longitude=-122.3847&maxradiuskm=300&minmagnitude=2.5&starttime=NOW-7days&orderby=time
NOTES: Consider also showing 'largest in last 30 days' (starttime=NOW-30days) so the panel is not empty.
FORMAT: GeoJSON FeatureCollection
FIELDS: Same fields as usgs-quakes-150km. Use properties.felt (DYFI count), cdi, mmi, alert (PAGER), and tsunami for emphasis.
SAMPLE: 30-day variant: [3.18 '21 km SSW of Ucluelet, Canada' 2026-09-15 09:30:51Z felt=19], [2.56 '2 km E of Mount Vernon, Washington' 2026-09-12 04:17:36Z felt=10], [3.75 '20 km E of Castle Rock, Washington' 2026-09-05 11:09:28Z felt=1025]. 7-day query: {"metadata":{"count":0}}
FRESH: Live query. Last qualifying event 2026-09-15 (outside the 7-day window).

## scl-outages (poll 120)
URL: https://utilisocial.io/datacapable/v2/p/scl/map/events
NOTES: Both lowercase 'scl' and 'SCL' work. The v1 path returns 401, /summary returns 401, and /map/summary and /map/metadata return 404. The response is Content-Type application/json;charset=ISO-8859-1 with no-cache headers. Works with any UA, including none. Show 'No outages in Ballard' when the filtered list is empty.
FORMAT: JSON array (empty [] when there are no outages)
FIELDS: [].id; .startTime, .lastUpdatedTime, .etrTime (estimated restoration; all epoch ms UTC); .numPeople (customers affected); .status ('Dispatched', etc.); .cause ('Investigating', etc.); .identifier; .latitude, .longitude; .polygons.rings [[[lon,lat],...]] (ArcGIS-style, wkid 4326); .city ('South Seattle' etc.). Filter to the Ballard bbox lat 47.655-47.700, lon -122.410 to -122.360. Companion endpoint https://utilisocial.io/datacapable/v2/p/scl/map/stats returns {"lastUpdatedTime":"1790304243470"} (a string of epoch ms).
SAMPLE: [{"id":2220533,"startTime":1790296018000,"lastUpdatedTime":1790303043000,"etrTime":1790318096000,"title":"Outage","numPeople":1,"status":"Dispatched","cause":"Investigating","identifier":"223090","latitude":47.55481,"longitude":-122.27421,"polygons":{"type":"polygon","spatialReference":{"latestWkid":4326,"wkid":4326},"rings":[[[-122.27399,47.55455],[-122.2741,47.55449],...]],"hasZ":false,"hasM":false},"city":"South Seattle","state":"WA"}]
FRESH: map/stats lastUpdatedTime 02:34:03Z and then 02:44:03Z (probes at 02:34 and 02:45Z). The one citywide outage had lastUpdatedTime 02:24Z. There were no Ballard outages at probe time.

## myballard-rss (poll 900)
URL: https://www.myballard.com/feed/
NOTES: myballard.com/feed redirects to https://www.myballard.com/feed/, so follow redirects. Works with any UA.
FORMAT: RSS 2.0 (WordPress), 30 items
FIELDS: channel.item[].title, .link, .pubDate (RFC822 +0000), .dc:creator, .category[], .description (CDATA HTML excerpt ending in a 'read-more' link; strip tags), .guid
SAMPLE: <item><title>Ballard and Ingraham students named National Merit semifinalists</title><link>https://www.myballard.com/2026/09/24/ballard-and-ingraham-students-named-national-merit-semifinalists/</link><dc:creator><![CDATA[Meghan Walker]]></dc:creator><pubDate>Thu, 24 Sep 2026 17:37:00 +0000</pubDate><category><![CDATA[Ballard]]></category><guid isPermaLink="false">https://www.myballard.com/?p=357098</guid><description><![CDATA[Three Ballard High School students and two Ingraham High School students have been named semifinalists...
FRESH: Newest item 2026-09-24 17:37Z (about 9h before the probe). Previous items were 09-23 18:03Z and 17:40Z.

## seattletimes-local-rss (poll 900)
URL: https://www.seattletimes.com/seattle-news/feed/
NOTES: curl's default UA gets 403. UA 'node' and 'Mozilla/5.0 (compatible; BallardDash/0.1)' get 200. /tag/ballard/feed/ returned 202 (a bot challenge), so it is not usable; filter the main feed for 'Ballard' instead.
FORMAT: RSS 2.0, about 32 items
FIELDS: item[].title (HTML entities, e.g. &#8217;), .link (has utm params), .pubDate (-0700 local offset), .dc:creator, .description
SAMPLE: <item><title>Will Fall City mass shooting suspect&#8217;s case be moved to adult court?</title><link>https://www.seattletimes.com/seattle-news/law-justice/will-fall-city-mass-shooting-suspects-case-be-moved-to-adult-court/?utm_source=RSS&amp;utm_medium=Referral&amp;utm_campaign=RSS_seattle-news</link>...<pubDate>Thu, 24 Sep 2026 19:06:49 -0700</pubDate><dc:creator><![CDATA[Lauren Girgis]]></dc:creator>
FRESH: Newest item 2026-09-24 19:06 PDT, about 30 min before the probe

## reddit-ballard-rss (poll 1800)
URL: https://www.reddit.com/r/Ballard/new/.rss
NOTES: Rate limits are aggressive. Back-to-back requests from one IP got 429 (x-ratelimit-remaining: 0.0), and bare UA 'Mozilla/5.0' once got 403. After a few minutes, UA 'Mozilla/5.0 (compatible; BallardDash/0.1)' and a full Chrome UA both got 200. Poll at most every 15-30 min, stagger it with the other reddit feed, and serve the cache on 429/403. /new.json returns 403 (blocked); old.reddit.com returns 302.
FORMAT: Atom XML, 25 entries
FIELDS: feed.entry[].title, .link@href, .published and .updated (ISO8601 +00:00), .author.name ('/u/...'), .id ('t3_xxx'), media:thumbnail@url, .content (HTML; strip it)
SAMPLE: <entry><author><name>/u/chyrsanthesunshine</name>...</author><category term="Ballard" label="r/Ballard"/><content type="html">…</content><id>t3_1wnlmlp</id><media:thumbnail url="https://preview.redd.it/u9jtt35vw4rh1.png?..." /><link href="https://www.reddit.com/r/Ballard/comments/1wnlmlp/hi_everyone_im_jackie_a_dental_hygiene_student_at/" /><updated>2026-09-22T20:51:22+00:00</updated><published>2026-09-22T20:51:22+00:00</published><title>Hi Everyone! I'm Jackie, a Dental Hygiene student...</title></entry>
FRESH: Newest post 2026-09-22 20:51Z, about 2 days old. The feed header <updated> is the request time.

## reddit-seattle-ballard-search (poll 1800)
URL: https://www.reddit.com/r/Seattle/search.rss?q=ballard&restrict_sr=on&sort=new&t=month
NOTES: Same rate-limit caveats as reddit-ballard-rss; the two share the IP quota. Probed with a full browser UA.
FORMAT: Atom XML, about 23 entries
FIELDS: Same as reddit-ballard-rss: entry[].title, link@href, published, author.name
SAMPLE: 2026-09-24T20:17:52+00:00 | Ballard Town &amp; Country used to be my favorite grocery store- what happened??
2026-09-24T17:20:39+00:00 | Stolen Car - Ballard
2026-09-23T00:47:27+00:00 | Anyone record Real Time Traffic footage from Ballard bridge?
FRESH: Newest entry 2026-09-24 20:17Z, about 6h before the probe

## google-news-ballard (poll 1800)
URL: https://news.google.com/rss/search?q=%22Ballard%22+Seattle+when:7d&hl=en-US&gl=US&ceid=US:en
NOTES: Items are NOT sorted by date, so sort by pubDate on the server. Dedupe against the My Ballard feed by title. Filter noise sources (MaxPreps, NFHS Network). Works with UA 'node'.
FORMAT: RSS 2.0, about 32 items
FIELDS: item[].title (ends with ' - Source'), .link (a news.google.com redirect URL), .pubDate (GMT), .source (text) and .source@url, .description (HTML list)
SAMPLE: <item><title>GoodMart to open on Ballard Ave this week - My Ballard</title><link>https://news.google.com/rss/articles/CBMihgFBVV95cUxNYzB2TFlpbXhHT3…</link><pubDate>Mon, 21 Sep 2026 17:12:41 GMT</pubDate><description>…</description><source url="https://www.myballard.com">My Ballard</source></item>
FRESH: Newest item 2026-09-24 22:20Z (theurbanist.org), about 4h before the probe

## spd-blotter-rss (poll 900)
URL: https://spdblotter.seattle.gov/feed/
NOTES: UA quirk: bare 'Mozilla/5.0' gets 403, while 'node' and 'Mozilla/5.0 (compatible; BallardDash/0.1)' get 200. Use a descriptive UA.
FORMAT: RSS 2.0 (WordPress), 10 items
FIELDS: item[].title, .link, .pubDate (+0000), .dc:creator, .category[] (includes precinct names such as 'West Precinct' and 'North Precinct'), .description
SAMPLE: <item><title>Violent Downtown Hate Crime Attack Leaves Woman with Permanent Injuries</title><link>https://spdblotter.seattle.gov/2026/09/24/violent-downtown-hate-crime-attack-leaves-woman-with-permanent-injuries/</link><dc:creator><![CDATA[Detective Shane Weatherford]]></dc:creator><pubDate>Thu, 24 Sep 2026 23:09:41 +0000</pubDate><category><![CDATA[Investigations]]></category><category><![CDATA[West Precinct]]></category>
FRESH: Newest item 2026-09-24 23:09Z, about 3.5h before the probe

## sfd-fireline-rss (poll 1800)
URL: https://fireline.seattle.gov/feed/
NOTES: Works with UA 'node' and with the BallardDash UA.
FORMAT: RSS 2.0, 10 items
FIELDS: item[].title, .link, .pubDate, .description
SAMPLE: Thu, 24 Sep 2026 14:32:27 +0000 | Early morning residential fire in the Meadowbrook neighborhood injures person an...
Wed, 23 Sep 2026 21:31:43 +0000 | Firefighters battle early morning commercial structure fire in the Georgetown ne...
FRESH: Newest item 2026-09-24 14:32Z (about 12h before the probe)

## sdot-blog-rss (poll 3600)
URL: https://sdotblog.seattle.gov/feed/
NOTES: Any UA
FORMAT: RSS 2.0, 10 items
FIELDS: item[].title, .link, .pubDate, .description
SAMPLE: Wed, 23 Sep 2026 01:13:26 +0000 | Mayor Wilson's 2027-2028 Proposed Budget Supports a Resilient Seattle Transporta...
Thu, 17 Sep 2026 18:04:43 +0000 | Host a Trick-or-Streets celebration on your block – Apply by October 20
FRESH: Newest item 2026-09-23 01:13Z (about 1.5 days before the probe)

## seattle-parks-parkways-rss (poll 3600)
URL: https://parkways.seattle.gov/feed/
NOTES: Any UA
FORMAT: RSS 2.0, 10 items
FIELDS: item[].title, .link, .pubDate, .description
SAMPLE: Wed, 23 Sep 2026 22:19:44 +0000 | Seattle Parks and Recreation Gathers Input for Hing Hay Park Exercise Equipment...
Tue, 22 Sep 2026 20:32:45 +0000 | Mayor Wilson&#8217;s 2027-2028 Proposed Budget: Seattle Parks and Recreation Hig...
FRESH: Newest item 2026-09-23 22:19Z (about 1 day before the probe)

## phinneywood-rss (poll 1800)
URL: https://phinneywood.com/feed/
NOTES: Use the apex host. www.phinneywood.com/feed/ returns a 301 to https://phinneywood.com/feed/ (follow redirects).
FORMAT: RSS 2.0, 10 items
FIELDS: item[].title, .link, .pubDate, .description
SAMPLE: Thu, 24 Sep 2026 17:45:00 +0000 | Did You Know Phinney Ridge Lutheran Church Has a Food Pantry?
Thu, 24 Sep 2026 00:05:00 +0000 | September PhinneyWood Housing Market Snapshot
FRESH: Newest item 2026-09-24 17:45Z (about 9h before the probe)

## visitballard-events (poll 3600)
URL: https://www.visitballard.com/wp-json/tribe/events/v1/events?per_page=50&start_date=2026-09-24&end_date=2026-10-01
NOTES: Pass explicit local dates. start_date=now resolved to 2026-09-25 00:00 (server UTC), which dropped tonight's Pacific-time events. per_page max is about 50; page through with next_rest_url. An iCal alternative also works: https://www.visitballard.com/events/?ical=1 (text/calendar, 'Visit Ballard - ECPv6.17.5'). The root visitballard.com redirects to www. Works with UA 'node'.
FORMAT: JSON {events:[...], total, total_pages, next_rest_url}
FIELDS: events[].id, .title (HTML entities, e.g. &#8217; and &amp;, so decode), .url, .start_date and .end_date ('YYYY-MM-DD HH:MM:SS' America/Los_Angeles), .utc_start_date, .utc_end_date, .all_day, .timezone, .cost, .image.url (may be false), .excerpt (HTML), .categories[].name, .venue.venue, .venue.address (venue is [] when none; geo_lat/geo_lng are null, so no coordinates), .organizer; top-level total, total_pages, next_rest_url for paging
SAMPLE: {"events":[{"id":10005945,"title":"Moomins&#8217; Sea Adventures &amp; Tove and the Sea","url":"https://www.visitballard.com/event/moomins-sea-adventures-tove-and-the-sea/2026-09-24/","start_date":"2026-09-24 08:00:00","end_date":"2026-09-24 17:00:00","utc_start_date":"2026-09-24 15:00:00","all_day":false,"timezone":"America/Los_Angeles","cost":"$10 – $25","venue":{"venue":"National Nordic Museum","address":"2655 NW Market St","geo_lat":null,...}},...],"total":1450,"total_pages":145}
FRESH: It listed tonight's events (e.g. 'Karaoke at Hattie's Hat' 2026-09-24 21:30). The newest 'modified' timestamp seen was 2026-09-22.

## ballard-farmers-market-hours (poll 0)
URL: https://www.sfmamarkets.com/visit-ballard-farmers-market/
NOTES: sfmamarkets.com redirects to www. ballardfarmersmarket.org redirects to the SFMA homepage. Hard-code the schedule rather than scraping.
FORMAT: HTML (static facts)
FIELDS: Static: every Sunday, year-round, rain or shine, 9:00 AM-2:00 PM. Location: Ballard Ave NW from 22nd Ave NW & NW Market St down to 20th Ave NW. Meters are free on Sundays. The vendor map is updated every Friday by 5 PM.
SAMPLE: "YEAR-ROUND MARKET, RAIN OR SHINE SUNDAYS 9:00 AM-2:00 PM" ... "The Ballard Farmers Market is open every Sunday, rain or shine, year-round from 9:00 AM - 2:00PM. The Market operates along the historic cobblestone stretch of Ballard Avenue NW, running from 22nd Avenue NW and NW Market Street down Ballard Avenue NW to 20th Avenue NW"
FRESH: Page fetched 2026-09-25 (current)

## spl-ballard-events (poll 3600)
URL: https://www.trumba.com/calendars/kalendaro.json?search=Ballard%20Branch&days=14
NOTES: Full-text search: search=Ballard alone can match other branches' descriptions, so keep only events whose stripped location equals 'Ballard Branch'. days=N controls the window. .rss and .ics variants exist on Trumba (not tested). The BiblioCommons gateway is not usable (see bibliocommons-spl).
FORMAT: JSON array
FIELDS: [].eventID; .title (HTML entities, e.g. &quot; &#263;); .description (HTML); .location (HTML anchor, e.g. <a href=...>Ballard Branch</a>, so strip tags and keep only 'Ballard Branch'); .startDateTime and .endDateTime (local, no offset) plus .startTimeZoneOffset '-0700'; .dateTimeFormatted; .allDay; .canceled (bool; titles are also prefixed 'CANCELLED - '); .permaLinkUrl; .eventImage.url; .customFields[] {label,value} (e.g. 'Registration Required'); .locationType ('In-Person')
SAMPLE: [{"eventID":206603394,"title":"Seattle Reads: Sara Novi&#263; discusses &quot;True Biz&quot;","locationType":"In-Person","location":"<a href=\"https://www.spl.org/hours-and-locations/ballard-branch\" target=\"_blank\">Ballard Branch</a>","startDateTime":"2026-09-25T11:00:00","endDateTime":"2026-09-25T12:15:00","allDay":false,"startTimeZoneOffset":"-0700","canceled":false,"permaLinkUrl":"https://www.spl.org/event-calendar?trumbaEmbed=view%3Devent%26eventid%3D20660339..."}]
FRESH: Returned 12 upcoming Ballard Branch events from 2026-09-25 onward, including a CANCELLED 2026-09-26 Toddler Play Group (a live cancellation flag)

## spl-ballard-hours (poll 86400)
URL: https://www.spl.org/hours-and-locations/ballard-branch
NOTES: Regex: <span>\s*(Mon|Tue|...)\s*</span><span>\s*([^<]+?)\s*</span> inside branch-header__hours. Holiday closures: https://www.spl.org/using-the-library/plan-a-visit/holidays-and-closures (not parsed).
FORMAT: HTML
FIELDS: Inside div.branch-header__hours ol li: <span>Day</span><span>hours</span>. Verified: Mon 10 a.m.-6 p.m.; Tue 10 a.m.-8 p.m.; Wed 10 a.m.-8 p.m.; Thu 10 a.m.-8 p.m.; Fri 10 a.m.-6 p.m.; Sat 10 a.m.-6 p.m.; Sun 10 a.m.-6 p.m. Book returns 24/7. Address: 5614 22nd Ave NW (47.669874, -122.3843863). Phone 206-684-4089.
SAMPLE: <div class="branch-header__hours"><h3>Open for book returns 24/7.</h3><h4>Open Hours</h4><ol><li><span>Mon</span><span> 10 a.m. - 6 p.m. </span></li> ... [('Tue','10 a.m. - 8 p.m.'),('Wed','10 a.m. - 8 p.m.'),('Thu','10 a.m. - 8 p.m.'),('Fri','10 a.m. - 6 p.m.'),('Sat','10 a.m. - 6 p.m.'),('Sun','10 a.m. - 6 p.m.')]
FRESH: Fetched 2026-09-25 (current)

## nordic-museum-hours (poll 0)
URL: https://nordicmuseum.org/contact
NOTES: /visit redirects to /what-to-see-and-do, which says 'Tuesday through Sunday 10am – 5pm'. The Thursday extension is only on /contact.
FORMAT: HTML (static facts)
FIELDS: Static: Monday closed; Tue, Wed, Fri, Sat, Sun 10am-5pm; Thursday 10am-8pm (extended). Closed Thanksgiving Day, Christmas Eve, Christmas Day, and New Year's Day. Freya Café: Tue-Sun 10am-5pm, Thu until 7pm. Address 2655 NW Market St.
SAMPLE: "Museum Hours The Museum is open Tuesday-Sunday from 10am-5pm, with extended hours every Thursday until 8pm. We are open year-round with the exception of Thanksgiving Day, Christmas Eve, Christmas Day, and New Year's Day." ... "Hours Monday Closed Tuesday 10am - 5pm Wednesday 10am - 5pm Thursday 10am - 8pm (Extended hours) Friday 10am - 5pm Saturday 10am - 5pm Sunday 10am - 5pm"
FRESH: Fetched 2026-09-25 (current)

## kc-cso-status (poll 600)
URL: https://your.kingcounty.gov/dnrp/library/wastewater/cso/img/CSO_metadata.CSV
NOTES: Found through the ArcGIS webmap 6de3cae45d914326a32ed120b5ace4f8 embedded on https://kingcounty.gov/en/dept/dnrp/waste-services/wastewater-treatment/sewer-system-services/cso-status. There is an ETag and Last-Modified for conditional GET. The data is unreviewed real-time data. The advice is to stay out of the water for 48h after an overflow.
FORMAT: CSV (129 rows; Content-Type application/octet-stream)
FIELDS: Columns: CSO_TagName, X_COORD (lon), Y_COORD (lat), Name ('King County CSO: Ballard' or 'Seattle CSO'), DSN, DateTime ('MM/DD/YYYY HH:MM', Pacific local), Status (CurrentlyOverflowing | OverflowLast48hrs | NoRecentOverflow | NoData). Skip the 4 'Dummy' legend rows (X=-120.0). Ballard bbox rows: BALL, 11TH, NBEA, NPDES056, 057, 059, 060, 148, 151, 152 (and CANL, 3RD, 174 just south).
SAMPLE: CSO_TagName,X_COORD,Y_COORD,Name,DSN,DateTime,Status
CSO_Status1,-120.0,47.66,Dummy1,DSN,09/24/2026 19:40,CurrentlyOverflowing
BALL,-122.382333,47.663916,King County CSO: Ballard,3,09/24/2026 19:40,NoRecentOverflow
11TH,-122.370774,47.659491,King County CSO: 11th Ave NW,4,09/24/2026 19:40,NoRecentOverflow
NPDES060,-122.4077581,47.66783263,Seattle CSO,60,09/24/2026 19:40,NoRecentOverflow
FRESH: DateTime 09/24/2026 19:40 PDT with Last-Modified 2026-09-25 02:40:09Z, probed at 02:40-02:45Z (under 5 min old). Citywide: 1 CurrentlyOverflowing, 1 OverflowLast48hrs, 116 NoRecentOverflow, 11 NoData. All Ballard sites NoRecentOverflow.

## seattle-street-closures (poll 21600)
URL: https://data.seattle.gov/resource/ium9-iqtc.json?$where=within_box(line_string,47.700,-122.410,47.655,-122.360)%20AND%20start_date%20%3C%3D%20'2026-09-24T23:59:59'%20AND%20end_date%20%3E%3D%20'2026-09-24T00:00:00'&$order=start_date%20DESC&$limit=200
NOTES: within_box(col, north_lat, west_lon, south_lat, east_lon) works on line columns. Construction closures are NOT in this dataset; it only holds community/event closures. There is a bad-data row with start_date 2924-06-16, so guard against absurd dates. To answer 'closed today', check the weekday column for the current Pacific day.
FORMAT: JSON array (Socrata)
FIELDS: permit_number; permit_type ('Block Party','Play Street','Farmers Market','Temporary Activation','Safe Starts Street Use','Unknown Temporary Activation'); project_name; project_description; start_date and end_date (floating local); sunday..saturday (hours text such as '6PM-9PM' or 'All Day'; the key is absent when there is no closure that day); street_on, street_from, street_to; segkey; line_string {type:LineString, coordinates:[[lon,lat],...]}. There is one row per street segment, so group by permit_number.
SAMPLE: {"permit_number":"SUFUN0006276","permit_type":"Play Street","project_name":"Play Street | Every Fri | on 16th Ave NW","start_date":"2026-05-29T00:00:00.000","end_date":"2026-10-05T00:00:00.000","friday":"6PM-9PM","street_on":"16TH AVE NW","street_from":"NW 70TH ST","street_to":"NW 73RD ST","segkey":"2271"} ; {"permit_number":"SUFUN0006056","permit_type":"Farmers Market",...,"sunday":"6AM-5PM","street_on":"BALLARD AVE NW","street_from":"20TH AVE NW","street_to":"NW VERNON PL"}
FRESH: rowsUpdatedAt 2026-09-24 22:22Z. 7 active segments in the Ballard bbox on 2026-09-24.

## seattle-311-requests (poll 3600)
URL: https://data.seattle.gov/resource/5ngg-rpne.json?$where=within_circle(latitude_longitude,47.6687,-122.3847,2000)&$order=createddate%20DESC&$limit=50
NOTES: Label it as 'as of yesterday'. A companion tracking dataset, 43nw-pkdq ('Customer Service Request Tracking Data', updated 2026-09-25 02:39Z), may be fresher but was NOT queried.
FORMAT: JSON array (Socrata)
FIELDS: servicerequestnumber; webintakeservicerequests (request type, e.g. 'Unauthorized Encampment', 'Abandoned Vehicle/72hr Parking Ordinance'); departmentname; createddate (floating local); methodreceivedname; servicerequeststatusname ('Open', etc.); location (address text); latitude, longitude (numbers); latitude_longitude (point); zipcode; policeprecinct; community_reporting_area (e.g. 'WHITTIER HEIGHTS', 'SUNSET HILL/LOYAL HEIGHTS')
SAMPLE: {"servicerequestnumber":"26-00286601","webintakeservicerequests":"Unauthorized Encampment","departmentname":"SEA-City of Seattle","createddate":"2026-09-23T22:39:51.000","methodreceivedname":"Citizen Web Intake App","servicerequeststatusname":"Open","location":"6116 22ND AVE NW, SEATTLE, WA 98107","latitude":"47.67367144","longitude":"-122.38436133","zipcode":"98107","councildistrict":"6","policeprecinct":"NORTH","community_reporting_area":"WHITTIER HEIGHTS"}
FRESH: max(createddate) = 2026-09-24T02:50 local, about 17h before the probe. Newest Ballard row 2026-09-23 23:21. rowsUpdatedAt 2026-09-24 18:36Z.

## seattle-building-permits (poll 21600)
URL: https://data.seattle.gov/resource/76t5-zqzr.json?$select=permitnum,permittypedesc,description,originaladdress1,issueddate,statuscurrent,estprojectcost,latitude,longitude,link&$where=within_circle(location1,47.6687,-122.3847,2000)%20AND%20issueddate%20IS%20NOT%20NULL&$order=issueddate%20DESC&$limit=25
NOTES: Some rows are 'Ready for Issuance' with a future or odd issueddate, so filter on statuscurrent if needed.
FORMAT: JSON array (Socrata)
FIELDS: permitnum; permittypedesc; description; originaladdress1; issueddate and applieddate (date only, T00:00); statuscurrent ('Issued','Ready for Issuance',...); estprojectcost (string); housingunitsadded; latitude, longitude; link.url (Accela record); location1 (geo column used for within_circle)
SAMPLE: {"permitnum":"7145413-CN","permittypedesc":"Addition/Alteration","description":"Change of use from general retail sales and services to restaurant per land use code. Construct tenant improvements ... ( Alma and Fuego cafe)","originaladdress1":"7733 24TH AVE NW","issueddate":"2026-09-19T00:00:00.000","statuscurrent":"Issued","estprojectcost":"10000.0000","latitude":"47.68600584","longitude":"-122.38796268","link":{"url":"https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=7145413-CN"}}
FRESH: max(issueddate) = 2026-09-23. rowsUpdatedAt 2026-09-25 01:14Z.
