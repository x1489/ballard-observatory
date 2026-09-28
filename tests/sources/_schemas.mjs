// CONTRACT.md output shapes for the 38 v1 sources, in the notation of _helpers.mjs shapeProblems().
// Field names are exact; '?' = may be null. Where CONTRACT.md is silent on nullability, the schema follows what
// the code intentionally emits (noted inline).

const PARAM = ['enum', 'PM2.5', 'OZONE', 'PM10'];

// ---------------------------------------------------------------- weather
export const weather = {
  current: {
    t: 'epoch', tempF: 'num?', feelsF: 'num?', humidity: 'int?', precipIn: 'num?', code: 'int?', cloud: 'int?',
    windMph: 'num?', gustMph: 'num?', windDir: 'int?', isDay: 'bool?', visMi: 'num?', uv: 'num?', pressureHpa: 'num?',
  },
  hourly: {
    $array: { t: 'epoch', tempF: 'num?', feelsF: 'num?', pop: 'int?', precipIn: 'num?', code: 'int?', windMph: 'num?', gustMph: 'num?', windDir: 'int?', uv: 'num?', cloud: 'int?' },
    max: 24,
  },
  daily: {
    $array: { date: 'date', t: 'epoch', code: 'int?', hiF: 'num?', loF: 'num?', pop: 'int?', precipIn: 'num?', windMph: 'num?', gustMph: 'num?', windDir: 'int?', uvMax: 'num?', sunrise: 'epoch?', sunset: 'epoch?' },
    max: 7,
  },
  nowcast: { $array: { t: 'epoch', precipIn: 'num?', code: 'int?' }, max: 12 },
  rainStartsAt: 'epoch?',
  rainEndsAt: 'epoch?',
};

export const nwsForecast = {
  updated: 'epoch?',
  periods: {
    $array: { name: 'str', start: 'epoch', end: 'epoch', isDay: 'bool', tempF: 'num', pop: 'int?', wind: 'str?', windDir: 'str?', short: 'str', detail: 'str', icon: 'str?' },
    min: 1, max: 8,
  },
};

export const alerts = {
  alerts: {
    $array: {
      id: 'str', event: 'str', severity: 'str?', urgency: 'str?', headline: 'str', description: 'str', instruction: 'str?',
      area: 'str', onset: 'epoch?', ends: 'epoch?', expires: 'epoch?', marine: 'bool',
    },
  },
};

export const stationRow = {
  id: 'str', lat: 'num', lon: 'num', distKm: 'num', t: 'epoch', tempF: 'num?', humidity: 'int?', windMph: 'num?', gustMph: 'num?',
  windDir: 'int?', pressureHpa: 'num?', stale: 'bool', inBallard: 'bool',
};
export const stations = { stations: { $array: stationRow, min: 1 }, medianTempF: 'num?', medianOf: 'int' };

export const westpoint = {
  lat: 'num', lon: 'num', t: 'epoch', windDir: 'num?', windKt: 'num?', windMph: 'num?', gustKt: 'num?', gustMph: 'num?',
  peakGustKt: 'num?', peakGustMph: 'num?', peakGustT: 'epoch?', pressureHpa: 'num?', pressureTendencyHpa: 'num?', airTempF: 'num?',
  history: { $array: { t: 'epoch', windKt: 'num?', gustKt: 'num?', windDir: 'num?', pressureHpa: 'num?' }, max: 24 },
};

export const marine = {
  issued: 'str?', issuedT: 'epoch?', expires: 'epoch?',
  headlines: { $array: 'str' },
  periods: { $array: { name: 'str', text: 'str' }, min: 1 },
};

export const afd = { issued: 'epoch?', synopsis: 'str', shortTerm: 'str?' };

export const sky = {
  date: 'date',
  sun: { civilDawn: 'epoch?', rise: 'epoch?', noon: 'epoch?', set: 'epoch?', civilDusk: 'epoch?' },
  moon: { rise: 'epoch?', set: 'epoch?', phase: 'str?', illum: 'int?' },
  nextPhase: { $nullable: { phase: 'str', t: 'epoch' } },
  tomorrowSun: { rise: 'epoch?', set: 'epoch?' },
};

export const kp = { t: 'epoch', kp: 'num', kpIndex: 'int', recent: { $array: { t: 'epoch', kp: 'num' }, max: 8 } };

export const radar = {
  valid: 'epoch', tileUrl: 'str', frames: { $array: { label: 'str', tileUrl: 'str' }, min: 11, max: 11 }, loopGif: 'str',
};

export const airnow = {
  observed: { $array: { param: PARAM, aqi: 'int?', category: 'str?', t: 'epoch?', primary: 'bool' } },
  forecast: { $array: { date: 'date', param: PARAM, aqi: 'int?', category: 'str?', primary: 'bool' } },
  discussion: 'str?',
};

