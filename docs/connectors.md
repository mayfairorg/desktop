# Mayfair Ghost connectors: developer guide

A **connector** lets Mayfair Ghost use an external tool without giving the Mayfair page any way to run commands. The architecture is generic: it knows nothing about particular tools. A connector is a folder with a manifest (`connector.json`) and the program the manifest names. Mayfair Desktop validates the manifest, asks the user to approve it in a native dialog, runs the program in a restricted way, and checks everything the program prints.

Code: `src/main/ghost/` (manifest.js, result.js, manager.js, runner.js, proc.js, logger.js, picks.js, index.js, samples/). Bridge: `window.mayfairDesktop.browser.ghost.*` (contract: section 0.5 of `browser-bridge-contract.md`). Tests: `test/ghost-*.test.js`.

This guide is about the mechanism. Connectors for tools whose purpose is to find one person's accounts are not part of Mayfair Ghost and must not be built on it.

## 1. How it fits together

```
Mayfair page --(browser.ghost.*, allowlisted, argument-checked)--> BrowserService --> GhostService
                                                                      ConnectorManager  (discover, validate, approve, enable, test, health)
                                                                      JobRunner         (queue, spawn, parse, limits, history)
<userData>/connectors/<id>/   connector.json + program        (the connector, installed independently)
<userData>/ghost/state.json   approvals, enabled flags, test results
<userData>/ghost/jobs.json    job history (last 100 jobs)
<userData>/ghost/audit.jsonl  every ACTIVE run
<userData>/ghost/logs/        ghost.log (+ .1 to .4), JSON lines, rotated at 256 KB
```

The page can only: list and inspect connectors, ask for approval, enable or disable an approved connector, remove one (native confirm), start a job by naming a connector and giving input values, cancel and read jobs and logs, and ask for a native file picker. It cannot approve, register, or pass a command, argument list, path or environment. There is no such call, and the allowlist (`src/main/lib/ipc-allowlist.js`, group `GH` inside `BR`) rejects any extra key in `jobs.run`.

## 2. Manifest reference (`connector.json`)

Unknown keys are rejected at every level. All keys below are required unless marked optional. The validator is `validateManifest` in `manifest.js`; its test is `test/ghost-manifest.test.js`.

