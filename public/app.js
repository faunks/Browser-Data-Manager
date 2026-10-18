const state = {
  browser: '',
  profile: '',
  sites: [],
  activeOrigin: null,     // site key
  activeSite: null,       // full site object (has .origins)
  activeTab: 'cookies',
  filter: { q: '', types: new Set(), sort: 'name', hideExt: false, icons: true },
  cursor: 0,
  visible: [],
  browsers: [],
  uiBrowser: null        // which browser *this page* is open in
};

// remember the sidebar prefs between sessions (this is just UI state for the tool itself)
try {
  const saved = JSON.parse(localStorage.getItem('bdm-ui') || '{}');
  if (saved.sort) state.filter.sort = saved.sort;
  state.filter.hideExt = !!saved.hideExt;
  if (saved.icons === false) state.filter.icons = false;
} catch (_) {}
function saveUiPrefs() {
  try { localStorage.setItem('bdm-ui', JSON.stringify({ sort: state.filter.sort, hideExt: state.filter.hideExt, icons: state.filter.icons })); } catch (_) {}
}

const el = (id) => document.getElementById(id);
const browserSelect = el('browserSelect');
const profileSelect = el('profileSelect');
const scanBtn = el('scanBtn');
const zipBtn = el('zipBtn');
const siteList = el('siteList');
const siteTools = el('siteTools');
const siteSearch = el('siteSearch');
const tabContent = el('tabContent');
const warning = el('warning');
const detailBar = el('detailBar');
const saveAllBtn = el('saveAllBtn');
const runBtn = el('runBtn');

// ---------- unsaved edits ("pending") ----------
// Every edited-but-unsaved cookie / localStorage value registers itself here, so "Save all" and "Run"
// can write them all in one go, even when they're on different sites or tabs.
const pending = new Map();   // id -> { site, tab, label, save: async () => void }
const viewCache = new Map(); // "tab|site" -> rendered view; only reused while it still holds unsaved edits

function setPending(id, entry) {
  if (entry) pending.set(id, entry); else pending.delete(id);
  refreshPendingUi();
}
function hasPendingFor(site, tab) {
  for (const p of pending.values()) if (p.site === site && p.tab === tab) return true;
  return false;
}
function refreshPendingUi() {
  const n = pending.size;
  saveAllBtn.disabled = n === 0;
  saveAllBtn.textContent = n ? `Save all (${n})` : 'Save all';
  const dirtySites = new Set(Array.from(pending.values(), (p) => p.site));
  siteList.querySelectorAll('.site-row').forEach((r) => r.classList.toggle('dirty', dirtySites.has(r.dataset.site)));
}
window.addEventListener('beforeunload', (e) => { if (pending.size) { e.preventDefault(); e.returnValue = ''; } });

// ---------- site icons ----------
function hueOf(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** A small square icon: a coloured letter right away, replaced by the real favicon once it loads. */
function siteIcon(key) {
  const wrap = document.createElement('span');
  wrap.className = 'fav';
  const letter = (key.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^a-z0-9]+/i, '')[0] || '?').toUpperCase();
  const fb = document.createElement('span');
  fb.className = 'fav-fb';
  fb.style.background = `hsl(${hueOf(key)} 42% 36%)`;
  fb.textContent = letter;
  wrap.appendChild(fb);
  // extension entries (chrome-extension://id) have no website to ask
  if (state.browser && state.profile && !/^[a-z][a-z0-9+.-]*:\/\//i.test(key)) {
    const img = new Image();
    img.loading = 'lazy';            // only rows scrolled into view actually fetch their icon
    img.decoding = 'async';
    img.alt = '';
    img.addEventListener('load', () => wrap.classList.add('has-img'));
    img.addEventListener('error', () => img.remove());
    img.src = '/api/favicon' + qs({ browser: state.browser, profile: state.profile, host: key, net: state.filter.icons ? '1' : '0' });
    wrap.appendChild(img);
  }
  return wrap;
}

function toast(msg, isError) {
  const t = document.createElement('div');
  t.className = 'toast-msg';
  t.style.borderColor = isError ? 'var(--danger)' : 'var(--border)';
  t.textContent = msg;
  el('toast').appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-BDM': '1', ...(opts && opts.headers) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.running = !!data.running;
    err.sameBrowser = !!data.sameBrowser;
    if (data.locked) {
      err.locked = true;
      // The file is locked because the browser is running. If that's the browser this very page is open
      // in, ending it would kill this page, so offer to move to another browser instead.
      if (state.uiBrowser && state.uiBrowser === state.browser) showSwitchModal(null);
      refreshStatus();
    }
    throw err;
  }
  return data;
}

function qs(params) {
  return '?' + new URLSearchParams(params).toString();
}

async function loadBrowsers() {
  const browsers = await api('/api/browsers');
  state.browsers = browsers;
  for (const b of browsers) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name + (b.installed ? '' : ' (not found)');
    opt.disabled = !b.installed;
    browserSelect.appendChild(opt);
  }
}

async function loadProfiles(browserId) {
  profileSelect.innerHTML = '<option value="">Select profile…</option>';
  if (!browserId) { profileSelect.disabled = true; scanBtn.disabled = true; zipBtn.disabled = scanBtn.disabled; return; }
  const profiles = await api('/api/profiles' + qs({ browser: browserId }));
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    profileSelect.appendChild(opt);
  }
  profileSelect.disabled = profiles.length === 0;
  if (profiles.length === 0) toast('No profiles found for this browser', true);
}

browserSelect.addEventListener('change', () => {
  state.browser = browserSelect.value;
  scanBtn.disabled = true; zipBtn.disabled = scanBtn.disabled;
  refreshStatus();
  loadProfiles(state.browser).catch((e) => toast(e.message, true));
});

