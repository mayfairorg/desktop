'use strict';
// Ordered list of browser tabs. Pinned tabs (pinned by the user) sit together at the left; every other
// tab follows. The Mayfair view is not a tab: it lives outside this list.
class TabModel {
  // nextId: optional shared id allocator, so several models (one per Browser window group) never hand out the same id
  constructor(nextId) { this.tabs = []; this.activeId = null; this.seq = 0; this.nextId = nextId || (() => ++this.seq); }
  pinnedCount() { let n = 0; while (n < this.tabs.length && this.tabs[n].pinned) n++; return n; }
  add({ pinned = false, private: priv = false, url = '', activate = true, afterActive = false, afterId = null, appId = null, tor = false } = {}) {
    const tab = { id: this.nextId(), pinned: !!pinned, private: priv, url, title: '', appId, tor };
    if (pinned) this.tabs.splice(this.pinnedCount(), 0, tab);
    else if (afterId != null && this.get(afterId)) this.tabs.splice(Math.max(this.index(afterId) + 1, this.pinnedCount()), 0, tab);
    else if (afterActive && this.activeId != null && this.get(this.activeId)) {
      const i = this.index(this.activeId);
      this.tabs.splice(Math.max(i + 1, this.pinnedCount()), 0, tab);
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
    if (i < 0) return { closed: false };
    const wasActive = this.activeId === id;
    const [tab] = this.tabs.splice(i, 1);
    if (wasActive) this.activeId = (this.tabs[i] || this.tabs[i - 1] || {}).id ?? null;
    return { closed: true, tab, activeId: this.activeId };
  }
  // Take a tab out without closing it (moving it to another window group); the neighbour becomes active here.
  detach(id) {
    const i = this.index(id);
    if (i < 0) return null;
    const wasActive = this.activeId === id;
    const [tab] = this.tabs.splice(i, 1);
    if (wasActive) this.activeId = (this.tabs[i] || this.tabs[i - 1] || {}).id ?? null;
    return tab;
  }
  // Put a detached tab in; pinned tabs stay in the pinned block, others never go in front of it. Becomes the active tab.
  attach(tab, index) {
    const p = this.pinnedCount();
    const at = Number.isInteger(index) ? index : this.tabs.length;
    const to = tab.pinned ? Math.max(0, Math.min(p, at)) : Math.max(p, Math.min(this.tabs.length, at));
    this.tabs.splice(to, 0, tab);
    this.activeId = tab.id;
    return to;
  }
  closeOthers(id) {
    const keep = this.get(id);
    if (!keep) return [];
    const removed = this.tabs.filter((t) => t.id !== id && !t.pinned);
    this.tabs = this.tabs.filter((t) => t.id === id || t.pinned);
    if (!this.get(this.activeId)) this.activeId = keep.id;
    return removed;
  }
  pin(id, on) {
    const i = this.index(id);
    if (i < 0) return false;
    const t = this.tabs[i];
    if (!!t.pinned === !!on) return true;
    this.tabs.splice(i, 1);
    t.pinned = !!on;
    this.tabs.splice(this.pinnedCount(), 0, t);   // a pinned tab joins the end of the pinned block; an unpinned one goes right after it
    return true;
  }
  // a tab never crosses the border between the pinned block and the rest
  move(id, toIndex) {
    const i = this.index(id);
    if (i < 0 || !Number.isInteger(toIndex)) return false;
    const t = this.tabs[i];
    const p = this.pinnedCount();
    const lo = t.pinned ? 0 : p, hi = t.pinned ? p - 1 : this.tabs.length - 1;
    const to = Math.max(lo, Math.min(hi, toIndex));
    this.tabs.splice(i, 1);
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
