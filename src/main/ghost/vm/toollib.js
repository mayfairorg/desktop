'use strict';
// Ghost virtual computer: the TOOL LIBRARY LIST. A small local file in the Ghost data folder that names the tools this person added,
// so the same list can be carried to another computer (another part of the app copies it to the person's Mayfair account).
//
// What an entry holds:   name, where it came from (a GitHub address, or "uploaded"), the pinned commit, a SHA-256 of its files, its
//                        version, install notes (the setup commands that were shown and run), and the connector it was registered as.
// What it never holds:   case data, files from the shared folder, results, notes, secrets, paths on this computer.
// Only the keys below are accepted; an entry with anything else is rejected, so nothing else can ride along.
//
//   export()          the list as a plain object (schema 1) for the sync code to store.
//   import(list)      checks a list from elsewhere, merges it into this one (merge()), saves, and says which tools have to be fetched
//                     into the virtual computer on this computer. It does NOT fetch anything and approves nothing: the installer
//                     re-fetches each tool at its pinned commit, compares the checksum, and every connector needs approval again here.
//   merge(a, b)       pure function behind import(): one entry per name; the same commit is kept as is; a different commit is a conflict
//                     and the entry changed most recently wins (the other one is reported so the person can see it).
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 1, KIND = 'ghost-tool-library';
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;       // the same shape as a connector id: the tool's folder in the machine is named by it
const SHA40 = /^[0-9a-f]{40}$/, SHA64 = /^[0-9a-f]{64}$/;
const GH_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const FORM_KEYS = ['id', 'title', 'description', 'program', 'args', 'output', 'entityType', 'inputLabel', 'network', 'scope', 'licence', 'restrictions', 'timeoutSec', 'selfTestInput'];
const KEYS = ['name', 'source', 'commit', 'checksum', 'version', 'notes', 'setup', 'connector', 'licence', 'addedAt', 'updatedAt'];
const MAX_TOOLS = 500, MAX_ENTRY = 64 * 1024, MAX_FILE = 4 * 1024 * 1024;

const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => Object.keys(v).every((k) => keys.includes(k));
const text = (v, max) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const iso = (v) => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

// -> {ok:true, entry} (a clean copy with only the known keys) or {ok:false, error}
function validateEntry(e) {
  const bad = (m) => ({ ok: false, error: m });
  if (!obj(e) || !only(e, KEYS)) return bad('not a tool entry (unknown keys)');
  if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) return bad('bad tool name');
  const s = e.source;
  if (!obj(s) || !['github', 'upload'].includes(s.type)) return bad('bad source');
  if (s.type === 'github') {
    if (!only(s, ['type', 'url', 'repo', 'ref']) || typeof s.url !== 'string' || !GH_URL.test(s.url)) return bad('a GitHub source needs an https://github.com/owner/repo address');
    if (typeof s.repo !== 'string' || s.url !== 'https://github.com/' + s.repo) return bad('source address and repository do not match');
    if (s.ref !== undefined && !(text(s.ref, 200) && /^[A-Za-z0-9._\/-]{1,200}$/.test(s.ref) && !s.ref.includes('..') && !s.ref.startsWith('-'))) return bad('bad ref');
    if (typeof e.commit !== 'string' || !SHA40.test(e.commit)) return bad('a GitHub tool needs a 40-character pinned commit');
  } else {
    if (!only(s, ['type', 'name']) || !text(s.name, 120)) return bad('bad upload source');
    if (e.commit !== undefined && !(typeof e.commit === 'string' && SHA40.test(e.commit))) return bad('bad commit');
  }
  if (!obj(e.checksum) || !only(e.checksum, ['algo', 'value']) || e.checksum.algo !== 'sha256' || !SHA64.test(e.checksum.value || '')) return bad('bad checksum');
  if (e.version !== undefined && !text(e.version, 64)) return bad('bad version');
  if (e.notes !== undefined && !(Array.isArray(e.notes) && e.notes.length <= 30 && e.notes.every((n) => text(n, 400)))) return bad('bad install notes');
  if (e.setup !== undefined && !(Array.isArray(e.setup) && e.setup.length <= 20 && e.setup.every((c) => obj(c) && only(c, ['label', 'command']) && text(c.label, 120) && text(c.command, 600)))) return bad('bad setup list');
  if (e.licence !== undefined && !text(e.licence, 100)) return bad('bad licence');
  for (const k of ['addedAt', 'updatedAt']) if (e[k] !== undefined && !iso(e[k])) return bad('bad ' + k);
  if (e.connector !== undefined) {
    // how the tool was described as a connector (the form values). It is checked again, in full, when it is registered on a computer.
    const c = e.connector;
    if (!obj(c) || !only(c, FORM_KEYS)) return bad('bad connector description');
    for (const k of FORM_KEYS) {
      if (c[k] === undefined) continue;
      if (k === 'args' ? !(Array.isArray(c.args) && c.args.length <= 20 && c.args.every((a) => text(a, 500))) : k === 'timeoutSec' ? !(typeof c.timeoutSec === 'number' && c.timeoutSec > 0 && c.timeoutSec <= 1800) : !text(c[k], 1000)) return bad('bad connector description: ' + k);
    }
  }
  const clean = {};
  for (const k of KEYS) if (e[k] !== undefined) clean[k] = JSON.parse(JSON.stringify(e[k]));
  if (Buffer.byteLength(JSON.stringify(clean)) > MAX_ENTRY) return bad('entry is too large');
  return { ok: true, entry: clean };
}

