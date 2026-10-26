'use strict';
// Privacy settings logic (pure). Honest scope:
//  - Secure DNS encrypts name lookups. It is NOT a VPN and does not hide your IP address.
//  - Only the Tor tab or a proxy you supply changes the address websites see.
const DNS_PROVIDERS = Object.freeze({
  cloudflare: { name: 'Cloudflare (1.1.1.1)', url: 'https://cloudflare-dns.com/dns-query' },
  quad9: { name: 'Quad9 (9.9.9.9)', url: 'https://dns.quad9.net/dns-query' },
});
const WEBRTC = Object.freeze({
  off: 'default',
  public: 'default_public_interface_only',
  strict: 'disable_non_proxied_udp',
});
const PROXY_MODES = ['off', 'http', 'socks5'];

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:]+\])$/i;
const isHost = (h) => typeof h === 'string' && h.length > 0 && h.length <= 253 && HOST.test(h);
const isPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// -> { ok, error?, config? } ; config is what Electron's session.setProxy wants.
function proxyConfig(mode, host, port) {
  if (mode === 'off' || mode === undefined) return { ok: true, config: { mode: 'direct' } };
  if (!PROXY_MODES.includes(mode)) return { ok: false, error: 'Pick HTTP or SOCKS5.' };
  if (!isHost(host)) return { ok: false, error: 'Enter a host name or IP address only, without http:// or a path.' };
  if (!isPort(port)) return { ok: false, error: 'Port must be a number from 1 to 65535.' };
  const scheme = mode === 'socks5' ? 'socks5' : 'http';
  // '<-loopback>' also sends localhost through the proxy, so nothing silently skips it
  return { ok: true, config: { mode: 'fixed_servers', proxyRules: `${scheme}://${host}:${port}`, proxyBypassRules: '<-loopback>' } };
}

function dohConfig(enabled, provider) {
  const p = DNS_PROVIDERS[provider] || DNS_PROVIDERS.cloudflare;
  return enabled ? { secureDnsMode: 'secure', secureDnsServers: [p.url] } : { secureDnsMode: 'automatic', secureDnsServers: [] };
}

// Chromium feature list. ECH only works through secure DNS, so it is on only with it.
function featureSwitches({ secureDns, ech }) {
  const enable = ['DnsOverHttps'];
  if (secureDns && ech) enable.push('EncryptedClientHello');
  const disable = ['Translate', 'MediaRouter', 'OptimizationHints', 'InterestFeedContentSuggestions'];
  if (!(secureDns && ech)) disable.push('EncryptedClientHello');
  return { enable: enable.join(','), disable: disable.join(',') };
}

// Which WebRTC policy a tab gets. Tor tabs are always strict. Mayfair and Web apps are exempt
// so video calls keep working; ordinary and private browser tabs follow the setting.
function webrtcPolicy(kind, setting) {
  if (kind === 'tor') return WEBRTC.strict;
  if (kind === 'home' || kind === 'app') return WEBRTC.off;
  return WEBRTC[setting] || WEBRTC.strict;
}

// Standard locale and reduced fingerprint: what a tab gets, by kind.
function tabPrivacy(kind, s) {
  const tor = kind === 'tor';
  const web = kind === 'browse' || kind === 'private';
  return {
    standardLocale: tor || (web && !!s.standardLocale),
    reduceFingerprint: tor || (web && !!s.reduceFingerprint),
    webrtc: webrtcPolicy(kind, s.webrtc),
  };
}

const STD = { timezone: 'UTC', locale: 'en-US', languages: ['en-US', 'en'], acceptLanguages: 'en-US,en;q=0.9' };

// Script run before any page script in tabs with reduced fingerprinting. It only narrows values
// the page can read; it does not touch Mayfair, Web apps or any page's own code.
function fingerprintScript() {
  return `(()=>{try{const d=(o,k,v)=>Object.defineProperty(o,k,{get:()=>v,configurable:true});
d(Navigator.prototype,'hardwareConcurrency',4);d(Navigator.prototype,'deviceMemory',8);
d(Navigator.prototype,'languages',Object.freeze(['en-US','en']));d(Navigator.prototype,'language','en-US');
if(navigator.getBattery)d(Navigator.prototype,'getBattery',undefined);
if(navigator.connection)d(Navigator.prototype,'connection',undefined);
}catch(e){}})();`;
}

const PRIVACY_DEFAULTS = Object.freeze({ secureDns: false, dnsProvider: 'cloudflare', ech: true, webrtc: 'strict', standardLocale: false, reduceFingerprint: true, proxyMode: 'off', proxyHost: '', proxyPort: 0 });

const NOTES = Object.freeze({
  dns: 'Secure DNS encrypts the lookup that turns a site name into an address. It is not a VPN and does not hide your IP address. Websites and your network still see where you connect.',
  tor: 'The Tor tab sends traffic through the Tor network, so sites see a Tor exit address, not yours. It is slow, and some sites block Tor. Nothing is saved when you close it. This is not Tor Browser and it hides less than Tor Browser does.',
  rules: 'Using Tor, a proxy or secure DNS to get around the rules of your school or workplace network can break those rules. Check you are allowed before you use them.',
  fp: 'Reduced fingerprinting narrows some details sites can read. It lowers tracking but does not make you anonymous.',
});

module.exports = { DNS_PROVIDERS, WEBRTC, PROXY_MODES, PRIVACY_DEFAULTS, STD, NOTES, isHost, isPort, proxyConfig, dohConfig, featureSwitches, webrtcPolicy, tabPrivacy, fingerprintScript };
