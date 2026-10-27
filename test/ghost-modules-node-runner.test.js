'use strict';
// Part A: '@node' connectors in an installed build (RunAsNode fuse OFF) run through the utilityProcess adapter. Electron is not
// available here, so a stand-in utilityProcess (test/ghost-utility-fake.js) forks the same bootstrap in plain Node with the exact env.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmp, stage, sleep, until } = require('./ghost-helpers');
const { makeFake } = require('./ghost-utility-fake');
const { ConnectorManager } = require('../src/main/ghost/manager');
const { JobRunner } = require('../src/main/ghost/runner');
const { GhostLog } = require('../src/main/ghost/logger');
const { PickStore } = require('../src/main/ghost/picks');
const { createUtilityRunner, descendants, BOOTSTRAP } = require('../src/main/ghost/node-runner/adapter');

function ctxFor({ nodeAvailable, fake = makeFake(), withUtility = true } = {}) {
  const root = tmp();
  const log = new GhostLog(path.join(root, 'ghost', 'logs'));
  const utility = withUtility ? createUtilityRunner({ utilityProcess: fake, killGraceMs: 300 }) : null;
  const manager = new ConnectorManager({ root, nodeAvailable, utility, confirm: async () => true, log });
  const runner = new JobRunner({ manager, log, ghostDir: path.join(root, 'ghost'), picks: new PickStore(), utility });
  manager.setRunner(runner);
  const ready = async (over, opts) => {
    const r = manager.register(stage(over, opts));
    assert.equal(r.ok, true, JSON.stringify(r));
    await manager.requestApproval(r.id); manager.enable(r.id);
    return r.id;
  };
  return { root, manager, runner, utility, fake, ready };
}
const go = async (c, id, input) => { const r = c.runner.submit({ connector: id, input }); assert.equal(r.ok, true, JSON.stringify(r)); return c.runner.wait(r.jobId); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('fuse off: an @node connector runs in the utility process with normalised results', async () => {
  const c = ctxFor({ nodeAvailable: false });
  const id = await c.ready();
  const job = await go(c, id, { mode: 'ok' });
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(job.results.map((r) => r.entity.value), ['one', 'two']);
  assert.equal(job.results[0].source.connector, id);
  assert.equal(c.fake.forks.length, 1);
  assert.equal(c.fake.forks[0].modulePath, BOOTSTRAP);
  assert.equal(c.fake.forks[0].opts.stdio, 'pipe');
  assert.equal(c.fake.forks[0].opts.cwd, path.join(c.root, 'connectors', id));
});

test('the utility runner never needs ELECTRON_RUN_AS_NODE and gives the connector the same minimal environment', async () => {
  const c = ctxFor({ nodeAvailable: false });
  const id = await c.ready();
  const job = await go(c, id, { mode: 'env' });
  assert.equal(job.status, 'done', job.error);
  const keys = job.results[0].entity.value.split(',');
  assert.deepEqual(keys, ['LANG', 'MF_CONNECTOR_ID', 'MF_JOB_ID', 'PATH', 'TMPDIR']);
  assert.equal('ELECTRON_RUN_AS_NODE' in c.fake.forks[0].opts.env, false);
});

test('same normalised output as the plain-process runner', async () => {
  const strip = (j) => j.results.map((r) => ({ ...r, observedAt: 'x' }));
  const a = ctxFor({ nodeAvailable: true }), b = ctxFor({ nodeAvailable: false });
  const ja = await go(a, await a.ready(), { mode: 'uncertain' }), jb = await go(b, await b.ready(), { mode: 'uncertain' });
  assert.equal(ja.status, 'failed'); assert.equal(jb.status, 'failed');       // uncertain without a note is rejected the same way
  assert.equal(ja.error, jb.error); assert.equal(ja.rejected, jb.rejected);
  const oa = await go(a, a.manager.discover()[0], { mode: 'badjson' }), ob = await go(b, b.manager.discover()[0], { mode: 'badjson' });
  assert.deepEqual(strip(oa), strip(ob)); assert.deepEqual(oa.errors, ob.errors); assert.equal(oa.status, ob.status);
});

test('input is one argument: shell text stays text', async () => {
  const c = ctxFor({ nodeAvailable: false });
  const id = await c.ready();
  const marker = path.join(tmp(), 'owned');
  const job = await go(c, id, { mode: 'echo', text: `; touch ${marker}; echo $HOME` });
  assert.equal(job.status, 'done');
  assert.equal(job.results[0].entity.value, `; touch ${marker}; echo $HOME`);
  assert.equal(fs.existsSync(marker), false);
});

test('timeout, cancel and the output cap behave as for plain children', async () => {
  const c = ctxFor({ nodeAvailable: false });
  const id = await c.ready({ limits: { timeoutMs: 700, maxOutputBytes: 1048576, maxConcurrent: 4 } });
  const t = await go(c, id, { mode: 'sleep' });
  assert.equal(t.status, 'timed-out');
  assert.equal(t.results.length, 1);
  const r = c.runner.submit({ connector: id, input: { mode: 'sleep' } });
  await until(() => c.runner.get(r.jobId).resultCount === 1);
  assert.equal(c.runner.cancel(r.jobId), true);
  assert.equal((await c.runner.wait(r.jobId)).status, 'cancelled');
  const c2 = ctxFor({ nodeAvailable: false });
  const id2 = await c2.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 50000, maxConcurrent: 2 } });
  const big = await go(c2, id2, { mode: 'spam' });
  assert.equal(big.status, 'failed'); assert.match(big.error, /larger than 50000/);
});

