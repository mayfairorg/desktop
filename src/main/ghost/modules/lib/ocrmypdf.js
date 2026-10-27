'use strict';
// OCRmyPDF (separate program, MPL-2.0): text of a scanned PDF. Works in a private temporary folder and keeps nothing. Heavy.
const fs = require('node:fs');
const path = require('node:path');
const { toolModule } = require('./tool-common');
const { ocrReport } = require('./tesseract');

module.exports = toolModule({
  id: 'ocrmypdf', name: 'OCR for PDFs (OCRmyPDF)', program: 'OCRmyPDF', programs: ['ocrmypdf'], capabilities: ['ocr', 'pdf', 'text-extraction', 'passive'], heavy: true, timeoutMs: 600000, tmp: true,
  description: 'Recognises the text of a scanned PDF with OCRmyPDF (pages that already have text are skipped) and reports it as a document with a preview. The PDF is not changed.',
  licence: { spdx: 'MPL-2.0', url: 'https://github.com/ocrmypdf/OCRmyPDF/blob/main/LICENSE' }, versionArgs: ['--version'], files: ['tesseract.js'],
  restrictions: 'OCR output is likely, never certain. The text may contain personal details from the document; do not use it to profile a private individual. Needs Tesseract and Ghostscript installed next to it.',
  exts: ['.pdf'], maxBytes: 209715200,
  extraInputs: [{ name: 'language', type: 'enum', label: 'Language', required: false, values: ['eng', 'deu', 'fra', 'spa', 'ita', 'por', 'nld'] }],
  argv: (ctx, input, file, tmp) => ['--skip-text', '--quiet', '-l', input.language || 'eng', '--sidecar', path.join(tmp, 'text.txt'), '--output-type', 'pdf', file, path.join(tmp, 'out.pdf')],
  parse: (ctx, stdout, info) => {
    let text = '';
    try { text = fs.readFileSync(path.join(info.tmp, 'text.txt'), 'utf8'); } catch { /* no text */ }
    ocrReport(ctx, text, info, info.input.language || 'eng', 'ocrmypdf');
  },
});
