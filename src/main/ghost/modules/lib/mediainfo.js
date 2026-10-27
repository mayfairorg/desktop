'use strict';
// MediaInfo (separate program, BSD-2-Clause): container and stream facts of a picked audio or video file. Local only.
const { toolModule } = require('./tool-common');
const { ModuleError, clip, isoDate } = require('./core');

const PERSONAL = /^(performer|album_performer|composer|director|producer|author|artist|copyright|encoded_by|lyricist|conductor|writingby|actor|.*serial.*)$/i;
function parse(ctx, stdout, info) {
  let doc;
  try { doc = JSON.parse(stdout); } catch { throw new ModuleError('bad-response', 'MediaInfo did not return JSON'); }
  const tracks = doc && doc.media && Array.isArray(doc.media.track) ? doc.media.track : null;
  if (!tracks) throw new ModuleError('bad-response', 'MediaInfo returned no tracks');
  const gen = tracks.find((t) => t['@type'] === 'General') || {};
  const withheld = [...new Set(tracks.flatMap((t) => Object.keys(t).filter((k) => PERSONAL.test(k))))];
  const sum = tracks.filter((t) => t['@type'] !== 'General').slice(0, 12).map((t) => ({ type: t['@type'], format: clip(String(t.Format || ''), 40), codec: t.CodecID ? clip(String(t.CodecID), 20) : undefined, width: t.Width ? Number(t.Width) : undefined, height: t.Height ? Number(t.Height) : undefined, fps: t.FrameRate ? Number(t.FrameRate) : undefined, channels: t.Channels ? Number(t.Channels) : undefined }));
  ctx.emit({ type: 'document', value: clip(info.name, 200), raw: { size: info.size, sha256: info.sha256, format: gen.Format ? clip(String(gen.Format), 40) : undefined, durationS: gen.Duration ? Number(gen.Duration) : undefined, overallBitRate: gen.OverallBitRate ? Number(gen.OverallBitRate) : undefined, writingApplication: gen.Encoded_Application ? clip(String(gen.Encoded_Application), 120) : undefined, tracks: sum, personalFieldsWithheld: withheld.length ? withheld : undefined } });
  for (const [kind, key] of [['encoded', 'Encoded_Date'], ['tagged', 'Tagged_Date'], ['file-modified', 'File_Modified_Date']]) {
    const v = gen[key]; if (typeof v !== 'string') continue;
    const m = /^(UTC|\w+)?\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(v); if (!m) continue;
    const utc = m[1] === 'UTC';
    const t = isoDate(`${m[2]}T${m[3]}${utc ? 'Z' : ''}`);
    if (t) ctx.emit({ type: 'event', value: `${kind} time of ${clip(info.name, 120)}: ${m[2]} ${m[3]}${utc ? ' (UTC)' : ''}`, raw: { kind, t: utc ? t : `${m[2]}T${m[3]}`, zoneStated: utc, of: info.name } });
  }
  if (withheld.length) ctx.note(`personal fields withheld: ${withheld.join(', ')}`);
}
module.exports = toolModule({
  id: 'mediainfo', name: 'MediaInfo', program: 'MediaInfo', programs: ['mediainfo'], capabilities: ['file-metadata', 'audio-video', 'passive'],
  description: 'Container, codec, duration and encoding dates of a picked audio or video file, read with MediaInfo.',
  licence: { spdx: 'BSD-2-Clause', url: 'https://mediaarea.net/en/MediaInfo/License' }, versionArgs: ['--Version'],
  restrictions: 'Dates inside media files can be edited. Names of performers, directors and other people credited in the file are withheld.',
  argv: (ctx, input, file) => ['--Output=JSON', '--', file], parse,
});
module.exports.parse = parse;
