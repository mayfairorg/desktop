'use strict';
// ArchiveBox (MIT) on the user's own instance: which saved copies of a page the user's own collection already holds. Ghost connects only
// to the instance address you enter; the program is not bundled and nothing is saved or changed in the collection (read only).
const { ModuleError, clip, isoDate } = require('./core');

const meta = {
  id: 'archivebox', tool: 'archivebox-api', name: 'ArchiveBox (your own instance)', version: '1.0.0',
  description: 'Lists the saved copies of a page in your own ArchiveBox collection (title, time saved, link to the copy). Read only.',
  capabilities: ['web-archive', 'archivebox', 'own-instance', 'passive'], scope: 'passive', network: 'keyless-external',
  hosts: [], ownInstance: true, client: { rps: 4, maxRequests: 3, timeoutMs: 20000, maxBytes: 2097152 },
  restrictions: 'Connects only to the instance address you enter: https, or http on this computer or your own network. Link-local addresses are refused. An API token, if your instance needs one, is sent only to that instance. Nothing is archived or changed: it only reads the list. The ArchiveBox program is separate and is not installed by Ghost.',
  licence: { spdx: 'MIT', url: 'https://github.com/ArchiveBox/ArchiveBox/blob/dev/LICENSE' },
  inputs: [
    { name: 'instance', type: 'string', label: 'Your ArchiveBox address', required: false, maxLength: 300, pattern: '^https?://[A-Za-z0-9.:\\[\\]_-]+/?$' },
    { name: 'url', type: 'string', label: 'Page address to look for', required: false, maxLength: 1000 },
    { name: 'token', type: 'string', label: 'API token (if needed)', required: false, sensitive: true, maxLength: 200, pattern: '^[A-Za-z0-9._-]+$' },
    { name: 'check', type: 'enum', label: 'Self-check', required: false, values: ['parser'] },
  ],
  files: ['core.js', 'runtime.js'],
  // the instance is the user's own and differs per run, so the self-test checks the reader on a built-in sample; reaching an instance is proven by the first real run
  selfTest: { input: { check: 'parser' }, expect: { minResults: 1, contains: [{ type: 'document', value: 'ArchiveBox reader ready' }] } },
};
// one snapshot record -> {href, title, savedAt, id, ts} or null
function snap(it) {
  let u; try { u = new URL(it && it.url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const ts = typeof it.timestamp === 'string' || typeof it.timestamp === 'number' ? String(it.timestamp) : null;
  const savedAt = isoDate(it.bookmarked_at || it.created_at || (ts && Number(ts) > 1e8 ? new Date(Number(ts) * 1000).toISOString() : '')) || undefined;
  return { href: u.href, title: it.title ? clip(String(it.title), 200) : undefined, savedAt, id: it.id ? clip(String(it.id), 60) : undefined, ts: ts && /^[0-9.]+$/.test(ts) ? ts : null };
}
const SAMPLE = [{ id: 'sample-1', url: 'https://example.com/page', title: 'Sample', timestamp: '1700000000.1', bookmarked_at: '2023-11-14T22:13:20Z' }, { url: 'javascript:alert(1)' }];

async function run(ctx, input) {
  if (input.check === 'parser') {
    const ok = SAMPLE.map(snap).filter(Boolean);
    if (ok.length !== 1 || ok[0].href !== 'https://example.com/page' || ok[0].savedAt !== '2023-11-14T22:13:20.000Z') throw new Error('the built-in ArchiveBox reader self-check failed');
    ctx.emit({ type: 'document', value: 'ArchiveBox reader ready', raw: { selfCheck: true, note: 'built-in sample; no instance was contacted' } });
    return;
  }
  if (!input.instance || !input.url) throw new ModuleError('bad-input', 'enter your ArchiveBox address and the page address to look for');
  const origin = ctx.client.allowOwn(input.instance);
  const pageUrl = String(input.url).trim();
  try { const u = new URL(pageUrl); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw new ModuleError('bad-input', 'enter a page address starting with http:// or https://'); }
  const headers = input.token ? { 'x-archivebox-api-key': input.token } : {};
  const res = await ctx.client.get(`${origin}/api/v1/core/snapshots?url=${encodeURIComponent(pageUrl)}&limit=50`, { headers, purpose: 'archivebox-list' });
  if (res.status === 404) throw new ModuleError('unavailable', 'this address does not look like an ArchiveBox with the API switched on');
  const doc = res.json();
  const items = Array.isArray(doc) ? doc : doc && Array.isArray(doc.items) ? doc.items : null;
  if (!items) throw new ModuleError('bad-response', 'the instance answered in a shape that is not the ArchiveBox snapshot list');
  if (!items.length) { ctx.note('your collection holds no saved copy of this address'); return; }
  for (const it of items.slice(0, 50)) {
    const s = snap(it); if (!s) continue;
    ctx.emit({ type: 'url', value: s.href, confidence: 'confirmed', url: s.ts ? `${origin}/archive/${s.ts}/index.html` : origin, raw: { rel: 'saved-copy', title: s.title, savedAt: s.savedAt, snapshotId: s.id } });
  }
}
module.exports = { meta, run, snap };
