'use strict';
// electron-builder afterPack hook: flips the Electron fuses on the packed binary (before it is signed).  See README.md, Code protection.
//   needs the dev dependency @electron/fuses (npm install).  If it is missing the build FAILS: an unprotected installer must never be shipped by accident.
//   MAYFAIR_ALLOW_UNFUSED=1 lets a developer build without it.
const path = require('node:path');
const { FUSES } = require('../src/main/lib/protect');

function executableFor(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const name = packager.appInfo.productFilename;
  if (electronPlatformName === 'darwin') return path.join(appOutDir, name + '.app');
  if (electronPlatformName === 'win32') return path.join(appOutDir, name + '.exe');
  return path.join(appOutDir, packager.executableName || name.toLowerCase().replace(/\s+/g, '-'));
}

// fuses: the @electron/fuses module (injected by the test)
async function applyFuses(context, fuses = null) {
  let F = fuses;
  if (!F) {
    try { F = require('@electron/fuses'); } catch (e) {
      if (process.env.MAYFAIR_ALLOW_UNFUSED === '1') { console.warn('after-pack: @electron/fuses is not installed, fuses NOT set (MAYFAIR_ALLOW_UNFUSED=1)'); return null; }
      throw new Error('after-pack: @electron/fuses is not installed. Run npm install, or set MAYFAIR_ALLOW_UNFUSED=1 for a developer build. (' + e.message + ')');
    }
  }
  const O = F.FuseV1Options;
  const wire = {
    version: F.FuseVersion.V1,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin' && context.arch === 3,   // arm64 macOS: flipping a fuse breaks the ad-hoc signature, so it is redone
    [O.RunAsNode]: FUSES.RunAsNode,
    [O.EnableNodeOptionsEnvironmentVariable]: FUSES.EnableNodeOptionsEnvironmentVariable,
    [O.EnableNodeCliInspectArguments]: FUSES.EnableNodeCliInspectArguments,
    [O.EnableEmbeddedAsarIntegrityValidation]: FUSES.EnableEmbeddedAsarIntegrityValidation,
    [O.OnlyLoadAppFromAsar]: FUSES.OnlyLoadAppFromAsar,
    [O.GrantFileProtocolExtraPrivileges]: FUSES.GrantFileProtocolExtraPrivileges,
  };
  const target = executableFor(context);
  await F.flipFuses(target, wire);
  return { target, wire };
}
exports.default = async function afterPack(context) { return applyFuses(context); };
exports.applyFuses = applyFuses;
exports.executableFor = executableFor;
