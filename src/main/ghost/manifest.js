'use strict';
// Mayfair Ghost: connector manifest (connector.json) schema and validator.
// A connector is a folder with connector.json and the program it runs. The manifest is DATA: nothing in it is ever
// handed to a shell. The validator rejects unknown keys, paths that leave the connector folder, shell metacharacters in
// executables, and argument templates with anything other than named placeholders. See docs/connectors.md.
const path = require('node:path');

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CAP_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const FIELD_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const REL_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;     // forward slashes only; no leading dot-segment, no '..' (a '..' segment starts with a dot), no shell characters
const BARE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const SCOPES = ['local', 'passive', 'active'];
const NETWORKS = ['local', 'keyless-external', 'rate-limited', 'unavailable'];
const PERMISSIONS = ['read-picked-file', 'network', 'temp-files'];
const FIELD_TYPES = ['string', 'enum', 'integer', 'url-host', 'file'];
const NODE_TOKEN = '@node';     // the app's own node: process.execPath with ELECTRON_RUN_AS_NODE=1
const LIMIT_MAX = { timeoutMs: 600000, maxOutputBytes: 16 * 1024 * 1024, maxMemoryMb: 4096, maxConcurrent: 8 };
const TOP_KEYS = ['id', 'name', 'version', 'description', 'capabilities', 'scope', 'network', 'licence', 'installRequirements', 'command', 'input', 'output', 'limits', 'permissions', 'externalRestrictions', 'selfTest'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !v.includes('\0');
const isInt = (v) => Number.isInteger(v);

function onlyKeys(o, allowed, where, errs) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${where}: unknown key "${k}"`);
}
function requireKeys(o, keys, where, errs) {
  for (const k of keys) if (o[k] === undefined) errs.push(`${where}: missing "${k}"`);
}

// A path inside the connector folder: relative, forward slashes, no '..', no absolute or drive paths, no shell characters.
function relPathError(p) {
  if (typeof p !== 'string' || !p) return 'must be a non-empty string';
  if (p.length > 200) return 'is too long';
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || path.isAbsolute(p)) return 'must be relative to the connector folder (absolute paths are refused)';
  if (p.includes('\\')) return 'must use forward slashes';
  if (p.split('/').some((s) => s === '..' || s === '.')) return 'must not contain . or .. segments (path traversal)';
  if (!REL_PATH_RE.test(p)) return 'contains characters that are not allowed (letters, digits, . _ - and / only)';
  return null;
}

function checkArgvElement(s, where, errs) {
  if (!isStr(s, 1, 500)) errs.push(`${where}: must be a string of 1 to 500 characters`);
}

function validateInputField(f, i, errs) {
  const where = `input.fields[${i}]`;
  if (!isObj(f)) { errs.push(`${where}: must be an object`); return null; }
  if (!FIELD_TYPES.includes(f.type)) { errs.push(`${where}: type must be one of ${FIELD_TYPES.join(', ')}`); return null; }
  const common = ['name', 'type', 'label', 'required', 'sensitive'];
  const extra = { string: ['pattern', 'minLength', 'maxLength', 'allowLeadingDash'], enum: ['values'], integer: ['min', 'max'], 'url-host': [], file: ['maxBytes'] }[f.type];
  onlyKeys(f, [...common, ...extra], where, errs);
  if (typeof f.name !== 'string' || !FIELD_RE.test(f.name)) errs.push(`${where}: name must match ${FIELD_RE}`);
  if (f.label !== undefined && !isStr(f.label, 1, 80)) errs.push(`${where}: label must be 1 to 80 characters`);
  if (f.required !== undefined && typeof f.required !== 'boolean') errs.push(`${where}: required must be true or false`);
  if (f.sensitive !== undefined && typeof f.sensitive !== 'boolean') errs.push(`${where}: sensitive must be true or false`);
  if (f.type === 'string') {
    if (!isInt(f.maxLength) || f.maxLength < 1 || f.maxLength > 4096) errs.push(`${where}: string fields need maxLength 1 to 4096`);
    if (f.minLength !== undefined && (!isInt(f.minLength) || f.minLength < 0 || (isInt(f.maxLength) && f.minLength > f.maxLength))) errs.push(`${where}: minLength must be an integer from 0 to maxLength`);
    if (f.pattern !== undefined) {
      if (!isStr(f.pattern, 1, 200)) errs.push(`${where}: pattern must be 1 to 200 characters`);
      else { try { new RegExp(f.pattern); } catch { errs.push(`${where}: pattern is not a valid regular expression`); } }
    }
    if (f.allowLeadingDash !== undefined && typeof f.allowLeadingDash !== 'boolean') errs.push(`${where}: allowLeadingDash must be true or false`);
  } else if (f.type === 'enum') {
    if (!Array.isArray(f.values) || !f.values.length || f.values.length > 50 || !f.values.every((v) => isStr(v, 1, 100)) || new Set(f.values).size !== f.values.length) errs.push(`${where}: values must be 1 to 50 distinct strings`);
  } else if (f.type === 'integer') {
    if (!isInt(f.min) || !isInt(f.max) || f.min > f.max || Math.abs(f.min) > Number.MAX_SAFE_INTEGER || Math.abs(f.max) > Number.MAX_SAFE_INTEGER) errs.push(`${where}: integer fields need integer min and max (min <= max)`);
  } else if (f.type === 'file') {
    if (f.maxBytes !== undefined && (!isInt(f.maxBytes) || f.maxBytes < 1 || f.maxBytes > 1024 * 1024 * 1024)) errs.push(`${where}: maxBytes must be 1 to 1073741824`);
  }
  return f;
}

// Value check for one declared field. Returns {ok, value} or {ok:false, error}. Values come from the Mayfair page: never trusted.
function checkFieldValue(f, v) {
  switch (f.type) {
    case 'string':
      if (typeof v !== 'string') return { ok: false, error: 'must be text' };
      if (v.includes('\0')) return { ok: false, error: 'contains an invalid character' };
      if (v.length > f.maxLength) return { ok: false, error: `is longer than ${f.maxLength}` };
      if (f.minLength !== undefined && v.length < f.minLength) return { ok: false, error: `is shorter than ${f.minLength}` };
      if (f.pattern !== undefined && !new RegExp(f.pattern).test(v)) return { ok: false, error: 'does not match the expected format' };
      return { ok: true, value: v };
    case 'enum':
      return typeof v === 'string' && f.values.includes(v) ? { ok: true, value: v } : { ok: false, error: 'is not one of the allowed values' };
    case 'integer':
      return Number.isInteger(v) && v >= f.min && v <= f.max ? { ok: true, value: v } : { ok: false, error: `must be a whole number from ${f.min} to ${f.max}` };
    case 'url-host': {
      if (typeof v !== 'string' || !HOST_RE.test(v)) return { ok: false, error: 'must be a host name such as example.com (no scheme, path or port)' };
      return { ok: true, value: v.toLowerCase() };
    }
    case 'file':
      return typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'must be a token from ghost.pickFile()' };
    default: return { ok: false, error: 'unknown type' };
  }
}

// Check a whole input object against the manifest's field list. Unknown names are refused. Returns {ok, values, errors}.
function validateInput(manifest, input) {
  const errors = [];
  const fields = manifest.input.fields;
  if (!isObj(input)) return { ok: false, values: {}, errors: ['input must be an object'] };
  for (const k of Object.keys(input)) if (!fields.some((f) => f.name === k)) errors.push(`input: unknown field "${k}"`);
  const values = {};
  for (const f of fields) {
    const v = input[f.name];
    if (v === undefined || v === null || v === '') { if (f.required !== false) errors.push(`input.${f.name}: is required`); continue; }
    const r = checkFieldValue(f, v);
    if (!r.ok) errors.push(`input.${f.name}: ${r.error}`); else values[f.name] = r.value;
  }
  return { ok: errors.length === 0, values, errors };
}

function placeholdersOf(s) { const out = []; for (const m of s.matchAll(PLACEHOLDER_RE)) out.push(m[1]); return out; }

function validateCommand(c, fieldNames, errs) {
  if (!isObj(c)) { errs.push('command: must be an object'); return; }
  onlyKeys(c, ['executable', 'args', 'files'], 'command', errs);
  requireKeys(c, ['executable', 'args'], 'command', errs);
  if (typeof c.executable === 'string' && c.executable !== NODE_TOKEN) {
    const e = relPathError(c.executable);
    if (e) errs.push(`command.executable ${e}`);
  } else if (c.executable !== undefined && typeof c.executable !== 'string') errs.push('command.executable: must be a string');
  if (!Array.isArray(c.args)) { errs.push('command.args: must be an array (never a shell string)'); return; }
  if (c.args.length > 40) errs.push('command.args: at most 40 elements');
  c.args.forEach((a, i) => {
    const where = `command.args[${i}]`;
    if (typeof a !== 'string') { errs.push(`${where}: must be a string`); return; }
    checkArgvElement(a, where, errs);
    const rest = a.replace(PLACEHOLDER_RE, '');
    if (rest.includes('{') || rest.includes('}')) errs.push(`${where}: unbalanced braces; only named placeholders like {name} are allowed`);
    for (const n of placeholdersOf(a)) {
      if (!FIELD_RE.test(n)) errs.push(`${where}: placeholder {${n}} is not a named placeholder`);
      else if (!fieldNames.includes(n)) errs.push(`${where}: placeholder {${n}} is not a declared input field`);
    }
  });
  if (c.executable === NODE_TOKEN) {
    const first = c.args[0];
    if (typeof first !== 'string' || relPathError(first) || /\{|\}/.test(first)) errs.push('command.args[0]: with @node the first argument must be the connector script, a literal relative path inside the connector folder');
  }
  if (c.files !== undefined) {
    if (!Array.isArray(c.files) || c.files.length > 20) errs.push('command.files: must be an array of at most 20 relative paths');
    else c.files.forEach((p, i) => { const e = relPathError(p); if (e) errs.push(`command.files[${i}] ${e}`); });
  }
}

function validateRequirement(r, i, errs) {
  const where = `installRequirements[${i}]`;
  if (!isObj(r)) { errs.push(`${where}: must be an object`); return; }
  onlyKeys(r, ['name', 'check'], where, errs);
  if (!isStr(r.name, 1, 60)) errs.push(`${where}: name must be 1 to 60 characters`);
  if (!Array.isArray(r.check)) { errs.push(`${where}: check must be an argv array (never a shell string)`); return; }
  if (!r.check.length || r.check.length > 8) { errs.push(`${where}: check must have 1 to 8 elements`); return; }
  r.check.forEach((a, j) => { if (!isStr(a, 1, 200)) errs.push(`${where}.check[${j}]: must be a string of 1 to 200 characters`); });
  const exe = r.check[0];
  if (typeof exe === 'string' && exe !== NODE_TOKEN) {
    if (exe.includes('/') || exe.includes('\\')) { const e = relPathError(exe); if (e) errs.push(`${where}.check[0] ${e}`); }
    else if (!BARE_NAME_RE.test(exe)) errs.push(`${where}.check[0]: must be a plain program name (letters, digits . _ + -), got a string with shell characters`);
  }
}

function validateSelfTest(s, errs) {
  if (!isObj(s)) { errs.push('selfTest: must be an object'); return; }
  onlyKeys(s, ['input', 'expect'], 'selfTest', errs);
  requireKeys(s, ['input', 'expect'], 'selfTest', errs);
  if (s.input !== undefined && !isObj(s.input)) errs.push('selfTest.input: must be an object');
  if (s.expect !== undefined) {
    if (!isObj(s.expect)) { errs.push('selfTest.expect: must be an object'); return; }
    onlyKeys(s.expect, ['minResults', 'contains'], 'selfTest.expect', errs);
    if (s.expect.minResults !== undefined && (!isInt(s.expect.minResults) || s.expect.minResults < 0 || s.expect.minResults > 1000)) errs.push('selfTest.expect.minResults: must be an integer from 0 to 1000');
    if (s.expect.contains !== undefined) {
      if (!Array.isArray(s.expect.contains) || s.expect.contains.length > 50) errs.push('selfTest.expect.contains: must be an array of at most 50 {type, value}');
      else s.expect.contains.forEach((c, i) => { if (!isObj(c) || Object.keys(c).some((k) => k !== 'type' && k !== 'value') || !isStr(c.type, 1, 40) || !isStr(c.value, 1, 2000)) errs.push(`selfTest.expect.contains[${i}]: must be {type, value}`); });
    }
    if (s.expect.minResults === undefined && s.expect.contains === undefined) errs.push('selfTest.expect: needs minResults or contains (a self-test that expects nothing proves nothing)');
  }
}

// Validate a parsed connector.json. Returns { ok, errors[], manifest } (manifest is a frozen deep copy when ok).
function validateManifest(m) {
  const errors = [];
  if (!isObj(m)) return { ok: false, errors: ['manifest must be a JSON object'], manifest: null };
  onlyKeys(m, TOP_KEYS, 'manifest', errors);
  requireKeys(m, TOP_KEYS, 'manifest', errors);
  if (m.id !== undefined && (typeof m.id !== 'string' || !ID_RE.test(m.id))) errors.push('id: must be 1 to 40 characters of a-z, 0-9 and hyphen, not starting or ending with a hyphen');
  if (m.name !== undefined && !isStr(m.name, 1, 80)) errors.push('name: must be 1 to 80 characters');
  if (m.version !== undefined && (typeof m.version !== 'string' || m.version.length > 64 || !SEMVER_RE.test(m.version))) errors.push('version: must be a semantic version such as 1.0.0');
  if (m.description !== undefined && !isStr(m.description, 1, 500)) errors.push('description: must be 1 to 500 characters');
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities) || !m.capabilities.length || m.capabilities.length > 20 || !m.capabilities.every((c) => typeof c === 'string' && CAP_RE.test(c)) || new Set(m.capabilities).size !== m.capabilities.length) errors.push('capabilities: must be 1 to 20 distinct lowercase names');
  }
  if (m.scope !== undefined && !SCOPES.includes(m.scope)) errors.push(`scope: must be one of ${SCOPES.join(', ')}`);
  if (m.network !== undefined && !NETWORKS.includes(m.network)) errors.push(`network: must be one of ${NETWORKS.join(', ')}`);
  if (m.licence !== undefined) {
    if (!isObj(m.licence)) errors.push('licence: must be an object');
    else {
      onlyKeys(m.licence, ['spdx', 'url', 'mode'], 'licence', errors);
      requireKeys(m.licence, ['spdx', 'url', 'mode'], 'licence', errors);
      if (m.licence.spdx !== undefined && (typeof m.licence.spdx !== 'string' || !/^[A-Za-z0-9.+() -]{1,100}$/.test(m.licence.spdx))) errors.push('licence.spdx: must be an SPDX identifier such as MIT or GPL-3.0-only');
      if (m.licence.url !== undefined && (typeof m.licence.url !== 'string' || m.licence.url.length > 300 || !/^https:\/\/[^\s<>"'`\\]+$/.test(m.licence.url))) errors.push('licence.url: must be an https address');
      if (m.licence.mode !== undefined && !['bundled', 'separate-program'].includes(m.licence.mode)) errors.push('licence.mode: must be bundled or separate-program');
    }
  }
  if (m.installRequirements !== undefined) {
    if (!Array.isArray(m.installRequirements) || m.installRequirements.length > 10) errors.push('installRequirements: must be an array of at most 10');
    else m.installRequirements.forEach((r, i) => validateRequirement(r, i, errors));
  }
  // input schema first: the command's placeholders must name its fields
  let fieldNames = [];
  if (m.input !== undefined) {
    if (!isObj(m.input)) errors.push('input: must be an object');
    else {
      onlyKeys(m.input, ['fields'], 'input', errors);
      if (!Array.isArray(m.input.fields) || m.input.fields.length > 16) errors.push('input.fields: must be an array of at most 16 fields');
      else {
        m.input.fields.forEach((f, i) => validateInputField(f, i, errors));
        fieldNames = m.input.fields.map((f) => f && f.name).filter((n) => typeof n === 'string');
        if (new Set(fieldNames).size !== fieldNames.length) errors.push('input.fields: names must be unique');
      }
    }
  }
  if (m.command !== undefined) validateCommand(m.command, fieldNames, errors);
  if (m.output !== undefined) {
    if (!isObj(m.output)) errors.push('output: must be an object');
    else { onlyKeys(m.output, ['format'], 'output', errors); if (m.output.format !== 'jsonl') errors.push('output.format: must be "jsonl" (JSON lines on stdout)'); }
  }
  if (m.limits !== undefined) {
    if (!isObj(m.limits)) errors.push('limits: must be an object');
    else {
      onlyKeys(m.limits, ['timeoutMs', 'maxOutputBytes', 'maxMemoryMb', 'maxConcurrent'], 'limits', errors);
      requireKeys(m.limits, ['timeoutMs', 'maxOutputBytes', 'maxConcurrent'], 'limits', errors);
      for (const k of ['timeoutMs', 'maxOutputBytes', 'maxMemoryMb', 'maxConcurrent']) {
        const v = m.limits[k];
        if (v !== undefined && (!isInt(v) || v < (k === 'timeoutMs' ? 100 : k === 'maxMemoryMb' ? 16 : 1) || v > LIMIT_MAX[k])) errors.push(`limits.${k}: must be an integer up to ${LIMIT_MAX[k]}`);
      }
    }
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.length > PERMISSIONS.length || !m.permissions.every((p) => PERMISSIONS.includes(p)) || new Set(m.permissions).size !== m.permissions.length) errors.push(`permissions: must be distinct values from ${PERMISSIONS.join(', ')}`);
  }
  if (m.externalRestrictions !== undefined && !isStr(m.externalRestrictions, 1, 1000)) errors.push('externalRestrictions: must be 1 to 1000 characters (write "None" if there are none)');
  if (m.selfTest !== undefined) validateSelfTest(m.selfTest, errors);

  // cross-field rules
  if (!errors.length) {
    const net = m.network === 'keyless-external' || m.network === 'rate-limited';
    if (net && !m.permissions.includes('network')) errors.push('permissions: a connector with external network use must declare "network"');
    if (!net && m.permissions.includes('network')) errors.push('permissions: "network" is declared but network is ' + m.network);
    if (m.input.fields.some((f) => f.type === 'file') && !m.permissions.includes('read-picked-file')) errors.push('permissions: a file input needs "read-picked-file"');
    if (m.scope === 'local' && net) errors.push('scope: a local-scope connector cannot use the external network');
    const st = validateInput(m, m.selfTest.input);
    if (!st.ok) errors.push(...st.errors.map((e) => 'selfTest.' + e));
    if (m.selfTest.input && Object.keys(m.selfTest.input).some((k) => (m.input.fields.find((f) => f.name === k) || {}).type === 'file')) errors.push('selfTest.input: cannot use a file field (a self-test must not depend on a picked file)');
  }
  if (errors.length) return { ok: false, errors, manifest: null };
  return { ok: true, errors: [], manifest: deepFreeze(JSON.parse(JSON.stringify(m))) };
}
function deepFreeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; }

