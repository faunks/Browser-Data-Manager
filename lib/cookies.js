const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { decryptChromiumValue, encryptChromiumValue, safeStorageServiceNameFor } = require('./decrypt');
const { platform } = require('./browserPaths');

function snapshotCopy(filePath) {
  const tmp = path.join(os.tmpdir(), 'bdm-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.sqlite');
  fs.copyFileSync(filePath, tmp);
  // Chrome/Firefox sqlite DBs may have -wal / -shm sidecar files with unflushed data.
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(filePath + suffix)) {
      try { fs.copyFileSync(filePath + suffix, tmp + suffix); } catch (_) {}
    }
  }
  return tmp;
}

function cleanup(tmp) {
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
}

// ---------- Chromium ----------

function chromiumCookiesPath(profilePath) {
  const direct = path.join(profilePath, 'Cookies');
  if (fs.existsSync(direct)) return direct;
  const nested = path.join(profilePath, 'Network', 'Cookies');
  if (fs.existsSync(nested)) return nested;
  return null;
}

function listChromiumCookies(browserId, userDataRoot, profilePath) {
  const dbPath = chromiumCookiesPath(profilePath);
  if (!dbPath) return [];
  const tmp = snapshotCopy(dbPath);
  try {
    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, creation_utc
       FROM cookies ORDER BY host_key`
    ).all();
    db.close();
    const serviceName = safeStorageServiceNameFor(browserId);
    return rows.map((r) => ({
      origin: r.host_key.replace(/^\./, ''),
      name: r.name,
      value: r.value && r.value.length > 0 ? r.value : decryptChromiumValue(r.encrypted_value, platform, userDataRoot, serviceName),
      path: r.path,
      expires: chromiumEpochToDate(r.expires_utc),
      secure: !!r.is_secure,
      httpOnly: !!r.is_httponly
    }));
  } finally {
    cleanup(tmp);
  }
}

function chromiumEpochToDate(v) {
  if (!v || v === 0) return null;
  // Chrome epoch: microseconds since 1601-01-01
  const unixMs = v / 1000 - 11644473600000;
  return new Date(unixMs).toISOString();
}

function writeChromiumCookie(browserId, userDataRoot, profilePath, match, updates) {
  const dbPath = chromiumCookiesPath(profilePath);
  if (!dbPath) throw new Error('Cookies database not found for this profile');
  const db = new Database(dbPath); // direct, read-write; requires browser closed
  try {
    db.pragma('busy_timeout = 3000');
    const serviceName = safeStorageServiceNameFor(browserId);
    if (updates === null) {
      db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ? AND path = ?')
        .run('.' + match.origin.replace(/^\./, ''), match.name, match.path);
      // host_key may or may not have leading dot; try both
      db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ? AND path = ?')
        .run(match.origin.replace(/^\./, ''), match.name, match.path);
      return;
    }
    const encrypted = encryptChromiumValue(updates.value, platform, userDataRoot, serviceName);
    const info = db.prepare(
      `UPDATE cookies SET value = '', encrypted_value = ? WHERE host_key = ? AND name = ? AND path = ?`
    ).run(encrypted, match.origin, match.name, match.path);
    if (info.changes === 0) {
      db.prepare(
        `UPDATE cookies SET value = '', encrypted_value = ? WHERE host_key = ? AND name = ? AND path = ?`
      ).run(encrypted, '.' + match.origin.replace(/^\./, ''), match.name, match.path);
    }
  } finally {
    db.close();
  }
}

// ---------- Firefox ----------

function firefoxCookiesPath(profilePath) {
  const p = path.join(profilePath, 'cookies.sqlite');
  return fs.existsSync(p) ? p : null;
}

function listFirefoxCookies(profilePath) {
  const dbPath = firefoxCookiesPath(profilePath);
  if (!dbPath) return [];
  const tmp = snapshotCopy(dbPath);
  try {
    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      `SELECT host, name, value, path, expiry, isSecure, isHttpOnly FROM moz_cookies ORDER BY host`
    ).all();
    db.close();
    return rows.map((r) => ({
      origin: r.host.replace(/^\./, ''),
      name: r.name,
      value: r.value,
      path: r.path,
      expires: r.expiry ? new Date(r.expiry * 1000).toISOString() : null,
      secure: !!r.isSecure,
      httpOnly: !!r.isHttpOnly
    }));
  } finally {
    cleanup(tmp);
  }
}

function writeFirefoxCookie(profilePath, match, updates) {
  const dbPath = firefoxCookiesPath(profilePath);
  if (!dbPath) throw new Error('cookies.sqlite not found for this profile');
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 3000');
    if (updates === null) {
      db.prepare('DELETE FROM moz_cookies WHERE host = ? AND name = ? AND path = ?')
        .run(match.origin, match.name, match.path);
      db.prepare('DELETE FROM moz_cookies WHERE host = ? AND name = ? AND path = ?')
        .run('.' + match.origin, match.name, match.path);
      return;
    }
    db.prepare('UPDATE moz_cookies SET value = ? WHERE host = ? AND name = ? AND path = ?')
      .run(updates.value, match.origin, match.name, match.path);
  } finally {
    db.close();
  }
}

// ---------- Public API ----------

function listCookies(browser, userDataRoot, profilePath) {
  return browser.engine === 'chromium'
    ? listChromiumCookies(browser.id, userDataRoot, profilePath)
    : listFirefoxCookies(profilePath);
}

function updateCookie(browser, userDataRoot, profilePath, match, newValue) {
  return browser.engine === 'chromium'
    ? writeChromiumCookie(browser.id, userDataRoot, profilePath, match, { value: newValue })
    : writeFirefoxCookie(profilePath, match, { value: newValue });
}

function deleteCookie(browser, userDataRoot, profilePath, match) {
  return browser.engine === 'chromium'
    ? writeChromiumCookie(browser.id, userDataRoot, profilePath, match, null)
    : writeFirefoxCookie(profilePath, match, null);
}

module.exports = { listCookies, updateCookie, deleteCookie };
