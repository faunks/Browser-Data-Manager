/**
 * Turn a browser profile into a zip that is ready to be used as a *separate user-data folder*:
 *
 *   Expand-Archive profile.zip D:\\chrome_debug_profile
 *   Start-Process chrome.exe -ArgumentList '--user-data-dir="D:\\chrome_debug_profile" --remote-debugging-port=9222'
 *
 * Chromium browsers (Chrome, Edge, Brave, Chromium)
 *   The zip root is a user-data dir: `Default/` (your profile, renamed to Default whatever it was called,
 *   because --user-data-dir alone opens Default), `Local State` (holds the key that decrypts cookies and
 *   saved passwords; its profile list is trimmed to the one profile) and an empty `First Run`.
 * Firefox
 *   The zip root is the profile folder itself, used as `-profile <folder>`.
 *
 * Caches, lock files and crash dumps are left out (cache can be added back). The zip is streamed, so
 * multi-GB profiles don't need to fit in memory. Cookies stay encrypted with a key tied to the OS user
 * (DPAPI / Keychain), so the extracted folder works for the same OS user on the same machine.
 */
const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

const CHROMIUM_CACHE_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache',
  'Media Cache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache'
]);
const CHROMIUM_ALWAYS_SKIP_DIRS = new Set(['blob_storage', 'Crashpad', 'BrowserMetrics']);
const CHROMIUM_SKIP_FILES = /^(LOCK|lockfile|SingletonLock|SingletonCookie|SingletonSocket)$/;

const GECKO_CACHE_DIRS = new Set(['cache2', 'startupCache', 'shader-cache', 'jumpListCache', 'thumbnails']);
const GECKO_ALWAYS_SKIP_DIRS = new Set(['crashes', 'minidumps', 'saved-telemetry-pings']);
const GECKO_SKIP_FILES = /^(lock|\.parentlock|parent\.lock)$/;

const EXE = {
  win32:  { chrome: 'chrome.exe', edge: 'msedge.exe', brave: 'brave.exe', chromium: 'chromium.exe', firefox: 'firefox.exe' },
  darwin: { chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave Browser', chromium: 'Chromium', firefox: 'Firefox' },
  linux:  { chrome: 'google-chrome', edge: 'microsoft-edge', brave: 'brave-browser', chromium: 'chromium', firefox: 'firefox' }
};
const PORT = 9222;

function exeName(browserId) {
  return (EXE[process.platform] || EXE.linux)[browserId] || browserId;
}

function safeName(s) {
  return String(s || '').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'profile';
}

// ---------- which files go in ----------

function rules(browser, includeCache) {
  const gecko = browser.engine === 'gecko';
  const cacheDirs = gecko ? GECKO_CACHE_DIRS : CHROMIUM_CACHE_DIRS;
  const alwaysDirs = gecko ? GECKO_ALWAYS_SKIP_DIRS : CHROMIUM_ALWAYS_SKIP_DIRS;
  const skipFiles = gecko ? GECKO_SKIP_FILES : CHROMIUM_SKIP_FILES;
  return {
    skipDir: (rel, name) => alwaysDirs.has(name) || (!includeCache && cacheDirs.has(rel)),
    skipFile: (name) => skipFiles.test(name)
  };
}

function walk(root, rule) {
  const files = [];
  const unreadable = [];
  const visit = (dir, relPrefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (err) { unreadable.push({ rel: relPrefix || '.', reason: err.code || err.message }); return; }
    for (const e of entries) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!rule.skipDir(rel, e.name)) visit(abs, rel);
      } else if (e.isFile()) {
        if (rule.skipFile(e.name)) continue;
        let size = 0;
        try { size = fs.statSync(abs).size; } catch (err) { unreadable.push({ rel, reason: err.code || err.message }); continue; }
        files.push({ abs, rel, size });
      }
      // symlinks and special files are ignored on purpose
    }
  };
  visit(root, '');
  return { files, unreadable };
}

// ---------- extra files that make the folder usable ----------

/** Keep os_crypt (the cookie/password key) but make the profile list say "just Default". */
function rewriteLocalState(buf, sourceProfileId) {
  try {
    const j = JSON.parse(buf.toString('utf8'));
    const p = (j.profile = j.profile || {});
    const info = p.info_cache && p.info_cache[sourceProfileId];
    p.info_cache = info ? { Default: info } : {};
    p.last_used = 'Default';
    p.last_active_profiles = ['Default'];
    p.profiles_order = ['Default'];
    return Buffer.from(JSON.stringify(j));
  } catch (_) {
    return buf;   // not JSON for some reason: ship it untouched rather than break the encryption key
  }
}

