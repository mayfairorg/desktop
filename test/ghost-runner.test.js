'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { context, stage, tmp, sleep, until } = require('./ghost-helpers');
const { JobRunner } = require('../src/main/ghost/runner');

const run = async (c, id, input, scope) => { const r = c.runner.submit({ connector: id, input, scope }); assert.equal(r.ok, true, JSON.stringify(r)); return c.runner.wait(r.jobId); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a successful run: results validated and normalised, states and events in order', async () => {
  const c = context();
  const id = await c.ready();
  const r = c.runner.submit({ connector: id, input: { mode: 'ok' } });
  assert.equal(r.ok, true);
  assert.match(r.jobId, /^j-/);
  const job = await c.runner.wait(r.jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.resultCount, 2);
  assert.deepEqual(job.results.map((x) => x.entity.value), ['one', 'two']);
  const x = job.results[0];
  assert.deepEqual(Object.keys(x).sort(), ['confidence', 'entity', 'observedAt', 'source']);
  assert.equal(x.source.connector, id);
  assert.equal(job.exitCode, 0); assert.equal(job.rejected, 0); assert.equal(job.error, null);
  assert.ok(job.startedAt && job.endedAt >= job.startedAt);
  const ev = c.events.filter(([n, p]) => n === 'ghost-job' && p.jobId === r.jobId).map(([, p]) => p.status);
  assert.deepEqual([...new Set(ev)], ['queued', 'running', 'done']);
  assert.deepEqual(Object.keys(c.events[0][1]).sort(), ['jobId', 'message', 'progress', 'status']);
});
test('progress lines become progress events and are not results', async () => {
  const c = context();
  const id = await c.ready();
  const job = await run(c, id, { mode: 'progress' });
  assert.equal(job.status, 'done');
  assert.equal(job.resultCount, 1);
  assert.ok(c.events.some(([, p]) => p.jobId === job.id && p.progress === 0.5 && p.message === 'half'));
  assert.equal(job.progress, 1);
});
test('timeout kills the job and marks it timed-out', async () => {
  const c = context();
  const id = await c.ready({ limits: { timeoutMs: 600, maxOutputBytes: 100000, maxConcurrent: 2 } });
  const t0 = Date.now();
  const job = await run(c, id, { mode: 'sleep' });
  assert.equal(job.status, 'timed-out');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(job.resultCount, 1, 'what arrived before the timeout is kept');
  assert.match(job.error, /600 ms/);
});
test('cancel kills a running job and its child processes (process group)', async () => {
  const c = context();
  const id = await c.ready();
  const r = c.runner.submit({ connector: id, input: { mode: 'children' } });
  assert.ok(await until(() => c.runner.jobs.get(r.jobId).resultCount === 1), 'the connector started its child');
  const childPid = +c.runner.jobs.get(r.jobId).results[0].entity.value;
  assert.ok(alive(childPid));
  assert.equal(c.runner.cancel(r.jobId), true);
  const job = await c.runner.wait(r.jobId);
  assert.equal(job.status, 'cancelled');
  assert.ok(await until(() => !alive(childPid), 4000), 'the grandchild is gone too');
  assert.equal(c.runner.cancel(r.jobId), false, 'cancelling a finished job does nothing');
  assert.equal(c.runner.cancel('j-nonexistent'), false);
});
test('a queued job can be cancelled before it starts', async () => {
  const c = context();
  const id = await c.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 100000, maxConcurrent: 1 } });
  const a = c.runner.submit({ connector: id, input: { mode: 'sleep' } });
  const b = c.runner.submit({ connector: id, input: { mode: 'ok' } });
  assert.equal(b.status, 'queued', 'maxConcurrent 1: the second waits');
  assert.equal(c.runner.cancel(b.jobId), true);
  assert.equal((await c.runner.wait(b.jobId)).status, 'cancelled');
  assert.equal(c.runner.jobs.get(b.jobId).startedAt, null);
  c.runner.cancel(a.jobId); await c.runner.wait(a.jobId);
});
test('concurrency limit: the next job starts when a slot frees', async () => {
  const c = context();
  const id = await c.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 100000, maxConcurrent: 1 } });
  const a = c.runner.submit({ connector: id, input: { mode: 'sleep' } });
  const b = c.runner.submit({ connector: id, input: { mode: 'ok' } });
  assert.ok(await until(() => c.runner.jobs.get(a.jobId).status === 'running'));
  assert.equal(c.runner.jobs.get(b.jobId).status, 'queued');
  c.runner.cancel(a.jobId);
  assert.equal((await c.runner.wait(b.jobId)).status, 'done');
});
test('the queue is bounded', async () => {
  const c = context();
  const id = await c.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 100000, maxConcurrent: 1 } });
  c.runner.queueMax = 2;
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(c.runner.submit({ connector: id, input: { mode: 'sleep' } }));
  const over = c.runner.submit({ connector: id, input: { mode: 'sleep' } });
  assert.equal(over.ok, false); assert.equal(over.error, 'queue-full');
  c.runner.shutdown();
  for (const r of ids) await c.runner.wait(r.jobId);
});
test('output cap: the job is killed and fails, not truncated silently', async () => {
  const c = context();
  const id = await c.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 20000, maxConcurrent: 1 } });
  const job = await run(c, id, { mode: 'spam' });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /output is larger than 20000 bytes/);
});
test('a malformed JSON line is rejected and recorded; later valid lines still count', async () => {
  const c = context();
  const id = await c.ready();
  const job = await run(c, id, { mode: 'badjson' });
  assert.equal(job.status, 'done');
  assert.equal(job.rejected, 1);
  assert.equal(job.resultCount, 1);
  assert.equal(job.errors[0].line, 1);
  assert.match(job.errors[0].error, /not valid JSON/);
  assert.equal(job.errors[0].sample, 'not json at all');
  const g = c.runner.get(job.id);
  assert.equal(g.rejected, 1); assert.equal(g.errors.length, 1);
});
test('a result that does not validate is rejected, and a job with nothing valid fails', async () => {
  const c = context();
  const id = await c.ready();
  const job = await run(c, id, { mode: 'invalid' });
  assert.equal(job.status, 'failed');
  assert.equal(job.resultCount, 0);
  assert.equal(job.rejected, 1);
  assert.match(job.errors[0].error, /source must be/);
  assert.match(job.error, /no valid results/);
  for (const [mode, text] of [['future', /future/], ['wrongsource', /source\.connector/], ['uncertain', /uncertaintyNote/]]) {
    const j = await run(c, id, { mode });
    assert.equal(j.resultCount, 0, mode); assert.match(j.errors[0].error, text, mode);
  }
});
test('an overlong line is rejected, and the stream recovers', async () => {
  const c = context();
  const id = await c.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 1048576, maxConcurrent: 1 } });
  const job = await run(c, id, { mode: 'longline' });
  assert.equal(job.status, 'done');
  assert.equal(job.rejected, 1);
  assert.match(job.errors[0].error, /longer than 65536 bytes/);
  assert.equal(job.resultCount, 1);
  assert.equal(job.results[0].entity.value, 'after');
});
test('raw is capped in the stored result', async () => {
  const c = context();
  const id = await c.ready();
  const job = await run(c, id, { mode: 'bigraw' });
  assert.equal(job.results[0].raw.truncated, true);
});
test('stderr is captured but capped', async () => {
  const c = context();
  const id = await c.ready();
  const job = await run(c, id, { mode: 'stderr' });
  assert.equal(job.status, 'done');
  assert.equal(job.stderr.length, 16 * 1024);
  assert.equal(job.stderrTruncated, true);
});
test('a non-zero exit fails the job with the exit code and the first stderr line', async () => {
  const c = context();
  const id = await c.ready();
  const job = await run(c, id, { mode: 'fail' });
  assert.equal(job.status, 'failed'); assert.equal(job.exitCode, 3);
  assert.match(job.error, /exit code 3: boom/);
});
test('the environment is stripped: no inherited secrets', async () => {
  process.env.GHOST_TEST_SECRET = 'hunter2'; process.env.AWS_SECRET_ACCESS_KEY = 'x'; process.env.NODE_OPTIONS = '--max-old-space-size=100';
  try {
    const c = context();
    const id = await c.ready();
    const job = await run(c, id, { mode: 'env' });
    assert.equal(job.status, 'done');
    const keys = job.results[0].entity.value.split(',');
    for (const k of keys) assert.ok(['PATH', 'LANG', 'TMPDIR', 'ELECTRON_RUN_AS_NODE', 'MF_CONNECTOR_ID', 'MF_JOB_ID'].includes(k), 'unexpected variable ' + k);
    assert.ok(!keys.includes('GHOST_TEST_SECRET') && !keys.includes('AWS_SECRET_ACCESS_KEY') && !keys.includes('NODE_OPTIONS') && !keys.includes('HOME'));
    assert.ok(keys.includes('MF_JOB_ID') && keys.includes('ELECTRON_RUN_AS_NODE'));
  } finally { delete process.env.GHOST_TEST_SECRET; delete process.env.AWS_SECRET_ACCESS_KEY; delete process.env.NODE_OPTIONS; }
});
test('argv is not shell-interpolated: "; touch ..." is just text', async () => {
  const c = context();
  const id = await c.ready();
  const marker = path.join(tmp(), 'pwned');
  const evil = [`; touch ${marker}`, `&& touch ${marker}`, `$(touch ${marker})`, '`touch ' + marker + '`', `| touch ${marker}`, `\n touch ${marker}`, '; touch /tmp/pwned', '"; touch /tmp/pwned; "'];
  fs.rmSync('/tmp/pwned', { force: true });
  for (const text of evil) {
    const job = await run(c, id, { mode: 'echo', text });
    assert.equal(job.status, 'done');
    assert.equal(job.results[0].entity.value, text, 'the program received the text exactly as one argument');
  }
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync('/tmp/pwned'), false);
});
test('the working directory is the connector folder', async () => {
  const c = context();
  const id = await c.ready({}, { script: require('./ghost-helpers').SCRIPT.replace("else if (mode === 'echo')", "else if (mode === 'echo' && text === 'cwd') { res(process.cwd()); }\nelse if (mode === 'echo')") });
  const job = await run(c, id, { mode: 'echo', text: 'cwd' });
  assert.equal(fs.realpathSync(job.results[0].entity.value), fs.realpathSync(path.join(c.root, 'connectors', id)));
});
test('a bad input never starts a process', async () => {
  const c = context();
  const id = await c.ready();
  for (const input of [{ mode: 'nope' }, {}, { mode: 'ok', extra: 'x' }, { mode: 'echo', text: 'x'.repeat(5000) }, { mode: 'echo', text: 5 }, 'str', null, { mode: ['ok'] }]) {
    const r = c.runner.submit({ connector: id, input });
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.error, 'bad-input');
  }
  assert.equal(c.runner.list().length, 0);
});
test('only registered, approved AND enabled connectors run', async () => {
  const c = context();
  assert.equal(c.runner.submit({ connector: 'unknown', input: {} }).error, 'broken');
  assert.equal(c.runner.submit({ connector: '../../bin/sh', input: {} }).error, 'bad-id');
  assert.equal(c.runner.submit({ connector: 'a b', input: {} }).error, 'bad-id');
  assert.equal(c.runner.submit({ connector: 5, input: {} }).error, 'bad-id');
  const id = c.manager.register(stage()).id;
  assert.equal(c.runner.submit({ connector: id, input: { mode: 'ok' } }).error, 'not-approved');
  await c.manager.requestApproval(id);
  assert.equal(c.runner.submit({ connector: id, input: { mode: 'ok' } }).error, 'not-enabled');
  c.manager.enable(id);
  assert.equal(c.runner.submit({ connector: id, input: { mode: 'ok' } }).ok, true);
  c.manager.disable(id);
  assert.equal(c.runner.submit({ connector: id, input: { mode: 'ok' } }).error, 'not-enabled');
  assert.equal(c.runner.jobs.size >= 1, true);
});
test('disabling cancels the connector\'s running jobs', async () => {
  const c = context();
  const id = await c.ready();
  const r = c.runner.submit({ connector: id, input: { mode: 'sleep' } });
  await until(() => c.runner.jobs.get(r.jobId).status === 'running');
  c.manager.disable(id);
  assert.equal((await c.runner.wait(r.jobId)).status, 'cancelled');
});
test('a file changed between queueing and starting is not run', async () => {
  const c = context();
  const id = await c.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 100000, maxConcurrent: 1 } });
  const a = c.runner.submit({ connector: id, input: { mode: 'sleep' } });
  const b = c.runner.submit({ connector: id, input: { mode: 'ok' } });
  fs.appendFileSync(path.join(c.root, 'connectors', id, 'run.js'), '//tampered');
  c.runner.cancel(a.jobId);
  const job = await c.runner.wait(b.jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /changed or was disabled/);
  assert.equal(job.startedAt, null);
});
test('memory limit (best effort, Linux): the job is killed above the limit', { skip: process.platform !== 'linux' }, async () => {
  const c = context();
  const id = await c.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 100000, maxConcurrent: 1, maxMemoryMb: 128 } });
  const job = await run(c, id, { mode: 'mem' });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /memory use above 128 MB/);
});
test('a program that cannot start fails the job cleanly', async () => {
  const c = context();
  const id = await c.ready({ command: { executable: 'tool.sh', args: [] }, input: { fields: [{ name: 'mode', type: 'enum', values: ['ok'] }] }, selfTest: { input: { mode: 'ok' }, expect: { minResults: 0 } } }, { extra: { 'tool.sh': 'no shebang, not executable' } });
  fs.chmodSync(path.join(c.root, 'connectors', id, 'tool.sh'), 0o644);
  const job = await run(c, id, { mode: 'ok' });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /could not start: EACCES/);
});

