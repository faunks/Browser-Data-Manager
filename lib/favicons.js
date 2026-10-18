/**
 * Site icons for the sidebar.
 *
 * Lookup order for a site key (e.g. "github.com"; see siteKey() in server.js):
 *   1. The browser's own saved icons — Chromium's `Favicons` DB or Firefox's `favicons.sqlite`.
 *      Fully offline, and it's exactly the icon you see in your tabs.
 *   2. (optional, `net: true`) The site itself: its <link rel="icon"> tags, then /favicon.ico.
 *      Results — including "no icon" — are cached on disk in ../.icon-cache so each site is asked once.
 *
 * Online fetching is limited to public hostnames: no IPs, no localhost / single-label / .local names,
 * and every redirect hop is re-checked, so a cookie for an internal host can't make this tool poke your LAN.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dns = require('dns');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const CACHE_DIR = path.join(__dirname, '..', '.icon-cache');
const MISS_TTL = 3 * 24 * 3600 * 1000;      // retry sites without an icon after 3 days
const HIT_TTL = 30 * 24 * 3600 * 1000;      // refresh downloaded icons after 30 days
const LOCAL_TTL = 2 * 60 * 1000;            // re-read the browser's icon DB at most every 2 min
const MAX_ICON_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 256 * 1024;

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

// ---------- helpers ----------

function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = buf.subarray(0, 600).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Same collapsing rule as siteKey() in server.js, but starting from a full page URL. */
function keyFromUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { return null; }
  const host = u.host.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  return (u.protocol === 'http:' || u.protocol === 'https:') ? host : `${u.protocol}//${host}`;
}

/** Lower score = better. We draw icons at ~16-20px, so ~32px (2x) is ideal; 65535 = scalable (svg). */
function sizeScore(w) {
  if (w === 65535) return 0;
  if (!w) return 5000;
  return w >= 32 ? w - 32 : 1000 - w;
}

function remember(map, key, buf, width) {
  if (!key || !buf || !buf.length) return;
  const mime = sniff(buf);
  if (!mime) return;
  const score = sizeScore(width);
  const prev = map.get(key);
  if (!prev || score < prev.score) map.set(key, { mime, buf, score });
}

function snapshot(file) {
  const tmp = path.join(os.tmpdir(), 'bdm-fav-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.sqlite');
  fs.copyFileSync(file, tmp);
  for (const s of ['-wal', '-shm']) {
    if (fs.existsSync(file + s)) { try { fs.copyFileSync(file + s, tmp + s); } catch (_) {} }
  }
  return tmp;
}
function dropSnapshot(tmp) {
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
}

// ---------- 1. the browser's own icon database ----------

function readLocal(browser, profilePath) {
  const map = new Map();
  const file = path.join(profilePath, browser.engine === 'chromium' ? 'Favicons' : 'favicons.sqlite');
  if (!fs.existsSync(file)) return map;
  let tmp;
  try {
    tmp = snapshot(file);
    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
      if (browser.engine === 'chromium') {
        const rows = db.prepare(
          `SELECT m.page_url AS url, b.image_data AS data, b.width AS width
           FROM icon_mapping m JOIN favicon_bitmaps b ON b.icon_id = m.icon_id
           WHERE b.image_data IS NOT NULL`
        ).iterate();
        for (const r of rows) remember(map, keyFromUrl(r.url), r.data, r.width);
      } else {
        const rows = db.prepare(
          `SELECT p.page_url AS url, i.data AS data, i.width AS width
           FROM moz_pages_w_icons p
           JOIN moz_icons_to_pages ip ON ip.page_id = p.id
           JOIN moz_icons i ON i.id = ip.icon_id
           WHERE i.data IS NOT NULL`
        ).iterate();
        for (const r of rows) remember(map, keyFromUrl(r.url), r.data, r.width);
      }
    } finally { db.close(); }
  } catch (err) {
    console.warn('[favicons] could not read the browser icon DB:', err.message);
  } finally {
    if (tmp) dropSnapshot(tmp);
  }
  return map;
}

const localCache = new Map(); // "browser|profile" -> { t, map }

function localMap(browser, profile) {
  const k = browser.id + '|' + profile.id;
  const hit = localCache.get(k);
  if (hit && Date.now() - hit.t < LOCAL_TTL) return hit.map;
  const map = readLocal(browser, profile.path);
  localCache.set(k, { t: Date.now(), map });
  return map;
}

function invalidate(browserId, profileId) {
  localCache.delete(browserId + '|' + profileId);
}

/** "static.foo.com" -> ["static.foo.com", "foo.com"]. Stops at two labels. Ports are ignored for parents. */
function candidates(key) {
  const out = [key];
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(key)) return out;
  const hostOnly = key.replace(/:\d+$/, '');
  if (hostOnly !== key) out.push(hostOnly);
  if (net.isIP(hostOnly)) return out;
  const labels = hostOnly.split('.');
  while (labels.length > 2) { labels.shift(); out.push(labels.join('.')); }
  return out;
}

// ---------- 2. fetching from the site itself ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
}

