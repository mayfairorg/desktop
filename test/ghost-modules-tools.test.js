'use strict';
// Tool connectors: ExifTool, MediaInfo, Tesseract, OCRmyPDF, Apache Tika, FFmpeg frames, GDAL, QGIS launcher (local programs) and
// ArchiveBox, NASA Earthdata, USGS Landsat (network). No real program and no real service is used: the program runner and the transport
// are injected, and the program outputs below are hand-labelled samples in the formats those tools print.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tmp } = require('./ghost-helpers');
const { makeFetch } = require('./fixtures/ghost-modules-mock');
const fixtures = require('./fixtures/ghost-modules.json');
const mods = require('../src/main/ghost/modules');
const { realTools } = require('../src/main/ghost/modules/lib/tool-run');
const { validateResult } = require('../src/main/ghost/result');
const { validateManifest } = require('../src/main/ghost/manifest');

const NOW = new Date('2026-10-27T09:00:00.000Z');
const noSleep = async () => {};
globalThis.fetch = async (u) => { throw new Error('LIVE NETWORK CALL IN A TEST: ' + u); };

// a stand-in for the program runner: programs = {name: (args) => ({code, stdout, stderr})}
function fakeTools({ programs = {}, files = {}, launches = [] } = {}) {
  const calls = [];
  return {
    calls, launches,
    find: (names) => { const n = names.find((x) => programs[x]); return n ? '/fake/bin/' + n : null; },
    findFile: (re) => Object.keys(files).find((x) => re.test(x)) ? '/fake/bin/' + Object.keys(files).find((x) => re.test(x)) : null,
    run: async (file, args, o) => { calls.push({ file, args, o }); const p = programs[path.basename(file)]; if (!p) return { code: null, error: 'ENOENT' }; return { stdout: '', stderr: '', code: 0, ...(await p(args, o)) }; },
    launch: async (file, args) => { launches.push({ file, args }); return { ok: true, pid: 1 }; },
    heavy: async (fn) => { calls.push({ heavy: true }); return fn(); },
  };
}
const runT = async (id, input, tools, extra = {}) => { const r = await mods.runModule(id, input, { tools, now: () => NOW, sleep: noSleep, ...extra }); for (const l of r.results) { const v = validateResult(l, { connector: id, now: NOW.getTime() }); assert.equal(v.ok, true, v.error + JSON.stringify(l)); } return r; };
const picked = (name, data = 'content') => { const p = path.join(tmp('mfd-tool-'), name); fs.writeFileSync(p, data); return p; };
const vals = (r, t) => r.results.filter((x) => x.entity.type === t).map((x) => x.entity.value);
const txt = (r) => JSON.stringify(r.results);

test('all new connectors have valid manifests: separate programs declared as such, local ones with no network', () => {
  const local = ['exiftool', 'mediainfo', 'tesseract', 'ocrmypdf', 'tika', 'ffmpeg-frames', 'gdal-info', 'qgis-open'];
  const heavy = ['tesseract', 'ocrmypdf', 'tika', 'ffmpeg-frames'];
  for (const id of [...local, 'archivebox', 'nasa-cmr', 'usgs-landsat']) {
    const m = mods.byId(id); assert.ok(m, id);
    const man = mods.toManifest(m.meta);
    const v = validateManifest(man); assert.equal(v.ok, true, id + JSON.stringify(v.errors));
    if (local.includes(id)) {
      assert.equal(man.network, 'local', id); assert.equal(man.licence.mode, 'separate-program', id); assert.ok(!man.permissions.includes('network'));
      assert.ok(man.installRequirements.some((r) => r.check.includes('--locate')), id);
      assert.equal(man.limits.maxConcurrent, heavy.includes(id) ? 1 : 2, id);
    }
    assert.ok(man.selfTest.expect.minResults >= 1);
  }
  assert.equal(mods.toManifest(mods.byId('nasa-cmr').meta).network, 'rate-limited');
  assert.equal(mods.toManifest(mods.byId('archivebox').meta).licence.mode, 'bundled');
  for (const bad of ['gallery-dl', 'sherlock', 'maigret', 'holehe', 'blackbird', 'whatsmyname']) assert.equal(mods.byId(bad), null);
});

