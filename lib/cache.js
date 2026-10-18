const fs = require('fs');
const path = require('path');

/**
 * Browser disk caches are opaque, version-specific binary formats
 * (Chromium "Simple Cache" blockfiles, Firefox cache2). Fully parsing them
 * is out of scope here. Instead we list the raw cache entry files with
 * size/mtime, and try to recover the original request URL by scanning each
 * file for an embedded http(s):// string - Chromium's Simple Cache and
 * Firefox's cache2 both store the request key as near-plaintext near the
 * start or end of the entry, so this works for a useful fraction of entries.
 * Deleting a file evicts that cache entry even when we can't label it.
 */
function findCacheDirs(browserEngine, profilePath) {
  const dirs = [];
  if (browserEngine === 'chromium') {
    for (const name of ['Cache', path.join('Cache', 'Cache_Data'), 'Code Cache', 'GPUCache']) {
      const p = path.join(profilePath, name);
      if (fs.existsSync(p)) dirs.push(p);
    }
  } else {
    const cache2 = path.join(profilePath, 'cache2', 'entries');
    if (fs.existsSync(cache2)) dirs.push(cache2);
  }
  return dirs;
}

function sniffUrl(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, 4096);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    fs.closeSync(fd);
    const text = buf.toString('latin1');
    const m = text.match(/https?:\/\/[^\s\x00-\x1f"'<>]{4,300}/);
    return m ? m[0] : null;
  } catch (_) {
    return null;
  }
}

function listCache(browser, profilePath) {
  const dirs = findCacheDirs(browser.engine, profilePath);
  const entries = [];
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const f of files) {
      if (!f.isFile()) continue;
      // skip obvious index files
      if (/^(index|the-real-index|__)/i.test(f.name)) continue;
      const full = path.join(dir, f.name);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (stat.size === 0) continue;
      entries.push({
        file: full,
        dir,
        name: f.name,
        sizeBytes: stat.size,
        modified: stat.mtime.toISOString(),
        guessedUrl: sniffUrl(full)
      });
    }
  }
  entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return entries.slice(0, 500); // cap - caches can have tens of thousands of files
}

function deleteCacheFile(filePath) {
  fs.unlinkSync(filePath);
}

function clearCacheDir(browser, profilePath) {
  const dirs = findCacheDirs(browser.engine, profilePath);
  let removed = 0;
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (_) {}
    }
  }
  return removed;
}

module.exports = { listCache, deleteCacheFile, clearCacheDir };
