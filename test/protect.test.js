'use strict';
// Code protection: developer-tools gating, the start-up integrity check, the Electron fuses, the protected build and the legal files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const PROT = require('../src/main/lib/protect');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfprot-'));

test('developer tools: off in an installed build, on from source, owner switch turns them on', () => {
  assert.equal(PROT.devToolsAllowed({ env: {}, isPackaged: true }), false);
  assert.equal(PROT.devToolsAllowed({ env: {}, isPackaged: false }), true);
  assert.equal(PROT.devToolsAllowed({ env: { MAYFAIR_DESKTOP_DEVTOOLS: '1' }, isPackaged: true }), true);
  assert.equal(PROT.devToolsAllowed({ env: { MAYFAIR_DESKTOP_DEVTOOLS: 'yes' }, isPackaged: true }), false, 'only the exact value 1');
});
test('keys that open developer tools or the page source are recognised, ordinary keys are not', () => {
  const k = (o) => PROT.isDevToolsKey({ type: 'keyDown', ...o });
  assert.ok(k({ key: 'F12' })); assert.ok(k({ key: 'I', control: true, shift: true })); assert.ok(k({ key: 'j', meta: true, shift: true })); assert.ok(k({ key: 'C', control: true, shift: true }));
  assert.ok(k({ key: 'i', meta: true, alt: true })); assert.ok(k({ key: 'u', control: true })); assert.ok(k({ key: 'U', meta: true }));
  assert.ok(!k({ key: 'u' })); assert.ok(!k({ key: 'i', control: true })); assert.ok(!k({ key: 'c', control: true })); assert.ok(!k({ key: 'F11' })); assert.ok(!k({ key: 'r', control: true }));
  assert.ok(!PROT.isDevToolsKey({ type: 'keyUp', key: 'F12' })); assert.ok(!PROT.isDevToolsKey(null));
  assert.ok(PROT.isViewSource('view-source:https://cloud.mayfairmail.com/')); assert.ok(PROT.isViewSource('  VIEW-SOURCE:x')); assert.ok(!PROT.isViewSource('https://cloud.mayfairmail.com/'));
});
test('the Mayfair view is wired to it: no devtools in its web preferences, keys swallowed, view-source refused, tampered build never loads Mayfair', () => {
  const b = read('src/main/browser-service.js');
  assert.match(b, /devTools: this\.devTools/);
  assert.match(b, /if \(!this\.devTools\)/); assert.match(b, /isDevToolsKey/); assert.match(b, /devtools-opened/);
  assert.equal((b.match(/PROT\.isViewSource/g) || []).length, 2, 'will-navigate/redirect and window.open of the Mayfair view');
  assert.match(b, /if \(this\.tampered\)/); assert.match(b, /blocked: devtools/); assert.ok(fs.existsSync(path.join(root, 'src/ui/tampered.html')));
  const m = read('src/main/main.js');
  assert.match(m, /PROT\.verify\(path\.resolve\(__dirname, '\.\.', '\.\.'\)\)/); assert.match(m, /app\.isPackaged \? PROT\.verify/);
  assert.ok(!/toggleDevTools/.test(m.replace(/PROT\.devToolsAllowed[^\]]*\]/, '')), 'the menu item only exists when allowed');
});

