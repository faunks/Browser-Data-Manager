/**
 * Optionally open the UI in a private/incognito window when the server starts.
 *
 *   npm start -- --open            first browser found (edge, chrome, brave, chromium, firefox)
 *   npm start -- --open=edge       a specific one: chrome | edge | brave | chromium | firefox
 *   OPEN=edge npm start            same thing via env var
 *
 * Chromium-based browsers are started with a separate throw-away --user-data-dir so this window
 * is its own browser instance. That matters: a normal/incognito window of your real profile would
 * keep the cookie + localStorage files locked, which is exactly what you need to avoid when editing.
 * Pass --shared-profile to skip that and just use a plain incognito window.
 * Firefox has no equivalent switch here, so it just gets a private window (it may attach to an
 * already-running Firefox, so prefer a Chromium browser, or a different browser from the one you edit).
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const BROWSERS = {
  edge:     { private: '--inprivate', win: 'msedge',  mac: 'Microsoft Edge', linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  chrome:   { private: '--incognito', win: 'chrome',  mac: 'Google Chrome',  linux: ['google-chrome', 'google-chrome-stable'] },
  brave:    { private: '--incognito', win: 'brave',   mac: 'Brave Browser',  linux: ['brave-browser', 'brave'] },
  chromium: { private: '--incognito', win: 'chromium', mac: 'Chromium',      linux: ['chromium', 'chromium-browser'] },
  firefox:  { private: null, firefox: true, win: 'firefox', mac: 'Firefox', linux: ['firefox'] }
};
const ORDER = ['edge', 'chrome', 'brave', 'chromium', 'firefox'];

function wanted() {
  const arg = process.argv.find((a) => a === '--open' || a.startsWith('--open='));
  const val = arg ? (arg.split('=')[1] || '') : (process.env.OPEN || '');
  if (!arg && !process.env.OPEN) return null;
  if (val && !BROWSERS[val.toLowerCase()]) {
    console.log(`Unknown browser "${val}" for --open. Use one of: ${ORDER.join(', ')}`);
    return null;
  }
  return val ? [val.toLowerCase()] : ORDER;
}

function tryLaunch(cmd, args, opts) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    let child;
    try { child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts }); } catch (_) { return finish(false); }
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    child.unref();
    setTimeout(() => finish(true), 1500); // still running after 1.5s -> it launched
  });
}

async function launch(name, url, shared) {
  const b = BROWSERS[name];
  const profileDir = path.join(os.tmpdir(), 'bdm-ui-profile');
  const q = (s) => `"${s}"`;

  if (process.platform === 'win32') {
    const args = b.firefox ? ['-private-window', q(url)]
      : [b.private, ...(shared ? [] : [`--user-data-dir=${q(profileDir)}`, '--no-first-run']), q(url)];  // quoted: '&' would otherwise end the cmd line
    // `start` resolves the exe through the registry's App Paths, so no full path is needed
    return tryLaunch('cmd', ['/c', 'start', '""', b.win, ...args], { windowsVerbatimArguments: true });
  }
  if (process.platform === 'darwin') {
    const args = b.firefox ? ['-n', '-a', b.mac, '--args', '-private-window', url]
      : ['-n', '-a', b.mac, '--args', b.private, ...(shared ? [] : [`--user-data-dir=${profileDir}`, '--no-first-run']), url];
    return tryLaunch('open', args, {});
  }
  for (const exe of b.linux) {
    const args = b.firefox ? ['-private-window', url]
      : [b.private, ...(shared ? [] : [`--user-data-dir=${profileDir}`, '--no-first-run']), url];
    if (await tryLaunch(exe, args, {})) return true;
  }
  return false;
}

async function maybeOpen(url) {
  const names = wanted();
  if (!names) return;
  const shared = process.argv.includes('--shared-profile');
  if (!shared) { try { fs.mkdirSync(path.join(os.tmpdir(), 'bdm-ui-profile'), { recursive: true }); } catch (_) {} }
  for (const n of names) {
    if (await launch(n, url, shared)) { console.log(`Opened a private ${n} window.`); return; }
  }
  console.log("Couldn't launch a browser automatically. Use the link printed above.");
}

/** Open `url` in a private window of browser `name` (separate throw-away profile). Resolves true if it started. */
function openPrivate(name, url) {
  try { fs.mkdirSync(path.join(os.tmpdir(), 'bdm-ui-profile'), { recursive: true }); } catch (_) {}
  return BROWSERS[name] ? launch(name, url, false) : Promise.resolve(false);
}

/**
 * Open `url` in a normal window of browser `name`, using the REAL profile `profile` ({id, path} from browserPaths).
 * Used by the "Run" button: after your edits are written to disk, this starts the browser on that profile
 * so the site loads with the edited cookies / localStorage. The browser must not already be running
 * (the server ends it first), otherwise the already-open instance would just add a tab and may overwrite the edits.
 */
async function openInProfile(name, profile, url) {
  const b = BROWSERS[name];
  if (!b || !profile) return false;
  // These end up on a cmd.exe line on Windows, so refuse anything that could break out of the quotes.
  if (/["%\r\n]/.test(profile.id) || /["%\r\n]/.test(profile.path)) return false;
  const q = (s) => `"${s}"`;

  if (process.platform === 'win32') {
    const args = b.firefox ? ['-profile', q(profile.path), q(url)]
      : [`--profile-directory=${q(profile.id)}`, q(url)];
    return tryLaunch('cmd', ['/c', 'start', '""', b.win, ...args], { windowsVerbatimArguments: true });
  }
  if (process.platform === 'darwin') {
    const args = b.firefox ? ['-a', b.mac, '--args', '-profile', profile.path, url]
      : ['-a', b.mac, '--args', `--profile-directory=${profile.id}`, url];
    return tryLaunch('open', args, {});
  }
  for (const exe of b.linux) {
    const args = b.firefox ? ['-profile', profile.path, url] : [`--profile-directory=${profile.id}`, url];
    if (await tryLaunch(exe, args, {})) return true;
  }
  return false;
}

module.exports = { maybeOpen, openPrivate, openInProfile };
