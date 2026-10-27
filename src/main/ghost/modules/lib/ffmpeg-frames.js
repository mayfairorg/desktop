'use strict';
// FFmpeg (separate program, LGPL builds only): still frames from a picked video at a chosen interval. Heavy.
const fs = require('node:fs');
const path = require('node:path');
const { toolModule, sha256 } = require('./tool-common');
const { ModuleError, clip } = require('./core');

async function parse(ctx, stdout, info) {
  const every = Math.max(1, Math.min(3600, parseInt(info.input.every, 10) || 10));
  const names = fs.readdirSync(info.tmp).filter((n) => /^frame_\d{4}\.png$/.test(n)).sort();
  if (!names.length) { ctx.note('no frames were produced (the file may have no video stream)'); return; }
  let i = 0;
  for (const n of names) {
    const p = path.join(info.tmp, n), st = fs.statSync(p);
    ctx.emit({ type: 'image', value: clip(`frame ${String(i + 1).padStart(4, '0')} of ${info.name}`, 300), raw: { offsetS: i * every, bytes: st.size, sha256: await sha256(p), of: info.name, sourceSha256: info.sha256, keptIn: path.basename(info.tmp) } });
    i++;
  }
  ctx.note('the frames stay in a private temporary folder on this computer until a case folder is chosen; results carry their hashes and time offsets');
}
module.exports = toolModule({
  id: 'ffmpeg-frames', name: 'Video frames (FFmpeg)', program: 'FFmpeg', programs: ['ffmpeg'], capabilities: ['video', 'frame-extraction', 'passive'], heavy: true, timeoutMs: 600000, tmp: true, keepTmp: true, maxBytes: 1073741824,
  description: 'Extracts still frames from a picked video at a chosen interval with FFmpeg and reports each frame with its time offset and SHA-256.',
  licence: { spdx: 'LGPL-2.1-or-later', url: 'https://ffmpeg.org/legal.html' }, versionArgs: ['-version'],
  restrictions: 'Only LGPL builds of FFmpeg are accepted: a build compiled with GPL or non-free parts is refused. Frames are not sent anywhere and no face matching is done. Respect the rights of people in a video.',
  extraInputs: [{ name: 'every', type: 'integer', label: 'Seconds between frames', required: false, min: 1, max: 3600 }, { name: 'max', type: 'integer', label: 'Most frames', required: false, min: 1, max: 100 }],
  checkBuild: async (ctx, runProg) => { const r = await runProg(['-version']); if (/--enable-(gpl|nonfree|version3)/.test(r.stdout)) throw new ModuleError('unavailable', 'this FFmpeg build includes GPL or non-free parts; Ghost only uses LGPL builds'); },
  argv: (ctx, input, file, tmp) => ['-nostdin', '-v', 'error', '-i', file, '-vf', `fps=1/${Math.max(1, Math.min(3600, parseInt(input.every, 10) || 10))}`, '-frames:v', String(Math.max(1, Math.min(100, parseInt(input.max, 10) || 20))), '-f', 'image2', path.join(tmp, 'frame_%04d.png')],
  parse,
});
