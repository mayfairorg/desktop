'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/main/ghost/manifest');
const R = require('../src/main/ghost/result');
const { baseManifest } = require('./ghost-helpers');

const clone = (o) => JSON.parse(JSON.stringify(o));
const bad = (mutate, expectText) => {
  const m = clone(baseManifest()); mutate(m);
  const r = M.validateManifest(m);
  assert.equal(r.ok, false, 'should be rejected: ' + expectText);
  assert.ok(r.errors.some((e) => e.includes(expectText)), `expected an error containing "${expectText}", got ${JSON.stringify(r.errors)}`);
};

test('the shipped sample manifest and the test manifest are valid and frozen', () => {
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/main/ghost/samples/sample-textstats/connector.json'), 'utf8'));
  const r = M.validateManifest(sample);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.ok(Object.isFrozen(r.manifest) && Object.isFrozen(r.manifest.command.args));
  assert.equal(M.validateManifest(baseManifest()).ok, true);
});
test('a native executable inside the connector folder is accepted', () => {
  const m = baseManifest({ command: { executable: 'bin/tool', args: ['--mode={mode}'], files: ['lib/helper.js'] } });
  assert.deepEqual(M.validateManifest(m).errors, []);
});
test('unknown keys are rejected everywhere', () => {
  bad((m) => { m.extra = 1; }, 'unknown key "extra"');
  bad((m) => { m.licence.note = 'x'; }, 'licence: unknown key');
  bad((m) => { m.command.shell = true; }, 'command: unknown key "shell"');
  bad((m) => { m.limits.nice = 5; }, 'limits: unknown key');
  bad((m) => { m.output.schema = 'x'; }, 'output: unknown key');
  bad((m) => { m.selfTest.timeout = 5; }, 'selfTest: unknown key');
  bad((m) => { m.input.fields[0].default = 'ok'; }, 'unknown key "default"');
  bad((m) => { m.input.fields[1].values = ['a']; }, 'unknown key "values"');
  bad((m) => { m.installRequirements = [{ name: 'x', check: ['true'], install: 'curl x | sh' }]; }, 'unknown key "install"');
});
test('every required key is required; wrong types are rejected', () => {
  for (const k of ['id', 'name', 'version', 'description', 'capabilities', 'scope', 'network', 'licence', 'installRequirements', 'command', 'input', 'output', 'limits', 'permissions', 'externalRestrictions', 'selfTest']) bad((m) => { delete m[k]; }, `missing "${k}"`);
  assert.equal(M.validateManifest(null).ok, false);
  assert.equal(M.validateManifest([]).ok, false);
  assert.equal(M.validateManifest('x').ok, false);
  bad((m) => { m.name = 5; }, 'name:');
  bad((m) => { m.capabilities = []; }, 'capabilities:');
  bad((m) => { m.capabilities = ['A b']; }, 'capabilities:');
});
test('id: lowercase letters, digits and hyphen only', () => {
  for (const id of ['Upper', 'has space', 'a/b', '../x', '-lead', 'trail-', 'under_score', '', 'x'.repeat(41), 'a.b']) bad((m) => { m.id = id; }, 'id:');
  for (const id of ['a', 'ab', 'a-b-c', 'x1', 'sample-textstats']) { const m = baseManifest({ id }); assert.equal(M.validateManifest(m).ok, true, id); }
});
test('version must be semver; scope, network, licence enums', () => {
  for (const v of ['1', '1.0', 'v1.0.0', '1.0.0.0', '01.0.0', 'latest']) bad((m) => { m.version = v; }, 'version:');
  for (const v of ['1.0.0', '0.1.0-beta.1', '2.3.4+build5']) assert.equal(M.validateManifest(baseManifest({ version: v })).ok, true, v);
  bad((m) => { m.scope = 'root'; }, 'scope:');
  bad((m) => { m.network = 'wide-open'; }, 'network:');
  bad((m) => { m.licence.mode = 'linked'; }, 'licence.mode');
  bad((m) => { m.licence.url = 'http://example.com/l'; }, 'licence.url');
  bad((m) => { m.licence.url = 'javascript:alert(1)'; }, 'licence.url');
  bad((m) => { m.licence.spdx = 'MIT; rm -rf'; }, 'licence.spdx');
  bad((m) => { delete m.licence.url; }, 'missing "url"');
});
test('executable: no traversal, no absolute paths, no shell characters', () => {
  const cases = ['../evil', 'a/../../evil', '/bin/sh', '/usr/bin/env', 'C:\\Windows\\cmd.exe', 'C:/x', '\\\\server\\share\\x', 'sh -c ls', 'a;b', 'a|b', 'a&b', 'a`b`', '$(id)', 'a b', 'a>b', 'a\nb', './x', 'a//b', 'a\\b', '', 'a\0b', '~/x', '*', 'x*', '$HOME/x', 'a$b'];
  for (const e of cases) bad((m) => { m.command.executable = e; }, 'command.executable');
  for (const e of ['bin/tool', 'tool.exe', 'run.sh', 'a-b/c_d/e.f']) assert.equal(M.validateManifest(baseManifest({ command: { executable: e, args: [] } })).ok, true, e);
});
test('command.args must be an array of strings with named placeholders only', () => {
  bad((m) => { m.command.args = '--mode={mode}'; }, 'must be an array');
  bad((m) => { m.command.args = 'run.js && rm -rf /'; }, 'must be an array');
  bad((m) => { m.command.args = [1]; }, 'command.args[0]: must be a string');
  bad((m) => { m.command.args = ['run.js', '{}']; }, 'not a named placeholder');
  bad((m) => { m.command.args = ['run.js', '{0}']; }, 'not a named placeholder');
  bad((m) => { m.command.args = ['run.js', '{ mode }']; }, 'not a named placeholder');
  bad((m) => { m.command.args = ['run.js', '{nope}']; }, 'not a declared input field');
  bad((m) => { m.command.args = ['run.js', '{mode']; }, 'unbalanced braces');
  bad((m) => { m.command.args = ['run.js', 'mode}']; }, 'unbalanced braces');
  bad((m) => { m.command.args = ['run.js', '{{mode}}']; }, 'unbalanced braces');
  bad((m) => { m.command.args = new Array(41).fill('x'); m.command.executable = 'x'; }, 'at most 40');
  bad((m) => { m.command.args = ['{mode}.js']; }, 'first argument must be the connector script');
  bad((m) => { m.command.args = ['../x.js']; }, 'first argument must be the connector script');
  bad((m) => { m.command.args = ['/etc/x.js']; }, 'first argument must be the connector script');
  bad((m) => { m.command.files = ['../../etc/passwd']; }, 'command.files[0]');
});
test('installRequirements: the check is an argv array, never a shell string', () => {
  bad((m) => { m.installRequirements = [{ name: 'x', check: 'which node' }]; }, 'argv array');
  bad((m) => { m.installRequirements = [{ name: 'x', check: [] }]; }, '1 to 8 elements');
  bad((m) => { m.installRequirements = [{ name: 'x', check: ['node; id', '-v'] }]; }, 'plain program name');
  bad((m) => { m.installRequirements = [{ name: 'x', check: ['a b'] }]; }, 'plain program name');
  bad((m) => { m.installRequirements = [{ name: 'x', check: ['$(id)'] }]; }, 'plain program name');
  bad((m) => { m.installRequirements = [{ name: 'x', check: ['../bin/x'] }]; }, 'check[0]');
  bad((m) => { m.installRequirements = [{ name: 'x', check: ['/bin/ls'] }]; }, 'check[0]');
  bad((m) => { m.installRequirements = [{ name: 'x', check: ['node', 5] }]; }, 'check[1]');
  bad((m) => { m.installRequirements = [{ check: ['node'] }]; }, 'name');
  assert.equal(M.validateManifest(baseManifest({ installRequirements: [{ name: 'Node', check: ['node', '--version'] }, { name: 'own', check: ['@node', '-e', '0'] }, { name: 'bundled', check: ['bin/self-check'] }] })).ok, true);
});
test('input schema: typed fields with bounds', () => {
  bad((m) => { m.input.fields[1].maxLength = 0; }, 'maxLength');
  bad((m) => { delete m.input.fields[1].maxLength; }, 'maxLength');
  bad((m) => { m.input.fields[1].maxLength = 100000; }, 'maxLength');
  bad((m) => { m.input.fields[1].pattern = '('; }, 'not a valid regular expression');
  bad((m) => { m.input.fields[0].values = []; }, 'values');
  bad((m) => { m.input.fields[0].values = ['a', 'a']; }, 'values');
  bad((m) => { m.input.fields[0] = { name: 'mode', type: 'integer', min: 5, max: 1 }; }, 'min <= max');
  bad((m) => { m.input.fields[0] = { name: 'mode', type: 'integer', min: 1.5, max: 3 }; }, 'integer min and max');
  bad((m) => { m.input.fields[0] = { name: 'mode', type: 'object' }; }, 'type must be one of');
  bad((m) => { m.input.fields[0].name = 'Bad-Name'; }, 'name must match');
  bad((m) => { m.input.fields.push({ name: 'text', type: 'url-host' }); }, 'unique');
  bad((m) => { m.input = { fields: [], extra: 1 }; }, 'input: unknown key');
});
test('limits, permissions and cross-field rules', () => {
  bad((m) => { m.limits.timeoutMs = 10; }, 'limits.timeoutMs');
  bad((m) => { m.limits.timeoutMs = 99999999; }, 'limits.timeoutMs');
  bad((m) => { m.limits.maxOutputBytes = 0; }, 'limits.maxOutputBytes');
  bad((m) => { m.limits.maxConcurrent = 100; }, 'limits.maxConcurrent');
  bad((m) => { m.limits.maxMemoryMb = 1; }, 'limits.maxMemoryMb');
  bad((m) => { delete m.limits.timeoutMs; }, 'missing "timeoutMs"');
  bad((m) => { m.output.format = 'text'; }, 'output.format');
  bad((m) => { m.permissions = ['root']; }, 'permissions:');
  bad((m) => { m.permissions = ['network', 'network']; }, 'permissions:');
  bad((m) => { m.permissions = ['network']; }, '"network" is declared but network is local');
  bad((m) => { m.network = 'keyless-external'; m.scope = 'passive'; }, 'must declare "network"');
  bad((m) => { m.network = 'rate-limited'; m.permissions = ['network']; m.scope = 'local'; }, 'local-scope connector cannot use the external network');
  bad((m) => { m.input.fields.push({ name: 'f', type: 'file', required: false }); m.command.args.push('--file={f}'); }, 'needs "read-picked-file"');
  bad((m) => { m.externalRestrictions = ''; }, 'externalRestrictions');
});
test('selfTest: must expect something, must be valid input, cannot use a file', () => {
  bad((m) => { m.selfTest.expect = {}; }, 'proves nothing');
  bad((m) => { m.selfTest.input = { mode: 'nonsense' }; }, 'selfTest.input.mode');
  bad((m) => { m.selfTest.input = {}; }, 'selfTest.input.mode: is required');
  bad((m) => { m.selfTest.input = { mode: 'ok', extra: 1 }; }, 'unknown field "extra"');
  bad((m) => { m.selfTest.expect = { minResults: -1 }; }, 'minResults');
  bad((m) => { m.selfTest.expect = { contains: [{ type: 'a' }] }; }, 'contains[0]');
  bad((m) => { m.permissions = ['read-picked-file']; m.input.fields.push({ name: 'f', type: 'file', required: false }); m.selfTest.input = { mode: 'ok', f: 'abcdefgh12345678' }; }, 'cannot use a file field');
});

