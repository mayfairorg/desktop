'use strict';
const path = require('node:path');
const fs = require('node:fs');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function safeFilename(name) {
  let n = String(name || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/[ .]+$/, '').trim();
  if (!n || RESERVED.test(n)) n = 'download' + (n ? '-' + n : '');
  if (n.length > 150) { const ext = path.extname(n).slice(0, 12); n = n.slice(0, 150 - ext.length) + ext; }
  return n;
}
// "a.pdf" -> "a (1).pdf" -> "a (2).pdf"
function uniquePath(dir, name, exists = fs.existsSync) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; exists(p) && i < 10000; i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}
// Where a download goes. mode: drive | folder | ask. Returns { dir } or { ask:true }.
function chooseDir(settings, { driveDir, downloadsDir }) {
  if (settings.downloadMode === 'ask') return { ask: true };
  if (settings.downloadMode === 'folder' && settings.downloadFolder) return { dir: settings.downloadFolder };
  if (settings.downloadMode === 'folder') return { dir: downloadsDir };
  return { dir: driveDir };
}
module.exports = { safeFilename, uniquePath, chooseDir };
