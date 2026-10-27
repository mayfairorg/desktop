'use strict';
// Ghost virtual computer: "Run from GitHub" in the terminal window. Paste a repository address: Ghost clones ONE commit inside the machine
// (/home/ghost/src/<name>, the commit is resolved and shown), looks at what is there (README, licence, manifests) without running anything,
// detects python, node, go, rust or make, and SHOWS the install and run commands built from fixed templates. Nothing is run by this module:
// the person copies a command, or has it typed at the prompt (without pressing Enter), and reads it first.
// The page can only ask for commands by the id this module gave them; it never supplies one.
const GH = require('./github');

const HOME_SRC = '/home/ghost/src';

class RunFromGithub {
  constructor({ vm }) { this.vm = vm; this.busy = false; this.last = new Map(); }
  // -> {ok, name, dir, commit, source, readme, licenceFile, files, detected, suggestions:[{id, label, runtime, kind, command, note}], replaced}
  async clone({ url, ref } = {}) {
    if (this.busy) return { ok: false, code: 'busy', error: 'A clone is already running.' };
    const p = GH.parseRepo(url, ref);
    if (!p) return { ok: false, code: 'bad-url', error: 'Enter a GitHub repository address: https://github.com/owner/repo (and optionally a tag, branch or commit).' };
    this.busy = true;
    try {
      await this.vm.ensureRunning();
      const dir = HOME_SRC + '/' + p.name;
      const had = await this.vm.runArgv(['test', '-d', dir], { timeoutMs: 10000 });
      let got;
      try { got = await GH.cloneInto(this.vm, p, dir); } catch (e) { return { ok: false, code: 'clone-failed', error: String((e && e.message) || e).slice(0, 300) }; }
      const ins = await GH.inspectDir(this.vm, dir);
      let programs = {}; try { programs = await GH.probePrograms(this.vm); } catch { /* unknown */ }
      const suggestions = GH.suggest(ins, dir, programs);
      this.last.set(p.name, suggestions);
      return { ok: true, name: p.name, dir, commit: got.commit, source: { repo: p.owner + '/' + p.repo, ref: p.ref }, readme: ins.readme, licenceFile: ins.licence, files: ins.files.slice(0, 100),
        detected: GH.detect(ins), suggestions: suggestions.map((s) => ({ id: s.id, label: s.label, runtime: s.runtime, kind: s.kind, command: s.command, note: s.note })), replaced: had.code === 0,
        note: 'Cloned at the commit shown. Nothing has been run. Read the commands, then copy one or have it typed at the prompt.' };
    } catch (e) { return { ok: false, code: e.code || 'error', error: String((e && e.message) || e).slice(0, 300) }; } finally { this.busy = false; }
  }
  // The text of one suggested command, for typing at the prompt (no Enter) or copying. Looked up by id, never taken from the page.
  commandText({ name, id }) {
    const s = (this.last.get(name) || []).find((x) => x.id === id);
    return s ? { ok: true, command: s.command } : { ok: false, code: 'not-found', error: 'Unknown command: clone the repository again.' };
  }
}
module.exports = { RunFromGithub, HOME_SRC };
