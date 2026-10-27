'use strict';
// Ghost virtual computer: the pinned index and the first-use download. Nothing here is bundled with the app.
//  - vm-index.json ships INSIDE the app. Every asset it lists has an https address, a size and a SHA-256, so a changed or substituted
//    file is refused. The index is produced by .github/workflows/ghost-vm-image.yml and copied into the app at release time.
//  - Downloads go only to the listed GitHub release hosts, follow redirects only to those hosts, are capped at the listed size, and
//    are verified before they are renamed into place. A file that fails is deleted. Nothing falls back to another source.
//  - The QEMU program and the system image are re-checked (size and time, then the full hash if either changed) at every start.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readZip } = require('../../lib/zip');
const { guestArch } = require('./platform');

const HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const MAX_ASSET = 2 * 1024 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => Object.keys(v).every((k) => keys.includes(k));

class VmError extends Error { constructor(code, message) { super(message); this.code = code; } }

function checkAsset(a, where, hosts) {
  if (!obj(a) || !only(a, ['url', 'sha256', 'size', 'exec'])) throw new VmError('bad-index', where + ': not an asset entry');
  let u; try { u = new URL(a.url); } catch { throw new VmError('bad-index', where + ': bad address'); }
  if (u.protocol !== 'https:' || !hosts.includes(u.hostname) || u.username || u.password) throw new VmError('bad-index', where + ': the address must be https on a GitHub release host');
  if (!SHA_RE.test(a.sha256 || '')) throw new VmError('bad-index', where + ': missing sha256');
  if (!Number.isInteger(a.size) || a.size < 1 || a.size > MAX_ASSET) throw new VmError('bad-index', where + ': bad size');
  if (a.exec !== undefined && !(Array.isArray(a.exec) && a.exec.length <= 8 && a.exec.every((x) => typeof x === 'string' && /^[A-Za-z0-9._/-]{1,80}$/.test(x) && !x.includes('..')))) throw new VmError('bad-index', where + ': bad exec list');
  return a;
}
// Returns the index when it is well formed. An index with published:false is valid but offers nothing.
function validateIndex(idx, { hosts = HOSTS } = {}) {
  const bad = () => new VmError('bad-index', 'The virtual computer index is not valid.');
  if (!obj(idx) || idx.schema !== 1 || !only(idx, ['schema', 'published', 'note', 'releaseTag', 'qemu', 'images']) || typeof idx.published !== 'boolean') throw bad();
  if (!idx.published) return idx;
  if (!obj(idx.qemu) || !obj(idx.images)) throw bad();
  for (const [k, v] of Object.entries(idx.qemu)) { if (!/^(linux|darwin|win32)-(x64|arm64)$/.test(k)) throw new VmError('bad-index', 'unknown program key ' + k); checkAsset(v, 'qemu.' + k, hosts); }
  for (const [k, v] of Object.entries(idx.images)) {
    if (!['x86_64', 'aarch64'].includes(k) || !obj(v) || !only(v, ['version', 'kernel', 'initrd', 'disk'])) throw new VmError('bad-index', 'bad image entry ' + k);
    for (const n of ['kernel', 'initrd', 'disk']) checkAsset(v[n], 'images.' + k + '.' + n, hosts);
  }
  return idx;
}
function loadIndex(file = path.join(__dirname, 'vm-index.json')) {
  let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new VmError('bad-index', 'The virtual computer index is missing or damaged.'); }
  return validateIndex(raw);
}

const sha256File = (file) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });

// What this computer needs. ok:false (with a plain reason) when the index offers nothing for this system.
function plan(idx, { platform, arch }) {
  if (!idx.published) return { ok: false, code: 'not-published', error: 'The virtual computer has not been published yet: no image release exists. Nothing was downloaded.' };
  const g = guestArch(arch), q = idx.qemu[platform + '-' + arch], im = g && idx.images[g];
  if (!q) return { ok: false, code: 'no-qemu', error: 'No QEMU program is listed for ' + platform + ' on ' + arch + '.' };
  if (!im) return { ok: false, code: 'no-image', error: 'No system image is listed for ' + g + '.' };
  return { ok: true, guest: g, items: [{ name: 'qemu', asset: q, kind: 'pack' }, { name: 'kernel', asset: im.kernel, kind: 'file' }, { name: 'initrd', asset: im.initrd, kind: 'file' }, { name: 'disk', asset: im.disk, kind: 'file' }], total: q.size + im.kernel.size + im.initrd.size + im.disk.size, version: im.version || '' };
}

