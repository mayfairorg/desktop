'use strict';
// Ghost virtual computer: the terminal window talks to ONE object with the terminal service's surface. This one sends a new terminal to the
// virtual computer by default and to the local terminal only when the window asks for it ("advanced": the page asks, main shows the warning).
// Later calls (input, resize, close...) go to whichever of the two owns that terminal.
class TerminalRouter {
  constructor({ local, vm }) { this.local = local; this.vm = vm; this._emit = () => {}; }
  get toolsDir() { return this.local.toolsDir; }
  get emit() { return this._emit; }
  set emit(fn) { this._emit = fn; this.local.emit = fn; this.vm.emit = fn; }
  async info() { return { ...this.vm.info(), local: { available: true } }; }
  localInfo() { return this.local.info(); }
  open(owner, o = {}) { const { local, ...rest } = o || {}; return local ? this.local.open(owner, rest) : this.vm.open(owner, rest); }
  _svc(id) { return typeof id === 'string' && this.vm.sessions.has(id) ? this.vm : this.local; }
  input(owner, id, d) { return this._svc(id).input(owner, id, d); }
  resize(owner, id, c, r) { return this._svc(id).resize(owner, id, c, r); }
  interrupt(owner, id) { return this._svc(id).interrupt(owner, id); }
  ack(owner, id, n) { return this._svc(id).ack(owner, id, n); }
  close(owner, id) { return this._svc(id).close(owner, id); }
  closeOwner(owner) { this.vm.closeOwner(owner); this.local.closeOwner(owner); }
  count() { return this.vm.count() + this.local.count(); }
  shutdown() { this.local.shutdown(); return this.vm.shutdown(); }
}
module.exports = { TerminalRouter };