function fetchableHost(host) {
  if (!host || net.isIP(host) || !host.includes('.')) return false;
  if (!/^[a-z0-9.-]+$/i.test(host)) return false;                 // also rejects ports and brackets
  return !/(^|\.)(localhost|local|internal|lan|home|corp|intranet|test|invalid)$/i.test(host);
}

async function assertPublic(host) {
  if (!fetchableHost(host)) throw new Error('host not allowed');
  const addrs = await dns.promises.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('private address');
}

async function readLimited(res, maxBytes) {
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { try { await reader.cancel(); } catch (_) {} break; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

async function safeFetch(url, maxBytes, timeoutMs = 4000) {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(cur);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme not allowed');
    await assertPublic(u.hostname);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(cur, {
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (BrowserDataManager icon fetch)', Accept: 'text/html,image/*;q=0.9,*/*;q=0.5' }
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        try { await res.body.cancel(); } catch (_) {}
        cur = new URL(loc, cur).href;
        continue;
      }
      if (!res.ok) { try { await res.body.cancel(); } catch (_) {} throw new Error('HTTP ' + res.status); }
      return { buf: await readLimited(res, maxBytes), url: cur };
    } finally { clearTimeout(timer); }
  }
  throw new Error('too many redirects');
}

function iconLinksFromHtml(html, baseUrl) {
  const found = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) || []).slice(1).find(Boolean) || '';
    const tokens = rel.toLowerCase().split(/\s+/);
    const apple = tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed');
    if (!tokens.includes('icon') && !apple) continue;
    const href = (tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) || []).slice(1).find(Boolean);
    if (!href || /^data:/i.test(href)) continue;
    const size = (tag.match(/\bsizes\s*=\s*["']?(\d+)x\d+/i) || [])[1];
    let abs;
    try { abs = new URL(href.replace(/&amp;/g, '&'), baseUrl).href; } catch (_) { continue; }
    found.push({ url: abs, apple, score: apple ? 2000 + sizeScore(Number(size) || 0) : sizeScore(Number(size) || 0) });
  }
  return found.sort((a, b) => a.score - b.score).slice(0, 3);
}

async function downloadIcon(host) {
  let origin = `https://${host}/`;
  try {
    const page = await safeFetch(origin, MAX_HTML_BYTES);
    origin = new URL(page.url).origin + '/';
    for (const c of iconLinksFromHtml(page.buf.toString('utf8'), page.url)) {
      try {
        const img = await safeFetch(c.url, MAX_ICON_BYTES);
        const mime = sniff(img.buf);
        if (mime) return { mime, buf: img.buf };
      } catch (_) { /* try the next candidate */ }
    }
  } catch (_) { /* no usable homepage; fall through to /favicon.ico */ }
  try {
    const img = await safeFetch(origin + 'favicon.ico', MAX_ICON_BYTES);
    const mime = sniff(img.buf);
    if (mime) return { mime, buf: img.buf };
  } catch (_) {}
  return null;
}

// ---- disk cache + request coalescing + concurrency cap ----

const cacheFile = (host) => path.join(CACHE_DIR, crypto.createHash('sha1').update(host).digest('hex') + '.json');

function readDisk(host) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(host), 'utf8'));
    const age = Date.now() - j.t;
    if (j.miss) return age < MISS_TTL ? { miss: true } : null;
    if (age >= HIT_TTL) return null;
    return { mime: j.mime, buf: Buffer.from(j.b64, 'base64') };
  } catch (_) { return null; }
}

function writeDisk(host, icon) {
  try {
    fs.writeFileSync(cacheFile(host), JSON.stringify(icon
      ? { t: Date.now(), mime: icon.mime, b64: icon.buf.toString('base64') }
      : { t: Date.now(), miss: true }));
  } catch (_) {}
}

const inflight = new Map();
const waiting = [];
let active = 0;
const MAX_ACTIVE = 6;

function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(resolve, reject).finally(() => { active--; const next = waiting.shift(); if (next) next(); });
    };
    active < MAX_ACTIVE ? run() : waiting.push(run);
  });
}

async function fromNetwork(host) {
  if (!fetchableHost(host)) return null;
  const disk = readDisk(host);
  if (disk) return disk.miss ? null : disk;
  if (!inflight.has(host)) {
    inflight.set(host, limited(async () => {
      const icon = await downloadIcon(host).catch(() => null);
      writeDisk(host, icon);
      return icon;
    }).finally(() => inflight.delete(host)));
  }
  return inflight.get(host);
}

// ---------- public API ----------

/**
 * @returns {Promise<{mime:string, buf:Buffer}|null>}
 */
async function getIcon(browser, profile, key, { net: allowNet = true } = {}) {
  const local = localMap(browser, profile);
  const keys = candidates(key);
  for (const k of keys) {
    const hit = local.get(k);
    if (hit) return hit;
  }
  // Cached downloads are free to serve even when "online icons" is off; only *new* downloads need the switch.
  for (const k of keys) {
    const disk = readDisk(k);
    if (disk && !disk.miss) return disk;
  }
  if (!allowNet) return null;
  return fromNetwork(key);   // the site's own host only (fetchableHost() rejects ports / non-public names)
}

module.exports = { getIcon, invalidate, _internal: { sniff, iconLinksFromHtml, isPrivateIp, fetchableHost, candidates, keyFromUrl } };
