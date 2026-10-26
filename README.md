# Mayfair Desktop

Mayfair Cloud in its own window, with a built-in browser, so you never need another browser.
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
| `npm run smoke` | Starts the real app under a virtual screen (Linux, needs `xvfb`) and runs 83 checks, saving screenshots to `/tmp/mf-smoke`. |
| `npm run fetch-lists` | Downloads the ad-blocker filter lists into `assets/filters/` (run before building installers). |
| `npm run update-rates` | Refreshes the currency table from the European Central Bank. |
| `node tools/fetch-tor.js linux x64 <version>` | Downloads the Tor daemon (see Privacy). |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Builds an installer for that system, on that system. |

Running as root on Linux (some servers and containers): Electron needs `--no-sandbox`. The smoke test does this for you.

## 2. What is in it

**Mayfair tab (tab 0, pinned).** Opens https://cloud.mayfairmail.com full screen (kiosk style; turn it off in Settings to open in a window). Remembers window size and position (moved back on screen if a monitor is gone). One copy only (a second launch focuses the first). Launch at login, system tray, close-to-tray, native notifications, `mayfair://` links, and file handling for docx xlsx pptx pdf csv md txt and images.

**Built-in browser.** Tabs for any site, address bar with search, back/forward/reload, HTTPS indicator, bookmarks (and bar), history, find in page, zoom per site, pop-up blocking, permission prompts with per-site memory, downloads (into your Mayfair Drive folder, a folder you pick, or ask each time), private tabs, and a password-fill hook for Mayfair Passwords.

**Mayfair Search** (new-tab page and address-bar default). One box. Search goes to the results page of the engine you pick (DuckDuckGo by default; Brave, Google, Bing, Startpage, Ecosia, Qwant). Mayfair never scrapes or proxies results. On this device it adds: your bookmarks and history first, your Mayfair files/notes/contacts (when the Cloud answers), a calculator, unit conversion, currency (offline table, always shown with its date), time zones, and command shortcuts ("open finance", "new note", "invoice Acme"). Weather (Open-Meteo), definitions (Free Dictionary API) and Wikipedia summaries run only when you type `weather ...`, `define ...` or `wiki ...`, and send only that word or place. Suggestions come from your own bookmarks and history only.

**Web apps** (Ctrl+Shift+A). A JSON-driven catalogue of 36 popular sites (`src/main/lib/webapps.json`; add your own in `webapps-custom.json` inside the app data folder). Each app opens in its own tab or its own window with its own saved sign-in (its own session), shows an unread count when the site puts one in its window title, can raise a native notification when that count goes up, can be pinned (tray menu, macOS Dock menu, Windows jump list, and listed to the Cloud page), can get a desktop shortcut (Windows, Linux), and can be signed out or removed. Plain names and one neutral glyph per category; no third-party logos. Nothing on the sites is scraped or modified: the only thing read is the window title.

**Privacy** (Ctrl+Shift+P). Private tab with Tor, secure DNS, leak protection, your own proxy. See section 5.

**Ad blocker.** See section 6.

## 3. Security

- `contextIsolation` on, `sandbox` on, no `nodeIntegration`, `webSecurity` on, no `webview`. Checked by a test that fails if anyone weakens it.
- IPC is an allow-list (`src/main/lib/ipc-allowlist.js`): every channel names which kind of page may call it and its argument shapes. Mayfair-origin pages get a tiny bridge (`window.mayfairDesktop`); ordinary websites get nothing; the start page gets only its own search calls.
- The Mayfair tab can only stay on `cloud.mayfairmail.com` or `mayfairmail.com` over HTTPS. Any other address opens as a new browser tab. `mailto:`/`tel:` go to the system; `javascript:`, `file:` and `data:` are refused.
- No certificate-error overrides. Site CSP headers are never rewritten.
- No telemetry: Chromium background services are switched off (see "what was verified"). The only requests the app makes of its own accord are to Mayfair, the pages you open, filter-list updates, the update feed, and the three answer services when you type their prefixes.

## 3b. Code protection (what it does and does not do)

Nothing that runs on a person's computer can be made impossible to copy. These steps make casual copying and editing hard, make changes visible, and make the legal position clear. All free, nothing that changes how the app works.