test('history is capped and persists; a job left running by a crash is shown as failed', async () => {
  const c = context({ maxHistory: 3 });
  const id = await c.ready();
  for (let i = 0; i < 5; i++) await run(c, id, { mode: 'ok' });
  assert.equal(c.runner.list({ limit: 50 }).length, 3);
  const file = path.join(c.root, 'ghost', 'jobs.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(d.jobs.length, 3);
  d.jobs[0].status = 'running'; fs.writeFileSync(file, JSON.stringify(d));
  const r2 = new JobRunner({ manager: c.manager, ghostDir: path.join(c.root, 'ghost'), maxHistory: 3 });
  assert.equal(r2.list().length, 3);
  assert.equal(r2.get(d.jobs[0].id).status, 'failed');
  assert.match(r2.get(d.jobs[0].id).error, /interrupted/);
  assert.equal(r2.list({ connector: 'other' }).length, 0);
  const sum = r2.list()[0];
  assert.deepEqual(Object.keys(sum).sort(), ['connector', 'createdAt', 'endedAt', 'error', 'id', 'kind', 'message', 'progress', 'rejected', 'resultCount', 'scope', 'startedAt', 'status', 'version']);
});
test('sensitive inputs never reach the log, the history or the audit trail', async () => {
  const c = context();
  const id = await c.ready({
    scope: 'active', network: 'keyless-external', permissions: ['network'], externalRestrictions: 'Only systems you own.',
    command: { executable: '@node', args: ['run.js', '--mode={mode}', '--token={token}', '--host={target}'] },
    input: { fields: [{ name: 'mode', type: 'enum', values: ['ok'] }, { name: 'token', type: 'string', maxLength: 100, sensitive: true }, { name: 'target', type: 'url-host' }] },
    selfTest: { input: { mode: 'ok', token: 'tok-selftest', target: 'example.com' }, expect: { minResults: 1 } },
  });
  const secret = 'S3CRET-VALUE-12345';
  const job = await run(c, id, { mode: 'ok', token: secret, target: 'example.com' }, { target: 'example.com', confirmedAuthorised: true });
  assert.equal(job.status, 'done');
  assert.equal(job.input.token, '***');
  const files = [path.join(c.root, 'ghost', 'jobs.json'), path.join(c.root, 'ghost', 'audit.jsonl'), path.join(c.root, 'ghost', 'logs', 'ghost.log')];
  for (const f of files) assert.ok(fs.existsSync(f), f);
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('S3CRET'), 'secret leaked into ' + path.basename(f) + ' (inputs only)');
  assert.ok(fs.readFileSync(path.join(c.root, 'ghost', 'logs', 'ghost.log'), 'utf8').includes('"token":"***"'));
});
test('logs are structured JSON lines, filterable by job, and rotated', async () => {
  const c = context();
  const id = await c.ready();
  const a = await run(c, id, { mode: 'ok' });
  const b = await run(c, id, { mode: 'badjson' });
  const all = c.log.tail({ n: 500 });
  assert.ok(all.length >= 6 && all.every((l) => typeof l.t === 'number' && l.level && l.event));
  const ja = c.log.tail({ jobId: a.id, n: 50 });
  assert.ok(ja.length >= 3 && ja.every((l) => l.jobId === a.id));
  assert.deepEqual(ja.map((l) => l.event).filter((e) => e.startsWith('job-')), ['job-queued', 'job-start', 'job-end']);
  assert.ok(c.log.tail({ jobId: b.id }).some((l) => l.event === 'result-rejected'));
  assert.equal(c.log.tail({ n: 2 }).length, 2);
  assert.equal(c.log.tail({ jobId: 'j-none' }).length, 0);
  // rotation
  const { GhostLog } = require('../src/main/ghost/logger');
  const dir = tmp('mfd-log-'); const l = new GhostLog(dir, { maxBytes: 2000, keep: 2 });
  for (let i = 0; i < 100; i++) l.info('x', { i, pad: 'p'.repeat(100) });
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['ghost.log', 'ghost.log.1', 'ghost.log.2']);
  assert.ok(fs.statSync(path.join(dir, 'ghost.log')).size <= 2000);
  assert.ok(l.tail({ n: 500 }).length > 10);
  assert.equal(l.tail({ n: 500 }).at(-1).i, 99);
});
