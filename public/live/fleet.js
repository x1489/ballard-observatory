// What each tracked thing looks like: aircraft type -> 3D model scaled to the real type's length and wingspan;
// King County Metro vehicle number -> bus model (40 ft / 60 ft articulated / trolleybus) and livery; Amtrak train ->
// consist. Sources: manufacturer dimensions; King County Metro fleet list (Wikipedia, Sep 2026).

// Aircraft models (public/models, CC BY 4.0 via God's Eye View; see public/models/README.md): real-world metres,
// +Y up, nose toward -X. [length, height, span] of each model as built.
export const AIR_MODELS = {
  b789: { url: '/models/b789.glb', dims: [62.8, 15.6, 59.9] },
  airplane: { url: '/models/airplane.glb', dims: [51.5, 13.4, 43.6] },
  atr72: { url: '/models/atr72.glb', dims: [27.2, 7.6, 26.9] },
  c172: { url: '/models/c172.glb', dims: [8.24, 2.72, 11.0] },
  citation2: { url: '/models/citation2.glb', dims: [15.8, 5.7, 14.9] },
  bell206: { url: '/models/bell206.glb', dims: [11.9, 3.3, 10.9] },
  jet: { url: '/models/jet.glb', dims: [42.1, 11.3, 40.8] },
};

