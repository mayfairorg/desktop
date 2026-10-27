'use strict';
// Install-on-demand for the security tools. Runs in the main process; there is no call that takes a URL, a path to run, or a command from
// the page: the page names a catalog id and says the licence was accepted.
//
//   install(id)  download -> verify checksum -> extract -> move into <userData>/ghost/tools/<id>/pkg -> run the self-test -> only then write
//                install.json with status "installed". Any failure leaves nothing marked installed and says why, in plain words.
//   adopt(id, path)  the same self-test for a copy the user already has (nothing is copied or redistributed).
//   status(id)   "installed" only if install.json says the self-test passed AND the program on disk still has the recorded SHA-256.
//
// If a download host cannot be reached the result is {ok:false, error:'host-unreachable'} with the host name. Nothing is invented.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { CATALOG } = require('./catalog');

const UNREACHABLE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);
const HEX64 = /^[a-f0-9]{64}$/;
const fail = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };

function sha256File(p) {
  return new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
}
function minimalEnv() {
  const e = {};
  for (const k of process.platform === 'win32' ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH']) if (process.env[k] !== undefined) e[k] = process.env[k];
  if (process.platform !== 'win32') { e.LANG = 'C.UTF-8'; e.TMPDIR = os.tmpdir(); }
  return e;
}
function run(cmd, args, { cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = execFile(cmd, args, { cwd, env: { ...minimalEnv(), HOME: cwd || os.tmpdir(), USERPROFILE: cwd || os.tmpdir() }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, spawnError: err && typeof err.code === 'string' ? err.code : null, killed: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') })); } catch (e) { resolve({ code: null, spawnError: e.code || 'spawn-failed', stdout: '', stderr: '' }); }
    void child;
  });
}
const platformKey = (platform, arch) => `${platform}-${arch}`;
const exeNameFor = (cat, platform) => cat.exeName[platform] || cat.exeName.default;

class ToolInstaller {
  // root: the userData folder. fetchImpl: fetch-compatible (the app passes net.fetch so system proxy settings apply).
  constructor({ root, catalog = CATALOG, fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch, log = null, now = () => new Date().toISOString(), extract = null } = {}) {
    if (!root) throw new Error('root is required');
    this.root = root; this.catalog = catalog; this.fetch = fetchImpl; this.platform = platform; this.arch = arch; this.log = log; this.now = now;
    this.toolsDir = path.join(root, 'ghost', 'tools');
    this.extractImpl = extract || ((a, d, k) => this._extract(a, d, k));
    this.busy = new Set();
  }
  _log(event, data) { if (this.log && this.log.info) { try { this.log.info(event, data); } catch { /* logging must not break an install */ } } }
  _dir(id) { return path.join(this.toolsDir, id); }
  _recordPath(id) { return path.join(this._dir(id), 'install.json'); }
  _readRecord(id) { try { return JSON.parse(fs.readFileSync(this._recordPath(id), 'utf8')); } catch { return null; } }
  _writeRecord(id, rec) { fs.mkdirSync(this._dir(id), { recursive: true }); const p = this._recordPath(id); fs.writeFileSync(p + '.tmp', JSON.stringify(rec, null, 2)); fs.renameSync(p + '.tmp', p); }

  list() { return Object.keys(this.catalog); }
  // What the UI shows. `installed` is true only when the stored self-test passed and the file is unchanged.
  async status(id) {
    const cat = this.catalog[id];
    if (!cat) return { id, known: false, installed: false, state: 'unknown' };
    const supported = !!cat.platforms[platformKey(this.platform, this.arch)];
    const base = { id, known: true, tool: cat.tool, supported, canAdopt: true, hint: supported ? undefined : cat.manualHint, urlsVerified: cat.verified === true, installed: false, state: 'not-installed' };
    const rec = this._readRecord(id);
    if (!rec) return base;
    if (rec.status === 'failed') return { ...base, state: 'failed', reason: rec.reason, at: rec.at };
    if (rec.status !== 'installed' || !rec.selfTest || rec.selfTest.passed !== true) return base;
    const exe = rec.adopted ? rec.exe : path.join(this._dir(id), String(rec.exe || ''));
    let same = false;
    try { same = fs.statSync(exe).isFile() && rec.exeSha256 === await sha256File(exe); } catch { same = false; }
    if (!same) return { ...base, state: 'changed', reason: 'The program on disk is missing or no longer matches the checksum recorded when it was tested; install it again.' };
    return { ...base, installed: true, state: 'installed', version: rec.version, installedAt: rec.installedAt, source: rec.source, adopted: rec.adopted === true };
  }

  async _get(url, hosts, signal) {
    let u = url;
    for (let hop = 0; hop < 6; hop++) {
      let parsed; try { parsed = new URL(u); } catch { return { err: fail('bad-url', 'The catalog holds an invalid address.') }; }
      if (parsed.protocol !== 'https:') return { err: fail('bad-url', 'Downloads must use https.', { host: parsed.host }) };
      if (!hosts.includes(parsed.hostname)) return { err: fail('host-not-allowed', `Ghost will not download from ${parsed.hostname}; it is not on this tool's allowed list.`, { host: parsed.hostname }) };
      let res;
      try { res = await this.fetch(u, { redirect: 'manual', signal, headers: { 'User-Agent': 'MayfairGhost-installer' } }); }
      catch (e) {
        const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
        if (e && e.name === 'AbortError') return { err: fail('cancelled', 'The download was cancelled.') };
        if (UNREACHABLE.has(code) || /fetch failed/i.test(String(e && e.message))) return { err: fail('host-unreachable', `Could not reach ${parsed.hostname}${code ? ' (' + code + ')' : ''}. Nothing was downloaded or installed. Check your connection and try again; if you are behind a firewall, ${parsed.hostname} may be blocked.`, { host: parsed.hostname, code }) };
        return { err: fail('download-failed', `Download failed: ${(e && e.message) || 'unknown error'}`, { host: parsed.hostname }) };
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u).toString(); continue; }
      if (res.status !== 200) return { err: fail('download-failed', `${parsed.hostname} answered HTTP ${res.status}, so nothing was downloaded or installed.${res.status === 403 || res.status === 407 ? ' A firewall or proxy may be blocking this host.' : ''}`, { host: parsed.hostname, status: res.status }) };
      return { res, host: parsed.hostname };
    }
    return { err: fail('download-failed', 'Too many redirects.') };
  }

  async _expectedSha(cat, plat, signal) {
    if (typeof plat.sha256 === 'string' && HEX64.test(plat.sha256)) return { sha: plat.sha256, by: 'pinned' };
    if (cat.checksums && cat.checksums.url) {
      const g = await this._get(cat.checksums.url, cat.hosts, signal);
      if (g.err) return { err: g.err };
      const text = Buffer.from(await g.res.arrayBuffer()).toString('utf8').slice(0, 1024 * 1024);
      for (const line of text.split(/\r?\n/)) {
        const m = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line);
        if (m && path.posix.basename(m[2]) === plat.file) return { sha: m[1].toLowerCase(), by: 'upstream-checksum-file' };
      }
      return { err: fail('no-checksum', `The checksum list from the project has no entry for ${plat.file}, so Ghost will not install it.`) };
    }
    return { err: fail('no-checksum', `No checksum is pinned or published for ${plat.file}, so Ghost cannot verify it and will not install it. A pinned checksum has to come from Mayfair's signed tool index. You can use your own copy instead.`) };
  }

  async install(id, { licenceAccepted = false, onProgress = () => {}, signal } = {}) {
    const cat = this.catalog[id];
    if (!cat) return fail('unknown-tool', 'That tool is not in the catalog.');
    if (licenceAccepted !== true) return fail('licence-not-accepted', 'Show the licence and ask first; the tool is not downloaded until it is accepted.');
    if (Object.prototype.hasOwnProperty.call(cat, 'ownerUrl') && !cat.ownerUrl) return fail('owner-url-missing', 'The project address for this tool has not been supplied yet, so there is nothing to download. No address is guessed.');
    const plat = cat.platforms[platformKey(this.platform, this.arch)];
    if (!plat) return fail('unsupported-platform', `There is no download for ${this.platform} ${this.arch}. ${cat.manualHint || ''}`.trim());
    if (this.busy.has(id)) return fail('busy', 'This tool is already being installed.');
    this.busy.add(id);
    const staging = path.join(this.toolsDir, '.staging', `${id}-${crypto.randomBytes(6).toString('hex')}`);
    try {
      onProgress({ id, state: 'checksum', received: 0, total: 0 });
      const exp = await this._expectedSha(cat, plat, signal);
      if (exp.err) { this._record(id, exp.err); return exp.err; }
      fs.mkdirSync(path.join(staging, 'pkg'), { recursive: true });
      const archive = path.join(staging, 'download');
      const dl = await this._download(plat.url, cat, archive, onProgress, id, signal);
      if (dl.err) return dl.err;
      if (dl.sha !== exp.sha) { const e = fail('checksum-mismatch', `The download does not match its checksum (expected ${exp.sha.slice(0, 12)}..., got ${dl.sha.slice(0, 12)}...). It was deleted and nothing was installed.`); this._record(id, e); return e; }
      onProgress({ id, state: 'extracting', received: dl.bytes, total: dl.bytes });
      const ex = await this._unpack(archive, path.join(staging, 'pkg'), plat.archive, exeNameFor(cat, this.platform));
      if (ex.err) { this._record(id, ex.err); return ex.err; }
      return await this._finish(id, cat, staging, ex.exeRel, { url: plat.url, sha256: exp.sha, verifiedBy: exp.by, size: dl.bytes }, onProgress);
    } catch (e) {
      const err = fail('install-failed', `Install failed: ${(e && e.message) || 'unknown error'}. Nothing was installed.`);
      this._record(id, err); return err;
    } finally { rmrf(staging); this.busy.delete(id); }
  }

  async _download(url, cat, dest, onProgress, id, signal) {
    const g = await this._get(url, cat.hosts, signal);
    if (g.err) { this._record(id, g.err); return { err: g.err }; }
    const total = Number(g.res.headers.get('content-length')) || 0;
    if (total && cat.maxBytes && total > cat.maxBytes) { const e = fail('too-large', `The download is ${Math.round(total / 1048576)} MB, more than the ${Math.round(cat.maxBytes / 1048576)} MB allowed for this tool.`); this._record(id, e); return { err: e }; }
    const h = crypto.createHash('sha256'); let bytes = 0;
    const out = fs.createWriteStream(dest);
    try {
      for await (const chunk of g.res.body) {
        bytes += chunk.length;
        if (cat.maxBytes && bytes > cat.maxBytes) throw Object.assign(new Error('download is larger than allowed'), { tooLarge: true });
        h.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress({ id, state: 'downloading', received: bytes, total });
      }
    } catch (e) {
      out.destroy();
      const err = e.tooLarge ? fail('too-large', 'The download is larger than allowed for this tool and was stopped.') : (e && e.name === 'AbortError') ? fail('cancelled', 'The download was cancelled.') : fail('download-failed', `The download was interrupted (${(e && e.cause && e.cause.code) || e.message}). Nothing was installed.`, { host: g.host });
      this._record(id, err); return { err };
    }
    await new Promise((r, j) => out.end((x) => (x ? j(x) : r())));
    return { sha: h.digest('hex'), bytes };
  }

  _record(id, err) {
    // A failed attempt is recorded for the UI only if nothing is installed yet; it never overwrites a working install.
    const rec = this._readRecord(id);
    if (rec && rec.status === 'installed') return;
    try { this._writeRecord(id, { status: 'failed', reason: err.message, error: err.error, at: this.now() }); } catch { /* best effort */ }
  }

  async _unpack(archive, dest, kind, exeName) {
    try {
      if (kind === 'raw') fs.copyFileSync(archive, path.join(dest, exeName));
      else await this.extractImpl(archive, dest, kind);
    } catch (e) { return { err: fail('extract-failed', `The download could not be unpacked safely (${(e && e.message) || 'error'}). Nothing was installed.`) }; }
    // no links anywhere in what we unpacked, and the program must be a plain file
    const found = []; let bad = null;
    const walk = (d, depth) => {
      if (depth > 6) return;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isSymbolicLink()) { bad = 'it contains a symbolic link'; return; }
        if (ent.isDirectory()) walk(p, depth + 1); else if (ent.isFile() && ent.name === exeName) found.push(p);
      }
    };
    walk(dest, 0);
    if (bad) return { err: fail('extract-failed', `The download was refused: ${bad}. Nothing was installed.`) };
    if (!found.length) return { err: fail('extract-failed', `The download does not contain ${exeName}. Nothing was installed.`) };
    found.sort((a, b) => a.length - b.length);
    if (process.platform !== 'win32') fs.chmodSync(found[0], 0o755);
    return { exeRel: path.relative(dest, found[0]).split(path.sep).join('/') };
  }

  // The system extractors, after listing the archive and refusing absolute paths and "..".
  async _extract(archive, dest, kind) {
    let list;
    if (kind === 'tar.gz') list = await run('tar', ['-tzf', archive]);
    else if (kind === 'zip') list = this.platform === 'linux' ? await run('unzip', ['-Z1', archive]) : await run('tar', ['-tf', archive]);
    else throw new Error('unknown archive type');
    if (list.code !== 0) throw new Error(list.spawnError === 'ENOENT' ? 'no archive tool on this computer' : 'not a valid archive');
    const names = list.stdout.split(/\r?\n/).filter(Boolean);
    if (names.length > 20000) throw new Error('too many files');
    for (const n of names) if (n.startsWith('/') || n.includes('\\') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) throw new Error('unsafe path in archive');
    const r = kind === 'tar.gz' ? await run('tar', ['-xzf', archive, '-C', dest], { timeoutMs: 120000 })
      : this.platform === 'linux' ? await run('unzip', ['-q', '-o', archive, '-d', dest], { timeoutMs: 120000 }) : await run('tar', ['-xf', archive, '-C', dest], { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error('extraction failed');
  }

  // Move into place, run the self-test there, and only then write the record that says "installed".
  async _finish(id, cat, staging, exeRel, source, onProgress, adopted = null) {
    const final = path.join(this._dir(id), 'pkg'), prev = path.join(this._dir(id), 'pkg.prev');
    fs.mkdirSync(this._dir(id), { recursive: true });
    rmrf(prev);
    const hadPrev = fs.existsSync(final);
    if (hadPrev) fs.renameSync(final, prev);
    fs.renameSync(path.join(staging, 'pkg'), final);
    const exe = path.join(final, ...exeRel.split('/'));
    onProgress({ id, state: 'testing', received: 0, total: 0 });
    const st = await this.selfTest(cat, exe);
    if (!st.passed) {
      rmrf(final); if (hadPrev) fs.renameSync(prev, final);
      const e = fail('selftest-failed', `The program was downloaded and verified but did not pass its self-test (${st.detail}), so it is NOT installed.`, { detail: st.detail });
      this._record(id, e); this._log('tool-install-failed', { id, error: e.error, detail: st.detail }); return e;
    }
    const rec = { status: 'installed', tool: cat.tool, version: st.version, requestedVersion: cat.requestedVersion, exe: 'pkg/' + exeRel, exeSha256: await sha256File(exe), installedAt: this.now(), source, launcher: cat.launcher || [], selfTest: { passed: true, t: this.now(), detail: st.detail } };
    this._writeRecord(id, rec);
    rmrf(prev);
    this._log('tool-installed', { id, version: st.version, verifiedBy: source.verifiedBy });
    onProgress({ id, state: 'done', received: 0, total: 0 });
    return { ok: true, status: await this.status(id) };
  }

  // Runs the program's version command and requires the expected product text. A program that starts but answers something else fails.
  async selfTest(cat, exe) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfghost-selftest-'));
    try {
      const launcher = cat.launcher || [];
      const r = launcher.length ? await run(launcher[0], [...launcher.slice(1), exe, ...cat.versionArgs], { cwd: dir }) : await run(exe, cat.versionArgs, { cwd: dir });
      if (r.spawnError) return { passed: false, detail: `it could not start (${r.spawnError})` };
      if (r.killed) return { passed: false, detail: 'it did not answer in time' };
      const m = new RegExp(cat.versionRe, 'mi').exec(r.stdout + '\n' + r.stderr);
      if (!m) return { passed: false, detail: `it did not report a version we recognise (exit ${r.code})` };
      return { passed: true, version: m[1], detail: `${cat.tool} ${m[1]}` };
    } finally { rmrf(dir); }
  }

  // Use a copy that is already on this computer. Nothing is copied or redistributed; the file is recorded with its SHA-256 and re-checked on every run.
  async adopt(id, exePath, { licenceAccepted = false } = {}) {
    const cat = this.catalog[id];
    if (!cat) return fail('unknown-tool', 'That tool is not in the catalog.');
    if (licenceAccepted !== true) return fail('licence-not-accepted', 'Show the licence and ask first.');
    if (typeof exePath !== 'string' || !path.isAbsolute(exePath)) return fail('bad-path', 'Choose the program file.');
    let real, st;
    try { real = fs.realpathSync(exePath); st = fs.statSync(real); } catch { return fail('bad-path', 'That file does not exist.'); }
    if (!st.isFile()) return fail('bad-path', 'That is not a file.');
    const test = await this.selfTest(cat, real);
    if (!test.passed) { const e = fail('selftest-failed', `That program did not pass the self-test (${test.detail}), so it is NOT registered.`, { detail: test.detail }); return e; }
    this._writeRecord(id, { status: 'installed', adopted: true, tool: cat.tool, version: test.version, exe: real, exeSha256: await sha256File(real), installedAt: this.now(), source: { url: null, verifiedBy: 'user-supplied' }, launcher: cat.launcher || [], selfTest: { passed: true, t: this.now(), detail: test.detail } });
    this._log('tool-adopted', { id, version: test.version });
    return { ok: true, status: await this.status(id) };
  }

  remove(id) {
    if (!this.catalog[id]) return fail('unknown-tool', 'That tool is not in the catalog.');
    rmrf(this._dir(id));
    return { ok: true };
  }
}
module.exports = { ToolInstaller, platformKey };
