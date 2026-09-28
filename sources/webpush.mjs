// Web Push without dependencies (runs in Cloudflare Workers and Node 18+ via WebCrypto): RFC 8291 message encryption
// (aes128gcm, ECDH P-256 + HKDF) and RFC 8292 VAPID authentication (ES256 JWT). Used to alert followers when a
// drawbridge goes up, a fire call comes in nearby, or an aircraft declares an emergency, even with the app closed.
const te = new TextEncoder();
let provided = null;
/** WebCrypto is global in Workers and Node 19+; Node 18 callers pass require('node:crypto').webcrypto. */
export function useCrypto(c) { provided = c; }
const wc = () => globalThis.crypto || provided;
const subtle = () => wc().subtle;

export const b64u = {
  enc(buf) { const b = new Uint8Array(buf); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hmac(key, data) {
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, data));
}
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, len);
}

/**
 * Encrypt a payload for a push subscription (RFC 8291). For tests, `salt` and `serverKeys` ({ publicKey (raw 65),
 * privateKey (CryptoKey) }) can be fixed; otherwise they are random per message.
 */
export async function encryptPayload(payload, { p256dh, auth }, { salt = null, serverKeys = null, rs = 4096 } = {}) {
  const uaPublic = typeof p256dh === 'string' ? b64u.dec(p256dh) : p256dh;
  const authSecret = typeof auth === 'string' ? b64u.dec(auth) : auth;
  let as = serverKeys;
  if (!as) {
    const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    as = { publicKey: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)), privateKey: kp.privateKey };
  }
  const uaKey = await subtle().importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(te.encode('WebPush: info\0'), uaPublic, as.publicKey), 32);
  salt = salt || wc().getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const data = typeof payload === 'string' ? te.encode(payload) : payload;
  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));
  const header = new Uint8Array(21 + as.publicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = as.publicKey.length;
  header.set(as.publicKey, 21);
  return concat(header, ct);
}

/** VAPID Authorization header value for an endpoint. vapid: { publicKey (b64u raw), privateJwk (JWK object), subject }. */
export async function vapidAuth(endpoint, vapid, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => b64u.enc(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })}`;
  const key = await subtle().importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
}

/** Send one notification. Returns { ok, status, gone } (gone: the subscription no longer exists; delete it). */
export async function sendPush(subscription, payload, vapid, { ttl = 3600, urgency = 'normal', topic = null, fetchImpl = globalThis.fetch } = {}) {
  const body = await encryptPayload(JSON.stringify(payload), subscription.keys);
  const headers = { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency, Authorization: await vapidAuth(subscription.endpoint, vapid) };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const r = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body });
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}

/** A new VAPID key pair: { publicKey (b64u raw, for the browser), privateJwk (keep secret) }. */
export async function generateVapidKeys() {
  const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { publicKey: b64u.enc(await subtle().exportKey('raw', kp.publicKey)), privateJwk: await subtle().exportKey('jwk', kp.privateKey) };
}
