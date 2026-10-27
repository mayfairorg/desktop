'use strict';
// Ghost terminal: the first-use notice. It is a native dialog shown by the main process, so no web page can click it or fake it.
// The acceptance is a small local file (version + time). Nothing is sent anywhere. A new major version asks again.
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '1.0';
const major = (v) => String(v || '').split('.')[0];

class TermsStore {
  constructor(file) { this.file = file; }
  accepted() {
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return !!r && typeof r === 'object' && major(r.version) === major(VERSION) && Number.isFinite(Date.parse(r.acceptedAt));
    } catch { return false; }
  }
  record(now = Date.now()) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, acceptedAt: new Date(now).toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  clear() { try { fs.rmSync(this.file, { force: true }); } catch { /* nothing to clear */ } }
}

function noticeOptions(toolsDir) {
  return {
    type: 'warning',
    title: 'Ghost terminal',
    message: 'This terminal runs real commands on this computer.',
    detail: [
      'Whatever you type or paste runs as you, with access to your files, accounts and network, exactly like a terminal you open yourself. Mayfair does not check commands and cannot undo them.',
      'Nothing runs until you type it. A web page, including Mayfair Cloud, cannot send anything to this window.',
      'Programs you download for Ghost go in this folder, which is added to your PATH here:\n' + toolsDir,
      'Use it only for work you are allowed to do, and only on systems you own or have permission to test.',
    ].join('\n\n'),
    buttons: ['I understand, open the terminal', 'Cancel'],
    defaultId: 1, cancelId: 1, noLink: true,
  };
}

// dialog: Electron's dialog (or a test double). Resolves true only when the person clicked the first button.
async function ensureAccepted({ store, dialog, parent, toolsDir, now }) {
  if (store.accepted()) return true;
  const o = noticeOptions(toolsDir);
  const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, o) : await dialog.showMessageBox(o);
  if (r.response !== 0) return false;
  store.record(now);
  return true;
}

module.exports = { TermsStore, ensureAccepted, noticeOptions, VERSION };
