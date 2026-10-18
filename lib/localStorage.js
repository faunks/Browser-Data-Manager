const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ClassicLevel } = require('classic-level');

function snapshotDir(srcDir) {
  const tmp = path.join(os.tmpdir(), 'bdm-ldb-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmp);
  for (const f of fs.readdirSync(srcDir)) {
    try { fs.copyFileSync(path.join(srcDir, f), path.join(tmp, f)); } catch (_) {}
  }
  return tmp;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Chromium's "Local Storage" leveldb entries are keyed roughly as:
 *   "_" + <origin> + "\x00" + <js key>
 * with a couple of metadata keys ("VERSION", "META:...") mixed in that we skip.
 * Values carry a 1-byte encoding tag (0 = UTF-16LE, 1 = Latin1/UTF-8) per
 * Chromium's dom_storage ValueEncoding, which we decode heuristically.
 * This is reverse-engineered and best-effort: Chrome has changed this format
 * across versions, so a handful of entries may not parse perfectly.
 */
function decodeChromiumValue(buf) {
  if (!buf || buf.length === 0) return '';
  const tag = buf[0];
  const rest = buf.subarray(1);
  try {
    if (tag === 0) return rest.toString('utf16le');
    return rest.toString('utf8');
  } catch (_) {
    return rest.toString('utf8');
  }
}

function encodeChromiumValue(str) {
  // Always write as UTF-16LE (tag 0), which Chromium always understands.
  const body = Buffer.from(str, 'utf16le');
  return Buffer.concat([Buffer.from([0]), body]);
}

async function listChromiumLocalStorage(profilePath) {
  const dir = path.join(profilePath, 'Local Storage', 'leveldb');
  if (!fs.existsSync(dir)) return [];
  const tmp = snapshotDir(dir);
  const results = [];
  let db;
  try {
    db = new ClassicLevel(tmp, { valueEncoding: 'buffer', keyEncoding: 'buffer' });
    await db.open();
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('latin1');
      if (keyStr === 'VERSION' || keyStr.startsWith('META:')) continue;
      if (keyBuf[0] !== 0x5f /* '_' */) continue;
      const nul = keyBuf.indexOf(0, 1);
      if (nul === -1) continue;
      const origin = keyBuf.subarray(1, nul).toString('utf8');
      const jsKey = keyBuf.subarray(nul + 1).toString('utf16le') || keyBuf.subarray(nul + 1).toString('utf8');
      results.push({
        origin,
        key: jsKey,
        value: decodeChromiumValue(valBuf),
        rawKey: keyBuf.toString('base64')
      });
    }
  } finally {
    if (db) await db.close().catch(() => {});
    rmrf(tmp);
  }
  return results;
}

async function writeChromiumLocalStorage(profilePath, rawKeyB64, newValue) {
  const dir = path.join(profilePath, 'Local Storage', 'leveldb');
  const db = new ClassicLevel(dir, { valueEncoding: 'buffer', keyEncoding: 'buffer' });
  try {
    await db.open();                       // fails with LEVEL_LOCKED while the browser is running
    const key = Buffer.from(rawKeyB64, 'base64');
    if (newValue === null) {
      await db.del(key);
    } else {
      await db.put(key, encodeChromiumValue(newValue));
    }
  } finally {
    await db.close().catch(() => {});
  }
}

// ---------- Firefox ----------

/** Decode a storage/default/<dir> folder name back into a readable origin. */
function decodeFirefoxOriginDir(dirName) {
  // Format roughly: <scheme>+++<host>[+<port]  e.g. https+++example.com
  const m = dirName.match(/^([a-z-]+)\+\+\+(.+)$/i);
  if (!m) return dirName;
  return `${m[1]}://${m[2]}`;
}

async function listFirefoxLocalStorage(profilePath) {
  const base = path.join(profilePath, 'storage', 'default');
  const results = [];
  if (!fs.existsSync(base)) return results;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dataPath = path.join(base, entry.name, 'ls', 'data.sqlite');
    if (!fs.existsSync(dataPath)) continue;
    const tmp = path.join(os.tmpdir(), 'bdm-ffls-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.sqlite');
    try {
      fs.copyFileSync(dataPath, tmp);
      const db = new Database(tmp, { readonly: true, fileMustExist: true });
      const rows = db.prepare('SELECT key, value FROM data').all();
      db.close();
      const origin = decodeFirefoxOriginDir(entry.name);
      for (const r of rows) {
        results.push({ origin, key: r.key, value: typeof r.value === 'string' ? r.value : Buffer.from(r.value).toString('utf8'), originDir: entry.name });
      }
    } catch (_) {
      // table/schema not present in this Firefox version - skip this origin
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  return results;
}

function writeFirefoxLocalStorage(profilePath, originDir, key, newValue) {
  const dataPath = path.join(profilePath, 'storage', 'default', originDir, 'ls', 'data.sqlite');
  if (!fs.existsSync(dataPath)) throw new Error('data.sqlite not found for this origin');
  const db = new Database(dataPath);
  try {
    db.pragma('busy_timeout = 3000');
    if (newValue === null) {
      db.prepare('DELETE FROM data WHERE key = ?').run(key);
    } else {
      db.prepare('UPDATE data SET value = ? WHERE key = ?').run(newValue, key);
    }
  } finally {
    db.close();
  }
}

// ---------- Public API ----------

async function listLocalStorage(browser, profilePath) {
  return browser.engine === 'chromium'
    ? listChromiumLocalStorage(profilePath)
    : listFirefoxLocalStorage(profilePath);
}

async function updateLocalStorage(browser, profilePath, item, newValue) {
  return browser.engine === 'chromium'
    ? writeChromiumLocalStorage(profilePath, item.rawKey, newValue)
    : writeFirefoxLocalStorage(profilePath, item.originDir, item.key, newValue);
}

async function deleteLocalStorage(browser, profilePath, item) {
  return browser.engine === 'chromium'
    ? writeChromiumLocalStorage(profilePath, item.rawKey, null)
    : writeFirefoxLocalStorage(profilePath, item.originDir, item.key, null);
}

module.exports = { listLocalStorage, updateLocalStorage, deleteLocalStorage };
