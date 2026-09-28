# weather, sky & air

## open-meteo-forecast (poll 900)
URL: https://api.open-meteo.com/v1/forecast?latitude=47.6687&longitude=-122.3847&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,visibility,uv_index,pressure_msl&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,cloud_cover,visibility&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FLos_Angeles&forecast_days=7&forecast_hours=24
NOTES: No headers needed. Free tier is for non-commercial use, about 10k calls/day. Snaps to the grid cell at 47.665,-122.394 (effectively the Locks area). Timestamps are local wall-clock with no offset, so apply utc_offset_seconds. The 'mp/h' unit label is just its spelling of mph. Visibility is in feet when imperial units are selected (divide by 5280 for miles). This is modeled data, not measured: it read 53.4F while the nearby stations read 55-57F.
FORMAT: JSON
FIELDS: current.time (local ISO, no offset), current.temperature_2m (F), current.apparent_temperature (F feels-like), current.relative_humidity_2m (%), current.precipitation (in), current.weather_code (WMO code), current.cloud_cover (%), current.wind_speed_10m / wind_gusts_10m (mph), current.wind_direction_10m (deg from), current.is_day (0/1), current.visibility (FEET because imperial units selected), current.uv_index, current.pressure_msl (hPa). hourly.* = parallel arrays indexed by hourly.time (24 entries starting at the current local hour): temperature_2m, apparent_temperature, precipitation_probability (%), precipitation, weather_code, wind_speed_10m, wind_gusts_10m, wind_direction_10m, uv_index, cloud_cover, visibility. daily.* = parallel arrays over daily.time (7 days): weather_code, temperature_2m_max/min, precipitation_probability_max, precipitation_sum (in), wind_speed_10m_max, wind_gusts_10m_max, wind_direction_10m_dominant, uv_index_max, sunrise, sunset (local ISO). utc_offset_seconds (-25200 during PDT).
SAMPLE: {"latitude":47.66542,"longitude":-122.39413,"utc_offset_seconds":-25200,"timezone":"America/Los_Angeles","current":{"time":"2026-09-24T19:30","interval":900,"temperature_2m":53.4,"apparent_temperature":50.7,"relative_humidity_2m":91,"precipitation":0.0,"weather_code":3,"cloud_cover":100,"wind_speed_10m":7.0,"wind_direction_10m":27,"wind_gusts_10m":11.9,"is_day":0,"visibility":44291.34,"uv_index":0.0,"pressure_msl":1009.9},"hourly":{"time":["2026-09-24T19:00","2026-09-24T20:00"],"temperature_2m":[54.3,53.7],"precipitation_probability":[21,21]},"daily":{"time":["2026-09-24"],"temperature_2m_max":[60.3],"temperature_2m_min":[50.4],"sunrise":["2026-09-24T06:59"],"sunset":["2026-09-24T19:02"]}}
FRESH: current.time 2026-09-24T19:30 PDT (02:30Z) vs now 02:33Z, about 3 min old.

## open-meteo-nowcast-15min (poll 900)
URL: https://api.open-meteo.com/v1/forecast?latitude=47.6687&longitude=-122.3847&minutely_15=precipitation,rain,weather_code&forecast_minutely_15=12&precipitation_unit=inch&timezone=America%2FLos_Angeles
NOTES: You can merge these params into the main forecast call to save a request. The params were verified separately, not combined.
FORMAT: JSON
FIELDS: minutely_15.time[] (local ISO), minutely_15.precipitation[] (in per 15 min), minutely_15.rain[], minutely_15.weather_code[]
SAMPLE: {"minutely_15":{"time":["2026-09-24T19:30","2026-09-24T19:45",...,"2026-09-24T21:45","2026-09-24T22:00"],"precipitation":[0.0,0.0,...,0.004,0.004],"weather_code":[3,3,...,51,51]}}
FRESH: First slot 19:30 PDT, same as now (02:33Z).

