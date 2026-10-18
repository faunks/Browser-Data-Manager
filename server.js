const express = require('express');
const path = require('path');
const { listBrowsers, listProfiles, getBrowser } = require('./lib/browserPaths');
const cookiesLib = require('./lib/cookies');
const lsLib = require('./lib/localStorage');
const cacheLib = require('./lib/cache');
const control = require('./lib/browserControl');
const { openPrivate, openInProfile } = require('./lib/openUi');
const favicons = require('./lib/favicons');
const profileZip = require('./lib/profileZip');

const { createGate, mintUrl } = require('./lib/localOnly');

const PORT = Number(process.env.PORT) || 4321;
const BASE = `http://localhost:${PORT}`;

const app = express();
app.disable('x-powered-by');
// Local-only gate: loopback socket + exact Host/Origin + per-launch secret cookie. Runs before ANYTHING else (static files included).
app.use(createGate(PORT));
app.use(express.json());

// Extra check on top of the gate: writes / process-kills must carry a custom header, which cross-site pages can't send.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-bdm'] !== '1') return res.status(403).json({ error: 'Missing X-BDM header' });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function resolveProfile(req) {
  const browserId = req.query.browser || req.body.browser;
  const profileId = req.query.profile || req.body.profile;
  const browser = getBrowser(browserId);
  if (!browser || !browser.installed) throw Object.assign(new Error('Unknown or not-installed browser'), { status: 400 });
  const profile = listProfiles(browserId).find((p) => p.id === profileId);
  if (!profile) throw Object.assign(new Error('Unknown profile'), { status: 400 });
  return { browser, profile };
}

const LOCKED_MSG = 'The browser still has this profile open, so its data files are locked. Close the browser completely ' +
  '(check Task Manager / the system tray for leftover background processes), then try again.';

function isLockError(err) {
  const code = err && (err.code || '');
  const causeCode = err && err.cause && err.cause.code;
  return code === 'LEVEL_LOCKED' || causeCode === 'LEVEL_LOCKED' || code === 'LEVEL_DATABASE_NOT_OPEN' ||
    code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|LOCK:|being used by another process/i.test(String(err && err.message) + String(err && err.cause && err.cause.message));
}

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (isLockError(err)) {
        console.warn(`[locked] ${req.method} ${req.path}: browser still running`);
        return res.status(409).json({ error: LOCKED_MSG, locked: true });
      }
      if (!err.status) console.error(err);
      res.status(err.status || 500).json({ error: err.message, ...(err.running && { running: true }), ...(err.sameBrowser && { sameBrowser: true }) });
    });
  };
}

/**
 * Cookies are stored by bare host ("google.com"), localStorage by full origin
 * ("https://www.google.com"), cache by URL. To stop one site showing up as three
 * separate rows we collapse them all onto one key: scheme (http/https), a leading
 * dot and "www." are dropped. Anything else (chrome-extension://, file://) keeps its scheme.
 */
function siteKey(origin) {
  let s = String(origin || '').trim().toLowerCase().replace(/^\./, '');
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
  if (m) {
    const rest = m[2].replace(/\/.*$/, '');
    s = (m[1] === 'http' || m[1] === 'https') ? rest : `${m[1]}://${rest}`;
  }
  return s.replace(/^www\./, '');
}

/** The UI sends the raw origins that make up a site as ?origins=<json array>. */
function parseOrigins(req) {
  const raw = req.query.origins;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map(String);
    } catch (_) {}
    const err = new Error('Bad "origins" parameter');
    err.status = 400;
    throw err;
  }
  return req.query.origin ? [String(req.query.origin)] : null;
}

app.get('/api/browsers', asyncRoute(async (req, res) => {
  res.json(listBrowsers().map(({ id, name, engine, installed }) => ({ id, name, engine, installed })));
}));

app.get('/api/profiles', asyncRoute(async (req, res) => {
  const browserId = req.query.browser;
  res.json(listProfiles(browserId));
}));