export const purpleair = {
  sensors: { $array: { id: 'int', lat: 'num', lon: 'num', t: 'epoch', pm25: 'num', aqi: 'int' } },
  medianAqi: 'num?', medianPm25: 'num?', count: 'int', t: 'epoch?',
};

// ---------------------------------------------------------------- water
const tidePt = { t: 'epoch', ft: 'num' };
const hiloPt = { t: 'epoch', ft: 'num', type: ['enum', 'H', 'L'] };
export const tides = {
  station: 'str',
  hilo: { $array: hiloPt },
  curve: { $array: tidePt },
  observed: { $array: tidePt },
  latest: { $nullable: { t: 'epoch', ft: 'num', predictedFt: 'num?', anomalyFt: 'num?' } },
  next: { $array: hiloPt, max: 4 },
  trend: ['enum', 'rising', 'falling'],
};

export const currents = {
  station: 'str', events: { $array: { t: 'epoch', type: ['enum', 'slack', 'flood', 'ebb'], knots: 'num?' }, min: 1 },
};

export const lake = { t: 'epoch', ft: 'num', history: { $array: tidePt, min: 1 }, outflowCfs: 'num?', outflowT: 'epoch?' };

export const lockages = {
  recent: {
    $array: { name: 'str', direction: ['enum', 'up', 'down'], arrival: 'epoch', start: 'epoch?', end: 'epoch?', waitMin: 'num?', commercial: 'bool', mmsi: 'num?' },
    max: 30,
  },
  today: { up: 'int', down: 'int', total: 'int', commercial: 'int' },
  queued: 'int',
  avgWaitMin: 'num?',
  lastEnd: 'epoch?',
};

const stoppage = { chamber: 'num?', begin: 'epoch', end: 'epoch?', reason: 'str', scheduled: 'bool', trafficStopped: 'bool' };
export const stoppages = { active: { $array: stoppage }, upcoming: { $array: stoppage }, recent: { $array: stoppage } };

export const bridges = {
  bridges: { $array: { id: 'int', name: 'str', lat: 'num', lon: 'num', up: 'bool', since: 'epoch?', sinceKnown: 'bool' }, min: 1 },
  log: { $array: { bridge: 'str', upAt: 'epoch', downAt: 'epoch?', minutes: 'num?' }, max: 50 },
  observingSince: 'epoch',
};

const bridgeStat = { last24h: 'int', last7d: 'int', avgMin: 'num?', latest: 'epoch?' };
export const bridgeHistory = {
  openings: { $array: { bridge: ['enum', 'Ballard', 'Fremont'], open: 'epoch', close: 'epoch?', minutes: 'num?' }, max: 100 },
  stats: { Ballard: bridgeStat, Fremont: bridgeStat },
  newest: 'epoch?',
};

export const salmon = {
  year: 'int',
  species: {
    $array: {
      name: ['enum', 'Sockeye', 'Chinook', 'Coho'], latestDate: 'str?', latestT: 'epoch?', latestCount: 'int?', total: 'int?',
      recent: { $array: { date: 'str', count: 'int' }, max: 7 },
    },
    min: 1,
  },
  source: 'str',
};

export const cso = {
  sites: { $array: { tag: 'str', name: 'str', lat: 'num', lon: 'num', status: ['enum', 'overflowing', 'recent', 'none', 'nodata'], t: 'epoch?' }, min: 1 },
  overflowing: 'int', recent: 'int', t: 'epoch?',
};

// ---------------------------------------------------------------- move
export const arrival = {
  t: 'epoch', predicted: 'bool', min: 'num', vehicleId: 'str?', stopsAway: 'int?', distM: 'int?', occupancy: 'str?',
  deviationSec: 'int?', confidence: ['enum', 'live', 'scheduled', 'low'],
};
export const transit = {
  now: 'epoch',
  groups: {
    $array: {
      route: 'str', routeId: 'str', headsign: 'str', dir: 'str', stopId: 'str', stopName: 'str?', stopDir: 'str?',
      arrivals: { $array: arrival, min: 1, max: 4 },
    },
  },
  situations: { $array: { id: 'str', summary: 'str', description: 'str?', severity: 'str?', routes: { $array: 'str' } } },
};

export const vehicleRow = {
  route: ['enum', 'D Line', '40', '44'], headsign: 'str', vehicleId: 'str', lat: 'num', lon: 'num', heading: 'int?', deviationSec: 'int?', t: 'epoch',
};
export const vehicles = { vehicles: { $array: vehicleRow } };

export const metroAlerts = {
  alerts: {
    $array: {
      id: 'str', header: 'str', description: 'str?', effect: 'str', severity: 'str?', start: 'epoch?', end: 'epoch?',
      routes: { $array: 'str' }, stops: { $array: 'str' }, url: 'str?',
    },
  },
  total: 'int',
};

