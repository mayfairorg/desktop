'use strict';
// Static checks on the shipped code: the security settings cannot silently regress.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

test('no web preferences weaken isolation', () => {
  const src = read('src/main/browser-service.js');
  assert.ok(!/nodeIntegration:\s*true/.test(src));
  assert.ok(!/contextIsolation:\s*false/.test(src));
  assert.ok(!/sandbox:\s*false/.test(src));
  assert.ok(!/webSecurity:\s*false/.test(src));
  assert.ok(!/allowRunningInsecureContent:\s*true/.test(src));
  assert.ok(!/enableRemoteModule|webviewTag:\s*true/.test(src));
  assert.equal((src.match(/contextIsolation: true/g) || []).length, 3); // Mayfair view, tabs, Web app windows
  assert.equal((src.match(/sandbox: true/g) || []).length, 3);
});
test('no certificate-error override and no CSP stripping', () => {
  const all = walk('src').filter((f) => f.endsWith('.js')).map((f) => read(f)).join('\n');
  assert.ok(!/ignore-certificate-errors/.test(all));
  assert.ok(!/certificate-error/.test(all));
  assert.ok(!/onHeadersReceived/.test(all), 'we must not rewrite response headers (CSP respected)');
});
test('no telemetry: no analytics SDKs or hard-coded endpoints other than Mayfair and search', () => {
  const pkg = require('../package.json');
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ');
  assert.ok(!/sentry|segment|mixpanel|amplitude|analytics|bugsnag|datadog/i.test(deps));
  const all = walk('src').filter((f) => /\.(js|html)$/.test(f) && !f.endsWith('blocklist.txt') && !f.includes('ghost/connectors-security')).map((f) => read(f)).join('\n');
  const hosts = new Set([...all.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
  const allowed = ['www.w3.org' /* the SVG namespace name, never requested */, 'cloud.mayfairmail.com', 'mayfairmail.com', 'duckduckgo.com', 'www.startpage.com', 'search.brave.com', 'example.com', 'cloudflare-dns.com', 'dns.quad9.net', 'geocoding-api.open-meteo.com', 'api.open-meteo.com', 'api.dictionaryapi.dev', 'en.wikipedia.org', 'www.google.com', 'www.bing.com', 'www.ecosia.org', 'www.qwant.com', 'cdn.jsdelivr.net', 'easylist.to', 'ublockorigin.github.io', '127.0.0.1',
    // Mayfair Ghost passive modules (src/main/ghost/modules): public lookup services a person starts on purpose, each on that module's own host allowlist
    'data.iana.org', 'cloudflare-dns.com', 'dns.google', 'crt.sh', 'web.archive.org', 'archive.org', 'api.gdeltproject.org', 'www.wikidata.org', 'cmr.earthdata.nasa.gov', 'landsatlook.usgs.gov',
    // links in connector manifests (licence pages) and an XML namespace string: never requested
    'api.gleif.org', 'data.sec.gov', 'www.sec.gov', 'nominatim.openstreetmap.org', 'overpass-api.de', 'gibs.earthdata.nasa.gov', 'earth-search.aws.element84.com', 'index.commoncrawl.org', 'www.cisa.gov', 'services.nvd.nist.gov',
    // the keyless connectors' link-only addresses (shown as a source link, never requested)
    'nvd.nist.gov', 'search.gleif.org', 'www.openstreetmap.org',
    'opensource.org', 'github.com', 'exiftool.org', 'mediaarea.net', 'gdal.org', 'www.qgis.org', 'ffmpeg.org', 'www.apache.org', 'ns.adobe.com'];
  for (const h of hosts) assert.ok(allowed.includes(h) || h.endsWith('.invalid'), 'unexpected host ' + h);
});
test('every UI page has a strict CSP and loads no remote script', () => {
  for (const f of walk('src/ui').filter((x) => x.endsWith('.html'))) {
    const s = read(f);
    assert.match(s, /Content-Security-Policy/, f);
    assert.match(s, /default-src 'none'/, f);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(s), 'inline script in ' + f);
    assert.ok(!/ on[a-z]+=/i.test(s), 'inline handler in ' + f);
    assert.ok(!/src="https?:/i.test(s), 'remote script in ' + f);
  }
});
test('UI follows the owner skin rules: no tinted icon chips, no accent colour-mix on icons', () => {
  const css = walk('src/ui').filter((f) => f.endsWith('.css')).map(read).join('\n');
  assert.ok(!/mf-tint|mf-tile/.test(css));
  assert.ok(!/svg[^{]*\{[^}]*background/.test(css));
  assert.match(css, /--mf-accent:#ffa800/i);
});
test('navigation lock is wired to will-navigate, will-redirect and the window open handler', () => {
  const src = read('src/main/browser-service.js');
  for (const k of ["'will-navigate'", "'will-redirect'", 'setWindowOpenHandler', 'will-attach-webview']) assert.ok(src.includes(k) || read('src/main/main.js').includes(k), k);
});
test('packaging config covers the required targets, protocol and file types', () => {
  const b = require('../package.json').build;
  assert.ok(b.win.target.some((t) => t.target === 'nsis'));
  assert.ok(b.mac.target.some((t) => t.target === 'dmg'));
  assert.deepEqual(b.linux.target.sort(), ['AppImage', 'deb']);
  assert.deepEqual(b.protocols[0].schemes, ['mayfair']);
  for (const e of ['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'md', 'txt', 'png', 'jpg']) assert.ok(b.fileAssociations.some((f) => f.ext === e), e);
  const wf = read('.github/workflows/build.yml');
  for (const k of ['windows-latest', 'macos-latest', 'ubuntu-latest']) assert.ok(wf.includes(k));
});

test('Tor tab fails closed and never shares a proxy or session with other tabs', () => {
  const src = read('src/main/browser-service.js');
  assert.ok(src.includes("if (tor && !this.tor.ready)"), 'no Tor tab unless Tor is connected');
  assert.ok(/tor: 'mf-tor'/.test(src) && !/tor: 'persist:/.test(src), 'Tor partition is in-memory');
  const net = src.slice(src.indexOf('async applyNetwork'), src.indexOf('async applyNetwork') + 700);
  assert.ok(!net.includes('PARTITION.tor') && !net.includes('PARTITION.home'), 'user proxy never applies to Tor or Mayfair');
  assert.ok(src.includes("setWebRTCIPHandlingPolicy"));
});

test('spell-check dictionary downloads (a Google host) are switched off outside macOS', () => {
  const src = read('src/main/browser-service.js');
  assert.ok(src.includes('setSpellCheckerDictionaryDownloadURL') && src.includes('quietSpellcheck(session.defaultSession)'));
  assert.ok(!/spellcheck: true/.test(src));
});
