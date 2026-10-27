'use strict';
// Ghost investigation browser: which calls the two Ghost browser pages may make, and what their arguments must look like.
// These channels belong to these windows only; they are not part of the Browser bridge, so Mayfair Cloud pages cannot reach them.
const { CASE_ID } = require('./policy');
const str = (n) => (v) => typeof v === 'string' && v.length <= n && !v.includes('\0');
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keysIn = (v, ok) => Object.keys(v).every((k) => ok.includes(k));

const launch = (v) => obj(v) && keysIn(v, ['caseId', 'name', 'url', 'route', 'module', 'directConfirmed']) && typeof v.caseId === 'string' && CASE_ID.test(v.caseId) &&
  (v.name === undefined || str(80)(v.name)) && (v.url === undefined || str(2048)(v.url)) && (v.route === undefined || v.route === 'tor' || v.route === 'direct-doh') &&
  (v.module === undefined || /^[a-z0-9][a-z0-9-]{0,39}$/.test(v.module)) && (v.directConfirmed === undefined || v.directConfirmed === true);

// role: 'launcher' (the control window) or 'case' (a case window's own toolbar page).
const CALLS = {
  'gbr:launcher.open': { role: 'launcher', args: [launch] },
  'gbr:launcher.cases': { role: 'launcher', args: [] },
  'gbr:launcher.tor': { role: 'launcher', args: [] },
  'gbr:case.info': { role: 'case', args: [] },
  'gbr:case.navigate': { role: 'case', args: [(v) => str(2048)(v) && v.length > 0] },
  'gbr:case.back': { role: 'case', args: [] },
  'gbr:case.forward': { role: 'case', args: [] },
  'gbr:case.reload': { role: 'case', args: [] },
  'gbr:case.stop': { role: 'case', args: [] },
  'gbr:case.allowHost': { role: 'case', args: [(v) => str(253)(v) && v.length > 0] },
  'gbr:case.capture': { role: 'case', args: [] },
  'gbr:case.snapshots': { role: 'case', args: [] },
  'gbr:case.panel': { role: 'case', args: [(v) => Number.isInteger(v) && v >= 0 && v <= 260] },
  'gbr:case.close': { role: 'case', args: [] },
  'gbr:kill': { role: 'any', args: [] },
};
const EVENTS = ['gbr:state', 'gbr:killed'];

function check(channel, role, args) {
  const c = CALLS[channel];
  if (!c) return { ok: false, reason: 'unknown call' };
  if (c.role !== 'any' && c.role !== role) return { ok: false, reason: 'not for this window' };
  if (args.length !== c.args.length) return { ok: false, reason: 'wrong number of arguments' };
  for (let i = 0; i < c.args.length; i++) if (!c.args[i](args[i])) return { ok: false, reason: 'bad argument ' + (i + 1) };
  return { ok: true };
}
module.exports = { check, CALLS, EVENTS };