test('a missing program is reported as unavailable with the reason, and the self-test cannot pass', async () => {
  for (const id of ['exiftool', 'mediainfo', 'tesseract', 'ocrmypdf', 'tika', 'ffmpeg-frames', 'gdal-info', 'qgis-open']) {
    const r = await runT(id, { check: 'version' }, fakeTools());
    assert.equal(r.status, 'unavailable', id); assert.match(r.message, /is not installed/, id); assert.equal(r.results.length, 0); assert.equal(r.exitCode, 69);
  }
});

const EXIF_OUT = JSON.stringify([{ SourceFile: '/x/p.jpg', 'ExifTool:ExifToolVersion': 12.7, 'File:FileType': 'JPEG', 'File:MIMEType': 'image/jpeg', 'File:ImageWidth': 640, 'File:ImageHeight': 480, 'IFD0:Make': 'Acme', 'IFD0:Model': 'Cam 1', 'IFD0:Software': 'Edit 2', 'IFD0:Artist': 'Zed Fixture-Person', 'IFD0:Copyright': 'Zed', 'ExifIFD:DateTimeOriginal': '2024:05:01 12:30:00', 'ExifIFD:OffsetTimeOriginal': '+01:00', 'ExifIFD:BodySerialNumber': '123456', 'ExifIFD:CreateDate': '2024:05:01 12:30:01', 'IFD0:ModifyDate': '2024:05:02 08:00:00', 'GPS:GPSLatitude': 51.5007, 'GPS:GPSLatitudeRef': 'N', 'GPS:GPSLongitude': 0.1246, 'GPS:GPSLongitudeRef': 'W', 'Composite:GPSLatitude': 51.5007, 'Composite:GPSLongitude': -0.1246, 'Composite:GPSAltitude': 11.2 }]);
test('exiftool: fields, times with zone, signed GPS from the composite tag, personal fields withheld', async () => {
  const t = fakeTools({ programs: { exiftool: () => ({ stdout: EXIF_OUT }) } });
  const f = picked('p.jpg', 'x');
  const r = await runT('exiftool', { file: f }, t);
  assert.equal(r.status, 'ok'); assert.equal(r.network, 'local'); assert.equal(r.requests, 0);
  assert.deepEqual(t.calls.find((c) => c.args).args.slice(0, 5), ['-json', '-G1', '-a', '-n', '-fast2']); assert.equal(t.calls.find((c) => c.args).args.at(-1), f); assert.equal(t.calls.find((c) => c.args).args.at(-2), '--');
  const img = r.results.find((x) => x.entity.type === 'image');
  assert.equal(img.raw.make, 'Acme'); assert.equal(img.raw.mimeType, 'image/jpeg'); assert.equal(img.raw.imageWidth, 640);
  assert.deepEqual(img.raw.personalFieldsWithheld.sort(), ['Artist', 'BodySerialNumber', 'Copyright']);
  assert.ok(!/Zed|123456/.test(txt(r)));
  assert.deepEqual(r.results.filter((x) => x.entity.type === 'event').map((x) => x.raw.kind), ['capture', 'created', 'modified']);
  assert.equal(r.results.find((x) => x.raw && x.raw.kind === 'capture').raw.t, '2024-05-01T11:30:00.000Z');
  assert.equal(r.results.find((x) => x.raw && x.raw.kind === 'modified').raw.zoneStated, false);
  const p = r.results.find((x) => x.entity.type === 'place'); assert.equal(p.entity.value, '51.5007,-0.1246'); assert.equal(p.raw.altitudeM, 11.2);
  const v = await runT('exiftool', { check: 'version' }, fakeTools({ programs: { exiftool: () => ({ stdout: '12.76\n' }) } }));
  assert.equal(v.results[0].entity.value, 'ExifTool available'); assert.equal(v.results[0].raw.version, '12.76');
  assert.equal((await runT('exiftool', { file: f }, fakeTools({ programs: { exiftool: () => ({ stdout: 'oops' }) } }))).status, 'bad-response');
  assert.equal((await runT('exiftool', { file: f }, fakeTools({ programs: { exiftool: () => ({ code: 1, stderr: 'Error: File not found\n' }) } }))).status, 'bad-response');
  assert.equal((await runT('exiftool', { file: path.join(tmp(), 'none.jpg') }, t)).status, 'bad-input');
  assert.equal((await runT('exiftool', {}, t)).status, 'bad-input');
});

