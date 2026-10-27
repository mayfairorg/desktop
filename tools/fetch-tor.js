'use strict';
// Downloads the "Tor Expert Bundle" (the tor daemon, not Tor Browser) from the Tor Project's
// official archive, checks its SHA-256 against the Project's signed checksum list (and the
// OpenPGP signature when gpg is installed), and unpacks it to vendor/tor/<os>-<arch>/.
// Usage: node tools/fetch-tor.js <win|mac|linux> <x64|arm64> [version]
// Needs network access to archive.torproject.org and dist.torproject.org.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

let [plat, arch, ver = process.env.TOR_BUNDLE_VERSION] = process.argv.slice(2);
if (!['win', 'mac', 'linux'].includes(plat) || !['x64', 'arm64'].includes(arch)) {
  console.error('Usage: node tools/fetch-tor.js <win|mac|linux> <x64|arm64> <version>   (or set TOR_BUNDLE_VERSION, e.g. the current Tor Browser stable version)'); process.exit(2);
}
// No version given: ask the Tor Project which Tor Browser release is current (its own update feed), else read its package archive index.
const findVersion = async () => {
  try { const j = JSON.parse((await get('https://aus1.torproject.org/torbrowser/update_3/release/downloads.json')).toString()); if (/^\d+\.\d+(\.\d+)?$/.test(j.version)) return j.version; } catch { /* try the archive */ }
  const idx = (await get('https://archive.torproject.org/tor-package-archive/torbrowser/')).toString();
  const all = [...idx.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\/"/g)].map((m) => m[1]);
  all.sort((a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); } return 0; });
  if (!all.length) throw new Error('could not find a current Tor version');
  return all[0];
};
const osName = { win: 'windows', mac: 'macos', linux: 'linux' }[plat];
const archName = { x64: 'x86_64', arm64: 'aarch64' }[arch];
let base, file;
const out = path.join(__dirname, '..', 'vendor', 'tor', `${plat}-${arch}`);
const tmp = path.join(__dirname, '..', 'vendor', '.dl'); fs.mkdirSync(tmp, { recursive: true });

const get = (url) => new Promise((res, rej) => https.get(url, (r) => {
  if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return res(get(new URL(r.headers.location, url).toString()));
  if (r.statusCode !== 200) { r.resume(); return rej(new Error(`${url} -> HTTP ${r.statusCode}`)); }
  const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res(Buffer.concat(c)));
}).on('error', rej));

(async () => {
  if (!ver) { ver = await findVersion(); console.log('current Tor version', ver); }
  base = `https://archive.torproject.org/tor-package-archive/torbrowser/${ver}/`;
  file = `tor-expert-bundle-${osName}-${archName}-${ver}.tar.gz`;
  const [tgz, sums, asc] = await Promise.all([get(base + file), get(base + 'sha256sums-signed-build.txt'), get(base + 'sha256sums-signed-build.txt.asc').catch(() => null)]);
  const want = (sums.toString().split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1] === file) || [])[0];
  const have = crypto.createHash('sha256').update(tgz).digest('hex');
  if (!want || want !== have) throw new Error(`SHA-256 mismatch for ${file}: expected ${want}, got ${have}`);
  console.log('sha256 ok', have);
  fs.writeFileSync(path.join(tmp, 'sums.txt'), sums);
  if (asc) {
    fs.writeFileSync(path.join(tmp, 'sums.txt.asc'), asc);
    try {
      // Tor Browser Developers signing key (fingerprint published at https://support.torproject.org/tbb/how-to-verify-signature/)
      execFileSync('gpg', ['--batch', '--keyserver', 'hkps://keys.openpgp.org', '--recv-keys', 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290'], { stdio: 'inherit' });
      execFileSync('gpg', ['--batch', '--verify', path.join(tmp, 'sums.txt.asc'), path.join(tmp, 'sums.txt')], { stdio: 'inherit' });
      console.log('gpg signature ok');
    } catch (e) { if (process.env.REQUIRE_GPG === '1') throw e; console.warn('gpg check skipped or failed (set REQUIRE_GPG=1 to make this fatal):', e.message); }
  }
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(tmp, file), tgz);
  execFileSync('tar', ['-xzf', path.join(tmp, file), '-C', out], { stdio: 'inherit' });
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'licenses', 'TOR-NOTICE.txt'), path.join(out, 'TOR-NOTICE.txt'));
  const exe = plat === 'win' ? 'tor.exe' : 'tor';
  const bin = [path.join(out, 'tor', exe), path.join(out, exe)].find(fs.existsSync);
  if (!bin) throw new Error('tor binary not found after unpacking');
  if (plat !== 'win') fs.chmodSync(bin, 0o755);
  console.log('tor installed at', bin);
})().catch((e) => { console.error('fetch-tor failed:', e.message); process.exit(1); });
