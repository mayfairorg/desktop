'use strict';
// Tesseract OCR (separate program, Apache-2.0): text in a picked image. Heavy: one at a time.
const { toolModule } = require('./tool-common');
const { clip } = require('./core');

function ocrReport(ctx, text, info, lang, engine) {
  const t = text.replace(/\r/g, '').replace(/\f/g, '\n').trim();
  const words = t ? t.split(/\s+/).length : 0;
  ctx.emit({ type: 'document', value: clip(info.name, 200), confidence: t ? 'likely' : 'uncertain', ...(t ? {} : { uncertaintyNote: 'no text was recognised; the image may have none, or the language pack may not match' }), raw: { engine, language: lang, size: info.size, sha256: info.sha256, characters: t.length, words, textPreview: clip(t, 1500) } });
  if (t) ctx.note('OCR text can contain mistakes; check it against the original');
}
const LANGS = ['eng', 'deu', 'fra', 'spa', 'ita', 'por', 'nld'];
module.exports = toolModule({
  id: 'tesseract', name: 'OCR (Tesseract)', program: 'Tesseract', programs: ['tesseract'], capabilities: ['ocr', 'text-extraction', 'passive'], heavy: true, timeoutMs: 180000,
  description: 'Recognises the text in a picked image with Tesseract and reports it as a document with a preview. Recognition is approximate.',
  licence: { spdx: 'Apache-2.0', url: 'https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE' }, versionArgs: ['--version'],
  restrictions: 'OCR output is likely, never certain. The text may contain personal details from the image; keep the results with the case and do not use them to profile a private individual. Needs the language data you choose.',
  exts: ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp'],
  extraInputs: [{ name: 'language', type: 'enum', label: 'Language', required: false, values: LANGS }],
  argv: (ctx, input, file) => [file, 'stdout', '-l', input.language || 'eng', '--psm', '3'],
  parse: (ctx, stdout, info) => ocrReport(ctx, stdout, info, info.input.language || 'eng', 'tesseract'),
});
module.exports.ocrReport = ocrReport;
