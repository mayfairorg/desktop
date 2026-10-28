'use strict';
// The master search's first step: what was typed, what it was understood as, and the other readings. Pure and deterministic.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, normalise, KINDS } = require('../src/main/ghost/app/search');
const UI = require('../src/ui/ghost/modules');

// [input, kind, value]
const TABLE = [
  ['example.com', 'domain', 'example.com'],
  ['  Example.COM  ', 'domain', 'example.com'],
  ['example.com.', 'domain', 'example.com'],
  ['sub.domain.example.co.uk', 'domain', 'sub.domain.example.co.uk'],
  ['*.example.org', 'domain', 'example.org'],
  ['xn--bcher-kva.example', 'domain', 'xn--bcher-kva.example'],
  ['bücher.example', 'domain', 'xn--bcher-kva.example'],
  ['my-site.io', 'domain', 'my-site.io'],
  ['8.8.8.8', 'ip', '8.8.8.8'],
  ['192.168.1.10', 'ip', '192.168.1.10'],
  ['2001:DB8::1', 'ip', '2001:db8::1'],
  ['::1', 'ip', '::1'],
  ['10.0.0.0/8', 'cidr', '10.0.0.0/8'],
  ['192.0.2.0/24', 'cidr', '192.0.2.0/24'],
  ['2001:db8::/32', 'cidr', '2001:db8::/32'],
  ['AS15169', 'asn', 'AS15169'],
  ['as15169', 'asn', 'AS15169'],
  ['AS 13335', 'asn', 'AS13335'],
  ['https://example.com/a/b?c=d#frag', 'url', 'https://example.com/a/b?c=d'],
  ['http://example.com', 'url', 'http://example.com/'],
  ['example.com/page', 'url', 'https://example.com/page'],
  ['https://1.2.3.4:8080/x', 'url', 'https://1.2.3.4:8080/x'],
  ['http://[::1]/x', 'url', 'http://[::1]/x'],
  ['a'.repeat(64), 'cert-hash', 'a'.repeat(64)],
  ['0123456789ABCDEF'.repeat(4), 'cert-hash', '0123456789abcdef'.repeat(4)],
  ['0123456789abcdef0123456789abcdef01234567', 'cert-hash', '0123456789abcdef0123456789abcdef01234567'],
  [Array.from({ length: 32 }, () => 'AB').join(':'), 'cert-hash', 'ab'.repeat(32)],
  ['5493001KJTIIGC8Y1R12', 'lei', '5493001KJTIIGC8Y1R12'],
  ['549300 1kjtiigc8y1r12'.replace(' ', ''), 'lei', '5493001KJTIIGC8Y1R12'],
  ['HWUPKR0MPOU8FGXBT394', 'lei', 'HWUPKR0MPOU8FGXBT394'],
  ['51.5007, -0.1246', 'coords', '51.5007,-0.1246'],
  ['51.5007,-0.1246', 'coords', '51.5007,-0.1246'],
  ['-33.8688 151.2093', 'coords', '-33.8688,151.2093'],
  ['40.7128; -74.0060', 'coords', '40.7128,-74.006'],
  ['51.5007° N, 0.1246° W', 'coords', '51.5007,-0.1246'],
  ['35, 139', 'coords', '35,139'],
  ['Acme Corp', 'org-name', 'Acme Corp'],
  ['Microsoft Corporation', 'org-name', 'Microsoft Corporation'],
  ['Siemens AG', 'org-name', 'Siemens AG'],
  ['Mozilla Foundation', 'org-name', 'Mozilla Foundation'],
  ['Foo Bar Holdings Ltd.', 'org-name', 'Foo Bar Holdings Ltd.'],
  ['Eiffel Tower, Paris', 'place-text', 'Eiffel Tower, Paris'],
  ['Paris, France', 'place-text', 'Paris, France'],
  ['10 Downing Street', 'place-text', '10 Downing Street'],
  ['Heathrow Airport', 'place-text', 'Heathrow Airport'],
  ['Lake Victoria', 'place-text', 'Lake Victoria'],
  ['ransomware', 'keyword', 'ransomware'],
  ['CVE-2021-44228', 'keyword', 'CVE-2021-44228'],
  ['15169', 'keyword', '15169'],
  ['10 20', 'keyword', '10 20'],
  ['report.pdf', 'keyword', 'report.pdf'],
  ['photo.JPG', 'keyword', 'photo.JPG'],
  ['not a domain.com', 'keyword', 'not a domain.com'],
  ['100.5, 200.5', 'keyword', '100.5, 200.5'],
  ['999.999.999.999', 'keyword', '999.999.999.999'],
  ['10.0.0.0/33', 'keyword', '10.0.0.0/33'],
  ['AS99999999999', 'keyword', 'AS99999999999'],
  ['ftp://example.com/file', 'keyword', 'ftp://example.com/file'],
  ['', 'keyword', ''],
  ['   \n\t  ', 'keyword', ''],
];

