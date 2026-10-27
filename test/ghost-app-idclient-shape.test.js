'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeEntitlement } = require('../src/main/ghost/app/id-client');

test('the Mayfair ID service answer (expires_at in ms, active_scanning / image_geolocation) is understood', () => {
  const now = Date.parse('2026-10-27T18:00:00Z');
  const e = normalizeEntitlement({ approved: true, operator: false, status: 'approved', expires_at: now + 86400000, modules: { active_scanning: false, image_geolocation: true }, cache_seconds: 60 }, { now });
  assert.equal(e.status, 'approved'); assert.equal(e.approved, true);
  assert.equal(e.modules.scanning, false); assert.equal(e.modules.geolocation, true);
  assert.equal(e.expiresAt, new Date(now + 86400000).toISOString());
});
test('expired by time, operator status, and draft', () => {
  const now = Date.parse('2026-10-27T18:00:00Z');
  assert.equal(normalizeEntitlement({ status: 'approved', expires_at: now - 1000 }, { now }).status, 'expired');
  const op = normalizeEntitlement({ status: 'operator' }, { now });
  assert.equal(op.approved, true); assert.equal(op.operator, true); assert.equal(op.modules.scanning, true); assert.equal(op.modules.geolocation, true);
  assert.equal(normalizeEntitlement({ status: 'draft' }, { now }).approved, false);
  assert.equal(normalizeEntitlement({ status: 'approved', modules: { active_scanning: true } }, { now }).modules.scanning, true);
});
test('a module is never on for an unapproved account', () => {
  const e = normalizeEntitlement({ status: 'pending', modules: { active_scanning: true, image_geolocation: true } });
  assert.equal(e.modules.scanning, false); assert.equal(e.modules.geolocation, false);
});