test('input values: types, ranges, patterns, hosts, unknown fields', () => {
  const m = M.validateManifest(baseManifest({
    command: { executable: '@node', args: ['run.js', '--n={n}', '--h={h}', '--p={p}', '--e={e}'] },
    input: { fields: [
      { name: 'n', type: 'integer', min: 1, max: 10 },
      { name: 'h', type: 'url-host', required: false },
      { name: 'p', type: 'string', required: false, maxLength: 8, pattern: '^[a-z]+$' },
      { name: 'e', type: 'enum', values: ['a', 'b'], required: false },
    ] },
    selfTest: { input: { n: 3 }, expect: { minResults: 0 } },
  })).manifest;
  const v = (i) => M.validateInput(m, i);
  assert.equal(v({ n: 5 }).ok, true);
  assert.equal(v({ n: 0 }).ok, false);
  assert.equal(v({ n: 11 }).ok, false);
  assert.equal(v({ n: 1.5 }).ok, false);
  assert.equal(v({ n: '5' }).ok, false);
  assert.equal(v({}).ok, false);
  assert.equal(v({ n: 5, zzz: 1 }).ok, false, 'unknown field');
  assert.equal(v({ n: 5, h: 'Example.COM' }).values.h, 'example.com');
  for (const h of ['http://example.com', 'example.com/path', 'example.com:80', 'a b', '-bad.com', 'x;y.com', '$(id).com', '', ' example.com']) { const r = v({ n: 5, h }); if (h !== '') assert.equal(r.ok, false, h); }
  assert.equal(v({ n: 5, p: 'abc' }).ok, true);
  assert.equal(v({ n: 5, p: 'ABC' }).ok, false);
  assert.equal(v({ n: 5, p: 'abcdefghij' }).ok, false);
  assert.equal(v({ n: 5, e: 'c' }).ok, false);
  assert.equal(v({ n: 5, p: ['a'] }).ok, false);
  assert.equal(v('x').ok, false);
  assert.equal(v(null).ok, false);
});
test('argument expansion: one element per argument, values are never split; leading dash refused', () => {
  const m = M.validateManifest(baseManifest()).manifest;
  const r = M.expandArgs(m, { mode: 'echo', text: '; touch /tmp/pwned && echo $(id) `id` "q" \'s\' *' });
  assert.deepEqual(r.args, ['run.js', '--mode=echo', '--text=; touch /tmp/pwned && echo $(id) `id` "q" \'s\' *']);
  assert.deepEqual(M.expandArgs(m, { mode: 'echo' }).args, ['run.js', '--mode=echo'], 'an absent optional field drops its argument');
  const w = M.validateManifest(baseManifest({ command: { executable: '@node', args: ['run.js', '{mode}'] } })).manifest;
  assert.equal(M.expandArgs(w, { mode: '-rf' }).ok, false);
  assert.equal(M.expandArgs(w, { mode: 'echo' }).ok, true);
});

