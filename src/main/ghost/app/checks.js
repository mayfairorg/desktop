'use strict';
// Ghost app window: which calls the window may make and what shape their arguments must have. These channels (gapp:*) belong to the Ghost app window only.
// They are not part of the Browser bridge: the Mayfair Cloud page, a web page tab or any other window cannot reach them (window.js checks the sender, the frame and the page address).
const M = require('../manifest');
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keysIn = (v, ok) => Object.keys(v).every((k) => ok.includes(k));
const str = (n) => (v) => typeof v === 'string' && v.length <= n && !v.includes('\0');
const bool = (v) => typeof v === 'boolean';
const connId = (v) => typeof v === 'string' && M.ID_RE.test(v);
const jobId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v);
const caseId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
const scopeId = (v) => typeof v === 'string' && /^sc-[a-f0-9]{16}$/.test(v);
const searchId = (v) => typeof v === 'string' && /^s-[a-f0-9]{16}$/.test(v);
const KINDS = require('./search').KINDS;
const MAX_CASE = 32 * 1024 * 1024;
const input = (v) => obj(v) && Object.keys(v).length <= 16 && Object.entries(v).every(([k, x]) => /^[a-z][a-zA-Z0-9_]{0,31}$/.test(k) && (str(4096)(x) || Number.isInteger(x)));
const secret = (v) => obj(v) && ((keysIn(v, ['passphrase']) && str(1024)(v.passphrase) && v.passphrase.length > 0) || (keysIn(v, ['phrase']) && str(400)(v.phrase) && v.phrase.length > 0));

const CALLS = {
  'gapp:status': [], 'gapp:install': [], 'gapp:uninstall': [],
  'gapp:signin.start': [], 'gapp:signin.open': [], 'gapp:signin.cancel': [], 'gapp:signout': [], 'gapp:entitlement.check': [], 'gapp:openApply': [],
  'gapp:terms.get': [], 'gapp:terms.accept': [(v) => obj(v) && keysIn(v, ['version', 'sha256', 'lawful']) && str(16)(v.version) && /^[a-f0-9]{64}$/.test(v.sha256 || '') && bool(v.lawful)],
  'gapp:vault.unlock': [secret],
  'gapp:cases.list': [], 'gapp:cases.get': [caseId], 'gapp:cases.put': [caseId, str(MAX_CASE)], 'gapp:cases.create': [str(200)], 'gapp:cases.delete': [caseId], 'gapp:cases.backups': [caseId], 'gapp:cases.restore': [caseId, str(120)],
  'gapp:prefs.get': [], 'gapp:prefs.set': [(v) => obj(v) && keysIn(v, ['skin', 'theme', 'deco']) && (v.skin === undefined || /^[a-z]{2,16}$/.test(v.skin)) && (v.theme === undefined || v.theme === 'dark' || v.theme === 'light') && (v.deco === undefined || bool(v.deco))],
  'gapp:connectors.list': [], 'gapp:connectors.get': [connId], 'gapp:connectors.requestApproval': [connId], 'gapp:connectors.test': [connId], 'gapp:connectors.enable': [connId], 'gapp:connectors.disable': [connId],
  'gapp:jobs.run': [(v) => obj(v) && keysIn(v, ['connector', 'input']) && connId(v.connector) && (v.input === undefined || input(v.input))],
  'gapp:jobs.get': [jobId], 'gapp:jobs.cancel': [jobId], 'gapp:pickFile': [],
  'gapp:scope.declare': [(v) => obj(v) && keysIn(v, ['target', 'basis', 'who', 'when', 'confirm']) && str(253)(v.target) && (v.basis === 'own' || v.basis === 'permission') && (v.who === undefined || str(200)(v.who)) && (v.when === undefined || str(100)(v.when)) && bool(v.confirm)],
  'gapp:scope.revoke': [scopeId], 'gapp:scope.active': [], 'gapp:scope.log': [(v) => Number.isInteger(v) && v > 0 && v <= 1000],
  'gapp:scan.run': [(v) => obj(v) && keysIn(v, ['connector', 'scopeId', 'input']) && connId(v.connector) && scopeId(v.scopeId) && (v.input === undefined || input(v.input))],
  'gapp:report.save': [(v) => obj(v) && keysIn(v, ['json', 'format', 'author', 'hide', 'notesTabs']) && str(MAX_CASE)(v.json) && ['html', 'pdf', 'json'].includes(v.format) && (v.author === undefined || str(120)(v.author)) && (v.hide === undefined || (Array.isArray(v.hide) && v.hide.length <= 5000 && v.hide.every(str(64)))) && (v.notesTabs === undefined || (Array.isArray(v.notesTabs) && v.notesTabs.length <= 40 && v.notesTabs.every(str(64))))],
  'gapp:cases.exportJson': [str(MAX_CASE)], 'gapp:cases.importPick': [],
  'gapp:terminal.open': [(v) => obj(v) && keysIn(v, ['caseId']) && (v.caseId === undefined || /^[A-Za-z0-9_-]{1,40}$/.test(v.caseId))], 'gapp:tools.open': [],
  'gapp:builtins.status': [],
  'gapp:search.classify': [(v) => obj(v) && keysIn(v, ['query']) && str(2000)(v.query)],
  'gapp:search.run': [(v) => obj(v) && keysIn(v, ['query', 'kind', 'tools', 'caseId']) && str(2000)(v.query) && v.query.trim().length > 0 && (v.kind === undefined || KINDS.includes(v.kind)) && (v.tools === undefined || (Array.isArray(v.tools) && v.tools.length >= 1 && v.tools.length <= 64 && v.tools.every(connId) && new Set(v.tools).size === v.tools.length)) && (v.caseId === undefined || caseId(v.caseId))],
  'gapp:search.cancel': [(v) => obj(v) && keysIn(v, ['searchId']) && searchId(v.searchId)],
  'gapp:window.fullscreen': [bool], 'gapp:window.close': [],
};
// the virtual computer's calls for "Add a tool" (src/main/ghost/vm/ipc.js)
const VMIPC = require('../vm/ipc');
for (const n of VMIPC.APP_OPS) CALLS['gapp:vm.' + n] = VMIPC.CALLS[n];
const EVENTS = ['gapp:status', 'gapp:install', 'gapp:job', 'gapp:window', 'gapp:builtins', 'gapp:search'];

function check(channel, args) {
  const spec = Object.prototype.hasOwnProperty.call(CALLS, channel) ? CALLS[channel] : null;
  if (!spec) return { ok: false, reason: 'unknown channel' };
  if (!Array.isArray(args) || args.length !== spec.length) return { ok: false, reason: 'wrong number of arguments' };
  for (let i = 0; i < spec.length; i++) if (!spec[i](args[i])) return { ok: false, reason: 'bad argument ' + (i + 1) };
  return { ok: true };
}
module.exports = { CALLS, EVENTS, check, MAX_CASE };
