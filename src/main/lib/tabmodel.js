'use strict';
// Ordered tab list. Tab 0 is the pinned Mayfair desktop: it cannot be closed or moved.
class TabModel {
  constructor() { this.tabs = []; this.activeId = null; this.seq = 0; }
  add({ pinned = false, private: priv = false, url = '', activate = true, afterActive = false, appId = null, tor = false } = {}) {
    if (pinned && this.tabs.some((t) => t.pinned)) throw new Error('only one pinned tab');
    const tab = { id: ++this.seq, pinned, private: priv, url, title: '', appId, tor };
    if (pinned) this.tabs.unshift(tab);
    else if (afterActive && this.activeId != null) {
      const i = this.index(this.activeId);
      this.tabs.splice(Math.max(i + 1, this.tabs.some((t) => t.pinned) ? 1 : 0), 0, tab);
    } else this.tabs.push(tab);
    if (activate || this.activeId == null) this.activeId = tab.id;
    return tab;
  }
  index(id) { return this.tabs.findIndex((t) => t.id === id); }
  get(id) { return this.tabs.find((t) => t.id === id) || null; }
  active() { return this.get(this.activeId); }
  activate(id) { if (!this.get(id)) return false; this.activeId = id; return true; }
  close(id) {
    const i = this.index(id);
    if (i < 0 || this.tabs[i].pinned) return { closed: false };
    const wasActive = this.activeId === id;
    const [tab] = this.tabs.splice(i, 1);
    if (wasActive) this.activeId = (this.tabs[i] || this.tabs[i - 1] || this.tabs[0] || {}).id ?? null;
    return { closed: true, tab, activeId: this.activeId };
  }
  closeOthers(id) {
    const keep = this.get(id);
    const removed = this.tabs.filter((t) => !t.pinned && t.id !== id);
    this.tabs = this.tabs.filter((t) => t.pinned || t.id === id);
    if (!this.get(this.activeId)) this.activeId = keep ? keep.id : (this.tabs[0] || {}).id ?? null;
    return removed;
  }
  move(id, toIndex) {
    const i = this.index(id);
    if (i < 0 || this.tabs[i].pinned) return false;
    const min = this.tabs.some((t) => t.pinned) ? 1 : 0;
    const to = Math.max(min, Math.min(this.tabs.length - 1, toIndex));
    const [t] = this.tabs.splice(i, 1);
    this.tabs.splice(to, 0, t);
    return true;
  }
  step(dir) {
    if (!this.tabs.length) return null;
    const i = this.index(this.activeId);
    const n = (i + dir + this.tabs.length) % this.tabs.length;
    this.activeId = this.tabs[n].id;
    return this.activeId;
  }
  hasPrivate() { return this.tabs.some((t) => t.private); }
}
module.exports = { TabModel };
