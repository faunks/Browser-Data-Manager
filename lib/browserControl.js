/**
 * Check / end a browser's processes. "End task" = what Task Manager's End Task does: it force-closes
 * every window AND background process of that browser, which is what actually releases the lock on
 * its profile files (closing the last window is often not enough on Windows).
 */
const { execFile } = require('child_process');

// Process image names per platform. Edge's WebView2 runtime (msedgewebview2.exe) is deliberately NOT
// listed: other apps depend on it.
const PROCS = {
  win32:  { chrome: ['chrome.exe'], edge: ['msedge.exe'], brave: ['brave.exe'], chromium: ['chromium.exe'], firefox: ['firefox.exe'] },
  darwin: { chrome: ['Google Chrome'], edge: ['Microsoft Edge'], brave: ['Brave Browser'], chromium: ['Chromium'], firefox: ['firefox'] },
  linux:  { chrome: ['chrome'], edge: ['msedge'], brave: ['brave'], chromium: ['chromium', 'chromium-browser'], firefox: ['firefox'] }
};

function names(id) {
  const table = PROCS[process.platform] || PROCS.linux;
  return table[id] || [];
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
  });
}

async function procRunning(name) {
  if (process.platform === 'win32') {
    const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH']);
    return stdout.toLowerCase().includes(`"${name.toLowerCase()}"`);
  }
  const { err } = await run('pgrep', ['-x', name]);
  return !err;
}

async function isRunning(id) {
  for (const n of names(id)) if (await procRunning(n)) return true;
  return false;
}

async function kill(id, force) {
  for (const n of names(id)) {
    if (process.platform === 'win32') await run('taskkill', ['/F', '/T', '/IM', n]);
    else await run('pkill', [force ? '-9' : '-15', '-x', n]);
  }
}

/** Kill every process of the browser and wait (up to ~5s) until they're really gone. */
async function endTask(id) {
  await kill(id, false);
  for (let i = 0; i < 10; i++) {
    if (!(await isRunning(id))) return { stillRunning: false };
    await new Promise((r) => setTimeout(r, 500));
    if (i === 4) await kill(id, true); // escalate on mac/linux
  }
  return { stillRunning: await isRunning(id) };
}

module.exports = { isRunning, endTask };
