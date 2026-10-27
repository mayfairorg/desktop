'use strict';
// Ghost virtual computer: the machine's own disk.
//  - Layout:  <vm>/<case>/disk.qcow2  (a thin overlay: everything the person writes)   +  the shared base image (read-only, verified).
//  - Encryption at rest: the overlay is a qcow2 with LUKS encryption. Its key is 32 random bytes kept as a record in the Ghost vault
//    (namespace "connectors", id vmkey-<case>), so the disk cannot be read while the vault is locked, after the vault is wiped, or by
//    copying the file. The key reaches QEMU through an inherited, already-unlinked file descriptor (macOS, Linux) and never appears on a
//    command line; on Windows, where that is not possible, a 0600 key file exists in a private run folder for the first seconds of a start
//    and is overwritten and removed as soon as the machine reports in. NOT protected: the base image (public, identical for everyone), the
//    shared folder (ordinary files in the case folder), and the running machine's memory.
//  - If the vault is not available the disk is created unencrypted only after a native confirmation says so.
//  - Reset deletes the overlay and its key; the next start makes a clean one. Snapshots are qcow2 snapshots inside the overlay (disk
//    only, not memory) and are taken and restored with the machine stopped.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { VmError } = require('./images');
const { esc } = require('./argv');

const NS = 'connectors';
const SNAP_RE = /^[A-Za-z0-9._-]{1,40}$/;
const CASE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const keyId = (c) => 'vmkey-' + c;

// How keys are handed to a QEMU program. fileArgs[i] goes into `-object secret,id=secN,file=...`; stdio is the spawn stdio array; cleanup() closes or removes.
// POSIX: each key is written to a private file that is unlinked at once, and the open descriptor is inherited by the child (/dev/fd/N). The key
// is never in a command line or an environment variable, and has no name on disk. Windows cannot do that: the key file exists until cleanup().
function keyDelivery({ platform = process.platform, keys, runDir }) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    const fds = keys.map((k) => {
      const f = path.join(runDir, 'k' + crypto.randomBytes(4).toString('hex'));
      const fd = fs.openSync(f, 'wx', 0o600);
      fs.writeSync(fd, Buffer.from(k), 0, Buffer.byteLength(k), 0);       // written at position 0: the descriptor's own offset stays at 0
      fs.unlinkSync(f);
      return fd;
    });
    return { fileArgs: fds.map((_, i) => '/dev/fd/' + (3 + i)), stdio: ['pipe', 'pipe', 'pipe', ...fds], cleanup: () => { for (const fd of fds) { try { fs.closeSync(fd); } catch { /* closed */ } } } };
  }
  const files = keys.map((k) => { const f = path.join(runDir, 'k' + crypto.randomBytes(4).toString('hex')); fs.writeFileSync(f, k, { mode: 0o600 }); return f; });
  const cleanup = () => { for (const f of files) { try { fs.writeFileSync(f, crypto.randomBytes(64)); } catch { /* gone */ } try { fs.rmSync(f, { force: true }); } catch { /* gone */ } } };
  return { fileArgs: files, stdio: ['pipe', 'pipe', 'pipe'], cleanup };
}

function defaultRun(exe, args, { delivery, timeoutMs = 120000, env = {} } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } fin({ code: null, stdout: out, stderr: 'timed out' }); }, timeoutMs);
    if (t.unref) t.unref();
    try { child = spawn(exe, args, { shell: false, windowsHide: true, env, stdio: delivery ? delivery.stdio : ['ignore', 'pipe', 'pipe'] }); } catch (e) { return fin({ code: null, stdout: '', stderr: 'cannot start: ' + (e.code || e.message) }); }
    child.stdout.on('data', (d) => { if (out.length < 1 << 20) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 8192) err += d; });
    child.on('error', (e) => fin({ code: null, stdout: out, stderr: 'cannot start: ' + (e.code || e.message) }));
    child.on('close', (code) => fin({ code, stdout: out, stderr: err }));
  });
}

