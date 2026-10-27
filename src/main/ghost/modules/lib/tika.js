'use strict';
// Apache Tika (separate program, Apache-2.0; needs Java): metadata of documents in many formats. Heavy. Local only.
const { toolModule, isPersonalTag } = require('./tool-common');
const { ModuleError, clip, isoDate } = require('./core');

const KEEP = { 'Content-Type': 'contentType', 'xmpTPg:NPages': 'pages', 'Application-Name': 'application', 'pdf:producer': 'producer', producer: 'producer', 'dc:title': 'title', 'pdf:PDFVersion': 'pdfVersion', 'Content-Length': 'contentLength' };
function parse(ctx, stdout, info) {
  let doc;
  try { doc = JSON.parse(stdout); } catch { throw new ModuleError('bad-response', 'Tika did not return JSON'); }
  if (Array.isArray(doc)) doc = doc[0];
  if (!doc || typeof doc !== 'object') throw new ModuleError('bad-response', 'Tika returned no record');
  const raw = { size: info.size, sha256: info.sha256 }, withheld = [];
  for (const [k, v] of Object.entries(doc)) {
    if (isPersonalTag(k)) { withheld.push(k); continue; }
    if (KEEP[k] && (typeof v === 'string' || typeof v === 'number')) raw[KEEP[k]] = (KEEP[k] === 'pages' || KEEP[k] === 'contentLength') && Number.isFinite(Number(v)) ? Number(v) : typeof v === 'string' ? clip(v, 120) : v;
  }
  if (withheld.length) raw.personalFieldsWithheld = [...new Set(withheld)].slice(0, 20);
  ctx.emit({ type: 'document', value: clip(info.name, 200), raw });
  for (const [kind, keys] of [['created', ['dcterms:created', 'Creation-Date', 'meta:creation-date']], ['modified', ['dcterms:modified', 'Last-Modified', 'meta:save-date']]]) {
    const v = keys.map((k) => doc[k]).find((x) => typeof x === 'string'); const t = v ? isoDate(v) : null;
    if (t) ctx.emit({ type: 'event', value: `${kind} time of ${clip(info.name, 120)}: ${t.slice(0, 19).replace('T', ' ')} (UTC)`, confidence: 'likely', raw: { kind, t, of: info.name, source: 'document properties' } });
  }
  if (withheld.length) ctx.note(`personal fields withheld: ${[...new Set(withheld)].slice(0, 20).join(', ')}`);
}
module.exports = toolModule({
  id: 'tika', name: 'Document metadata (Apache Tika)', program: 'Apache Tika', programs: ['java'], capabilities: ['file-metadata', 'documents', 'passive'], heavy: true, timeoutMs: 120000,
  description: 'Document properties (type, pages, producer application, dates) of a picked file in many formats, read with Apache Tika. The text of the document is not extracted.',
  licence: { spdx: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' }, versionArgs: ['--version'],
  restrictions: 'Document dates and properties can be edited. Names of authors, last editors, companies and managers are withheld. Needs Java and the Tika application jar (tika-app-*.jar) in the connector\'s bin folder.',
  locate: (tools) => { const jar = tools.findFile(/^tika-app-[\d.]+\.jar$/); const java = tools.find(['java']); return jar && java ? { file: java, args: ['-Djava.awt.headless=true', '-jar', jar] } : null; },
  argv: (ctx, input, file) => ['--json', file], parse,
});
module.exports.parse = parse;
