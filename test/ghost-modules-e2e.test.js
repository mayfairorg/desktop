'use strict';
// The eight modules as real connectors through ConnectorManager and JobRunner: registered, approved, self-tested and run, with the
// fuse off (utility process adapter) and with the plain process runner. The child processes get a mock transport through the build
// `prelude` option, so nothing here reaches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp } = require('./ghost-helpers');
const { makeFake } = require('./ghost-utility-fake');
const { ConnectorManager } = require('../src/main/ghost/manager');
const { JobRunner } = require('../src/main/ghost/runner');
const { GhostLog } = require('../src/main/ghost/logger');
const { PickStore } = require('../src/main/ghost/picks');
const { createUtilityRunner } = require('../src/main/ghost/node-runner/adapter');
const mods = require('../src/main/ghost/modules');
const X = require('../src/main/ghost/modules/lib/exif-parse');

const FIX = path.join(__dirname, 'fixtures');
const prelude = (extraRoutes = []) => `globalThis.fetch = require(${JSON.stringify(path.join(FIX, 'ghost-modules-mock.js'))}).makeFetch(Object.assign({}, require(${JSON.stringify(path.join(FIX, 'ghost-modules.json'))}), {}), { overrides: ${JSON.stringify(extraRoutes)} });`;

const FIRST_EIGHT = ['dns-doh', 'rdap-domain', 'rdap-ip-asn', 'ct-crtsh', 'wayback-cdx', 'exif-meta', 'gdelt-doc', 'wikidata'];
async function setup({ fuseOff, extraRoutes = [], ids = FIRST_EIGHT }) {
  const root = tmp();
  const log = new GhostLog(path.join(root, 'ghost', 'logs'));
  const utility = fuseOff ? createUtilityRunner({ utilityProcess: makeFake(), killGraceMs: 300 }) : null;
  const manager = new ConnectorManager({ root, nodeAvailable: !fuseOff, utility, confirm: async () => true, log });
  const picks = new PickStore();
  const runner = new JobRunner({ manager, log, ghostDir: path.join(root, 'ghost'), picks, utility });
  manager.setRunner(runner);
  const reg = mods.installAll(manager, { ids, prelude: prelude(extraRoutes) });
  for (const r of reg) assert.equal(r.ok, true, JSON.stringify(r));
  return { root, manager, runner, picks, reg };
}
const go = async (c, id, input) => { const r = c.runner.submit({ connector: id, input }); assert.equal(r.ok, true, JSON.stringify(r)); return c.runner.wait(r.jobId); };

test('fuse off: all eight modules install unapproved, then approve, self-test and enable through the utility runner', async () => {
  const c = await setup({ fuseOff: true });
  assert.equal(c.reg.length, 8);
  for (const m of c.manager.list()) { assert.equal(m.state, 'not-approved'); assert.equal(m.install.installed, false); }
  for (const r of c.reg) {
    assert.equal((await c.manager.requestApproval(r.id)).ok, true);
    const t = await c.manager.test(r.id);
    assert.equal(t.passed, true, r.id + ' ' + JSON.stringify(t));
    assert.equal(c.manager.enable(r.id).ok, true);
  }
  const listed = Object.fromEntries(c.manager.list().map((m) => [m.id, m]));
  for (const id of Object.keys(listed)) { assert.equal(listed[id].install.installed, true, id); assert.equal(listed[id].install.verified, 'tested'); }
  assert.equal(listed['exif-meta'].network, 'local'); assert.equal(listed['dns-doh'].network, 'keyless-external'); assert.equal(listed['ct-crtsh'].network, 'rate-limited');
});

test('fuse off: jobs return normalised results, honest failures keep their reason', async () => {
  const c = await setup({ fuseOff: true, extraRoutes: [{ match: { host: 'crt.sh', query: { q: '%.limited.example.com' } }, status: 429, headers: { 'retry-after': '30' }, text: 'slow' }, { match: { host: 'crt.sh', query: { q: '%.busy.example.com' } }, status: 503, text: 'down' }] });
  for (const r of c.reg) { await c.manager.requestApproval(r.id); c.manager.enable(r.id); }
  const dns = await go(c, 'dns-doh', { domain: 'example.com', types: 'MX' });
  assert.equal(dns.status, 'done', dns.error); assert.deepEqual(dns.results.map((x) => x.entity.value), ['mail.example.com', 'mail2.example.com']);
  assert.equal(dns.results[0].source.connector, 'dns-doh'); assert.equal(dns.rejected, 0);
  assert.match(dns.stderr, /network: keyless-external \(1 request\)/);
  const rdap = await go(c, 'rdap-domain', { domain: 'example.com' });
  assert.equal(rdap.status, 'done', rdap.error); assert.ok(rdap.results.some((x) => x.entity.type === 'org' && x.entity.value === 'Fixture Registrar Inc.'));
  assert.ok(rdap.results.some((x) => x.entity.type === 'person' && x.entity.value === 'Jane Fixture-Person'), 'the registry contact is passed on');
  const lim = await go(c, 'ct-crtsh', { domain: 'limited.example.com' });
  assert.equal(lim.status, 'failed'); assert.equal(lim.exitCode, 75); assert.match(lim.error, /rate-limited: crt\.sh asked us to slow down \(retry after 30 s\)/);
  assert.match(lim.stderr, /network: rate-limited/);
  const busy = await go(c, 'ct-crtsh', { domain: 'busy.example.com' });
  assert.equal(busy.status, 'failed'); assert.equal(busy.exitCode, 69); assert.match(busy.error, /unavailable: crt\.sh is not available/); assert.match(busy.stderr, /network: unavailable/);
  const bad = await go(c, 'dns-doh', { domain: '10.0.0.1' });
  assert.equal(bad.status, 'failed'); assert.equal(bad.exitCode, 2); assert.match(bad.error, /bad-input/);
  const none = await go(c, 'dns-doh', { domain: 'missing.example.com', types: 'A' });
  assert.equal(none.status, 'done'); assert.equal(none.resultCount, 0); assert.match(none.stderr, /NXDOMAIN/);
});

