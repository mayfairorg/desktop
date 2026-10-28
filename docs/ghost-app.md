# Mayfair Ghost, the app

Ghost is an app inside Mayfair Desktop (category Research, not preinstalled). It opens inside the Mayfair Desktop window, as a view in the Mayfair app area (see "Inside the Mayfair window"), and sits on top of the connector core (`docs/connectors.md`) and the vault (`docs/ghost-vault.md`). Nothing here changes either of them.

## Where things live

| Part | Path |
| --- | --- |
| View in the Mayfair window, sender checks, no-network partition | `src/main/ghost/app/window.js` |
| Service (stages, gating, scope, cases, reports) | `src/main/ghost/app/service.js` |
| Mayfair ID client (device sign-in, entitlement) | `src/main/ghost/app/id-client.js` |
| Argument checks for the `gapp:*` calls | `src/main/ghost/app/checks.js` |
| Cases in the vault | `src/main/ghost/app/cases.js` |
| Shipped lookups: register, approve, switch on, self-test, per-tool state | `src/main/ghost/app/builtins.js` |
| Master search: classify, run, cancel, event stream | `src/main/ghost/app/search.js` |
| Which input kinds each shipped lookup takes, its group, how a kind becomes its input | `src/main/ghost/app/toolmap.js` |
| Scope guard and scan log | `src/main/ghost/app/scopelog.js` |
| Report export (HTML, PDF, JSON) | `src/main/ghost/app/report.js` |
| Ghost Terms (version, hash, clauses) | `src/main/ghost/app/terms-text.js` |
| Page (no inline script or style) | `src/ui/ghost/` |
| Entity forms, custom fields, link labels, case file buttons | `src/ui/ghost/entity-ui.js`, `fields.css` |
| Shared by page and main | `scope-parse.js`, `case-model.js`, `modules.js` |

## Inside the Mayfair window

Ghost's page (`src/ui/ghost/index.html`, its own preload, `gapp:*` channels, partition `mf-ghost-app`, no network) is one `WebContentsView` added to the main window's content view, above the Mayfair view. There is no title bar or bar of its own. It is created on first use, kept alive while hidden (an open case is not lost) and destroyed by Remove, by the main window closing, or by quit.

