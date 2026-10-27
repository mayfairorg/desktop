# Mayfair Desktop

Mayfair Cloud in its own window. The window shows Mayfair edge to edge, with no bar of its own. The Browser is an app inside Mayfair (its tabs, address bar and panes are drawn by Mayfair Cloud in the Mayfair skin); this program supplies the real web pages for it, so you never need another browser.
Windows, macOS and Linux. Built with Electron.

This folder is standalone. It does not touch the Mayfair web app or server code.

## 1. Run it (beginner steps)

1. Install Node.js 20 or newer from https://nodejs.org (the "LTS" button).
2. Open a terminal in this folder and run:

```
npm install
npm start
```

`npm install` downloads Electron (about 100 MB) and the other packages. `npm start` opens the app.

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | Runs the unit tests (no Electron needed). |
| `npm run smoke` | Starts the real app under a virtual screen (Linux, needs `xvfb`) with a stand-in Mayfair Cloud page that plays the Browser app, and runs 141 checks, saving screenshots to `/tmp/mf-smoke`. |
| `npm run packaged-check` | Packs the protected build into a real `app.asar`, flips the Electron fuses (the production set, the stock set, a changed copy, and two controls), starts each like an installed app and checks every page loaded with `file://` from the asar. Linux, needs `xvfb`, `openssl` and an Electron folder (`.electron-dl/dist` or pass a path). |
| `npm run fetch-lists` | Downloads the ad-blocker filter lists into `assets/filters/` (run before building installers). |
| `npm run update-rates` | Refreshes the currency table from the European Central Bank. |
| `node tools/fetch-tor.js linux x64 <version>` | Downloads the Tor daemon (see Privacy). |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Builds an installer for that system, on that system. |

Running as root on Linux (some servers and containers): Electron needs `--no-sandbox`. The smoke test does this for you.

## 2. What is in it

**The Mayfair view.** One full-size view that opens https://cloud.mayfairmail.com edge to edge (kiosk style; turn it off in Settings to open in a window). There is no tab strip, toolbar or overlay panel in the window. Remembers window size and position (moved back on screen if a monitor is gone). One copy only (a second launch focuses the first). Launch at login, system tray, close-to-tray, native notifications, `mayfair://` links, and file handling for docx xlsx pptx pdf csv md txt and images.

**Browser tabs (for the Browser app in Mayfair).** The Browser app is a normal Mayfair window drawn by Mayfair Cloud. Only the page itself is native: this app keeps one view per browser tab and puts the active one exactly over the Browser window's content area (the Cloud page reports that rectangle with `setBounds`, in CSS pixels; this app converts them with the Mayfair view's zoom factor). A native view always draws above web content, so when anything of Mayfair overlaps that area (another window, the Start menu, a menu, a dialog, a toast, a window being dragged, the Browser minimised or on another desktop) the Cloud page calls `setOccluded(true)`: the view is hidden after taking a picture of the page (`capture()`, JPEG), the Cloud page paints that picture into the content area, and `setOccluded(false)` shows the live page again. Tabs, address bar logic (URL or search), back/forward/reload, HTTPS state, bookmarks, history, find in page, zoom per site, pop-up blocking, permission prompts with per-site memory, downloads (into your Mayfair Drive folder, a folder you pick, or ask each time), private tabs, pinned and muted tabs, reopen closed tab, session restore, HTML5 full screen, ad blocker, secure DNS, leak protection, Tor tabs, Web apps, extensions and a password-fill hook for Mayfair Passwords are all available to the Cloud page through `window.mayfairDesktop.browser` (section 9b). In the web build of Cloud the bridge does not exist and the Browser app shows "Get Mayfair Desktop".

**Mayfair Search** (the page a new tab shows, inside the tab content; also the address-bar default). One box. Search goes to the results page of the engine you pick (DuckDuckGo by default; Brave, Google, Bing, Startpage, Ecosia, Qwant). Mayfair never scrapes or proxies results. On this device it adds: your bookmarks and history first, your Mayfair files/notes/contacts (when the Cloud answers), a calculator, unit conversion, currency (offline table, always shown with its date), time zones, and command shortcuts ("open finance", "new note", "invoice Acme"). Weather (Open-Meteo), definitions (Free Dictionary API) and Wikipedia summaries run only when you type `weather ...`, `define ...` or `wiki ...`, and send only that word or place. Suggestions come from your own bookmarks and history only.