test('result schema: a valid result is normalised', () => {
  const good = { entity: { type: 'sha256', value: 'ab' }, source: { tool: 't', connector: 'c', version: '1' }, observedAt: '2026-10-27T10:00:00+01:00', confidence: 'likely', raw: { a: 1 } };
  const r = R.validateResult(good, { connector: 'c' });
  assert.equal(r.ok, true);
  assert.equal(r.result.observedAt, '2026-10-27T09:00:00.000Z');
  assert.deepEqual(r.result.raw, { a: 1 });
});
test('result schema: every malformed result is rejected with a reason', () => {
  const g = () => ({ entity: { type: 'note', value: 'v' }, source: { tool: 't', connector: 'c', version: '1' }, observedAt: '2026-10-27T10:00:00Z', confidence: 'confirmed' });
  const rej = (mut, text) => { const o = g(); mut(o); const r = R.validateResult(o, { connector: 'c' }); assert.equal(r.ok, false, text); assert.match(r.error, new RegExp(text)); };
  rej((o) => { delete o.entity; }, 'entity');
  rej((o) => { o.entity.type = 'Bad Type'; }, 'entity');
  rej((o) => { o.entity.value = ''; }, 'entity');
  rej((o) => { o.entity.extra = 1; }, 'entity');
  rej((o) => { delete o.source; }, 'source');
  rej((o) => { o.source.url = 'javascript:alert(1)'; }, 'source.url');
  rej((o) => { o.source.connector = 'other'; }, 'source.connector');
  rej((o) => { o.observedAt = 'yesterday'; }, 'observedAt');
  rej((o) => { o.observedAt = '2999-01-01T00:00:00Z'; }, 'future');
  rej((o) => { o.confidence = 'certain'; }, 'confidence');
  rej((o) => { o.confidence = 'uncertain'; }, 'uncertaintyNote');
  rej((o) => { o.extra = 1; }, 'unknown key');
  assert.equal(R.validateResult('x').ok, false);
  assert.equal(R.validateResult(null).ok, false);
  assert.equal(R.validateResult([]).ok, false);
});
test('result raw is capped, not dropped', () => {
  const o = { entity: { type: 'note', value: 'v' }, source: { tool: 't', connector: 'c', version: '1' }, observedAt: '2026-10-27T10:00:00Z', confidence: 'confirmed', raw: { blob: 'z'.repeat(50000) } };
  const r = R.validateResult(o, { connector: 'c' });
  assert.equal(r.ok, true);
  assert.equal(r.result.raw.truncated, true);
  assert.ok(r.result.raw.bytes > 50000 && r.result.raw.preview.length <= 1000);
});
test('progress lines', () => {
  assert.deepEqual(R.parseProgress({ progress: 0.5, message: 'half' }), { progress: 0.5, message: 'half' });
  assert.deepEqual(R.parseProgress({ progress: 1 }), { progress: 1, message: '' });
  assert.ok(R.parseProgress({ progress: 2 }).error);
  assert.ok(R.parseProgress({ progress: 'x' }).error);
  assert.ok(R.parseProgress({ progress: 0.1, other: 1 }).error);
  assert.equal(R.parseProgress({ entity: {} }), null);
});
