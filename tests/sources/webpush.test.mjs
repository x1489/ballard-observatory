// Web Push (RFC 8291 encryption, RFC 8292 VAPID): checked against the RFC 8291 worked example and by decrypting
// with an independent implementation on Node's crypto module.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayload, vapidAuth, generateVapidKeys, sendPush, b64u, useCrypto } from '../../sources/webpush.mjs';

useCrypto(crypto.webcrypto);

const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const jwkFrom = (pub, d) => { const p = b64u.dec(pub); return { kty: 'EC', crv: 'P-256', x: b64u.enc(p.slice(1, 33)), y: b64u.enc(p.slice(33, 65)), d }; };

/** Independent RFC 8291 decryption with node:crypto (the user agent's side). */
function decrypt(body, uaPrivateJwk, uaPublicRaw, authSecret) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(b64u.dec(uaPrivateJwk.d)));
  const shared = ecdh.computeSecret(Buffer.from(asPublic));
  const hk = (s, ikm, info, len) => { const prk = crypto.createHmac('sha256', s).update(ikm).digest(); return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len); };
  const ikm = hk(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPublicRaw), Buffer.from(asPublic)]), 32);
  const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'last-record padding delimiter');
  return pt.subarray(0, pt.length - 1).toString();
}

test('RFC 8291 worked example: byte-for-byte', async () => {
  const privateKey = await crypto.webcrypto.subtle.importKey('jwk', jwkFrom(RFC.asPublic, RFC.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const body = await encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: b64u.dec(RFC.salt), serverKeys: { publicKey: b64u.dec(RFC.asPublic), privateKey } });
  assert.equal(b64u.enc(body), RFC.body);
});

test('random keys: an independent decryption recovers the payload', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const uaPublic = new Uint8Array(ua.getPublicKey());
  const auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: 'Ballard Bridge is up', body: 'Raised for a vessel', url: '/#/bridge/Ballard' });
  const body = await encryptPayload(msg, { p256dh: b64u.enc(uaPublic), auth: b64u.enc(auth) });
  assert.equal(decrypt(Buffer.from(body), { d: b64u.enc(ua.getPrivateKey()) }, uaPublic, auth), msg);
});

test('VAPID: a verifiable ES256 JWT for the push service origin', async () => {
  const v = await generateVapidKeys();
  const h = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', { ...v, subject: 'https://example.org' }, Date.parse('2026-09-28T12:00:00Z'));
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(k, v.publicKey);
  const [hdr, claims, sig] = t.split('.');
  const c = JSON.parse(Buffer.from(b64u.dec(claims)).toString());
  assert.equal(c.aud, 'https://fcm.googleapis.com');
  assert.equal(c.sub, 'https://example.org');
  const pub = await crypto.webcrypto.subtle.importKey('raw', b64u.dec(v.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64u.dec(sig), new TextEncoder().encode(`${hdr}.${claims}`)));
});

test('sendPush: headers, and gone subscriptions are reported', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz', keys: { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(crypto.randomBytes(16)) } };
  const v = { ...(await generateVapidKeys()), subject: 'https://example.org' };
  let seen;
  const r = await sendPush(sub, { title: 't' }, v, { fetchImpl: async (url, init) => { seen = init; return { ok: false, status: 410 }; } });
  assert.equal(seen.headers['Content-Encoding'], 'aes128gcm');
  assert.match(seen.headers.Authorization, /^vapid t=/);
  assert.equal(r.gone, true);
});