app.get('/api/sites', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  favicons.invalidate(browser.id, profile.id);   // pick up icons for sites visited since the last scan
  const cookies = cookiesLib.listCookies(browser, browser.root, profile.path);
  const storage = await lsLib.listLocalStorage(browser, profile.path);
  const cache = cacheLib.listCache(browser, profile.path);

  const sites = new Map();
  const bump = (origin, field) => {
    const key = siteKey(origin);
    if (!key) return;
    if (!sites.has(key)) sites.set(key, { origin: key, origins: new Set(), cookies: 0, localStorage: 0, cache: 0 });
    const site = sites.get(key);
    site.origins.add(origin);
    site[field]++;
  };
  cookies.forEach((c) => bump(c.origin, 'cookies'));
  storage.forEach((s) => bump(s.origin, 'localStorage'));
  cache.forEach((entry) => {
    if (entry.guessedUrl) {
      try { bump(new URL(entry.guessedUrl).host, 'cache'); } catch (_) {}
    }
  });

  res.json({
    sites: Array.from(sites.values())
      .map((x) => ({ ...x, origins: Array.from(x.origins) }))
      .sort((a, b) => a.origin.localeCompare(b.origin)),
    unattributedCacheEntries: cache.filter((e) => !e.guessedUrl).length
  });
}));

// ---- Site icons ----
// The sidebar can ask for hundreds of icons at once, so resolving the profile (which reads each profile's
// Preferences file) is memoised for a few seconds.
const profileMemo = new Map();
function resolveProfileCached(req) {
  const k = `${req.query.browser}|${req.query.profile}`;
  const hit = profileMemo.get(k);
  if (hit && Date.now() - hit.t < 15000) return hit.v;
  const v = resolveProfile(req);
  profileMemo.set(k, { t: Date.now(), v });
  return v;
}

app.get('/api/favicon', asyncRoute(async (req, res) => {
  const host = String(req.query.host || '').trim().toLowerCase();
  if (!host || host.length > 255) return res.status(400).end();
  const { browser, profile } = resolveProfileCached(req);
  const icon = await favicons.getIcon(browser, profile, host, { net: req.query.net !== '0' });
  if (!icon) return res.status(404).end();
  res.set({
    'Content-Type': icon.mime,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    // an SVG icon must never run script, even if someone opens the URL directly
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  });
  res.send(icon.buf);
}));

// ---- Cookies ----

app.get('/api/cookies', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const all = cookiesLib.listCookies(browser, browser.root, profile.path);
  const origins = parseOrigins(req);
  res.json(origins ? all.filter((c) => origins.includes(c.origin)) : all);
}));

app.put('/api/cookies', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const { match, value } = req.body;
  cookiesLib.updateCookie(browser, browser.root, profile.path, match, value);
  res.json({ ok: true });
}));

app.delete('/api/cookies', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const { match } = req.body;
  cookiesLib.deleteCookie(browser, browser.root, profile.path, match);
  res.json({ ok: true });
}));

// ---- localStorage ----

app.get('/api/localstorage', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const all = await lsLib.listLocalStorage(browser, profile.path);
  const origins = parseOrigins(req);
  res.json(origins ? all.filter((s) => origins.includes(s.origin)) : all);
}));

app.put('/api/localstorage', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const { item, value } = req.body;
  await lsLib.updateLocalStorage(browser, profile.path, item, value);
  res.json({ ok: true });
}));

app.delete('/api/localstorage', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const { item } = req.body;
  await lsLib.deleteLocalStorage(browser, profile.path, item);
  res.json({ ok: true });
}));

// ---- Cache (best-effort) ----

app.get('/api/cache', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const all = cacheLib.listCache(browser, profile.path);
  const origins = parseOrigins(req);
  const keys = origins && new Set(origins.map(siteKey));
  const hostKey = (url) => { try { return siteKey(new URL(url).host); } catch (_) { return null; } };
  res.json(keys ? all.filter((e) => e.guessedUrl && keys.has(hostKey(e.guessedUrl))) : all);
}));

app.delete('/api/cache', asyncRoute(async (req, res) => {
  const { file, clearAll } = req.body;
  if (clearAll) {
    const { browser, profile } = resolveProfile(req);
    const removed = cacheLib.clearCacheDir(browser, profile.path);
    return res.json({ ok: true, removed });
  }
  cacheLib.deleteCacheFile(file);
  res.json({ ok: true });
}));