profileSelect.addEventListener('change', () => {
  state.profile = profileSelect.value;
  scanBtn.disabled = !state.profile; zipBtn.disabled = scanBtn.disabled;
});

scanBtn.addEventListener('click', () => {
  const stayKey = 'bdm-stay-' + state.browser;
  // Same browser as this page? Offer to move to another one first (skippable: scanning/reading works fine).
  if (state.uiBrowser && state.uiBrowser === state.browser && !sessionStorage.getItem(stayKey)) {
    showSwitchModal(() => scanSites().catch((e) => toast(e.message, true)));
    return;
  }
  scanSites().catch((e) => toast(e.message, true));
});

async function scanSites() {
  if (pending.size && !confirm(`You have ${pending.size} unsaved edit${pending.size === 1 ? '' : 's'}. Scanning again discards them. Continue?`)) return;
  pending.clear();
  viewCache.clear();
  siteList.innerHTML = '<div class="empty">Scanning…</div>';
  const data = await api('/api/sites' + qs({ browser: state.browser, profile: state.profile }));
  state.sites = data.sites;
  state.activeOrigin = null;
  state.activeSite = null;
  siteTools.hidden = false;
  detailBar.hidden = false;
  updateDetailBar();
  refreshPendingUi();
  el('onlineIcons').checked = state.filter.icons;
  el('hideExt').checked = state.filter.hideExt;
  el('siteSort').value = state.filter.sort;
  renderSiteList();
  renderTab();
  if (data.unattributedCacheEntries) {
    toast(`${data.unattributedCacheEntries} cache entries could not be matched to a site (binary cache format).`);
  }
}

const EXT_RE = /^(chrome|moz|edge)-extension:\/\//i;

function siteTotal(x) { return x.cookies + x.localStorage + x.cache; }

function applySiteFilter() {
  const f = state.filter;
  const tokens = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  let list = state.sites.filter((x) => {
    if (f.hideExt && EXT_RE.test(x.origin)) return false;
    for (const t of f.types) if (!x[t]) return false;
    const hay = x.origin.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  if (f.sort === 'data') list = list.slice().sort((a, b) => siteTotal(b) - siteTotal(a) || a.origin.localeCompare(b.origin));
  // when searching, put hosts that *start with* the query first
  else if (tokens.length) {
    const t0 = tokens[0];
    const rank = (x) => (x.origin === t0 ? 0 : x.origin.startsWith(t0) ? 1 : x.origin.includes('.' + t0) ? 2 : 3);
    list = list.slice().sort((a, b) => rank(a) - rank(b) || a.origin.localeCompare(b.origin));
  }
  return { list, tokens };
}

function highlight(text, tokens) {
  if (!tokens.length) return escapeHtml(text);
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const t of tokens) {
    let i = lower.indexOf(t);
    while (i !== -1) { for (let j = i; j < i + t.length; j++) marks[j] = true; i = lower.indexOf(t, i + t.length); }
  }
  let out = '', open = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += escapeHtml(text[i]);
  }
  return out + (open ? '</mark>' : '');
}

function renderSiteList() {
  if (state.sites.length === 0) {
    siteTools.hidden = true;
    siteList.innerHTML = '<div class="empty">No cookies or localStorage found in this profile.</div>';
    return;
  }
  const { list, tokens } = applySiteFilter();
  state.visible = list;
  if (state.cursor >= list.length) state.cursor = Math.max(0, list.length - 1);
  el('siteCount').textContent = list.length === state.sites.length
    ? `${list.length} sites`
    : `${list.length} of ${state.sites.length} sites`;

  if (list.length === 0) {
    siteList.innerHTML = '<div class="empty">No sites match.</div>';
    return;
  }
  // many hundreds of rows is fine as plain DOM, but build in one go
  const frag = document.createDocumentFragment();
  list.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'site-row' + (s.origin === state.activeOrigin ? ' active' : '') + (idx === state.cursor && tokens.length ? ' cursor' : '');
    const parts = [];
    if (s.cookies) parts.push(`${s.cookies} cookie${s.cookies === 1 ? '' : 's'}`);
    if (s.localStorage) parts.push(`${s.localStorage} storage key${s.localStorage === 1 ? '' : 's'}`);
    if (s.cache) parts.push(`${s.cache} cache`);
    row.dataset.site = s.origin;
    row.innerHTML = `<div class="site-text"><div class="origin">${highlight(s.origin, tokens)}</div>
      <div class="counts">${parts.join(' · ') || 'empty'}</div></div>
      <span class="site-dot" title="Unsaved edits">●</span>`;
    row.prepend(siteIcon(s.origin));
    row.addEventListener('click', () => selectSite(s));
    frag.appendChild(row);
  });
  siteList.innerHTML = '';
  siteList.appendChild(frag);
  refreshPendingUi();
}

function selectSite(s) {
  state.activeOrigin = s.origin;
  state.activeSite = s;
  renderSiteList();
  updateDetailBar();
  renderTab();
}