// Build the argv from the template and validated values. Every element is ONE argument: values are never split or interpreted.
// Returns {ok, args} or {ok:false, error}.
function expandArgs(manifest, values) {
  const out = [];
  const fields = Object.fromEntries(manifest.input.fields.map((f) => [f.name, f]));
  for (const t of manifest.command.args) {
    const whole = /^\{([^{}]*)\}$/.exec(t);
    let skip = false;
    const s = t.replace(PLACEHOLDER_RE, (_m, n) => {
      const v = values[n];
      if (v === undefined) { skip = true; return ''; }
      const str = String(v);
      if (whole && fields[n].type !== 'integer' && fields[n].type !== 'file' && str.startsWith('-') && !(fields[n].type === 'string' && fields[n].allowLeadingDash)) throw new Error(`input.${n}: must not start with "-"`);
      return str;
    });
    if (skip) continue;                    // an optional field that was left out drops the argument that names it
    out.push(s);
  }
  return { ok: true, args: out };
}
function safeExpandArgs(manifest, values) {
  try { return expandArgs(manifest, values); } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { ID_RE, SEMVER_RE, HOST_RE, SCOPES, NETWORKS, PERMISSIONS, FIELD_TYPES, NODE_TOKEN, TOP_KEYS, validateManifest, validateInput, checkFieldValue, expandArgs: safeExpandArgs, relPathError, isObj };