const MI_OUT = JSON.stringify({ media: { '@ref': 'x', track: [{ '@type': 'General', Format: 'MPEG-4', Duration: '12.480', OverallBitRate: '2500000', Encoded_Date: 'UTC 2024-05-01 12:30:00', Tagged_Date: 'UTC 2024-05-01 12:30:05', Performer: 'Zed Fixture-Person', Encoded_Application: 'Fixture Encoder 3' }, { '@type': 'Video', Format: 'AVC', CodecID: 'avc1', Width: '1920', Height: '1080', FrameRate: '25.000' }, { '@type': 'Audio', Format: 'AAC', Channels: '2' }] } });
test('mediainfo: container facts, UTC dates, people credited in the file withheld', async () => {
  const r = await runT('mediainfo', { file: picked('v.mp4') }, fakeTools({ programs: { mediainfo: () => ({ stdout: MI_OUT }) } }));
  assert.equal(r.status, 'ok');
  const d = r.results[0]; assert.equal(d.entity.type, 'document'); assert.equal(d.raw.format, 'MPEG-4'); assert.equal(d.raw.durationS, 12.48); assert.equal(d.raw.tracks.length, 2); assert.equal(d.raw.tracks[0].width, 1920); assert.deepEqual(d.raw.personalFieldsWithheld, ['Performer']);
  assert.deepEqual(r.results.filter((x) => x.entity.type === 'event').map((x) => x.raw.t), ['2024-05-01T12:30:00.000Z', '2024-05-01T12:30:05.000Z']);
  assert.ok(!/Zed/.test(txt(r)));
  assert.equal((await runT('mediainfo', { file: picked('v.mp4') }, fakeTools({ programs: { mediainfo: () => ({ stdout: '{"media":null}' }) } }))).status, 'bad-response');
});

test('tesseract and ocrmypdf: text is likely not certain, empty text is uncertain with a reason, heavy lock is taken', async () => {
  const t = fakeTools({ programs: { tesseract: () => ({ stdout: 'Fixture Corp\nInvoice 42\n\f' }) } });
  const f = picked('scan.png');
  const r = await runT('tesseract', { file: f, language: 'deu' }, t);
  assert.equal(r.results[0].confidence, 'likely'); assert.equal(r.results[0].raw.words, 4); assert.equal(r.results[0].raw.language, 'deu'); assert.match(r.results[0].raw.textPreview, /Invoice 42/);
  assert.deepEqual(t.calls.find((c) => c.args).args, [f, 'stdout', '-l', 'deu', '--psm', '3']); assert.ok(t.calls.some((c) => c.heavy));
  const e = await runT('tesseract', { file: f }, fakeTools({ programs: { tesseract: () => ({ stdout: '  \n' }) } }));
  assert.equal(e.results[0].confidence, 'uncertain'); assert.match(e.results[0].uncertaintyNote, /no text was recognised/);
  assert.equal((await runT('tesseract', { file: picked('a.txt') }, t)).status, 'bad-input');
  const ocr = fakeTools({ programs: { ocrmypdf: (args) => { fs.writeFileSync(args[args.indexOf('--sidecar') + 1], 'Scanned page text'); return {}; } } });
  const pdf = picked('scan.pdf', '%PDF-1.4');
  const o = await runT('ocrmypdf', { file: pdf }, ocr);
  assert.equal(o.status, 'ok'); assert.match(o.results[0].raw.textPreview, /Scanned page text/); assert.equal(o.results[0].raw.engine, 'ocrmypdf');
  const a = ocr.calls.find((c) => c.args).args;
  assert.ok(a.includes('--skip-text') && a.at(-2) === pdf);
  assert.ok(!fs.existsSync(path.dirname(a.at(-1))), 'the private temporary folder is removed');
  assert.equal((await runT('ocrmypdf', { file: picked('scan.png') }, ocr)).status, 'bad-input');
});