// ---- Export ----
// body: { browser, profile, sites: "all" | [siteKey, ...], types: ["cookies" | "localStorage" | "cache", ...] }
// Cache is exported as a listing only (URL guess, size, date): the raw files are opaque binary blobs.
app.post('/api/export', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const types = ['cookies', 'localStorage', 'cache'].filter((t) => Array.isArray(req.body.types) && req.body.types.includes(t));
  if (!types.length) throw Object.assign(new Error('Choose at least one thing to export.'), { status: 400 });
  const all = req.body.sites === 'all';
  if (!all && !(Array.isArray(req.body.sites) && req.body.sites.length)) {
    throw Object.assign(new Error('Choose at least one site to export.'), { status: 400 });
  }
  const wanted = all ? null : new Set(req.body.sites.map(String));

  const sites = {};
  const slot = (key) => {
    if (!sites[key]) { sites[key] = {}; for (const t of types) sites[key][t] = []; }
    return sites[key];
  };
  if (wanted) for (const key of wanted) slot(key);   // explicitly chosen sites appear even when empty
  const take = (key) => key && (!wanted || wanted.has(key));

  if (types.includes('cookies')) {
    for (const c of cookiesLib.listCookies(browser, browser.root, profile.path)) {
      const key = siteKey(c.origin);
      if (take(key)) slot(key).cookies.push({ host: c.origin, name: c.name, value: c.value, path: c.path, expires: c.expires, secure: c.secure, httpOnly: c.httpOnly });
    }
  }
  if (types.includes('localStorage')) {
    for (const i of await lsLib.listLocalStorage(browser, profile.path)) {
      const key = siteKey(i.origin);
      if (take(key)) slot(key).localStorage.push({ origin: i.origin, key: i.key, value: i.value });
    }
  }
  const unattributedCache = [];
  if (types.includes('cache')) {
    for (const e of cacheLib.listCache(browser, profile.path)) {
      const row = { name: e.name, sizeBytes: e.sizeBytes, modified: e.modified, url: e.guessedUrl || null };
      let key = null;
      if (e.guessedUrl) { try { key = siteKey(new URL(e.guessedUrl).host); } catch (_) {} }
      if (key && take(key)) slot(key).cache.push(row);
      else if (!key && all) unattributedCache.push(row);
    }
  }

  const ordered = {};
  for (const k of Object.keys(sites).sort()) ordered[k] = sites[k];
  const totals = {};
  for (const t of types) totals[t] = Object.values(ordered).reduce((n, v) => n + v[t].length, 0);

  res.json({
    format: 'browser-data-manager-export',
    version: 1,
    _WARNING: 'This file contains live session cookies / tokens. Anyone who has it can be signed in as you on these ' +
      'sites, no password or 2FA needed. Do not share, email, or upload this file. Delete it when you are done.',
    exportedAt: new Date().toISOString(),
    browser: browser.id,
    profile: profile.label,
    types,
    siteCount: Object.keys(ordered).length,
    totals,
    ...(types.includes('cache') && { notes: ['Cache is a listing only (best-effort URL match, 500 largest files max), not the cached content.'] }),
    sites: ordered,
    ...(all && unattributedCache.length && { unattributedCache })
  });
}));

// ---- Profile -> debug-ready zip ----
// GET so the browser streams the (possibly multi-GB) download straight to disk instead of buffering it in memory.
// It only reads, but it hands out every cookie in the profile, so a cross-site page must not be able to trigger it.
function sameOriginOnly(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) throw Object.assign(new Error('Forbidden'), { status: 403 });
}

app.get('/api/profile-zip/plan', asyncRoute(async (req, res) => {
  sameOriginOnly(req);
  const { browser, profile } = resolveProfile(req);
  const { _files, ...plan } = profileZip.plan(browser, profile, { includeCache: req.query.cache === '1' });
  res.json({ ...plan, running: await control.isRunning(browser.id) });
}));

app.get('/api/profile-zip', asyncRoute(async (req, res) => {
  sameOriginOnly(req);
  const { browser, profile } = resolveProfile(req);
  const planned = profileZip.plan(browser, profile, { includeCache: req.query.cache === '1' });
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });   // download cancelled: stop reading files
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${planned.filename}"`,
    'Cache-Control': 'no-store'
  });
  const zip = profileZip.build(browser, profile, planned, ac.signal);
  zip.outputStream.on('error', (err) => { console.error('[profile-zip]', err); res.destroy(err); });
  zip.outputStream.pipe(res);
}));

