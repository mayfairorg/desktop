#!/usr/bin/env node
'use strict';
// Builds the protected copy of the app that the installers are made from: node tools/protect.js   (npm run protect; "npm run dist:*" runs it first)
//   build-protected/package.json, src/**, assets/**  with comments and whitespace removed from every .js (tools/minify.js), a copyright banner, NO source maps,
//   LICENSE.txt and THIRD_PARTY_NOTICES.txt, and integrity.json (a SHA-256 of every file under src/ and of package.json) which the app checks at start-up.
// The source folder is never changed.  electron-builder then packs build-protected/ (package.json "build.files" and "extraMetadata.main").
// bytenode (V8 bytecode) is deliberately not used: see README.md, Code protection.
const fs = require('node:fs');
const path = require('node:path');
const { minify } = require('./minify');
const PROT = require('../src/main/lib/protect');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'build-protected');
const YEAR = new Date().getFullYear();

function copyTree(from, to, fn) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b, fn); else fn(a, b);
  }
}
function banner(version) { return `/*! (c) ${YEAR} The Mayfair Organization. All rights reserved. Proprietary software: copying, reverse engineering and redistribution are prohibited (see LICENSE.txt). Open source parts keep their own licences (see THIRD_PARTY_NOTICES.txt). Mayfair Desktop ${version} */\n`; }

function run({ engine = process.env.MF_MINIFY_ENGINE || 'auto', quiet = false, out: OUT = DEFAULT_OUT } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.rmSync(OUT, { recursive: true, force: true });
  let before = 0, after = 0, files = 0, used = 'none';
  copyTree(path.join(ROOT, 'src'), path.join(OUT, 'src'), (a, b) => {
    if (a.endsWith('.map')) return;                                   // never ship a source map
    if (!a.endsWith('.js')) { fs.copyFileSync(a, b); return; }
    const src = fs.readFileSync(a, 'utf8');
    const r = minify(src, engine, true);                              // parsed again afterwards; the strip engine must give the identical syntax tree
    used = r.engine; before += src.length; after += r.code.length + 1; files++;
    fs.writeFileSync(b, banner(pkg.version) + r.code + '\n');
  });
  copyTree(path.join(ROOT, 'assets'), path.join(OUT, 'assets'), (a, b) => { if (!a.endsWith('.map')) fs.copyFileSync(a, b); });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(OUT, 'package.json'));
  for (const f of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  const man = PROT.buildManifest(OUT);
  fs.writeFileSync(path.join(OUT, PROT.MANIFEST), JSON.stringify(man, null, 1));
  if (!quiet) console.log(`protect: ${files} js files ${before} -> ${after} bytes (${used}), ${Object.keys(man.files).length} files in ${PROT.MANIFEST}, out ${OUT}`);
  return { files, before, after, engine: used, manifest: man };
}
module.exports = { run, banner, OUT: DEFAULT_OUT };
if (require.main === module) { try { run(); } catch (e) { console.error('protect failed:', e.message); process.exit(1); } }
