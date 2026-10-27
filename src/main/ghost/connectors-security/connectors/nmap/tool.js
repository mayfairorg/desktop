'use strict';
// Nmap (Nmap Public Source License): ACTIVE. Never bundled or redistributed by Mayfair: the user installs or downloads it separately.
// Connect scan only (-sT, no raw sockets, no elevation), no NSE scripts, no brute force, no exploit or intrusive categories.
// The target is resolved once and the pinned address is what Nmap is given. Flags follow the Nmap manual; not run against a live binary here.
const common = require('./common');
const SPEC = { id: 'nmap', tool: 'nmap', version: '1.0.0', scope: 'active', timeoutMs: 570000, versionArgs: ['--version'], versionRe: /Nmap version (\d+\.\d+[\w.]*)/ };
const PRESETS = {
  gentle: ['-sT', '-Pn', '-n', '--top-ports', '100', '-T2', '--max-retries', '1', '--max-rate', '50', '--host-timeout', '8m', '--reason'],
  normal: ['-sT', '-Pn', '-n', '--top-ports', '1000', '-T3', '--max-retries', '1', '--max-rate', '200', '--host-timeout', '9m', '-sV', '--version-light', '--reason'],
};

function normalizeInput(a) {
  const preset = a.preset === undefined ? 'gentle' : String(a.preset);
  if (!PRESETS[preset]) throw new common.UsageError('preset must be gentle or normal');
  return { preset };
}
async function buildArgs(input, ctx) {
  const r = await ctx.resolveTarget(input.target);
  if (!r.v4) throw new common.ToolError(`${input.target} has no IPv4 address; this connector scans IPv4 only`);
  return {
    argv: [...PRESETS[input.preset], '-oX', '-', '--', r.v4],
    pinned: r, host: input.target,
    // the pinned address must still be one of the target's addresses when the scan ends
    collect: async (res) => {
      if (!input.target || common.isIPv4(input.target)) return res.stdout;
      let again = null; try { again = await ctx.resolveTarget(input.target); } catch { /* unreachable now */ }
      r.changed = !!(again && !again.addresses.includes(r.v4));
      return res.stdout;
    },
  };
}

// ---- a small XML reader: elements, attributes, text. No DTD, no entity definitions (so no entity expansion), depth and size limits.
function decode(s) { return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => { const l = e.toLowerCase(); if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'amp') return '&'; if (l === 'quot') return '"'; if (l === 'apos') return "'"; const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }); }
function parseXml(text) {
  if (text.length > 16 * 1024 * 1024) throw new Error('xml too large');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[6] !== undefined) { stack[stack.length - 1].text += decode(m[6]); continue; }
    if (m[1] !== undefined) { stack[stack.length - 1].text += m[1]; continue; }
    if (m[3] === undefined) continue;
    if (m[2]) { if (stack.length > 1 && stack[stack.length - 1].name === m[3]) stack.pop(); else throw new Error('mismatched xml tag'); continue; }
    const attrs = {};
    for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] !== undefined ? a[2] : a[3]);
    const el = { name: m[3], attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(el);
    if (!m[5]) { stack.push(el); if (stack.length > 60) throw new Error('xml too deep'); }
  }
  if (stack.length !== 1) throw new Error('xml is not complete');
  return root;
}
const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name);