// ICAO type designator -> [model, length m, span m, description]
const T = (model, len, span, desc) => [model, len, span, desc];
export const TYPES = {
  // narrowbody jets
  B736: T('b789', 31.2, 34.3, 'Boeing 737-600'), B737: T('b789', 33.6, 35.8, 'Boeing 737-700'), B738: T('b789', 39.5, 35.8, 'Boeing 737-800'),
  B739: T('b789', 42.1, 35.8, 'Boeing 737-900'), B37M: T('b789', 35.6, 35.9, 'Boeing 737 MAX 7'), B38M: T('b789', 39.5, 35.9, 'Boeing 737 MAX 8'),
  B39M: T('b789', 42.2, 35.9, 'Boeing 737 MAX 9'), B3XM: T('b789', 43.8, 35.9, 'Boeing 737 MAX 10'), B752: T('b789', 47.3, 38.1, 'Boeing 757-200'),
  B753: T('b789', 54.4, 38.1, 'Boeing 757-300'), A318: T('b789', 31.4, 34.1, 'Airbus A318'), A319: T('b789', 33.8, 35.8, 'Airbus A319'),
  A320: T('b789', 37.6, 35.8, 'Airbus A320'), A321: T('b789', 44.5, 35.8, 'Airbus A321'), A19N: T('b789', 33.8, 35.8, 'Airbus A319neo'),
  A20N: T('b789', 37.6, 35.8, 'Airbus A320neo'), A21N: T('b789', 44.5, 35.8, 'Airbus A321neo'), BCS1: T('b789', 35.0, 35.1, 'Airbus A220-100'),
  BCS3: T('b789', 38.7, 35.1, 'Airbus A220-300'), E170: T('b789', 29.9, 26.0, 'Embraer 170'), E75L: T('b789', 31.7, 26.0, 'Embraer 175'),
  E75S: T('b789', 31.7, 26.0, 'Embraer 175'), E190: T('b789', 36.2, 28.7, 'Embraer 190'), E195: T('b789', 38.7, 28.7, 'Embraer 195'),
  E290: T('b789', 36.2, 33.7, 'Embraer E190-E2'), E295: T('b789', 41.5, 35.1, 'Embraer E195-E2'), CRJ2: T('citation2', 26.8, 21.2, 'Bombardier CRJ200'),
  CRJ7: T('citation2', 32.5, 23.2, 'Bombardier CRJ700'), CRJ9: T('citation2', 36.2, 24.9, 'Bombardier CRJ900'), MD88: T('citation2', 45.1, 32.9, 'McDonnell Douglas MD-88'),
  // widebody jets
  B762: T('b789', 48.5, 47.6, 'Boeing 767-200'), B763: T('b789', 54.9, 47.6, 'Boeing 767-300'), B764: T('b789', 61.4, 51.9, 'Boeing 767-400'),
  B772: T('b789', 63.7, 60.9, 'Boeing 777-200'), B77L: T('b789', 63.7, 64.8, 'Boeing 777-200LR/F'), B773: T('b789', 73.9, 60.9, 'Boeing 777-300'),
  B77W: T('b789', 73.9, 64.8, 'Boeing 777-300ER'), B778: T('b789', 69.8, 71.8, 'Boeing 777-8'), B779: T('b789', 76.7, 71.8, 'Boeing 777-9'),
  B788: T('b789', 56.7, 60.1, 'Boeing 787-8'), B789: T('b789', 62.8, 60.1, 'Boeing 787-9'), B78X: T('b789', 68.3, 60.1, 'Boeing 787-10'),
  A332: T('b789', 58.8, 60.3, 'Airbus A330-200'), A333: T('b789', 63.7, 60.3, 'Airbus A330-300'), A338: T('b789', 58.8, 64.0, 'Airbus A330-800'),
  A339: T('b789', 63.7, 64.0, 'Airbus A330-900'), A359: T('b789', 66.8, 64.8, 'Airbus A350-900'), A35K: T('b789', 73.8, 64.8, 'Airbus A350-1000'),
  MD11: T('b789', 61.6, 51.7, 'McDonnell Douglas MD-11'), KC46: T('b789', 50.5, 48.1, 'Boeing KC-46 Pegasus'), P8: T('b789', 39.5, 37.6, 'Boeing P-8 Poseidon'),
  // four-engine
  B744: T('airplane', 70.7, 64.4, 'Boeing 747-400'), B748: T('airplane', 76.3, 68.4, 'Boeing 747-8'), A388: T('airplane', 72.7, 79.8, 'Airbus A380'),
  A343: T('airplane', 63.6, 60.3, 'Airbus A340-300'), A346: T('airplane', 75.3, 63.5, 'Airbus A340-600'), C17: T('airplane', 53.0, 51.8, 'Boeing C-17 Globemaster III'),
  K35R: T('airplane', 41.5, 39.9, 'Boeing KC-135 Stratotanker'), E3TF: T('airplane', 46.6, 44.4, 'Boeing E-3 Sentry'),
  // turboprops
  DH8A: T('atr72', 22.3, 25.9, 'De Havilland Dash 8-100'), DH8B: T('atr72', 22.3, 25.9, 'De Havilland Dash 8-200'), DH8C: T('atr72', 25.7, 27.4, 'De Havilland Dash 8-300'),
  DH8D: T('atr72', 32.8, 28.4, 'De Havilland Dash 8-400'), AT43: T('atr72', 22.7, 24.6, 'ATR 42-300'), AT45: T('atr72', 22.7, 24.6, 'ATR 42-500'),
  AT72: T('atr72', 27.2, 27.1, 'ATR 72'), AT75: T('atr72', 27.2, 27.1, 'ATR 72-500'), AT76: T('atr72', 27.2, 27.1, 'ATR 72-600'),
  SF34: T('atr72', 19.7, 21.4, 'Saab 340'), B190: T('atr72', 17.6, 17.7, 'Beechcraft 1900'), DHC6: T('atr72', 15.8, 19.8, 'DHC-6 Twin Otter'),
  C130: T('atr72', 29.8, 40.4, 'Lockheed C-130 Hercules'), C30J: T('atr72', 29.8, 40.4, 'Lockheed C-130J Super Hercules'), BE20: T('atr72', 13.3, 16.6, 'Beechcraft King Air 200'),
  BE9L: T('atr72', 10.8, 15.3, 'Beechcraft King Air 90'), B350: T('atr72', 14.2, 17.7, 'Beechcraft King Air 350'), SW4: T('atr72', 18.1, 17.4, 'Fairchild Metroliner'),
  PC12: T('c172', 14.4, 16.3, 'Pilatus PC-12'), C208: T('c172', 11.5, 15.9, 'Cessna 208 Caravan'), TBM9: T('c172', 10.7, 12.8, 'Daher TBM 900'),
  TBM7: T('c172', 10.6, 12.7, 'Daher TBM 700'), PC6T: T('c172', 11.0, 15.9, 'Pilatus PC-6 Porter'), M600: T('c172', 9.1, 13.1, 'Piper M600'),
  // floatplanes (Kenmore Air's Lake Union fleet: Beavers and Otters)
  DHC2: T('c172', 9.2, 14.6, 'de Havilland Canada DHC-2 Beaver'), DH2T: T('c172', 10.8, 14.6, 'de Havilland Canada DHC-2T Turbo Beaver'),
  DHC3: T('c172', 12.8, 17.7, 'de Havilland Canada DHC-3 Otter'), DH3T: T('c172', 12.8, 17.7, 'de Havilland Canada DHC-3T Turbine Otter'),
  // piston general aviation
  C150: T('c172', 7.3, 10.2, 'Cessna 150'), C152: T('c172', 7.3, 10.1, 'Cessna 152'), C172: T('c172', 8.3, 11.0, 'Cessna 172 Skyhawk'),
  C182: T('c172', 8.8, 11.0, 'Cessna 182 Skylane'), C206: T('c172', 8.6, 11.0, 'Cessna 206 Stationair'), C210: T('c172', 8.6, 11.2, 'Cessna 210 Centurion'),
  P28A: T('c172', 7.3, 10.7, 'Piper PA-28 Cherokee'), P28R: T('c172', 7.6, 10.8, 'Piper Arrow'), PA32: T('c172', 8.4, 10.7, 'Piper PA-32'),
  PA46: T('c172', 8.8, 13.1, 'Piper Malibu'), SR20: T('c172', 7.9, 11.7, 'Cirrus SR20'), SR22: T('c172', 7.9, 11.7, 'Cirrus SR22'),
  S22T: T('c172', 7.9, 11.7, 'Cirrus SR22T'), DA40: T('c172', 8.0, 11.9, 'Diamond DA40'), DA42: T('c172', 8.6, 13.4, 'Diamond DA42'),
  BE36: T('c172', 8.4, 10.2, 'Beechcraft Bonanza'), BE35: T('c172', 7.7, 10.2, 'Beechcraft Bonanza'), BE58: T('c172', 9.1, 11.5, 'Beechcraft Baron'),
  M20P: T('c172', 7.5, 11.0, 'Mooney M20'), M20T: T('c172', 7.6, 11.0, 'Mooney M20'), PA34: T('c172', 8.7, 11.9, 'Piper Seneca'),
  C340: T('c172', 10.5, 11.6, 'Cessna 340'), RV7: T('c172', 6.2, 7.6, "Van's RV-7"), RV10: T('c172', 7.4, 9.6, "Van's RV-10"), GLID: T('c172', 7.0, 15.0, 'Glider'),
  // business jets
  C510: T('citation2', 12.4, 13.2, 'Cessna Citation Mustang'), C525: T('citation2', 13.0, 14.3, 'Cessna CitationJet'), C25A: T('citation2', 14.5, 15.1, 'Cessna Citation CJ2'),
  C25B: T('citation2', 15.6, 15.9, 'Cessna Citation CJ3'), C25C: T('citation2', 16.3, 15.5, 'Cessna Citation CJ4'), C560: T('citation2', 14.9, 15.9, 'Cessna Citation V'),
  C56X: T('citation2', 15.8, 17.2, 'Cessna Citation Excel'), C680: T('citation2', 19.4, 19.4, 'Cessna Citation Sovereign'), C68A: T('citation2', 19.4, 22.0, 'Cessna Citation Latitude'),
  C700: T('citation2', 21.1, 21.0, 'Cessna Citation Longitude'), C750: T('citation2', 22.0, 19.4, 'Cessna Citation X'), E50P: T('citation2', 12.8, 12.3, 'Embraer Phenom 100'),
  E55P: T('citation2', 15.6, 16.2, 'Embraer Phenom 300'), LJ35: T('citation2', 14.8, 12.0, 'Learjet 35'), LJ45: T('citation2', 17.7, 14.6, 'Learjet 45'),
  LJ60: T('citation2', 17.9, 13.3, 'Learjet 60'), LJ75: T('citation2', 17.7, 15.5, 'Learjet 75'), CL30: T('citation2', 20.9, 19.5, 'Bombardier Challenger 300'),
  CL35: T('citation2', 20.9, 21.0, 'Bombardier Challenger 350'), CL60: T('citation2', 21.0, 19.6, 'Bombardier Challenger 600'), GLF4: T('citation2', 26.9, 23.7, 'Gulfstream IV'),
  GLF5: T('citation2', 29.4, 28.5, 'Gulfstream V'), GLF6: T('citation2', 30.4, 30.4, 'Gulfstream G650'), GL5T: T('citation2', 29.5, 28.7, 'Bombardier Global 5000'),
  GLEX: T('citation2', 30.3, 28.7, 'Bombardier Global Express'), GL7T: T('citation2', 33.8, 31.7, 'Bombardier Global 7500'), FA7X: T('citation2', 23.2, 26.2, 'Dassault Falcon 7X'),
  FA8X: T('citation2', 24.5, 26.3, 'Dassault Falcon 8X'), F2TH: T('citation2', 20.2, 19.3, 'Dassault Falcon 2000'), F900: T('citation2', 20.2, 19.3, 'Dassault Falcon 900'),
  HDJT: T('citation2', 13.0, 12.1, 'Honda HA-420 HondaJet'), PC24: T('citation2', 16.9, 17.0, 'Pilatus PC-24'), BE40: T('citation2', 14.8, 13.3, 'Beechjet 400'),
  G280: T('citation2', 20.3, 19.2, 'Gulfstream G280'), GA6C: T('citation2', 30.4, 30.4, 'Gulfstream G600'), GA5C: T('citation2', 29.4, 28.5, 'Gulfstream G500'),
  // helicopters
  EC35: T('bell206', 12.2, 10.2, 'Airbus H135'), EC45: T('bell206', 13.6, 11.0, 'Airbus H145'), AS50: T('bell206', 10.9, 10.7, 'Airbus AS350 Écureuil'),
  EC30: T('bell206', 12.6, 10.7, 'Airbus H130'), B06: T('bell206', 12.1, 10.2, 'Bell 206 JetRanger'), B407: T('bell206', 12.7, 10.7, 'Bell 407'),
  B429: T('bell206', 12.7, 11.0, 'Bell 429'), B412: T('bell206', 17.1, 14.0, 'Bell 412'), B505: T('bell206', 11.0, 11.3, 'Bell 505'),
  S76: T('bell206', 16.0, 13.4, 'Sikorsky S-76'), A109: T('bell206', 13.0, 11.0, 'Leonardo AW109'), A139: T('bell206', 16.7, 13.8, 'Leonardo AW139'),
  R44: T('bell206', 11.7, 10.1, 'Robinson R44'), R22: T('bell206', 8.8, 7.7, 'Robinson R22'), R66: T('bell206', 11.8, 10.1, 'Robinson R66'),
  H60: T('bell206', 19.8, 16.4, 'Sikorsky UH-60 Black Hawk'), MD52: T('bell206', 9.8, 8.4, 'MD 520N'), MD60: T('bell206', 11.0, 8.4, 'MD 600N'),
  // military fast jets
  FA18: T('jet', 17.1, 12.3, 'Boeing F/A-18'), EA18: T('jet', 18.3, 13.6, 'Boeing EA-18G Growler'), F35: T('jet', 15.7, 10.7, 'Lockheed F-35'),
  T38: T('jet', 14.1, 7.7, 'Northrop T-38 Talon'), F16: T('jet', 15.0, 9.4, 'General Dynamics F-16'),
};