test('tika: java plus the jar from bin; metadata only; author, last editor and company withheld', async () => {
  const doc = JSON.stringify({ 'Content-Type': 'application/pdf', 'xmpTPg:NPages': '7', 'pdf:producer': 'PDF Lib 2', 'dc:creator': 'Zed Fixture-Person', 'meta:last-author': 'Pat Fixture-Person', Company: 'Fixture Co', 'dcterms:created': '2024-01-02T03:04:05Z', 'dcterms:modified': '2024-02-03T04:05:06Z' });
  const t = fakeTools({ programs: { java: () => ({ stdout: doc }) }, files: { 'tika-app-2.9.2.jar': 1 } });
  const r = await runT('tika', { file: picked('d.pdf') }, t);
  assert.equal(r.status, 'ok'); assert.equal(r.results[0].raw.pages, 7); assert.equal(r.results[0].raw.producer, 'PDF Lib 2');
  assert.deepEqual(r.results[0].raw.personalFieldsWithheld.sort(), ['Company', 'dc:creator', 'meta:last-author']);
  assert.ok(!/Zed|Pat|Fixture Co/.test(txt(r)));
  assert.deepEqual(r.results.filter((x) => x.entity.type === 'event').map((x) => x.raw.t), ['2024-01-02T03:04:05.000Z', '2024-02-03T04:05:06.000Z']);
  const c = t.calls.find((x) => x.args); assert.deepEqual(c.args.slice(0, 3), ['-Djava.awt.headless=true', '-jar', '/fake/bin/tika-app-2.9.2.jar']); assert.ok(c.args.includes('--json'));
  const nojar = await runT('tika', { file: picked('d.pdf') }, fakeTools({ programs: { java: () => ({}) } }));
  assert.equal(nojar.status, 'unavailable'); assert.match(nojar.message, /not installed/);
});

test('ffmpeg-frames: LGPL builds only, frames hashed with their offsets, a timeout is unavailable not a crash', async () => {
  const ff = (build) => fakeTools({ programs: { ffmpeg: (args) => { if (args[0] === '-version') return { stdout: 'ffmpeg version 6.1 ' + build + '\n' }; const out = args.at(-1); for (let i = 1; i <= 3; i++) fs.writeFileSync(out.replace('%04d', String(i).padStart(4, '0')), 'png' + i); return {}; } } });
  const t = ff('configuration: --enable-shared');
  const f = picked('clip.mp4');
  const r = await runT('ffmpeg-frames', { file: f, every: '5', max: '3' }, t);
  assert.equal(r.status, 'ok'); assert.equal(r.results.length, 3);
  assert.deepEqual(r.results.map((x) => x.raw.offsetS), [0, 5, 10]); assert.match(r.results[0].raw.sha256, /^[0-9a-f]{64}$/); assert.equal(r.results[0].entity.type, 'image');
  const a = t.calls.filter((c) => c.args).map((c) => c.args).find((x) => x[0] === '-nostdin');
  assert.ok(a.includes('fps=1/5') && a.includes('3') && a.includes(f));
  assert.ok(!/\/tmp|mf-ghost/.test(r.results.map((x) => x.entity.value).join('')));
  for (const b of ['--enable-gpl', '--enable-nonfree', '--enable-version3']) { const g = await runT('ffmpeg-frames', { file: f }, ff('configuration: ' + b)); assert.equal(g.status, 'unavailable', b); assert.match(g.message, /LGPL/); }
  const slow = await runT('ffmpeg-frames', { file: f }, fakeTools({ programs: { ffmpeg: (args) => (args[0] === '-version' ? { stdout: 'ffmpeg version 6' } : { timedOut: true, code: null }) } }));
  assert.equal(slow.status, 'unavailable'); assert.match(slow.message, /did not finish/);
});

