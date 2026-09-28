// Server-Sent Events hub for GET /api/stream: client registry, broadcast, keep-alive pings.
// Frames: `event: <name>\ndata: <json>\n\n`. Never compressed. Events: hello, source, activity, metric, ping.

export function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createHub({
  pingMs = 25000,
  retryMs = 3000,
  maxClients = 200,
  maxBufferBytes = 8 * 1024 * 1024, // a client this far behind is dropped (it reconnects and gets a fresh snapshot)
  now = Date.now,
  onChange = () => {},
  log = console,
} = {}) {
  const clients = new Set();
  let pingTimer = null;

  function drop(c) {
    if (!clients.delete(c)) return;
    try { onChange(clients.size); } catch { /* ignore */ }
    if (!clients.size && pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function write(c, chunk) {
    const { res } = c;
    if (res.destroyed || res.writableEnded) return drop(c);
    try {
      res.write(chunk);
    } catch {
      return drop(c);
    }
    if (res.writableLength > maxBufferBytes) {
      log.warn(`[hub] dropping a slow SSE client (${res.writableLength} bytes buffered)`);
      drop(c);
      res.destroy();
    }
  }

  function ensurePing() {
    if (pingTimer) return;
    pingTimer = setInterval(() => broadcast('ping', { now: now() }), pingMs);
    if (pingTimer.unref) pingTimer.unref();
  }

  /**
   * Take over an HTTP request as an SSE stream. initial: [[event, data], ...] sent right after the retry line
   * (hello + one source snapshot per cached source). Returns the client handle, or null if refused.
   */
  function connect(req, res, initial = []) {
    if (clients.size >= maxClients) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '10', 'Cache-Control': 'no-store' });
      res.end('too many stream clients');
      return null;
    }
    const sock = req.socket;
    if (sock) { sock.setTimeout(0); sock.setNoDelay(true); sock.setKeepAlive(true, 30000); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const c = { res, connectedAt: now() };
    clients.add(c);
    const cleanup = () => drop(c);
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    let chunk = `retry: ${retryMs}\n\n`;
    for (const [event, data] of initial) chunk += frame(event, data);
    write(c, chunk);
    ensurePing();
    try { onChange(clients.size); } catch { /* ignore */ }
    return c;
  }

  /** Send one event to every client (serialized once). Returns the number of clients it was queued for. */
  function broadcast(event, data) {
    if (!clients.size) return 0;
    const chunk = frame(event, data);
    for (const c of [...clients]) write(c, chunk);
    return clients.size;
  }

  function close() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    for (const c of [...clients]) {
      clients.delete(c);
      try { c.res.end(); } catch { /* ignore */ }
    }
  }

  return { connect, broadcast, close, get size() { return clients.size; } };
}
