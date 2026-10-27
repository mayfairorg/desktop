'use strict';
// Ghost look-and-feel settings (skin, light or dark, decorations): one small record in the Ghost vault (section "prefs"), so the choice belongs to this account's vault
// on this computer and is not written anywhere in the clear. Anything that is not a known skin or theme is refused on write and ignored on read.
const Skins = require('../../../ui/ghost/skins');

const NS = 'prefs';
const REC = 'ui';
class PrefError extends Error { constructor(code, message) { super(message); this.code = code; } }

class PrefStore {
  constructor({ vault }) { this.vault = vault; }
  _ready() { this.vault.ensure(); if (!this.vault.unlocked) throw new PrefError('locked', 'The vault is locked.'); }
  get() {
    this._ready(); const b = this.vault.get(NS, REC); if (b === null) return Skins.clean(null);
    try { return Skins.clean(JSON.parse(b.toString('utf8'))); } catch { return Skins.clean(null); }
  }
  // o: { skin?, theme?, deco? }. Fields left out keep their stored value.
  set(o) {
    this._ready();
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new PrefError('bad-pref', 'Those settings could not be read.');
    if (o.skin !== undefined && !Skins.IDS.includes(o.skin)) throw new PrefError('bad-pref', 'That is not a skin.');
    if (o.theme !== undefined && !Skins.THEMES.includes(o.theme)) throw new PrefError('bad-pref', 'That is not a theme.');
    if (o.deco !== undefined && typeof o.deco !== 'boolean') throw new PrefError('bad-pref', 'Those settings could not be read.');
    const next = Skins.clean({ ...this.get(), ...o });
    this.vault.put(NS, REC, JSON.stringify(next));
    return next;
  }
}
module.exports = { PrefStore, PrefError };