const freeBytesOf = (dir) => { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } };

// One download: stream into <dest>.part, hash as it arrives, refuse anything over the listed size, verify, rename.
async function download({ asset, dest, fetchImpl, onProgress = () => {}, hosts = HOSTS, signal, freeBytes = freeBytesOf }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const need = asset.size * 1.1;
  if (freeBytes(path.dirname(dest)) < need) throw new VmError('disk-space', 'Not enough free disk space: about ' + Math.ceil(need / 1048576) + ' MiB is needed for this download.');
  const part = dest + '.part';
  let u = asset.url, r = null, firstHost = '';
  try {
    for (let hop = 0; hop < 6; hop++) {
      const h = new URL(u);
      if (h.protocol !== 'https:' || !hosts.includes(h.hostname)) throw new VmError('refused-host', 'Refused: ' + h.hostname + ' is not a listed download host.');
      if (!firstHost) firstHost = h.hostname;
      try { r = await fetchImpl(u, { redirect: 'manual', headers: { 'user-agent': 'MayfairGhost' }, signal }); } catch (e) {
        if (e && e.name === 'AbortError') throw new VmError('cancelled', 'Cancelled.');
        throw new VmError('unreachable', 'Could not reach ' + h.hostname + ' (' + ((e && (e.code || (e.cause && e.cause.code) || e.message)) || 'network error') + '). The virtual computer cannot be downloaded from here right now. Check the connection and try again; nothing was installed.');
      }
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
      break;
    }
    if (!r || (r.status >= 300 && r.status < 400)) throw new VmError('redirects', 'Too many redirects.');
    if (!r.ok) throw new VmError('http', firstHost + ' answered ' + r.status + (r.status === 404 ? ' (the file is not there: the release may have been removed)' : '') + '.');
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len !== asset.size) throw new VmError('size', 'The server reports a different size than the pinned index (' + len + ' instead of ' + asset.size + '). Refused.');
    const hash = crypto.createHash('sha256'); let n = 0;
    const fd = fs.openSync(part, 'w', 0o600);
    try {
      const body = r.body && r.body.getReader ? r.body.getReader() : null;
      const take = (buf) => { n += buf.length; if (n > asset.size) throw new VmError('size', 'The download is larger than the pinned size. Refused.'); hash.update(buf); fs.writeSync(fd, buf); onProgress(n, asset.size); };
      if (body) { for (;;) { const { done, value } = await body.read(); if (done) break; take(Buffer.from(value)); } } else take(Buffer.from(await r.arrayBuffer()));
    } finally { fs.closeSync(fd); }
    if (n !== asset.size) throw new VmError('size', 'The download is incomplete (' + n + ' of ' + asset.size + ' bytes).');
    if (hash.digest('hex') !== asset.sha256) throw new VmError('checksum', 'The file does not match its pinned SHA-256, so it was deleted and not used.');
    fs.renameSync(part, dest);
    return { sha256: asset.sha256, size: n };
  } catch (e) { try { fs.rmSync(part, { force: true }); } catch { /* none */ } throw e; }
}