// ---------- detail bar: current site, Save all, Run ----------
function siteUrl(site) {
  if (!site) return null;
  const isUrl = (o) => /^[a-z][a-z0-9+.-]*:\/\//i.test(o);
  const web = site.origins.find((o) => /^https:\/\//i.test(o)) || site.origins.find((o) => /^http:\/\//i.test(o));
  try { if (web) return new URL(web).origin + '/'; } catch (_) {}
  if (isUrl(site.origin)) return null;                       // extension entries have no website
  const host = site.origin.replace(/^\./, '');
  const local = /^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(host);
  return `${local ? 'http' : 'https'}://${host}/`;
}

function updateDetailBar() {
  const site = state.activeSite;
  const icon = el('detailIcon');
  icon.innerHTML = '';
  if (site) icon.appendChild(siteIcon(site.origin));
  el('detailName').textContent = site ? site.origin : 'No site selected';
  const url = siteUrl(site);
  runBtn.disabled = !url;
  runBtn.title = url
    ? `Save everything, then open ${url} in ${browserName(state.browser)} using your edited data`
    : 'Pick a website to run';
}

function originsQs() {
  return { origins: JSON.stringify(state.activeSite ? state.activeSite.origins : [state.activeOrigin]) };
}

// ---- site search wiring ----
let searchTimer;
siteSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filter.q = siteSearch.value;
    state.cursor = 0;
    renderSiteList();
  }, 80);
});

siteSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (siteSearch.value) { siteSearch.value = ''; state.filter.q = ''; state.cursor = 0; renderSiteList(); }
    else siteSearch.blur();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = state.visible.length;
    if (!n) return;
    state.cursor = (state.cursor + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderSiteList();
    const c = siteList.querySelector('.site-row.cursor') || siteList.children[state.cursor];
    if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const s = state.visible[state.cursor];
    if (s) selectSite(s);
  }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !siteTools.hidden) {
    e.preventDefault();
    siteSearch.focus();
    siteSearch.select();
  }
});

document.querySelectorAll('#siteChips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const t = chip.dataset.type;
    if (state.filter.types.has(t)) state.filter.types.delete(t); else state.filter.types.add(t);
    chip.classList.toggle('on', state.filter.types.has(t));
    renderSiteList();
  });
});
el('siteSort').addEventListener('change', (e) => { state.filter.sort = e.target.value; saveUiPrefs(); renderSiteList(); });
el('onlineIcons').addEventListener('change', (e) => { state.filter.icons = e.target.checked; saveUiPrefs(); renderSiteList(); updateDetailBar(); });
el('hideExt').addEventListener('change', (e) => { state.filter.hideExt = e.target.checked; saveUiPrefs(); renderSiteList(); });

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeTab = btn.dataset.tab;
    renderTab();
  });
});

let renderToken = 0;
const COUNT_IDS = { cookies: 'countCookies', localstorage: 'countLs', cache: 'countCache' };

