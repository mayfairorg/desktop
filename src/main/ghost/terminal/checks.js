'use strict';
// Ghost terminal: which calls the terminal window may make, and what shape their arguments must have.
// These channels belong to the terminal window only. They are registered by window.js and are NOT part of the Browser bridge
// (src/main/lib/ipc-allowlist.js): the Mayfair Cloud page has no way to reach any of them.
const id = (v) => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v);
const int = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;

const M = require('../manifest');
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keysIn = (v, ok) => Object.keys(v).every((k) => ok.includes(k));
const token = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);
const toolId = (v) => typeof v === 'string' && M.ID_RE.test(v);
const jobId = (v) => typeof v === 'string' && /^j-[a-z0-9]{1,12}-[a-f0-9]{8}$/.test(v);
const str = (n) => (v) => typeof v === 'string' && v.length <= n && !v.includes('\0');
const FORM_KEYS = ['name', 'description', 'runtime', 'scope', 'network', 'licence', 'restrictions', 'inputLabel', 'args', 'selfTestInput', 'timeoutSec'];
const form = (v) => obj(v) && keysIn(v, FORM_KEYS) && ['name', 'description', 'restrictions', 'inputLabel', 'selfTestInput', 'licence', 'runtime', 'scope', 'network'].every((k) => v[k] === undefined || str(1000)(v[k])) &&
  (v.args === undefined || (Array.isArray(v.args) && v.args.length <= 16 && v.args.every(str(400)))) && (v.timeoutSec === undefined || (typeof v.timeoutSec === 'number' && v.timeoutSec > 0 && v.timeoutSec <= 600));
const inputObj = (v) => obj(v) && Object.keys(v).length <= 16 && Object.entries(v).every(([k, x]) => /^[a-z][a-zA-Z0-9_]{0,31}$/.test(k) && (typeof x === 'number' || str(4096)(x)));
const scopeObj = (v) => obj(v) && keysIn(v, ['target', 'confirmedAuthorised']) && str(253)(v.target) && v.confirmedAuthorised === true;

const CALLS = {
  'gterm:tools.list': [],
  'gterm:tools.addFolder': [],
  'gterm:tools.addZip': [],
  'gterm:tools.addScript': [form],
  'gterm:tools.addGithub': [(v) => obj(v) && keysIn(v, ['url', 'ref']) && str(300)(v.url) && (v.ref === undefined || str(200)(v.ref))],
  'gterm:tools.commit': [token],
  'gterm:tools.cancel': [token],
  'gterm:tools.approve': [toolId],
  'gterm:tools.test': [toolId],
  'gterm:tools.enable': [toolId],
  'gterm:tools.disable': [toolId],
  'gterm:tools.remove': [toolId],
  'gterm:tools.run': [(v) => obj(v) && keysIn(v, ['id', 'input', 'scope']) && toolId(v.id) && (v.input === undefined || inputObj(v.input)) && (v.scope === undefined || scopeObj(v.scope))],
  'gterm:tools.job': [jobId],
  'gterm:tools.cancelJob': [jobId],
  'gterm:info': [],
  'gterm:open': [(v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => k === 'cols' || k === 'rows') && int(10, 500)(v.cols) && int(2, 200)(v.rows)],
  'gterm:input': [id, (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 * 1024],
  'gterm:resize': [id, int(10, 500), int(2, 200)],
  'gterm:interrupt': [id],
  'gterm:close': [id],
  'gterm:ack': [id, int(0, 1 << 30)],
  'gterm:openTools': [],
};
const EVENTS = ['gterm:data', 'gterm:exit', 'gterm:job'];

function check(channel, args) {
  const spec = Object.prototype.hasOwnProperty.call(CALLS, channel) ? CALLS[channel] : null;
  if (!spec) return { ok: false, reason: 'unknown channel' };
  if (!Array.isArray(args) || args.length !== spec.length) return { ok: false, reason: 'wrong number of arguments' };
  for (let i = 0; i < spec.length; i++) if (!spec[i](args[i])) return { ok: false, reason: 'bad argument ' + (i + 1) };
  return { ok: true };
}

module.exports = { CALLS, EVENTS, check };
