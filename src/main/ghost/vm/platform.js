'use strict';
// Ghost virtual computer: which QEMU program and which accelerator this computer can use. Pure: every probe is handed in, so each
// operating system can be tested on any machine.
//  Linux  KVM        macOS  HVF        Windows  WHPX, then HAXM (older Intel setups)        anything else  TCG (software emulation, slow)
// The guest always has the same CPU family as the host: acceleration cannot run a different one, and software emulation of a
// different one would be slower still.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const GUEST = { x64: 'x86_64', arm64: 'aarch64' };
const ORDER = {
  linux: ['kvm', 'tcg'], darwin: ['hvf', 'tcg'],
  win32: { x64: ['whpx', 'hax', 'tcg'], arm64: ['whpx', 'tcg'] },
};
const LABEL = { kvm: 'KVM', hvf: 'Apple Hypervisor (HVF)', whpx: 'Windows Hypervisor Platform (WHPX)', hax: 'Intel HAXM', tcg: 'software emulation (TCG)' };

const guestArch = (arch) => GUEST[arch] || null;
const qemuName = (arch, platform) => 'qemu-system-' + guestArch(arch) + (platform === 'win32' ? '.exe' : '');
const imgName = (platform) => 'qemu-img' + (platform === 'win32' ? '.exe' : '');
const candidates = (platform, arch) => {
  const o = ORDER[platform];
  const l = Array.isArray(o) ? o : (o && o[arch]) || ['tcg'];
  return l.slice();
};
const supported = (platform, arch) => !!guestArch(arch) && ['linux', 'darwin', 'win32'].includes(platform);

// Quick operating-system checks that save a slow probe and give a better reason. Returns {ok, reason}.
async function hostHint(accel, { platform = process.platform, access = fs.accessSync, sysctl = async () => '' } = {}) {
  if (accel === 'kvm') {
    try { access('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); return { ok: true, reason: '' }; } catch (e) {
      return { ok: false, reason: e && e.code === 'ENOENT' ? 'there is no /dev/kvm (virtualization is off in the firmware, or this is a container or a machine inside a machine)' : 'this user may not use /dev/kvm (add the user to the kvm group)' };
    }
  }
  if (accel === 'hvf') {
    let v = ''; try { v = String(await sysctl('kern.hv_support')).trim(); } catch { /* unknown */ }
    return v === '0' ? { ok: false, reason: 'this Mac does not offer the Hypervisor framework' } : { ok: true, reason: '' };
  }
  return { ok: true, reason: '' };
}

// Starts the QEMU program with no machine at all and the chosen accelerator; exit code 0 means the accelerator opened.
function qemuProbe(qemu, { spawnImpl = spawn, timeoutMs = 10000, env = {} } = {}) {
  return (accel) => new Promise((resolve) => {
    let child, done = false, err = '';
    const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    let t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } fin({ ok: false, reason: 'the check did not finish in time' }); }, timeoutMs);
    if (t.unref) t.unref();
    try { child = spawnImpl(qemu, ['-machine', 'none', '-accel', accel, '-display', 'none', '-nodefaults', '-S', '-monitor', 'stdio'], { shell: false, windowsHide: true, env, stdio: ['pipe', 'ignore', 'pipe'] }); } catch (e) { return fin({ ok: false, reason: 'cannot start the QEMU program: ' + (e.code || e.message) }); }
    child.stderr.on('data', (d) => { if (err.length < 400) err += d; });
    child.on('error', (e) => fin({ ok: false, reason: 'cannot start the QEMU program: ' + (e.code || e.message) }));
    child.on('close', (code) => fin(code === 0 ? { ok: true, reason: '' } : { ok: false, reason: (err.trim().split('\n')[0] || 'exit code ' + code).slice(0, 160) }));
    try { child.stdin.end('quit\n'); } catch { /* closed */ }
  });
}

// -> {supported, accel, hardware, fast, label, tried:[{accel, ok, reason}], notice}
async function detectAccel({ platform = process.platform, arch = process.arch, hint = (a) => hostHint(a, { platform }), probe }) {
  if (!supported(platform, arch)) return { supported: false, accel: null, hardware: false, fast: false, label: '', tried: [], notice: 'The virtual computer is not available for ' + platform + ' on ' + arch + '.' };
  const tried = [];
  for (const accel of candidates(platform, arch)) {
    if (accel === 'tcg') break;
    const h = await hint(accel);
    if (!h.ok) { tried.push({ accel, ok: false, reason: h.reason }); continue; }
    const p = await probe(accel);
    tried.push({ accel, ok: !!p.ok, reason: p.ok ? '' : p.reason });
    if (p.ok) return { supported: true, accel, hardware: true, fast: true, label: LABEL[accel], tried, notice: '' };
  }
  const why = tried.length ? tried.map((t) => LABEL[t.accel] + ': ' + t.reason).join('; ') : 'no hardware accelerator exists for this system';
  return {
    supported: true, accel: 'tcg', hardware: false, fast: false, label: LABEL.tcg, tried,
    notice: 'Hardware virtualization is not available here (' + why + '). This is common inside containers, on some Chromebooks and on machines where it is switched off. The virtual computer will run in software emulation and be much slower: starting takes minutes and builds take many times longer.',
  };
}

module.exports = { guestArch, qemuName, imgName, candidates, supported, hostHint, qemuProbe, detectAccel, LABEL };
