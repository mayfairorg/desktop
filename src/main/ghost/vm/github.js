'use strict';
// Ghost virtual computer: working with a GitHub repository INSIDE the machine ("Run from GitHub" and the tool installer).
//   clone     init + fetch of one commit (depth 1) + detached checkout, with hooks and file/ext protocols off, no submodules, no prompts.
//             The commit is resolved and pinned; the pin is written next to the files.
//   inspect   one fixed read-only script lists the files and prints a few small text files (README, licence, manifests). Nothing is run.
//   suggest   install and run commands built from fixed templates for what was detected (python, node, go, rust, make). They are SHOWN.
//             Ghost never runs them by itself: the person clicks (or types them) after reading them. The text of a README is never turned
//             into a command, and no repository is named, listed or recommended anywhere in this file.
const { ToolHost } = require('../terminal/addtool');

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const SCRIPT_NAME = /^[A-Za-z0-9:_.-]{1,40}$/;
const slugName = (owner, repo) => (owner + '-' + repo).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);

function parseRepo(url, ref) {
  const p = ToolHost.parseRepo(url, ref);
  if (!p) return null;
  const name = slugName(p.owner, p.repo);
  if (!SAFE_NAME.test(name)) return null;
  return { ...p, name, https: 'https://github.com/' + p.owner + '/' + p.repo };
}

// Fixed script, one argument (the folder). No input from the repository reaches the shell as code.
const INSPECT = [
  'cd "$1" || exit 3',
  'echo "@@files"; ls -1A | head -200',
  'for f in README* readme* Readme*; do [ -f "$f" ] && { echo "@@readme $f"; head -c 6000 "$f"; echo; break; }; done',
  'for f in LICENSE* LICENCE* COPYING* license* licence*; do [ -f "$f" ] && { echo "@@licence $f"; head -c 4000 "$f"; echo; break; }; done',
  'for f in package.json pyproject.toml requirements.txt go.mod Cargo.toml connector.json; do [ -f "$f" ] && { echo "@@file $f"; head -c 20000 "$f"; echo; }; done',
  'for f in Makefile; do [ -f "$f" ] && { echo "@@file $f"; head -c 4000 "$f"; echo; }; done',
  'echo "@@commit"; git rev-parse HEAD 2>/dev/null',
].join('\n');

function parseInspect(text) {
  const out = { files: [], readme: null, licence: null, texts: {}, commit: '' };
  let cur = null, buf = [];
  const flush = () => {
    if (!cur) return;
    const body = buf.join('\n').replace(/\0/g, '');
    if (cur.k === 'files') out.files = body.split('\n').filter(Boolean);
    else if (cur.k === 'readme') out.readme = { name: cur.n, text: body.slice(0, 6000) };
    else if (cur.k === 'licence') out.licence = { name: cur.n, text: body.slice(0, 4000) };
    else if (cur.k === 'file') out.texts[cur.n] = body;
    else if (cur.k === 'commit') out.commit = body.trim().split('\n')[0] || '';
    buf = [];
  };
  for (const line of String(text).split('\n')) {
    const m = /^@@(files|readme|licence|file|commit)(?: (.{1,100}))?$/.exec(line);
    if (m) { flush(); cur = { k: m[1], n: m[2] || '' }; } else if (cur) buf.push(line);
  }
  flush();
  return out;
}

function jsonOr(text) { try { return JSON.parse(text); } catch { return null; } }

function detect(ins) {
  const has = (n) => ins.files.includes(n) || n in ins.texts;
  const found = [];
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py') || has('setup.cfg')) found.push('python');
  if (has('package.json')) found.push('node');
  if (has('go.mod')) found.push('go');
  if (has('Cargo.toml')) found.push('rust');
  if (has('Makefile') && !found.length) found.push('make');
  return found;
}