export const cameras = {
  cameras: { $array: { id: 'str', label: 'str', lat: 'num', lon: 'num', url: 'str', lastModified: 'epoch?', ok: 'bool' }, min: 8, max: 8 },
};

export const traffic = { sites: { $array: { id: 'str', name: 'str', links: { $array: { name: 'str', minutes: 'int?' } } }, min: 1 } };

export const incidentRow = {
  id: 'str', type: 'str', description: 'str', start: 'epoch?', end: 'epoch?', direction: 'str?', location: 'str?',
  lat: 'num', lon: 'num', url: 'str?', distKm: 'num',
};
export const incidents = { incidents: { $array: incidentRow }, citywide: 'int' };

export const lime = {
  t: 'epoch?', near: { total: 'int', scooters: 'int', ebikes: 'int', bikes: 'int' }, inBbox: 'int', points: { $array: 'any', max: 1000 },
};

// ---------------------------------------------------------------- civic
export const fire911 = {
  incidents: {
    $array: {
      id: 'str', type: 'str?', address: 'str?', t: 'epoch', lat: 'num?', lon: 'num?', units: 'str?', level: 'num?',
      active: 'bool?', distKm: 'num?', located: 'bool',
    },
  },
  activeKnown: 'bool', activeCount: 'int?', newest: 'epoch?',
};

export const crime = {
  reports: {
    $array: {
      id: 'str', t: 'epoch', offenseT: 'epoch?', offenses: { $array: 'str' }, category: 'str?', block: 'str?', lat: 'num?', lon: 'num?', beat: 'str?',
    },
    max: 80,
  },
  byCategory: { PROPERTY: 'int', PERSON: 'int', SOCIETY: 'int' },
  newest: 'epoch?', lagHours: 'num?',
};

const quake = {
  id: 'str', mag: 'num?', place: 'str?', t: 'epoch', depthKm: 'num?', lat: 'num', lon: 'num', url: 'str?', felt: 'int?', distKm: 'num',
};
export const quakes = { recent: { $array: quake, max: 30 }, notable: { $array: quake, max: 10 } };

export const outageRow = {
  id: 'any', start: 'epoch?', updated: 'epoch?', etr: 'epoch?', customers: 'num', status: 'str?', cause: 'str?', lat: 'num', lon: 'num',
  ring: { $nullable: { $array: 'any', min: 1 } },
};
export const outages = { ballard: { $array: outageRow }, citywide: { count: 'int', customers: 'num' }, updated: 'epoch?' };

export const newsItem = { source: 'str', title: 'str', link: 'str', t: 'epoch', summary: 'str?', ballard: 'bool' };
// feeds[] rows carry `error` only when ok is false; checked separately in the tests.
export const news = { items: { $array: newsItem, max: 60 }, feeds: { $array: 'any', min: 1 } };

export const redditItem = { sub: ['enum', 'r/Ballard', 'r/Seattle'], title: 'str', link: 'str', t: 'epoch', author: 'str?' };
export const reddit = { items: { $array: redditItem, max: 30 } };

export const eventRow = {
  id: 'str', title: 'str', start: 'epoch', end: 'epoch?', allDay: 'bool', venue: 'str?', address: 'str?', cost: 'str?', url: 'str',
  source: ['enum', 'Visit Ballard', 'SPL Ballard'], canceled: 'bool', category: 'str?',
};
export const events = { events: { $array: eventRow, max: 150 } };

export const closures = {
  closures: {
    $array: {
      permit: 'str', type: 'str?', name: 'str?', street: 'str?', from: 'str?', to: 'str?', todayHours: 'str?', days: { $map: 'str' },
      start: 'epoch', end: 'epoch',
      segments: { $array: { street: 'str?', from: 'str?', to: 'str?', line: { $nullable: { $array: 'any', min: 1 } } } },
    },
  },
};

export const requests311 = {
  requests: { $array: { id: 'str?', type: 'str?', status: 'str?', t: 'epoch?', address: 'str?', lat: 'num?', lon: 'num?', area: 'str?' }, max: 40 },
  newest: 'epoch?',
};

export const permits = {
  permits: {
    $array: {
      id: 'str', type: 'str?', description: 'str?', address: 'str?', issued: 'epoch', status: 'str?', cost: 'int?', units: 'num?',
      lat: 'num?', lon: 'num?', url: 'str?',
    },
    max: 25,
  },
};

/** Source id -> schema, for the end-to-end wiring test. */
export const BY_ID = {
  weather, 'nws-forecast': nwsForecast, alerts, stations, westpoint, marine, afd, sky, kp, radar, airnow, purpleair,
  tides, currents, lake, lockages, stoppages, bridges, 'bridge-history': bridgeHistory, salmon, cso,
  transit, vehicles, 'metro-alerts': metroAlerts, cameras, traffic, incidents, lime,
  fire911, crime, quakes, outages, news, reddit, events, closures, requests311, permits,
};
