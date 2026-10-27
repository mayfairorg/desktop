'use strict';
// Ghost virtual computer: the calls the windows may make, and what shape their arguments must have.
// ONE table of operations, bound to two windows by a prefix:
//   gterm:vm.<op>   the Ghost terminal window (the virtual computer console: status, download, network, reset, Run from GitHub)
//   gapp:vm.<op>    the Mayfair Ghost window (Tool Integrations: "Add a tool", the library list)
// Each window registers only the operations in its own list. No operation takes a command, an argument list, a program name or a path:
// a command is named by an id that main produced, a path comes from a native picker, and a connector is described by a form that main checks.
const M = require('../manifest');
const { CASE_RE, SNAP_RE } = require('./disk');
const { FORM_KEYS } = require('./installer');
const { RunFromGithub } = require('./rungh');

const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keysIn = (v, ok) => Object.keys(v).every((k) => ok.includes(k));
const str = (n) => (v) => typeof v === 'string' && v.length <= n && !v.includes('\0');
const toolId = (v) => typeof v === 'string' && M.ID_RE.test(v);
const token = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);
const runId = (v) => typeof v === 'string' && /^r[a-f0-9]{10}$/.test(v);
const sugId = (v) => typeof v === 'string' && /^[a-z]{2,8}-\d{1,2}$/.test(v);
const repoArgs = (v) => obj(v) && keysIn(v, ['url', 'ref', 'name']) && str(300)(v.url) && (v.ref === undefined || str(200)(v.ref)) && (v.name === undefined || toolId(v.name));
const form = (v) => obj(v) && keysIn(v, FORM_KEYS) && Object.entries(v).every(([k, x]) => (k === 'args' ? Array.isArray(x) && x.length <= 20 && x.every(str(500)) : k === 'timeoutSec' ? typeof x === 'number' && x > 0 && x <= 1800 : str(1000)(x)));
const resources = (v) => obj(v) && keysIn(v, ['memMb', 'cpus', 'diskGb']) && Object.values(v).every((x) => Number.isInteger(x));

const CALLS = {
  'status': [], 'install': [], 'cancelInstall': [], 'start': [(v) => obj(v) && keysIn(v, ['caseId']) && (v.caseId === undefined || (typeof v.caseId === 'string' && CASE_RE.test(v.caseId)))], 'stop': [], 'kill': [],
  'network': [(v) => obj(v) && keysIn(v, ['mode']) && ['tor', 'direct-doh', 'none'].includes(v.mode)],
  'useCase': [(v) => obj(v) && keysIn(v, ['caseId']) && typeof v.caseId === 'string' && CASE_RE.test(v.caseId)],
  'reset': [], 'snapshots': [], 'snapshot': [(v) => typeof v === 'string' && SNAP_RE.test(v)], 'restore': [(v) => typeof v === 'string' && SNAP_RE.test(v)], 'deleteSnapshot': [(v) => typeof v === 'string' && SNAP_RE.test(v)],
  'resources': [resources], 'openShare': [], 'wipeTools': [], 'log': [],
  'gh.clone': [(v) => obj(v) && keysIn(v, ['url', 'ref']) && str(300)(v.url) && (v.ref === undefined || str(200)(v.ref))],
  'gh.show': [(v) => obj(v) && keysIn(v, ['name', 'id']) && typeof v.name === 'string' && /^[a-z0-9._-]{1,60}$/.test(v.name) && sugId(v.id)],
  'tools.list': [], 'tools.verify': [],
  'tools.prepareGithub': [repoArgs],
  'tools.prepareUpload': [(v) => obj(v) && keysIn(v, ['kind', 'name']) && ['folder', 'zip', 'script'].includes(v.kind) && (v.name === undefined || toolId(v.name))],
  'tools.cancel': [token], 'tools.commit': [token],
  'tools.setupOptions': [toolId],
  'tools.runSetup': [(v) => obj(v) && keysIn(v, ['name', 'ids']) && toolId(v.name) && Array.isArray(v.ids) && v.ids.length >= 1 && v.ids.length <= 12 && v.ids.every(sugId)],
  'tools.setupRun': [runId], 'tools.cancelSetup': [runId],
  'tools.previewConnector': [(v) => obj(v) && keysIn(v, ['name', 'form']) && toolId(v.name) && form(v.form)],
  'tools.register': [(v) => obj(v) && keysIn(v, ['name', 'form']) && toolId(v.name) && form(v.form)],
  'tools.unregister': [toolId],
  'tools.prepareUpdate': [(v) => obj(v) && keysIn(v, ['name', 'ref']) && toolId(v.name) && (v.ref === undefined || str(200)(v.ref))],
  'tools.applyUpdate': [(v) => obj(v) && keysIn(v, ['token', 'discardChanges']) && token(v.token) && (v.discardChanges === undefined || typeof v.discardChanges === 'boolean')],
  'tools.remove': [(v) => obj(v) && keysIn(v, ['name', 'deleteFiles']) && toolId(v.name) && (v.deleteFiles === undefined || typeof v.deleteFiles === 'boolean')],
  'library.exportFile': [], 'library.importFile': [], 'library.importStatus': [], 'library.list': [],
};