- **Protected build.** `npm run dist:*` first runs `node tools/gen-notices.js` and `node tools/protect.js`, which write `build-protected/` (comments and whitespace removed from every .js, copyright banner, no source maps) and the installer is made from that folder, not from `src/`.
- **Integrity check.** `protect.js` writes `integrity.json` (SHA-256 of every file under `src/` and of `package.json`). An installed app checks it at start-up. If a file was changed, removed or added, the Mayfair tab shows "This copy of Mayfair Desktop has been changed" and never opens Mayfair Cloud. A person who edits files and also rewrites `integrity.json` defeats this check, which is why the Electron fuses below also check the asar itself, and why code signing matters.
- **Electron fuses** (set by `tools/after-pack.js` with `@electron/fuses`, before signing): RunAsNode off, NODE_OPTIONS off, `--inspect` off, embedded asar integrity validation on, only load the app from the asar, file:// extra privileges off. The build fails if `@electron/fuses` is missing (developer override: `MAYFAIR_ALLOW_UNFUSED=1`). Asar integrity is enforced by Electron on macOS and Windows only, not Linux.
- **No developer tools or view-source on the Mayfair tab** in an installed build (F12, Ctrl/Cmd+Shift+I/J/C, Ctrl/Cmd+U, the menu and "Inspect" are gone, `view-source:` is refused). Owner switch: start the app with `MAYFAIR_DESKTOP_DEVTOOLS=1`. Running from source (`npm start`) always has them. Other tabs (ordinary websites) keep the normal tools.
- **bytenode (V8 bytecode) is not used.** It needs the exact Electron binary for every platform and architecture, it is not available offline here (npm is blocked), bytecode can be decompiled and keeps all strings, and it would hide only a browser shell: the proprietary Mayfair Cloud code is not in this app, it is loaded from the server. The cost (a build that breaks on every Electron update, harder crash reports) is more than the gain.
- **Code signing** is left as an owner option (Apple Developer ID and a Windows certificate cost money; Linux needs none). Without it, macOS and Windows warn on first run, and the asar fuse cannot stop someone re-signing a modified app.
- **Licence and notices.** `LICENSE.txt` (all rights reserved, no copying, reverse engineering or redistribution; open source parts keep their own licences) and `THIRD_PARTY_NOTICES.txt` (generated from `legal/third-party.json`: Electron, Chromium, Node, Tor, Ghostery, electron-updater, EasyList and uBlock filters) are shipped in the app's `licenses` folder and shown in About and licences.

## 4. Update and download hosts

Auto-update uses `electron-updater` with a generic feed. The URL in `package.json` (`build.publish[0].url`) is a placeholder, so updating stays off until you replace it (or set `MAYFAIR_UPDATE_URL`). Upload the installers and the `latest*.yml` files the build produces to that address.

## 5. Privacy panel: what each switch really does

- **Secure DNS** (Cloudflare 1.1.1.1 or Quad9; Encrypted Client Hello where the site supports it, takes effect after restart). It encrypts name lookups. **It is not a VPN and does not hide your IP address.** Only the Tor tab or a proxy changes the address sites see.
- **Private tab with Tor** (Ctrl+Alt+T). Runs the open-source `tor` program on your computer and sends that tab through it, in its own in-memory session; nothing is saved; there is a clear "Tor" mark on the tab and toolbar and a "New identity" button. It is slow and some sites block Tor. It is **not Tor Browser** and hides less. The tab is never opened unless Tor reports 100%, and never falls back to a direct connection. Licence and attribution: `assets/licenses/TOR-NOTICE.txt` (BSD 3-clause; shipped next to the app).
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
5. **Repository variable `TOR_BUNDLE_VERSION`** (GitHub, Settings, Variables): the current Tor Browser stable version, so CI can fetch the matching Tor Expert Bundle from the Tor Project's archive.
6. Run `npm install` once locally and commit `package-lock.json`; then change `npm install` to `npm ci` in the workflow.
7. Tell the web app team the bridge contract (section 9).
8. Decide about Widevine (section 7).
9. Check the filter-list URLs still exist (the uBlock "annoyances" list has been renamed before). `npm run fetch-lists` reports any that fail.

Run the workflow from the GitHub "Actions" tab ("Build Mayfair Desktop", Run workflow), or push a tag like `v0.1.0`. It builds Windows (NSIS), macOS (dmg, Intel and Apple silicon) and Linux (AppImage and deb), all unsigned until step 4.

## 9. Contract with the Mayfair web app (`window.mayfairDesktop`, only on the Mayfair origins)

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

Passwords also speaks the extension page contract on the Mayfair tab: the page receives `window.postMessage({mayfair:1, v:1, type:'mf.pw.request', id, payload:{origin, host}})` and answers `{type:'mf.pw.credentials', id, payload:{id, credentials:[{username, password}]}}`. Post `{type:'mf.pw.listening'}` once Mayfair Passwords is open. The reply is only delivered to the tab that asked, and only if its address is still the same secure origin.

### Extensions (the nine Mayfair extensions)

`installExtension` accepts only `https://cloud.mayfairmail.com/ext/<file>.zip` (no query, no other host), downloads at most 8 MB, checks the SHA-256, unpacks with a zip reader that refuses `..`, absolute paths, encrypted or oversized archives, requires a Manifest V3 manifest (no `nativeMessaging`, `debugger`, `proxy`, `management`, `update_url` and similar), and keeps it in the app data folder. Installed extensions load into the normal browser session only (not Mayfair, Web apps, private or Tor tabs).

