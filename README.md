# Browser Data Manager

A local tool (Node/Express backend + plain HTML/JS frontend) to browse, copy, edit and
delete **cookies**, **localStorage**, and (best-effort) **cache** entries for browsers
installed on your own machine — Chrome, Edge, Brave, Chromium, and Firefox.

This reads real browser profile files on disk. Only run it against your own computer.

## Setup

### Fresh / bare Windows PC (nothing installed)

Double-click **`start.bat`** (or run `powershell -ExecutionPolicy Bypass -File start.ps1`). That's it.

On the first run it downloads a portable Node.js (official zip from nodejs.org, SHA-256 checked, no admin
rights, no installer) into `.runtime\node`, runs `npm ci`, then starts the app with `--open`. After that it
starts in a couple of seconds. It needs internet on the first run only (nodejs.org, registry.npmjs.org and
github.com for the prebuilt SQLite binary), and no C++ toolchain. If Node 18/20/22 is already installed it uses that instead.

```
start.bat                   opens in the first of edge / chrome / brave / chromium / firefox it finds
start.bat --open=chrome     pick one
start.bat --no-open         don't open a browser
```

Extract the zip first (don't run it from inside the zip viewer). To reset, delete `.runtime` and `node_modules`.

### Manual setup (you already have Node)

```bash
cd browser-data-manager
npm install
npm start
```

Then use the **single-use link printed in the console** (plain `http://localhost:4321` is refused, see *Access control* below), or let it open a private window for you:

```bash
npm start -- --open            # first of edge / chrome / brave / chromium / firefox it finds
npm start -- --open=edge       # pick one (use a different browser from the one you're editing)
```

Chromium-based browsers get a separate throw-away profile (`--shared-profile` turns that off), so
this window doesn't keep your real profile's files locked. You still need to close the browser you're
*editing*.

> `better-sqlite3` and `classic-level` compile native bindings on install — you'll need a
> C/C++ toolchain available (Xcode CLT on macOS, build-essential on Linux, or
> windows-build-tools/Visual Studio Build Tools on Windows). If install fails because of
> that, it's a one-time local toolchain issue, not a bug in the app.

## Using it

1. Pick a browser and a profile, click **Scan**.
2. Pick a site on the left to see its cookies / localStorage / cache.
3. **Copy** copies a value to your clipboard. **Save** edits a value in place.
   **Delete** removes the entry.

### Closing the browser you're editing

The bar under the header shows whether the selected browser is running.

- **Browser differs from the one this page is open in:** an **End <browser> task** button force-closes
  all its windows and background processes (like Task Manager's End Task), then the bar turns green.
- **Same browser:** closing it would close this page, so on Scan you get a popup with a button per other
  browser installed on the PC. Pick one and the app opens there (private window, same browser/profile
  selected, auto-scan), then the old browser is ended. "Stay here (read-only)" skips it; reading still
  works, saving will just report that the files are locked.

### Access control (who can reach it)

This tool can read and edit your cookies and end processes, so access is locked down in layers:

1. **Bound to `127.0.0.1` only** - other computers on your network can't open a connection at all (the server
   refuses to start if it ends up bound anywhere else).
2. **Loopback sockets only, exact `Host` and `Origin` checks** - blocks DNS-rebinding and other websites.
3. **Per-launch secret.** On every start the server makes a random 256-bit session secret. Your browser gets it
   via a **single-use link** (valid 10 minutes) that is swapped for an HttpOnly, SameSite=Strict cookie.
   Without that cookie *every* request (pages and API) gets 401, so other Windows users or programs on this
   PC can't use it either. Restart the server for a new link.
4. Writes / process-kills also need the `X-BDM` header.

Anything running as *you* with full access to your files (malware, or an admin on the machine) can still read your
browser profile directly - no local tool can prevent that.

### Finding a site

Use the search box above the site list (press `/` to focus it, `Esc` to clear, `↑ ↓` + `Enter` to
pick a result). Multiple words must all match. The chips filter to sites that have cookies,
storage or cache, and you can sort by amount of data or hide extension entries. A site's cookies
(`google.com`), localStorage (`https://www.google.com`) and cache are merged into one row.

### Site icons

Each site in the list shows its favicon. The icon comes from the browser's own saved icons
(Chromium's `Favicons` file / Firefox's `favicons.sqlite`), which is offline and is the same icon you see
on your tabs. If the browser has none for a site and **Download missing icons from the sites** is ticked, the
server asks the site itself (its `<link rel="icon">`, then `/favicon.ico`) and caches the result, including
"no icon", in `.icon-cache/` (delete that folder to reset). Only public hostnames are contacted — never IP
addresses, `localhost`, single-word or `.local` names — and redirects are re-checked. Untick the box to stay
fully offline. Sites without any icon show a coloured letter.

### Export

**Export…** (header, next to Save all) downloads a JSON file. Under *Sites* choose the current site, **Choose
sites…** (a searchable checklist, so any handful of sites), every site in the current search/filter, or all sites.
Under *What to export* tick **Everything** or any of Cookies / Local storage / Cache. Cache is exported as a
listing only (matched URL, size, date), since the cached files themselves are opaque binary data. The file is
grouped by site and contains cookie and token values in plain text, so keep it private. It reflects what is
saved in the browser's files, not unsaved edits in the UI.

### Save all and Run

Edits to cookies and localStorage are tracked across tabs and sites: edited rows get an orange marker, the site
gets an orange dot in the list, and the header shows **Save all (n)** (also `Ctrl/Cmd+Shift+S`). It writes every
pending edit in one go and reports a single summary.

**▶ Run** (next to Save all, for the selected site) does the whole round trip: it ends the browser if it's running
(after asking), saves all pending edits, then starts that browser on the edited profile and opens the site, so it
loads with your edited cookies and storage. If this page is open in the same browser you're editing, Run offers to
switch browsers first, since restarting it would close this page. After Run the browser holds the profile open again,
so close it again before editing further.

### Editing localStorage

Each key is a collapsible card; click it to edit. JSON values open in a **Tree** editor (edit
keys/values inline, change types, add/remove entries, expand/collapse all) with a **Text** mode
for raw editing (live validation, Format / Minify). JSON that is stored *inside* a string is
detected and edited as a tree too, then written back as a string. Numbers JavaScript can't represent
exactly (20-digit IDs, very long decimals) are swapped for a placeholder while editing and written
back with their original digits, so they are never corrupted.
`Ctrl/Cmd+S` saves. The filter box above the list searches keys and values.

**Close the target browser before editing or deleting.** On Windows, Chrome/Edge often keep running
in the background after the last window closes — if you get a "browser still has this profile open"
message, check Task Manager (or the tray icon) and fully quit it. If you launched the UI with
`--open=chrome` while editing *Chrome's* data, killing every `chrome.exe` also closes the UI window;
use `--open=edge` (or just open http://localhost:4321 in Edge) when editing Chrome, and vice versa. SQLite needs exclusive write
access to the cookie/localStorage databases; while the browser is running those files
are often locked (Chromium in particular keeps them open). Reading/scanning works fine
with the browser open since it's done from a snapshot copy.

## How each data type is handled, and its limitations

- **Cookies** — read directly from each browser's `Cookies` / `cookies.sqlite` file.
  Chromium encrypts cookie values at rest; this tool decrypts them using the same
  approach Chromium itself uses (DPAPI on Windows via a PowerShell call, Keychain-derived
  key on macOS, the default fixed-password derivation on Linux). On Linux, if your
  distro has Chromium's cookies protected by a real keyring/kwallet secret rather than
  the default password, decryption will fail gracefully and the value shows as
  `[encrypted]`. Firefox cookies are stored unencrypted and read straight from
  `cookies.sqlite`.

- **localStorage** — Chromium stores this in a LevelDB database
  (`Local Storage/leveldb`); this tool parses its key/value layout heuristically
  (it's an internal, version-dependent format, reverse-engineered rather than
  officially documented), so a small fraction of entries may not decode cleanly across
  very old/new Chrome versions. Firefox (modern "LSNG" storage) is read from each
  origin's `storage/default/<origin>/ls/data.sqlite`, which is a documented SQLite
  schema and reads reliably.

- **Cache** — browser disk caches (Chromium Simple Cache, Firefox cache2) are opaque,
  version-specific binary formats with no stable public schema. This tool does **not**
  fully parse cache entries; instead it lists the raw cache files with size/modified
  time and tries to recover the original URL by scanning each file for an embedded
  `http(s)://` string, which works for a useful fraction of entries but not all.
  Deleting a file evicts that cache entry even when the tool can't label its URL.

## Project layout

```
server.js              Express app / REST API
lib/browserPaths.js     Locate installed browsers + their profiles (per OS)
lib/decrypt.js          Chromium cookie value decryption
lib/cookies.js           Cookie read/write for Chromium + Firefox
lib/localStorage.js      localStorage read/write for Chromium (leveldb) + Firefox (sqlite)
lib/cache.js             Best-effort cache listing/deletion
lib/favicons.js          Site icons: browser icon DB, optional safe download, disk cache
lib/openUi.js            Open this UI / open a site in a browser profile (Run)
public/                  Frontend (vanilla HTML/CSS/JS, no build step)
```

## Safety notes

- This only touches files under your own OS user profile. The only outgoing network requests are the optional
  icon downloads described above (off with one checkbox); everything else is served locally on 127.0.0.1.
- Back up a profile before bulk-editing if it matters to you — writes go straight to
  the real database files.
