/**
 * Access gate: only YOUR browser window, on THIS machine, may talk to the server.
 *
 * Layers (every request goes through all of them):
 *  1. The socket must be a loopback connection (127.0.0.1 / ::1). The server also only *binds* to 127.0.0.1,
 *     so other computers can't even open a connection; this is a second lock.
 *  2. The Host header must be exactly localhost / 127.0.0.1 / [::1] with our port (stops DNS rebinding).
 *  3. Browser-sent Origin / Sec-Fetch-Site headers must say "same origin" (stops other websites from poking it).
 *  4. A random 256-bit session secret, created fresh on every start, must be presented as a cookie. It is handed
 *     to your browser through a SINGLE-USE link code (?t=...) that expires, so it never sits in a reusable URL,
 *     the command line, or browser history. Other users / programs on this PC without the cookie get 401.
 */
const crypto = require('crypto');

const SESSION = crypto.randomBytes(32).toString('hex');
const COOKIE = 'bdm_session';
const codes = new Map(); // single-use link code -> expiry (ms since epoch)

function purge() { const now = Date.now(); for (const [c, exp] of codes) if (exp <= now) codes.delete(c); }

/** A one-time code that can be swapped for the session cookie, once, within `ttlMs`. */
function mintCode(ttlMs = 10 * 60 * 1000) {
  purge();
  const code = crypto.randomBytes(24).toString('hex');
  codes.set(code, Date.now() + ttlMs);
  return code;
}

/** `base` like "http://localhost:4321", `pathQuery` like "/?browser=edge". Returns a single-use link. */
function mintUrl(base, pathQuery = '/', ttlMs) {
  const u = new URL(pathQuery, base);
  u.searchParams.set('t', mintCode(ttlMs));
  return u.toString();
}

function consumeCode(code) {
  purge();
  const exp = codes.get(code);
  if (!exp) return false;
  codes.delete(code); // single use
  return exp > Date.now();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hasSession(req) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE && safeEqual(part.slice(i + 1).trim(), SESSION)) return true;
  }
  return false;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function createGate(port) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);

  return function gate(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const deny = (code, msg) => res.status(code).type('text/plain').send(msg);

    if (!LOOPBACK.has(req.socket.remoteAddress)) { req.socket.destroy(); return; }
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) return deny(403, 'Forbidden host');
    if (req.headers.origin && !origins.has(String(req.headers.origin).toLowerCase())) return deny(403, 'Forbidden origin');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return deny(403, 'Forbidden cross-site request');

    // Link code -> session cookie, then redirect to the same URL without the code.
    if (req.method === 'GET' && req.query && typeof req.query.t === 'string') {
      const ok = consumeCode(req.query.t);
      if (!ok && !hasSession(req)) return deny(403, 'This link was already used or has expired. Restart start.bat (or the server) to get a new one.');
      if (ok) res.setHeader('Set-Cookie', `${COOKIE}=${SESSION}; HttpOnly; SameSite=Strict; Path=/`);
      const u = new URL(req.originalUrl, 'http://localhost');
      u.searchParams.delete('t');
      return res.redirect(303, u.pathname + u.search);
    }

    if (!hasSession(req)) {
      return deny(401, 'Access denied.\nOpen Browser Data Manager with the link printed in its console window, or just run start.bat again.');
    }
    next();
  };
}

module.exports = { createGate, mintUrl };
