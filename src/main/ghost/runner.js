'use strict';
// Mayfair Ghost: JobRunner. Starts approved connectors as child processes (argv array, shell:false, cwd = connector folder, minimal env),
// reads their stdout as JSON lines, validates every result, enforces the manifest limits, and keeps a capped, persistent job history.
// A result that does not validate is rejected and recorded; the runner never repairs, invents or silently drops output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, minimalEnv, killTree, rssMb } = require('./proc');
const { validateResult, parseProgress } = require('./result');
const { scrub, redact } = require('./logger');

const TERMINAL = ['done', 'failed', 'cancelled', 'timed-out'];
const LINE_MAX = 64 * 1024, STDERR_MAX = 16 * 1024, MAX_RESULTS = 5000, ERRORS_KEEP = 20, PERSIST_RESULTS = 200, GET_RESULTS = 1000;

class JobRunner {
  constructor({ manager, log = null, ghostDir, picks = null, utility = null, vm = null, emit = () => {}, maxHistory = 100, globalMax = 4, queueMax = 20, now = Date.now, io = null }) {
    this.io = io;
    this.manager = manager; this.utility = utility; this.vm = vm; this.log = log; this.picks = picks; this.emit = emit; this.now = now;
    this.maxHistory = maxHistory; this.globalMax = globalMax; this.queueMax = queueMax;
    this.file = ghostDir ? path.join(ghostDir, 'jobs.json') : null;
    this.jobs = new Map();      // id -> job (history and live)
    this.live = new Map();      // id -> {spec, child, timers, ...}
    this.queue = [];            // job ids waiting for a slot
    this.waiters = new Map();
    this.lastProgressEmit = new Map();
    this.pendingEmit = new Map();
    this._load();
  }