**Web apps** (Ctrl+Shift+A in a browser tab, or from the Browser app). A JSON-driven catalogue of 36 popular sites (`src/main/lib/webapps.json`; add your own in `webapps-custom.json` inside the app data folder). Each app opens in its own tab or its own window with its own saved sign-in (its own session), shows an unread count when the site puts one in its window title, can raise a native notification when that count goes up, can be pinned (tray menu, macOS Dock menu, Windows jump list, and listed to the Cloud page), can get a desktop shortcut (Windows, Linux), and can be signed out or removed. Plain names and one neutral glyph per category; no third-party logos. Nothing on the sites is scraped or modified: the only thing read is the window title.

**Synced history and form details.** With `historySync` on (default) the Browser reports new history entries, typed web searches and deletions to the Mayfair page (`history-add`, `history-remove`, `history-clear`) so they can be kept on your Mayfair ID (deleted ones for 30 days); `history.import` restores them on a new install. Private and Tor tabs never report anything. When you submit a form, the email, username, name, phone and address fields (never passwords, cards, ID numbers or codes) can be offered to the Mayfair ID (`autofill-offer`, memory only, off with `autofillSave`).

**Web app history** is kept per app (`history-app-<id>.json` in the app data folder) and never appears in the browser's history, address-bar suggestions or bookmarks; Reset, Remove and Clear browsing data with Web apps ticked clear it. `webapps.match(url)` tells the Cloud which catalogue app a web address belongs to, so it can open the installed app instead of a browser tab.

**Stay signed in.** Signing in to a web app keeps you signed in across restarts, reboots and updates. Each app has its own persistent session in the app data folder; nothing clears it except you (Reset this web app, Remove, or Clear browsing data with Web apps ticked). Sign-in cookies that a site would normally drop when the browser closes are kept for 400 days (the longest Chromium allows), cookies due to expire within 90 days are pushed out again each time you open the app and once a day while the app runs, and the session is written to disk a few seconds after changes and when you quit, so a crash or power cut keeps the login. Limits: a site can still sign you out on its side (password change, security check, session limit, inactivity rules), and the 400-day cap is renewed only by use. Only Web app sessions are treated this way, never normal, private or Tor tabs. A catalogue entry may list `authHosts` (sign-in hosts such as accounts.google.com) that stay inside the app window.

**Privacy** (Ctrl+Shift+P in a browser tab, or from the Browser app). Private tab with Tor, secure DNS, leak protection, your own proxy. See section 5.

**Ad blocker.** See section 6.

## 3. Security

- `contextIsolation` on, `sandbox` on, no `nodeIntegration`, `webSecurity` on, no `webview`. Checked by a test that fails if anyone weakens it.
- IPC is an allow-list (`src/main/lib/ipc-allowlist.js`): every channel names which kind of page may call it and its argument shapes. Only the Mayfair view, only its main frame and only on a Mayfair origin gets the bridge (`window.mayfairDesktop`, including `.browser`); every call is checked again in main (sender, channel, argument types and sizes). Ordinary websites get nothing; the start page gets only its own search calls. There is no other interface window with IPC any more.
- The Mayfair view can only stay on `cloud.mayfairmail.com` or `mayfairmail.com` over HTTPS. Any other address is sent to the Cloud page as an `open-url` event for the Browser app (or the system browser when nothing listens). `mailto:`/`tel:` go to the system; `javascript:`, `file:` and `data:` are refused.
- No certificate-error overrides. Site CSP headers are never rewritten.
- No telemetry: Chromium background services are switched off (see "what was verified"). The only requests the app makes of its own accord are to Mayfair, the pages you open, filter-list updates, the update feed, and the three answer services when you type their prefixes.

## 3b. Code protection (what it does and does not do)

Nothing that runs on a person's computer can be made impossible to copy. These steps make casual copying and editing hard, make changes visible, and make the legal position clear. All free, nothing that changes how the app works.

