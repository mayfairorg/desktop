'use strict';
// Factory for connectors that wrap a separate, locally installed program (ExifTool, MediaInfo, Tesseract, ...). The program is not part of
// Ghost: it is found in the connector's bin/ folder (put there by the download-on-first-use step, under the tool's own licence) or on PATH.
// Until it is found the connector says so (unavailable) and its self-test fails: nothing shows as ready that is not.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModuleError, clip } = require('./core');

const sha256 = (file) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); });

// def: {id, name, version, description, capabilities, programs:[names], program: display name, licence:{spdx,url}, restrictions, dataTerms?,
//       heavy?, timeoutMs?, extraInputs?, exts?:[...], versionArgs, locate?(tools)->{file, args}, argv(ctx,input,file,tmp)->args, parse(ctx, stdout, info), tmpDir?}
function toolModule(def) {
  const meta = {
    id: def.id, tool: def.programs[0], name: def.name, version: '1.0.0', description: def.description,
    capabilities: [...def.capabilities, 'local'], scope: 'local', network: 'local', hosts: [], client: { maxRequests: 0, timeoutMs: def.timeoutMs || 60000 },
    program: def.program, programNames: def.programs, heavy: !!def.heavy, separateProgram: true,
    restrictions: def.restrictions + ' The program is a separate download under its own licence (' + def.licence.spdx + '); until it is present this connector reports it as unavailable. It runs on this computer and makes no network request.',
    licence: def.licence, dataTerms: def.dataTerms,
    inputs: [{ name: 'file', type: 'file', label: 'File', required: false, maxBytes: def.maxBytes || 104857600 }, ...(def.extraInputs || []), { name: 'check', type: 'enum', label: 'Self-check', required: false, values: ['version'] }],
    files: ['core.js', 'runtime.js', 'tool-run.js', 'tool-common.js'].concat(def.files || []),
    selfTest: { input: { check: 'version' }, expect: { minResults: 1, contains: [{ type: 'document', value: def.program + ' available' }] } },
  };
  async function locate(ctx) {
    const l = def.locate ? def.locate(ctx.tools) : { file: ctx.tools.find(def.programs), args: [] };
    if (!l || !l.file) throw new ModuleError('unavailable', `${def.program} is not installed (not found in this connector's bin folder or on PATH)`, { missingProgram: true });
    return l;
  }
  async function run(ctx, input) {
    const l = await locate(ctx);
    const runProg = (args, o = {}) => ctx.tools.run(l.file, [...l.args, ...args], { timeoutMs: def.timeoutMs || 60000, ...o });
    if (def.checkBuild) await def.checkBuild(ctx, runProg);
    if (input.check === 'version') {
      const r = await runProg(def.versionArgs);
      const line = (r.stdout || r.stderr).split('\n').find((x) => x.trim()) || '';
      if (r.code !== 0 || !line) throw new ModuleError('unavailable', `${def.program} did not report a version (exit ${r.code === null ? 'none' : r.code})`);
      ctx.emit({ type: 'document', value: `${def.program} available`, raw: { selfCheck: true, version: clip(line.trim(), 120), program: path.basename(l.file) } });
      return;
    }
    if (!input.file) throw new ModuleError('bad-input', 'pick a file');
    let st;
    try { st = fs.statSync(input.file); } catch { throw new ModuleError('bad-input', 'the file cannot be read'); }
    if (!st.isFile()) throw new ModuleError('bad-input', 'not a regular file');
    if (def.exts && !def.exts.includes(path.extname(input.file).toLowerCase())) throw new ModuleError('bad-input', `${def.program} is used here for ${def.exts.join(' ')} files`);
    ctx.progress(0.1, 'reading the file');
    const hash = await sha256(input.file);
    const info = { file: input.file, name: path.basename(input.file), size: st.size, sha256: hash, input };
    const work = async () => {
      ctx.progress(0.3, `running ${def.program}`);
      const tmp = def.tmp ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mf-ghost-' + def.id + '-')) : null;
      try {
        const args = def.argv(ctx, input, input.file, tmp);
        const r = await runProg(args, { cwd: tmp || undefined, maxBytes: def.maxBytes_out });
        if (r.error) throw new ModuleError('unavailable', `${def.program} could not start: ${r.error}`);
        if (r.timedOut) throw new ModuleError('unavailable', `${def.program} did not finish within ${(def.timeoutMs || 60000) / 1000} s`);
        if (r.truncated) throw new ModuleError('bad-response', `${def.program} produced more output than allowed`);
        if (r.code !== 0 && !(def.okCodes || []).includes(r.code)) throw new ModuleError('bad-response', `${def.program} failed (exit ${r.code})${r.stderr ? ': ' + clip(r.stderr.split('\n').find((x) => x.trim()) || '', 160) : ''}`);
        await def.parse(ctx, r.stdout, { ...info, tmp, stderr: r.stderr });
      } finally { if (tmp && !def.keepTmp) fs.rmSync(tmp, { recursive: true, force: true }); }
    };
    if (def.heavy) {
      try { await ctx.tools.heavy(work); } catch (e) { if (e && e.code === 'HEAVY_BUSY') throw new ModuleError('unavailable', 'another heavy tool is still running; try again later'); throw e; }
    } else await work();
    ctx.progress(1);
  }
  return { meta, run, locate: (tools) => (def.locate ? def.locate(tools) : tools.find(def.programs)) };
}

// personal fields in file metadata: names of people, owners, serials
const PERSONAL_TAG = /^(artist|author|last-?author|creator|dc:creator|meta:author|meta:last-author|meta:initial-author|initial-creator|copyright|rights|owner(name)?|cameraownername|by-line|credit|contact|manager|company|performer|album_performer|composer|director|encoded_by|.*serial(number)?)$/i;
const isPersonalTag = (t) => PERSONAL_TAG.test(String(t).replace(/^.*:/, '')) || PERSONAL_TAG.test(String(t));

module.exports = { toolModule, sha256, isPersonalTag, PERSONAL_TAG };
