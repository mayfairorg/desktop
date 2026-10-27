'use strict';
// Shared by the ghost-browser*.test.js files: stand-ins for Electron sessions, Tor, windows and the vault. No network is ever touched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vault } = require('../src/main/ghost/vault/vault');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-gbr-'));
const fakeOS = () => ({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('OS:' + Buffer.from(s).toString('hex')), decryptString: (b) => Buffer.from(b.toString().slice(3), 'hex').toString() });
const mkVault = (dir = path.join(tmp(), 'vault')) => { const v = new Vault({ dir, safeStorage: fakeOS(), kdfParams: { m: 64, t: 1, p: 1 }, allowWeakKdf: true, syncDebounceMs: 5 }); v.open(); return v; };
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

class FakeSession {
  constructor(name, opts) {
    this.name = name; this.opts = opts; this.proxy = null; this.calls = []; this.handlers = {}; this.ua = null;
    this.webRequest = { onBeforeRequest: (f, fn) => { this.handlers.before = fn; this.filter = f; }, onBeforeSendHeaders: (f, fn) => { this.handlers.headers = fn; } };
  }
  async setProxy(p) { this.proxy = p; this.calls.push('setProxy'); }
  async resolveProxy() { const p = this.proxy; return p && p.mode === 'fixed_servers' ? 'SOCKS5 ' + p.proxyRules.replace(/^socks5:\/\//, '') : 'DIRECT'; }
  setUserAgent(ua, lang) { this.ua = [ua, lang]; }
  setPermissionRequestHandler(f) { this.handlers.perm = f; } setPermissionCheckHandler(f) { this.handlers.check = f; } setDevicePermissionHandler(f) { this.handlers.device = f; }
  setSpellCheckerEnabled(b) { this.spell = b; }
  on(ev, f) { this.handlers[ev] = f; }
  async clearStorageData() { this.calls.push('clearStorageData'); } async clearCache() { this.calls.push('clearCache'); }
  async clearAuthCache() { this.calls.push('clearAuthCache'); } async clearHostResolverCache() { this.calls.push('clearHostResolverCache'); }
  async closeAllConnections() { this.calls.push('closeAllConnections'); }
  request(url, type = 'mainFrame') { let out; this.handlers.before({ url, resourceType: type }, (r) => { out = r; }); return out; }
  headers(h) { let out; this.handlers.headers({ requestHeaders: h }, (r) => { out = r.requestHeaders; }); return out; }
}
function fakeElectron() {
  const sessions = new Map(); const resolver = [];
  return { sessions, resolver, app: { configureHostResolver: (c) => resolver.push(c) }, session: { fromPartition: (n, o) => { if (!sessions.has(n)) sessions.set(n, new FakeSession(n, o)); return sessions.get(n); } } };
}
class FakeTor extends EventEmitter {
  constructor({ fail = false, port = 41234 } = {}) { super(); this.fail = fail; this.port = port; this.state = { status: 'off', progress: 0, error: '', socksPort: 0 }; this.starts = 0; this.stops = 0; this.binary = '/x/tor'; }
  get ready() { return this.state.status === 'ready'; }
  async start() { this.starts++; if (this.fail) { this.state = { status: 'error', progress: 0, error: 'Tor did not connect', socksPort: 0 }; throw new Error('Tor did not connect'); } this.state = { status: 'ready', progress: 100, error: '', socksPort: this.port }; this.emit('state', this.state); return this.port; }
  stop() { this.stops++; this.state = { status: 'off', progress: 0, error: '', socksPort: 0 }; this.emit('state', this.state); }
}
// A stand-in for the window handle the service gets from window.js.
function fakeHandleFactory(log) {
  return (rec, hooks) => {
    const h = {
      rec, hooks, closed: false, loads: [], url: 'https://example.org/a?token=SECRET', title: 'Example page', focusCount: 0, cmds: [],
      sent: [],
      wc: {
        getURL: () => h.url, getTitle: () => h.title,
        debugger: { sendCommand: async (m) => (m === 'DOM.getDocument' ? { root: { nodeId: 1 } } : { outerHTML: '<html><body>' + (h.body || 'PAGE-MARKER-4471') + '</body></html>' }) },
        capturePage: async () => ({ toPNG: () => Buffer.from(h.png || 'PNG-BYTES-9921'), getSize: () => ({ width: 1280, height: 720 }) }),
      },
      nav: () => ({ url: h.url, title: h.title, loading: false, canGoBack: false, canGoForward: false, error: '' }),
      focus() { h.focusCount++; }, load(u) { h.loads.push(u); }, close() { h.closed = true; }, setPanel() {}, cmd(n) { h.cmds.push(n); },
    };
    log.push(h); return h;
  };
}
module.exports = { tmp, fakeOS, mkVault, walk, FakeSession, fakeElectron, FakeTor, fakeHandleFactory };