test('integrity: a build verifies, and any changed, removed or added file (or manifest) fails it', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'src/main'), { recursive: true }); fs.mkdirSync(path.join(d, 'src/ui'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x"}'); fs.writeFileSync(path.join(d, 'src/main/main.js'), 'a'); fs.writeFileSync(path.join(d, 'src/ui/x.html'), 'b');
  const man = PROT.buildManifest(d); fs.writeFileSync(path.join(d, PROT.MANIFEST), JSON.stringify(man));
  assert.deepEqual(PROT.verify(d), { ok: true, reason: 'ok', bad: [] });
  fs.writeFileSync(path.join(d, 'src/main/main.js'), 'a2'); let r = PROT.verify(d); assert.equal(r.ok, false); assert.deepEqual(r.bad, ['src/main/main.js']);
  fs.writeFileSync(path.join(d, 'src/main/main.js'), 'a');
  fs.writeFileSync(path.join(d, 'src/main/evil.js'), 'x'); r = PROT.verify(d); assert.ok(!r.ok && r.bad.includes('src/main/evil.js'), 'an added file is caught'); fs.rmSync(path.join(d, 'src/main/evil.js'));
  fs.rmSync(path.join(d, 'src/ui/x.html')); r = PROT.verify(d); assert.ok(!r.ok && r.bad.includes('src/ui/x.html'), 'a removed file is caught'); fs.writeFileSync(path.join(d, 'src/ui/x.html'), 'b');
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"y"}'); assert.ok(!PROT.verify(d).ok, 'package.json is covered'); fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x"}');
  const bad = JSON.parse(JSON.stringify(man)); bad.files['src/main/main.js'] = PROT.sha256('zz'); fs.writeFileSync(path.join(d, PROT.MANIFEST), JSON.stringify(bad)); assert.ok(!PROT.verify(d).ok, 'an edited manifest does not match');
  const esc = JSON.parse(JSON.stringify(man)); esc.files['../x'] = 'a'; fs.writeFileSync(path.join(d, PROT.MANIFEST), JSON.stringify(esc)); assert.ok(!PROT.verify(d).ok, 'no path escapes');
  fs.rmSync(path.join(d, PROT.MANIFEST)); r = PROT.verify(d); assert.ok(!r.ok && r.reason === 'no-manifest', 'a missing manifest fails an installed build');
  assert.equal(PROT.verify(d, { requireManifest: false }).ok, true, 'but a run from source skips it');
  fs.writeFileSync(path.join(d, PROT.MANIFEST), '{not json'); assert.ok(!PROT.verify(d).ok);
});

