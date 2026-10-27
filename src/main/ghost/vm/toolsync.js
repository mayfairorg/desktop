'use strict';
// Ghost virtual computer: the tool library list <-> the person's Mayfair account.
// The Cloud page (which holds the Mayfair session) does the talking to the server; this file is the desktop half of that:
//   list()          the local list in the SERVER shape (tool_key, name, source_url, pinned_ref, checksum, version, notes, added_at)
//   import(list)    a server-shape list, mapped back to a tool library list and handed to the installer's existing importLibrary(), so every
//                   tool is fetched again at its pinned commit, checked against its SHA-256, and every connector needs approval again here.
//   localOnly()     the switch: default is that the list follows the account; turned on, nothing is read out for the account and nothing is imported.
// It never carries case data, a path, a setup command or a connector description (the list holds none of those for the server), and it
// does not filter what a person installs.
const fs = require('node:fs');
const path = require('node:path');
const { NAME_RE, SCHEMA, KIND } = require('./toollib');

const SHA40 = /^[0-9a-f]{40}$/, SHA64 = /^[0-9a-f]{64}$/;
const GH_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SERVER_KEYS = ['tool_key', 'name', 'source_url', 'pinned_ref', 'checksum', 'version', 'notes', 'added_at', 'updated_at'];
const MAX_SERVER = 200, NOTES_MAX = 500;

const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (ms) => (Number.isSafeInteger(ms) && ms > 0 ? new Date(ms).toISOString() : undefined);

// The notes of an entry are a list of lines; the server holds one text of at most 500 characters. The newest lines are kept, whole.
function notesText(lines) {
  const out = [];
  let n = 0;
  for (const l of [...(Array.isArray(lines) ? lines : [])].reverse()) {
    const s = String(l).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!s) continue;
    if (n + s.length + (out.length ? 1 : 0) > NOTES_MAX) break;
    out.unshift(s); n += s.length + (out.length > 1 ? 1 : 0);
  }
  return out.join('\n');
}

// entries: valid toollib entries. -> {tools:[server shape]}. A GitHub tool carries its address; an uploaded tool has source_url ''.
function toServer(entries, now = Date.now()) {
  const tools = [];
  for (const e of entries) {
    if (!obj(e) || !NAME_RE.test(e.name || '') || !obj(e.checksum)) continue;
    const t = {
      tool_key: e.name, name: e.name,
      source_url: e.source && e.source.type === 'github' ? e.source.url : '',
      pinned_ref: typeof e.commit === 'string' ? e.commit : '',
      checksum: e.checksum.value, version: e.version || '', notes: notesText(e.notes),
    };
    const added = Date.parse(e.addedAt);
    if (Number.isFinite(added) && added > 0) t.added_at = Math.min(added, now);
    tools.push(t);
  }
  return { tools };
}

const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);

// list: {tools:[server shape]}. -> {list: a tool library list (schema 1), skipped:[{key, reason}], manual:[{key, name}]}
// A tool is restored only with a GitHub address, a 40-character pinned commit and a SHA-256: without them nothing could be checked, so it is skipped
// and reported. An uploaded tool (no address) cannot be fetched again and is listed for the person to add by hand.
function fromServer(list) {
  const skipped = [], manual = [], tools = [];
  const seen = new Set();
  for (const s of (obj(list) && Array.isArray(list.tools) ? list.tools : []).slice(0, MAX_SERVER)) {
    const key = obj(s) && typeof s.tool_key === 'string' ? s.tool_key.slice(0, 64) : '?';
    const skip = (reason) => skipped.push({ key, reason });
    if (!obj(s) || !Object.keys(s).every((k) => SERVER_KEYS.includes(k))) { skip('not a tool entry'); continue; }
    if (!NAME_RE.test(s.tool_key || '')) { skip('its name cannot be used as a tool name here'); continue; }
    if (seen.has(s.tool_key)) continue;
    seen.add(s.tool_key);
    if (s.source_url === '' || s.source_url === undefined) { manual.push({ key: s.tool_key, name: text(s.name, 120) && s.name ? s.name : s.tool_key }); continue; }
    if (typeof s.source_url !== 'string' || !GH_URL.test(s.source_url)) { skip('its address is not a GitHub repository'); continue; }
    if (typeof s.pinned_ref !== 'string' || !SHA40.test(s.pinned_ref)) { skip('it has no 40-character pinned commit'); continue; }
    const sum = typeof s.checksum === 'string' ? s.checksum.replace(/^sha256:/i, '').toLowerCase() : '';
    if (!SHA64.test(sum)) { skip('it has no SHA-256 checksum'); continue; }
    const e = { name: s.tool_key, source: { type: 'github', url: s.source_url, repo: s.source_url.slice('https://github.com/'.length) }, commit: s.pinned_ref, checksum: { algo: 'sha256', value: sum } };
    if (typeof s.version === 'string' && s.version && text(s.version, 64)) e.version = s.version;
    if (typeof s.notes === 'string' && s.notes) { const n = s.notes.split('\n').map((x) => x.trim()).filter(Boolean).slice(-30).map((x) => x.slice(0, 400)); if (n.length) e.notes = n; }
    const a = iso(s.added_at), u = iso(s.updated_at);
    if (a) e.addedAt = a;
    if (u) e.updatedAt = u;
    tools.push(e);
  }
  return { list: { schema: SCHEMA, kind: KIND, tools }, skipped, manual };
}

class ToolSync {
  // dir: <Ghost data folder> (toollib-sync.json lives next to toollib.json). getLibrary(): the ToolLibrary. getInstaller(): the VmToolInstaller. now: clock.
  constructor({ dir, getLibrary, getInstaller, now = Date.now }) {
    if (!dir || typeof getLibrary !== 'function' || typeof getInstaller !== 'function') throw new Error('dir, getLibrary and getInstaller are needed');
    this.file = path.join(dir, 'toollib-sync.json'); this.getLibrary = getLibrary; this.getInstaller = getInstaller; this.now = now;
  }
  // true when the person chose to keep the list on this computer only. Anything unreadable means the default: the list follows the account.
  isLocalOnly() {
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); return !!d && d.v === 1 && d.localOnly === true; } catch { return false; }
  }
  localOnly() { return { ok: true, localOnly: this.isLocalOnly() }; }
  setLocalOnly(on) {
    if (typeof on !== 'boolean') return { ok: false, code: 'bad-input', error: 'true or false is needed.' };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 1, localOnly: on }) + '\n', { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return { ok: true, localOnly: on };
  }
  // With the switch on, nothing is handed to the page for the account.
  list() {
    if (this.isLocalOnly()) return { ok: true, localOnly: true, tools: [] };
    return { ok: true, localOnly: false, tools: toServer(this.getLibrary().list(), this.now()).tools };
  }
  import(serverList) {
    if (this.isLocalOnly()) return { ok: false, code: 'local-only', error: 'This list is kept on this computer only.' };
    const m = fromServer(serverList);
    if (!m.list.tools.length) return { ok: true, plan: [], skipped: m.skipped, manual: m.manual, conflicts: [], rejected: [] };
    const r = this.getInstaller().importLibrary(m.list);
    if (!r || !r.ok) return r || { ok: false, code: 'error', error: 'The import did not start.' };
    return { ok: true, plan: r.plan, skipped: m.skipped, manual: m.manual, conflicts: r.conflicts, rejected: r.rejected };
  }
  importStatus() { return this.getInstaller().importStatus(); }
}

module.exports = { ToolSync, toServer, fromServer, notesText, SERVER_KEYS, MAX_SERVER };