test('gdal-info: raster facts and a footprint centre that says what it is', async () => {
  const out = JSON.stringify({ driverShortName: 'GTiff', size: [1000, 800], bands: [{}, {}, {}], coordinateSystem: { wkt: 'PROJCRS["WGS 84 / UTM zone 30N",BASEGEOGCRS[...]]' }, wgs84Extent: { type: 'Polygon', coordinates: [[[-1, 51], [-1, 52], [1, 52], [1, 51], [-1, 51]]] } });
  const r = await runT('gdal-info', { file: picked('a.tif') }, fakeTools({ programs: { gdalinfo: () => ({ stdout: out }) } }));
  assert.equal(r.results[0].raw.crs, 'WGS 84 / UTM zone 30N'); assert.equal(r.results[0].raw.bands, 3); assert.equal(r.results[0].raw.driver, 'GTiff');
  const p = r.results.find((x) => x.entity.type === 'place'); assert.equal(p.entity.value, '51.5,0'); assert.equal(p.confidence, 'likely'); assert.match(p.raw.note, /not a feature/);
  const none = await runT('gdal-info', { file: picked('a.tif') }, fakeTools({ programs: { gdalinfo: () => ({ stdout: JSON.stringify({ size: [2, 2] }) }) } }));
  assert.equal(none.results.length, 1); assert.ok(none.notes.some((n) => /no geographic footprint/.test(n)));
});

test('qgis-open: only exported case data, started unchanged and detached, never a shell', async () => {
  const t = fakeTools({ programs: { qgis: () => ({}) } });
  const f = picked('case.geojson', '{}');
  const r = await runT('qgis-open', { file: f }, t);
  assert.equal(r.status, 'ok'); assert.deepEqual(t.launches, [{ file: '/fake/bin/qgis', args: ['--nologo', f] }]); assert.equal(r.results[0].raw.openedInQgis, true);
  assert.equal((await runT('qgis-open', { file: picked('run.sh') }, t)).status, 'bad-input'); assert.equal(t.launches.length, 1);
  assert.equal((await runT('qgis-open', { check: 'version' }, t)).results[0].entity.value, 'QGIS available'); assert.equal(t.launches.length, 1, 'the self-check does not start QGIS');
  const fail = fakeTools({ programs: { qgis: () => ({}) } }); fail.launch = async () => ({ ok: false, error: 'EACCES' });
  assert.equal((await runT('qgis-open', { file: f }, fail)).status, 'unavailable');
});

// ---------------- the real program runner, with real stand-in programs ----------------
function script(dir, name, body) { const p = path.join(dir, name); fs.writeFileSync(p, `#!${process.execPath}\n${body}\n`, { mode: 0o755 }); return p; }
test('real runner: finds programs in bin first, argv only, no shell, minimal environment, timeout and output cap', { skip: process.platform === 'win32' }, async () => {
  const bin = tmp('mfd-bin-');
  script(bin, 'echoer', "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort() }));");
  script(bin, 'sleeper', 'setTimeout(()=>{}, 60000);');
  script(bin, 'spammer', "const s='x'.repeat(100000); for(let i=0;i<100;i++) process.stdout.write(s);");
  const t = realTools({ binDirs: [bin], pathEnv: '/nonexistent' });
  assert.equal(t.find(['echoer']), path.join(bin, 'echoer')); assert.equal(t.find(['nothere']), null);
  const marker = path.join(tmp(), 'owned');
  const r = await t.run(t.find(['echoer']), ['; touch ' + marker, '$(id)'], {});
  const o = JSON.parse(r.stdout); assert.deepEqual(o.argv, ['; touch ' + marker, '$(id)']); assert.equal(fs.existsSync(marker), false);
  assert.ok(!o.env.includes('ELECTRON_RUN_AS_NODE')); assert.ok(!o.env.some((k) => /TOKEN|KEY|SECRET/i.test(k)));
  assert.equal((await t.run(t.find(['sleeper']), [], { timeoutMs: 300 })).timedOut, true);
  assert.equal((await t.run(t.find(['spammer']), [], { maxBytes: 50000 })).truncated, true);
  assert.equal((await t.run(path.join(bin, 'missing'), [])).error, 'ENOENT');
  fs.writeFileSync(path.join(bin, 'noexec'), 'x', { mode: 0o644 }); assert.equal(t.find(['noexec']), null);
});
test('real runner: the heavy lock lets one job run at a time and recovers from a dead owner', { skip: process.platform === 'win32' }, async () => {
  const lock = path.join(tmp('mfd-lock-'), 'heavy.lock');
  const t = realTools({ binDirs: [], lockFile: lock, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
  const order = [];
  const job = (n) => t.heavy(async () => { order.push('start' + n); await new Promise((r) => setTimeout(r, 60)); order.push('end' + n); });
  await Promise.all([job(1), job(2), job(3)]);
  for (let i = 0; i < 3; i++) assert.equal(order[i * 2].replace('start', ''), order[i * 2 + 1].replace('end', ''), 'never interleaved: ' + order.join());
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, '2147483000');   // an owner that does not exist
  assert.equal(await t.heavy(async () => 'ok'), 'ok');
  fs.writeFileSync(lock, String(process.pid));   // an owner that is alive: wait, then give up
  await assert.rejects(t.heavy(async () => 'never', { waitMs: 50 }), (e) => e.code === 'HEAVY_BUSY');
  fs.unlinkSync(lock);
});
test('real runner: the --locate install check reports a missing program by exit code', async () => {
  const { main } = require('../src/main/ghost/modules/lib/runtime');
  const out = [], err = []; let code = null;
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, exit: (c) => { code = c; } };
  await main(mods.byId('exiftool'), { argv: ['--locate'], tools: fakeTools(), ...io });
  assert.equal(code, 3); assert.match(err.join(''), /ExifTool is not installed/);
  await main(mods.byId('exiftool'), { argv: ['--locate'], tools: fakeTools({ programs: { exiftool: () => ({}) } }), ...io });
  assert.equal(code, 0);
});

