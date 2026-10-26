'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/main/lib/origins');

test('isMayfairUrl accepts only the two https origins', () => {
  assert.ok(O.isMayfairUrl('https://cloud.mayfairmail.com/'));
  assert.ok(O.isMayfairUrl('https://cloud.mayfairmail.com/apps/files?x=1#y'));
  assert.ok(O.isMayfairUrl('https://mayfairmail.com/login'));
  assert.ok(O.isMayfairUrl('https://cloud.mayfairmail.com:443/'));
});
test('isMayfairUrl rejects look-alikes, http, ports, userinfo', () => {
  for (const u of [
    'http://cloud.mayfairmail.com/', 'https://cloud.mayfairmail.com.evil.com/', 'https://evilmayfairmail.com/',
    'https://mayfairmail.com.evil.io/', 'https://cloud.mayfairmail.com:8443/', 'https://cloud.mayfairmail.com@evil.com/',
    'https://user:pw@cloud.mayfairmail.com/', 'https://sub.cloud.mayfairmail.com/', 'https://www.mayfairmail.com/',
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', '', 'not a url', null, undefined,
  ]) assert.equal(O.isMayfairUrl(u), false, String(u));
});
test('classifyNavigation: locked tab keeps Mayfair, sends others to a new tab', () => {
  const c = (u, locked = true) => O.classifyNavigation(u, { locked });
  assert.equal(c('https://cloud.mayfairmail.com/x'), 'allow');
  assert.equal(c('https://example.com/'), 'newtab');
  assert.equal(c('http://example.com/'), 'newtab');
  assert.equal(c('mailto:a@b.co'), 'external');
  assert.equal(c('tel:+4412345'), 'external');
  for (const bad of ['javascript:1', 'file:///x', 'data:text/html,x', 'blob:https://x/y', 'ftp://x/', 'chrome://gpu', 'garbage']) assert.equal(c(bad), 'block', bad);
});
test('classifyNavigation: unlocked tab may go to any http(s) site but not file/javascript', () => {
  assert.equal(O.classifyNavigation('https://example.com', { locked: false }), 'allow');
  assert.equal(O.classifyNavigation('javascript:1', { locked: false }), 'block');
  assert.equal(O.classifyNavigation('file:///etc/passwd', { locked: false }), 'block');
});
test('normalizeInput: urls, hosts, search, and unsafe schemes', () => {
  assert.equal(O.normalizeInput('example.com'), 'https://example.com/');
  assert.equal(O.normalizeInput('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(O.normalizeInput('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(O.normalizeInput('192.168.1.1'), 'http://192.168.1.1/');
  assert.equal(O.normalizeInput('cats and dogs'), 'https://duckduckgo.com/?q=cats%20and%20dogs');
  assert.equal(O.normalizeInput('cats', 'brave'), 'https://search.brave.com/search?q=cats');
  assert.equal(O.normalizeInput('cats', 'nonsense'), 'https://duckduckgo.com/?q=cats');
  assert.equal(O.normalizeInput('singleword'), 'https://duckduckgo.com/?q=singleword');
  assert.match(O.normalizeInput('javascript:alert(1)'), /^https:\/\/duckduckgo\.com\//);
  assert.match(O.normalizeInput('file:///etc/passwd'), /^https:\/\/duckduckgo\.com\//);
  assert.match(O.normalizeInput('data:text/html,<b>'), /^https:\/\/duckduckgo\.com\//);
  assert.equal(O.normalizeInput('   '), null);
  assert.equal(O.normalizeInput(null), null);
});
test('httpsState and siteKey', () => {
  assert.equal(O.httpsState('https://a.com'), 'secure');
  assert.equal(O.httpsState('http://a.com'), 'insecure');
  assert.equal(O.httpsState('file:///x'), 'internal');
  assert.equal(O.httpsState('nope'), 'none');
  assert.equal(O.siteKey('https://a.com/x?y'), 'https://a.com');
  assert.equal(O.siteKey('file:///x'), null);
});
test('deep links always land on the Cloud origin', () => {
  const d = O.parseDeepLink('mayfair://open/Drive/a.docx?x=1');
  assert.equal(d.action, 'open');
  assert.equal(d.path, '/Drive/a.docx');
  assert.deepEqual(d.params, { x: '1' });
  assert.ok(O.isMayfairUrl(d.url));
  assert.ok(d.url.startsWith('https://cloud.mayfairmail.com/#mf='));
  const evil = O.parseDeepLink('mayfair://open?url=https://evil.com');
  assert.ok(O.isMayfairUrl(evil.url));
  assert.equal(new URL(evil.url).hostname, 'cloud.mayfairmail.com');
  assert.equal(O.parseDeepLink('https://cloud.mayfairmail.com'), null);
  assert.equal(O.parseDeepLink('mayfair://'), null);
  assert.equal(O.parseDeepLink('mayfair://bad_action!'), null);
  assert.equal(O.parseDeepLink('nonsense'), null);
});
test('argv scanning finds deep links and handled files only', () => {
  assert.equal(O.findDeepLink(['app', '--x', 'mayfair://open']), 'mayfair://open');
  assert.equal(O.findDeepLink(['app']), null);
  assert.deepEqual(O.findFileArgs(['/a/b.DOCX', '--flag', '/a/c.exe', 'mayfair://x.pdf', 'https://x/y.pdf', '/p/n.md']), ['/a/b.DOCX', '/p/n.md']);
  for (const e of ['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'md', 'txt', 'png', 'jpg']) assert.ok(O.isHandledFile('x.' + e));
  assert.equal(O.isHandledFile('x.exe'), false);
  assert.equal(O.isHandledFile('noext'), false);
});
