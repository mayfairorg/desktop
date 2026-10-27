'use strict';
// Ghost entity forms: the Add entity dialog (with the Person form), custom fields on every entity, link labels, and case file export / import / merge.
// Nothing here checks what a title, value or label says: any text is accepted on every entity type, Person included. Every change goes through GH.cs.mutate so it can be undone.
(function () {
  const GH = window.GH, h = GH.h, M = window.GhostCase;
  GH.TYPE_LABEL.person = 'Person'; GH.TYPE_PLURAL.person = 'People';

  const REL_LABEL = { 'ceo-of': 'CEO of', 'director-of': 'director of', 'owner-of': 'owner of', 'works-with': 'works with', custom: 'other (own label)' };
  const relName = (rel) => REL_LABEL[rel] || rel;
  // How a link reads: its own label when it has one, else the relation.
  GH.relText = (edge) => (edge.label ? edge.label : relName(edge.rel));
  const KIND_LABEL = { text: 'Text', longtext: 'Long text', link: 'Link', date: 'Date', number: 'Number' };

  // The control that edits a value of the given kind. Dates use the date picker only while the value is a plain date, so nothing typed earlier is lost.
  function valueControl(kind, value, id) {
    const v = String(value || '');
    if (kind === 'longtext') { const t = h('textarea', { id, rows: '5', maxlength: String(M.LIMITS.fieldValue) }); t.value = v; return t; }
    if (kind === 'date' && (!v || /^\d{4}-\d{2}-\d{2}$/.test(v))) return h('input', { id, type: 'date', value: v });
    const i = h('input', { id, type: 'text', maxlength: String(M.LIMITS.fieldValue), spellcheck: 'false', autocomplete: 'off', ...(kind === 'number' ? { inputmode: 'decimal' } : {}), ...(kind === 'link' ? { placeholder: 'https://' } : {}) });
    i.value = v; return i;
  }

  // One dialog for adding and editing a field. -> { title, value, kind, source } or null.
  async function fieldDialog(f, opts = {}) {
    const title = h('input', { id: 'fd-title', type: 'text', maxlength: String(M.LIMITS.fieldTitle), 'data-autofocus': '', list: 'fd-sugg', autocomplete: 'off' }); title.value = f.title || '';
    const sugg = h('datalist', { id: 'fd-sugg' }, (opts.suggest || []).map((x) => h('option', { value: x })));
    const kind = h('select', { id: 'fd-kind' }, M.FIELD_KINDS.map((k) => h('option', { value: k, selected: k === (f.kind || 'text') }, KIND_LABEL[k])));
    const source = h('input', { id: 'fd-src', type: 'text', maxlength: String(M.LIMITS.fieldSource), autocomplete: 'off' }); source.value = f.source || '';
    const slot = h('div', {}); let val = valueControl(f.kind || 'text', f.value, 'fd-val');
    const draw = () => { GH.clear(slot).append(GH.field('Value', val)); };
    kind.addEventListener('change', () => { const keep = val.value; val = valueControl(kind.value, keep, 'fd-val'); draw(); });
    draw();
    const r = await GH.dialog({ title: opts.title || 'Field', sub: 'Any title, any value. The time you record it is kept with it.', body: h('div', { class: 'stack' }, GH.field('Title', title), sugg, GH.field('Type', kind), slot, GH.field('Where you found it (optional)', source, 'A name, address or note. Kept with the field.')), actions: [{ label: 'Cancel', value: false }, { label: opts.ok || 'Save', primary: true, value: true }] });
    return r === true ? { title: title.value.trim(), value: val.value, kind: kind.value, source: source.value.trim() } : null;
  }

  // ---------- the Add entity dialog ----------
  // -> the id of the new (or merged) entity, or null when the person cancelled.
  async function addEntity() {
    const type = h('select', { id: 'ae-type' }, M.ENTITY_TYPES.filter((t) => t !== 'email').map((t) => h('option', { value: t, selected: t === 'domain' }, GH.TYPE_LABEL[t])));
    const val = h('input', { id: 'ae-val', type: 'text', maxlength: '500', 'data-autofocus': '', spellcheck: 'false' }), note = h('input', { id: 'ae-note', type: 'text', maxlength: '300' });
    const valField = h('div', {}), noteField = GH.field('Note (optional)', note);
    const pf = {}; // person form
    pf.role = h('input', { id: 'ap-role', type: 'text', maxlength: '300' }); pf.orgs = h('input', { id: 'ap-orgs', type: 'text', maxlength: '500' }); pf.date = h('input', { id: 'ap-date', type: 'date' });
    pf.link = h('input', { id: 'ap-link', type: 'text', maxlength: '500', placeholder: 'https://', spellcheck: 'false' }); pf.src = h('input', { id: 'ap-src', type: 'text', maxlength: String(M.LIMITS.fieldSource) });
    const personBox = h('div', { class: 'stack' }, GH.field('Role / title', pf.role), GH.field('Organisation(s)', pf.orgs, 'Add the organisation to the board too, then link it with "CEO of", "director of" or "owner of".'), GH.field('Appointed date', pf.date), GH.field('Public profile link', pf.link),
      GH.field('Source', pf.src, 'Where you found these details. It is recorded against each one, with the time. You can add more fields in the inspector.'));
    const sync = () => { const p = type.value === 'person'; GH.clear(valField).append(GH.field(p ? 'Name' : 'Value', val)); noteField.hidden = p; personBox.hidden = !p; };
    type.addEventListener('change', sync); sync();
    const r = await GH.dialog({ title: 'Add an entity', sub: 'Added by hand and marked that way. For anything a connector can find, use a module so the source is kept.', body: h('div', { class: 'stack' }, GH.field('Type', type), valField, noteField, personBox), actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }] });
    if (r !== true || !val.value.trim()) return null;
    let res;
    GH.cs.mutate('Add entity', (x) => {
      const now = new Date().toISOString();
      if (type.value === 'person') {
        const fields = [['Role / title', pf.role.value.trim(), 'text'], ['Organisation(s)', pf.orgs.value.trim(), 'text'], ['Appointed date', pf.date.value, 'date'], ['Public profile link', pf.link.value.trim(), 'link']].filter((f) => f[1]).map(([title, value, kind]) => ({ title, value, kind, source: pf.src.value.trim(), t: now }));
        res = M.addEntity(x, { type: 'person', value: val.value.trim(), manual: true, duplicate: true, fields });
      } else res = M.addEntity(x, { type: type.value, value: val.value.trim(), manual: true, attrs: note.value.trim() ? { note: note.value.trim() } : {} });
      M.layout(x);
    });
    if (res && res.error) { GH.toast(res.error); return null; }
    return res && res.id ? res.id : null;
  }

  // ---------- custom fields in the inspector ----------
  function valueNode(f) {
    if (f.kind === 'longtext') return h('div', { class: 'fld-long' }, String(f.value).split('\n').map((l, i) => [i ? h('br') : null, l]));
    return h('span', { class: f.kind === 'text' ? '' : 'mono' }, String(f.value));
  }
  function fieldsSection(e) {
    const list = M.fieldsOf(e), sug = e.type === 'person' ? M.PERSON_SUGGESTED.map((x) => x.title) : [];
    const add = async () => {
      const f = await fieldDialog({ kind: 'text' }, { title: 'Add a field', ok: 'Add field', suggest: [...sug, ...[...new Set(Object.values(GH.cs.current().entities).flatMap((x) => M.fieldsOf(x).map((y) => y.title)))].slice(0, 60)] });
      if (!f) return;
      const pre = e.type === 'person' ? M.PERSON_SUGGESTED.find((x) => x.title === f.title) : null;
      GH.cs.mutate('Add field', (x) => M.addField(x, e.id, { ...f, kind: pre && f.kind === 'text' ? pre.kind : f.kind }));
    };
    const edit = async (f) => { const r = await fieldDialog(f, { title: 'Edit field' }); if (r) GH.cs.mutate('Edit field', (x) => M.updateField(x, e.id, f.id, r)); };
    const quickRename = (f) => { const t = h('input', { id: 'fr-t', type: 'text', maxlength: String(M.LIMITS.fieldTitle), 'data-autofocus': '' }); t.value = f.title; return GH.dialog({ title: 'Rename field', body: GH.field('Title', t), actions: [{ label: 'Cancel', value: false }, { label: 'Rename', primary: true, value: true }] }).then((ok) => { if (ok === true) GH.cs.mutate('Rename field', (x) => M.updateField(x, e.id, f.id, { title: t.value.trim() })); }); };
    const rows = list.map((f, i) => h('li', { class: 'fld-row', 'data-field': f.id },
      h('div', { class: 'fld-main' }, h('b', {}, f.title || '(no title)'), ' ', valueNode(f), ' ', h('span', { class: 'mute sm mono' }, KIND_LABEL[f.kind] || f.kind)),
      h('div', { class: 'mute sm mono' }, [f.source ? 'source: ' + f.source : 'no source noted', 'recorded ' + GH.fmtTime(f.t), f.updated && f.updated !== f.t ? 'changed ' + GH.fmtTime(f.updated) : ''].filter(Boolean).join(' · ')),
      h('div', { class: 'row-a wrap' },
        GH.btn('Edit', { ghost: true, onclick: () => edit(f) }), GH.btn('Rename', { ghost: true, onclick: () => quickRename(f) }),
        GH.btn('Up', { ghost: true, disabled: i === 0, title: 'Move this field up', onclick: () => GH.cs.mutate('Reorder fields', (x) => M.moveField(x, e.id, f.id, 'up')) }),
        GH.btn('Down', { ghost: true, disabled: i === list.length - 1, title: 'Move this field down', onclick: () => GH.cs.mutate('Reorder fields', (x) => M.moveField(x, e.id, f.id, 'down')) }),
        GH.btn('', { icon: 'trash', ghost: true, title: 'Delete field ' + f.title, 'aria-label': 'Delete field ' + f.title, onclick: () => GH.cs.mutate('Delete field', (x) => M.removeField(x, e.id, f.id)) }))));
    return [h('h3', {}, 'Fields ' + list.length), list.length ? h('ul', { class: 'plain fields' }, rows) : h('p', { class: 'mute sm' }, e.type === 'person' ? 'No fields yet. Add a role, an organisation, an appointed date or a profile link, with where you found it.' : 'No custom fields. Add any title and value you need.'),
      h('div', { class: 'row-a wrap' }, GH.btn('Add field', { icon: 'plus', onclick: add }))];
  }

  // ---------- links ----------
  async function linkForm(opts) {
    const rel = h('select', { id: 'lk-rel' }, M.REL.map((x) => h('option', { value: x, selected: x === (opts.rel || 'linked-to') }, relName(x))));
    const label = h('input', { id: 'lk-label', type: 'text', maxlength: String(M.LIMITS.edgeLabel), autocomplete: 'off' }); label.value = opts.label || '';
    const src = h('input', { id: 'lk-src', type: 'text', maxlength: String(M.LIMITS.fieldSource), autocomplete: 'off' }); src.value = opts.sourceNote || '';
    label.addEventListener('input', () => { if (label.value.trim() && rel.value === 'linked-to') rel.value = 'custom'; });
    return { rel, label, src, nodes: [opts.to ? GH.field('To', opts.to) : null, GH.field('Relation', rel), GH.field('Own label (optional)', label, 'For example "former chair of". It is shown instead of the relation.'), GH.field('Where you found it (optional)', src)] };
  }
  async function linkDialog(from) {
    const cs = GH.cs.current(), ents = Object.values(cs.entities).filter((e) => e.id !== from).sort((a, b) => a.label.localeCompare(b.label)); if (!ents.length) { GH.toast('There is nothing else to link to.'); return; }
    const to = h('select', { id: 'lk-to' }, ents.map((e) => h('option', { value: e.id }, GH.TYPE_LABEL[e.type] + ': ' + e.label.slice(0, 60))));
    const f = await linkForm({ to });
    const r = await GH.dialog({ title: 'Link entities', sub: 'A link you make yourself is marked as added by hand.', body: h('div', { class: 'stack' }, f.nodes), actions: [{ label: 'Cancel', value: false }, { label: 'Add link', primary: true, value: true }] });
    if (r === true) GH.cs.mutate('Add link', (x) => M.addEdge(x, { from, to: to.value, rel: f.rel.value, label: f.label.value, sourceNote: f.src.value.trim(), manual: true }));
  }
  async function editLinkDialog(edge) {
    const f = await linkForm({ rel: edge.rel, label: edge.label, sourceNote: edge.sourceNote });
    const r = await GH.dialog({ title: 'Edit link', body: h('div', { class: 'stack' }, f.nodes), actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }] });
    if (r !== true) return;
    let ok = true; GH.cs.mutate('Edit link', (x) => { ok = M.updateEdge(x, edge.id, { rel: f.rel.value, label: f.label.value, sourceNote: f.src.value.trim() }); });
    if (!ok) GH.toast('That link already exists.');
  }

  // ---------- case file: export, import, merge ----------
  async function exportCase() {
    await GH.cs.flush();
    try { const res = await GH.call(GH.api.cases.exportJson, JSON.stringify(GH.cs.current())); GH.toast(res && res.saved === false ? 'Not saved.' : 'Case file saved.'); } catch (x) { GH.toast(GH.errText(x), 'err'); }
  }
  async function importCase() {
    let r; try { r = await GH.call(GH.api.cases.importPick); } catch (x) { GH.toast(GH.errText(x), 'err'); return; }
    if (!r || r.picked === false) return;
    const got = M.importJson(r.text);
    if (!got.case) { GH.toast('That file was not added: ' + got.problems[0], 'err'); return; }
    const inc = got.case, n = Object.keys(inc.entities).length;
    const ok = await GH.confirm('Merge "' + inc.title + '" into this case?', GH.plural(n, 'entity', 'entities') + ' and ' + GH.plural(Object.keys(inc.edges).length, 'link') + ' from ' + r.name + '. Entities that match are combined and their fields are kept. You can undo this with Undo.', 'Merge', false);
    if (!ok) return;
    let out; GH.cs.mutate('Merge case file', (x) => { out = M.mergeCase(x, inc); M.layout(x); });
    GH.toast('Merged: ' + GH.plural(out.entitiesAdded, 'new entity', 'new entities') + ', ' + out.entitiesMerged + ' combined, ' + GH.plural(out.fieldsAdded, 'field') + ', ' + GH.plural(out.linksAdded, 'link') + (out.skipped ? ', ' + out.skipped + ' skipped' : '') + '.');
  }

  GH.entityUI = { addEntity, fieldsSection, fieldDialog, linkDialog, editLinkDialog, exportCase, importCase };
})();
