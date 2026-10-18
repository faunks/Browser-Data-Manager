const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const platform = process.platform; // 'win32' | 'darwin' | 'linux'

/**
 * Each entry describes where a browser keeps its "User Data"-style root.
 * engine: 'chromium' | 'gecko'  (decides how we read cookies/localStorage)
 */
function chromiumRoots() {
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return {
      chrome: path.join(local, 'Google', 'Chrome', 'User Data'),
      edge: path.join(local, 'Microsoft', 'Edge', 'User Data'),
      brave: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      chromium: path.join(local, 'Chromium', 'User Data')
    };
  }
  if (platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    return {
      chrome: path.join(appSupport, 'Google', 'Chrome'),
      edge: path.join(appSupport, 'Microsoft Edge'),
      brave: path.join(appSupport, 'BraveSoftware', 'Brave-Browser'),
      chromium: path.join(appSupport, 'Chromium')
    };
  }
  // linux
  return {
    chrome: path.join(home, '.config', 'google-chrome'),
    edge: path.join(home, '.config', 'microsoft-edge'),
    brave: path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
    chromium: path.join(home, '.config', 'chromium')
  };
}

function geckoRoots() {
  if (platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return { firefox: path.join(roaming, 'Mozilla', 'Firefox') };
  }
  if (platform === 'darwin') {
    return { firefox: path.join(home, 'Library', 'Application Support', 'Firefox') };
  }
  return { firefox: path.join(home, '.mozilla', 'firefox') };
}

const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', engine: 'chromium' },
  { id: 'edge', name: 'Microsoft Edge', engine: 'chromium' },
  { id: 'brave', name: 'Brave', engine: 'chromium' },
  { id: 'chromium', name: 'Chromium', engine: 'chromium' },
  { id: 'firefox', name: 'Firefox', engine: 'gecko' }
];

function listBrowsers() {
  const cRoots = chromiumRoots();
  const gRoots = geckoRoots();
  return BROWSERS.map((b) => {
    const root = b.engine === 'chromium' ? cRoots[b.id] : gRoots[b.id];
    return { ...b, root, installed: !!root && fs.existsSync(root) };
  });
}

function listChromiumProfiles(root) {
  // Each subfolder "Default" or "Profile N" that contains a "Preferences" file is a profile.
  const profiles = [];
  if (!fs.existsSync(root)) return profiles;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'Default' || /^Profile \d+/.test(entry.name) || entry.name === 'Guest Profile') {
      const dir = path.join(root, entry.name);
      if (fs.existsSync(path.join(dir, 'Preferences')) || fs.existsSync(path.join(dir, 'Cookies'))) {
        let label = entry.name;
        try {
          const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Preferences'), 'utf8'));
          if (prefs.profile && prefs.profile.name) label = prefs.profile.name;
        } catch (_) { /* ignore unreadable/locked prefs */ }
        profiles.push({ id: entry.name, label, path: dir });
      }
    }
  }
  return profiles;
}

function listGeckoProfiles(root) {
  const profiles = [];
  if (!fs.existsSync(root)) return profiles;
  const iniPath = path.join(root, 'profiles.ini');
  if (fs.existsSync(iniPath)) {
    const ini = fs.readFileSync(iniPath, 'utf8');
    const blocks = ini.split(/\r?\n(?=\[)/g);
    for (const block of blocks) {
      if (!/^\[Profile\d+\]/.test(block)) continue;
      const pathMatch = block.match(/^Path=(.+)$/m);
      const nameMatch = block.match(/^Name=(.+)$/m);
      const isRelative = /^IsRelative=1/m.test(block);
      if (pathMatch) {
        const p = isRelative ? path.join(root, pathMatch[1]) : pathMatch[1];
        if (fs.existsSync(p)) {
          profiles.push({ id: path.basename(p), label: nameMatch ? nameMatch[1] : path.basename(p), path: p });
        }
      }
    }
  }
  if (profiles.length === 0) {
    // Fallback: scan for *.default* dirs
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.includes('.default')) {
        profiles.push({ id: entry.name, label: entry.name, path: path.join(root, entry.name) });
      }
    }
  }
  return profiles;
}

function listProfiles(browserId) {
  const b = listBrowsers().find((x) => x.id === browserId);
  if (!b || !b.installed) return [];
  return b.engine === 'chromium' ? listChromiumProfiles(b.root) : listGeckoProfiles(b.root);
}

function getBrowser(browserId) {
  return listBrowsers().find((x) => x.id === browserId);
}

module.exports = { listBrowsers, listProfiles, getBrowser, platform };