| Key | Rules |
| --- | --- |
| `id` | Unique, 1 to 40 characters of `a-z 0-9 -`, not starting or ending with `-`. Must equal the folder name. |
| `name`, `description` | Text, 1 to 80 and 1 to 500 characters. Shown in the approval dialog and the UI. |
| `version` | Semantic version (`1.2.3`, `1.2.3-beta.1`). Shown in the approval dialog. |
| `capabilities` | 1 to 20 distinct lowercase names (`a-z 0-9 . _ -`). The UI can group and filter by them. |
| `scope` | `local` works only on data on this computer. `passive` reads public information and does not touch the target. `active` interacts with a target system; see section 6. |
| `network` | `local` (none), `keyless-external` (external services, no account key), `rate-limited` (external services that limit use), `unavailable` (the service it needs is not available now: jobs and self-test are refused). |
| `licence` | `{spdx, url, mode}`. `spdx` is an SPDX identifier. `url` is an `https` address. `mode` is `bundled` (the tool ships inside the connector folder) or `separate-program` (a program the user installs separately under its own licence). Shown in the approval dialog. See section 9. |
| `installRequirements` | Array (may be empty) of `{name, check}`. `check` is an **argv array** (never a shell string): `check[0]` is a plain program name (`node`), the token `@node`, or a relative path inside the connector folder. Exit code 0 means the requirement is met. Checks run only after the connector is approved, with no shell and a minimal environment. |
| `command` | `{executable, args, files?}`. `executable` is a relative path inside the connector folder, or the token `@node` (the app's own Node: `process.execPath` with `ELECTRON_RUN_AS_NODE=1`). With `@node`, `args[0]` must be the script, a literal relative path. `args` is an **array** of templates: each element is one argument and may contain named placeholders `{field}` that refer to input fields. `files` (optional) lists extra relative files to include in the integrity hash (helpers, libraries). |
| `input` | `{fields: [...]}`, at most 16 fields; see section 3. |
| `output` | `{format: "jsonl"}`: JSON lines on stdout matching the result schema (section 4). |
| `limits` | `timeoutMs` (100 to 600000), `maxOutputBytes` (up to 16 MiB), `maxConcurrent` (1 to 8) are required. `maxMemoryMb` (16 to 4096) is optional and best effort (section 5). |
| `permissions` | Declared, shown at approval: `read-picked-file`, `network`, `temp-files`. `network` must be declared exactly when `network` is `keyless-external` or `rate-limited`; `read-picked-file` is required for a file input. These are declarations the user approves, not a sandbox (section 7). |
| `externalRestrictions` | Text (1 to 1000 characters) for the user: terms of use, rate limits, what the tool may be used for. Write `None.` if there are none. |
| `selfTest` | `{input, expect}`. `input` must be valid for the input schema and cannot use a file field. `expect` is `{minResults?, contains?: [{type, value}]}` and must expect something. |

Path rules (executable, `args[0]` for `@node`, `files`, relative check programs): relative, forward slashes only, characters `A-Za-z0-9 . _ -` and `/`, no `.` or `..` segments, no absolute or drive paths. At load time the file must also be a plain file (no symlink) whose real path is inside the connector folder.

Argument templates: a placeholder must be `{name}` where `name` is a declared field. `{}`, `{0}`, `{ x }`, an undeclared name or unbalanced braces are rejected. An argument that names an optional field is left out when the field has no value (so `"--text={text}"` simply disappears). A whole-argument placeholder (`"{name}"`) refuses values that start with `-` (so input cannot become a flag) unless the string field sets `allowLeadingDash`. Prefer the embedded form `--name={name}`.

## 3. Input schema

Each field: `{name, type, label?, required?, sensitive?, ...}`; `name` matches `[a-z][a-zA-Z0-9_]{0,31}`; `required` defaults to true.

| `type` | Extra keys | Accepts |
| --- | --- | --- |
| `string` | `maxLength` (required, 1 to 4096), `minLength?`, `pattern?` (regular expression, up to 200 characters), `allowLeadingDash?` | text, no NUL |
| `enum` | `values` (1 to 50 distinct strings) | one of the values |
| `integer` | `min`, `max` (both required) | a whole number in range |
| `url-host` | none | a host name or IPv4 address such as `example.com` (no scheme, path or port); lowercased |
| `file` | `maxBytes?` (default 50 MiB) | a token from `ghost.pickFile()` |

`sensitive: true` marks values (tokens, keys) that must never be logged: they are replaced by `***` in the log, the job history, the audit log, progress messages, stderr and error text. They are still passed to the program, as an argument, so they are visible to other programs on the same computer while it runs; a connector that needs a real secret should read it itself from a place the user controls instead.

**Picked files.** `ghost.pickFile()` opens a native file picker and returns `{token, name, size}`. The path never reaches the page. The token works once, for one run, for 10 minutes; `jobs.run` replaces it with the real path (resolved with `realpath`, size-checked) in the argument. A made-up token or a path is refused.

## 4. Output and the result schema

The program prints **JSON lines** on stdout, one object per line. Two kinds of line:

* Progress: `{"progress": 0.5, "message": "parsing"}`. `progress` is 0 to 1; `message` is optional, up to 200 characters. Delivered as `ghost-job` events (about ten a second at most).
* Result:

```json
{
  "entity": {"type": "uuid-version", "value": "4"},
  "source": {"tool": "uuid-info", "connector": "uuid-info", "version": "1.0.0", "url": "https://example.com/optional"},
  "observedAt": "2026-10-27T09:00:00.000Z",
  "confidence": "confirmed",
  "uncertaintyNote": "required when confidence is uncertain",
  "raw": {"anything": "optional, JSON"}
}
```

Rules (`result.js`): `entity.type` is lowercase `[a-z0-9._-]` up to 40 characters; `entity.value` is 1 to 2000 characters; `source.connector` must equal the connector's own id (a connector cannot report as another one); `source.tool` and `source.version` are required, `source.url` must be http or https; `observedAt` is an ISO 8601 date-time and not in the future; `confidence` is `confirmed`, `likely` or `uncertain`, and `uncertain` needs `uncertaintyNote`; `raw` is kept up to 4 KiB of JSON, larger values are replaced by `{truncated: true, bytes, preview}`; any other key is rejected.

**Nothing is fabricated or dropped silently.** A line that is not JSON, is too long (over 64 KiB), or does not validate is rejected; the job records `rejected` (a count) and `errors` (the first 20: line number, reason, the first 80 characters). A job that exits 0 with only rejected lines fails ("no valid results"). A confidence level is never added or upgraded by the app.

Print results as they are found, keep stderr for diagnostics (captured, capped at 16 KiB), exit 0 on success. A non-zero exit fails the job and the first stderr line is shown.

## 5. Running: what the runner guarantees

* `child_process.spawn` with an **argv array**, `shell: false`. The input text is one argument; `; touch /tmp/x` is just text (tested).
* `cwd` is the connector folder. The environment is minimal: `PATH`, `LANG`, `TMPDIR` (Windows: `SystemRoot`, `TEMP`, `TMP`), `ELECTRON_RUN_AS_NODE=1` for `@node`, and `MF_CONNECTOR_ID`, `MF_JOB_ID`. Nothing else is inherited: no tokens, cookies or API keys. `stdin` is closed.
* Files are hashed again immediately before every run (and again when a queued job starts). A change refuses the run.
* Limits: `timeoutMs` kills the job (`timed-out`); `maxOutputBytes` kills it (`failed`, "output is larger than ..."); at most 5000 results; `maxConcurrent` per connector (further jobs wait as `queued`; at most 4 jobs run at once overall and 20 may wait). `maxMemoryMb` is best effort: for `@node` the runner passes `--max-old-space-size`, and on Linux it also watches the resident memory and kills the job above the limit. On other systems only the Node heap flag applies.
* Cancel and timeout kill the whole **process group** (SIGTERM, then SIGKILL after 0.8 s; `taskkill /T /F` on Windows), so helpers the tool started die with it.
* States: `queued`, `running`, `done`, `failed`, `cancelled`, `timed-out`. History keeps the last 100 jobs in `jobs.json` (up to 200 results each); a job left running when the app closed shows as `failed: interrupted`.
* Logs: `ghost.log`, one JSON object per line `{t, level, event, jobId?, connector?, ...}`, rotated at 256 KB with 4 old files. Events include `job-queued`, `job-start`, `job-end`, `result-rejected`, `run-refused`, `approved`, `approval-revoked`, `self-test`. Read with `ghost.logs.tail({jobId?, n})`.

Memory limits and the Node runtime in installed builds: the production build turns the **RunAsNode fuse off** (`src/main/lib/protect.js`), so `ELECTRON_RUN_AS_NODE` does not work in an installed app. In such a build the manager reports the `@node` requirement as missing, refuses runs with `runtime-unavailable` and never starts the app binary as a tool. Connectors that use a bundled native executable are not affected. Decide before shipping `@node` connectors to users: either enable the fuse (a documented security trade-off) or move `@node` connectors to a utility-process adapter.

## 6. Approval, enabling and the active-scope guard

States: `not-approved` -> `approved` -> `enabled`, and `disabled` (enabled once, switched off). Only **registered, valid, approved and enabled** connectors run (the self-test needs approved only).

1. `requestApproval(id)` opens a **native** `dialog.showMessageBox` from the main process naming the connector, version, scope, network, permissions, licence and restrictions. Cancel is the default button. The page can ask; only the user's click grants. Repeated requests while the dialog is open share it.
2. The approval record in `state.json` stores the time and SHA-256 of `connector.json`, of the program and of every file in `command.files`.
3. The **health monitor** re-hashes on every list, validate, approval, test and run. Any difference (or a missing or invalid file) revokes the approval, turns off enabled, clears the test result, and shows `health: "changed"` (or `"broken"`). The user must approve the new files again.
4. `enable` and `disable` are plain state changes after approval; `disable` and `remove` cancel running jobs. `remove` asks in a native dialog, then deletes the folder and the record.
5. **Self-test** (`test(id)`) runs the connector's `selfTest.input` through the same runner and compares the output with `selfTest.expect`. It records `verified` as `tested` or `failed` with a timestamp and detail. A connector is reported `installed: true` only when every install requirement is `ok`, the self-test passed on the current files, and health is `ok`. Approval and enabling never imply it.
6. **Active scope.** A connector with `scope: "active"` needs a declaration on every run (and for `test`): `{target, confirmedAuthorised: true}`, exactly those keys, `confirmedAuthorised` the boolean `true`. When the connector has a `url-host` input, `target` must equal that value. The runner appends `run-requested` (before starting; if the write fails the run does not start) and `run-finished` lines to `audit.jsonl` with job, connector, version, target and masked inputs. The UI should make the user state the authorisation each time; the app records it and does not judge it.

## 7. Security rules

* No raw exec anywhere: the bridge has no call that takes a command; `spawn` appears once for jobs (`runner.js`) and once for requirement checks (`proc.js`), both with `shell: false` (a static test checks the ghost code for `shell: true`, `exec`, `eval`, `new Function`, inherited `process.env`).
* The page can never grant trust. The test hook that stands in for the dialog (`GhostService.useTestConfirm`) throws in an installed app and outside a smoke run, and is not reachable from the bridge.
* Declared `permissions` and `network` are shown to the user and recorded, but the app does not sandbox the child: an approved connector runs as the user. Approve only connectors you trust. (An operating-system sandbox can be added in `proc.js` without changing the manifest.)
* A connector folder may contain no symlinks (registration refuses them) and every file the manifest names is re-checked to be a plain file inside the folder.
* Install requirement checks run only for approved connectors.
* The log, history and audit log contain no value of a `sensitive` field.

## 8. Installing, removing and how the UI finds a connector

A connector is installed independently of the app: copy its folder to `<userData>/connectors/<id>/` (or call `ConnectorManager.register(folder)` from the main process, which validates, refuses links and oversized folders, copies and registers without approving). Removing it is deleting that folder or `ghost.connectors.remove(id)`; the app and other connectors are unaffected. `ghost.connectors.installSample()` installs `sample-textstats` from `src/main/ghost/samples/`.

The UI needs no code per connector: `ghost.connectors.list()` returns everything it needs (name, capabilities, scope, network, licence, install requirements and status, verified state, permissions, restrictions, state, health). `ghost.connectors.get(id)` adds the `input.fields` list so a form can be drawn (field types, bounds, labels, which are sensitive) and the limits. Listen with `browser.on('ghost-job', cb)` for `{jobId, status, progress, message}` and fetch results with `ghost.jobs.get(jobId)`. A typical flow: list -> `requestApproval` -> `test` -> `enable` -> `jobs.run` -> events -> `jobs.get`. Show "installed" only when `install.installed` is true.

## 9. Licence handling

Every manifest names the licence of the tool it runs. `mode: "bundled"`: the tool's files are inside the connector folder; ship its licence text next to it and make sure the licence allows redistribution. `mode: "separate-program"`: the connector only calls a program the user installed (an `installRequirements` check proves it is there); the program keeps its own licence and the connector must not copy it. Strong copyleft licences (GPL, AGPL) are a reason to prefer `separate-program`. The approval dialog shows the SPDX identifier and the mode, and `externalRestrictions` is where terms of use belong. Mayfair Desktop itself is proprietary; sample connectors shipped with it say so in their manifest.

## 10. Testing

```
npm test                     # includes test/ghost-manifest, ghost-manager, ghost-runner, ghost-bridge
node --test test/ghost-manifest.test.js
MF_SMOKE_TIMEOUT=560000 timeout 590 node tools/smoke.js    # includes the ghost checks (real Electron, real sample run)
```

The tests build connectors from a small script (`test/ghost-helpers.js`, field `mode` selects ok, sleep, spam, badjson, invalid, env, echo, children, mem, ...). To test a new connector: `const c = context(); const id = c.manager.register(folder).id; await c.manager.requestApproval(id); const t = await c.manager.test(id);` (the helper's dialog answers yes). Check `t.passed`, then run it with `c.runner.submit({connector:id, input})` and `await c.runner.wait(jobId)`. The smoke run uses a test-only stand-in for the native dialog (`br.ghost.useTestConfirm`), never reachable from the page.

## 11. Worked example: add a new connector

Goal: a local connector `uuid-info` that reports the version and variant of a UUID. Create a folder `uuid-info/` with two files.

`connector.json`:

```json
{
  "id": "uuid-info",
  "name": "UUID inspector",
  "version": "1.0.0",
  "description": "Reports the version and variant of a UUID. Local only.",
  "capabilities": ["identifier-analysis"],
  "scope": "local",
  "network": "local",
  "licence": { "spdx": "MIT", "url": "https://opensource.org/license/mit", "mode": "bundled" },
  "installRequirements": [
    { "name": "Built-in Node runtime", "check": ["@node", "-e", "process.exit(0)"] }
  ],
  "command": { "executable": "@node", "args": ["run.js", "--uuid={uuid}"] },
  "input": {
    "fields": [
      { "name": "uuid", "type": "string", "label": "UUID", "maxLength": 36, "pattern": "^[0-9a-fA-F-]{36}$" }
    ]
  },
  "output": { "format": "jsonl" },
  "limits": { "timeoutMs": 5000, "maxOutputBytes": 16384, "maxConcurrent": 4 },
  "permissions": [],
  "externalRestrictions": "None. Runs on this computer and sends nothing anywhere.",
  "selfTest": {
    "input": { "uuid": "123e4567-e89b-12d3-a456-426614174000" },
    "expect": { "minResults": 2, "contains": [{ "type": "uuid-version", "value": "1" }] }
  }
}
```

`run.js`:

```js
'use strict';
const arg = process.argv.slice(2).find((a) => a.startsWith('--uuid='));
const uuid = arg ? arg.slice(7).toLowerCase() : '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) { process.stderr.write('not a UUID\n'); process.exit(2); }
const variantNibble = parseInt(uuid[19], 16);
const variant = variantNibble < 8 ? 'ncs' : variantNibble < 12 ? 'rfc-4122' : variantNibble < 14 ? 'microsoft' : 'future';
const emit = (type, value) => console.log(JSON.stringify({
  entity: { type, value }, source: { tool: 'uuid-info', connector: 'uuid-info', version: '1.0.0' },
  observedAt: new Date().toISOString(), confidence: 'confirmed',
}));
console.log(JSON.stringify({ progress: 0.5, message: 'parsing' }));
emit('uuid-version', uuid[14]);
emit('uuid-variant', variant);
```

Steps:

1. Pick an `id` and fill the manifest. Choose the honest `scope` and `network`; declare `permissions` to match. Write a `selfTest` that proves the tool works (here: a known UUID version 1).
2. Check it: `node -e "console.log(require('./src/main/ghost/manifest').validateManifest(require('./uuid-info/connector.json')))"` prints `ok: true` or the list of problems.
3. Install it: copy the folder to `<userData>/connectors/uuid-info/` (or `manager.register('uuid-info')` in a test). It appears in `ghost.connectors.list()` as `not-approved`, `installed: false`.
4. `ghost.connectors.requestApproval('uuid-info')`: the native dialog shows name, version, scope, network, permissions, licence; the user approves.
5. `ghost.connectors.test('uuid-info')`: runs the self-test; on success `verified: "tested"` and `installed: true`.
6. `ghost.connectors.enable('uuid-info')`, then `ghost.jobs.run({connector: 'uuid-info', input: {uuid: '123e4567-e89b-42d3-a456-426614174000'}})` returns a `jobId`; `ghost-job` events follow; `ghost.jobs.get(jobId).results` holds `uuid-version = 4` and `uuid-variant = rfc-4122`.
7. Edit `run.js` and the connector shows `health: "changed"`, `not-approved`, until approved again.
8. Remove it: `ghost.connectors.remove('uuid-info')`.

For a tool that is a native program: put the executable in the folder, set `"executable": "bin/tool"`, write the arguments as an array, list a version check in `installRequirements`, and set `licence.mode` to `bundled` or `separate-program` as described above.
