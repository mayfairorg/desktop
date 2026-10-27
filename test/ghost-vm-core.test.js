'use strict';
// Ghost virtual computer, the pure parts: the QEMU command line per system, accelerator choice (with a fake qemu), the one shared folder,
// the pinned download with a mocked fetch, and the index builder. No real QEMU and no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp, FAKE_QEMU, launcher, makeZip, sha, fakeFetch } = require('./ghost-vm-helpers');
const A = require('../src/main/ghost/vm/argv');
const P = require('../src/main/ghost/vm/platform');
const S = require('../src/main/ghost/vm/share');
const I = require('../src/main/ghost/vm/images');

const base = (o = {}) => ({ platform: 'linux', guest: 'x86_64', accel: 'kvm', memMb: 2048, cpus: 2, kernel: '/k', initrd: '/i', baseDisk: '/b.qcow2', overlay: '/o.qcow2', toolsDisk: '/t.qcow2', share: { dir: '/s', mode: '9p' }, token: 'ab'.repeat(24), channels: { agent: { path: '/a.sock' }, net: { path: '/n.sock' } }, ...o });
const has = (argv, ...seq) => argv.some((_, i) => seq.every((s, j) => argv[i + j] === s));

test('argv: the machine has no network card, display, USB, clipboard or host devices, on every system', () => {
  for (const [platform, accel, guest] of [['linux', 'kvm', 'x86_64'], ['linux', 'tcg', 'x86_64'], ['darwin', 'hvf', 'aarch64'], ['darwin', 'tcg', 'x86_64'], ['win32', 'whpx', 'x86_64'], ['win32', 'tcg', 'x86_64'], ['linux', 'kvm', 'aarch64']]) {
    const argv = A.buildArgv(base({ platform, accel, guest, share: { dir: 'C:\\s', mode: A.shareMode(platform) } }));
    assert.deepEqual(A.selfCheck(argv), [], platform + '/' + accel);
    assert.ok(has(argv, '-nodefaults') && has(argv, '-nic', 'none') && has(argv, '-display', 'none') && has(argv, '-monitor', 'none'), platform);
    assert.ok(!argv.some((x) => /usb|virtio-net|e1000|hostfwd|vnc|spice|vdagent|clipboard/i.test(x)), platform);
  }
});
test('argv: accelerator and CPU per system', () => {
  const a = (o) => A.buildArgv(base(o));
  assert.ok(has(a({ accel: 'kvm' }), '-accel', 'kvm', '-cpu', 'host'));
  assert.ok(has(a({ platform: 'darwin', accel: 'hvf', guest: 'aarch64' }), '-machine', 'virt', '-accel', 'hvf', '-cpu', 'host'));
  assert.ok(has(a({ platform: 'win32', accel: 'whpx', share: { dir: 'C:\\s', mode: 'fat' } }), '-accel', 'whpx'));
  assert.ok(has(a({ accel: 'tcg' }), '-accel', 'tcg,thread=multi', '-cpu', 'max'));
  assert.ok(has(a({ guest: 'aarch64', accel: 'kvm' }), '-machine', 'virt,gic-version=host'));
  assert.throws(() => A.machine({ guest: 'riscv', accel: 'tcg' }), /Unsupported/);
});
test('argv: resource caps are clamped, and half the host memory is the most that is offered', () => {
  assert.deepEqual(A.resources({ memMb: 99999, cpus: 99, hostMemMb: 16000, hostCpus: 16 }), { memMb: 8000, cpus: 4 });
  assert.deepEqual(A.resources({ memMb: 1, cpus: 0, hostMemMb: 16000 }), { memMb: 512, cpus: 1 });
  assert.deepEqual(A.resources({ hostMemMb: 4096, hostCpus: 8 }), { memMb: 2048, cpus: 4 });
  const argv = A.buildArgv(base({ memMb: 777, cpus: 3 }));
  assert.ok(has(argv, '-m', '777M', '-smp', '3'));
});
test('argv: one shared folder only; 9p on Linux and macOS, FAT on Windows; commas in a path cannot add options', () => {
  const nine = A.buildArgv(base({ share: { dir: '/data/a,b', mode: '9p' } }));
  const fs0 = nine.filter((x, i) => nine[i - 1] === '-fsdev');
  assert.equal(fs0.length, 1);
  assert.equal(fs0[0], 'local,id=fs0,path=/data/a,,b,security_model=mapped-xattr');
  assert.equal(A.buildArgv(base({ platform: 'darwin', accel: 'hvf', share: { dir: '/s', mode: '9p' } })).find((x) => x.startsWith('local,id=fs0')), 'local,id=fs0,path=/s,security_model=none');
  assert.equal(A.shareMode('win32'), 'fat'); assert.equal(A.shareMode('linux'), '9p'); assert.equal(A.shareMode('darwin'), '9p');
  const fat = A.buildArgv(base({ platform: 'win32', accel: 'whpx', share: { dir: 'C:\\case\\shared', mode: 'fat' } }));
  assert.ok(fat.includes('file=fat:rw:C:\\case\\shared,format=raw,if=none,id=share'));
  assert.ok(!fat.includes('-fsdev'));
  const none = A.buildArgv(base({ share: null }));
  assert.ok(!none.includes('-fsdev') && !none.some((x) => /^file=fat:/.test(x)));
  // a second folder, even by a mistake in this file, is caught by the self-check
  assert.deepEqual(A.selfCheck([...nine, '-fsdev', 'local,id=fs1,path=/home/me,security_model=none']), ['more than one shared folder']);
  assert.ok(A.selfCheck(['-nic', 'user', '-usb', '-device', 'virtio-net-pci,netdev=x', '-netdev', 'user,id=x,hostfwd=tcp::22-:22']).length >= 4);
});
test('argv: keys reach QEMU only as file names (never as text), the token is on the kernel line, and the sandbox is Linux only', () => {
  const argv = A.buildArgv(base({ keyFiles: { root: '/dev/fd/3', tools: '/dev/fd/4' }, sandbox: true }));
  assert.ok(argv.includes('secret,id=sec0,file=/dev/fd/3') && argv.includes('secret,id=sec1,file=/dev/fd/4'));
  assert.ok(argv.some((x) => /encrypt\.key-secret=sec0/.test(x)) && argv.some((x) => /encrypt\.key-secret=sec1/.test(x)));
  assert.ok(argv.includes('-sandbox'));
  assert.ok(!A.buildArgv(base({ platform: 'darwin', accel: 'hvf', sandbox: true })).includes('-sandbox'));
  assert.ok(argv.find((x) => x.startsWith('console=')).includes('ghost.token=' + 'ab'.repeat(24)));
  // the base image is read-only and named explicitly
  assert.ok(argv.includes('driver=file,node-name=basef,filename=/b.qcow2,read-only=on'));
});