const CATEGORY_DEFAULT = { A1: T('c172', 8.3, 11.0, 'Light aircraft'), A2: T('citation2', 16, 16, 'Small aircraft'), A3: T('b789', 38, 35, 'Airliner'),
  A4: T('b789', 47, 38, 'Large airliner'), A5: T('b789', 64, 62, 'Heavy jet'), A6: T('jet', 16, 11, 'High-performance aircraft'), A7: T('bell206', 12, 10.5, 'Helicopter'),
  B1: T('c172', 8, 15, 'Glider'), B4: T('c172', 6, 9, 'Ultralight'), B6: T('c172', 3, 3, 'Drone') };

/** Model spec for an aircraft record: { model, url, scale: [x,y,z], len, span, desc, floats, heli } */
export function aircraftSpec(a) {
  const type = String(a.type || '').toUpperCase();
  let t = TYPES[type];
  if (!t) {
    if (a.kind === 'helicopter') t = CATEGORY_DEFAULT.A7;
    else if (a.kind === 'seaplane') t = TYPES.DHC2;
    else t = CATEGORY_DEFAULT[String(a.category || '').toUpperCase()] || (a.kind === 'airliner' ? CATEGORY_DEFAULT.A3 : CATEGORY_DEFAULT.A1);
  }
  const [model, len, span, desc] = t;
  const M = AIR_MODELS[model];
  const sx = len / M.dims[0], sz = span / M.dims[2], sy = (sx + sz) / 2;
  return { model, url: M.url, scale: [sx, sy, sz], len, span, height: M.dims[1] * sy, desc: a.desc || desc,
    floats: /^(DHC2|DH2T|DHC3|DH3T)$/.test(type) || a.kind === 'seaplane', heli: model === 'bell206' };
}