test('cancel kills the process and everything it started', async () => {
  const c = ctxFor({ nodeAvailable: false });
  const id = await c.ready();
  const r = c.runner.submit({ connector: id, input: { mode: 'children' } });
  await until(() => c.runner.get(r.jobId).resultCount === 1);
  const childPid = Number(c.runner.get(r.jobId).results[0].entity.value);
  assert.equal(alive(childPid), true);
  c.runner.cancel(r.jobId);
  assert.equal((await c.runner.wait(r.jobId)).status, 'cancelled');
  assert.equal(await until(() => !alive(childPid), 3000), true, 'grandchild is gone');
});

test('the memory limit reaches the utility process and is enforced', async () => {
  const c = ctxFor({ nodeAvailable: false });
  const id = await c.ready({ limits: { timeoutMs: 15000, maxOutputBytes: 1048576, maxConcurrent: 2, maxMemoryMb: 128 } });
  const job = await go(c, id, { mode: 'mem' });
  assert.deepEqual(c.fake.forks[0].opts.execArgv, ['--max-old-space-size=128']);
  if (process.platform === 'linux') { assert.equal(job.status, 'failed'); assert.match(job.error, /memory use above 128 MB/); }
});

test('a self-test passes under the utility runtime (requirement check included)', async () => {
  const c = ctxFor({ nodeAvailable: false });
  const r = c.manager.register(stage({ installRequirements: [{ name: 'Built-in Node runtime', check: ['@node', '-e', 'process.exit(0)'] }] }));
  await c.manager.requestApproval(r.id);
  const t = await c.manager.test(r.id);
  assert.equal(t.passed, true, JSON.stringify(t));
  const bad = c.manager.register(stage({ id: 'bad-req', installRequirements: [{ name: 'fails', check: ['@node', '-e', 'process.exit(3)'] }] }));
  await c.manager.requestApproval(bad.id);
  const reqs = await c.manager.checkRequirements(bad.id);
  assert.equal(reqs[0].status, 'missing'); assert.match(reqs[0].detail, /code 3/);
});

test('fuse off and no utility process available: still refused, the app binary is never started', async () => {
  const c = ctxFor({ nodeAvailable: false, withUtility: false });
  const id = await c.ready();
  const r = c.runner.submit({ connector: id, input: { mode: 'ok' } });
  assert.equal(r.ok, false); assert.equal(r.error, 'runtime-unavailable');
});

test('a fork that throws fails the job cleanly', async () => {
  const c = ctxFor({ nodeAvailable: false, fake: makeFake({ failFork: true }) });
  const id = await c.ready();
  const job = await go(c, id, { mode: 'ok' });
  assert.equal(job.status, 'failed'); assert.match(job.error, /could not start: EFORK/);
});

test('bootstrap: argv layout, private variables removed, bad input refused', () => {
  const dir = tmp();
  const script = path.join(dir, 's.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({argv: process.argv.slice(1), leaked: Object.keys(process.env).filter((k) => k.startsWith("MF_RUN"))}))');
  const env = { PATH: process.env.PATH };
  let r = spawnSync(process.execPath, [BOOTSTRAP], { env: { ...env, MF_RUN_SCRIPT: script, MF_RUN_ARGS: JSON.stringify(['--a=1', 'b c']) }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout), { argv: [script, '--a=1', 'b c'], leaked: [] });
  r = spawnSync(process.execPath, [BOOTSTRAP], { env: { ...env, MF_RUN_SCRIPT: 'relative.js' }, encoding: 'utf8' });
  assert.equal(r.status, 70);
  r = spawnSync(process.execPath, [BOOTSTRAP], { env: { ...env, MF_RUN_SCRIPT: script, MF_RUN_ARGS: '[1]' }, encoding: 'utf8' });
  assert.equal(r.status, 70);
});

test('descendants walks the table deepest first and ignores cycles', () => {
  const table = () => [[10, 1], [11, 10], [12, 11], [13, 10], [99, 98], [14, 14]];
  assert.deepEqual(descendants(10, table).sort(), [11, 12, 13]);
  assert.deepEqual(descendants(98, table), [99]);
  assert.deepEqual(descendants(5, () => { throw new Error('x'); }), []);
  assert.equal(createUtilityRunner({ utilityProcess: null }), null);
});