- Opening (App Library Open, File menu, tray, `--ghost`) creates or raises the view and tells Mayfair Cloud with the `ghost-app` event.
- Cloud draws Ghost's app window (taskbar entry with the Ghost logo, minimise, close) and reports where its body is: `browser.ghost.app.bounds({x, y, w, h, visible})` in CSS pixels of the Mayfair view (zoom applied, clamped to the window). `visible:false` is minimise. `browser.ghost.app.hide()` is the Cloud window closing (the page stays alive, the area is forgotten). `occluded(on, {focus, capture})` and `capture()` work like a Browser tab for the times another Cloud window covers it. `state()` answers `{open, shown, fullscreen, placed, embedded, fallback, main, title}`. Feature flag in `ready()`: `ghost-view`.
- Until Cloud reports an area the view fills the whole content area (after at most 1.5 seconds when Cloud listens for `ghost-app`, at once when it does not). Ghost's own close button hides it, so it can always be dismissed.
- Full screen (the page's button or F11): the view covers the whole content area and the main window goes full screen; leaving restores the area. The view follows every resize, maximise and restore of the window, down to a 390 px wide area.
- Ctrl+R, F5 and Ctrl+Shift+R do nothing in Ghost (no reload, so an open board is never dropped, and nothing reaches Mayfair's shortcuts).
- Security is unchanged: calls are accepted only from this view's own webContents (main frame, the Ghost file, `#` routes allowed); the Cloud page has no `ghostApp` and Ghost's page has no `mayfairDesktop`; navigation, new windows, webviews, permissions and every http(s) request are refused or cancelled.
- The Ghost terminal and the investigation browser stay separate windows.
- Fallback: only when the main window does not exist yet (for example `--ghost` before it is created) Ghost opens in the old separate window.
- Mayfair Cloud needs its own Ghost app window for the taskbar entry and the placed area (not part of this repository). Without it Ghost still opens, full size inside the window.

## Start flow

`download` -> `signin` -> `checking` -> `apply` or `terms` -> `ready`. Main decides the stage (`GhostApp.stage()`); the page only draws it. Every call except the start flow is refused with `not-ready` until the stage is `ready`. There is no question about keys, a passphrase or a purpose: the vault opens with this computer's key store.

- Installed from the Cloud App Library through the `ghost.app.library`, `ghost.app.open` and `ghost.app.remove` bridge calls. The library entry says Research, not preinstalled, needs Desktop.
- Sign-in is the Mayfair ID device flow (RFC 8628). The session is stored sealed in the vault. Refresh tokens rotate.
- Access is `GET /api/platform/v1/ghost/entitlement` with the access token. Unapproved accounts see the apply screen. Operators (`operator: true`) get every module and no expiry. A refusal takes effect at once; if Mayfair cannot be reached the last good answer is used for 72 hours. It is asked again at start and every 6 hours.
- Terms are Ghost's own, accepted once per version (version and SHA-256 recorded with the time). `terms-text.js` still has `[[ ]]` gaps for legal review (including the draft paragraph on lawful use and UK/EU GDPR duties when personal data is recorded); `termsGet()` reports how many.

## Server contracts that are assumed (not built yet)

These are the owner's to build. The client and the tests use a local stand-in (`test/ghost-app-mock.js`).

1. OpenID discovery at `https://mayfairmail.com/.well-known/openid-configuration` with `device_authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, all on the issuer origin. Client id `mayfair-ghost`, scope `openid profile email offline_access`.
2. `GET https://mayfairmail.com/api/platform/v1/ghost/entitlement` (Bearer) answering `{ status: "approved|pending|rejected|revoked|expired|none", operator?: bool, expiresAt?, modules?: { scanning?: bool, geolocation?: bool }, applyUrl?, note? }`. `404` means never applied. Anything unexpected is treated as not approved.
3. `GET https://cloud.mayfairmail.com/ghost/index.json` with `{ components: [{ id, version, size }] }` (`404` means none). The list is not signature-verified yet.

## Modules and connectors

Nine modules (`modules.js`): Domains and networks, Infrastructure map, Companies and public records, Files and images, Places, News and events, Web archive, Threat intel, Active scanning. Each lists the connector ids it expects. A connector is also matched when its capabilities include `ghost-<module id>`. A module runs only connectors that are installed, approved, switched on and healthy. Expected connectors that are missing are shown as "Connector not installed". Nothing is faked.

Lookup limits, enforced in code: no person, username, email or phone input kinds, and no connector for finding or profiling one person; `refusePersonQuery` stops such text before a lookup is started; connectors built for that (Sherlock, Maigret, Blackbird, Holehe, WhatsMyName, people search and similar) are hidden and refused in `service.js` (`BLOCKED`). Connectors pass on what a public source publishes: RDAP contacts (organisations as `org`, individuals as `person`, abuse mailboxes as `email`; only entries the registry itself marked redacted are counted and left out), Wikidata items that are people (as `person`), Nominatim results down to house number and street, and GDELT for any query text. Result kinds that are accounts (username, handle, profile, phone, face and similar) are withheld and counted at ingest; email is kept only with an infrastructure role.

Active scanning needs `modules.scanning` (operators have it). The scope guard takes one target (a domain, an IP, or a range no wider than /24), "I own it" or "I have written permission" (with who), and one tick. It lasts 12 hours and every declaration, scan start and scan end is a hash-chained line in the vault (`verify()` finds edits). The scan target comes from the declaration, not from the page.

## The shipped lookups and the master search

Calls and events the page uses (all gated like the other `gapp:*` calls, arguments checked in `checks.js`, no command, path or argument list anywhere). The preload names are `ghostApp.builtins.status()`, `ghostApp.search.classify({query})`, `ghostApp.search.run({...})`, `ghostApp.search.cancel({searchId})`, `ghostApp.onBuiltins(cb)` and `ghostApp.onSearch(cb)`.

### The shipped lookups are ready at start

Once the Terms are accepted (stage `ready`), on every start, `GhostApp.ensureBuiltins()` registers the shipped folders and `builtins.approveShipped` approves and switches on, in the same call and without a dialog (`manager.approveBuiltin`, in-process only, never on the bridge), every shipped lookup whose installed folder is byte-identical to the shipped one. Nothing waits for a test. A lookup the person switched off stays off. Security connectors and any folder that is not the shipped one are untouched and keep the native approval window. Any later change to a file withdraws the approval (the manager's hash check, unchanged).

`ensureBuiltins` runs from `status()`, from every gated call and from every change, so a restart with the Terms already accepted sets up without any other step. Every failure is written to the Ghost log (`builtin-setup-failed`, `builtin-setup-skipped`, `builtin-selftest-failed`, `builtins-register-failed`) and shown with its reason in `gapp:builtins.status`.

After that the self-test runs in the background (two at a time, per-service politeness in the connectors unchanged). It only records `tested` or `failed` and the reason; it never switches anything off. Tools that need a program that is not here (ExifTool, MediaInfo, Tika, OCRmyPDF, Tesseract, FFmpeg, GDAL, QGIS) are only checked for that program, never run; ArchiveBox needs the person's own instance.

Why the cards said "Needs your approval" and "Not tested": approval used to sit inside the same one-by-one pipeline as the self-test (approve one, test it, approve the next), two at a time. A rate-limited service (GDELT, crt.sh, RDAP) made each step slow, so a tool further down the list stayed unapproved for minutes or until the window closed; a failed test left a tool approved but off; an error inside that pipeline was swallowed and never retried in that run. Approval is now one synchronous pass in front of the tests.

### `gapp:builtins.status` and event `gapp:builtins`

Returns `{ total, ready, 'setting-up', needsProgram, off, failed:[{id,name,reason}], phase, error, tests:{done,total}, tools:[{ id, name, category, inputs:[kind], state, note, tested, testNote, description }] }`. `state` is `ready`, `setting-up`, `needs-program`, `off` or `failed`. `tested` is `tested`, `failed` or `pending`; `testNote` is the reason. `needs-program` carries `note` "Runs in the Ghost virtual computer" while the virtual computer image is not published (`vm-index.json` `published:false`), otherwise "needs <program>". The event carries the same object (debounced).

### `gapp:search.classify` `{ query }`

Pure. Returns `{ kind, value, alternatives:[{kind,value}] }`. Kinds: `domain ip cidr asn url cert-hash org-name lei file place-text coords keyword` (a closed list; `file` is never guessed from text). There is no person, username, email or phone kind. `asn` needs the `AS` prefix. Something that looks like an email address is a `keyword`; its domain part is only offered as an alternative the person can choose. A bare number is a `keyword`.

### `gapp:search.run` `{ query, kind?, tools?, caseId? }`

Returns `{ ok, searchId, kind, value, tools:[id], skipped:[{tool,state,note}] }`, or `{ ok:false, code, error }` (`bad-input`, `no-tools`, `error`); it never throws to the page. Without `kind` the query is classified; with `kind` the value is cleaned and checked as that kind (for `file` the query is the token from `gapp:pickFile`; every tool gets its own fresh one-time token for the same file). Without `tools`, every READY tool whose kinds include the kind takes part; with `tools`, exactly those (a tool page passes `tools:[id]`). Tools that take the kind but are not ready (needs a program, off, setting up, failed) are never run and are reported in `skipped` and as a `tool-error` event with `state`. Passive tools only (no scope), the Ghost block list applies, at most six tools of one search run at once through the existing job runner, and a full job queue is waited out.

Events `gapp:search`: `{ searchId, caseId?, type, tool?, results?, total?, truncated?, error?, state?, note?, jobId?, ms, summary?, cancelled? }` with `type` one of `tool-start`, `tool-result` (normalised connector results, at most 1000), `tool-empty`, `tool-error` (`state` is `needs-program`, `off`, `setting-up` or `failed` when no job ran or the program is missing) and `done` (`summary: { ran, results, errors, empty, notRun }`).

### `gapp:search.cancel` `{ searchId }`

Cancels the running jobs and the tools that have not started; `done` follows with `cancelled: true`. Returns `{ ok:true, cancelled }`.

## Case board

Format `mayfair-ghost-case/1`, stored sealed in the vault namespace `cases` with up to 20 backups (at most one every 5 minutes). A non-manual entity or link must carry a source. Undo and redo are 50 snapshot steps. Reports are self-contained escaped HTML (no script), JSON with a hash, or PDF from a script-free, network-blocked window. Footer: "Made with Mayfair Ghost. Copyright The Mayfair Organization."

### Entity model

An entity is `{id, type, key, label, attrs, fields, sources, tags, firstSeen, lastSeen, manual, pos, pinned}`. Types: `domain ip asn cert org person document image place event url email service finding`. Entities merge on the same type and canonical key (a person's key is the lowercased, space-collapsed name; a person added by hand is always a new entity, so two people can share a name).

- **Person** (label "Person") connects CEOs, directors and owners to organisations. It is filled by hand from sources the analyst found, or passed through from a registry or Wikidata result that named it; there is no lookup for people, usernames, emails, phones or addresses. The Add entity form offers the professional fields name (the label), role / title, organisation(s), appointed date, public profile link and a source; each one becomes a custom field.
- **Custom fields** exist on every entity type, in `entity.fields`, a list in display order: `{id, title, value, kind, source, t, updated}`. `kind` is `text`, `longtext`, `link`, `date` or `number` and only tells the page how to show and edit the value; the value is always stored as text. The title and value are free text. Nothing is blocked, warned about or filtered on any entity type, Person included; only size limits apply (200 fields per entity, 300 characters for a title, 20000 for a value, 1000 for the source note). `source` is free text (where the analyst found it) and `t` / `updated` are the time it was recorded and last changed. Fields can be added, edited, renamed, reordered (up and down) and deleted in the inspector. They are searched with the case search (title, value and source), appear in the report beside each entity and in the report JSON, and travel in the case file.
- **Links** carry a relation (`REL` now includes `ceo-of`, `director-of`, `owner-of`, `works-with` and `custom`), an optional free-text `label` shown instead of the relation, an optional `sourceNote`, and the existing `sources`, `t` and `manual`. `works-with` and `same-as` read both ways. A link can be edited from the inspector.
- **Case file**: "Export case file" saves the case JSON; "Import case file" reads one and merges it into the open case (`GhostCase.importJson`, `mergeCase`). Entities with the same type and key combine (a person by name): sources, tags and fields are unioned and nothing the open case holds is overwritten; links, notes and timeline entries are added without duplicates. The merge is one undo step. Channels `gapp:cases.exportJson` and `gapp:cases.importPick`.

## Shared files changed outside Ghost

`src/main/lib/ipc-allowlist.js`, `src/preload/web.js`, `src/main/browser-service.js`, `src/main/main.js` (the `ghost.app.*` bridge names and the `ghost-app` event; view, menu and tray wiring; the terminal and Tool Integrations buttons).

## Quick notes

A drawer on every Ghost screen (top-bar button, Ctrl+Shift+N) that can pop out into its own small always-on-top window (Ctrl+Shift+O). Paste text, sanitised rich text, links, clipboard images, dropped files, or press Capture for the Ghost browser page or a screen/window. Each clip keeps where it came from, a time and an item hash. Tabs (new, rename, reorder, close, restore), five highlight colours, underline, comments, tags, pins, search across tabs, undo/redo, and Send to case (new entity, or evidence on an existing one).

- Stored sealed in the vault: doc `qn-<scope>`, pictures `qb-<scope>-<id>`. Scope is a case id or `inbox`. Caps: 8 MB doc, 8 MB per picture, 128 MB per scope.
- The report can include chosen tabs as an appendix (covered by the report hash).
- No network, no telemetry, no AI. Channels are `gqn:*`, checked in `notes-checks.js`.
- Files: `ui/ghost/qn-model.js`, `quicknotes.js/.css/.html`, `quicknotes-boot.js`, `quicknotes-preload.js`; `main/ghost/app/notes.js`, `notes-checks.js`, `notes-host.js`, `notes-report.js`.
- Shared files touched: service.js, checks.js, report.js, index.js (ghost app); preload.js, shell.js, board.js, index.html (ui); main.js; browser/window.js (notesBridge).
- Tests: ghost-notes-model, -store, -host, -ui. Screenshots: `tools/ghost-notes-shots.js` (Playwright, stub bridge).

## Open items

- Tool Integrations asks the Cloud window to open its page by sending `panel-request { panel: 'settings', page: 'cl-ghost' }`. The Cloud page must handle that.
- The bridge contract note in the audit folder is not updated here.
- Street-level imagery, satellite layers and the map basemap are placeholders, labelled as not installed or not connected, until connectors for them exist.

## Tests

`test/ghost-app-*.test.js` (including `ghost-app-classify`, `ghost-app-search`, `ghost-app-search-checks`, `ghost-app-builtins-setup`), `test/ghost-case-model.test.js` (person type, custom fields, link labels, case file merge), `test/ghost-scope.test.js` need no display. `node tools/ghost-app-shots.js` runs the real view inside a stand-in main window under Xvfb at 1280x800 and 390x844 against the local stand-ins and writes screenshots and a results file to `GHOST_OUT` (default `/tmp/ghost-shots`).
