# Mayfair Ghost, the app

Ghost is an app inside Mayfair Desktop (category Research, not preinstalled). It opens in its own window (full screen by default) and sits on top of the connector core (`docs/connectors.md`) and the vault (`docs/ghost-vault.md`). Nothing here changes either of them.

## Where things live

| Part | Path |
| --- | --- |
| Window, sender checks, no-network partition | `src/main/ghost/app/window.js` |
| Service (stages, gating, scope, cases, reports) | `src/main/ghost/app/service.js` |
| Mayfair ID client (device sign-in, entitlement) | `src/main/ghost/app/id-client.js` |
| Argument checks for the `gapp:*` calls | `src/main/ghost/app/checks.js` |
| Cases in the vault | `src/main/ghost/app/cases.js` |
| Scope guard and scan log | `src/main/ghost/app/scopelog.js` |
| Report export (HTML, PDF, JSON) | `src/main/ghost/app/report.js` |
| Ghost Terms (version, hash, clauses) | `src/main/ghost/app/terms-text.js` |
| Page (no inline script or style) | `src/ui/ghost/` |
| Shared by page and main | `scope-parse.js`, `case-model.js`, `modules.js` |

## Start flow

`download` -> `signin` -> `checking` -> `apply` or `terms` -> `ready`. Main decides the stage (`GhostApp.stage()`); the page only draws it. Every call except the start flow is refused with `not-ready` until the stage is `ready`. There is no question about keys, a passphrase or a purpose: the vault opens with this computer's key store.

- Installed from the Cloud App Library through the `ghost.app.library`, `ghost.app.open` and `ghost.app.remove` bridge calls. The library entry says Research, not preinstalled, needs Desktop.
- Sign-in is the Mayfair ID device flow (RFC 8628). The session is stored sealed in the vault. Refresh tokens rotate.
- Access is `GET /api/platform/v1/ghost/entitlement` with the access token. Unapproved accounts see the apply screen. Operators (`operator: true`) get every module and no expiry. A refusal takes effect at once; if Mayfair cannot be reached the last good answer is used for 72 hours. It is asked again at start and every 6 hours.
- Terms are Ghost's own, accepted once per version (version and SHA-256 recorded with the time). `terms-text.js` still has `[[ ]]` gaps for legal review; `termsGet()` reports how many.

## Server contracts that are assumed (not built yet)

These are the owner's to build. The client and the tests use a local stand-in (`test/ghost-app-mock.js`).

1. OpenID discovery at `https://mayfairmail.com/.well-known/openid-configuration` with `device_authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, all on the issuer origin. Client id `mayfair-ghost`, scope `openid profile email offline_access`.
2. `GET https://mayfairmail.com/api/platform/v1/ghost/entitlement` (Bearer) answering `{ status: "approved|pending|rejected|revoked|expired|none", operator?: bool, expiresAt?, modules?: { scanning?: bool, geolocation?: bool }, applyUrl?, note? }`. `404` means never applied. Anything unexpected is treated as not approved.
3. `GET https://cloud.mayfairmail.com/ghost/index.json` with `{ components: [{ id, version, size }] }` (`404` means none). The list is not signature-verified yet.

## Modules and connectors

Nine modules (`modules.js`): Domains and networks, Infrastructure map, Companies and public records, Files and images, Places, News and events, Web archive, Threat intel, Active scanning. Each lists the connector ids it expects. A connector is also matched when its capabilities include `ghost-<module id>`. A module runs only connectors that are installed, approved, switched on and healthy. Expected connectors that are missing are shown as "Connector not installed". Nothing is faked.

Hard line, enforced in code: no person, username, email or phone input kinds; `refusePersonQuery` stops such text before any lookup; connectors for finding or profiling one person (Sherlock, Maigret, Blackbird, Holehe, WhatsMyName, people search and similar) are hidden and refused in `service.js` (`BLOCKED`); person-type results are withheld and counted at ingest; email is kept only with an infrastructure role.

Active scanning needs `modules.scanning` (operators have it). The scope guard takes one target (a domain, an IP, or a range no wider than /24), "I own it" or "I have written permission" (with who), and one tick. It lasts 12 hours and every declaration, scan start and scan end is a hash-chained line in the vault (`verify()` finds edits). The scan target comes from the declaration, not from the page.

## Case board

Format `mayfair-ghost-case/1`, stored sealed in the vault namespace `cases` with up to 20 backups (at most one every 5 minutes). A non-manual entity or link must carry a source. Undo and redo are 50 snapshot steps. Reports are self-contained escaped HTML (no script), JSON with a hash, or PDF from a script-free, network-blocked window. Footer: "Made with Mayfair Ghost. Copyright The Mayfair Organization."

## Shared files changed outside Ghost

`src/main/lib/ipc-allowlist.js`, `src/preload/web.js`, `src/main/browser-service.js`, `src/main/main.js` (the three `ghost.app.*` bridge names; window, menu and tray wiring; the terminal and Tool Integrations buttons).

## Open items

- Tool Integrations asks the Cloud window to open its page by sending `panel-request { panel: 'settings', page: 'cl-ghost' }`. The Cloud page must handle that.
- The bridge contract note in the audit folder is not updated here.
- Street-level imagery, satellite layers and the map basemap are placeholders, labelled as not installed or not connected, until connectors for them exist.

## Tests

`test/ghost-app-*.test.js`, `test/ghost-case-model.test.js`, `test/ghost-scope.test.js` need no display. `node tools/ghost-app-shots.js` runs the real window under Xvfb at 1280x800 and 390x844 against the local stand-ins and writes screenshots and a results file to `GHOST_OUT` (default `/tmp/ghost-shots`).
