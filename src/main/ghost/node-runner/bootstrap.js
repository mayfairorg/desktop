'use strict';
// Mayfair Ghost: entry point of the utility process that runs an approved '@node' connector script. The Electron fuse that lets the app
// binary act as plain Node stays OFF; instead the adapter (adapter.js) forks this file with utilityProcess and passes the connector's
// script and argument list in two private variables. They are removed before the connector starts, so the connector sees the same
// minimal environment and the same process.argv layout it would see under a plain Node run: [node, script, ...args].
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const fail = (msg) => { process.stderr.write('node-runner: ' + msg + '\n'); process.exit(70); };
const script = process.env.MF_RUN_SCRIPT;
let args;
try { args = JSON.parse(process.env.MF_RUN_ARGS || '[]'); } catch { fail('bad argument list'); }
delete process.env.MF_RUN_SCRIPT;
delete process.env.MF_RUN_ARGS;
if (typeof script !== 'string' || !path.isAbsolute(script)) fail('the script path must be absolute');
if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) fail('bad argument list');
process.argv = [process.execPath, script, ...args];
if (/\.mjs$/i.test(script)) import(pathToFileURL(script).href).catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
else require(script);
// A utility process does not end by itself when its work is done (its own pipes stay open), so end it when nothing but those pipes and
// this watcher remain; a connector that still waits on a timer, a socket, a child or a file keeps the process alive as in plain Node.
if (typeof process.getActiveResourcesInfo === 'function') {
  let idle = 0;
  const watch = setInterval(() => {
    const r = process.getActiveResourcesInfo();
    const own = r.filter((n) => n === 'Timeout').length <= 1 && r.every((n) => n === 'Timeout' || n === 'PipeWrap' || n === 'TTYWrap');
    idle = own ? idle + 1 : 0;
    if (idle >= 2) { clearInterval(watch); process.exit(process.exitCode || 0); }
  }, 100);
}
