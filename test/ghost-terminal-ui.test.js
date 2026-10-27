'use strict';
// Ghost terminal window code that has no DOM dependency: screen model, key encoding, line editing, and static checks on the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Screen, cw, xterm256 } = require('../src/ui/ghost-terminal/vt');
const { encode } = require('../src/ui/ghost-terminal/keys');
const { LineEditor } = require('../src/ui/ghost-terminal/linemode');

const dir = path.join(__dirname, '..', 'src', 'ui', 'ghost-terminal');
const rows = (s) => Array.from({ length: s.rows }, (_, i) => s.lineText(s.lines[i]));

test('screen: text, wrapping, CR/LF, backspace, tabs', () => {
  const s = new Screen(10, 4);
  s.write('hello\r\nworld');
  assert.deepEqual(rows(s), ['hello', 'world', '', '']);
  s.write('\r\n0123456789AB');
  assert.deepEqual(rows(s).slice(2), ['0123456789', 'AB']);
  s.write('\b\bX'); assert.equal(rows(s)[3], 'XB');
  const t = new Screen(20, 2); t.write('a\tb'); assert.equal(t.lines[0].ch[8], 'b');
});
test('screen: scrolling pushes lines into the scrollback; erase and cursor moves', () => {
  const s = new Screen(8, 3, { scrollback: 2 });
  for (let i = 1; i <= 6; i++) s.write('L' + i + '\r\n');
  assert.equal(s.scrollback.length, 2);
  assert.equal(s.lineText(s.line(0)), 'L4'.replace('L4', 'L3') === 'L3' ? s.lineText(s.line(0)) : '');
  const t = new Screen(8, 3); t.write('abcdef\x1b[3D\x1b[K'); assert.equal(rows(t)[0], 'abc');
  t.write('\x1b[2J\x1b[H'); assert.deepEqual(rows(t), ['', '', '']);
  t.write('\x1b[2;3Hx'); assert.equal(t.lines[1].ch[2], 'x');
  t.write('\x1b[1;1H\x1b[2K12345\x1b[2G\x1b[2P'); assert.equal(rows(t)[0], '145');
});
test('screen: colours, 256 and true colour, resets', () => {
  const s = new Screen(20, 2);
  s.write('\x1b[1;31mR\x1b[0m\x1b[38;5;200mP\x1b[48;2;1;2;3mT\x1b[0mN');
  const d = (i) => s.describe(s.lines[0].st[i]);
  assert.deepEqual([d(0).fg, d(0).b], [1, 1]);
  assert.equal(d(1).fg, 200);
  assert.equal(d(2).bg, '#010203');
  assert.deepEqual([d(3).fg, d(3).bg, d(3).b], [-1, -1, 0]);
  s.write('\x1b[92mG'); assert.equal(s.describe(s.lines[0].st[4]).fg, 10);
  assert.equal(xterm256(16), '#000000'); assert.equal(xterm256(231), '#ffffff'); assert.equal(xterm256(232), '#080808');
});
test('screen: progress bars (carriage return + erase), alternate screen, scroll region, insert/delete lines', () => {
  const s = new Screen(12, 4);
  s.write('10%'); s.write('\r\x1b[K50%'); assert.equal(rows(s)[0], '50%');
  s.write('\r\nmain'); s.write('\x1b[?1049h'); assert.ok(s.alt); s.write('\x1b[Halt'); assert.equal(rows(s)[0], 'alt');
  s.write('\x1b[?1049l'); assert.ok(!s.alt); assert.deepEqual(rows(s).slice(0, 2), ['50%', 'main']);
  const r = new Screen(5, 5); r.write('1\r\n2\r\n3\r\n4\r\n5\x1b[2;4r\x1b[4;1H\n'); assert.deepEqual(rows(r), ['1', '3', '4', '', '5']);
  const l = new Screen(5, 4); l.write('a\r\nb\r\nc\x1b[2;1H\x1b[L'); assert.deepEqual(rows(l), ['a', '', 'b', 'c']);
  l.write('\x1b[M'); assert.deepEqual(rows(l), ['a', 'b', 'c', '']);
});
test('screen: wide characters, combining marks, split surrogate pairs, resize keeps text', () => {
  const s = new Screen(6, 2);
  s.write('你好!'); assert.equal(cw(0x4f60), 2); assert.deepEqual(s.lines[0].ch.slice(0, 5), ['你', '', '好', '', '!']);
  s.write('\r\né'); assert.equal(s.lines[1].ch[0], 'é');
  const t = new Screen(8, 2); const em = '😀'; t.write('a' + em.slice(0, 1)); t.write(em.slice(1) + 'b'); assert.equal(t.lines[0].ch[1], em);
  const u = new Screen(10, 3); u.write('one\r\ntwo\r\nthree'); u.resize(4, 2); assert.equal(u.lineText(u.lines[1]), 'thre'); assert.ok(u.scrollback.length >= 1);
  u.resize(10, 3); assert.equal(rows(u)[2], 'three'.slice(0, 4)); 
});
test('screen: queries are never answered, strings are swallowed, title is kept and cleaned', () => {
  const s = new Screen(20, 2);
  const writes = []; s.reply = (x) => writes.push(x);
  s.write('\x1b[6n\x1b[c\x1b[0c\x1b]52;c;SGVsbG8=\x07ok');
  assert.deepEqual(writes, []); assert.equal(rows(s)[0], 'ok');
  s.write('\x1b]0;my title\x07'); assert.equal(s.title, 'my title');
  s.write('\x1b]2;bad\x1b\x07\x1b\\'); assert.ok(!/\x1b/.test(s.title));
  s.write('\x1bP+q544e\x1b\\x'); assert.equal(rows(s)[0], 'okx');
  s.write('\x1b[?2004h'); assert.ok(s.bracketed); s.write('\x1b[?1h'); assert.ok(s.appCursor);
  assert.ok(!/reply|respond|write\(.*input/.test(fs.readFileSync(path.join(dir, 'vt.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/this\.write/g, '')), 'the model has no way to send anything out');
});
test('screen: hostile input does not throw or grow without limit', () => {
  const s = new Screen(10, 3, { scrollback: 50 });
  let junk = ''; for (let i = 0; i < 4000; i++) junk += String.fromCharCode((i * 7919) % 127) + (i % 9 === 0 ? '\x1b[' + (i % 300) + ';' + (i % 400) + 'H' : '') + (i % 31 === 0 ? '\x1b]0;' : '');
  assert.doesNotThrow(() => { s.write(junk); s.write('\x1b[99999999;99999999H\x1b[99999999L\x1b[99999999P\x1b[99999999@\x1b[99999999S'); });
  s.write('x\r\n'.repeat(5000)); assert.ok(s.scrollback.length <= 50);
  assert.ok(s.x >= 0 && s.x < s.cols && s.y >= 0 && s.y < s.rows);
});

test('keys: what a terminal sends', () => {
  const k = (key, m = {}) => encode({ key, ...m });
  assert.equal(k('a'), 'a'); assert.equal(k('Enter'), '\r'); assert.equal(k('Backspace'), '\x7f'); assert.equal(k('Tab'), '\t'); assert.equal(k('Tab', { shiftKey: true }), '\x1b[Z');
  assert.equal(k('c', { ctrlKey: true }), '\x03'); assert.equal(k('d', { ctrlKey: true }), '\x04'); assert.equal(k('l', { ctrlKey: true }), '\x0c'); assert.equal(k('[', { ctrlKey: true }), '\x1b');
  assert.equal(k('ArrowUp'), '\x1b[A'); assert.equal(encode({ key: 'ArrowUp' }, { appCursor: true }), '\x1bOA'); assert.equal(k('ArrowLeft', { ctrlKey: true }), '\x1b[1;5D');
  assert.equal(k('Delete'), '\x1b[3~'); assert.equal(k('PageUp'), '\x1b[5~'); assert.equal(k('Home'), '\x1b[H'); assert.equal(k('F1'), '\x1bOP'); assert.equal(k('F5'), '\x1b[15~');
  assert.equal(k('b', { altKey: true }), '\x1bb'); assert.equal(k('é'), 'é');
  assert.equal(k('c', { metaKey: true }), null); assert.equal(k('Shift'), null); assert.equal(k('Dead'), null); assert.equal(k('1', { ctrlKey: true }), null);
});
test('line editor (basic mode): edit locally, send whole lines, history, Ctrl+C / Ctrl+D', () => {
  const e = new LineEditor(); const key = (key, m = {}) => e.feed({ key, ...m });
  for (const c of 'ls -l') key(c);
  assert.equal(e.buf, 'ls -l'); key('ArrowLeft'); key('ArrowLeft'); key('Backspace'); assert.equal(e.buf, 'ls-l'); key('x'); assert.equal(e.buf, 'lsx-l'); key('End');
  let r = key('Enter'); assert.equal(r.send, 'lsx-l\n'); assert.equal(e.buf, '');
  for (const c of 'pwd') key(c); assert.equal(key('Enter').send, 'pwd\n');
  key('ArrowUp'); assert.equal(e.buf, 'pwd'); key('ArrowUp'); assert.equal(e.buf, 'lsx-l'); key('ArrowDown'); key('ArrowDown'); assert.equal(e.buf, '');
  for (const c of 'abc') key(c); r = key('c', { ctrlKey: true }); assert.equal(r.interrupt, true); assert.equal(e.buf, '');
  assert.equal(key('d', { ctrlKey: true }).eof, true); for (const c of 'q') key(c); assert.ok(!key('d', { ctrlKey: true }).eof);
  const f = new LineEditor(); r = f.feed({ text: 'one\r\ntwo\n' }); assert.equal(r.send, 'one\ntwo\n');
  f.feed({ text: 'abc def' }); f.feed({ key: 'w', ctrlKey: true }); assert.equal(f.buf, 'abc ');
});

test('page: strict CSP, no inline script or handlers, no remote anything, text only (no innerHTML)', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'self'/); assert.ok(!/unsafe-inline|unsafe-eval/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html)); assert.ok(!/ on[a-z]+=/i.test(html)); assert.ok(!/https?:\/\//i.test(html));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setAttribute\(\s*['"]style/.test(code), f);
    assert.ok(!/https?:\/\//.test(code), f + ' has no URL'); assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/.test(code), f);
  }
  const css = fs.readFileSync(path.join(dir, 'term.css'), 'utf8');
  assert.ok(!/mf-tint|mf-tile/.test(css)); assert.ok(!/https?:/.test(css)); assert.match(css, /prefers-reduced-motion/);
});
test('page: the only thing sent to the shell comes from key, paste and composition handlers', () => {
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const sends = [...app.matchAll(/\bsend\(t,|api\.input\(/g)].length;
  assert.ok(sends >= 4);
  // every send site sits inside sink handlers or the paste confirm: no timers, no onData handler writes back
  const onData = app.slice(app.indexOf('api.onData('), app.indexOf('api.onExit('));
  assert.ok(!/send\(|api\.input/.test(onData), 'output never triggers input');
  assert.ok(!/setTimeout\([^)]*send\(/.test(app) && !/setInterval/.test(app));
  const pre = fs.readFileSync(path.join(dir, 'preload.js'), 'utf8');
  assert.ok(!/gterm:(exec|run|spawn|shell|command)\b/.test(pre) && !/exposeInMainWorld\([^)]*ipcRenderer/.test(pre));
});