const stamp = (e) => Date.parse(e.updatedAt || e.addedAt || 0) || 0;

// Pure. local and remote are arrays of VALID entries. -> {tools, added:[name], updated:[name], kept:[name], conflicts:[{name, local, remote, chose}]}
function merge(local, remote) {
  const by = new Map(local.map((e) => [e.name, e]));
  const added = [], updated = [], kept = [], conflicts = [];
  for (const r of remote) {
    const l = by.get(r.name);
    if (!l) { by.set(r.name, r); added.push(r.name); continue; }
    const same = (l.commit || '') === (r.commit || '') && l.checksum.value === r.checksum.value;
    if (same) {
      // identical code: keep this computer's entry and take what it was missing (a registration, notes)
      const m = { ...l };
      for (const k of ['notes', 'setup', 'connector', 'licence', 'version']) if (m[k] === undefined && r[k] !== undefined) m[k] = r[k];
      by.set(r.name, m); kept.push(r.name); continue;
    }
    const remoteWins = stamp(r) > stamp(l);
    conflicts.push({ name: r.name, local: { commit: l.commit || '', updatedAt: l.updatedAt || '' }, remote: { commit: r.commit || '', updatedAt: r.updatedAt || '' }, chose: remoteWins ? 'remote' : 'local' });
    if (remoteWins) { by.set(r.name, r); updated.push(r.name); } else kept.push(r.name);
  }
  return { tools: [...by.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), added, updated, kept, conflicts };
}

class ToolLibrary {
  // file: <Ghost data folder>/toollib.json. now: clock. Plain file by design: it holds nothing secret and no case data.
  constructor({ file, now = Date.now } = {}) {
    if (!file) throw new Error('a file is needed');
    this.file = file; this.now = now; this.tools = this._load(); this.listeners = [];
  }
  // fn() is called after the list was saved (an install, an update, a removal or an import). The sync code uses it to tell the Cloud page.
  onChange(fn) { if (typeof fn === 'function') this.listeners.push(fn); }
  _load() {
    try {
      const st = fs.statSync(this.file); if (st.size > MAX_FILE) return [];
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!obj(d) || d.schema !== SCHEMA || !Array.isArray(d.tools)) return [];
      return d.tools.map((e) => validateEntry(e)).filter((v) => v.ok).map((v) => v.entry).slice(0, MAX_TOOLS);
    } catch { return []; }
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, kind: KIND, tools: this.tools }, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    for (const f of this.listeners) { try { f(); } catch { /* a listener must not break saving */ } }
  }
  list() { return this.tools.map((e) => JSON.parse(JSON.stringify(e))); }
  get(name) { const e = this.tools.find((t) => t.name === name); return e ? JSON.parse(JSON.stringify(e)) : null; }
  // Add or replace one entry (by name). Stamps the time.
  put(entry) {
    const t = new Date(this.now()).toISOString();
    const prev = this.tools.find((e) => e.name === (entry && entry.name));
    const v = validateEntry({ ...entry, addedAt: (prev && prev.addedAt) || entry.addedAt || t, updatedAt: t });
    if (!v.ok) throw new Error(v.error);
    const rest = this.tools.filter((e) => e.name !== v.entry.name);
    if (rest.length >= MAX_TOOLS) throw new Error('the list is full (' + MAX_TOOLS + ' tools)');
    this.tools = [...rest, v.entry].sort((a, b) => (a.name < b.name ? -1 : 1));
    this._save();
    return JSON.parse(JSON.stringify(v.entry));
  }
  remove(name) { const n = this.tools.length; this.tools = this.tools.filter((e) => e.name !== name); if (this.tools.length !== n) this._save(); return this.tools.length !== n; }

  export() { return { schema: SCHEMA, kind: KIND, exportedAt: new Date(this.now()).toISOString(), tools: this.list() }; }

  // list: what export() gave on another computer (or the sync code stored). -> {ok, added, updated, kept, conflicts, rejected:[{name, error}], fetch:[entry]}
  // `fetch` is what has to be put into the virtual computer here (every added or updated tool that has a GitHub source; an uploaded tool
  // cannot be fetched again and is listed in `manual`).
  import(list) {
    if (!obj(list) || list.schema !== SCHEMA || list.kind !== KIND || !Array.isArray(list.tools)) return { ok: false, error: 'This is not a Ghost tool library list.' };
    if (list.tools.length > MAX_TOOLS) return { ok: false, error: 'The list has too many tools (limit ' + MAX_TOOLS + ').' };
    const good = [], rejected = [];
    for (const e of list.tools) { const v = validateEntry(e); if (v.ok) good.push(v.entry); else rejected.push({ name: obj(e) && typeof e.name === 'string' ? e.name.slice(0, 60) : '?', error: v.error }); }
    const seen = new Set(); const unique = good.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
    const m = merge(this.tools, unique);
    if (m.tools.length > MAX_TOOLS) return { ok: false, error: 'The merged list would have more than ' + MAX_TOOLS + ' tools.' };
    this.tools = m.tools; this._save();
    const changed = new Set([...m.added, ...m.updated]);
    const entries = this.tools.filter((e) => changed.has(e.name));
    return { ok: true, added: m.added, updated: m.updated, kept: m.kept, conflicts: m.conflicts, rejected,
      fetch: entries.filter((e) => e.source.type === 'github'), manual: entries.filter((e) => e.source.type !== 'github').map((e) => ({ name: e.name, source: e.source.name })) };
  }
}

module.exports = { ToolLibrary, validateEntry, merge, SCHEMA, KIND, KEYS, NAME_RE };