// ---------------- network connectors ----------------
const SNAPS = { items: [{ id: 's1', url: 'https://example.com/page', title: 'Example page', timestamp: '1700000000.1', bookmarked_at: '2023-11-14T22:13:20Z' }, { id: 's2', url: 'javascript:alert(1)' }, { id: 's3', url: 'https://example.com/page#2', timestamp: '1700000100.5' }] };
const ab = (overrides) => ({ overrides });
test('archivebox: only the instance the user names, plain http only on this computer or a private network, token only there', async () => {
  const route = [{ match: { host: '127.0.0.1', path: '/api/v1/core/snapshots' }, json: SNAPS }];
  const f = makeFetch(fixtures, { overrides: route });
  const r = await mods.runModule('archivebox', { instance: 'http://127.0.0.1:8000', url: 'https://example.com/page', token: 'abc.def-1' }, { fetch: f, sleep: noSleep, now: () => NOW });
  assert.equal(r.status, 'ok', r.message);
  assert.deepEqual(r.results.map((x) => x.entity.value), ['https://example.com/page', 'https://example.com/page#2']);
  assert.equal(r.results[0].source.url, 'http://127.0.0.1:8000/archive/1700000000.1/index.html'); assert.equal(r.results[0].raw.savedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(f.log[0], 'http://127.0.0.1:8000/api/v1/core/snapshots?url=https%3A%2F%2Fexample.com%2Fpage&limit=50');
  assert.ok(!JSON.stringify(r).includes('abc.def-1'), 'the token is not in results');
  const calls = []; const spy = async (u, o) => { calls.push([u, o]); return new Response(JSON.stringify({ items: [] })); };
  await mods.runModule('archivebox', { instance: 'https://archive.example.org', url: 'https://example.com/', token: 'tok-1' }, { fetch: spy, sleep: noSleep });
  assert.equal(calls[0][1].headers['x-archivebox-api-key'], 'tok-1'); assert.equal(calls[0][1].credentials, 'omit');
  for (const [inst, why] of [['http://archive.example.org', 'http off this network'], ['http://169.254.169.254', 'metadata address'], ['http://[fe80::1]', 'link-local v6'], ['ftp://x.example', 'scheme'], ['https://u:p@x.example', 'credentials']]) {
    const b = await mods.runModule('archivebox', { instance: inst, url: 'https://example.com/' }, { fetch: spy, sleep: noSleep });
    assert.ok(['bad-input', 'blocked'].includes(b.status), why + ' ' + b.status);
  }
  assert.equal(calls.length, 1, 'no request for refused addresses');
  const redirect = await mods.runModule('archivebox', { instance: 'http://127.0.0.1:8000', url: 'https://example.com/' }, { fetch: async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }), sleep: noSleep });
  assert.equal(redirect.status, 'blocked');
  const auth = await mods.runModule('archivebox', { instance: 'http://127.0.0.1:8000', url: 'https://example.com/' }, { fetch: async () => new Response('{}', { status: 401 }), sleep: noSleep });
  assert.equal(auth.status, 'unavailable'); assert.match(auth.message, /needs an account login/);
  assert.equal((await mods.runModule('archivebox', { instance: 'http://127.0.0.1:8000', url: 'https://example.com/' }, { fetch: async () => new Response('{"a":1}'), sleep: noSleep })).status, 'bad-response');
  assert.equal((await mods.runModule('archivebox', { instance: 'http://127.0.0.1:8000', url: 'not a url' }, { fetch: spy })).status, 'bad-input');
  const st = await mods.runModule('archivebox', { check: 'parser' }, { fetch: spy });
  assert.equal(st.status, 'ok'); assert.equal(st.results[0].entity.value, 'ArchiveBox reader ready'); assert.equal(st.requests, 0);
});