test('fuse off: a picked file is read locally and never named by path in the results', async () => {
  const c = await setup({ fuseOff: true });
  await c.manager.requestApproval('exif-meta'); c.manager.enable('exif-meta');
  const dir = tmp('mfd-e2e-'); const file = path.join(dir, 'site-visit.jpg');
  fs.writeFileSync(file, X.buildExifJpeg({ make: 'Acme', lat: 51.5007, lon: -0.1246, artist: 'Zed Fixture-Person' }));
  const token = c.picks.add(file, fs.statSync(file).size);
  const job = await go(c, 'exif-meta', { file: token });
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(job.results.map((r) => r.entity.type).sort(), ['image', 'place']);
  const s = JSON.stringify(job.results);
  assert.ok(!s.includes(dir) && !/Zed/.test(s));
  assert.match(job.stderr, /network: local/);
  const again = c.runner.submit({ connector: 'exif-meta', input: { file: token } });
  assert.equal(again.ok, false, 'the pick token works once'); assert.equal(again.error, 'bad-input');
});

test('plain process runner: the same module gives the same results as the utility runner', async () => {
  const a = await setup({ fuseOff: false }), b = await setup({ fuseOff: true });
  for (const c of [a, b]) { await c.manager.requestApproval('wikidata'); c.manager.enable('wikidata'); }
  const strip = (j) => j.results.map((r) => ({ ...r, observedAt: 'x' }));
  const ja = await go(a, 'wikidata', { kind: 'organisation', query: 'Fixture Corp' }), jb = await go(b, 'wikidata', { kind: 'organisation', query: 'Fixture Corp' });
  assert.equal(ja.status, 'done'); assert.equal(jb.status, 'done');
  assert.deepEqual(strip(ja), strip(jb)); assert.equal(ja.resultCount, 5);
});

test('changing a module file withdraws its approval (the library files are part of the hash)', async () => {
  const c = await setup({ fuseOff: true });
  await c.manager.requestApproval('dns-doh'); c.manager.enable('dns-doh');
  const f = path.join(c.root, 'connectors', 'dns-doh', 'lib', 'core.js');
  fs.appendFileSync(f, '\n// edited\n');
  const r = c.runner.submit({ connector: 'dns-doh', input: { domain: 'example.com' } });
  assert.equal(r.ok, false); assert.ok(['changed', 'not-approved'].includes(r.error));
});

test('tool connectors: not ready until the program is there; once it is in bin/, the self-test passes under both runtimes', { skip: process.platform === 'win32' }, async () => {
  for (const fuseOff of [true, false]) {
    const c = await setup({ fuseOff, ids: ['exiftool', 'gdal-info'] });
    for (const r of c.reg) await c.manager.requestApproval(r.id);
    const before = await c.manager.test('exiftool');
    assert.equal(before.passed, false); assert.match(before.lastTest.detail, /ExifTool program|not installed/);
    assert.equal(c.manager.list().find((m) => m.id === 'exiftool').install.installed, false);
    // the download-on-first-use step puts the program into the connector's bin folder
    const bin = path.join(c.root, 'connectors', 'exiftool', 'bin'); fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'exiftool'), `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === '-ver') console.log('12.76'); else console.log(JSON.stringify([{ 'File:MIMEType': 'image/png', 'File:FileType': 'PNG' }]));\n`, { mode: 0o755 });
    const after = await c.manager.test('exiftool');
    assert.equal(after.passed, true, JSON.stringify(after));
    assert.equal(c.manager.list().find((m) => m.id === 'exiftool').install.installed, true);
    c.manager.enable('exiftool');
    const f = path.join(tmp('mfd-e2e-'), 'x.png'); fs.writeFileSync(f, 'png');
    const job = await go(c, 'exiftool', { file: c.picks.add(f, 3) });
    assert.equal(job.status, 'done', job.error); assert.equal(job.results[0].entity.type, 'image'); assert.equal(job.results[0].raw.mimeType, 'image/png');
    assert.equal((await c.manager.test('gdal-info')).passed, false, 'GDAL is still missing');
  }
});
