'use strict';
// The '@node' runner on the REAL Electron utilityProcess (the other tests use a stand-in). A connector must finish and report
// its exit by itself; before this check an installed app waited for ever and every self-test timed out.
const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
const bin = () => [process.env.ELECTRON_BIN, path.join(__dirname, '..', 'node_modules/electron/dist/electron'), path.join(__dirname, '..', '.electron-dl/dist/electron')].filter(Boolean).find((p) => fs.existsSync(p));
test('real utilityProcess: a connector script finishes, its output arrives, exit codes are reported, a late finisher is waited for', { timeout: 120000 }, (t) => {
  if (process.env.GHOST_SKIP_E2E === '1') return t.skip('GHOST_SKIP_E2E=1');
  if (!bin() || spawnSync('which', ['xvfb-run']).status !== 0) return t.skip('needs the Electron binary and xvfb-run');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-runner-out-')), 'r.json');
  const r = spawnSync('xvfb-run', ['-a', bin(), '--no-sandbox', '--disable-gpu', path.join(__dirname, '..', 'tools', 'ghost-runner-main.js')], { env: { ...process.env, GHOST_OUT: out }, encoding: 'utf8', timeout: 100000 });
  assert.ok(fs.existsSync(out), 'no result: ' + String(r.stderr).slice(-300));
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(res.error, undefined);
  assert.equal(res.quick.code, 0); assert.deepEqual(JSON.parse(res.quick.out), { args: ['a', 'b'] });
  assert.equal(res.late.code, 0); assert.equal(res.late.out, 'late');
  assert.equal(res.fail.code, 3);
  assert.equal(res.check.status, 'ok');
});