const VM_OPS = ['status', 'install', 'cancelInstall', 'start', 'stop', 'kill', 'useCase', 'network', 'reset', 'snapshots', 'snapshot', 'restore', 'deleteSnapshot', 'resources', 'openShare', 'wipeTools', 'log'];
const TERMINAL_OPS = [...VM_OPS, 'gh.clone', 'gh.show'];
const APP_OPS = ['status', 'install', 'cancelInstall', 'start', 'network', 'tools.list', 'tools.verify', 'tools.prepareGithub', 'tools.prepareUpload', 'tools.cancel', 'tools.commit', 'tools.setupOptions', 'tools.runSetup', 'tools.setupRun',
  'tools.cancelSetup', 'tools.previewConnector', 'tools.register', 'tools.unregister', 'tools.prepareUpdate', 'tools.applyUpdate', 'tools.remove', 'library.exportFile', 'library.importFile', 'library.importStatus', 'library.list', 'kill'];

// vm: VmService. installer: VmToolInstaller. library: ToolLibrary. fsx/dialogs: shell.openPath(folder), saveJson(name, text) -> path|null, pickJson() -> text|null.
function makeOps({ vm, installer, library, openPath = async () => false, saveJson = async () => null, pickJson = async () => null }) {
  const gh = new RunFromGithub({ vm });
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return { ok: false, code: e.code || 'error', error: String((e && e.message) || e).slice(0, 300) }; } };
  const ops = {
    'status': () => vm.status(),
    'install': () => vm.install(), 'cancelInstall': () => vm.cancelInstall(),
    'start': (o) => vm.start(o || {}), 'stop': () => vm.stop(), 'kill': () => vm.kill(),
    'network': (o) => vm.setNetwork(o.mode), 'useCase': (o) => vm.useCase(o.caseId),
    'reset': () => vm.reset(), 'snapshots': async () => ({ ok: true, snapshots: await vm.listSnapshots() }), 'snapshot': (n) => vm.snapshot(n), 'restore': (n) => vm.restore(n), 'deleteSnapshot': (n) => vm.deleteSnapshot(n),
    'resources': (o) => vm.setResources(o), 'wipeTools': () => vm.wipeTools(), 'log': () => ({ ok: true, ...vm.getBootLog() }),
    'openShare': async () => { const s = vm.status().share; if (!s || !s.dir) return { ok: false, code: 'no-share', error: 'Start the virtual computer once to make the shared folder.' }; const r = await openPath(s.dir); return { ok: !r, dir: s.dir, error: r || undefined }; },
    'gh.clone': (o) => gh.clone(o), 'gh.show': (o) => gh.commandText(o),
    'tools.list': () => ({ ok: true, tools: installer.list() }), 'tools.verify': async () => ({ ok: true, tools: await installer.verifyPresent() }),
    'tools.prepareGithub': (o) => installer.prepareGithub(o), 'tools.prepareUpload': (o) => installer.prepareUpload(o),
    'tools.cancel': (t) => installer.cancel(t), 'tools.commit': (t) => installer.commit(t),
    'tools.setupOptions': (n) => installer.setupOptions(n), 'tools.runSetup': (o) => installer.runSetup(o), 'tools.setupRun': (r) => installer.setupRun(r), 'tools.cancelSetup': (r) => installer.cancelSetup(r),
    'tools.previewConnector': (o) => installer.previewConnector(o), 'tools.register': (o) => installer.register(o), 'tools.unregister': (n) => installer.unregister(n),
    'tools.prepareUpdate': (o) => installer.prepareUpdate(o), 'tools.applyUpdate': (o) => installer.applyUpdate(o), 'tools.remove': (o) => installer.remove(o),
    'library.list': () => ({ ok: true, tools: library.list() }),
    'library.exportFile': async () => { const p = await saveJson('ghost-tool-library.json', JSON.stringify(library.export(), null, 2) + '\n'); return p ? { ok: true, saved: true } : { ok: false, code: 'cancelled', error: 'Cancelled.' }; },
    'library.importFile': async () => {
      const t = await pickJson(); if (t === null) return { ok: false, code: 'cancelled', error: 'Cancelled.' };
      let j; try { j = JSON.parse(t); } catch { return { ok: false, code: 'bad-list', error: 'That file is not a tool library list.' }; }
      return installer.importLibrary(j);
    },
    'library.importStatus': () => installer.importStatus(),
  };
  const wrapped = {}; for (const [k, f] of Object.entries(ops)) wrapped[k] = guard(f);
  return { ops: wrapped, gh };
}

// -> {handlers: {channel: fn(event, ...args)}, calls: {channel: [validators]}}
function bind(prefix, names, ops) {
  const handlers = {}, calls = {};
  for (const n of names) { handlers[prefix + n] = (_e, ...a) => ops[n](...a); calls[prefix + n] = CALLS[n]; }
  return { handlers, calls };
}

module.exports = { CALLS, TERMINAL_OPS, APP_OPS, makeOps, bind };
