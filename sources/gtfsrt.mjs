// A small, dependency-free GTFS-realtime (protobuf) decoder: FeedMessage -> vehicle positions and trip updates.
// Only the fields the live scene uses are named; unknown fields (and agency extensions) are skipped. Runs in Node
// and in Cloudflare Workers. Spec: https://gtfs.org/realtime/reference/

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf; this.pos = pos; this.end = end;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  /** Varint as [lo, hi] unsigned 32-bit halves. */
  varint() {
    const b = this.buf;
    let lo = 0, hi = 0, x, i;
    for (i = 0; i < 4; i++) { x = b[this.pos++]; lo = (lo | ((x & 127) << (i * 7))) >>> 0; if (x < 128) return [lo, 0]; }
    x = b[this.pos++]; lo = (lo | ((x & 127) << 28)) >>> 0; hi = (x & 127) >> 4; if (x < 128) return [lo, hi];
    for (i = 0; i < 5; i++) { x = b[this.pos++]; hi = (hi | ((x & 127) << (i * 7 + 3))) >>> 0; if (x < 128) return [lo, hi]; }
    throw new Error('gtfs-rt: malformed varint');
  }
  uint() { const [lo, hi] = this.varint(); return hi * 4294967296 + lo; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const n = this.uint(); this.pos += n; }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`gtfs-rt: unsupported wire type ${wire}`);
  }
}
const td = new TextDecoder();

// schema: field number -> [name, type, repeated, subschema]
const S = {};
S.header = { 1: ['version', 'string'], 3: ['timestamp', 'uint'] };
S.trip = { 1: ['tripId', 'string'], 2: ['startTime', 'string'], 3: ['startDate', 'string'], 4: ['relationship', 'enum'], 5: ['routeId', 'string'], 6: ['directionId', 'uint'] };
S.vehicleDesc = { 1: ['id', 'string'], 2: ['label', 'string'] };
S.position = { 1: ['lat', 'float'], 2: ['lon', 'float'], 3: ['bearing', 'float'], 5: ['speed', 'float'] };
S.event = { 1: ['delay', 'int32'], 2: ['time', 'uint'], 3: ['uncertainty', 'int32'] };
S.stu = { 1: ['seq', 'uint'], 2: ['arrival', 'msg', false, S.event], 3: ['departure', 'msg', false, S.event], 4: ['stopId', 'string'], 5: ['relationship', 'enum'] };
S.tripUpdate = { 1: ['trip', 'msg', false, S.trip], 2: ['stops', 'msg', true, S.stu], 3: ['vehicle', 'msg', false, S.vehicleDesc], 4: ['timestamp', 'uint'], 5: ['delay', 'int32'] };
S.vehiclePos = { 1: ['trip', 'msg', false, S.trip], 2: ['position', 'msg', false, S.position], 3: ['stopSeq', 'uint'], 4: ['status', 'enum'], 5: ['timestamp', 'uint'],
  6: ['congestion', 'enum'], 7: ['stopId', 'string'], 8: ['vehicle', 'msg', false, S.vehicleDesc], 9: ['occupancy', 'enum'], 10: ['occupancyPct', 'uint'] };
S.entity = { 1: ['id', 'string'], 2: ['deleted', 'bool'], 3: ['tripUpdate', 'msg', false, S.tripUpdate], 4: ['vehicle', 'msg', false, S.vehiclePos] };
S.feed = { 1: ['header', 'msg', false, S.header], 2: ['entity', 'msg', true, S.entity] };

function decode(r, schema, end) {
  const o = {};
  while (r.pos < end) {
    const key = r.uint();
    const field = Math.floor(key / 8), wire = key & 7;
    const f = schema[field];
    if (!f) { r.skip(wire); continue; }
    const [name, type, repeated, sub] = f;
    let v;
    switch (type) {
      case 'string': { const n = r.uint(); v = td.decode(r.buf.subarray(r.pos, r.pos + n)); r.pos += n; break; }
      case 'uint': case 'enum': v = r.uint(); break;
      case 'int32': v = r.varint()[0] | 0; break;
      case 'bool': v = r.varint()[0] !== 0; break;
      case 'float': v = r.view.getFloat32(r.pos, true); r.pos += 4; break;
      case 'msg': { const n = r.uint(); const stop = r.pos + n; v = decode(r, sub, stop); r.pos = stop; break; }
      default: r.skip(wire);
    }
    if (type === 'float' && wire !== 5) throw new Error(`gtfs-rt: field ${name} wire ${wire}`);
    if (repeated) (o[name] || (o[name] = [])).push(v); else o[name] = v;
  }
  return o;
}

/** Decode a GTFS-realtime FeedMessage (Uint8Array) into { header, entity: [...] }. */
export function decodeFeed(bytes) {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const feed = decode(r, S.feed, r.end);
  feed.entity = feed.entity || [];
  return feed;
}

export const VEHICLE_STATUS = ['incoming', 'stopped', 'in transit'];
export const OCCUPANCY = ['empty', 'many seats', 'few seats', 'standing room', 'crushed standing room', 'full', 'not accepting passengers', 'no data', 'not boardable'];

// ------------------------------------------------------------------ encoder (tests only)
/** Encode a plain object with a schema name back to protobuf bytes (used by tests to build fixtures). */
export function encode(obj, schemaName = 'feed') {
  const out = [];
  const pushVarint = (n) => {
    let v = BigInt.asUintN(64, BigInt(n));
    do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; out.push(b); } while (v);
  };
  const emit = (o, schema) => {
    for (const [no, [name, type, repeated, sub]] of Object.entries(schema)) {
      if (o[name] === undefined || o[name] === null) continue;
      const vals = repeated ? o[name] : [o[name]];
      for (const v of vals) {
        const field = Number(no);
        if (type === 'string') { const b = new TextEncoder().encode(v); pushVarint(field * 8 + 2); pushVarint(b.length); out.push(...b); }
        else if (type === 'uint' || type === 'enum' || type === 'int32' || type === 'bool') { pushVarint(field * 8); pushVarint(type === 'bool' ? (v ? 1 : 0) : v); }
        else if (type === 'float') { pushVarint(field * 8 + 5); const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v, true); out.push(...new Uint8Array(dv.buffer)); }
        else if (type === 'msg') { const saved = out.splice(0); emit(v, sub); const body = out.splice(0); out.push(...saved); pushVarint(field * 8 + 2); pushVarint(body.length); out.push(...body); }
      }
    }
  };
  emit(obj, S[schemaName]);
  return new Uint8Array(out);
}