// ------------------------------------------------------------------ King County Metro buses
// Fleet number ranges (King County Metro fleet, Wikipedia): length and propulsion.
const KCM_FLEET = [
  [1000, 1067, 40, 'battery', 'Gillig EV Plus'], [3700, 3759, 35, 'hybrid', 'New Flyer XDE35'], [4300, 4409, 40, 'trolley', 'New Flyer XT40 trolleybus'],
  [4500, 4563, 60, 'trolley', 'New Flyer XT60 trolleybus'], [4700, 4719, 40, 'battery', 'New Flyer XE40'], [4800, 4819, 60, 'battery', 'New Flyer XE60'],
  [6000, 6117, 60, 'hybrid', 'New Flyer DE60LF'], [6200, 6269, 60, 'hybrid', 'New Flyer XDE60'], [6400, 6412, 60, 'hybrid', 'New Flyer XDE60'],
  [6800, 6999, 60, 'hybrid', 'New Flyer DE60LF'], [7001, 7199, 40, 'hybrid', 'Orion VII'], [7200, 7259, 40, 'hybrid', 'New Flyer XDE40'],
  [7300, 7494, 40, 'hybrid', 'Gillig Low Floor'], [8000, 8299, 60, 'hybrid', 'New Flyer XDE60'],
];
const TOPS = ['teal', 'blue', 'green'];