- Tracker blocker: Electron has no `declarativeNetRequest`, so its `rules/trackers.json` is read and applied natively to the basic blocker. When the full ad blocker is active it already covers those hosts, so they are not added twice and not counted twice.
- Passwords: handled by the app (the extension looks for a Mayfair tab, and the pinned tab is in a separate session), through the page contract above and the key button in the toolbar. It is recorded as installed with `native: "bridge"` and not loaded into Chromium.
- The other seven (deals, clipper, reader, dark, tabsaver, screenshot, translate) load, but Electron's extension support is partial. Verified by running: loading shows `Permission 'contextMenus' is unknown` and `Permission 'notifications' is unknown`, and the background workers of some fail with `Service worker registration failed`, `Cannot read properties of undefined (reading 'onClicked')` and `(reading 'onCommand')`. So right-click menus, keyboard commands and notifications from those extensions will not work in the desktop app; content scripts and popups may. Which extension features work was not tested page by page.
- The download page link used by Cloud is https://mayfairmail.com/desktop.

Web Push does not work in Electron (there is no Google push service in it). Native notifications come from `notify()`: the web app should call it when its own live connection receives an event. Deep links also set `#mf=<encoded path>` on the Cloud URL.

## 10. What was verified, and what was not

Verified by running (Linux, Xvfb, Electron 38): `npm test` (99 tests) and the 83-check smoke run (launch, pinned tab, offline page, navigation lock, IPC lockdown, tabs, bookmarks, history, private tab, downloads into the Drive folder, pop-up blocking, permission prompts, find in page, Web apps open/badge/reset/remove/window, WebRTC policy, standard locale and reduced fingerprint, own proxy, Tor tab against a stand-in `tor` program, Mayfair Search answers and commands, start page at 390, 1280 and 2560 pixels in dark and light). Screenshots from that run were looked at and fixed.

Could not be done here, and why:

- **`npm install` fails**: `registry.npmjs.org` is blocked by this sandbox (`ENOTFOUND` direct, `403 CONNECT` through the proxy). I fetched the Electron binary straight from GitHub releases instead. As a result `electron-builder` and `electron-updater` were never installed or run, so the installers were never built and the electron-builder config is untested.
- **Tor**: every Tor Project host (`dist.torproject.org`, `archive.torproject.org`, `www.torproject.org`, `deb.torproject.org`) returns `403 CONNECT` here, and `fetch-tor.js` fails with `getaddrinfo ENOTFOUND archive.torproject.org`. The manager (start, progress, new identity, stop, clean-up, crash and timeout) was tested against a stand-in program, not the real `tor`. Real bootstrap is untested.
- **Ghostery ad blocker and the lists**: the package could not be installed and `easylist.to`, `ublockorigin.github.io` and `cdn.jsdelivr.net` are blocked here. The engine wrapper, list updates, per-site exceptions and fallback are unit-tested against a fake library; real blocking, cosmetic filters, scriptlets and YouTube ads are untested. The package version (`^2.0.0`) and the scriptlet resource URL are unconfirmed.
- **Secure DNS / ECH**: switches are applied, but no live lookup could be observed (no network).
- **Weather, definitions, Wikipedia** and the ECB rate refresh: parsers tested on sample data, live calls untested.
- **Windows and macOS**: nothing run. Tray, jump list, Dock menu, login item, desktop shortcut on those systems are untested.
- **Mayfair Cloud itself** is unreachable from this sandbox (`403 CONNECT`), so the bridge was tested only up to the point where the page would answer.
- **Chromium background traffic**: I watched the sandbox proxy log during the smoke runs. The only unexplained connection was `redirector.gvt1.com` (a Google host) at start-up: Electron downloads spell-check dictionaries there on Windows and Linux, even with `--disable-background-networking` and `--disable-component-update` (tested: still one hit with each). Fix: spell check is switched off outside macOS and the dictionary URL points to a dead local port (a stand-alone test showed 0 hits afterwards). Other hosts seen were only Mayfair, the filter-list hosts and the pages the test opened. This is a log of refused connections from one machine, not a guarantee for every platform.
- The currency table is an approximate bundled sample dated 2026-10-01; `npm run update-rates` replaces it with real ECB rates.
- The omnibox (address bar) sends searches to your chosen engine and understands the command shortcuts, but does not show a suggestion drop-down; suggestions appear on the Mayfair Search page.
- Video-site sign-in pop-ups that need `window.opener` (for example "Sign in with Google" popups) are loaded in the same tab instead and may not complete.

## 11. Folder map

```
src/main/main.js         start-up, single instance, tray, menus, login item, updater
src/main/browser.js      window, tabs, sessions, downloads, permissions, IPC, Web apps, privacy, search
src/main/lib/            pure logic with unit tests (origins, stores, ipc allow-list, privacy, tor, webapps, adblock engine, ...)
src/preload/             ui.js (own UI), web.js (Mayfair bridge), page.js (websites + start page)
src/ui/                  tab strip and toolbar, panels, Mayfair Search page, error page
tools/                   icons, smoke test, Tor / filter-list / rate fetchers
test/                    node:test suites
```