async function renderTab() {
  const token = ++renderToken;
  if (!state.activeOrigin) {
    tabContent.innerHTML = '<div class="empty">Select a site on the left.</div>';
    return;
  }
  const tab = state.activeTab;
  const site = state.activeOrigin;
  const ck = tab + '|' + site;

  // Going back to a view that still has unsaved edits: show the very same DOM again so nothing is lost.
  const cached = viewCache.get(ck);
  if (cached && hasPendingFor(site, tab)) {
    tabContent.innerHTML = '';
    tabContent.appendChild(cached);
    el(COUNT_IDS[tab]).textContent = cached.dataset.count || '';
    return;
  }
  viewCache.delete(ck);

  tabContent.innerHTML = '<div class="empty">Loading…</div>';
  const stale = () => token !== renderToken;
  try {
    if (tab === 'cookies') await renderCookies(site, stale);
    else if (tab === 'localstorage') await renderLocalStorage(site, stale);
    else await renderCache(stale);
    if (stale() || tab === 'cache') return;
    const wrap = document.createElement('div');
    wrap.className = 'view';
    wrap.dataset.count = el(COUNT_IDS[tab]).textContent;
    wrap.append(...tabContent.childNodes);
    tabContent.appendChild(wrap);
    viewCache.set(ck, wrap);
  } catch (e) {
    if (!stale()) tabContent.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

async function renderCookies(siteKey, stale) {
  const rows = await api('/api/cookies' + qs({ browser: state.browser, profile: state.profile, ...originsQs() }));
  if (stale()) return;
  el('countCookies').textContent = rows.length || '';
  if (rows.length === 0) { tabContent.innerHTML = '<div class="empty">No cookies for this site.</div>'; return; }

  const table = document.createElement('table');
  table.innerHTML = `<thead><tr><th>Name</th><th>Value</th><th>Path</th><th>Expires</th><th></th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const c of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}</td>
      <td class="value"><textarea>${escapeHtml(c.value)}</textarea></td>
      <td>${escapeHtml(c.path)}</td>
      <td>${c.expires ? new Date(c.expires).toLocaleDateString() : 'session'}</td>
      <td class="row-actions">
        <button class="btn-copy">Copy</button>
        <button class="btn-save">Save</button>
        <button class="btn-delete">Delete</button>
      </td>`;
    const textarea = tr.querySelector('textarea');
    const pid = `ck|${c.origin}|${c.name}|${c.path}`;
    const persist = async (value) => {
      await api('/api/cookies', {
        method: 'PUT',
        body: JSON.stringify({ browser: state.browser, profile: state.profile, match: { origin: c.origin, name: c.name, path: c.path }, value })
      });
      c.value = value;
      tr.classList.remove('dirty');
      setPending(pid, null);
    };
    textarea.addEventListener('input', () => {
      const dirty = textarea.value !== c.value;
      tr.classList.toggle('dirty', dirty);
      if (pending.has(pid) === dirty) return;
      setPending(pid, dirty ? { site: siteKey, tab: 'cookies', label: `cookie ${c.name}`, save: () => persist(textarea.value) } : null);
    });
    tr.querySelector('.btn-copy').addEventListener('click', () => copyText(textarea.value));
    tr.querySelector('.btn-save').addEventListener('click', async () => {
      try {
        await persist(textarea.value);
        toast('Cookie saved. Changes apply next time the browser reads its cookie DB.');
      } catch (e) { toast(e.message, true); }
    });
    tr.querySelector('.btn-delete').addEventListener('click', async () => {
      if (!confirm(`Delete cookie "${c.name}"?`)) return;
      try {
        await api('/api/cookies', {
          method: 'DELETE',
          body: JSON.stringify({ browser: state.browser, profile: state.profile, match: { origin: c.origin, name: c.name, path: c.path } })
        });
        setPending(pid, null);
        tr.remove();
        toast('Cookie deleted.');
      } catch (e) { toast(e.message, true); }
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tabContent.innerHTML = '';
  tabContent.appendChild(table);
}

function fmtBytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
}

function previewOf(value) {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? flat.slice(0, 120) + '…' : flat;
}

function typeBadge(value) {
  const a = JsonEditor.analyse(value);
  if (a.kind === 'json') return a.isArray ? `list · ${a.count} item${a.count === 1 ? '' : 's'}` : `object · ${a.count} key${a.count === 1 ? '' : 's'}`;
  if (a.kind === 'json-unsafe') return 'JSON · big numbers';
  const t = value.trim();
  if (t === 'true' || t === 'false') return 'boolean';
  if (t !== '' && Number.isFinite(Number(t))) return 'number';
  return 'text';
}

async function renderLocalStorage(siteKey, stale) {
  const rows = await api('/api/localstorage' + qs({ browser: state.browser, profile: state.profile, ...originsQs() }));
  if (stale()) return;
  el('countLs').textContent = rows.length || '';
  if (rows.length === 0) { tabContent.innerHTML = '<div class="empty">No localStorage keys for this site.</div>'; return; }
  rows.sort((a, b) => a.key.localeCompare(b.key));

  const multiOrigin = state.activeSite && state.activeSite.origins.filter((o) => /^https?:\/\//.test(o) || EXT_RE.test(o)).length > 1;

  tabContent.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'ls-bar';
  bar.innerHTML = `<input class="ls-filter" type="search" placeholder="Filter keys and values…" spellcheck="false" autocomplete="off" />
    <label class="check"><input type="checkbox" class="ls-vals" checked /> search values</label>
    <span class="ls-count"></span>
    <button class="ls-collapse">Collapse all</button>`;
  tabContent.appendChild(bar);
  const list = document.createElement('div');
  list.className = 'ls-list';
  tabContent.appendChild(list);

  const cards = rows.map((item) => buildLsCard(item, multiOrigin, siteKey));
  cards.forEach((c) => list.appendChild(c.el));

  const filterInput = bar.querySelector('.ls-filter');
  const valsBox = bar.querySelector('.ls-vals');
  const countEl = bar.querySelector('.ls-count');
  function applyFilter() {
    const tokens = filterInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    const inVals = valsBox.checked;
    let n = 0;
    for (const c of cards) {
      const hay = c.keyLower + (inVals ? '\n' + c.valueLower() : '');
      const hit = tokens.every((t) => hay.includes(t));
      c.el.hidden = !hit;
      c.setKeyMarks(tokens);
      if (hit) n++;
    }
    countEl.textContent = tokens.length ? `${n} of ${cards.length} keys` : `${cards.length} keys`;
    // a single hit is almost always what you were looking for: open it
    if (tokens.length) {
      const visible = cards.filter((c) => !c.el.hidden);
      if (visible.length === 1) visible[0].open();
    }
  }
  let t;
  filterInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(applyFilter, 100); });
  valsBox.addEventListener('change', applyFilter);
  filterInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { filterInput.value = ''; applyFilter(); } });
  bar.querySelector('.ls-collapse').addEventListener('click', () => cards.forEach((c) => c.close()));
  applyFilter();
  if (cards.length === 1) cards[0].open();
}