- **Protected build.** `npm run dist:*` first runs `node tools/gen-notices.js` and `node tools/protect.js`, which write `build-protected/` (comments and whitespace removed from every .js, copyright banner, no source maps) and the installer is made from that folder, not from `src/`.
- **Integrity check.** `protect.js` writes `integrity.json` (SHA-256 of every file under `src/` and of `package.json`). An installed app checks it at start-up. If a file was changed, removed or added, the Mayfair view shows "This copy of Mayfair Desktop has been changed" and never opens Mayfair Cloud. A person who edits files and also rewrites `integrity.json` defeats this check, which is why the Electron fuses below also check the asar itself, and why code signing matters.
- **Electron fuses** (set by `tools/after-pack.js` with `@electron/fuses`, before signing): RunAsNode off, NODE_OPTIONS off, `--inspect` off, embedded asar integrity validation on, only load the app from the asar, (file:// extra privileges stay ON: switching them off makes the app's own pages loaded from the asar (start page, error page, changed-copy page) draw unstyled, with `style-src 'self'` no longer matching; `npm run packaged-check` shows this with a negative control and runs the whole production fuse set together against a real asar). The build fails if `@electron/fuses` is missing (developer override: `MAYFAIR_ALLOW_UNFUSED=1`). Asar integrity is enforced by Electron on macOS and Windows only, not Linux.
- **No developer tools or view-source on the Mayfair view** in an installed build (F12, Ctrl/Cmd+Shift+I/J/C, Ctrl/Cmd+U, the menu and "Inspect" are gone, `view-source:` is refused). Owner switch: start the app with `MAYFAIR_DESKTOP_DEVTOOLS=1`. Running from source (`npm start`) always has them. Browser tabs (ordinary websites) keep the normal tools when the switch is on; `devtools(id)` on the bridge is refused otherwise.
- **bytenode (V8 bytecode) is not used.** It needs the exact Electron binary for every platform and architecture, it is not available offline here (npm is blocked), bytecode can be decompiled and keeps all strings, and it would hide only a browser shell: the proprietary Mayfair Cloud code is not in this app, it is loaded from the server. The cost (a build that breaks on every Electron update, harder crash reports) is more than the gain.
- **Code signing** is left as an owner option (Apple Developer ID and a Windows certificate cost money; Linux needs none). Without it, macOS and Windows warn on first run, and the asar fuse cannot stop someone re-signing a modified app.
- **Licence and notices.** `LICENSE.txt` (all rights reserved, no copying, reverse engineering or redistribution; open source parts keep their own licences) and `THIRD_PARTY_NOTICES.txt` (generated from `legal/third-party.json`: Electron, Chromium, Node, Tor, Ghostery, electron-updater, EasyList and uBlock filters) are shipped in the app's `licenses` folder and shown in About and licences.

## 4. Update and download hosts

Auto-update uses `electron-updater` with a generic feed. The URL in `package.json` (`build.publish[0].url`) is a placeholder, so updating stays off until you replace it (or set `MAYFAIR_UPDATE_URL`). Upload the installers and the `latest*.yml` files the build produces to that address.

## 5. Privacy panel: what each switch really does

- **Secure DNS** (Cloudflare 1.1.1.1 or Quad9; Encrypted Client Hello where the site supports it, takes effect after restart). It encrypts name lookups. **It is not a VPN and does not hide your IP address.** Only the Tor tab or a proxy changes the address sites see.
- **Private tab with Tor** (Ctrl+Alt+T). Runs the open-source `tor` program on your computer and sends that tab through it, in its own in-memory session; nothing is saved; there is a clear "Tor" mark on the tab (the Browser app shows it) and a "New identity" button. It is slow and some sites block Tor. It is **not Tor Browser** and hides less. The tab is never opened unless Tor reports 100%, and never falls back to a direct connection. Licence and attribution: `assets/licenses/TOR-NOTICE.txt` (BSD 3-clause; shipped next to the app).
- **Leak protection.** WebRTC is set to `disable_non_proxied_udp` in browser and private tabs (Tor tabs always); Mayfair and Web apps are exempt so video calls keep working; you can relax it. Optional standard time zone and language (UTC, English US) and reduced fingerprinting apply to new tabs (always for Tor). Reduced fingerprinting narrows a few values; it does not make you anonymous.
- **Your own proxy** (HTTP or SOCKS5, no login support yet). Used by browser tabs, private tabs and Web apps. Mayfair connects directly. Tor never goes through it.
- Using Tor, a proxy or secure DNS to get around the rules of a school or workplace network can break those rules. The panel says so.

## 6. Ad blocker

On by default in browser, private and Tor tabs, and in Web apps marked for it (YouTube, Twitch). Per-site off switch (Site settings) and an allow-list, and a blocked-items counter per tab. It uses `@ghostery/adblocker-electron` (MPL-2.0) with EasyList, EasyPrivacy and the uBlock filter lists (filters, badware, privacy, quick fixes, unbreak, annoyances): network filters, cosmetic filters and scriptlets. It does not use the browser-extension system, so it works with zero extensions. Lists are bundled into the installer (`npm run fetch-lists`) and refreshed every 3 days from their public addresses (plain downloads, nothing sent about you). Licences and credits are on the About page (Menu, About and licences).

Honest limits: blocking ads, and especially video ads, is cat-and-mouse. Sites change and some detect blockers, so some ads will get through and some sites will ask you to turn the blocker off. If the Ghostery library or the lists are missing, the app falls back to a small built-in list of about 65 tracker domains and the About page says "Basic blocker".

## 7. DRM video (Netflix, Disney+, Spotify playback)

Stock Electron does not include Widevine. Verified here: in the running app `navigator.requestMediaKeySystemAccess('com.widevine.alpha', ...)` was rejected with `NotSupportedError: Unsupported keySystem or supportedConfigurations`, and no `libwidevinecdm` file ships next to the Electron binary. So these sites are marked "Video playback may not work here" in the catalogue and probably will not play. Getting Widevine means using a Widevine-enabled Electron build (for example the Castlabs "Electron for Content Security" fork) and a Widevine licence agreement with Google; that is not free, so it is not done.

## 8. What the owner must supply (to-do list)

1. **Update host**: somewhere to put installers and `latest*.yml` (any static HTTPS host). Put its URL in `package.json` under `build.publish[0].url`.
2. **Apple Developer ID** (paid, Apple Developer Program) for signing and notarising the macOS app. In GitHub secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK` (the .p12, base64), `CSC_KEY_PASSWORD`. Without it macOS shows "unidentified developer".
3. **Windows code-signing certificate** (paid, from a certificate authority). Secrets `WIN_CSC_LINK` (.pfx base64) and `WIN_CSC_PASSWORD`. Without it Windows SmartScreen warns on install.
4. Uncomment the signing lines in `.github/workflows/build.yml` after adding the secrets.
5. Tor is fetched automatically: CI asks the Tor Project for the current release, checks the checksum and signature, and bundles the Tor daemon. Nothing to set up. (Optional: repository variable `TOR_BUNDLE_VERSION` pins a version.)
6. Run `npm install` once locally and commit `package-lock.json`; then change `npm install` to `npm ci` in the workflow.
7. Tell the web app team the bridge contract (section 9).
8. Decide about Widevine (section 7).
9. Check the filter-list URLs still exist (the uBlock "annoyances" list has been renamed before). `npm run fetch-lists` reports any that fail.

Run the workflow from the GitHub "Actions" tab ("Build Mayfair Desktop", Run workflow), or push a tag like `v0.1.0`. It builds Windows (NSIS), macOS (dmg, Intel and Apple silicon) and Linux (AppImage and deb), all unsigned until step 4.

## 9. Contract with the Mayfair web app (`window.mayfairDesktop`, only on the Mayfair origins)

The Browser bridge, `window.mayfairDesktop.browser`, is described in section 9b.

```
isDesktop, info(), notify({title, body, url?, tag?}), setBadge(n), openBrowser(url)
onFile(cb) + readFile(token)        files opened with the app or downloaded into Drive
onDeepLink(cb)                      mayfair://open/finance, mayfair://new/note, mayfair://new/invoice?name=Acme
onDownload(cb)
apps.list(), apps.open(id)          Web apps the user pinned
search.onQuery(cb) + search.respond(id, [{kind, title, subtitle, link}])   files/notes/contacts for Mayfair Search
passwords.onRequest(cb) + passwords.respond(id, [{username, password}])    Mayfair Passwords autofill
installExtension(id, url, sha256) -> {ok, id, version} | {ok:false, error}
removeExtension(id) -> bool        listExtensions() -> [{id, version, enabled, native?}]
```

Passwords also speaks the extension page contract on the Mayfair view: the page receives `window.postMessage({mayfair:1, v:1, type:'mf.pw.request', id, payload:{origin, host}})` and answers `{type:'mf.pw.credentials', id, payload:{id, credentials:[{username, password}]}}`. Post `{type:'mf.pw.listening'}` once Mayfair Passwords is open. The reply is only delivered to the tab that asked, and only if its address is still the same secure origin.

### 9b. The Browser bridge (`window.mayfairDesktop.browser`)

The full list of calls and events, their argument shapes and the occlusion rules are in `audit/browser-bridge-contract.md` (kept next to the Cloud code that uses them). In short:

```
ready()  setBounds({x,y,w,h,visible})  setOccluded(bool)  capture() -> JPEG data URL  focus(id)
newTab({url?,private?,tor?,webapp?,background?}) closeTab activate move duplicate pin mute closeOthers reopenClosed
go(id,text) back forward reload stop home() suggest(text)
find stopFind zoom print savePage devtools(only when allowed) fullscreen(false) windowFullscreen fillPassword
bookmarks.*  history.*  downloads.*  settings.{get,set,setProxy,pickFolder,clearBrowsingData}
permissions.{list,site,set,reset,answer}  popups.allow  webapps.*  tor.*  adblock.*  extensions.*  about()
on(event, cb) -> off     state, find-result, download, permission-request, permission-cancel, new-window-request,
                         open-url, fullscreen, menu, panel-request, notice, tor, focus
```

The same names are listed in three places that a test keeps equal: the allow-list (`src/main/lib/ipc-allowlist.js`), the preload (`src/preload/web.js`) and the handlers (`src/main/browser-service.js`).

### Extensions (the nine Mayfair extensions)

`installExtension` accepts only `https://cloud.mayfairmail.com/ext/<file>.zip` (no query, no other host), downloads at most 8 MB, checks the SHA-256, unpacks with a zip reader that refuses `..`, absolute paths, encrypted or oversized archives, requires a Manifest V3 manifest (no `nativeMessaging`, `debugger`, `proxy`, `management`, `update_url` and similar), and keeps it in the app data folder. Installed extensions load into the normal browser session only (not Mayfair, Web apps, private or Tor tabs).

- Tracker blocker: Electron has no `declarativeNetRequest`, so its `rules/trackers.json` is read and applied natively to the basic blocker. When the full ad blocker is active it already covers those hosts, so they are not added twice and not counted twice.
- Passwords: handled by the app (the extension looks for a Mayfair page, and the Mayfair view is in a separate session), through the page contract above and `fillPassword(id)` on the Browser bridge. It is recorded as installed with `native: "bridge"` and not loaded into Chromium.
- The other seven (deals, clipper, reader, dark, tabsaver, screenshot, translate) load, but Electron's extension support is partial. Verified by running: loading shows `Permission 'contextMenus' is unknown` and `Permission 'notifications' is unknown`, and the background workers of some fail with `Service worker registration failed`, `Cannot read properties of undefined (reading 'onClicked')` and `(reading 'onCommand')`. So right-click menus, keyboard commands and notifications from those extensions will not work in the desktop app; content scripts and popups may. Which extension features work was not tested page by page.
- The download page link used by Cloud is https://mayfairmail.com/desktop.

Web Push does not work in Electron (there is no Google push service in it). Native notifications come from `notify()`: the web app should call it when its own live connection receives an event. Deep links also set `#mf=<encoded path>` on the Cloud URL.

## 10. What was verified, and what was not

Verified by running (Linux, Xvfb, Electron 38): `npm test` (123 tests), the 141-check smoke run against a stand-in Cloud page (one full-size Mayfair view and nothing else, the bridge, setBounds with zoom conversion and window moves, occlusion with a real picture, tabs, pin, move, duplicate, mute, reopen, go/search, back/forward, find, zoom, bookmarks, history, settings, own proxy, permission and pop-up events, downloads, HTML5 full screen, `open-url`, deep links, menu and key shortcuts from a page tab, Web apps, Tor start/stop, crash page, extensions, session restore), and `npm run packaged-check` (real asar, production fuse set together, stock set, changed copy, file privileges off as a negative control, loose folder refused). The earlier 83-check list covered: launch, pinned tab, offline page, navigation lock, IPC lockdown, tabs, bookmarks, history, private tab, downloads into the Drive folder, pop-up blocking, permission prompts, find in page, Web apps open/badge/reset/remove/window, WebRTC policy, standard locale and reduced fingerprint, own proxy, Tor tab against a stand-in `tor` program, Mayfair Search answers and commands, start page at 390, 1280 and 2560 pixels in dark and light). Screenshots from that run were looked at and fixed.

