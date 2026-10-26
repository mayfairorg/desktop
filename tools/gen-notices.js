#!/usr/bin/env node
'use strict';
// Writes THIRD_PARTY_NOTICES.txt from legal/third-party.json.  node tools/gen-notices.js [--check]  (--check fails if the file is out of date; the unit tests run it)
// For a component with "npm" or "file", the real licence file from node_modules (or the named file) is copied in when it exists; otherwise a standard text for MIT or BSD-3-Clause is used.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const MIT = (holder) => `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const BSD3 = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;
function licenceText(c) {
  const tries = [];
  if (c.npm) for (const n of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE']) tries.push(path.join(ROOT, 'node_modules', c.npm, n));
  if (c.file) tries.push(path.join(ROOT, c.file));
  for (const f of tries) { try { return fs.readFileSync(f, 'utf8').trim() + '\n(copied from ' + path.relative(ROOT, f) + ')'; } catch { /* not installed here */ } }
  if (/^MIT/.test(c.licence)) return `${c.holder}\n\n` + MIT(c.holder);
  if (/^BSD-3/.test(c.licence)) return `${c.holder}\nAll rights reserved.\n\n` + BSD3;
  return 'The full text is at ' + c.url + ' and in the project named above.';
}
function render() {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'legal', 'third-party.json'), 'utf8'));
  const out = ['THIRD-PARTY NOTICES', 'Mayfair Desktop (c) The Mayfair Organization, all rights reserved (see LICENSE.txt).', 'The parts below are not ours. They are used under their own licences, which are not changed by the Mayfair licence.', ''];
  for (const c of d.components) out.push('='.repeat(78), `${c.name}  ${c.version}`, `Licence: ${c.licence}`, `Project: ${c.url}`, `Credit: ${c.holder}`, c.what, '', licenceText(c), '');
  out.push('='.repeat(78), d.buildTools, '');
  return out.join('\n');
}
module.exports = { render, licenceText };
if (require.main === module) {
  const f = path.join(ROOT, 'THIRD_PARTY_NOTICES.txt'), txt = render();
  if (process.argv.includes('--check')) { let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* missing */ } if (cur !== txt) { console.error('THIRD_PARTY_NOTICES.txt is out of date: run node tools/gen-notices.js'); process.exit(1); } console.log('notices up to date'); }
  else { fs.writeFileSync(f, txt); console.log('wrote', f, txt.length, 'bytes'); }
}