  // ---------- history ----------
  _load() {
    if (!this.file) return;
    try {
      const d = JSON.parse(this.io ? this.io.read('jobs.json') : fs.readFileSync(this.file, 'utf8'));
      if (d && d.v === 1 && Array.isArray(d.jobs)) for (const j of d.jobs.slice(-this.maxHistory)) {
        if (!j || typeof j.id !== 'string') continue;
        if (!TERMINAL.includes(j.status)) { j.status = 'failed'; j.error = 'interrupted: the app closed while this job was running'; }
        this.jobs.set(j.id, j);
      }
    } catch { /* no history yet */ }
  }
  _persist() {
    if (!this.file) return;
    try {
      const terminal = [...this.jobs.values()].filter((j) => TERMINAL.includes(j.status)).slice(-this.maxHistory);
      const out = terminal.map((j) => ({ ...j, results: j.results.slice(0, PERSIST_RESULTS) }));
      if (this.io) { this.io.write('jobs.json', JSON.stringify({ v: 1, jobs: out })); return; }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, jobs: out }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* history is a convenience */ }
  }
  _trim() {
    const terminal = [...this.jobs.values()].filter((j) => TERMINAL.includes(j.status));
    for (const j of terminal.slice(0, Math.max(0, terminal.length - this.maxHistory))) this.jobs.delete(j.id);
  }
  _summary(j) {
    return { id: j.id, connector: j.connector, version: j.version, kind: j.kind, status: j.status, createdAt: j.createdAt, startedAt: j.startedAt, endedAt: j.endedAt, progress: j.progress, message: j.message, resultCount: j.resultCount, rejected: j.rejected, error: j.error || null, scope: j.scope ? { target: j.scope.target } : null };
  }
  list({ limit = 50, connector } = {}) {
    return [...this.jobs.values()].filter((j) => !connector || j.connector === connector).slice(-limit).reverse().map((j) => this._summary(j));
  }
  get(id) {
    const j = this.jobs.get(id);
    if (!j) return null;
    return { ...this._summary(j), input: j.input, errors: j.errors, stderr: j.stderr, stderrTruncated: j.stderrTruncated, exitCode: j.exitCode, results: j.results.slice(0, GET_RESULTS), resultsTruncated: j.results.length > GET_RESULTS || j.resultCount > j.results.length };
  }

  // ---------- submitting ----------
  // The only way to run anything: a connector id and an input object. Returns {ok, jobId, status} or {ok:false, error, message}.
  submit({ connector, input, scope, kind = 'job' }) {
    if (this.queue.length >= this.queueMax) return { ok: false, error: 'queue-full', message: 'too many jobs are waiting' };
    const selftest = kind === 'selftest';
    const prep = this.manager.prepareRun(connector, input, scope, { picks: this.picks, selftest });
    if (!prep.ok) { if (this.log) this.log.warn('run-refused', { connector: String(connector).slice(0, 40), error: prep.error }); return prep; }
    const spec = prep.spec;
    const id = 'j-' + this.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const job = { id, connector: spec.id, version: spec.version, kind, status: 'queued', createdAt: this.now(), startedAt: null, endedAt: null, progress: 0, message: '', results: [], resultCount: 0, rejected: 0, errors: [], stderr: '', stderrTruncated: false, exitCode: null, error: null, scope: spec.scope, input: spec.summary };
    if (spec.scopeKind === 'active') {
      if (!this.manager.audit({ event: 'run-requested', jobId: id, connector: spec.id, version: spec.version, kind, target: spec.scope.target, confirmedAuthorised: true, input: spec.summary })) return { ok: false, error: 'audit-failed', message: 'the audit log could not be written, so the run was not started' };
    }
    this.jobs.set(id, job);
    this.live.set(id, { spec, selftest, child: null, reason: null, timers: [] });
    this.queue.push(id);
    if (this.log) this.log.info('job-queued', { jobId: id, connector: spec.id, version: spec.version, kind, input: spec.summary }, spec.secrets);
    this._event(job, true);
    this._pump();
    return { ok: true, jobId: id, status: job.status };
  }
  wait(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return Promise.resolve(null);
    if (TERMINAL.includes(j.status)) return Promise.resolve(j);
    return new Promise((res) => { const w = this.waiters.get(jobId) || []; w.push(res); this.waiters.set(jobId, w); });
  }

  _runningOf(connector) { let n = 0; for (const id of this.live.keys()) { const j = this.jobs.get(id); if (j && j.status === 'running' && j.connector === connector) n++; } return n; }
  _runningCount() { let n = 0; for (const id of this.live.keys()) { const j = this.jobs.get(id); if (j && j.status === 'running') n++; } return n; }
  _pump() {
    for (let i = 0; i < this.queue.length;) {
      if (this._runningCount() >= this.globalMax) return;
      const id = this.queue[i], ctx = this.live.get(id);
      if (this._runningOf(ctx.spec.id) >= ctx.spec.limits.maxConcurrent) { i++; continue; }
      this.queue.splice(i, 1);
      this._start(id);
    }
  }

  // ---------- running ----------
  _start(id) {
    const job = this.jobs.get(id), ctx = this.live.get(id), spec = ctx.spec;
    if (!this.manager.stillValid(spec, ctx.selftest)) return this._finish(id, 'failed', 'the connector changed or was disabled before it started');
    job.status = 'running'; job.startedAt = this.now();
    this._event(job, true);
    if (this.log) this.log.info('job-start', { jobId: id, connector: spec.id, kind: job.kind }, spec.secrets);
    let child;
    try {
      if (spec.runtime === 'vm') {
        if (!this.vm) return this._finish(id, 'failed', 'the virtual computer is not available');
        child = this.vm.start({ spec, jobId: id, env: { MF_CONNECTOR_ID: spec.id, MF_JOB_ID: id } });
      } else if (spec.runtime === 'utility') {
        if (!this.utility) return this._finish(id, 'failed', 'the built-in Node runner is not available');
        child = this.utility.start({ script: spec.exe, args: spec.args, cwd: spec.dir, env: minimalEnv({ extra: { MF_CONNECTOR_ID: spec.id, MF_JOB_ID: id } }), execArgv: spec.execArgv });
      } else child = spawn(spec.exe, spec.args, { cwd: spec.dir, shell: false, env: minimalEnv({ node: spec.node, extra: { MF_CONNECTOR_ID: spec.id, MF_JOB_ID: id } }), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) { return this._finish(id, 'failed', 'could not start: ' + (e.code || e.message)); }
    ctx.child = child;
    const lim = spec.limits;
    let buf = Buffer.alloc(0), skipping = false, outBytes = 0, lineNo = 0, ended = false;
    const stop = (reason) => { if (!ctx.reason) { ctx.reason = reason; this._kill(child); } };
    const reject = (error, sample) => {
      job.rejected++;
      if (job.errors.length < ERRORS_KEEP) job.errors.push({ line: lineNo, error, ...(sample ? { sample: scrub(sample, spec.secrets) } : {}) });
      if (this.log) this.log.warn('result-rejected', { jobId: id, connector: spec.id, line: lineNo, error }, spec.secrets);
    };
    const onLine = (lb) => {
      lineNo++;
      const text = lb.toString('utf8').trim();
      if (!text) return;
      let o;
      try { o = JSON.parse(text); } catch { return reject('output line is not valid JSON', text.slice(0, 80)); }
      const pr = parseProgress(o);
      if (pr) {
        if (pr.error) return reject(pr.error, text.slice(0, 80));
        job.progress = pr.progress; job.message = redact(pr.message, spec.secrets); this._event(job, false);
        return;
      }
      const v = validateResult(o, { connector: spec.id, now: this.now() });
      if (!v.ok) return reject(v.error, text.slice(0, 80));
      if (job.resultCount >= MAX_RESULTS) return stop('too-many-results');
      job.resultCount++; job.results.push(v.result);
    };
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > lim.maxOutputBytes) { stop('output-too-large'); return; }
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) break;
        const line = buf.subarray(0, nl); buf = buf.subarray(nl + 1);
        if (skipping) { skipping = false; continue; }
        if (line.length > LINE_MAX) { lineNo++; reject('output line is longer than ' + LINE_MAX + ' bytes'); continue; }
        onLine(line);
      }
      if (buf.length > LINE_MAX) { if (!skipping) { lineNo++; reject('output line is longer than ' + LINE_MAX + ' bytes'); } skipping = true; buf = Buffer.alloc(0); }
    });
    let errBuf = '';
    child.stderr.on('data', (chunk) => {
      if (errBuf.length < STDERR_MAX) { errBuf += chunk.toString('utf8'); if (errBuf.length > STDERR_MAX) { errBuf = errBuf.slice(0, STDERR_MAX); job.stderrTruncated = true; } } else job.stderrTruncated = true;
    });
    ctx.timers.push(setTimeout(() => stop('timed-out'), lim.timeoutMs));
    if (lim.maxMemoryMb) ctx.timers.push(setInterval(() => { const r = rssMb(child.pid); if (r !== null && r > lim.maxMemoryMb) stop('memory-limit'); }, 400));
    const end = (code, signal, spawnError) => {
      if (ended) return; ended = true;
      if (!skipping && buf.length && buf.length <= LINE_MAX) onLine(buf);
      job.stderr = redact(errBuf, spec.secrets); job.exitCode = code;
      if (spawnError) return this._finish(id, 'failed', 'could not start: ' + (spawnError.code || spawnError.message));
      if (ctx.reason === 'cancelled') return this._finish(id, 'cancelled', null);
      if (ctx.reason === 'timed-out') return this._finish(id, 'timed-out', `no answer within ${lim.timeoutMs} ms`);
      if (ctx.reason) return this._finish(id, 'failed', { 'output-too-large': `output is larger than ${lim.maxOutputBytes} bytes`, 'too-many-results': `more than ${MAX_RESULTS} results`, 'memory-limit': `memory use above ${lim.maxMemoryMb} MB` }[ctx.reason] || ctx.reason);
      if (code !== 0) return this._finish(id, 'failed', `exit code ${code === null ? 'none' : code}${signal ? ' (' + signal + ')' : ''}${job.stderr ? ': ' + job.stderr.split('\n')[0].slice(0, 200) : ''}`);
      if (job.rejected > 0 && job.resultCount === 0) return this._finish(id, 'failed', 'no valid results: every output line was rejected');
      this._finish(id, 'done', null);
    };
    child.on('error', (e) => { if (child.pid === undefined) end(null, null, e); });
    child.on('close', (code, signal) => end(code, signal, null));
  }

  _finish(id, status, error) {
    const job = this.jobs.get(id), ctx = this.live.get(id);
    if (!job || TERMINAL.includes(job.status)) return;
    if (ctx) for (const t of ctx.timers) { clearTimeout(t); clearInterval(t); }
    this.queue = this.queue.filter((x) => x !== id);
    this.live.delete(id);
    job.status = status; job.endedAt = this.now(); job.error = error ? redact(error, ctx ? ctx.spec.secrets : []) : null;
    if (status === 'done') job.progress = 1;
    if (this.log) this.log.info('job-end', { jobId: id, connector: job.connector, status, resultCount: job.resultCount, rejected: job.rejected, exitCode: job.exitCode, ms: job.endedAt - (job.startedAt || job.createdAt), error: job.error }, ctx ? ctx.spec.secrets : []);
    if (ctx && ctx.spec.scopeKind === 'active') this.manager.audit({ event: 'run-finished', jobId: id, connector: job.connector, status, resultCount: job.resultCount });
    this._event(job, true);
    this.lastProgressEmit.delete(id);
    this._trim(); this._persist();
    for (const w of this.waiters.get(id) || []) w(job);
    this.waiters.delete(id);
    this._pump();
  }
  // Progress events are limited to about ten a second; the newest one is always delivered (trailing emit). State changes go out at once.
  _event(job, force) {
    const t = this.now();
    const wait = 100 - (t - (this.lastProgressEmit.get(job.id) || 0));
    const send = () => {
      this.lastProgressEmit.set(job.id, this.now());
      try { this.emit('ghost-job', { jobId: job.id, status: job.status, progress: job.progress, message: job.message }); } catch { /* listener failed */ }
    };
    const pend = this.pendingEmit.get(job.id);
    if (force || wait <= 0) { if (pend) { clearTimeout(pend); this.pendingEmit.delete(job.id); } return send(); }
    if (pend) return;
    const timer = setTimeout(() => { this.pendingEmit.delete(job.id); send(); }, wait);
    if (timer.unref) timer.unref();
    this.pendingEmit.set(job.id, timer);
  }

  // ---------- cancel ----------
  cancel(id) {
    const job = this.jobs.get(id), ctx = this.live.get(id);
    if (!job || !ctx || TERMINAL.includes(job.status)) return false;
    if (job.status === 'queued') { this._finish(id, 'cancelled', null); return true; }
    if (!ctx.reason) { ctx.reason = 'cancelled'; this._kill(ctx.child); }
    return true;
  }
  _kill(child) { if (child && typeof child.killTree === 'function') child.killTree(); else killTree(child); }
  cancelConnector(connector) { for (const [id] of [...this.live]) { const j = this.jobs.get(id); if (j && j.connector === connector) this.cancel(id); } }
  shutdown() { for (const [id] of [...this.live]) this.cancel(id); }
}

module.exports = { JobRunner, TERMINAL, LINE_MAX, STDERR_MAX, MAX_RESULTS };