const CMR_COLL = { feed: { entry: [{ id: 'C1000-FIXTURE', title: 'Fixture Surface Reflectance Daily', short_name: 'FIXSR', version_id: '6', data_center: 'FIXTURE_DAAC', time_start: '2000-02-24T00:00:00.000Z', summary: 'A fictional dataset.' }, { id: '../evil', title: 'bad id' }] } };
const CMR_GRAN = { feed: { entry: [{ id: 'G2000-FIXTURE', title: 'FIXSR.A2024100.h18v03', time_start: '2024-04-09T10:00:00.000Z', time_end: '2024-04-09T10:05:00.000Z', collection_concept_id: 'C1000-FIXTURE', data_center: 'FIXTURE_DAAC', links: [{ rel: 'http://esipfed.org/ns/fedsearch/1.1/browse#', href: 'https://browse.example.org/g.png' }, { rel: 'http://esipfed.org/ns/fedsearch/1.1/data#', href: 'https://data.example.org/g.hdf' }] }] } };
test('nasa-cmr: datasets and data files, search only, login needs reported', async () => {
  const f = makeFetch(fixtures, { overrides: [{ match: { host: 'cmr.earthdata.nasa.gov', path: '/search/collections.json' }, json: CMR_COLL }, { match: { host: 'cmr.earthdata.nasa.gov', path: '/search/granules.json' }, json: CMR_GRAN }] });
  const c = await mods.runModule('nasa-cmr', { kind: 'collections', query: 'surface reflectance', bbox: '-1,51,1,52', limit: '5' }, { fetch: f, sleep: noSleep, now: () => NOW });
  assert.equal(c.status, 'ok'); assert.equal(c.results.length, 1); assert.equal(c.results[0].raw.conceptId, 'C1000-FIXTURE'); assert.equal(c.results[0].source.url, 'https://cmr.earthdata.nasa.gov/search/concepts/C1000-FIXTURE.html');
  const u = new URL(f.log[0]); assert.equal(u.searchParams.get('keyword'), 'surface reflectance'); assert.equal(u.searchParams.get('bounding_box'), '-1,51,1,52'); assert.equal(u.searchParams.get('page_size'), '5');
  const g = await mods.runModule('nasa-cmr', { kind: 'granules', query: 'FIXSR', start: '2024-04-01', end: '2024-04-30' }, { fetch: f, sleep: noSleep, now: () => NOW });
  assert.equal(g.results[0].raw.browseImage, 'https://browse.example.org/g.png'); assert.equal(g.results[0].raw.downloadNeedsLogin, true); assert.ok(!JSON.stringify(g.results).includes('data.example.org'));
  assert.equal(new URL(f.log.at(-1)).searchParams.get('temporal'), '2024-04-01T00:00:00Z,2024-04-30T23:59:59Z'); assert.ok(g.notes.some((n) => /needs a free NASA Earthdata login/.test(n)));
  for (const bad of [{ bbox: '5,5,1,1' }, { bbox: '-200,0,1,1' }, { start: '2024-13-45' }]) assert.equal((await mods.runModule('nasa-cmr', { kind: 'granules', query: 'FIXSR', ...bad }, { fetch: f, sleep: noSleep })).status, 'bad-input');
  const login = await mods.runModule('nasa-cmr', { kind: 'collections', query: 'MODIS' }, { fetch: async () => new Response('login', { status: 401 }), sleep: noSleep });
  assert.equal(login.status, 'unavailable'); assert.equal(login.network, 'unavailable'); assert.match(login.message, /needs an account login/);
  const lim = await mods.runModule('nasa-cmr', { kind: 'collections', query: 'MODIS' }, { fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '3' } }), sleep: noSleep });
  assert.equal(lim.network, 'rate-limited');
  assert.equal(f.unmocked.length, 0);
});

