'use strict';
// Stands in for qemu-system-<arch>. No machine is run. It:
//   - answers the accelerator probe (-machine none -accel X): exit 0 only when X is in FAKE_ACCEL (comma list), otherwise exit 1 with a reason
//   - on a real start: logs its command line, whether the key file was readable (length only), connects to the agent socket named in argv
//     and plays the guest agent (hello with the token from the kernel command line, then ack every request). FAKE_MODE changes how it behaves:
//       exit-early   exit(3) at once, writing to stderr          no-hello    connect but never say hello          badtoken   say hello with a wrong token
const fs = require('node:fs');
const net = require('node:net');
const a = process.argv.slice(2);
const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'qemu', ...o }) + '\n'); };
const val = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
if (val('-machine') === 'none') {
  const accel = val('-accel'), ok = String(process.env.FAKE_ACCEL || '').split(',').includes(accel);
  log({ probe: accel, ok });
  if (!ok) { process.stderr.write('qemu-system: ' + accel + ' accelerator does not exist\n'); process.exit(1); }
  process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
  return;
}
let keyLens = [];
for (const o of a.filter((x) => /^secret,/.test(x))) { const m = /file=(.+)$/.exec(o); try { keyLens.push(fs.readFileSync(m[1]).length); } catch { keyLens.push(-1); } }
log({ run: true, argv: a, keyLens, cwd: process.cwd() });
const mode = process.env.FAKE_MODE || '';
if (mode === 'exit-early') { process.stderr.write('qemu-system: could not open the disk\n'); process.exit(3); }
const chard = (id) => { const x = a.find((s) => s.startsWith('socket,id=' + id + ',')); const m = x && /path=(.+)$/.exec(x); return m ? m[1] : null; };
const append = val('-append') || ''; const token = (/ghost\.token=([0-9a-f]+)/.exec(append) || [])[1];
const sock = net.connect(chard('agent'));
const send = (o) => sock.write(JSON.stringify(o) + '\n');
sock.on('connect', () => { if (mode === 'no-hello') return; send({ ev: 'hello', token: mode === 'badtoken' ? 'f'.repeat(48) : token, version: 1 }); });
let buf = '';
sock.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    log({ req: m.op, ...(m.argv ? { argv: m.argv } : {}), ...(m.kind ? { kind: m.kind } : {}) });
    if (m.op === 'poweroff') { setTimeout(() => process.exit(0), 20); continue; }
    if (m.op === 'shell') { send({ ev: 'ack', rid: m.rid, ok: true }); send({ ev: 'data', sid: m.sid, b64: Buffer.from('ghost$ ').toString('base64') }); continue; }
    if (m.op === 'in') { send({ ev: 'data', sid: m.sid, b64: m.b64 }); continue; }
    if (m.op === 'exec') { send({ ev: 'x-out', xid: m.xid, ch: 'o', b64: Buffer.from('ok\n').toString('base64') }); send({ ev: 'x-exit', xid: m.xid, code: 0 }); continue; }
    if (m.rid !== undefined) send({ ev: 'ack', rid: m.rid, ok: true });
  }
});
sock.on('close', () => process.exit(0));
sock.on('error', () => process.exit(4));
process.on('SIGTERM', () => process.exit(0));