// raw: Nmap XML (-oX -).
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  let doc;
  try { doc = parseXml(String(raw)); } catch (e) { throw new common.ToolError('Nmap output was not complete XML (' + e.message + ')'); }
  const run = kid(doc, 'nmaprun');
  if (!run) throw new common.ToolError('Nmap output has no <nmaprun> element');
  const out = [];
  const ver = run.attrs.version;
  for (const host of kids(run, 'host')) {
    const addr = (kids(host, 'address').find((a) => a.attrs.addrtype === 'ipv4') || kid(host, 'address'));
    if (!addr || !addr.attrs.addr) continue;
    const ip = addr.attrs.addr;
    const at = common.isoTs(host.attrs.endtime) || undefined;
    const st = kid(host, 'status');
    const names = kid(host, 'hostnames') ? kids(kid(host, 'hostnames'), 'hostname').map((h) => h.attrs.name).filter(Boolean).slice(0, 5) : [];
    const o = (extra = {}) => ({ version: ver, observedAt: at, ...extra });
    if (st && st.attrs.state === 'up' && st.attrs.reason !== 'user-set') out.push(mk('host-up', ip, o({ raw: { reason: st.attrs.reason, hostnames: names } })));
    const ports = kid(host, 'ports');
    let open = 0;
    if (ports) {
      for (const ex of kids(ports, 'extraports')) {
        const reasons = kids(ex, 'extrareasons').map((r) => r.attrs.reason).filter(Boolean).join(',');
        out.push(mk('port-summary', `${ip}: ${ex.attrs.count} ${ex.attrs.state}${reasons ? ' (' + reasons + ')' : ''}`, o()));
      }
      for (const p of kids(ports, 'port')) {
        const state = kid(p, 'state');
        if (!state) continue;
        const id = `${ip}:${p.attrs.portid}/${p.attrs.protocol}`;
        if (state.attrs.state !== 'open') { out.push(mk('port-state', `${id} ${state.attrs.state}`, o({ confidence: 'uncertain', note: state.attrs.state === 'filtered' ? 'No answer or an unreachable reply: a firewall may be dropping probes, so the port may still be open.' : `State "${state.attrs.state}" is how this one probe was answered.`, raw: { reason: state.attrs.reason } }))); continue; }
        open++;
        const svc = kid(p, 'service');
        out.push(mk('open-port', id, o({ raw: { reason: state.attrs.reason, ...(svc && svc.attrs.name ? { service: svc.attrs.name } : {}) } })));
        if (svc && svc.attrs.name) {
          const label = [svc.attrs.name, svc.attrs.product, svc.attrs.version].filter(Boolean).join(' ');
          const conf = Number(svc.attrs.conf);
          if (svc.attrs.method === 'probed' && conf >= 8) out.push(mk('service', `${id} ${label}`, o({ confidence: 'likely', note: `Identified by probing the service (Nmap confidence ${conf}/10); product and version can be disguised by the server.`, raw: { method: 'probed', conf } })));
          else out.push(mk('service', `${id} ${label}`, o({ confidence: 'uncertain', note: svc.attrs.method === 'table' ? 'Service name comes from the port-number table, not from talking to the service.' : `Nmap rates its own identification ${Number.isFinite(conf) ? conf + '/10' : 'low'}.`, raw: { method: svc.attrs.method, conf: Number.isFinite(conf) ? conf : undefined } })));
        }
      }
    }
    if (!open) out.push(mk('no-open-ports', `${ip}: no open ports found in the scanned set`, o({ confidence: 'uncertain', note: 'Closed or filtered ports do not prove the host is absent or unprotected; firewalls can drop probes.' })));
  }
  const fin = kid(kid(run, 'runstats') || { children: [] }, 'finished');
  if (fin && fin.attrs.summary) out.push(mk('scan-summary', fin.attrs.summary.slice(0, 500), { version: ver, observedAt: common.isoTs(fin.attrs.time) || undefined, raw: { args: String(run.attrs.args || '').slice(0, 300) } }));
  if (opts.plan && opts.plan.pinned && opts.plan.pinned.changed) out.push(mk('target-resolution-changed', `${opts.input.target} no longer resolves to ${opts.plan.pinned.v4}`, { confidence: 'uncertain', note: 'The address that was scanned is not one the host name resolves to at the end of the scan; treat these results as belonging to the pinned address only.' }));
  return out;
}
module.exports = { SPEC, PRESETS, normalizeInput, buildArgs, parse, parseXml };
