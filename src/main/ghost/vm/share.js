'use strict';
// Ghost virtual computer: the one shared folder. There is exactly one per case, it is always <vm>/cases/<case>/shared inside Ghost's own
// data folder, and nothing else of this computer is ever visible to the machine: not the home folder, not Downloads, not a folder the
// page names. The person puts files in and takes files out through this folder (the window can open it).
// The checks below run before every start: the folder must be a real directory (not a link), its real path must still be inside the case
// folder, and the case id must be plain.
const fs = require('node:fs');
const path = require('node:path');
const { CASE_RE } = require('./disk');
const { VmError } = require('./images');

const within = (root, p) => p !== root && p.startsWith(root + path.sep);

function paths(base, caseId) {
  if (!CASE_RE.test(String(caseId))) throw new VmError('bad-input', 'Case id must be 1 to 40 letters, digits, - or _.');
  const caseDir = path.join(base, 'cases', caseId);
  return { caseDir, shared: path.join(caseDir, 'shared') };
}

// Creates the folder when missing and returns its real path. Throws when it is anything but a plain directory inside the case folder.
function ensureShare(base, caseId, { fsx = fs } = {}) {
  const { caseDir, shared } = paths(base, caseId);
  fsx.mkdirSync(path.dirname(caseDir), { recursive: true, mode: 0o700 });
  // The case folder itself must be a plain folder before anything is made inside it (a link there would make the new folder appear somewhere else).
  let cs = null; try { cs = fsx.lstatSync(caseDir); } catch { /* new */ }
  if (cs && !cs.isDirectory()) throw new VmError('share-unsafe', 'The case folder is a link or a file, so nothing was shared.');
  if (!cs) fsx.mkdirSync(caseDir, { mode: 0o700 });

  let st = null; try { st = fsx.lstatSync(shared); } catch { /* new */ }
  if (st && !st.isDirectory()) throw new VmError('share-unsafe', 'The shared folder is not a plain folder (it is a link or a file), so it was not shared.');
  if (!st) fsx.mkdirSync(shared, { mode: 0o700 });
  const realBase = fsx.realpathSync(base), realCase = fsx.realpathSync(caseDir), real = fsx.realpathSync(shared);
  if (!within(realBase, realCase)) throw new VmError('share-unsafe', 'The case folder resolves outside the virtual computer folder, so nothing was shared.');
  if (!within(realCase, real)) throw new VmError('share-unsafe', 'The shared folder resolves outside the case folder, so it was not shared.');
  return real;
}
module.exports = { paths, ensureShare, within };