// ---- Browser process control ----

app.get('/api/status', asyncRoute(async (req, res) => {
  const browser = getBrowser(req.query.browser);
  if (!browser) throw Object.assign(new Error('Unknown browser'), { status: 400 });
  res.json({ running: await control.isRunning(browser.id) });
}));

// End Task: force-close every process of a browser. Refused for the browser this page is open in,
// because that would kill the UI itself — the UI offers "switch browser" for that case instead.
app.post('/api/browser/end', asyncRoute(async (req, res) => {
  const { browser: id, uiBrowser } = req.body;
  const browser = getBrowser(id);
  if (!browser) throw Object.assign(new Error('Unknown browser'), { status: 400 });
  if (uiBrowser && uiBrowser === id) {
    throw Object.assign(new Error('This window is running in that browser. Switch to another browser first.'), { status: 409 });
  }
  res.json({ ok: true, ...(await control.endTask(id)) });
}));

// Open this app in `to` (private window, scan restored), then end `from`.
app.post('/api/browser/switch', asyncRoute(async (req, res) => {
  const { from, to, profile } = req.body;
  const src = getBrowser(from);
  const dst = getBrowser(to);
  if (!src || !dst || !dst.installed || src.id === dst.id) throw Object.assign(new Error('Bad browser selection'), { status: 400 });
  const qs = new URLSearchParams({ browser: src.id, scan: '1' });
  if (profile) qs.set('profile', profile);
  const ok = await openPrivate(dst.id, mintUrl(BASE, `/?${qs}`, 60 * 1000));
  if (!ok) throw Object.assign(new Error(`Couldn't start ${dst.name}. Nothing was closed.`), { status: 500 });
  res.json({ ok: true, opened: dst.name });
  // give the response a moment to flush and the new window a moment to load, then end the old browser
  setTimeout(() => { control.endTask(src.id).catch(() => {}); }, 2500);
}));

// Run: open a site in the browser being edited, on the edited profile, so it loads with your changes.
// The UI saves everything first and ends the browser if it's running; this is the final launch step.
app.post('/api/browser/run', asyncRoute(async (req, res) => {
  const { browser, profile } = resolveProfile(req);
  const { url, uiBrowser } = req.body;
  let u;
  try { u = new URL(String(url)); } catch (_) { throw Object.assign(new Error('Bad URL'), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol) || !/^[a-z0-9.\-:\[\]]+$/i.test(u.host)) {
    throw Object.assign(new Error('Only http(s) sites can be opened.'), { status: 400 });
  }
  if (uiBrowser && uiBrowser === browser.id) {
    throw Object.assign(new Error(`This page is open in ${browser.name}, so it can't be restarted from here.`), { status: 409, sameBrowser: true });
  }
  if (await control.isRunning(browser.id)) {
    throw Object.assign(new Error(`${browser.name} is still running. Close it first, otherwise it would keep its old data.`), { status: 409, running: true });
  }
  const target = u.origin + '/';
  const ok = await openInProfile(browser.id, profile, target);
  if (!ok) throw Object.assign(new Error(`Couldn't start ${browser.name}.`), { status: 500 });
  res.json({ ok: true, opened: browser.name, url: target });
}));

const server = app.listen(PORT, '127.0.0.1', () => {
  const a = server.address();
  if (!a || a.address !== '127.0.0.1') { console.error('Refusing to run: server is not bound to 127.0.0.1 only.'); process.exit(1); }
  console.log(`Browser Data Manager running at ${BASE}  (reachable from this computer only, and only with the session link)`);
  console.log('Close the target browser before editing/deleting cookies or localStorage (SQLite needs exclusive write access).');
  console.log(`Open it with this single-use link (valid 10 min, then restart for a new one):\n  ${mintUrl(BASE, '/')}`);
  require('./lib/openUi').maybeOpen(mintUrl(BASE, '/'));
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other copy first (or set PORT=...).`);
  else console.error(err);
  process.exit(1);
});
