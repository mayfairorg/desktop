'use strict';
// The Sigma matcher: YAML subset reader, modifiers, conditions, and the things it must refuse rather than guess.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sigma = require(path.join(__dirname, '..', 'src', 'main', 'ghost', 'connectors-security', 'connectors', 'sigma-match', 'tool.js'));
const NOW = '2026-10-27T10:00:00.000Z';
const run = (rules, events) => sigma.parse({ rules, logs: events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') }, { now: NOW });
const hits = (res) => res.filter((r) => r.entity.type === 'sigma-match').map((r) => r.raw.event);
const skipped = (res) => res.filter((r) => r.entity.type === 'sigma-rule-skipped').map((r) => r.entity.value);
const rule = (det, extra = '') => `title: T\n${extra}detection:\n${det.split('\n').map((l) => '  ' + l).join('\n')}\n`;

test('yaml subset: maps, lists, lists of maps, flow lists, quotes, comments, block scalars, multiple documents', () => {
  const y = sigma.parseYaml("title: 'It''s ok' # comment\ntags:\n  - a.b\n  - \"c d\"\nflow: [1, 'x, y', true, null]\nnested:\n  k:\n    - m1: 1\n      m2: two\n    - m1: 3\ndesc: |\n  line one\n  line two\nfold: >\n  a\n  b\nsame:\n- x\n- y\n");
  assert.equal(y.title, "It's ok");
  assert.deepEqual([...y.tags], ['a.b', 'c d']);
  assert.deepEqual([...y.flow], [1, 'x, y', true, null]);
  assert.equal(y.nested.k[0].m2, 'two'); assert.equal(y.nested.k[1].m1, 3);
  assert.equal(y.desc, 'line one\nline two'); assert.equal(y.fold, 'a b');
  assert.deepEqual([...y.same], ['x', 'y']);
  assert.equal(sigma.parseYamlDocs('a: 1\n---\nb: 2\n').length, 2);
  assert.ok(sigma.parseYamlDocs('a: &x 1\n')[0].error, 'anchors are refused');
  assert.ok(sigma.parseYamlDocs('a:\n\tb: 1\n')[0].error, 'tab indentation is refused');
  const proto = sigma.parseYaml('__proto__:\n  polluted: 1\n');
  assert.equal({}.polluted, undefined); assert.ok(proto);
});
test('modifiers: contains, startswith, endswith, all, wildcards, case, re, cidr, comparisons, exists, null', () => {
  const ev = [{ A: 'Hello World', N: 5, IP: '10.1.2.3', P: 'C:\\Windows\\System32\\cmd.exe' }, { A: 'bye' }];
  const t = (det) => hits(run(rule(det + '\ncondition: s'), ev));
  assert.deepEqual(t('s:\n  A|contains: world'), [1]);
  assert.deepEqual(t('s:\n  A|startswith: hello'), [1]);
  assert.deepEqual(t('s:\n  A|endswith: WORLD'), [1]);
  assert.deepEqual(t('s:\n  A: hello*'), [1]);
  assert.deepEqual(t('s:\n  A: "h?llo world"'), [1]);
  assert.deepEqual(t('s:\n  A|contains|all:\n    - hello\n    - world'), [1]);
  assert.deepEqual(t('s:\n  A|contains:\n    - nothere\n    - bye'), [2]);
  assert.deepEqual(t('s:\n  A|cased|contains: hello'), []);
  assert.deepEqual(t('s:\n  A|re: "^hel+o"'), [1]);
  assert.deepEqual(t('s:\n  IP|cidr: 10.1.0.0/16'), [1]);
  assert.deepEqual(t('s:\n  N|gt: 4'), [1]);
  assert.deepEqual(t('s:\n  N|lt: 4'), []);
  assert.deepEqual(t('s:\n  N|exists: true'), [1]);
  assert.deepEqual(t('s:\n  N|exists: false'), [2]);
  assert.deepEqual(t('s:\n  N: null'), [2]);
  assert.deepEqual(t("s:\n  P|endswith: '\\cmd.exe'"), [1]);
});
test('conditions: and / or / not, parentheses, 1 of X*, all of X*, them', () => {
  const ev = [{ a: 1, b: 1 }, { a: 1 }, { b: 1 }, { c: 1 }];
  const det = 'sel_a:\n  a: 1\nsel_b:\n  b: 1\nfilter:\n  c: 1\n';
  const c = (cond) => hits(run(rule(det + 'condition: ' + cond), ev));
  assert.deepEqual(c('sel_a and sel_b'), [1]);
  assert.deepEqual(c('sel_a or sel_b'), [1, 2, 3]);
  assert.deepEqual(c('sel_a and not sel_b'), [2]);
  assert.deepEqual(c('not (sel_a or sel_b)'), [4]);
  assert.deepEqual(c('1 of sel_*'), [1, 2, 3]);
  assert.deepEqual(c('all of sel_*'), [1]);
  assert.deepEqual(c('1 of them'), [1, 2, 3, 4]);
  assert.deepEqual(c('all of them'), []);
});
test('lists of maps are OR, keyword lists search every value, dotted fields reach nested events', () => {
  assert.deepEqual(hits(run(rule('s:\n  - A: 1\n    B: 2\n  - A: 9\ncondition: s'), [{ A: 1, B: 2 }, { A: 9 }, { A: 1 }])), [1, 2]);
  assert.deepEqual(hits(run(rule('s:\n  - mimikatz\n  - sekurlsa\ncondition: s'), [{ x: { y: 'run MIMIKATZ' } }, { x: 'fine' }])), [1]);
  assert.deepEqual(hits(run(rule('s:\n  process.name: cmd.exe\ncondition: s'), [{ process: { name: 'cmd.exe' } }, { 'process.name': 'cmd.exe' }, { process: { name: 'x' } }])), [1, 2]);
});
test('unsupported features skip the rule with a reason; they never guess a match', () => {
  const ev = [{ A: 'x' }];
  const cases = {
    'aggregation': rule('s:\n  A: x\ncondition: s | count() > 2'), 'timeframe': rule('s:\n  A: x\ntimeframe: 5m\ncondition: s'), 'base64': rule('s:\n  A|base64: x\ncondition: s'),
    'windash': rule('s:\n  A|windash|contains: -x\ncondition: s'), 'unknown selection': rule('s:\n  A: x\ncondition: nope'), 'no condition': rule('s:\n  A: x\n'),
    'collection': 'title: T\naction: global\ndetection:\n  s:\n    A: x\n  condition: s\n', 'bad regex': rule('s:\n  A|re: "("\ncondition: s'), 'long regex': rule('s:\n  A|re: "' + 'a'.repeat(250) + '"\ncondition: s'),
    'correlation': 'title: T\ncorrelation:\n  type: event_count\n',
  };
  for (const [name, r] of Object.entries(cases)) { const res = run(r, ev); assert.deepEqual(hits(res), [], name); assert.equal(skipped(res).length, 1, name); assert.equal(res.find((x) => x.entity.type === 'sigma-rule-skipped').confidence, 'uncertain'); }
  const mixed = run(cases.aggregation + '---\n' + rule('s:\n  A: x\ncondition: s'), ev);
  assert.deepEqual(hits(mixed), [1]); assert.equal(skipped(mixed).length, 1);
});
test('matches carry author and licence (DRL attribution), and weak rule status lowers confidence', () => {
  const res = run(rule('s:\n  A: x\ncondition: s', 'id: abc\nstatus: experimental\nauthor: Jane Roe\nlicense: DRL-1.1\nlevel: high\n'), [{ A: 'x' }]);
  const m = res.find((r) => r.entity.type === 'sigma-match');
  assert.equal(m.confidence, 'uncertain'); assert.match(m.uncertaintyNote, /experimental/);
  assert.equal(m.raw.author, 'Jane Roe'); assert.equal(m.raw.license, 'DRL-1.1'); assert.equal(m.raw.level, 'high');
  assert.match(m.uncertaintyNote, /logsource is not checked/);
});
test('limits: bad log lines are counted, matches are capped, future timestamps are not trusted', () => {
  const r = run(rule('s:\n  A: x\ncondition: s'), ['not json', '[1]', { A: 'x', '@timestamp': '2999-01-01T00:00:00Z' }]);
  assert.match(r.find((x) => x.entity.type === 'parse-warning').entity.value, /^2 log lines/);
  assert.equal(r.find((x) => x.entity.type === 'sigma-match').observedAt, NOW);
  const many = run(rule('s:\n  A: x\ncondition: s'), Array.from({ length: 1200 }, () => ({ A: 'x' })));
  assert.equal(hits(many).length, 1000);
  assert.equal(many.find((x) => x.entity.type === 'output-truncated').confidence, 'uncertain');
});
test('built-in self-test behaves', () => { assert.equal(sigma.selfTest().filter((r) => r.entity.type === 'sigma-match').length, 1); });