// -> [{id, label, runtime, kind: 'setup'|'run', cwd, argv, command, note}]. `programs`: {name: bool} of what the machine has (optional).
// argv and cwd are what runs (an argument list, no shell); command is the same thing written out for the person to read, copy or type.
function suggest(ins, dir, programs = {}) {
  if (!/^\/(home\/ghost\/src|opt\/ghost-tools)\/[a-z0-9._-]{1,60}$/.test(dir)) throw new Error('bad folder');
  const has = (n) => ins.files.includes(n) || n in ins.texts;
  const out = [];
  const add = (runtime, kind, label, argv, note = '') => out.push({ id: runtime + '-' + out.length, label, runtime, kind, cwd: dir, argv, command: 'cd ' + dir + ' && ' + argv.join(' '), note });
  const missing = (p, hint) => (programs[p] === false ? ' ' + hint : '');
  for (const rt of detect(ins)) {
    if (rt === 'python') {
      add('python', 'setup', 'Create a Python environment', ['python3', '-m', 'venv', '.venv'], 'Keeps this tool\'s packages in its own folder.');
      if (has('requirements.txt')) add('python', 'setup', 'Install requirements', ['.venv/bin/pip', 'install', '-r', 'requirements.txt'], 'Downloads packages through the route you chose. Some packages run build code.');
      else if (has('pyproject.toml') || has('setup.py')) add('python', 'setup', 'Install the project', ['.venv/bin/pip', 'install', '.'], 'Runs the project\'s own build code inside the virtual computer.');
      const sec = /\[project\.scripts\]([\s\S]*?)(\n\[|$)/.exec(ins.texts['pyproject.toml'] || '');
      const names = sec ? [...sec[1].matchAll(/^\s*([A-Za-z0-9_.-]{1,40})\s*=/gm)].map((m) => m[1]).filter((n) => SCRIPT_NAME.test(n)).slice(0, 3) : [];
      for (const n of names) add('python', 'run', 'Run ' + n, ['.venv/bin/' + n, '--help']);
      if (!names.length) for (const f of ['main.py', 'app.py', '__main__.py']) if (has(f)) { add('python', 'run', 'Run ' + f, ['.venv/bin/python', f, '--help']); break; }
    } else if (rt === 'node') {
      const pj = jsonOr(ins.texts['package.json']) || {};
      add('node', 'setup', 'Install packages', has('package-lock.json') ? ['npm', 'ci'] : ['npm', 'install'], 'Runs the project\'s install scripts inside the virtual computer.');
      const scripts = pj && typeof pj.scripts === 'object' && pj.scripts ? Object.keys(pj.scripts).filter((k) => SCRIPT_NAME.test(k)) : [];
      if (scripts.includes('build')) add('node', 'setup', 'Build', ['npm', 'run', 'build']);
      if (scripts.includes('start')) add('node', 'run', 'Start', ['npm', 'start']);
      else if (typeof pj.bin === 'string' && /^[A-Za-z0-9._\/-]{1,80}$/.test(pj.bin) && !pj.bin.includes('..') && !pj.bin.startsWith('/')) add('node', 'run', 'Run the command', ['node', pj.bin, '--help']);
    } else if (rt === 'go') {
      add('go', 'setup', 'Build', ['go', 'build', './...'], 'Downloads Go modules through the route you chose.' + missing('go', 'Go is not installed in this machine.'));
      add('go', 'run', 'Run', ['go', 'run', '.', '--help']);
    } else if (rt === 'rust') {
      add('rust', 'setup', 'Build', ['cargo', 'build', '--release'], 'Downloads crates through the route you chose.' + missing('cargo', 'Rust is not in the base image: install it first with "doas apk add cargo".'));
      add('rust', 'run', 'Run', ['cargo', 'run', '--release', '--', '--help']);
    } else if (rt === 'make') {
      add('make', 'setup', 'Build', ['make'], 'Runs the project\'s Makefile.');
    }
  }
  return out;
}

const PROGRAMS = ['git', 'python3', 'pip', 'pipx', 'node', 'npm', 'go', 'cargo', 'gcc', 'make', 'curl', 'jq', 'unzip'];
const PROBE = 'for p in ' + PROGRAMS.join(' ') + '; do printf "%s=%s\\n" "$p" "$(command -v $p 2>/dev/null)"; done';
async function probePrograms(vm) {
  const r = await vm.runArgv(['sh', '-c', PROBE], { timeoutMs: 15000 });
  const out = {};
  for (const l of r.stdout.split('\n')) { const m = /^([a-z0-9]+)=(.*)$/.exec(l); if (m) out[m[1]] = !!m[2]; }
  return out;
}

// Clone one commit into dest (an absolute folder inside the machine). Returns {commit}. Throws a plain error.
async function cloneInto(vm, p, dest, { onStep = () => {} } = {}) {
  const run = async (label, argv, ms = 300000) => {
    onStep(label);
    const r = await vm.runArgv(argv, { timeoutMs: ms });
    if (r.code !== 0) throw new Error(label + ' failed: ' + (r.stderr.trim().split('\n').pop() || 'exit code ' + r.code).slice(0, 240));
    return r;
  };
  await vm.agent.rmtree(dest).catch(() => {});
  const git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'advice.detachedHead=false'];
  await run('Preparing the folder', ['mkdir', '-p', dest]);
  await run('Starting a repository', [...git, '-C', dest, 'init', '-q']);
  await run('Setting the address', [...git, '-C', dest, 'remote', 'add', 'origin', p.https + '.git']);
  await run('Downloading the commit', [...git, '-C', dest, 'fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', p.ref]);
  await run('Checking it out', [...git, '-C', dest, 'checkout', '-q', '--detach', 'FETCH_HEAD']);
  const r = await run('Reading the commit', [...git, '-C', dest, 'rev-parse', 'HEAD'], 20000);
  const commit = r.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('could not resolve a commit');
  const pin = { type: 'github', repo: p.owner + '/' + p.repo, requestedRef: p.ref, commit, fetchedAt: new Date().toISOString() };
  await vm.agent.put(dest + '/.ghost-pin.json', JSON.stringify(pin, null, 2) + '\n');
  return { commit, pin };
}

async function inspectDir(vm, dest) {
  const r = await vm.runArgv(['sh', '-c', INSPECT, 'sh', dest], { timeoutMs: 30000, maxBytes: 512 * 1024 });
  if (r.code !== 0) throw new Error('could not read the folder');
  return parseInspect(r.stdout);
}

module.exports = { parseRepo, slugName, parseInspect, detect, suggest, probePrograms, cloneInto, inspectDir, INSPECT, PROGRAMS, SAFE_NAME };