test('fuses: the required ones are set, and after-pack passes them to @electron/fuses', async () => {
  assert.deepEqual(PROT.FUSES, { RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true, GrantFileProtocolExtraPrivileges: true });
  const AP = require('../tools/after-pack');
  const calls = [];
  const fake = { FuseVersion: { V1: 1 }, FuseV1Options: Object.fromEntries(Object.keys(PROT.FUSES).map((k, i) => [k, i])), flipFuses: async (t, w) => { calls.push([t, w]); } };
  const ctx = { appOutDir: '/o', electronPlatformName: 'win32', arch: 1, packager: { appInfo: { productFilename: 'Mayfair Desktop' } } };
  const r = await AP.applyFuses(ctx, fake);
  assert.equal(r.target, path.join('/o', 'Mayfair Desktop.exe')); assert.equal(calls.length, 1);
  const w = calls[0][1]; Object.keys(PROT.FUSES).forEach((k, i) => assert.equal(w[i], PROT.FUSES[k], k));
  assert.equal(AP.executableFor({ ...ctx, electronPlatformName: 'darwin' }), path.join('/o', 'Mayfair Desktop.app'));
  assert.equal((await AP.applyFuses({ ...ctx, electronPlatformName: 'darwin', arch: 3 }, fake)).wire.resetAdHocDarwinSignature, true);
  const had = process.env.MAYFAIR_ALLOW_UNFUSED; delete process.env.MAYFAIR_ALLOW_UNFUSED;
  await assert.rejects(() => AP.applyFuses(ctx, null), /@electron\/fuses is not installed|Cannot find|fuses|ENOENT/, 'no silent unprotected installer');
  if (had !== undefined) process.env.MAYFAIR_ALLOW_UNFUSED = had;
});
test('file:// pages use nothing that GrantFileProtocolExtraPrivileges=false would take away', () => {
  for (const f of fs.readdirSync(path.join(root, 'src/ui')).filter((x) => /\.(js|html)$/.test(x))) {
    const s = read('src/ui/' + f);
    assert.ok(!/\bfetch\s*\(|localStorage|sessionStorage|XMLHttpRequest|indexedDB|serviceWorker|type="module"|\bimport\s*\(/.test(s), f + ' needs file:// privileges');
  }
});
test('packaging: protected tree, afterPack fuses, asar on, notices shipped, no source maps', () => {
  const p = require('../package.json'), b = p.build;
  assert.equal(b.asar, true); assert.equal(b.afterPack, 'tools/after-pack.js'); assert.equal(b.extraMetadata.main, 'build-protected/src/main/main.js');
  assert.ok(b.files.includes('build-protected/**/*') && b.files.includes('!**/*.map') && !b.files.includes('src/**/*'), 'the installer is made from build-protected, not from src');
  for (const s of ['dist', 'dist:win', 'dist:mac', 'dist:linux']) assert.match(p.scripts[s], /gen-notices\.js && node tools\/protect\.js && electron-builder/, s);
  assert.ok(b.extraResources.some((e) => e.from === 'LICENSE.txt') && b.extraResources.some((e) => e.from === 'THIRD_PARTY_NOTICES.txt'));
  assert.ok(p.devDependencies['@electron/fuses']); assert.match(b.copyright, /All rights reserved/); assert.match(read('.gitignore'), /build-protected/);
  assert.ok(!fs.readdirSync(path.join(root, 'src'), { recursive: true }).some((f) => String(f).endsWith('.map')), 'no source maps in the source tree');
});

for (const engine of ['strip', 'auto']) {
  test('protected build (' + engine + ' engine): minified, bannered, no source maps, integrity verifies, still valid JavaScript', () => {
    const out = path.join(tmp(), 'bp');
    const r = require('../tools/protect').run({ engine, quiet: true, out });
    assert.ok(r.files >= 20 && r.after < r.before, `${r.before} -> ${r.after}`);
    if (engine === 'strip') assert.equal(r.engine, 'strip');
    assert.deepEqual(PROT.verify(out), { ok: true, reason: 'ok', bad: [] });
    const main = fs.readFileSync(path.join(out, 'src/main/main.js'), 'utf8');
    assert.ok(main.startsWith('/*! (c) ') && /All rights reserved/.test(main.split('\n')[0]));
    assert.ok(!/sourceMappingURL/.test(main) && !/\n\s*\/\/ /.test(main) && main.split('\n').length < 20, 'comments gone, lines collapsed');
    for (const f of PROT.listFiles(out).filter((x) => x.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(out, f)]);
    assert.ok(fs.existsSync(path.join(out, 'LICENSE.txt')) && fs.existsSync(path.join(out, 'THIRD_PARTY_NOTICES.txt')) && fs.existsSync(path.join(out, 'assets/icon.png')));
    fs.appendFileSync(path.join(out, 'src/main/browser-service.js'), '\n/*x*/'); assert.ok(!PROT.verify(out).ok, 'editing the protected copy is detected');
  });
}
test('the strip engine keeps the syntax tree identical (templates, regexes, ASI, return/newline)', () => {
  const { strip, shape } = require('../tools/minify');
  const cases = ['a=1\nb=2\n;[1].map(x=>x)', 'function f(){return\n1}', 'x=`a${ b }${ c }d`;y=/=\\//g.test("//");z=a/b/c', 'let a=1;\n++a\nb=a++\n+c', 'if(a)b\nelse c', 'var s="/*",t=\'//\';/* c */ // d\nq=1', 'a = b\n(c)', 'x = a ? .5 : 1; y = 1 .toString(); z = a - -b; w = a + +b; v = a+ ++b', 'for(const x of y)z()\nlabel:for(;;)break label'];
  for (const c of cases) assert.equal(shape(strip(c)), shape(c), JSON.stringify(c));
});

test('legal files: licence says all rights reserved, notices are generated and list the open source parts', () => {
  const lic = read('LICENSE.txt');
  assert.match(lic, /All rights reserved/); assert.match(lic, /reverse engineer/i); assert.match(lic, /redistribut/i); assert.match(lic, /own\s+licences/);
  execFileSync(process.execPath, [path.join(root, 'tools/gen-notices.js')]);   /* the notices file is generated (not committed), so make it first */
  execFileSync(process.execPath, [path.join(root, 'tools/gen-notices.js'), '--check']);
  const n = read('THIRD_PARTY_NOTICES.txt');
  for (const k of ['Electron', 'Chromium', 'tor (the Tor daemon)', 'BSD-3-Clause', '@ghostery/adblocker', 'MPL-2.0', 'EasyList', 'uBlock filters', 'electron-updater', 'MIT']) assert.ok(n.includes(k), k);
  const lists = require('../src/main/lib/filter-lists.json').lists;
  for (const l of lists) assert.ok(n.includes(l.credit.split(' ')[0]), 'every filter list credit appears: ' + l.id);
  assert.match(read('src/main/lib/about.js'), /THIRD_PARTY_NOTICES\.txt/);
});
test('no secrets in the shipped code: no keys, tokens or private key blocks', () => {
  const pats = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/, /\bsk-[A-Za-z0-9]{20,}/, /\bghp_[A-Za-z0-9]{30,}/, /xox[abp]-[A-Za-z0-9-]{10,}/, /AIza[0-9A-Za-z_-]{35}/, /(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i];
  for (const f of PROT.listFiles(root, 'src').concat(['package.json', 'tools/after-pack.js', 'tools/protect.js']).filter((x) => /\.(js|json|html)$/.test(x))) {
    const s = read(f); for (const p of pats) assert.ok(!p.test(s), f + ' matches ' + p);
  }
});
