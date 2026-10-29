'use strict';
// Real Electron utilityProcess check for the '@node' runner (run under xvfb by test/ghost-runner-real.test.js). Writes JSON to GHOST_OUT.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { app, utilityProcess } = require('electron');
const { createUtilityRunner } = require('../src/main/ghost/node-runner/adapter.js');
const out = process.env.GHOST_OUT; const res = {};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-runner-real-'));
fs.writeFileSync(path.join(dir, 'quick.js'), "process.stdout.write(JSON.stringify({args:process.argv.slice(2)}));");
fs.writeFileSync(path.join(dir, 'late.js'), "setTimeout(()=>process.stdout.write('late'),1500);");
fs.writeFileSync(path.join(dir, 'fail.js'), "process.exit(3);");
const run = (r, file, args) => new Promise((resolve) => {
  const c = r.start({ script: path.join(dir, file), args, cwd: dir, env: { PATH: process.env.PATH } });
  let o = ''; c.stdout.on('data', (d) => { o += d; });
  const t = setTimeout(() => { if (c.killTree) c.killTree(); resolve({ timedOut: true, out: o }); }, 12000);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, out: o }); });
});
app.whenReady().then(async () => {
  try {
    const r = createUtilityRunner({ utilityProcess });
    res.quick = await run(r, 'quick.js', ['a', 'b']);
    res.late = await run(r, 'late.js', []);
    res.fail = await run(r, 'fail.js', []);
    res.check = await r.runCheck({ argv: ['@node', '-e', 'process.exit(0)'], cwd: dir, resolveRel: () => null, timeoutMs: 10000 });
  } catch (e) { res.error = String(e && e.stack || e); }
  fs.writeFileSync(out, JSON.stringify(res)); app.exit(0);
});