function buildLsCard(item, showOrigin, siteKey) {
  const card = document.createElement('div');
  card.className = 'ls-card';
  const head = document.createElement('div');
  head.className = 'ls-head';
  const bytes = new Blob([item.value]).size;
  head.innerHTML = `
    <span class="ls-caret">▸</span>
    <span class="ls-key"></span>
    <span class="ls-dirty" hidden title="Unsaved changes">●</span>
    <span class="ls-badge">${escapeHtml(typeBadge(item.value))}</span>
    <span class="ls-size">${fmtBytes(bytes)}</span>
    ${showOrigin ? `<span class="ls-origin" title="${escapeHtml(item.origin)}">${escapeHtml(item.origin)}</span>` : ''}
    <span class="ls-preview">${escapeHtml(previewOf(item.value))}</span>
    <span class="row-actions">
      <button class="btn-copy">Copy</button>
      <button class="btn-delete">Delete</button>
    </span>`;
  const keyEl = head.querySelector('.ls-key');
  keyEl.textContent = item.key;
  const bodyEl = document.createElement('div');
  bodyEl.className = 'ls-body';
  bodyEl.hidden = true;
  card.append(head, bodyEl);

  let editor = null;
  let opened = false;
  const pid = `ls|${item.origin}|${item.key}`;

  // Writes one value to disk (no toast, so Save all can report a single summary).
  async function persist(value) {
    await api('/api/localstorage', {
      method: 'PUT',
      body: JSON.stringify({ browser: state.browser, profile: state.profile, item, value })
    });
    item.value = value;
    head.querySelector('.ls-preview').textContent = previewOf(value);
    head.querySelector('.ls-badge').textContent = typeBadge(value);
    head.querySelector('.ls-size').textContent = fmtBytes(new Blob([value]).size);
  }
  async function saveNow() {
    if (!editor.isValid()) throw new Error(`"${item.key}" contains invalid JSON`);
    const value = editor.getValue();
    await persist(value);
    editor.setBaseline(value);   // also clears the dirty marker
    setPending(pid, null);
  }

  function open() {
    if (!editor) {
      editor = JsonEditor.create({
        value: item.value,
        onDirtyChange: (d) => {
          head.querySelector('.ls-dirty').hidden = !d;
          card.classList.toggle('dirty', d);
          if (pending.has(pid) === d) return;
          setPending(pid, d ? { site: siteKey, tab: 'localstorage', label: `${item.key}`, save: saveNow } : null);
        },
        onSave: async (value) => {
          try {
            await persist(value);
            setPending(pid, null);
            toast('Saved.');
          } catch (e) { toast(e.message, true); throw e; }
        }
      });
      bodyEl.appendChild(editor.el);
    }
    opened = true;
    bodyEl.hidden = false;
    card.classList.add('open');
    head.querySelector('.ls-caret').textContent = '▾';
    head.querySelector('.ls-preview').hidden = true;
  }
  function close() {
    opened = false;
    bodyEl.hidden = true;
    card.classList.remove('open');
    head.querySelector('.ls-caret').textContent = '▸';
    head.querySelector('.ls-preview').hidden = false;
  }

  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    opened ? close() : open();
  });
  head.querySelector('.btn-copy').addEventListener('click', () => copyText(editor ? editor.getValue() : item.value));
  head.querySelector('.btn-delete').addEventListener('click', async () => {
    if (!confirm(`Delete key "${item.key}"?`)) return;
    try {
      await api('/api/localstorage', {
        method: 'DELETE',
        body: JSON.stringify({ browser: state.browser, profile: state.profile, item })
      });
      setPending(pid, null);
      card.remove();
      toast('Deleted.');
    } catch (e) { toast(e.message, true); }
  });

  return {
    el: card,
    keyLower: item.key.toLowerCase(),
    valueLower: (() => { let c, src; return () => (src === item.value ? c : (src = item.value, c = item.value.toLowerCase())); })(),
    open,
    close,
    setKeyMarks(tokens) { keyEl.innerHTML = highlight(item.key, tokens); }
  };
}

async function renderCache(stale) {
  const rows = await api('/api/cache' + qs({ browser: state.browser, profile: state.profile, ...originsQs() }));
  if (stale()) return;
  el('countCache').textContent = rows.length || '';
  const note = document.createElement('div');
  note.className = 'cache-note';
  note.textContent = 'Cache is a binary, version-specific format: entries are matched to this site by a best-effort scan and may be incomplete. Deleting removes the raw cache file.';
  tabContent.innerHTML = '';
  tabContent.appendChild(note);
  if (rows.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No cache entries matched to this site.';
    tabContent.appendChild(d);
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr><th>File</th><th>Size</th><th>Modified</th><th></th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const entry of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="value">${escapeHtml(entry.name)}</td>
      <td>${(entry.sizeBytes / 1024).toFixed(1)} KB</td>
      <td>${new Date(entry.modified).toLocaleString()}</td>
      <td class="row-actions"><button class="btn-delete">Delete</button></td>`;
    tr.querySelector('.btn-delete').addEventListener('click', async () => {
      if (!confirm('Delete this cache file?')) return;
      try {
        await api('/api/cache', { method: 'DELETE', body: JSON.stringify({ file: entry.file }) });
        tr.remove();
        toast('Cache file deleted.');
      } catch (e) { toast(e.message, true); }
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tabContent.appendChild(table);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard.')).catch(() => toast('Copy failed.', true));
}

// ---------- which browser is this page open in? ----------

async function detectCurrentBrowser() {
  try { if (navigator.brave && await navigator.brave.isBrave()) return 'brave'; } catch (_) {}
  const ua = navigator.userAgent || '';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand);
  const real = brands.filter((b) => !/not.?a.?brand/i.test(b) && b !== 'Chromium');
  for (const b of real) {
    if (/Brave/i.test(b)) return 'brave';
    if (/Google Chrome/i.test(b)) return 'chrome';
    if (/Microsoft Edge/i.test(b)) return 'edge';
  }
  if (real.length) return null;                       // Opera, Vivaldi, ... (not one we manage)
  if (brands.includes('Chromium')) return 'chromium';
  return /Chrome\//.test(ua) ? 'chrome' : null;
}

// ---------- running status + End task ----------

const endTaskBtn = el('endTaskBtn');
const browserName = (id) => (state.browsers.find((b) => b.id === id) || {}).name || id;
let statusTimer = null;

async function refreshStatus() {
  if (!state.browser) { warning.hidden = true; clearInterval(statusTimer); statusTimer = null; return; }
  if (!statusTimer) statusTimer = setInterval(() => { if (!document.hidden) refreshStatus(); }, 3000);
  const name = browserName(state.browser);
  const same = state.uiBrowser === state.browser;
  let running = null;
  try { running = (await api('/api/status' + qs({ browser: state.browser }))).running; } catch (_) {}
  if (!state.browser) return;
  warning.hidden = false;
  const dot = el('warnDot');
  const text = el('warnText');
  if (same) {
    dot.className = 'dot on';
    text.textContent = `You're viewing this app in ${name}, which is also the browser you're editing. It can't be closed from here without closing this page.`;
    endTaskBtn.hidden = false;
    endTaskBtn.textContent = 'Switch browser…';
    endTaskBtn.onclick = () => showSwitchModal(null);
  } else if (running) {
    dot.className = 'dot on';
    text.textContent = `${name} is running. Close it before saving or deleting, or the files stay locked.`;
    endTaskBtn.hidden = false;
    endTaskBtn.textContent = `End ${name} task`;
    endTaskBtn.onclick = endBrowserTask;
  } else {
    dot.className = 'dot off';
    text.textContent = running === false ? `${name} is closed — safe to edit.` : 'Close this browser before editing.';
    endTaskBtn.hidden = true;
  }
}

