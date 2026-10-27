'use strict';
// Ghost investigation browser: how traffic leaves this computer (pure).
//  tor        SOCKS5 to the Tor program Ghost starts for itself. The proxy scheme is socks5 (not socks5-local), so the browser sends the
//             host NAME to Tor and Tor resolves it at the exit: the computer's own resolver is never asked. If Tor stops, requests fail.
//  direct-doh The person's own connection, with every lookup sent encrypted to one DNS-over-HTTPS server and no fallback to the system
//             resolver. The sites see the real IP address. Needs an explicit choice.
const PV = require('../../lib/privacy');

const MODES = ['tor', 'direct-doh'];

function plan({ mode, socksPort = 0, provider = 'cloudflare' }) {
  if (mode === 'tor') {
    if (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535) throw new Error('Tor is not connected.');
    return {
      mode, proxy: { mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:' + socksPort, proxyBypassRules: '<-loopback>' },
      resolver: null,   // nothing to configure: the proxy does the lookup
      dnsLabel: 'Tor (resolved at the exit)', routeLabel: 'Tor', exposesIp: false,
    };
  }
  if (mode === 'direct-doh') {
    const p = PV.DNS_PROVIDERS[provider] || PV.DNS_PROVIDERS.cloudflare;
    return { mode, proxy: { mode: 'direct' }, resolver: { enableBuiltInResolver: true, secureDnsMode: 'secure', secureDnsServers: [p.url] }, dnsLabel: 'DNS over HTTPS (' + p.name + ')', routeLabel: 'Direct', exposesIp: true };
  }
  throw new Error('Unknown route.');
}

// Applies a plan to a session and checks it took. Throws (so the window is not opened) when the check fails.
async function apply({ session, app, plan: p, previousResolver = null }) {
  await session.setProxy(p.proxy);
  if (typeof session.closeAllConnections === 'function') await session.closeAllConnections();
  if (p.mode === 'direct-doh') {
    // The host resolver is shared by the whole app (Chromium has no per-session switch for it), so Ghost sets it for the length of the
    // direct case and puts the previous setting back afterwards.
    app.configureHostResolver(p.resolver);
  }
  const seen = await session.resolveProxy('https://check.invalid/');
  if (p.mode === 'tor' && !/^SOCKS5 127\.0\.0\.1:\d+$/.test(String(seen).trim())) throw new Error('The Tor route did not apply, so the window was not opened.');
  if (p.mode === 'direct-doh' && !/^DIRECT/.test(String(seen).trim())) throw new Error('An unexpected proxy is set, so the window was not opened.');
  return { proxySeen: String(seen).trim(), previousResolver };
}

// Status shown in the chip.
function chip({ plan: p, tor, caseName }) {
  const torState = tor ? tor.status : 'off';
  if (!p) return { route: 'none', dns: 'none', tone: 'idle', text: 'No route · ' + (caseName || 'no case'), case: caseName || '', tor: torState };
  const down = p.mode === 'tor' && torState !== 'ready';
  return { route: p.routeLabel.toLowerCase(), dns: p.mode === 'tor' ? 'tor' : 'doh', tone: down ? 'bad' : p.mode === 'tor' ? 'ok' : 'warn', text: (down ? 'Tor down, requests blocked' : p.routeLabel) + ' · ' + p.dnsLabel + ' · ' + (caseName || 'no case'), case: caseName || '', tor: torState, exposesIp: p.exposesIp };
}

module.exports = { plan, apply, chip, MODES };
