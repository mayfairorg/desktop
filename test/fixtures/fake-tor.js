#!/usr/bin/env node
// Stand-in for the tor program, for tests only. Speaks just enough: bootstrap log lines, a
// SOCKS port that is merely reserved, and a control port that accepts cookie auth + NEWNYM.
const fs = require('node:fs');
const net = require('node:net');
const rc = fs.readFileSync(process.argv[process.argv.indexOf('-f') + 1], 'utf8');
const get = (k) => (new RegExp('^' + k + ' (.+)$', 'm').exec(rc) || [])[1];
const control = parseInt(get('ControlPort').split(':')[1], 10);
const cookieFile = get('CookieAuthFile');
if (process.env.FAKE_TOR_MODE === 'crash') { console.log('[err] boom'); process.exit(3); }
const cookie = Buffer.from('0123456789abcdef0123456789abcdef');
fs.writeFileSync(cookieFile, cookie);
const srv = net.createServer((s) => {
  let ok = false; let buf = '';
  s.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (line.startsWith('AUTHENTICATE ')) { ok = line.slice(13) === cookie.toString('hex'); s.write(ok ? '250 OK\r\n' : '515 Authentication failed\r\n'); }
      else if (line === 'SIGNAL NEWNYM') { s.write(ok ? '250 OK\r\n' : '514 Authentication required\r\n'); fs.writeFileSync(cookieFile + '.newnym', '1'); }
      else if (line === 'QUIT') { s.end('250 closing connection\r\n'); }
    }
  });
});
srv.listen(control, '127.0.0.1', () => {
  if (process.env.FAKE_TOR_MODE === 'hang') return;
  for (const [p, t] of [[5, 'conn_done'], [50, 'loading_status'], [100, 'done']]) setTimeout(() => console.log(`Jan 01 00:00:00.000 [notice] Bootstrapped ${p}% (${t}): x`), p * 2);
});
process.on('SIGTERM', () => process.exit(0));