async function endBrowserTask() {
  const name = browserName(state.browser);
  if (!confirm(`Force-close ${name}?\n\nThis ends every ${name} window and background process (like Task Manager's End Task). ` +
    `Unsent form data is lost; tabs can usually be restored the next time you open it.`)) return;
  endTaskBtn.disabled = true;
  try {
    const r = await api('/api/browser/end', { method: 'POST', body: JSON.stringify({ browser: state.browser, uiBrowser: state.uiBrowser }) });
    toast(r.stillRunning ? `${name} is still running — try again or close it manually.` : `${name} closed. You can edit now.`, r.stillRunning);
  } catch (e) { toast(e.message, true); }
  endTaskBtn.disabled = false;
  refreshStatus();
}

// ---------- switch-browser popup ----------

const modal = el('modal');

function showModal(title, body, buttons) {
  el('modalTitle').textContent = title;
  el('modalBody').textContent = body;
  const box = el('modalBtns');
  box.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = 'modal-btn' + (b.primary ? ' primary' : '');
    btn.addEventListener('click', b.onClick);
    box.appendChild(btn);
  }
  modal.hidden = false;
}
function hideModal() { modal.hidden = true; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && !modal.dataset.busy) hideModal(); });

/** onStay: what to do if the user chooses to stay in this browser (read-only). null = just close the popup. */
function showSwitchModal(onStay) {
  const from = browserName(state.browser);
  const others = state.browsers.filter((b) => b.installed && b.id !== state.browser);
  const buttons = others.map((b) => ({
    label: `Close ${from} & open in ${b.name}`,
    primary: true,
    onClick: () => switchTo(b)
  }));
  buttons.push({
    label: onStay ? 'Stay here (read-only)' : 'Cancel',
    onClick: () => { hideModal(); if (onStay) { sessionStorage.setItem('bdm-stay-' + state.browser, '1'); onStay(); } }
  });
  showModal(
    `You're using ${from} to edit ${from}`,
    others.length
      ? `${from} has to be fully closed before its cookies and localStorage can be changed, and closing it would close this page. ` +
        `Pick another browser to continue in: it opens with this app and your selection, then ${from} is closed.`
      : `${from} has to be fully closed before it can be edited, but no other supported browser was found on this PC to continue in. ` +
        `Install one (for example Edge or Firefox) or open this page in another browser.`,
    buttons
  );
}

async function switchTo(target) {
  const from = browserName(state.browser);
  if (pending.size && !confirm(`You have ${pending.size} unsaved edit${pending.size === 1 ? '' : 's'}. Switching browsers closes this page and discards them. Switch anyway?`)) return;
  modal.dataset.busy = '1';
  showModal(`Opening ${target.name}…`, `Starting ${target.name}. Once it's up, ${from} will be closed and this window goes with it.`, []);
  try {
    await api('/api/browser/switch', { method: 'POST', body: JSON.stringify({ from: state.browser, to: target.id, profile: state.profile || '' }) });
    showModal(`Continue in ${target.name}`, `${target.name} should now be open with this app. ${from} is being closed — you can ignore this window.`, []);
  } catch (e) {
    delete modal.dataset.busy;
    toast(e.message, true);
    showSwitchModal(null);
  }
}

// ---------- Save all / Run ----------

let saving = false;

/** Writes every pending edit. Returns true only if everything that was pending is now on disk. */
async function saveAll(quietWhenEmpty) {
  const items = Array.from(pending.values());
  if (!items.length) { if (!quietWhenEmpty) toast('Nothing to save.'); return true; }
  if (saving) return false;
  saving = true;
  saveAllBtn.disabled = true;
  let ok = 0;
  const failures = [];
  for (const p of items) {
    try { await p.save(); ok++; }
    catch (e) {
      failures.push(`${p.label}: ${e.message}`);
      if (e.locked) break;     // every other write would hit the same lock
    }
  }
  saving = false;
  refreshPendingUi();
  if (failures.length) {
    toast(`Saved ${ok} of ${items.length}. ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`, true);
    return false;
  }
  toast(`Saved ${ok} change${ok === 1 ? '' : 's'}.`);
  return true;
}

saveAllBtn.addEventListener('click', () => saveAll());

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveAll(); }
});

/**
 * Run = make sure the browser is closed, write all edits, then open the site in that browser on the
 * edited profile, so it loads with your cookies / localStorage.
 */