Could not be done here, and why:

- **`npm install` fails**: `registry.npmjs.org` is blocked by this sandbox (`ENOTFOUND` direct, `403 CONNECT` through the proxy). I fetched the Electron binary straight from GitHub releases instead. As a result `electron-builder` and `electron-updater` were never installed or run, so the installers were never built and the electron-builder config is untested.
- **Tor**: every Tor Project host (`dist.torproject.org`, `archive.torproject.org`, `www.torproject.org`, `deb.torproject.org`) returns `403 CONNECT` here, and `fetch-tor.js` fails with `getaddrinfo ENOTFOUND archive.torproject.org`. The manager (start, progress, new identity, stop, clean-up, crash and timeout) was tested against a stand-in program, not the real `tor`. Real bootstrap is untested.
- **Ghostery ad blocker and the lists**: the package could not be installed and `easylist.to`, `ublockorigin.github.io` and `cdn.jsdelivr.net` are blocked here. The engine wrapper, list updates, per-site exceptions and fallback are unit-tested against a fake library; real blocking, cosmetic filters, scriptlets and YouTube ads are untested. The package version (`^2.0.0`) and the scriptlet resource URL are unconfirmed.
- **Secure DNS / ECH**: switches are applied, but no live lookup could be observed (no network).
- **Weather, definitions, Wikipedia** and the ECB rate refresh: parsers tested on sample data, live calls untested.
- **Windows and macOS**: nothing run. Tray, jump list, Dock menu, login item, desktop shortcut on those systems are untested.
- **Mayfair Cloud itself** is unreachable from this sandbox (`403 CONNECT`). The bridge was tested against a stand-in page (`tools/smoke-cloud.html`) served for the Mayfair address inside the app's own session, not against the real Cloud Browser app. `savePage`, `print`, `pickFolder` (native dialogs), the real Tor program, Windows and macOS, and a real multi-monitor or high-DPI screen were not run.
- **Chromium background traffic**: I watched the sandbox proxy log during the smoke runs. The only unexplained connection was `redirector.gvt1.com` (a Google host) at start-up: Electron downloads spell-check dictionaries there on Windows and Linux, even with `--disable-background-networking` and `--disable-component-update` (tested: still one hit with each). Fix: spell check is switched off outside macOS and the dictionary URL points to a dead local port (a stand-alone test showed 0 hits afterwards). Other hosts seen were only Mayfair, the filter-list hosts and the pages the test opened. This is a log of refused connections from one machine, not a guarantee for every platform.
- The currency table is an approximate bundled sample dated 2026-10-01; `npm run update-rates` replaces it with real ECB rates.
- The address bar is drawn by the Browser app in Mayfair Cloud. This app supplies the logic (`go(id,text)`: address or search with your engine, command shortcuts) and `suggest(text)` (your bookmarks and history, no network).
- Video-site sign-in pop-ups that need `window.opener` (for example "Sign in with Google" popups) are loaded in the same tab instead and may not complete.

## 11. Folder map

```
src/main/main.js         start-up, single instance, tray, menus, login item, updater
src/main/browser-service.js  BrowserService: window, the Mayfair view, tab views, bounds, occlusion, capture, state events, bridge handlers, sessions, downloads, permissions, Web apps, privacy, search
src/main/lib/            pure logic with unit tests (origins, stores, ipc allow-list, privacy, tor, webapps, adblock engine, ...)
src/preload/             web.js (Mayfair bridge and Browser bridge), page.js (websites + start page)
src/ui/                  pages shown inside tab content: Mayfair Search start page, error page, changed-copy page
tools/                   icons, smoke test (+ smoke-cloud.html stand-in Cloud page), packaged-check (asar + fuses), Tor / filter-list / rate fetchers
test/                    node:test suites
```
