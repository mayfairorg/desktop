'use strict';
// Quick notes: which calls the Ghost window and the pop-out notes window may make, and what shape their arguments must have.
// These channels (gqn:*) belong to those two windows only; notes-host.js checks the sender, the frame and the page address before this check runs.
const QN = require('../../../ui/ghost/qn-model');
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keysIn = (v, ok) => Object.keys(v).every((k) => ok.includes(k));
const str = (n) => (v) => typeof v === 'string' && v.length <= n && !v.includes('\0');
const bool = (v) => typeof v === 'boolean';
const scope = (v) => typeof v === 'string' && /^(inbox|[A-Za-z0-9_-]{8,64})$/.test(v);
const blobId = (v) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
const bytes = (v) => ArrayBuffer.isView(v) && v.byteLength > 0 && v.byteLength <= QN.LIMITS.blobBytes;
const sourceId = (v) => typeof v === 'string' && /^[A-Za-z0-9:_\-.]{1,120}$/.test(v);
const caseOrNull = (v) => v === null || scope(v);
const hint = (v) => obj(v) && keysIn(v, ['kind', 'label']) && ['ghost-app', 'tool'].includes(v.kind) && str(200)(v.label);
const clipPayload = (v) => obj(v) && keysIn(v, ['scope', 'clip']) && scope(v.scope) && obj(v.clip) && (() => { try { return JSON.stringify(v.clip).length <= 400000; } catch { return false; } })();
const sent = (v) => obj(v) && keysIn(v, ['clipId', 'entityId', 'label', 'caseId']) && str(60)(v.clipId) && str(80)(v.entityId || '') && str(200)(v.label || '') && str(80)(v.caseId || '');

const CALLS = {
  'gqn:get': [scope], 'gqn:put': [scope, str(QN.LIMITS.docBytes)],
  'gqn:blob.put': [scope, bytes], 'gqn:blob.get': [scope, blobId], 'gqn:blob.save': [scope, blobId, str(160)],
  'gqn:cases': [], 'gqn:clipboard': [scope], 'gqn:hint': [], 'gqn:copied': [hint],
  'gqn:capture.browser': [scope, caseOrNull], 'gqn:capture.sources': [], 'gqn:capture.take': [scope, sourceId],
  'gqn:popout.open': [(v) => obj(v) && keysIn(v, ['scope', 'theme']) && scope(v.scope) && ['dark', 'light'].includes(v.theme)], 'gqn:popout.close': [], 'gqn:popout.info': [], 'gqn:popout.top': [bool],
  'gqn:send': [clipPayload], 'gqn:sent': [sent],
};
const EVENTS = ['gqn:popped', 'gqn:send', 'gqn:sent'];

function check(channel, args) {
  const spec = Object.prototype.hasOwnProperty.call(CALLS, channel) ? CALLS[channel] : null;
  if (!spec) return { ok: false, reason: 'unknown channel' };
  if (!Array.isArray(args) || args.length !== spec.length) return { ok: false, reason: 'wrong number of arguments' };
  for (let i = 0; i < spec.length; i++) if (!spec[i](args[i])) return { ok: false, reason: 'bad argument ' + (i + 1) };
  return { ok: true };
}
module.exports = { CALLS, EVENTS, check };