const STAC = { features: [{ id: 'LC09_L2SP_201024_20240615_20240617_02_T1', bbox: [-1, 50, 1, 52], properties: { datetime: '2024-06-15T10:55:00Z', 'eo:cloud_cover': 12.5, platform: 'LANDSAT_9' } }, { id: 'LC08_L2SP_201024_20240607_20240615_02_T1', properties: { datetime: '2024-06-07T10:55:00Z', 'eo:cloud_cover': 80, platform: 'LANDSAT_8' } }, { id: '../x' }] };
test('usgs-landsat: public scene search, cloud filter, login need reported honestly', async () => {
  const f = makeFetch(fixtures, { overrides: [{ match: { host: 'landsatlook.usgs.gov', path: '/stac-server/search' }, json: STAC }] });
  const r = await mods.runModule('usgs-landsat', { bbox: '-0.5,51.3,0.3,51.7', start: '2024-06-01', end: '2024-06-30', maxCloud: '50' }, { fetch: f, sleep: noSleep, now: () => NOW });
  assert.equal(r.status, 'ok'); assert.deepEqual(r.results.map((x) => x.entity.value), ['LC09_L2SP_201024_20240615_20240617_02_T1']);
  assert.equal(r.results[0].raw.cloudCoverPercent, 12.5); assert.equal(r.results[0].raw.acquired, '2024-06-15T10:55:00.000Z'); assert.equal(r.results[0].raw.platform, 'LANDSAT_9');
  const u = new URL(f.log[0]); assert.equal(u.searchParams.get('datetime'), '2024-06-01T00:00:00Z/2024-06-30T23:59:59Z'); assert.equal(u.searchParams.get('bbox'), '-0.5,51.3,0.3,51.7');
  assert.ok(r.notes.some((n) => /1 scene\(s\) above 50% cloud cover were left out/.test(n)));
  assert.equal((await mods.runModule('usgs-landsat', { bbox: '1,1,0,0' }, { fetch: f, sleep: noSleep })).status, 'bad-input');
  const login = await mods.runModule('usgs-landsat', { bbox: '-1,50,1,52' }, { fetch: async () => new Response('', { status: 403 }), sleep: noSleep });
  assert.equal(login.status, 'unavailable'); assert.equal(login.network, 'unavailable'); assert.match(login.message, /needs an account login or refused access \(HTTP 403\)/);
  assert.equal((await mods.runModule('usgs-landsat', { bbox: '-1,50,1,52' }, { fetch: async () => new Response('{"type":"x"}'), sleep: noSleep })).status, 'bad-response');
});

test('no new connector can be given a person to look up: the code names no such tools and takes no such input', () => {
  const dir = path.join(__dirname, '..', 'src/main/ghost/modules');
  for (const f of fs.readdirSync(path.join(dir, 'lib'))) { const s = fs.readFileSync(path.join(dir, 'lib', f), 'utf8'); assert.ok(!/gallery-dl|sherlock|maigret|holehe|blackbird|whatsmyname/i.test(s), f); }
  for (const m of mods.MODULES) for (const fld of m.meta.inputs) assert.ok(!/e-?mail|user(name)?|handle|phone|person|people|^name$/i.test(fld.name), m.meta.id + ' ' + fld.name);
});
