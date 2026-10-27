'use strict';
// OpenOSINT: PLACEHOLDER. The tool's repository, licence, command line and output format were not identified (tool audit, section 1.1), and
// Mayfair will not guess them. The owner supplies the project URL in catalog.js (entry "openosint", field platforms[...].url and the licence in
// this folder's connector.json). Until a command line and parser are written against the real tool, every run and the self-test FAIL with that
// reason, so it can never show as installed. Keyless modules only, domain input only.
const common = require('./common');
const SPEC = { id: 'openosint', tool: 'openosint', version: '1.0.0', scope: 'passive', versionArgs: ['--version'], versionRe: /(\d+\.\d+\.\d+)/ };
const NOT_DEFINED = 'OpenOSINT is not wired up: the project address, licence and command line have not been supplied, and Ghost will not invent them.';

function normalizeInput(a) {
  const domain = String(a.domain || '').toLowerCase();
  if (!common.FQDN_RE.test(domain)) throw new common.UsageError('domain must be a full domain name such as example.com');
  return { domain };
}
async function buildArgs() { throw new common.ToolError(NOT_DEFINED, 10); }
function parse() { throw new common.ToolError(NOT_DEFINED, 10); }
async function functionalSelfTest() { throw new common.ToolError(NOT_DEFINED, 10); }
module.exports = { SPEC, NOT_DEFINED, normalizeInput, buildArgs, parse, functionalSelfTest };