// ---- accelerator detection, with a fake qemu program that answers the probe
test('platform: each system tries its own accelerators in order and falls back to slow software emulation with a plain notice', async () => {
  const d = tmp(); const qemu = launcher(d, 'qemu-system-x86_64', FAKE_QEMU);
  const run = async (platform, arch, accels, hint) => P.detectAccel({ platform, arch, hint: hint || (async () => ({ ok: true, reason: '' })), probe: P.qemuProbe(qemu, { env: { FAKE_ACCEL: accels, FAKE_LOG: path.join(d, 'log') } }) });
  assert.equal((await run('linux', 'x64', 'kvm')).accel, 'kvm');
  assert.equal((await run('darwin', 'arm64', 'hvf')).accel, 'hvf');
  const w = await run('win32', 'x64', 'whpx'); assert.equal(w.accel, 'whpx'); assert.equal(w.fast, true);
  const hax = await run('win32', 'x64', 'hax'); assert.equal(hax.accel, 'hax');
  assert.equal((await run('win32', 'arm64', 'hax')).accel, 'tcg');
  const slow = await run('linux', 'x64', '');
  assert.equal(slow.accel, 'tcg'); assert.equal(slow.fast, false); assert.equal(slow.hardware, false);
  assert.match(slow.notice, /much slower/); assert.match(slow.notice, /Chromebooks/); assert.match(slow.notice, /KVM: .*accelerator does not exist/);
  const noKvm = await run('linux', 'x64', 'kvm', async () => ({ ok: false, reason: 'there is no /dev/kvm (virtualization is off in the firmware, or this is a container or a machine inside a machine)' }));
  assert.equal(noKvm.accel, 'tcg'); assert.match(noKvm.notice, /no \/dev\/kvm/);
  // the probe starts the program with no machine and never a shell
  const lines = fs.readFileSync(path.join(d, 'log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.probe === 'kvm' && l.ok === true));
  assert.equal((await P.detectAccel({ platform: 'freebsd', arch: 'x64', probe: async () => ({ ok: true }) })).supported, false);
  assert.equal((await P.detectAccel({ platform: 'linux', arch: 'ia32', probe: async () => ({ ok: true }) })).supported, false);
});
test('platform: a program that cannot start is reported, not trusted; /dev/kvm checks give the reason', async () => {
  const r = await P.qemuProbe('/nonexistent/qemu', {})('kvm'); assert.equal(r.ok, false); assert.match(r.reason, /cannot start the QEMU program/);
  const no = await P.hostHint('kvm', { access: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } }); assert.equal(no.ok, false); assert.match(no.reason, /no \/dev\/kvm/);
  const perm = await P.hostHint('kvm', { access: () => { const e = new Error('x'); e.code = 'EACCES'; throw e; } }); assert.match(perm.reason, /kvm group/);
  assert.equal((await P.hostHint('hvf', { sysctl: async () => '0\n' })).ok, false);
  assert.equal((await P.hostHint('hvf', { sysctl: async () => '1' })).ok, true);
  assert.equal(P.qemuName('x64', 'win32'), 'qemu-system-x86_64.exe'); assert.equal(P.qemuName('arm64', 'darwin'), 'qemu-system-aarch64');
});

// ---- the one shared folder
test('share: always <vm>/cases/<case>/shared inside the data folder; never anything else', () => {
  const b = tmp(); const real = S.ensureShare(b, 'case-1');
  assert.equal(real, fs.realpathSync(path.join(b, 'cases', 'case-1', 'shared')));
  assert.equal(S.ensureShare(b, 'case-1'), real);
  for (const bad of ['../x', 'a/b', '..', '', 'a b', 'x'.repeat(41), '/etc', 'C:\\x']) assert.throws(() => S.ensureShare(b, bad), /Case id/, bad);
  assert.ok(real.startsWith(fs.realpathSync(b) + path.sep));
  assert.ok(!real.startsWith(require('node:os').homedir() + path.sep + 'Documents'));
});
test('share: a link in place of the folder, or a case folder that is a link out, is refused', () => {
  const b = tmp(), out = tmp('mfd-outside-');
  fs.mkdirSync(path.join(b, 'cases', 'c1'), { recursive: true });
  fs.symlinkSync(out, path.join(b, 'cases', 'c1', 'shared'));
  assert.throws(() => S.ensureShare(b, 'c1'), (e) => e.code === 'share-unsafe');
  fs.writeFileSync(path.join(b, 'cases', 'f.txt'), 'x'); fs.mkdirSync(path.join(b, 'cases', 'c3'), { recursive: true }); fs.writeFileSync(path.join(b, 'cases', 'c3', 'shared'), 'a file');
  assert.throws(() => S.ensureShare(b, 'c3'), (e) => e.code === 'share-unsafe');
  fs.symlinkSync(out, path.join(b, 'cases', 'c2'));
  assert.throws(() => S.ensureShare(b, 'c2'), (e) => e.code === 'share-unsafe');
  assert.equal(fs.readdirSync(out).length, 0, 'nothing was created in the folder the link pointed at');
  assert.equal(S.within('/a/b', '/a/b/c'), true); assert.equal(S.within('/a/b', '/a/b'), false); assert.equal(S.within('/a/b', '/a/bc'), false);
});

// ---- the pinned download
function release() {
  const q = makeZip([['qemu-system-x86_64', '#!/bin/sh\n'], ['qemu-img', '#!/bin/sh\n']]);
  const kernel = Buffer.from('kernel-bytes'), initrd = Buffer.from('initrd-bytes'), disk = Buffer.from('disk-bytes-'.repeat(50));
  const u = (n) => 'https://github.com/o/r/releases/download/t1/' + n;
  const files = { [u('qemu-linux-x64.zip')]: q, [u('kernel-x86_64')]: kernel, [u('initrd-x86_64')]: initrd, [u('base-x86_64.qcow2')]: disk };
  const index = { schema: 1, published: true, releaseTag: 't1', qemu: { 'linux-x64': { url: u('qemu-linux-x64.zip'), sha256: sha(q), size: q.length, exec: ['qemu-system-x86_64', 'qemu-img'] } },
    images: { x86_64: { version: '1.0', kernel: { url: u('kernel-x86_64'), sha256: sha(kernel), size: kernel.length }, initrd: { url: u('initrd-x86_64'), sha256: sha(initrd), size: initrd.length }, disk: { url: u('base-x86_64.qcow2'), sha256: sha(disk), size: disk.length } } } };
  return { files, index, u };
}
const SYS = { platform: 'linux', arch: 'x64' };
test('download: first use fetches every file, verifies each SHA-256, unpacks QEMU, reports progress, and a second status needs no download', async () => {
  const r = release(), d = tmp(), log = [];
  const as = new I.Assets({ dir: d, fetchImpl: fakeFetch(r.files, log) });
  assert.equal((await as.status(I.validateIndex(r.index), SYS)).installed, false);
  const prog = [];
  const out = await as.install(r.index, SYS, { onProgress: (p) => prog.push(p) });
  assert.equal(out.ok, true);
  assert.deepEqual(log.length, 4);
  assert.ok(prog.length >= 4 && prog.at(-1).doneBytes === prog.at(-1).total);
  const st = await as.status(r.index, SYS);
  assert.equal(st.installed, true); assert.deepEqual(st.missing, []);
  assert.ok(fs.existsSync(st.paths.qemu) && fs.existsSync(st.paths.qemuImg));
  assert.equal(fs.statSync(st.paths.qemu).mode & 0o111, 0o111, 'the listed programs are made executable');
  assert.equal(fs.readFileSync(st.paths.kernel, 'utf8'), 'kernel-bytes');
  await as.install(r.index, SYS); assert.equal(log.length, 4, 'nothing is fetched again');
});
test('download: a file that does not match its pinned SHA-256 is deleted and nothing is installed', async () => {
  const r = release(), d = tmp();
  r.files[r.u('initrd-x86_64')] = Buffer.from('initrd-BYTES');           // same size, other content
  const as = new I.Assets({ dir: d, fetchImpl: fakeFetch(r.files) });
  await assert.rejects(as.install(r.index, SYS), (e) => e.code === 'checksum' && /pinned SHA-256/.test(e.message));
  const st = await as.status(r.index, SYS);
  assert.equal(st.installed, false); assert.ok(st.missing.includes('initrd'));
  assert.equal(fs.existsSync(st.paths.initrd), false); assert.equal(fs.existsSync(st.paths.initrd + '.part'), false);
});
test('download: wrong size, short body, unreachable host, 404 and hosts outside GitHub are refused honestly', async () => {
  const r = release(), d = tmp();
  const k = r.u('kernel-x86_64');
  const mk = (files) => new I.Assets({ dir: tmp(), fetchImpl: fakeFetch(files) });
  await assert.rejects(mk({ ...r.files, [k]: { status: 200, body: Buffer.from('kernel-bytes'), headers: { 'content-length': '999' } } }).install(r.index, SYS), (e) => e.code === 'size');
  await assert.rejects(mk({ ...r.files, [k]: Buffer.from('kernel') }).install(r.index, SYS), (e) => e.code === 'size' || e.code === 'checksum');
  await assert.rejects(mk({ ...r.files, [k]: { status: 404, body: Buffer.alloc(0) } }).install(r.index, SYS), (e) => e.code === 'http' && /404/.test(e.message) && /not there/.test(e.message));
  const gone = { ...r.files }; delete gone[k];
  await assert.rejects(mk(gone).install(r.index, SYS), (e) => e.code === 'unreachable' && /github\.com/.test(e.message) && /nothing was installed/.test(e.message));
  // a redirect to another host is refused, a redirect inside the listed hosts is followed
  await assert.rejects(mk({ ...r.files, [k]: { status: 302, headers: { location: 'https://evil.example/k' } } }).install(r.index, SYS), (e) => e.code === 'refused-host');
  const ok = { ...r.files, [k]: { status: 302, headers: { location: 'https://objects.githubusercontent.com/x/kernel' } }, 'https://objects.githubusercontent.com/x/kernel': Buffer.from('kernel-bytes') };
  assert.equal((await mk(ok).install(r.index, SYS)).ok, true);
  await assert.rejects(new I.Assets({ dir: d, fetchImpl: fakeFetch(r.files), freeBytes: () => 10 }).install(r.index, SYS), (e) => e.code === 'disk-space');
});
test('download: the index must list GitHub release hosts, https, size and SHA-256; an unpublished index offers nothing', () => {
  const r = release();
  assert.throws(() => I.validateIndex({ ...r.index, qemu: { 'linux-x64': { ...r.index.qemu['linux-x64'], url: 'http://github.com/x' } } }), /https/);
  assert.throws(() => I.validateIndex({ ...r.index, qemu: { 'linux-x64': { ...r.index.qemu['linux-x64'], url: 'https://evil.example/x' } } }), /GitHub release host/);
  assert.throws(() => I.validateIndex({ ...r.index, qemu: { 'linux-x64': { ...r.index.qemu['linux-x64'], sha256: 'abc' } } }), /sha256/);
  assert.throws(() => I.validateIndex({ ...r.index, qemu: { 'linux-x64': { ...r.index.qemu['linux-x64'], exec: ['../../bin/sh'] } } }), /exec/);
  assert.throws(() => I.validateIndex({ ...r.index, extra: 1 }), /not valid/);
  const none = I.plan({ schema: 1, published: false }, SYS);
  assert.equal(none.ok, false); assert.equal(none.code, 'not-published'); assert.match(none.error, /Nothing was downloaded/);
  assert.equal(I.plan(r.index, { platform: 'darwin', arch: 'arm64' }).code, 'no-qemu');
  const shipped = I.loadIndex(); assert.equal(shipped.published, false, 'the shipped index offers nothing until the workflow has run');
});
test('download: a QEMU package with a path that climbs out of its folder is refused', async () => {
  const r = release(); const bad = makeZip([['../evil', 'x'], ['qemu-system-x86_64', 'x'], ['qemu-img', 'x']]);
  r.index.qemu['linux-x64'] = { ...r.index.qemu['linux-x64'], sha256: sha(bad), size: bad.length }; r.files[r.u('qemu-linux-x64.zip')] = bad;
  await assert.rejects(new I.Assets({ dir: tmp(), fetchImpl: fakeFetch(r.files) }).install(r.index, SYS), /Unsafe file name|unsafe/i);
});
test('make-index writes a valid pinned index from a folder of release assets', () => {
  const { build } = require('../tools/ghost-vm/image/make-index');
  const d = tmp();
  for (const [n, c] of [['qemu-linux-x64.zip', 'z'], ['qemu-win32-x64.zip', 'w'], ['kernel-x86_64', 'k'], ['initrd-x86_64', 'i'], ['base-x86_64.qcow2', 'd']]) fs.writeFileSync(path.join(d, n), c);
  const idx = build({ dir: d, repo: 'owner/repo', tag: 'ghost-vm-1', version: '1' });
  I.validateIndex(idx);
  assert.equal(idx.qemu['linux-x64'].sha256, sha(Buffer.from('z')));
  assert.deepEqual(idx.qemu['win32-x64'].exec, ['qemu-system-x86_64.exe', 'qemu-img.exe']);
  assert.equal(idx.images.x86_64.disk.url, 'https://github.com/owner/repo/releases/download/ghost-vm-1/base-x86_64.qcow2');
  assert.throws(() => build({ dir: d, repo: 'bad repo', tag: 't' }), /bad repository/);
  assert.throws(() => build({ dir: tmp(), repo: 'o/r', tag: 't' }), /at least one/);
});