async function runSite() {
  const site = state.activeSite;
  const url = siteUrl(site);
  if (!site || !url) { toast('Pick a website first.', true); return; }
  const name = browserName(state.browser);

  if (state.uiBrowser && state.uiBrowser === state.browser) {
    showModal(`Run needs a different browser`,
      `This page is open in ${name}, which is the browser you're editing. Run has to close ${name} and start it again on the edited profile, which would close this page too. ` +
      `Continue in another browser first; then Run works from there.`,
      [
        { label: 'Switch browser…', primary: true, onClick: () => showSwitchModal(null) },
        { label: 'Cancel', onClick: hideModal }
      ]);
    return;
  }

  runBtn.disabled = true;
  try {
    const status = await api('/api/status' + qs({ browser: state.browser }));
    if (status.running) {
      if (!confirm(`${name} has to be closed so your edits can be written and then picked up.\n\nForce-close ${name} now? ` +
        `Every ${name} window and background process ends; tabs can usually be restored when it starts again.`)) return;
      const r = await api('/api/browser/end', { method: 'POST', body: JSON.stringify({ browser: state.browser, uiBrowser: state.uiBrowser }) });
      if (r.stillRunning) { toast(`${name} is still running. Close it manually and try Run again.`, true); refreshStatus(); return; }
    }
    if (!(await saveAll(true))) return;
    const r = await api('/api/browser/run', {
      method: 'POST',
      body: JSON.stringify({ browser: state.browser, profile: state.profile, url, uiBrowser: state.uiBrowser })
    });
    toast(`Opened ${r.url} in ${name}. Close ${name} again before editing more.`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    runBtn.disabled = !siteUrl(state.activeSite);
    refreshStatus();
  }
}
runBtn.addEventListener('click', runSite);

// ---------- Export ----------

const exportModal = el('exportModal');
const expGo = el('expGo');
const expSearch = el('expSearch');
const exp = { scope: 'current', sel: new Set() };
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

function expTypes() { return Array.from(exportModal.querySelectorAll('.exp-type:checked'), (c) => c.value); }

/** The sites the dialog currently stands for: an array of site keys, or the string "all". */
function expSites() {
  if (exp.scope === 'current') return state.activeOrigin ? [state.activeOrigin] : [];
  if (exp.scope === 'pick') return Array.from(exp.sel);
  if (exp.scope === 'shown') return applySiteFilter().list.map((s) => s.origin);
  return 'all';
}

function refreshExportSummary() {
  const types = expTypes();
  const sites = expSites();
  const keys = sites === 'all' ? state.sites.map((s) => s.origin) : sites;
  const byKey = new Map(state.sites.map((s) => [s.origin, s]));
  const n = { cookies: 0, localStorage: 0, cache: 0 };
  for (const k of keys) {
    const s = byKey.get(k);
    if (!s) continue;
    n.cookies += s.cookies; n.localStorage += s.localStorage; n.cache += s.cache;
  }
  const parts = [];
  if (types.includes('cookies')) parts.push(plural(n.cookies, 'cookie'));
  if (types.includes('localStorage')) parts.push(plural(n.localStorage, 'storage key'));
  if (types.includes('cache')) parts.push(plural(n.cache, 'cache entry', 'cache entries'));
  el('expSummary').textContent = !keys.length ? 'No sites chosen.'
    : !types.length ? 'Nothing chosen to export.'
    : `${plural(keys.length, 'site')}: ${parts.join(' · ')}`;
  expGo.disabled = !keys.length || !types.length || !el('expAck').checked;
  el('expPickCount').textContent = exp.sel.size ? `(${exp.sel.size} chosen)` : '';
  el('expEverything').checked = types.length === 3;
}

function renderExpPicker() {
  const tokens = expSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.sites.filter((s) => tokens.every((t) => s.origin.toLowerCase().includes(t)));
  const box = el('expSiteList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">No sites match.</div>'; return; }
  const frag = document.createDocumentFragment();
  for (const s of list) {
    const row = document.createElement('label');
    row.className = 'exp-site';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = exp.sel.has(s.origin);
    cb.addEventListener('change', () => { cb.checked ? exp.sel.add(s.origin) : exp.sel.delete(s.origin); refreshExportSummary(); });
    const name = document.createElement('span');
    name.className = 'exp-site-name';
    name.textContent = s.origin;
    const counts = document.createElement('span');
    counts.className = 'exp-site-counts';
    counts.textContent = [s.cookies && `${s.cookies}c`, s.localStorage && `${s.localStorage}s`, s.cache && `${s.cache}k`].filter(Boolean).join(' · ');
    row.append(cb, siteIcon(s.origin), name, counts);
    frag.appendChild(row);
  }
  box.appendChild(frag);
}

function setExpScope(scope) {
  exp.scope = scope;
  exportModal.querySelectorAll('input[name="expScope"]').forEach((r) => { r.checked = r.value === scope; });
  el('expPicker').hidden = scope !== 'pick';
  if (scope === 'pick') renderExpPicker();
  refreshExportSummary();
}

function openExport() {
  if (!state.sites.length) { toast('Scan a profile first.', true); return; }
  const active = state.activeOrigin;
  exp.sel = new Set(active ? [active] : []);
  expSearch.value = '';

  el('expCurrentLabel').textContent = active ? `Current site: ${active}` : 'Current site (none selected)';
  exportModal.querySelector('input[name="expScope"][value="current"]').disabled = !active;
  const shown = applySiteFilter().list.length;
  const filtered = shown !== state.sites.length;
  el('expShownRow').hidden = !filtered;
  el('expShownLabel').textContent = `Sites in the current list (${shown} of ${state.sites.length}, matching your search/filters)`;
  el('expAllLabel').textContent = `All sites (${state.sites.length})`;

  exportModal.querySelectorAll('.exp-type').forEach((c) => { c.checked = true; });
  const note = el('expPendingNote');
  note.hidden = !pending.size;
  note.textContent = pending.size ? `You have ${plural(pending.size, 'unsaved edit')}. The export contains what is saved in the browser's files, so Save all first if you want them included.` : '';

  el('expAck').checked = false;
  setExpScope(active ? 'current' : 'all');
  exportModal.hidden = false;
}
function closeExport() { exportModal.hidden = true; }

async function doExport() {
  const types = expTypes();
  const sites = expSites();
  expGo.disabled = true;
  expGo.textContent = 'Exporting…';
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BDM': '1' },
      body: JSON.stringify({ browser: state.browser, profile: state.profile, sites, types })
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || res.statusText);
    }
    const blob = await res.blob();
    const label = sites === 'all' ? 'all-sites' : sites.length === 1 ? sites[0].replace(/[^a-z0-9.-]+/gi, '_') : `${sites.length}-sites`;
    const what = types.length === 3 ? 'everything' : types.join('+');
    const name = `bdm-${state.browser}-${label}-${what}-${new Date().toISOString().slice(0, 10)}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Exported ${name}`);
    closeExport();
  } catch (e) {
    toast(e.message, true);
  } finally {
    expGo.textContent = 'Export';
    refreshExportSummary();
  }
}

