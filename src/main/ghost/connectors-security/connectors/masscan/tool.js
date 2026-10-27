'use strict';
// Masscan (AGPL-3.0, separate program only, never bundled): ACTIVE. One IPv4 address, at most 100 ports, rate capped at 100 packets/s.
// Needs raw sockets. Ghost never asks for administrator rights; if the OS does not already allow raw sockets the run fails and says so.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'masscan', tool: 'masscan', version: '1.0.0', scope: 'active', timeoutMs: 300000, versionArgs: ['--version'], versionRe: /Masscan version (\d+\.\d+(?:\.\d+)?)/i, versionNonzeroOk: true };

function expandPorts(s) {
  if (!/^\d{1,5}(?:[,-]\d{1,5})*$/.test(s)) throw new common.UsageError('ports must look like 80,443 or 1-100');
  let n = 0;
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(Number);
    const hi = b === undefined ? a : b;
    if (a < 1 || hi > 65535 || hi < a) throw new common.UsageError('ports must be between 1 and 65535');
    n += hi - a + 1;
  }
  if (n > 100) throw new common.UsageError('at most 100 ports per run');
  return n;
}
function normalizeInput(a) {
  const ports = String(a.ports === undefined ? '22,80,443' : a.ports);
  expandPorts(ports);
  const rate = common.intArg(a.rate, 'rate', 1, 100, 25);
  return { ports, rate };
}
async function buildArgs(input, ctx) {
  const r = await ctx.resolveTarget(input.target);
  if (!r.v4) throw new common.ToolError(`${input.target} has no IPv4 address; Masscan here scans IPv4 only`);
  const out = path.join(ctx.runDir, 'masscan.lst');
  return {
    argv: ['-p', input.ports, '--rate', String(input.rate), '--wait', '5', '-oL', out, r.v4],
    pinned: r,
    collect: async (res) => {
      const err = res.stderr || '';
      if (/permission denied|operation not permitted|must be root|requires? (root|administrator)|libpcap|npcap|failed to detect|FAIL:/i.test(err) && res.code !== 0) throw new common.ToolError('Masscan needs raw sockets, which this account does not have. Mayfair Ghost never asks for administrator rights, so this tool is unavailable here.', 6);
      try { return fs.readFileSync(out, 'utf8'); } catch { return ''; }
    },
  };
}
// raw: the -oL list: "#masscan", "open tcp 80 93.184.216.34 1700000000", "# end"
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const out = []; let bad = 0; let ended = false;
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) { if (/^#\s*end/i.test(t)) ended = true; continue; }
    const m = /^open (tcp|udp|sctp) (\d{1,5}) (\d{1,3}(?:\.\d{1,3}){3}) (\d+)$/.exec(t);
    if (!m) { bad++; continue; }
    out.push(mk('open-port', `${m[3]}:${m[2]}/${m[1]}`, { observedAt: common.isoTs(m[4]) || undefined, raw: { via: 'syn-ack' } }));
  }
  if (!out.length) out.push(mk('no-open-ports', 'no open ports found in the scanned set', { confidence: 'uncertain', note: 'At a capped, slow rate and with a short wait, replies can be lost; absence of an answer is not proof of closed ports.' }));
  if (raw && !ended && out.length) out.push(mk('scan-incomplete', 'the list has no "# end" line', { confidence: 'uncertain', note: 'Masscan did not write its end marker, so the list may be cut short.' }));
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse, expandPorts };