/** { length, artic, trolley, front, rear, model, desc, color } for a Metro vehicle on a route. */
export function busSpec(vehicleId, routeName) {
  const n = parseInt(String(vehicleId || '').replace(/\D/g, '').slice(-4), 10);
  const f = Number.isFinite(n) ? KCM_FLEET.find(([a, b]) => n >= a && n <= b) : null;
  const rapid = /^[A-H] Line$/i.test(routeName || '') || /RapidRide/i.test(routeName || '');
  const trolley = f ? f[3] === 'trolley' : /^(1|2|3|4|7|10|12|13|14|36|43|44|49|70)$/.test(routeName || '');
  const artic = f ? f[2] === 60 : rapid;
  const top = rapid ? 'rapid' : TOPS[(Number.isFinite(n) ? n : 0) % 3];
  let front, rear = null;
  if (trolley) { front = artic ? 'trolley60f' : 'trolley40'; rear = artic ? 'trolley60r' : null; }
  else { front = artic ? `bus60f-${top}` : `bus40-${top}`; rear = artic ? `bus60r-${top}` : null; }
  return { length: artic ? 18.3 : f && f[2] === 35 ? 10.7 : 12.2, artic, trolley, front, rear, desc: f ? f[4] : artic ? 'Articulated bus' : 'Bus',
    propulsion: f ? f[3] : trolley ? 'trolley' : 'hybrid', color: rapid ? '#cf2a27' : trolley ? '#5f3a8c' : { teal: '#157f86', blue: '#1d4f9a', green: '#3c8a3f' }[top] };
}
/** Distance (m) from the front section's centre back to the rear section's centre on a 60 ft bus. */
export const ARTIC_GAP = 5.5 + 0.46 + 3.65;

// ------------------------------------------------------------------ Amtrak
export function trainConsist(routeName) {
  if (/Cascades/i.test(routeName)) return { loco: 'loco-cascades', car: 'coach-cascades', cars: 6, locoLen: 21.6, carLen: 25.9, color: '#2f5b41' };
  return { loco: 'loco-amtrak', car: 'superliner', cars: 6, locos: 2, locoLen: 21.6, carLen: 25.9, color: '#1d3557' };
}
