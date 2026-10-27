'use strict';
// Quick notes pages and styles: policy, skins (tokens only), shortcuts, the bridge, and the hard line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dir = path.join(__dirname, '..', 'src', 'ui', 'ghost');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const files = ['qn-model.js', 'quicknotes.js', 'quicknotes-boot.js', 'quicknotes-preload.js'];

test('every Quick notes script parses; page code has no innerHTML, eval, inline style or web addresses', () => {
  for (const f of files) {
    const src = read(f); assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
    if (f.endsWith('preload.js')) continue;
    assert.equal(/\.innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function|setAttribute\(\s*['"]style['"]/.test(src), false, f);
    assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\^?https\?[^\n]*/g, '').replace(/'(https?:|mailto:)[^']*'/g, '')), false, f + ' has a web address');
    assert.equal(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(src), false, f + ' touches the network');
  }
});
test('quicknotes.css: tokens only, no hex colour, no own radius, no tinted icon chips', () => {
  const css = read('quicknotes.css'); assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false); assert.equal(/border-radius:\s*\d/.test(css), false); assert.equal(/rgba?\(|hsla?\(/.test(css), false);
  assert.equal(/\.chip-ico|\.ico-chip|icon-chip|\.ico-bg|\.tint/.test(css + read('quicknotes.js')), false);
  assert.match(css, /max-width:\s*900px|900px/); assert.match(css, /pointer:\s*coarse/);
});
test('quicknotes.html: strict CSP, right scripts in order, no inline code', () => {
  const html = read('quicknotes.html'); assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'/); assert.equal(/<script(?![^>]*src=)/.test(html), false); assert.equal(/\sstyle=|\son[a-z]+=/i.test(html), false);
  const s = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]); assert.deepEqual(s, ['util.js', 'qn-model.js', 'quicknotes.js', 'quicknotes-boot.js']); for (const x of s) assert.ok(fs.existsSync(path.join(dir, x)));
  assert.ok(html.includes('quicknotes.css') && html.includes('mf-tokens.css'));
});
test('the Ghost page loads the notes files after board.js, and the shell wires the button, the dock and the shortcuts', () => {
  const html = read('index.html'), sc = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sc.indexOf('qn-model.js') > sc.indexOf('board.js') && sc.indexOf('quicknotes.js') > sc.indexOf('qn-model.js')); assert.ok(html.includes('quicknotes.css'));
  const shell = read('shell.js'); assert.match(shell, /GH\.qn\.topButton\(/); assert.match(shell, /GH\.qn\.attach\(/); assert.match(shell, /GH\.qn\.SHORTCUTS/);
  const qn = read('quicknotes.js'); assert.match(qn, /Shift\+N|shiftKey/); assert.match(qn, /SHORTCUTS/);
});
test('both preloads expose a frozen bridge and only gqn channels for notes', () => {
  const pre = read('quicknotes-preload.js'); assert.match(pre, /Object\.freeze\(\{\s*\n?\s*notes/); assert.deepEqual([...new Set([...pre.matchAll(/'(gqn:[^']+)'/g)].map((m) => m[1].split('.')[0]))].every((c) => c.startsWith('gqn:')), true);
  const main = read('preload.js'); assert.match(main, /notes:\s*Object\.freeze/); assert.equal(/ipcRenderer\s*[,}]/.test(pre.replace(/const \{[^}]*\} = require/, '')) && /exposeInMainWorld\([^)]*ipcRenderer/.test(pre), false);
});
test('the hard line is unchanged: nothing here looks up or stores a private person', () => {
  const all = files.map(read).join('\n') + read('quicknotes.css');
  assert.equal(/people[- ]?search|person lookup|lookupPerson|find a person|skip.?trace|reverse phone|electoral roll/i.test(all), false);
});