class Assets {
  constructor({ dir, fetchImpl = (typeof fetch === 'function' ? fetch : null), freeBytes } = {}) {
    this.dir = dir; this.fetch = fetchImpl; this.freeBytes = freeBytes; this.file = path.join(dir, 'assets.json');
  }
  _read() { try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); return d && d.v === 1 && d.files ? d : { v: 1, files: {} }; } catch { return { v: 1, files: {} }; } }
  _write(d) { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(d), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  paths(guest, { platform, arch }) {
    const w = platform === 'win32', gd = path.join(this.dir, guest), qdir = path.join(this.dir, 'qemu-' + platform + '-' + arch);
    return { qemu: path.join(qdir, 'qemu-system-' + guest + (w ? '.exe' : '')), qemuImg: path.join(qdir, 'qemu-img' + (w ? '.exe' : '')), qdir, kernel: path.join(gd, 'kernel'), initrd: path.join(gd, 'initrd'), disk: path.join(gd, 'base.qcow2') };
  }
  // Already here and unchanged? Size and time first; the full hash only when either differs from the record.
  async intact(item, paths) {
    const d = this._read(), rec = d.files[item.name];
    if (!rec || rec.sha256 !== item.asset.sha256) return false;
    try {
      if (item.name === 'qemu') { const st = fs.statSync(paths.qemu); return st.isFile() && st.size === rec.exeSize && Math.round(st.mtimeMs) === rec.exeMtime; }
      const f = paths[item.name], st = fs.statSync(f);
      if (st.size !== item.asset.size) return false;
      if (Math.round(st.mtimeMs) === rec.mtime) return true;
      if ((await sha256File(f)) !== item.asset.sha256) return false;
      rec.mtime = Math.round(st.mtimeMs); this._write(d);
      return true;
    } catch { return false; }
  }
  async status(idx, sys) {
    const p = plan(idx, sys);
    if (!p.ok) return { installed: false, ...p };
    const paths = this.paths(p.guest, sys), missing = [];
    for (const it of p.items) if (!(await this.intact(it, paths))) missing.push(it.name);
    return { installed: missing.length === 0, ok: true, missing, total: p.total, version: p.version, paths, guest: p.guest };
  }
  // Downloads what is missing. onProgress({item, received, size, doneBytes, total}).
  async install(idx, sys, { onProgress = () => {}, signal } = {}) {
    const p = plan(idx, sys);
    if (!p.ok) throw new VmError(p.code, p.error);
    if (!this.fetch) throw new VmError('no-network', 'No network client is available.');
    const paths = this.paths(p.guest, sys);
    let doneBytes = 0;
    for (const it of p.items) {
      if (await this.intact(it, paths)) { doneBytes += it.asset.size; continue; }
      const pack = it.kind === 'pack';
      const dest = pack ? path.join(this.dir, 'qemu-pack.zip') : paths[it.name];
      const base = doneBytes;
      await download({ asset: it.asset, dest, fetchImpl: this.fetch, signal, freeBytes: this.freeBytes, onProgress: (n, s) => onProgress({ item: it.name, received: n, size: s, doneBytes: base + n, total: p.total }) });
      const d = this._read();
      if (pack) { try { this._unpack(dest, paths, it.asset, d); } finally { fs.rmSync(dest, { force: true }); } } else { const st = fs.statSync(dest); d.files[it.name] = { sha256: it.asset.sha256, mtime: Math.round(st.mtimeMs) }; fs.chmodSync(dest, 0o600); }
      this._write(d);
      doneBytes += it.asset.size;
    }
    return { ok: true, paths, version: p.version, guest: p.guest };
  }
  _unpack(zipFile, paths, asset, d) {
    const entries = readZip(fs.readFileSync(zipFile), { entries: 600, total: 900 * 1024 * 1024, single: 400 * 1024 * 1024 });
    fs.rmSync(paths.qdir, { recursive: true, force: true });
    const root = path.resolve(paths.qdir); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const e of entries) {
      if (e.name.includes(':') || e.name.split('/').some((s) => s === '' || s === '.')) throw new VmError('unsafe-archive', 'Unsafe file name in the QEMU package.');
      const p = path.resolve(root, ...e.name.split('/'));
      if (!p.startsWith(root + path.sep)) throw new VmError('unsafe-archive', 'Unsafe file name in the QEMU package.');
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, e.data, { mode: 0o644 });
    }
    for (const rel of asset.exec || []) { const p = path.join(root, ...rel.split('/')); if (!fs.existsSync(p)) throw new VmError('missing-exec', 'The QEMU package does not contain ' + rel + '.'); fs.chmodSync(p, 0o755); }
    if (!fs.existsSync(paths.qemu) || !fs.existsSync(paths.qemuImg)) throw new VmError('missing-exec', 'The QEMU package does not contain the expected programs.');
    const st = fs.statSync(paths.qemu);
    d.files.qemu = { sha256: asset.sha256, exeSize: st.size, exeMtime: Math.round(st.mtimeMs) };
  }
}

module.exports = { HOSTS, VmError, validateIndex, loadIndex, plan, download, Assets, sha256File };
