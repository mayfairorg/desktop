'use strict';
// Writes vm-index.json for a release. Run by .github/workflows/ghost-vm-image.yml after the assets are built:
//   node tools/ghost-vm/image/make-index.js <assets folder> <owner/repo> <release tag> [version]
// The folder holds: qemu-<platform>-<arch>.zip (one per host system), kernel-<arch>, initrd-<arch>, base-<arch>.qcow2.
// Every entry gets its size and SHA-256 here, so the app can refuse a file that was changed or swapped after publishing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GUEST = { x64: 'x86_64', arm64: 'aarch64' };

function sha256(file) { const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(1 << 20); try { for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); } return h.digest('hex'); }

function build({ dir, repo, tag, version = tag }) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) || !/^[A-Za-z0-9._-]{1,80}$/.test(tag)) throw new Error('bad repository or tag');
  const asset = (name, extra = {}) => {
    const f = path.join(dir, name);
    const st = fs.statSync(f);
    return { url: 'https://github.com/' + repo + '/releases/download/' + tag + '/' + encodeURIComponent(name), sha256: sha256(f), size: st.size, ...extra };
  };
  const idx = { schema: 1, published: true, releaseTag: tag, qemu: {}, images: {} };
  for (const name of fs.readdirSync(dir).sort()) {
    const m = /^qemu-(linux|darwin|win32)-(x64|arm64)\.zip$/.exec(name);
    if (!m) continue;
    const exe = m[1] === 'win32' ? '.exe' : '', g = GUEST[m[2]];
    idx.qemu[m[1] + '-' + m[2]] = asset(name, { exec: ['qemu-system-' + g + exe, 'qemu-img' + exe] });
  }
  for (const g of Object.values(GUEST)) {
    if (!fs.existsSync(path.join(dir, 'base-' + g + '.qcow2'))) continue;
    idx.images[g] = { version, kernel: asset('kernel-' + g), initrd: asset('initrd-' + g), disk: asset('base-' + g + '.qcow2') };
  }
  if (!Object.keys(idx.qemu).length || !Object.keys(idx.images).length) throw new Error('the folder needs at least one qemu package and one image');
  return idx;
}

if (require.main === module) {
  const [dir, repo, tag, version] = process.argv.slice(2);
  if (!dir || !repo || !tag) { console.error('usage: make-index.js <assets folder> <owner/repo> <tag> [version]'); process.exit(2); }
  const idx = build({ dir, repo, tag, version });
  fs.writeFileSync(path.join(dir, 'vm-index.json'), JSON.stringify(idx, null, 2) + '\n');
  console.log('wrote vm-index.json: ' + Object.keys(idx.qemu).length + ' qemu packages, ' + Object.keys(idx.images).length + ' images');
}
module.exports = { build };