class VmDisk {
  // dir: the case folder. vault: () => the open Vault or null. qemuImg: () => path of qemu-img. run: test double for the program runner.
  constructor({ caseId, dir, vault = () => null, qemuImg, platform = process.platform, run = defaultRun, runDirBase, env = {}, keyName = null }) {
    if (!CASE_RE.test(caseId)) throw new VmError('bad-input', 'Bad case id.');
    this.caseId = caseId; this.keyName = keyName || keyId(caseId); this.dir = dir; this.vault = vault; this.qemuImg = qemuImg; this.platform = platform; this.run = run; this.env = env;
    this.overlay = path.join(dir, 'disk.qcow2'); this.stateFile = path.join(dir, 'disk.json');
    this.runDirBase = runDirBase || path.join(dir, '.run');
  }
  _state() { try { const d = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); return d && d.v === 1 ? d : null; } catch { return null; } }
  _writeState(s) { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify({ v: 1, ...s }), { mode: 0o600 }); fs.renameSync(this.stateFile + '.tmp', this.stateFile); }
  exists() { return fs.existsSync(this.overlay); }
  encrypted() { const s = this._state(); return !!s && s.encrypted === true; }
  vaultReady() { const v = this.vault(); return !!v && v.unlocked; }

  // The key as hex, or null when the disk is not encrypted. Throws a plain error when the vault cannot give it.
  key() {
    if (!this.encrypted()) return null;
    const v = this.vault();
    if (!v || !v.unlocked) throw new VmError('vault-locked', 'The disk of this virtual computer is encrypted with your Ghost vault key, and the vault is locked. Unlock the vault first.');
    let k; try { k = v.get(NS, this.keyName); } catch (e) { throw new VmError('vault-locked', 'The vault could not give the disk key: ' + e.message); }
    if (!k) throw new VmError('key-missing', 'The disk key is not in the vault any more (the vault was wiped or replaced), so this disk can no longer be read. Reset the virtual computer to start a clean one.');
    return k.toString('utf8');
  }
  _delivery(keyHex) { return keyDelivery({ platform: this.platform, keys: [keyHex], runDir: path.join(this.runDirBase, crypto.randomBytes(4).toString('hex')) }); }

  // Make the overlay if there is none. allowPlain: the person confirmed an unencrypted disk. -> {created, encrypted}
  async ensure({ baseDisk, baseId, sizeGb = 16, allowPlain = false } = {}) {
    if (this.exists() && this._state()) {
      const st = this._state();
      // The overlay only works on top of the exact base image it was made from. A newer image means this disk has to be reset.
      if (baseDisk && baseId && st.baseId && st.baseId !== baseId) throw new VmError('base-changed', 'The system image was updated since this disk was made. Reset the virtual computer (the tools disk and the shared folder are kept) to use the new image.');
      return { created: false, encrypted: this.encrypted() };
    }
    if (this.exists()) fs.rmSync(this.overlay, { force: true });                   // a half-made file with no record
    const gb = Math.max(4, Math.min(64, Math.round(sizeGb)));
    const ready = this.vaultReady();
    if (!ready && !allowPlain) throw new VmError('vault-unavailable', 'The Ghost vault is not available, so the disk cannot be encrypted.');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let keyHex = null;
    if (ready) { keyHex = crypto.randomBytes(32).toString('hex'); this.vault().put(NS, this.keyName, keyHex); }
    const d = keyHex ? this._delivery(keyHex) : null;
    const ordered = ['create', ...(d ? ['--object', 'secret,id=sec0,file=' + esc(d.fileArgs[0])] : []), '-f', 'qcow2', ...(baseDisk ? ['-b', baseDisk, '-F', 'qcow2'] : []), ...(d ? ['-o', 'encrypt.format=luks,encrypt.key-secret=sec0'] : []), this.overlay, gb + 'G'];
    let r;
    try { r = await this.run(this.qemuImg(), ordered, { delivery: d, env: this.env }); } finally { if (d) d.cleanup(); }
    if (r.code !== 0 || !fs.existsSync(this.overlay)) {
      if (keyHex) { try { this.vault().remove(NS, this.keyName); } catch { /* none */ } }
      fs.rmSync(this.overlay, { force: true });
      throw new VmError('disk-create', 'Could not create the disk: ' + String(r.stderr || 'unknown error').trim().split('\n')[0].slice(0, 200));
    }
    fs.chmodSync(this.overlay, 0o600);
    this._writeState({ encrypted: !!keyHex, sizeGb: gb, ...(baseId ? { baseId } : {}), created: new Date().toISOString() });
    return { created: true, encrypted: !!keyHex };
  }

  // Wipes the machine's disk back to the clean image. The shared folder is not touched.
  reset() {
    try { fs.rmSync(this.overlay, { force: true }); } catch { /* gone */ }
    fs.rmSync(this.stateFile, { force: true });
    const v = this.vault();
    if (v && v.unlocked) { try { v.remove(NS, this.keyName); } catch { /* no key record */ } }
    return { ok: true };
  }

  async _img(sub, extra) {
    const keyHex = this.key();
    const d = keyHex ? this._delivery(keyHex) : null;
    const image = 'driver=qcow2,file.filename=' + esc(this.overlay) + ',backing=' + (d ? ',encrypt.key-secret=sec0' : '');
    const args = [sub, ...(d ? ['--object', 'secret,id=sec0,file=' + esc(d.fileArgs[0])] : []), ...extra, '--image-opts', image];
    let r;
    try { r = await this.run(this.qemuImg(), args, { delivery: d, env: this.env }); } finally { if (d) d.cleanup(); }
    return r;
  }
  async snapshots() {
    if (!this.exists()) return [];
    const keyHex = this.key();
    const d = keyHex ? this._delivery(keyHex) : null;
    const args = ['info', ...(d ? ['--object', 'secret,id=sec0,file=' + esc(d.fileArgs[0])] : []), '--output=json', '--image-opts', 'driver=qcow2,file.filename=' + esc(this.overlay) + ',backing=' + (d ? ',encrypt.key-secret=sec0' : '')];
    let r;
    try { r = await this.run(this.qemuImg(), args, { delivery: d, env: this.env }); } finally { if (d) d.cleanup(); }
    if (r.code !== 0) throw new VmError('snapshot-list', 'Could not read the snapshots: ' + String(r.stderr).trim().split('\n')[0].slice(0, 200));
    let j; try { j = JSON.parse(r.stdout); } catch { throw new VmError('snapshot-list', 'Could not read the snapshot list.'); }
    return (Array.isArray(j.snapshots) ? j.snapshots : []).map((s) => ({ name: String(s.name), t: Number(s['date-sec']) * 1000 || 0 })).filter((s) => SNAP_RE.test(s.name));
  }
  async _snap(flag, name) {
    if (!SNAP_RE.test(String(name))) throw new VmError('bad-input', 'A snapshot name is 1 to 40 letters, digits, dot, dash or underscore.');
    if (!this.exists()) throw new VmError('no-disk', 'There is no disk yet.');
    const r = await this._img('snapshot', [flag, name]);
    if (r.code !== 0) throw new VmError('snapshot', 'The snapshot step failed: ' + String(r.stderr).trim().split('\n')[0].slice(0, 200));
    return { ok: true };
  }
  async snapshot(name) { if ((await this.snapshots()).some((s) => s.name === name)) throw new VmError('exists', 'A snapshot with that name exists.'); return this._snap('-c', name); }
  restore(name) { return this._snap('-a', name); }
  delete(name) { return this._snap('-d', name); }
}

module.exports = { VmDisk, keyDelivery, defaultRun, SNAP_RE, CASE_RE, NS, keyId };
