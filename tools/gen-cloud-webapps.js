#!/usr/bin/env node
'use strict';
// Writes the Mayfair Cloud copy of the web apps catalogue (the list the App Library shows when Mayfair Desktop is not installed).
//   node tools/gen-cloud-webapps.js <path to apps/webapps_catalogue.js>        write it
//   node tools/gen-cloud-webapps.js --check <path>                              exit 1 when that file is not what the desktop catalogue produces
// The desktop catalogue (src/main/lib/webapps.json) is the single source: ids, names, categories, addresses, descriptions and search words are the same in both.
const fs = require('node:fs');
const path = require('node:path');
const W = require('../src/main/lib/webapps');
const { apps } = W.validateCatalogue(require('../src/main/lib/webapps.json').apps);

function render() {
  const rows = apps.map((a) => '[' + [a.id, a.name, a.category, a.url, a.description, a.keywords.join(' ')].map((x) => JSON.stringify(x)).join(',') + ']');
  return '/* Web apps catalogue for the App Library when Mayfair Desktop is not installed: id, name, category, address, description, search words.\n'
    + '   Generated from the desktop catalogue (desktop-app/src/main/lib/webapps.json) by desktop-app/tools/gen-cloud-webapps.js: do not edit by hand.\n'
    + '   Names only: no logos are bundled; the desktop app fetches each site\'s own icon, and this list shows a letter instead. */\n'
    + 'window.MFWEBAPPS=[\n' + rows.join(',\n') + '\n];\n';
}
if (require.main === module) {
  const check = process.argv[2] === '--check'; const out = process.argv[check ? 3 : 2];
  if (!out) { console.error('usage: gen-cloud-webapps.js [--check] <apps/webapps_catalogue.js>'); process.exit(2); }
  const text = render();
  if (check) { let cur = ''; try { cur = fs.readFileSync(out, 'utf8'); } catch { /* missing */ } if (cur !== text) { console.error('out of step with the desktop catalogue: ' + out); process.exit(1); } console.log('in step: ' + apps.length + ' apps'); }
  else { fs.writeFileSync(path.resolve(out), text); console.log('wrote ' + out + ' (' + apps.length + ' apps)'); }
}
module.exports = { render };