## nws-points (poll 86400)
URL: https://api.weather.gov/points/47.6687,-122.3847
NOTES: Send User-Agent: 'BallardDashboard/1.0 (contact)' and Accept: application/geo+json. A request with no UA also returned 200 in testing, but NWS policy requires a UA, so always send one. The marine zone PZZ135 is NOT listed here because it covers water, not this land point.
FORMAT: GeoJSON (JSON)
FIELDS: properties.gridId=SEW, gridX=124, gridY=71, properties.forecast, forecastHourly, forecastGridData, observationStations, forecastZone=WAZ315, county=WAC033, fireWeatherZone=WAZ654, radarStation=KATX, timeZone=America/Los_Angeles
SAMPLE: {"properties":{"gridId":"SEW","gridX":124,"gridY":71,"forecast":"https://api.weather.gov/gridpoints/SEW/124,71/forecast","forecastHourly":"https://api.weather.gov/gridpoints/SEW/124,71/forecast/hourly","observationStations":"https://api.weather.gov/gridpoints/SEW/124,71/stations","forecastZone":"https://api.weather.gov/zones/forecast/WAZ315","county":"https://api.weather.gov/zones/county/WAC033","radarStation":"KATX","relativeLocation":{"properties":{"city":"Seattle","state":"WA"}}}}
FRESH: Static metadata

## nws-forecast-periods (poll 1800)
URL: https://api.weather.gov/gridpoints/SEW/124,71/forecast
NOTES: User-Agent required. The NWS API sometimes returns a transient 500/503 on gridpoint endpoints, so retry once and serve the cached copy. windSpeed is a string (parse it with a regex). The icon URLs are api.weather.gov images and can be used directly.
FORMAT: GeoJSON (JSON)
FIELDS: properties.updateTime; properties.periods[]: number, name ('Tonight','Friday'), startTime/endTime (ISO with -07:00 offset), isDaytime, temperature + temperatureUnit (F), probabilityOfPrecipitation.value (%), windSpeed (string, e.g. '3 to 9 mph'), windDirection (compass string), icon (URL), shortForecast, detailedForecast
SAMPLE: {"number":1,"name":"Tonight","startTime":"2026-09-24T18:00:00-07:00","endTime":"2026-09-25T06:00:00-07:00","isDaytime":false,"temperature":54,"temperatureUnit":"F","probabilityOfPrecipitation":{"unitCode":"wmoUnit:percent","value":94},"windSpeed":"1 to 6 mph","windDirection":"NE","icon":"https://api.weather.gov/icons/land/night/rain,90?size=medium","shortForecast":"Light Rain","detailedForecast":"Rain. Cloudy, with a low around 54. Northeast wind 1 to 6 mph. Chance of precipitation is 90%..."}
FRESH: updateTime 2026-09-24T19:20:42Z (about 7h old, which is normal for the forecast cycle). First period starts at 18:00 PDT today.

## nws-forecast-hourly (poll 1800)
URL: https://api.weather.gov/gridpoints/SEW/124,71/forecast/hourly
NOTES: User-Agent required. The response is large (156 periods), so slice the first 24.
FORMAT: GeoJSON (JSON)
FIELDS: properties.periods[]: startTime, temperature (F), probabilityOfPrecipitation.value, dewpoint.value (degC), relativeHumidity.value, windSpeed (string mph), windDirection, shortForecast, icon
SAMPLE: {"startTime":"2026-09-24T19:00:00-07:00","temperature":59,"probabilityOfPrecipitation":{"unitCode":"wmoUnit:percent","value":34},"windSpeed":"5 mph","windDirection":"N","shortForecast":"Chance Light Rain","icon":"https://api.weather.gov/icons/land/night/rain,30?size=small"}
FRESH: generatedAt 02:37Z (now). First period is the current hour, 19:00 PDT.

