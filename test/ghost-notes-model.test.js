'use strict';
// Ghost Quick notes: the model (sanitiser, paste model, tabs, highlights, search, undo, send to case). No display, no vault.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const N = require('../src/ui/ghost/qn-model');
const M = require('../src/ui/ghost/case-model');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const T0 = Date.UTC(2026, 9, 27, 9, 30, 0);
const mk = (text, o = {}) => N.makeClip({ kind: 'text', text, hash: sha(text) }, { now: T0, ...o });
const desc = (name, mime, bytes = 10) => ({ name, mime, bytes, sha256: sha(name + mime), blob: sha(name + mime).slice(0, 16), w: 4, h: 3 });

test('sha256 matches the standard test vectors, for text and for bytes', () => {
  assert.equal(N.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(N.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const big = Buffer.alloc(1000003, 7); assert.equal(N.sha256(new Uint8Array(big)), crypto.createHash('sha256').update(big).digest('hex'));
  assert.equal(N.sha256('héllo ✓'), sha('héllo ✓'));
});

// ---------- sanitiser ----------
test('sanitiser: script and style are removed with their content, in any case, closed or not', () => {
  const s = N.sanitizeHtml('<p>keep</p><SCRIPT type="x">alert(1)</SCRIPT><style>p{background:url(https://evil.example/a.png)}</style><p>also</p><script>stealCookies()');
  assert.equal(s.text, 'keep\nalso'); const j = JSON.stringify(s.tree); assert.equal(/alert|steal|evil|url\(/.test(j), false);
  const h = N.treeToHtml(s.tree); assert.equal(/<script|<style|alert/i.test(h), false);
});
test('sanitiser: nothing remote can load: images, frames, objects, svg, link and meta tags, srcset, background, inline styles', () => {
  const html = '<link rel="stylesheet" href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example"><p style="background:url(https://evil.example/b.png)" class="x" onclick="steal()">hi <img src="https://evil.example/pixel.gif" srcset="https://evil.example/2x.gif 2x" alt="a pixel" onerror="steal()"> there</p>'
    + '<iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/o"><param name=x value=y></object><svg><image href="https://evil.example/i.svg"/><script>1</script></svg><video src="https://evil.example/v.mp4"></video><div background="https://evil.example/bg">tail</div><embed src="https://evil.example/e">';
  const s = N.sanitizeHtml(html); const j = JSON.stringify(s.tree), out = N.treeToHtml(s.tree);
  assert.equal(/evil\.example/.test(j + out), false); assert.equal(/<img|<iframe|<object|<svg|<video|<embed|<link|<meta|style=|onclick|onerror|srcset|class=/i.test(out), false);
  assert.match(s.text, /hi \[image: a pixel\] there/); assert.match(s.text, /tail$/);
  assert.equal(N.treeProblem(s.tree), null);
});
test('sanitiser: links keep their address (http, https, mailto) and lose anything else', () => {
  const s = N.sanitizeHtml('<a href="https://ok.example/p?q=1" title="T" onclick="x()">one</a> <a href="javascript:alert(1)">two</a> <a href="  JaVaScRiPt:alert(1)">three</a> <a href="data:text/html,<script>1</script>">four</a> <a href="mailto:a@b.example">five</a> <a href="vbscript:x">six</a> <a href="file:///etc/passwd">seven</a> <a href="//evil.example/x">eight</a>');
  const links = []; (function w(a) { for (const x of a) if (typeof x !== 'string') { if (x.t === 'a') links.push(x); w(x.c); } })(s.tree);
  assert.deepEqual(links.map((l) => (l.a && l.a.href) || null), ['https://ok.example/p?q=1', null, null, null, 'mailto:a@b.example', null, null, null]);
  assert.equal(s.text, 'one two three four five six seven eight');
  const out = N.treeToHtml(s.tree); assert.equal(/javascript|vbscript|data:|file:|evil/i.test(out), false); assert.ok(out.includes('rel="noreferrer noopener"'));
});
test('sanitiser: only the allowed tags survive, other tags lose the tag and keep the text; comments and doctype go', () => {
  const s = N.sanitizeHtml('<!doctype html><!-- hidden --><html><body><custom-el>x</custom-el><span style="color:red">y</span><form action="https://evil.example"><input name=q value=secret><button>go</button><textarea>area</textarea><select><option>o</option></select></form><font color=red>z</font><marquee>m</marquee><![CDATA[ cdata ]]></body></html>');
  assert.equal(/hidden|secret|area|evil/.test(JSON.stringify(s.tree)), false);
  assert.match(s.text, /^xy/); assert.ok(s.text.includes('go')); assert.ok(s.text.includes('z')); assert.ok(s.text.includes('m'));
  const tags = new Set(); (function w(a) { for (const x of a) if (typeof x !== 'string') { tags.add(x.t); w(x.c); } })(s.tree);
  assert.deepEqual([...tags].filter((t) => !['p', 'h3', 'h4', 'b', 'i', 'u', 's', 'code', 'mark', 'sub', 'sup', 'small', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'a', 'hr'].includes(t)), []);
});
test('sanitiser: structure is kept (headings, lists, tables, pre) and the text is what the person sees', () => {
  const s = N.sanitizeHtml('<h1>Head</h1><p>Hello <b>wor</b>ld</p><ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table><pre>  keep\n  space</pre><blockquote>q</blockquote>');
  assert.equal(s.text, 'Head\nHello world\none\ntwo\na\tb\t\n  keep\n  space\nq');
  assert.equal(N.flatten(s.tree), s.text);
  const h = N.treeToHtml(s.tree); assert.ok(h.startsWith('<h3>Head</h3><p>Hello <b>wor</b>ld</p><ul><li>one</li><li>two</li></ul><table>'));
});
test('sanitiser: entities are decoded to text, never to markup', () => {
  const s = N.sanitizeHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#60;b&#62; &#x41; &copy; &nbsp;|&bogus; &#0; &#xD800;</p>');
  assert.ok(s.text.startsWith('<script>alert(1)</script> & <b> A ©')); assert.ok(s.text.includes('&bogus;'));
  const out = N.treeToHtml(s.tree); assert.equal(/<script|<b>/.test(out), false); assert.ok(out.includes('&lt;script&gt;'));
});
test('sanitiser: hostile input is bounded (deep nesting, huge text, many nodes) and never throws', () => {
  const deep = '<div>'.repeat(6000) + 'x' + '</div>'.repeat(6000); const s = N.sanitizeHtml(deep); assert.equal(s.text, 'x'); assert.equal(N.treeProblem(s.tree), null);
  const big = N.sanitizeHtml('<p>' + 'word '.repeat(100000) + '</p>'); assert.ok(big.text.length <= N.LIMITS.clipText); assert.equal(big.truncated, true);
  const many = N.sanitizeHtml('<b>x</b>'.repeat(30000)); assert.equal(N.treeProblem(many.tree), null); assert.equal(many.truncated, true);
  for (const bad of ['<', '<<<>>>', '<a href="', '<p attr=\'', '</p></p></div>', '<!--', '<![CDATA[', '<script', '<svg><svg><svg>', '\u0000<p>\u0000', '<a href=x/>y', '<br/><br>']) assert.doesNotThrow(() => N.sanitizeHtml(bad), bad);
});
test('sanitiser: validate refuses a document that carries anything the sanitiser would not have made', () => {
  const doc = N.newDoc('inbox', T0), s = N.sanitizeHtml('<p><b>x</b></p>');
  const good = N.makeClip({ kind: 'rich', tree: s.tree, text: s.text, hash: sha('rich\n' + s.text) }, { now: T0 }); N.addClips(doc, doc.active, [good], T0); assert.deepEqual(N.validate(doc), []);
  const evil = (tree) => { const d = JSON.parse(JSON.stringify(doc)); d.tabs[0].clips[0].tree = tree; return N.validate(d).length > 0; };
  assert.equal(evil([{ t: 'script', c: ['x'] }]), true); assert.equal(evil([{ t: 'p', c: ['x'], onclick: 'a()' }]), true); assert.equal(evil([{ t: 'a', c: ['x'], a: { href: 'javascript:alert(1)' } }]), true);
  assert.equal(evil([{ t: 'a', c: ['x'], a: { href: 'https://ok.example/', src: 'https://evil.example/' } }]), true); assert.equal(evil([{ t: 'img', c: [], a: { src: 'https://evil.example/p.gif' } }]), true);
  assert.equal(evil([{ t: 'p', c: ['different'] }]), true);       // text must be what the tree says
  const d = JSON.parse(JSON.stringify(doc)); d.tabs[0].clips[0].from.url = 'javascript:x'; assert.ok(N.validate(d).length);
});

// ---------- the paste model ----------
test('paste: plain text becomes a text clip with a hash of its text; trailing blank space is dropped', () => {
  const r = N.classifyPaste({ text: 'line one\r\nline two  \n\n' }); assert.equal(r.items.length, 1); const d = r.items[0];
  assert.equal(d.kind, 'text'); assert.equal(d.text, 'line one\nline two'); assert.equal(d.hash, sha('line one\nline two'));
});
test('paste: a lone address is a link (title from the page address), also as an anchor with its own title; an address in a sentence is text', () => {
  let r = N.classifyPaste({ text: '  https://www.example.org/a/b?c=1#d  ' }); assert.deepEqual([r.items[0].kind, r.items[0].url, r.items[0].title], ['link', 'https://www.example.org/a/b?c=1#d', 'example.org']);
  r = N.classifyPaste({ html: '<meta charset="utf-8"><a href="https://news.example/story">The story title</a>', text: 'The story title' }); assert.deepEqual([r.items[0].kind, r.items[0].url, r.items[0].title], ['link', 'https://news.example/story', 'The story title']);
  r = N.classifyPaste({ text: 'see https://x.example/a for details' }); assert.equal(r.items[0].kind, 'text');
  r = N.classifyPaste({ text: 'javascript:alert(1)' }); assert.equal(r.items[0].kind, 'text');
  r = N.classifyPaste({ text: 'x', uris: ['https://x.example/'] }); assert.equal(r.items[0].kind, 'text');
});
test('paste: formatted html is kept as rich text (sanitised); html that adds no formatting falls back to the plain text', () => {
  let r = N.classifyPaste({ html: '<p>Some <b>bold</b> and <script>bad()</script><a href="https://a.example/">link</a></p>', text: 'Some bold and link' });
  assert.equal(r.items[0].kind, 'rich'); assert.equal(r.items[0].text, 'Some bold and link'); assert.equal(/bad\(\)/.test(JSON.stringify(r.items[0])), false);
  r = N.classifyPaste({ html: '<div><span style="color:red">Plain words</span></div>', text: 'Plain words (from the clipboard)' }); assert.deepEqual([r.items[0].kind, r.items[0].text], ['text', 'Plain words (from the clipboard)']);
  r = N.classifyPaste({ html: '<div>Only html</div>', text: '' }); assert.deepEqual([r.items[0].kind, r.items[0].text], ['text', 'Only html']);
});
test('paste: pictures and files win over text; a copied web picture keeps the picture address as its source; unusable files are skipped', () => {
  const r = N.classifyPaste({ html: '<img src="https://img.example/cat.png?x=1">', text: 'https://img.example/cat.png', files: [desc('image.png', 'image/png'), desc('report.pdf', 'application/pdf'), { name: 'bad', mime: 'image/png', sha256: 'zz', blob: 'zz' }] });
  assert.deepEqual(r.items.map((i) => i.kind), ['image', 'file']); assert.equal(r.items[0].srcUrl, 'https://img.example/cat.png?x=1'); assert.equal(r.items[0].title, '');
  const c = N.makeClip(r.items[0], { now: T0 }); assert.equal(c.from.url, 'https://img.example/cat.png?x=1'); assert.equal(c.image.mime, 'image/png');
  const f = N.makeClip(r.items[1], { now: T0 }); assert.equal(f.file.name, 'report.pdf'); assert.equal(f.hash, r.items[1].hash);
  assert.equal(N.classifyPaste({ files: [desc('x.svg', 'image/svg+xml')] }).items[0].kind, 'file');          // svg is kept as a file, never drawn
  const named = N.classifyPaste({ files: [desc('../../etc/passwd', 'text/plain')] }).items[0]; assert.equal(/[\\/]/.test(named.file.name), false, 'no path separators survive in a file name');
});
test('paste: nothing, long text and file names are handled', () => {
  assert.deepEqual(N.classifyPaste({}).items, []); assert.deepEqual(N.classifyPaste({ text: '  \n ' }).items, []); assert.deepEqual(N.classifyPaste({ files: [] }).items, []);
  const r = N.classifyPaste({ text: 'x'.repeat(N.LIMITS.clipText + 500) }); assert.equal(r.items[0].text.length, N.LIMITS.clipText); assert.equal(r.items[0].truncated, true); assert.ok(r.notes.length);
});
test('provenance: a fresh hint is used, an old or unknown one is "Pasted", typed and dropped say so', () => {
  const hint = { kind: 'ghost-browser', label: 'Ghost browser: Example', url: 'https://example.org/page', at: T0 - 30000 };
  assert.deepEqual(N.fromHint(hint, T0), { kind: 'ghost-browser', label: 'Ghost browser: Example', url: 'https://example.org/page', auto: true });
  assert.deepEqual(N.fromHint(hint, T0 + N.HINT_MAX_AGE_MS), { kind: 'pasted', label: 'Pasted', url: '', auto: false });
  assert.equal(N.fromHint(null, T0).label, 'Pasted'); assert.equal(N.fromHint({ kind: 'evil', label: 'x', at: T0 }, T0).kind, 'pasted');
  assert.equal(N.fromHint({ kind: 'tool', label: 'Tool: rdap', at: T0 }, T0, 'typed').kind, 'typed'); assert.equal(N.fromHint(null, T0, 'dropped').label, 'Dropped file');
  assert.equal(N.fromHint({ kind: 'window', label: 'W', url: 'javascript:x', at: T0 }, T0).url, '');
});
test('a clip carries provenance, a time and an item hash, and the document validates', () => {
  const doc = N.newDoc('inbox', T0); const c = mk('hello', { from: { kind: 'tool', label: 'Tool: RDAP lookup', url: '', auto: true } });
  N.addClips(doc, doc.active, [c], T0);
  assert.equal(c.t, '2026-10-27T09:30:00.000Z'); assert.equal(c.hash, sha('hello')); assert.deepEqual(c.from, { kind: 'tool', label: 'Tool: RDAP lookup', url: '', auto: true }); assert.deepEqual(N.validate(doc), []);
  const dup = N.addClips(doc, doc.active, [mk('hello')], T0); assert.equal(dup.added.length, 0); assert.equal(dup.skipped.length, 1);
});

// ---------- tabs ----------
const titles = (d) => d.tabs.map((t) => t.title);
test('tabs: new, rename, reorder, close, restore', () => {
  const d = N.newDoc('inbox', T0); assert.deepEqual(titles(d), ['Notes']);
  const a = N.addTab(d, '', T0).tab, b = N.addTab(d, 'Leads', T0).tab, c = N.addTab(d, '', T0).tab; assert.deepEqual(titles(d), ['Notes', 'Notes 2', 'Leads', 'Notes 3']); assert.equal(d.active, c.id);
  assert.equal(N.renameTab(d, a.id, '  Domains  ', T0), true); assert.equal(N.renameTab(d, a.id, '   ', T0), false); assert.equal(N.renameTab(d, 'nope', 'x', T0), false); assert.equal(titles(d)[1], 'Domains');
  assert.equal(N.moveTab(d, c.id, 0, T0), true); assert.deepEqual(titles(d), ['Notes 3', 'Notes', 'Domains', 'Leads']); N.moveTab(d, c.id, 99, T0); assert.equal(titles(d)[3], 'Notes 3'); assert.equal(N.moveTab(d, c.id, 3, T0), false);
  N.addClips(d, b.id, [mk('in leads')], T0);
  d.active = b.id; N.closeTab(d, b.id, T0); assert.equal(d.tabs.length, 3); assert.equal(d.closed.length, 1); assert.notEqual(d.active, b.id); assert.ok(d.tabs.some((t) => t.id === d.active));
  const back = N.restoreTab(d, null, T0); assert.equal(back.id, b.id); assert.equal(back.clips.length, 1); assert.equal(d.active, b.id); assert.equal(d.closed.length, 0); assert.equal(d.tabs.indexOf(back), 2);
  assert.equal(N.restoreTab(d, null, T0), null); assert.deepEqual(N.validate(d), []);
});
test('tabs: closing the last tab leaves a fresh one; any closed tab can be restored; closed tabs are capped; tabs are capped', () => {
  const d = N.newDoc('inbox', T0); const first = d.tabs[0]; N.addClips(d, first.id, [mk('keep me')], T0);
  N.closeTab(d, first.id, T0); assert.equal(d.tabs.length, 1); assert.notEqual(d.tabs[0].id, first.id); assert.equal(d.tabs[0].clips.length, 0);
  const r = N.restoreTab(d, first.id, T0); assert.equal(r.clips[0].text, 'keep me'); assert.equal(d.tabs.length, 1, 'the empty stand-in is replaced');
  for (let i = 0; i < 30; i++) { const t = N.addTab(d, 'T' + i, T0).tab; N.closeTab(d, t.id, T0); } assert.equal(d.closed.length, N.LIMITS.closed);
  N.discardClosed(d, d.closed[0].tab.id, T0); assert.equal(d.closed.length, N.LIMITS.closed - 1);
  const e = N.newDoc('inbox', T0); for (let i = 0; i < 60; i++) N.addTab(e, '', T0); assert.equal(e.tabs.length, N.LIMITS.tabs); assert.ok(N.addTab(e, '', T0).error);
});
test('clips: move between tabs, pin, retitle, source, tags, delete', () => {
  const d = N.newDoc('inbox', T0), t2 = N.addTab(d, 'Second', T0).tab, t1 = d.tabs[0]; const c = mk('one'); N.addClips(d, t1.id, [c], T0);
  assert.equal(N.moveClip(d, c.id, t2.id, T0), true); assert.equal(t1.clips.length, 0); assert.equal(t2.clips.length, 1);
  N.addClips(d, t1.id, [mk('one')], T0); assert.equal(N.moveClip(d, N.findClip(d, c.id).clip.id, t1.id, T0), false, 'a duplicate in the target is refused');
  assert.equal(N.togglePin(d, c.id, T0), true); assert.equal(N.togglePin(d, c.id, T0), false);
  assert.equal(N.setTitle(d, c.id, '  A title ', T0), true); assert.equal(c.title, 'A title');
  assert.equal(N.setFrom(d, c.id, { label: 'Annual report p.3', url: 'https://x.example/r.pdf' }, T0), true); assert.deepEqual([c.from.label, c.from.url, c.from.auto], ['Annual report p.3', 'https://x.example/r.pdf', false]);
  assert.equal(N.addTag(d, c.id, '  Evidence  ', T0), true); assert.equal(N.addTag(d, c.id, 'evidence', T0), false); assert.equal(N.addTag(d, c.id, '<b>', T0), true); assert.deepEqual(c.tags, ['evidence', 'b']);
  for (let i = 0; i < 20; i++) N.addTag(d, c.id, 't' + i, T0); assert.equal(c.tags.length, N.LIMITS.tags); assert.equal(N.removeTag(d, c.id, 'evidence', T0), true);
  assert.deepEqual(N.allTags(d).map((x) => x.tag).slice(0, 1), ['b']);
  assert.equal(N.removeClip(d, c.id, T0).id, c.id); assert.equal(N.findClip(d, c.id), null); assert.deepEqual(N.validate(d), []);
});

// ---------- highlights ----------
test('highlights: ranges are clamped and ordered; the same colour on the same range toggles; another colour replaces it', () => {
  const d = N.newDoc('inbox', T0), c = mk('The quick brown fox'); N.addClips(d, d.active, [c], T0);
  assert.ok(N.addHighlight(d, c.id, { a: 3, b: 3, color: 'yellow' }, T0).error); assert.ok(N.addHighlight(d, c.id, { a: 0, b: 5 }, T0).error); assert.ok(N.addHighlight(d, c.id, { a: 0, b: 5, color: 'pink' }, T0).error);
  const r = N.addHighlight(d, c.id, { a: 99, b: 4, color: 'yellow' }, T0); assert.deepEqual([c.hl[0].a, c.hl[0].b], [4, 19]); assert.equal(r.id, c.hl[0].id);
  assert.equal(N.addHighlight(d, c.id, { a: 4, b: 19, color: 'yellow' }, T0).toggled, true); assert.equal(c.hl.length, 0);
  N.addHighlight(d, c.id, { a: 0, b: 3, color: 'green' }, T0); N.addHighlight(d, c.id, { a: 0, b: 3, color: 'red' }, T0); assert.equal(c.hl.length, 1); assert.equal(c.hl[0].color, 'red');
  N.addHighlight(d, c.id, { a: 0, b: 3, u: true }, T0); assert.deepEqual([c.hl.length, c.hl[0].color, c.hl[0].u], [1, 'red', true]);
  N.addHighlight(d, c.id, { a: 0, b: 3, color: 'red' }, T0); assert.deepEqual([c.hl.length, c.hl[0].color, c.hl[0].u], [1, null, true]);
  N.addHighlight(d, c.id, { a: 0, b: 3, u: true }, T0); assert.equal(c.hl.length, 0);
  assert.deepEqual(N.COLORS, ['yellow', 'green', 'blue', 'red', 'grey']); assert.deepEqual(N.validate(d), []);
});
test('highlights: pieces tile the text exactly, overlaps share a piece, the latest colour wins and underline adds', () => {
  const text = 'abcdefghij'; const hl = [{ id: 'h1', a: 2, b: 6, color: 'yellow', u: false, comment: '' }, { id: 'h2', a: 4, b: 8, color: 'blue', u: false, comment: '' }, { id: 'h3', a: 5, b: 7, color: null, u: true, comment: '' }];
  const p = N.coverage(0, text.length, hl); assert.deepEqual(p.map((x) => [x.a, x.b]), [[0, 2], [2, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 10]]);
  assert.equal(p.map((x) => text.slice(x.a, x.b)).join(''), text);
  const st = p.map((x) => N.pieceStyle(x.hl)); assert.deepEqual(st.map((s) => s.color), [null, 'yellow', 'blue', 'blue', 'blue', 'blue', null]); assert.deepEqual(st.map((s) => s.u), [false, false, false, true, true, false, false]);
  const sub = N.coverage(3, 7, hl); assert.deepEqual([sub[0].a, sub[sub.length - 1].b], [3, 7]); assert.deepEqual(N.coverage(5, 5, hl), []); assert.deepEqual(N.coverage(0, 4, []).map((x) => [x.a, x.b]), [[0, 4]]);
});
test('highlights: comments, removing, clearing a range, text-less clips, and rich text offsets', () => {
  const d = N.newDoc('inbox', T0), c = mk('alpha beta gamma delta'); N.addClips(d, d.active, [c], T0);
  const id = N.addHighlight(d, c.id, { a: 6, b: 10, color: 'green', comment: ' check this ' }, T0).id; assert.equal(c.hl[0].comment, ' check this ');
  assert.equal(N.setHighlightComment(d, c.id, id, 'verified', T0), true); assert.equal(c.hl[0].comment, 'verified'); assert.equal(N.setHighlightComment(d, c.id, 'nope', 'x', T0), false);
  N.addHighlight(d, c.id, { a: 0, b: 5, color: 'blue' }, T0); N.addHighlight(d, c.id, { a: 11, b: 16, u: true }, T0); assert.equal(c.hl.length, 3);
  assert.equal(N.clearHighlights(d, c.id, 8, 12, T0), 2); assert.deepEqual(c.hl.map((h) => h.color), ['blue']); assert.equal(N.removeHighlight(d, c.id, c.hl[0].id, T0), true); assert.equal(c.hl.length, 0);
  N.addHighlight(d, c.id, { a: 0, b: 4, color: 'red' }, T0); assert.equal(N.clearHighlights(d, c.id, undefined, undefined, T0), 1);
  const img = N.makeClip({ kind: 'image', title: '', image: { blob: 'a'.repeat(16), mime: 'image/png', bytes: 5, w: 1, h: 1, name: 'x' }, hash: sha('img') }, { now: T0 }); N.addClips(d, d.active, [img], T0);
  assert.ok(N.addHighlight(d, img.id, { a: 0, b: 1, color: 'red' }, T0).error);
  const s = N.sanitizeHtml('<h1>Title</h1><p>First <b>bold</b> part</p><ul><li>item</li></ul>'), rc = N.makeClip({ kind: 'rich', tree: s.tree, text: s.text, hash: sha(s.text) }, { now: T0 }); N.addClips(d, d.active, [rc], T0);
  const a = rc.text.indexOf('bold'); N.addHighlight(d, rc.id, { a, b: a + 4, color: 'yellow' }, T0); assert.equal(rc.text.slice(rc.hl[0].a, rc.hl[0].b), 'bold');
  const html = N.treeToHtml(rc.tree, { wrap: (x, y, str) => N.coverage(x, y, rc.hl).map((p) => (p.hl.length ? '[' : '') + str.slice(p.a - x, p.b - x) + (p.hl.length ? ']' : '')).join('') }); assert.ok(html.includes('<b>[bold]</b>'), html);
  assert.deepEqual(N.validate(d), []);
  const bad = JSON.parse(JSON.stringify(d)); bad.tabs[0].clips[0].hl = [{ id: 'hhhh', a: 3, b: 999, color: 'red', u: false, comment: '', t: c.t }]; assert.ok(N.validate(bad).some((m) => /outside its text/.test(m)));
  const fixed = N.normalize(bad, 'inbox'); assert.deepEqual(N.validate(fixed), []);
});

// ---------- search ----------
test('search: across every tab, terms ANDed, accents and case ignored, filters for tag, colour, kind, pinned, tab and source', () => {
  const d = N.newDoc('inbox', T0), t1 = d.tabs[0], t2 = N.addTab(d, 'Companies', T0).tab;
  const a = mk('Registered office: Rue de l’Église 12, Genève', { from: { kind: 'ghost-browser', label: 'Ghost browser: Registry', url: 'https://reg.example/x', auto: true } }), b = mk('nameserver ns1.example.net resolves to 203.0.113.9', { from: { kind: 'tool', label: 'Tool: DNS lookup', url: '', auto: true } });
  const c = N.makeClip({ kind: 'link', url: 'https://news.example/story', title: 'Port strike story', text: 'https://news.example/story', hash: sha('l') }, { now: T0 + 5000 });
  N.addClips(d, t1.id, [a, b], T0); N.addClips(d, t2.id, [c], T0);
  N.addTag(d, b.id, 'infrastructure', T0); N.addHighlight(d, a.id, { a: 0, b: 10, color: 'red', comment: 'ask the registrar' }, T0); N.togglePin(d, c.id, T0);
  const ids = (q, o) => N.search(d, q, o).map((r) => r.clip);
  assert.deepEqual(ids('geneve'), [a.id]); assert.deepEqual(ids('EGLISE geneve'), [a.id]); assert.deepEqual(ids('ns1 203.0.113.9'), [b.id]); assert.deepEqual(ids('ns1 geneve'), []);
  assert.deepEqual(ids('port strike'), [c.id]); assert.deepEqual(ids('"port strike"'), [c.id]); assert.deepEqual(ids('"strike port"'), []);
  assert.deepEqual(ids('registrar'), [a.id]); assert.equal(N.search(d, 'registrar')[0].field, 'comment'); assert.equal(N.search(d, 'dns')[0].field, 'source');
  assert.deepEqual(ids('tag:infra'), [b.id]); assert.deepEqual(ids('color:red'), [a.id]); assert.deepEqual(ids('kind:link'), [c.id]); assert.deepEqual(ids('kind:text').sort(), [a.id, b.id].sort());
  assert.deepEqual(ids('is:pinned'), [c.id]); assert.deepEqual(ids('tab:compan'), [c.id]); assert.deepEqual(ids('from:ghost'), [a.id]); assert.deepEqual(ids('example', { tab: t2.id }), [c.id]);
  assert.equal(N.search(d, 'geneve')[0].tab, t1.id); assert.equal(N.search(d, 'geneve')[0].tabTitle, 'Notes'); assert.ok(/Genève/.test(N.search(d, 'geneve')[0].snippet));
  assert.deepEqual(N.search(d, ''), []); assert.deepEqual(N.search(d, '   '), []); assert.deepEqual(ids('zzzz'), []);
  assert.equal(N.search(d, 'example')[0].clip, c.id, 'pinned clips come first');
});

// ---------- undo and redo ----------
test('undo and redo restore the same document object; typing in one group is one step; the history is bounded', () => {
  const d = N.newDoc('inbox', T0), hist = new N.History(d), c = mk('x'); const keep = d;
  hist.run('Add', (x) => N.addClips(x, x.active, [c], T0)); hist.run('Tab', (x) => N.addTab(x, 'Two', T0)); assert.equal(d.tabs.length, 2);
  assert.equal(hist.undo(), 'Tab'); assert.equal(d.tabs.length, 1); assert.equal(d, keep); assert.equal(hist.undo(), 'Add'); assert.equal(d.tabs[0].clips.length, 0); assert.equal(hist.undo(), null);
  assert.equal(hist.redo(), 'Add'); assert.equal(d.tabs[0].clips.length, 1); assert.equal(hist.redo(), 'Tab'); assert.equal(d.tabs.length, 2); assert.equal(hist.redo(), null);
  hist.undo(); hist.run('New edit', (x) => N.addTab(x, 'Three', T0)); assert.equal(hist.canRedo(), false);
  const h2 = new N.History(N.newDoc('inbox', T0)); for (let i = 0; i < 5; i++) h2.run('Comment', (x) => N.renameTab(x, x.tabs[0].id, 'n' + i, T0), { group: 'c', windowMs: 1000, now: 1000 + i }); assert.equal(h2.undoStack.length, 1);
  const h3 = new N.History(N.newDoc('inbox', T0)); for (let i = 0; i < 120; i++) h3.run('s', (x) => N.addTab(x, 't' + i, T0)); assert.ok(h3.undoStack.length <= N.UNDO_LIMIT);
});

// ---------- send to a case ----------
test('send to case: a clip becomes an entity (or evidence on one) with the clip recorded as a source: tool, hash, where it came from', () => {
  const c = M.newCase('Test case', T0); const ip = mk('203.0.113.9', { from: { kind: 'tool', label: 'Tool: DNS lookup', url: 'https://dns.example/q?x=1', auto: true } });
  assert.deepEqual(N.suggestEntity(ip), { type: 'ip', value: '203.0.113.9', label: '203.0.113.9' }); assert.equal(N.suggestEntity(mk('Example.ORG.')).type, 'domain'); assert.equal(N.suggestEntity(mk('as64500')).type, 'asn'); assert.equal(N.suggestEntity(mk('2001:db8::1')).type, 'ip');
  assert.equal(N.suggestEntity(mk('A longer note about the thing\nwith a second line')).type, 'finding');
  assert.equal(N.suggestEntity(N.makeClip({ kind: 'link', url: 'https://a.example/p', title: 'T', text: 'https://a.example/p', hash: sha('l') }, { now: T0 })).type, 'url');
  const r = N.sendToCase(M, c, ip, { mode: 'new', now: T0 }); assert.ok(r.entityId); const e = c.entities[r.entityId]; assert.equal(e.type, 'ip'); assert.equal(e.manual, true); assert.equal(e.sources.length, 1);
  const s = c.sources[e.sources[0]]; assert.deepEqual([s.connector, s.rawSha256, s.origin], ['quick-notes', ip.hash, 'https://dns.example/q']); assert.ok(s.note.includes('Tool: DNS lookup') && s.note.includes(N.shortHash(ip.hash)));
  assert.deepEqual(M.validate(c), []); assert.equal(M.isUnsourced(e), false);
  // the same value again merges into the same entity and adds a second source
  const again = N.sendToCase(M, c, mk('203.0.113.9', { from: { kind: 'pasted', label: 'Pasted', url: '', auto: false } }), { mode: 'new', now: T0 + 1000 }); assert.equal(again.merged, true); assert.equal(c.entities[again.entityId].sources.length, 2);
  // attach as evidence to an existing entity
  const dom = M.addEntity(c, { type: 'domain', value: 'example.org', manual: true }).id; const note = mk('Registered 2019 to a holding company.');
  const at = N.sendToCase(M, c, note, { mode: 'attach', entityId: dom, now: T0 + 2000 }); assert.equal(at.entityId, dom); assert.equal(c.entities[dom].sources.length, 1); assert.ok(c.entities[dom].attrs.note.startsWith('Registered 2019'));
  assert.ok(N.sendToCase(M, c, note, { mode: 'attach', entityId: 'gone', now: T0 }).error); assert.deepEqual(M.validate(c), []);
  const person = N.sendToCase(M, c, mk('free text'), { mode: 'new', type: 'email', now: T0 }); assert.equal(c.entities[person.entityId].type, 'finding', 'the email type is never chosen from a clip');
  const img = N.makeClip({ kind: 'image', title: 'Shopfront', image: { blob: 'b'.repeat(16), mime: 'image/png', bytes: 5, w: 1, h: 1, name: 's.png' }, hash: sha('shop') }, { now: T0 }); const ir = N.sendToCase(M, c, img, { mode: 'new', now: T0 }); assert.equal(c.entities[ir.entityId].type, 'image'); assert.equal(c.entities[ir.entityId].attrs.sha256, img.hash);
  const doc = N.newDoc('inbox', T0); N.addClips(doc, doc.active, [ip], T0); assert.equal(N.markSent(doc, ip.id, { entityId: r.entityId, label: 'x', caseId: c.id }, T0), true); assert.equal(ip.sent.length, 1); assert.deepEqual(N.validate(doc), []);
});

test('load: normalize repairs a damaged document without inventing anything, validate rejects what is left', () => {
  assert.deepEqual(N.validate(N.normalize({ format: 'old', tabs: 'x' }, 'inbox')), []);
  const d = N.newDoc('inbox', T0); N.addClips(d, d.active, [mk('x')], T0); const j = JSON.parse(JSON.stringify(d));
  j.tabs[0].clips[0].hash = 'nothex'; assert.ok(N.validate(j).length); j.tabs[0].clips[0].hash = sha('x'); j.tabs[0].clips[0].kind = 'script'; assert.ok(N.validate(j).length);
  const k = JSON.parse(JSON.stringify(d)); k.scope = '../x'; assert.ok(N.validate(k).length); k.scope = 'inbox'; k.tabs.push(JSON.parse(JSON.stringify(k.tabs[0]))); assert.ok(N.validate(k).some((m) => /share an id/.test(m)));
  const u = N.usage(Object.assign(N.newDoc('inbox', T0), {})); assert.deepEqual(u, { blobs: 0, blobBytes: 0, clips: 0 });
  const e = N.newDoc('inbox', T0); const i1 = N.makeClip({ kind: 'image', title: '', image: { blob: 'c'.repeat(16), mime: 'image/png', bytes: 1000, w: 1, h: 1, name: 'a' }, hash: sha('a') }, { now: T0 }), i2 = N.makeClip({ kind: 'file', title: 'f', file: { blob: 'd'.repeat(16), name: 'f.pdf', mime: 'application/pdf', bytes: 500 }, hash: sha('f') }, { now: T0 }); N.addClips(e, e.active, [i1, i2], T0);
  assert.deepEqual(N.usage(e), { blobs: 2, blobBytes: 1500, clips: 2 }); assert.deepEqual([...N.blobRefs(e)].sort(), ['c'.repeat(16), 'd'.repeat(16)]);
  const over = JSON.parse(JSON.stringify(e)); over.tabs[0].clips[0].image.bytes = N.LIMITS.blobBytes + 1; assert.ok(N.validate(over).length);
});