function dirNameFor(browser) { return `${browser.id}_debug_profile`; }

function commandsFor(browser, filename) {
  const dir = dirNameFor(browser);
  const gecko = browser.engine === 'gecko';
  const exe = exeName(browser.id);
  if (process.platform === 'win32') {
    const target = `D:\\${dir}`;
    const flag = gecko ? `-profile "${target}"` : `--user-data-dir="${target}"`;
    return {
      extract: `Expand-Archive -Path "$HOME\\Downloads\\${filename}" -DestinationPath "${target}"`,
      launch: `Start-Process ${exe} -ArgumentList '${flag} --remote-debugging-port=${PORT}'`
    };
  }
  const target = `$HOME/${dir}`;
  const flag = gecko ? `-profile "${target}"` : `--user-data-dir="${target}"`;
  return {
    extract: `unzip -q ~/Downloads/${filename} -d ${target}`,
    launch: process.platform === 'darwin'
      ? `open -na "${exe}" --args ${flag} --remote-debugging-port=${PORT}`
      : `${exe} ${flag} --remote-debugging-port=${PORT} &`
  };
}

function launcherScript(browser) {
  const gecko = browser.engine === 'gecko';
  const exe = exeName(browser.id);
  if (process.platform === 'win32') {
    const bt = '`';
    const arg = gecko ? `-profile ${bt}"$PSScriptRoot${bt}"` : `--user-data-dir=${bt}"$PSScriptRoot${bt}"`;
    return {
      name: 'launch-debug.ps1',
      text: [
        `# Starts ${browser.name} on THIS folder with remote debugging on port ${PORT}.`,
        '# Works wherever you extracted the zip (this folder is the profile / user-data dir).',
        `$port = ${PORT}`,
        `Start-Process ${exe} -ArgumentList "${arg} --remote-debugging-port=$port"`,
        gecko ? 'Write-Host "Remote debugging: ws://localhost:$port (WebDriver BiDi)"' : 'Write-Host "DevTools endpoint: http://localhost:$port/json/version"',
        ''
      ].join('\r\n')
    };
  }
  const flag = gecko ? '-profile "$DIR"' : '--user-data-dir="$DIR"';
  const run = process.platform === 'darwin'
    ? `open -na "${exe}" --args ${flag} --remote-debugging-port=$PORT`
    : `"${exe}" ${flag} --remote-debugging-port=$PORT &`;
  return {
    name: 'launch-debug.sh',
    mode: 0o100755,
    text: [
      '#!/bin/sh',
      `# Starts ${browser.name} on THIS folder with remote debugging on port ${PORT}.`,
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      `PORT=${PORT}`,
      run,
      gecko ? 'echo "Remote debugging on port $PORT (WebDriver BiDi)"' : 'echo "DevTools endpoint: http://localhost:$PORT/json/version"',
      ''
    ].join('\n')
  };
}

function warningText(browser, profile) {
  return [
    '!!! THIS FOLDER IS A LIVE COPY OF YOUR BROWSER IDENTITY !!!',
    '',
    `Whoever runs a browser on this folder is logged in as you, on every site "${profile.label}" was logged`,
    'into when it was packed -- no password, no 2FA, nothing else needed. It also carries saved passwords and',
    'autofill data for that profile.',
    '',
    'Do not:',
    '  - email it, upload it, or send it over chat / cloud storage you do not fully control',
    '  - hand it to "support", a client, a colleague, or anyone else',
    '  - leave the extracted folder sitting around after you are done debugging',
    '',
    'Changing your passwords afterwards does NOT undo this -- only signing out / revoking sessions on each site',
    'does. If this is not your own machine and account, you are responsible for how this copy of someone\'s',
    'identity gets used once you hand it over.',
    '',
    'Delete this zip and the extracted folder as soon as you are done with it.',
    ''
  ].join('\n');
}