## nws-alerts (poll 120)
URL: https://api.weather.gov/alerts/active?zone=WAZ315,WAC033,PZZ135
NOTES: User-Agent required. Comma-separated zone list works in one call. The point query (https://api.weather.gov/alerts/active?point=47.6687,-122.3847) also returns 200 but misses marine alerts. Do not poll faster than 30s.
FORMAT: GeoJSON (JSON)
FIELDS: features[].properties: id, event, severity, urgency, certainty, onset, ends, expires (ISO with offset), headline, description, instruction, areaDesc, geocode.UGC[]; top-level updated
SAMPLE: {"event":"Small Craft Advisory","severity":"Minor","urgency":"Expected","onset":"2026-09-25T11:00:00-07:00","ends":"2026-09-25T23:00:00-07:00","headline":"Small Craft Advisory issued September 24 at 1:32PM PDT until September 25 at 11:00PM PDT by NWS Seattle WA","areaDesc":"Puget Sound and Hood Canal","description":"* WHAT...South winds 10 to 20 kt with gusts to 25 kt..."}
FRESH: Live. Top-level updated was 02:33Z (now). 1 active alert (marine SCA).

## nws-obs-kbfi (poll 300)
URL: https://api.weather.gov/stations/KBFI/observations/latest
NOTES: User-Agent required. Every value is a {unitCode,value,qualityControl} object in SI units: convert C to F, km/h to mph (x0.621371), Pa to inHg (/3386.39), m to mi. Fields can be null and keys like precipitationLastHour are sometimes absent, so guard every access. Alternates: /stations/KSEA/observations/latest and /stations/SEAW1/observations/latest (both 200).
FORMAT: GeoJSON (JSON)
FIELDS: properties.timestamp (UTC ISO), textDescription, icon, temperature.value (degC), dewpoint.value (degC), relativeHumidity.value (%), windDirection.value (deg), windSpeed.value (km/h), windGust.value (km/h or null), barometricPressure.value (Pa), seaLevelPressure.value (Pa), visibility.value (m), windChill/heatIndex.value (degC or null), rawMessage (METAR, empty on 5-min obs), cloudLayers[]
SAMPLE: {"stationId":"KBFI","timestamp":"2026-09-25T02:15:00+00:00","textDescription":"Mostly Cloudy","temperature":{"unitCode":"wmoUnit:degC","value":14,"qualityControl":"V"},"windSpeed":{"unitCode":"wmoUnit:km_h-1","value":0},"windDirection":{"value":0},"windGust":{"value":null,"qualityControl":"Z"},"relativeHumidity":{"value":76.84},"barometricPressure":{"unitCode":"wmoUnit:Pa","value":100880.52},"visibility":{"unitCode":"wmoUnit:m","value":16093.44}}
FRESH: timestamp 02:15Z vs now 02:33Z, 18 min old. KSEA was 02:10Z. SEAW1 was 01:30Z.

## nws-obs-ballard-cwop (poll 300)
URL: https://api.weather.gov/stations/AW337/observations/latest
NOTES: User-Agent required. That is one call per station, so fetch 3 in parallel and show the median or each on the map. These are amateur sensors, so show a timestamp and hide a reading older than about 90 min. Wind is often 0 because of sheltered placement. The station list came from https://api.weather.gov/stations?state=WA&limit=500 (paginated through pagination.next).
FORMAT: GeoJSON (JSON)
FIELDS: Same shape as KBFI: properties.timestamp, temperature.value (degC), relativeHumidity.value, windSpeed.value (km/h), windGust.value (km/h), windDirection.value, barometricPressure.value (Pa, often null). No textDescription or visibility. Other URLs use the same pattern: /stations/E7826/observations/latest, /stations/F8372/observations/latest, /stations/AS437/observations/latest
SAMPLE: {"stationId":"AW337","timestamp":"2026-09-25T02:19:00+00:00","temperature":{"unitCode":"wmoUnit:degC","value":13.33,"qualityControl":"V"},"relativeHumidity":{"value":91.9},"windSpeed":{"unitCode":"wmoUnit:km_h-1","value":0},"windGust":{"value":4.824,"qualityControl":"S"},"windDirection":{"value":207}}
FRESH: AW337 02:19Z (16 min old), E7826 02:11Z (24 min), F8372 02:17Z (18 min), AS437 02:17Z; checked at 02:35Z

## open-meteo-air-quality (poll 3600)
URL: https://air-quality-api.open-meteo.com/v1/air-quality?latitude=47.6687&longitude=-122.3847&current=us_aqi,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone,pm2_5,pm10,ozone,nitrogen_dioxide,carbon_monoxide,sulphur_dioxide,uv_index&hourly=us_aqi,pm2_5,pm10,ozone&timezone=America%2FLos_Angeles&forecast_days=2
NOTES: No key. Grid cell is at 47.70,-122.40 (coarse, about 10-40 km). Pollen variables are accepted but return null outside Europe, so don't request them. us_aqi uses a rolling average, so it lags.
FORMAT: JSON
FIELDS: current.time (local, hourly), current.us_aqi, us_aqi_pm2_5, us_aqi_pm10, us_aqi_ozone (USAQI), pm2_5, pm10, ozone, nitrogen_dioxide, carbon_monoxide, sulphur_dioxide (ug/m3), uv_index; hourly.time[] + hourly.us_aqi[], pm2_5[], pm10[], ozone[] (hourly starts at 00:00 local today, so skip past hours)
SAMPLE: {"latitude":47.699997,"longitude":-122.399994,"current":{"time":"2026-09-24T19:00","interval":3600,"us_aqi":76,"us_aqi_pm2_5":76,"us_aqi_pm10":23,"us_aqi_ozone":25,"pm2_5":16.1,"pm10":16.6,"ozone":28.0,"nitrogen_dioxide":34.4,"carbon_monoxide":178.0,"alder_pollen":null,"birch_pollen":null,"grass_pollen":null,"ragweed_pollen":null}}
FRESH: current.time 19:00 PDT (02:00Z) vs now 02:33Z. That is the current hour.

## airnow-reportingarea (poll 1800)
URL: https://files.airnowtech.org/airnow/today/reportingarea.dat
NOTES: No key or UA needed. Same file on S3: https://s3-us-west-1.amazonaws.com//files.airnowtech.org/airnow/today/reportingarea.dat. Supports If-Modified-Since (304 verified), so cache on Last-Modified. Parse server-side and keep only the Seattle lines. Times are local PDT.
FORMAT: Pipe-delimited text, no header, about 1.8 MB for all of the US
FIELDS: Columns (split on '|'): [0] IssueDate, [1] ValidDate (MM/DD/YY), [2] ValidTime (HH:MM local, blank for forecasts), [3] TimeZone (PDT), [4] DayIndex, [5] RecordType (O=observed now, F=forecast, Y=yesterday), [6] Primary (Y/N), [7] ReportingArea, [8] State, [9] Lat, [10] Lon, [11] Parameter (PM2.5/PM10/OZONE), [12] AQI, [13] Category (Good/Moderate...), [14] ActionDay, [15] Discussion, [16] ForecastSource. Filter [7]=='Seattle-Bellevue-Kent Valley' && [8]=='WA'.
SAMPLE: 09/24/26|09/24/26|19:00|PDT|0|O|Y|Seattle-Bellevue-Kent Valley|WA|47.5620|-122.3405|PM2.5|44|Good|No||Puget Sound Clean Air Agency
09/24/26|09/24/26|19:00|PDT|0|O|N|Seattle-Bellevue-Kent Valley|WA|47.5620|-122.3405|OZONE|12|Good|No||Puget Sound Clean Air Agency
09/21/26|09/25/26||PDT|4|F|Y|Seattle-Bellevue-Kent Valley|WA|47.5620|-122.3405|PM2.5|28|Good|No|For Mon-Fri (Sep 21-25): We should have GOOD air quality this week...|Puget Sound Clean Air Agency
FRESH: Last-Modified 02:26:53Z. Observed ValidTime 19:00 PDT = 02:00Z. Now is 02:36Z.

## airnow-hourly-monitors (poll 1800)
URL: https://files.airnowtech.org/airnow/2026/20260925/HourlyAQObs_2026092501.dat
NOTES: The filename is built from the UTC date and hour: https://files.airnowtech.org/airnow/YYYY/YYYYMMDD/HourlyAQObs_YYYYMMDDHH.dat. Try (now-1h) first and fall back to (now-2h) on 404. HourlyAQObs was NOT in /airnow/today/ (404 there), but HourlyData_YYYYMMDDHH.dat was. Times are UTC. Use If-Modified-Since.
FORMAT: CSV with quoted fields and a header row (about 1 MB)
FIELDS: AQSID, SiteName, Latitude, Longitude, ValidDate (MM/DD/YYYY UTC), ValidTime (HH:MM UTC), ReportingArea_PipeDelimited, PM25_AQI, OZONE_AQI, PM10_AQI, NO2_AQI (NowCast AQI), PM25 (UG/M3), OZONE (PPB), NO2 (PPB), CO (PPM), PM25_Measured flags. Filter AQSID in [530330039,530330048,530330030,530330080,530330024]. Blank string = missing.
SAMPLE: "AQSID","SiteName","Status","EPARegion","Latitude","Longitude",...,"ValidDate","ValidTime","DataSource","ReportingArea_PipeDelimited","OZONE_AQI","PM10_AQI","PM25_AQI","NO2_AQI",...,"PM25","PM25_Unit",...
"530330030","Seattle-10th & Weller","Active","R10","47.597222","-122.319722","41.8","-8","US","WA","09/25/2026","01:00","Washington Department of Ecology","Seattle-Bellevue-Kent Valley","","","31","","0","0","1","1","6.8","UG/M3",...,"0.3","PPM"
FRESH: Newest file at 02:36Z was the 01Z hour (Last-Modified 02:23Z). The 02Z file returned 404 at that point, so data lags about 1.5h.

## purpleair-airfire-export (poll 1200)
URL: https://airfire-data-exports.s3.us-west-2.amazonaws.com/maps/purple_air/v4/pas.csv
NOTES: Content-Type is binary/octet-stream, so parse it as text. Supports If-Modified-Since (304 verified), which avoids re-downloading 1.5 MB. Some rows are stale (sensors offline), so filter on utc_ts. The column meaning of utc_ts (start vs end of the averaging hour) is not documented, so show it as 'hourly avg'. Ballard sensor ids: 2069, 13285, 32523, 79055, 83087, 112536, 123393, 129135, 154341, 154957, 155415, 157083, 164501, 164507, 165325, 188087, 250037, 281266, 320412 (plus stale 193657, 101788, 52135).
FORMAT: CSV with a header row, about 1.5 MB, about 18.5k sensors across North America
FIELDS: sensor_index, latitude, longitude, utc_ts ('YYYY-MM-DD HH:MM:SS+0000', hourly), epa_pm25 (EPA-corrected hourly PM2.5 ug/m3), epa_nowcast (NowCast PM2.5 ug/m3, use this for AQI), timezone, raw_pm25. Filter lat 47.655-47.700, lon -122.410 to -122.360, and drop rows where utc_ts is older than about 2h. Convert epa_nowcast to AQI with the EPA 2024 PM2.5 breakpoints (0-9.0 = 0-50, 9.1-35.4 = 51-100, 35.5-55.4 = 101-150, 55.5-125.4 = 151-200, 125.5-225.4 = 201-300).
SAMPLE: sensor_index,latitude,longitude,utc_ts,epa_pm25,epa_nowcast,timezone,raw_pm25
2069,47.666977,-122.39336,2026-09-25 02:00:00+0000,5.3,5.3,America/Los_Angeles,7.2
32523,47.668514,-122.372475,2026-09-25 02:00:00+0000,5.6,5.6,America/Los_Angeles,8.1
83087,47.68004,-122.38896,2026-09-25 02:00:00+0000,5.1,5.3,America/Los_Angeles,8.0
123393,47.671104,-122.39402,2026-09-25 02:00:00+0000,12.1,7.7,America/Los_Angeles,21.4
193657,47.670277,-122.401695,2026-09-24 23:00:00+0000,4.7,4.2,America/Los_Angeles,2.2
FRESH: Last-Modified 02:01:46Z. 17,785 of 18,473 rows have utc_ts 2026-09-25 02:00Z. Now is 02:36Z.

## ndbc-wpow1-cwind (poll 600)
URL: https://www.ndbc.noaa.gov/data/realtime2/WPOW1.cwind
NOTES: No key or UA needed. Times are UTC. Gust fields are only filled on the hourly row. The same station is also available as JSON through https://api.weather.gov/stations/WPOW1/observations/latest (200; it returned 02:00Z, windSpeed 16.56 km/h, pressure 100865.87 Pa). A human-readable summary is at https://www.ndbc.noaa.gov/data/latest_obs/wpow1.txt ('Wind: N (360), 9 kt ... Air Temp: 56.1 F').
FORMAT: Whitespace-delimited text, 2 header lines (#), newest row first
FIELDS: cols: YY MM DD hh mm (UTC), WDIR (deg true), WSPD (m/s, 10-min avg), GDR (gust dir), GST (m/s peak gust), GTIME (hhmm of gust). Missing values appear as 99.0 / 999 / 9999 / MM. Convert m/s to mph (x2.23694) or to kt (x1.94384).
SAMPLE: #YY  MM DD hh mm WDIR WSPD GDR GST GTIME
#yr  mo dy hr mn degT m/s degT m/s hhmm
2026 09 25 02 00 001  4.6  10  6.2 0102
2026 09 25 01 50 002  4.6 999 99.0 9999
FRESH: Newest row 02:00Z, Last-Modified 02:10Z, fetched at 02:34Z (34 min old).

## ndbc-wpow1-stdmet (poll 900)
URL: https://www.ndbc.noaa.gov/data/realtime2/WPOW1.txt
NOTES: Read only the first few lines (the file is large, about 45 days). The top ~12 rows make a good 12h wind and pressure sparkline.
FORMAT: Whitespace-delimited text, 2 header lines, newest first, 45 days of history
FIELDS: YY MM DD hh mm (UTC), WDIR degT, WSPD m/s, GST m/s, PRES hPa, ATMP degC, PTDY hPa (3-h pressure tendency), WTMP/DEWP/VIS/TIDE are always MM at this station
SAMPLE: #YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 09 25 02 00 360  4.6  4.6    MM    MM    MM  MM 1009.2  13.4    MM    MM   MM -1.1    MM
2026 09 25 01 00  10  5.7  6.2    MM    MM    MM  MM 1009.5  13.7    MM    MM   MM -0.8    MM
FRESH: Newest row 02:00Z vs now 02:34Z

## nws-marine-pzz135-text (poll 1800)
URL: https://tgftp.nws.noaa.gov/data/forecasts/marine/coastal/pz/pzz135.txt
NOTES: No UA needed. Content-Type text/plain. Wind is in knots. JSON alternative: https://api.weather.gov/products/types/CWF/locations/SEW (200, lists products; fetch @graph[0]['@id'] and read productText, then extract the PZZ135 block). https://api.weather.gov/zones/coastal/PZZ135/forecast returns 404 'Marine Forecast Not Supported'.
FORMAT: Plain text
FIELDS: Line 'Expires:YYYYMMDDhhmm' (UTC). Issuance line (e.g. '132 PM PDT Thu Sep 24 2026'). Optional '...SMALL CRAFT ADVISORY...' headline block between '...' markers. Periods start with '.TONIGHT...', '.FRI...' and so on. Split on /^\.([A-Z ]+)\.\.\./m. End marker '$$'.
SAMPLE: Expires:202609250945;;995819
FZUS56 KSEW 242032
CWFSEW
...
PZZ135-250945-
Puget Sound and Hood Canal-
132 PM PDT Thu Sep 24 2026

...SMALL CRAFT ADVISORY IN EFFECT FROM FRIDAY MORNING THROUGH
FRIDAY EVENING...

.TONIGHT...N wind 5 to 10 kt, becoming NE late this evening,
veering to SE after midnight. Waves around 2 ft or less...
.FRI...S wind 10 to 20 kt with gusts to 25 kt. Waves around 2 ft
or less...
FRESH: Last-Modified 2026-09-24 20:32:41Z (issued 1:32 PM PDT), expires 2026-09-25 09:45Z. Current.

## nws-afd-sew (poll 3600)
URL: https://api.weather.gov/products/types/AFD/locations/SEW/latest
NOTES: User-Agent required.
FORMAT: JSON
FIELDS: issuanceTime (UTC ISO), productText (full text; show the .SYNOPSIS... section, which ends at the next '&&')
SAMPLE: {"issuanceTime":"2026-09-24T20:46:00+00:00","productText":"...AFDSEW\n\nArea Forecast Discussion\nNational Weather Service Seattle WA\n146 PM PDT Thu Sep 24 2026\n\n.SYNOPSIS...\nA stronger, more typical fall weather system has arrived on the\ncoast this afternoon, and will continue moving into the area\nthrough Friday. Rain, increasing winds and the potential for\nisolated thunderstorms are forecast..."}
FRESH: issuanceTime 20:46Z, about 6h old (normal cycle)

## usno-sun-moon (poll 21600)
URL: https://aa.usno.navy.mil/api/rstt/oneday?date=2026-09-24&coords=47.6687,-122.3847&tz=-8&dst=true
NOTES: Set date= to today in America/Los_Angeles. With tz=-8&dst=true the service applies DST itself, but times come back suffixed like '06:59  DT', so strip the non-digits (verified). tz=-7&dst=false returns clean times but is only right during PDT. Moon events can be missing on some days.
FORMAT: GeoJSON-like JSON
FIELDS: properties.data.sundata[] {phen: 'Begin Civil Twilight'|'Rise'|'Upper Transit'|'Set'|'End Civil Twilight', time 'HH:MM'}, moondata[] {phen, time}, curphase (e.g. 'Waxing Gibbous'), fracillum ('96%'), closestphase {phase, year, month, day, time}, tz, isdst
SAMPLE: {"curphase":"Waxing Gibbous","fracillum":"96%","closestphase":{"day":26,"month":9,"phase":"Full Moon","time":"09:49","year":2026},"sundata":[{"phen":"Begin Civil Twilight","time":"06:29"},{"phen":"Rise","time":"06:59"},{"phen":"Upper Transit","time":"13:01"},{"phen":"Set","time":"19:03"},{"phen":"End Civil Twilight","time":"19:33"}],"moondata":[{"phen":"Set","time":"04:38"},{"phen":"Rise","time":"18:13"},{"phen":"Upper Transit","time":"23:55"}],"tz":-7.0}
FRESH: Computed for the requested date (astronomical, always current)

## nws-ridge-radar-katx (poll 300)
URL: https://radar.weather.gov/ridge/standard/KATX_loop.gif
NOTES: The browser can load it directly with a cache-busting ?t= param, or the server can proxy it. The image covers a wide area (all of western WA). Use the IEM tiles for a zoomed Ballard view.
FORMAT: Animated GIF (about 1.45 MB). Single latest frame: https://radar.weather.gov/ridge/standard/KATX_0.gif
FIELDS: Image only. Use Last-Modified as the 'as of' time.
SAMPLE: HTTP/2 200 content-type: image/gif content-length: 1454443 last-modified: Fri, 25 Sep 2026 02:35:26 GMT
FRESH: Loop Last-Modified 02:35:26Z, latest frame 02:33:13Z, checked at 02:36:44Z

## iem-nexrad-tiles (poll 300)
URL: https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png
NOTES: Tiles carry Cache-Control max-age=300. To use in a Leaflet map without a key, layer these over an OSM basemap (basemap not verified here). Be polite: the server should cache tiles rather than hammer IEM.
FORMAT: PNG XYZ tiles (Web Mercator, 256px). Timestamp JSON: https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json
FIELDS: Tiles: Ballard is tile z10 x163 y357 (z8 x40 y89). Timestamp JSON: meta.valid (UTC ISO), meta.radar_quorum. Past frames: replace the layer with nexrad-n0q-900913-m05m, -m10m ... -m50m (verified -m30m returns 200).
SAMPLE: {"meta": {"vcp": null, "product": "N0Q", "site": "USCOMP", "valid": "2026-09-25T02:35:00Z", "processing_time_secs": 100, "radar_quorum": "144/147"}}
FRESH: meta.valid 02:35Z vs now 02:37Z

## swpc-kp-aurora (poll 600)
URL: https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
NOTES: No key. time_tag is UTC with no Z suffix.
FORMAT: JSON array
FIELDS: Last element: time_tag (UTC ISO without Z), kp_index (int), estimated_kp (float), kp (string like '3P'). The 3-hourly official series is at https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json (200). It is now an array of objects {time_tag, Kp, a_running, station_count}, not the older array-of-arrays shape.
SAMPLE: [...,{"time_tag":"2026-09-25T02:33:00","kp_index":3,"estimated_kp":3.33,"kp":"3P"}]
FRESH: time_tag 02:33Z vs now 02:36Z
