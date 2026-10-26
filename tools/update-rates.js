'use strict';
// Refreshes src/ui/rates.json from the European Central Bank's free daily reference rates.
// Run it before a release (CI can do it). Needs access to www.ecb.europa.eu.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
https.get('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', (r) => {
  if (r.statusCode !== 200) { console.error('HTTP ' + r.statusCode); process.exit(1); }
  let x = ''; r.on('data', (d) => { x += d; });
  r.on('end', () => {
    const date = (/time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(x) || [])[1];
    const rates = { EUR: 1 };
    for (const m of x.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = parseFloat(m[2]);
    if (!date || Object.keys(rates).length < 20) { console.error('Unexpected ECB file'); process.exit(1); }
    fs.writeFileSync(path.join(__dirname, '..', 'src', 'ui', 'rates.json'), JSON.stringify({ base: 'EUR', date, approximate: false, source: 'European Central Bank daily reference rates', rates }, null, 1));
    console.log('rates updated for', date, Object.keys(rates).length, 'currencies');
  });
}).on('error', (e) => { console.error('update-rates failed:', e.message); process.exit(1); });