function readmeText(browser, profile, includeCache, skipped) {
  const gecko = browser.engine === 'gecko';
  const c = commandsFor(browser, '<this-zip>.zip');
  return [
    warningText(browser, profile),
    `Debug-ready copy of the ${browser.name} profile "${profile.label}"`,
    `Created ${new Date().toISOString()} by Browser Data Manager`,
    '',
    'How to use',
    `  1. Extract this zip into an empty folder (the folder becomes the ${gecko ? 'profile' : '--user-data-dir'}).`,
    '  2. Close any running copy of the browser that uses that same folder.',
    `  3. Start it with remote debugging on:`,
    `       ${c.launch}`,
    `     (or run ${launcherScript(browser).name} from the extracted folder)`,
    gecko ? false : `  4. Open http://localhost:${PORT}/json/version to check the DevTools endpoint.`,
    '',
    'Notes',
    gecko ? false : `  - Your profile "${profile.id}" is stored as Default/ so that --user-data-dir alone opens it.`,
    gecko ? false : '  - Chrome 136+ ignores --remote-debugging-port on the default user-data dir, which is why this separate folder is needed.',
    '  - Cookies and saved passwords are encrypted with a key tied to the OS user account that created this zip.',
    '    The folder works for that same user on that same computer; on another machine/user they will not decrypt.',
    `  - Browser cache ${includeCache ? 'is included' : 'was left out (it is rebuilt automatically)'}.`,
    skipped ? `  - ${skipped} file(s) could not be read and were skipped; see SKIPPED.txt.` : false,
    ''
  ].filter((l) => l !== false).join('\n');
}

// ---------- public API ----------

function filenameFor(browser, profile) {
  const d = new Date().toISOString().slice(0, 10);
  return `${browser.id}-${safeName(profile.label)}-debug-profile-${d}.zip`;
}

/** Cheap preview: what would go in, and how big it is. */
function plan(browser, profile, { includeCache = false } = {}) {
  const { files, unreadable } = walk(profile.path, rules(browser, includeCache));
  let bytes = files.reduce((n, f) => n + f.size, 0);
  const localState = browser.engine === 'chromium' ? path.join(browser.root, 'Local State') : null;
  let hasLocalState = false;
  if (localState) { try { bytes += fs.statSync(localState).size; hasLocalState = true; } catch (_) {} }
  const filename = filenameFor(browser, profile);
  return {
    filename,
    files: files.length,
    bytes,
    includeCache,
    hasLocalState,
    unreadable: unreadable.length,
    commands: commandsFor(browser, filename),
    _files: files
  };
}

async function canRead(abs) {
  let fh;
  try {
    fh = await fs.promises.open(abs, 'r');
    await fh.read(Buffer.alloc(1), 0, 1, 0);
    return null;
  } catch (err) {
    return err.code || err.message;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * Returns a yazl.ZipFile whose outputStream the caller pipes to the HTTP response. Files are added
 * asynchronously while it streams. `signal` aborts the work if the download is cancelled.
 */
function build(browser, profile, planned, signal) {
  const zip = new yazl.ZipFile();
  const gecko = browser.engine === 'gecko';
  const prefix = gecko ? '' : 'Default/';
  const skipped = planned.unreadable ? [{ rel: '(some folders)', reason: 'unreadable' }] : [];

  (async () => {
    try {
      // 1. the pieces that make the folder usable
      if (!gecko) {
        try {
          const ls = fs.readFileSync(path.join(browser.root, 'Local State'));
          zip.addBuffer(rewriteLocalState(ls, profile.id), 'Local State');
        } catch (err) { skipped.push({ rel: 'Local State', reason: err.code || err.message }); }
        zip.addBuffer(Buffer.alloc(0), 'First Run');
      }
      // 2. the profile itself
      for (const f of planned._files) {
        if (signal.aborted) return;
        const problem = await canRead(f.abs);
        if (problem) { skipped.push({ rel: f.rel, reason: problem }); continue; }
        zip.addFile(f.abs, prefix + f.rel, { compressionLevel: 1 });
      }
      // 3. launcher + notes (added last so they can mention anything that was skipped)
      const launcher = launcherScript(browser);
      zip.addBuffer(Buffer.from(launcher.text), launcher.name, launcher.mode ? { mode: launcher.mode } : undefined);
      zip.addBuffer(Buffer.from(readmeText(browser, profile, planned.includeCache, skipped.length)), 'README-debug-profile.txt');
      zip.addBuffer(Buffer.from(warningText(browser, profile)), '!!! READ BEFORE SHARING !!!.txt');
      if (skipped.length) {
        zip.addBuffer(Buffer.from(skipped.map((s) => `${s.rel}\t${s.reason}`).join('\n') + '\n'), 'SKIPPED.txt');
      }
      zip.end();
    } catch (err) {
      zip.outputStream.destroy(err);
    }
  })();

  return zip;
}

module.exports = { plan, build };