el('exportBtn').addEventListener('click', openExport);
el('expCancel').addEventListener('click', closeExport);
expGo.addEventListener('click', doExport);
exportModal.addEventListener('click', (e) => { if (e.target === exportModal) closeExport(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !exportModal.hidden) closeExport(); });
exportModal.querySelectorAll('input[name="expScope"]').forEach((r) => r.addEventListener('change', () => setExpScope(r.value)));
exportModal.querySelectorAll('.exp-type').forEach((c) => c.addEventListener('change', refreshExportSummary));
el('expAck').addEventListener('change', refreshExportSummary);
el('expEverything').addEventListener('change', (e) => {
  exportModal.querySelectorAll('.exp-type').forEach((c) => { c.checked = e.target.checked; });
  refreshExportSummary();
});
let expSearchTimer;
expSearch.addEventListener('input', () => { clearTimeout(expSearchTimer); expSearchTimer = setTimeout(renderExpPicker, 80); });
el('expSelShown').addEventListener('click', () => {
  const tokens = expSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
  state.sites.filter((s) => tokens.every((t) => s.origin.toLowerCase().includes(t))).forEach((s) => exp.sel.add(s.origin));
  renderExpPicker();
  refreshExportSummary();
});
el('expSelNone').addEventListener('click', () => { exp.sel.clear(); renderExpPicker(); refreshExportSummary(); });

// ---------- Debug-ready profile zip ----------

const zipModal = el('zipModal');
let zipPlanToken = 0;

async function refreshZipPlan() {
  const token = ++zipPlanToken;
  const goBtn = el('zipGo');
  goBtn.disabled = true;
  el('zipSummary').textContent = 'Calculating…';
  try {
    const p = await api('/api/profile-zip/plan' + qs({ browser: state.browser, profile: state.profile, cache: el('zipCache').checked ? '1' : '0' }));
    if (token !== zipPlanToken) return;
    const ls = p.hasLocalState === false && browserIsChromium() ? ' · "Local State" not found, so cookies may not decrypt' : '';
    el('zipSummary').textContent = `${p.files.toLocaleString()} files · about ${fmtBytes(p.bytes)} before compression${ls}`;
    el('zipCmds').textContent = `${p.commands.extract}\n${p.commands.launch}`;
    const warn = el('zipRunning');
    warn.hidden = !p.running;
    warn.textContent = p.running ? `${browserName(state.browser)} is running. Its files can be mid-write, so close it first for a clean copy (use End task in the bar above), or go ahead and accept that.` : '';
    goBtn.disabled = !el('zipAck').checked;
  } catch (e) {
    if (token === zipPlanToken) el('zipSummary').textContent = e.message;
  }
}

function browserIsChromium() {
  const b = state.browsers.find((x) => x.id === state.browser);
  return !b || b.engine === 'chromium';
}

function openZipDialog() {
  if (!state.browser || !state.profile) { toast('Pick a browser and profile first.', true); return; }
  el('zipCache').checked = false;
  el('zipAck').checked = false;
  el('zipCmds').textContent = '';
  zipModal.hidden = false;
  refreshZipPlan();
}
function closeZipDialog() { zipModal.hidden = true; zipPlanToken++; }

zipBtn.addEventListener('click', openZipDialog);
el('zipCancel').addEventListener('click', closeZipDialog);
el('zipCache').addEventListener('change', refreshZipPlan);
el('zipAck').addEventListener('change', () => { el('zipGo').disabled = !el('zipAck').checked; });
zipModal.addEventListener('click', (e) => { if (e.target === zipModal) closeZipDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !zipModal.hidden) closeZipDialog(); });
el('zipCopy').addEventListener('click', () => copyText(el('zipCmds').textContent));
el('zipGo').addEventListener('click', () => {
  // a normal navigation-style download: the browser streams the zip to disk as the server builds it
  const a = document.createElement('a');
  a.href = '/api/profile-zip' + qs({ browser: state.browser, profile: state.profile, cache: el('zipCache').checked ? '1' : '0' });
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Download started. A big profile takes a while to pack; the browser shows progress.');
});

// ---------- start up ----------

(async () => {
  try {
    await loadBrowsers();
    state.uiBrowser = await detectCurrentBrowser();
    // Arriving from a "switch browser" hand-off: restore the selection and scan right away.
    const p = new URLSearchParams(location.search);
    if (p.get('browser') && state.browsers.some((b) => b.id === p.get('browser') && b.installed)) {
      state.browser = p.get('browser');
      browserSelect.value = state.browser;
      await loadProfiles(state.browser);
      if (p.get('profile')) { profileSelect.value = p.get('profile'); state.profile = profileSelect.value; }
      scanBtn.disabled = !state.profile; zipBtn.disabled = scanBtn.disabled;
      history.replaceState(null, '', location.pathname);
      refreshStatus();
      if (p.get('scan') && state.profile) await scanSites();
    }
  } catch (e) { toast(e.message, true); }
})();