test('classify: a table of inputs gives the kind and the cleaned value', () => {
  assert.ok(TABLE.length >= 40, 'at least forty inputs');
  for (const [input, kind, value] of TABLE) {
    const r = classify(input);
    assert.deepEqual([r.kind, r.value], [kind, value], JSON.stringify(input) + ' -> ' + JSON.stringify(r));
  }
});
test('classify: the result is always { kind, value, alternatives } with a kind from the closed list, and the alternatives are other readings', () => {
  for (const [input] of TABLE) {
    const r = classify(input);
    assert.deepEqual(Object.keys(r).sort(), ['alternatives', 'kind', 'value']);
    assert.ok(KINDS.includes(r.kind), r.kind);
    const seen = new Set([r.kind + '\0' + r.value]);
    for (const a of r.alternatives) {
      assert.deepEqual(Object.keys(a).sort(), ['kind', 'value']); assert.ok(KINDS.includes(a.kind), a.kind); assert.ok(a.value);
      assert.ok(!seen.has(a.kind + '\0' + a.value), 'no repeated reading: ' + JSON.stringify(input)); seen.add(a.kind + '\0' + a.value);
    }
  }
});
test('classify is pure: same answer every time, no I/O, input is not changed', () => {
  for (const [input] of TABLE) assert.deepEqual(classify(input), classify(input));
  assert.deepEqual(classify(undefined), classify('')); assert.deepEqual(classify(null), classify('')); assert.deepEqual(classify(42), classify('42'));
});
test('the kinds are the closed list of the module screens without entity, rules-file, log-file and instance-url, and have no person, username, email or phone kind', () => {
  assert.deepEqual([...KINDS].sort(), UI.INPUT_KINDS.filter((k) => !['entity', 'rules-file', 'log-file', 'instance-url'].includes(k)).sort());
  assert.equal(KINDS.some((k) => /email|phone|username|person/.test(k)), false);
});
test('an ASN needs the AS prefix: a bare number is a keyword', () => {
  assert.equal(classify('AS15169').kind, 'asn'); assert.equal(classify('15169').kind, 'keyword'); assert.equal(classify('ASN15169').kind, 'keyword');
});
test('something that looks like an email address is a keyword; the domain part is only an alternative the person can choose', () => {
  const r = classify('someone@example.com');
  assert.equal(r.kind, 'keyword'); assert.equal(r.value, 'someone@example.com');
  assert.deepEqual(r.alternatives, [{ kind: 'domain', value: 'example.com' }]);
  assert.equal(classify('someone@@example.com').alternatives.some((a) => a.kind === 'domain'), false);
  // choosing the domain reading gives the domain only
  assert.deepEqual(normalise('domain', 'example.com'), { ok: true, value: 'example.com' });
});
test('a URL offers its host as the domain (or IP) reading; a domain offers keyword', () => {
  assert.deepEqual(classify('https://www.example.com/x').alternatives[0], { kind: 'domain', value: 'www.example.com' });
  assert.deepEqual(classify('http://1.2.3.4/x').alternatives[0], { kind: 'ip', value: '1.2.3.4' });
  assert.ok(classify('example.com').alternatives.some((a) => a.kind === 'keyword'));
  assert.ok(classify('Acme Corp').alternatives.some((a) => a.kind === 'keyword') && classify('Acme Corp').alternatives.some((a) => a.kind === 'place-text'));
});
test('long or odd input is cut and cleaned, never thrown on', () => {
  const r = classify('word '.repeat(1000)); assert.equal(r.kind, 'keyword'); assert.ok(r.value.length <= 2000);
  assert.equal(classify('a\u0000b\u0007c').value, 'a b c');
  assert.doesNotThrow(() => classify({ toString() { throw new Error('x'); } }) );
});
test('normalise: a kind chosen by the person is checked and cleaned, or refused in plain words', () => {
  assert.deepEqual(normalise('domain', 'https://Example.com/x'), { ok: true, value: 'example.com' });
  assert.deepEqual(normalise('asn', 'as 15169'), { ok: true, value: 'AS15169' });
  assert.deepEqual(normalise('coords', '51.5, -0.12'), { ok: true, value: '51.5,-0.12' });
  assert.deepEqual(normalise('keyword', '  two   words '), { ok: true, value: 'two words' });
  assert.deepEqual(normalise('org-name', 'Acme'), { ok: true, value: 'Acme' });
  assert.deepEqual(normalise('file', 'abcdefgh12345678'), { ok: true, value: 'abcdefgh12345678' });
  for (const [k, v] of [['domain', 'not a domain'], ['ip', 'example.com'], ['cidr', '1.2.3.4'], ['asn', '15169'], ['url', 'hello'], ['cert-hash', 'abc'], ['lei', 'short'], ['coords', '95, 10'], ['file', 'x'], ['domain', ''], ['keyword', ''], ['person', 'x'], ['email', 'a@b.c'], ['username', 'x']]) {
    const r = normalise(k, v); assert.equal(r.ok, false, k + ' ' + v); assert.match(r.error, /\S/);
  }
});
