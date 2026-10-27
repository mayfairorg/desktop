'use strict';
// Stands in for qemu-img. Keeps its state in <image>.fake.json next to the image: {encrypted, snapshots:[{name,date-sec}]}, and logs every call.
// A key given as --object secret,...,file=<path> is read from that path; its length is logged, never its value.
const fs = require('node:fs');
const a = process.argv.slice(2);
const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'qemu-img', ...o }) + '\n'); };
const sub = a[0];
const oi = a.indexOf('--object');
let keyLen = null;
if (oi >= 0) { const m = /file=([^,]+)/.exec(a[oi + 1]); try { keyLen = fs.readFileSync(m[1].replace(/,,/g, ',')).length; } catch { keyLen = -1; } }
const imgOpt = a.indexOf('--image-opts') >= 0 ? a[a.indexOf('--image-opts') + 1] : null;
const target = imgOpt ? /file\.filename=([^,]+)/.exec(imgOpt)[1] : null;
const st = (f) => { try { return JSON.parse(fs.readFileSync(f + '.fake.json', 'utf8')); } catch { return null; } };
const put = (f, s) => fs.writeFileSync(f + '.fake.json', JSON.stringify(s));
log({ sub, args: a.filter((x) => !/^secret/.test(x)), keyLen });
if (process.env.FAKE_IMG_FAIL === sub) { process.stderr.write('qemu-img: fake failure\n'); process.exit(1); }
if (sub === 'create') {
  const size = a[a.length - 1], file = a[a.length - 2];
  fs.writeFileSync(file, 'fake qcow2 ' + size);
  put(file, { encrypted: oi >= 0 && a.some((x) => /encrypt\.format=luks/.test(x)), snapshots: [] });
  process.exit(0);
}
const s = st(target);
if (!s) { process.stderr.write('qemu-img: Could not open: no such file\n'); process.exit(1); }
if (s.encrypted && keyLen === null) { process.stderr.write('qemu-img: Image is encrypted but no key was given\n'); process.exit(1); }
if (!s.encrypted && keyLen !== null) { process.stderr.write('qemu-img: key given for an unencrypted image\n'); process.exit(1); }
if (sub === 'info') { process.stdout.write(JSON.stringify({ snapshots: s.snapshots })); process.exit(0); }
if (sub === 'snapshot') {
  const flag = a[a.indexOf('--image-opts') - 2], name = a[a.indexOf('--image-opts') - 1];
  if (flag === '-c') s.snapshots.push({ name, 'date-sec': 1700000000 + s.snapshots.length });
  else if (flag === '-d') s.snapshots = s.snapshots.filter((x) => x.name !== name);
  else if (flag === '-a' && !s.snapshots.some((x) => x.name === name)) { process.stderr.write('qemu-img: Snapshot not found\n'); process.exit(1); }
  put(target, s); process.exit(0);
}
process.exit(2);
