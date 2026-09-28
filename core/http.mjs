// HTTP response helpers: gzip negotiation, ETag / If-None-Match, MIME types.
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(zlib.gzip);
export const GZIP_MIN_BYTES = 1024;

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.glb': 'model/gltf-binary',
};

/** Text-like types worth gzipping. Never event streams or raster images. */
export function isCompressible(type = '') {
  const t = String(type).toLowerCase();
  if (t.startsWith('text/event-stream')) return false;
  return t.startsWith('text/') || /^application\/(json|geo\+json|javascript|manifest\+json|xml)|^image\/svg\+xml|^model\/gltf-binary/.test(t);
}

/** True if the request's Accept-Encoding allows gzip (q > 0). */
export function acceptsGzip(req) {
  const h = req.headers['accept-encoding'];
  if (!h) return false;
  const q = {};
  for (const part of String(h).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    q[name.trim()] = qp ? parseFloat(qp.slice(2)) || 0 : 1;
  }
  if ('gzip' in q) return q.gzip > 0;
  return '*' in q && q['*'] > 0;
}

/** Does If-None-Match match this ETag? Weak comparison, lists and '*' supported. */
export function etagMatches(req, etag) {
  const inm = req.headers['if-none-match'];
  if (!inm || !etag) return false;
  if (inm.trim() === '*') return true;
  const bare = (s) => s.trim().replace(/^W\//, '');
  const want = bare(etag);
  return inm.split(',').some((t) => bare(t) === want);
}

/** Short stable hash (FNV-1a 32-bit, base36) for ETag parts. */
export function hash(s) {
  let h = 0x811c9dc5;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * Send a body, gzipped when the type is compressible, the body is big enough and the client accepts gzip.
 * opts.gz: a precomputed gzip buffer for this body (static file cache).
 */
export async function sendBody(req, res, status, body, headers = {}, { gz } = {}) {
  const type = headers['Content-Type'] || '';
  const h = { 'Cache-Control': 'no-store', ...headers };
  const compressible = isCompressible(type);
  if (compressible) h.Vary = 'Accept-Encoding';
  let out = typeof body === 'string' ? Buffer.from(body) : body;
  if (compressible && out && out.length >= GZIP_MIN_BYTES && acceptsGzip(req)) {
    try {
      out = gz || await gzipAsync(out, { level: 6 });
      h['Content-Encoding'] = 'gzip';
    } catch { /* send uncompressed */ }
  }
  if (res.destroyed) return;
  h['Content-Length'] = out ? out.length : 0;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : out);
}

export const gzipBuffer = (buf) => gzipAsync(buf, { level: 9 });

export const sendJson = (req, res, status, obj, headers = {}) =>
  sendBody(req, res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

export const sendText = (req, res, status, text, headers = {}) =>
  sendBody(req, res, status, String(text), { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
