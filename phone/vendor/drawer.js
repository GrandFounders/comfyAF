/**
 * hostKit/shell/drawer.js — the phone form of the Menu and the Ribbon: GuaP's slide-in drawer.
 *
 * It is not a second copy of the menus. Every time it opens it READS the live shell — the menu
 * bar (`#menuBarItems` + each `#<id>MenuDropdown`, hostKit/menubar.js markup, plugin menus from
 * host/menus.js included) and the Ribbon (`.ribbon-tab` / `.ribbon-panel`) — and a tap on a row
 * clicks the real item. So a plugin's menu entries are on the phone with no extra wiring.
 *
 * Look and feel (GuaP/menu/sidebar_mMenu.html): a mode strip at the top that swipes sideways
 * (the app's modes / quick actions), then one collapsible CATEGORY per menu and per ribbon tab,
 * each with 📌 to pin it to the Tools Dock Strip. Both lists are endless (endless.js — with
 * GuaP's four wrap-around bugs fixed).
 *
 * Opens from ☰, or a swipe in from the left edge; closes with ×, a swipe left, a tap outside, Esc.
 */
import { Endless } from './endless.js';

const PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>';

/** The rows of one dropdown, in display order — the same walk menu-tearoff.js does. */
export function menuRows(dropdown) {
  const out = [];
  const content = dropdown && (dropdown.querySelector('.menu-bar-dropdown-content') || dropdown);
  if (!content) return out;
  (function walk(node) {
    for (const c of node.children) {
      const cl = c.classList;
      if (cl.contains('menu-bar-dropdown-sep')) out.push({ kind: 'sep' });
      else if (cl.contains('menu-bar-dropdown-label')) out.push({ kind: 'label', label: c.textContent.trim() });
      else if (cl.contains('menu-bar-dropdown-item')) {
        if (c.offsetParent === null && c.style.display === 'none') continue;    // an item the app has hidden
        const k = c.querySelector('kbd');
        let label = '';
        for (const n of c.childNodes) if (n !== k && !(n.classList && n.classList.contains('ic'))) label += n.textContent;
        const ic = c.querySelector('.ic');
        out.push({ kind: 'item', label: label.trim(), kbd: k ? k.textContent.trim() : '', icon: ic ? ic.textContent.trim() : '', disabled: !!c.disabled, el: c });
      } else if (c.children.length) walk(c);
    }
  })(content);
  return out;
}

/** The ribbon's tabs as categories: each group is a labelled section of buttons / selects. */
export function ribbonCategories(ribbon) {
  if (!ribbon) return [];
  const cats = [];
  for (const tab of ribbon.querySelectorAll('.ribbon-tab[data-tab]')) {
    const id = tab.dataset.tab;
    const panel = ribbon.querySelector('#ribbon-' + CSS.escape(id)) || ribbon.querySelector(`.ribbon-panel[data-tab="${CSS.escape(id)}"]`);
    if (!panel) continue;
    const rows = [];
    const groups = panel.querySelectorAll('.ribbon-group');
    for (const g of (groups.length ? groups : [panel])) {
      const gl = g.querySelector('.ribbon-group-label');
      const name = (gl && gl.textContent.trim()) || g.dataset.label || '';
      if (name) rows.push({ kind: 'label', label: name });
      for (const c of g.querySelectorAll('.ribbon-btn, select, input:not([type=hidden])')) {
        if (c.closest('.ribbon-group-label')) continue;
        if (c.tagName === 'SELECT' || c.tagName === 'INPUT') { rows.push({ kind: 'control', label: c.getAttribute('aria-label') || c.title || c.name || '', el: c }); continue; }
        const label = c.getAttribute('aria-label') || c.title || c.textContent.trim();
        const svg = c.querySelector('svg');
        rows.push({ kind: 'item', label: String(label).replace(/\s*\(.*?\)\s*$/, ''), svgIcon: svg ? svg.outerHTML : '', icon: '', disabled: !!c.disabled, pressed: c.classList.contains('active'), el: c });
      }
    }
    cats.push({ key: 'ribbon:' + id, title: tab.textContent.trim(), rows, ribbon: true });
  }
  return cats;
}

export class ShellDrawer {
  /**
   * @param opts {
   *   doc, appId, brand,
   *   menuBar: element (default .menu-bar), ribbon: element (default .ribbon),
   *   modes: [{ id, label, icon, run }]  — the swipeable strip (GuaP's Edit · Design · Preview …),
   *   activeMode, categories: () => [{ key, title, rows }]  — extra categories,
   *   onPin(category) — default: a `shell:pin` event on document,
   *   side: 'left' (default) | 'right' — which edge it slides in from (and which edge a swipe opens it from),
   *   modeless: bool | () => bool — a SIDE MENU rather than a sheet: no dim, the page stays usable, and a
   *             tap on a row keeps it open (GuaP's desktop drawer). Default: modal.
   * }
   */
  constructor(opts = {}) {
    this.o = opts;
    this.doc = opts.doc || document;
    this.key = (opts.appId || 'shell') + ':drawer';
    this.state = { open: {}, mode: opts.activeMode || (opts.modes && opts.modes[0] && opts.modes[0].id) || null };
    try { Object.assign(this.state.open, JSON.parse(localStorage.getItem(this.key) || '{}').open || {}); } catch (e) { /* storage blocked */ }
    this.isOpen = false;
    this._subs = new Set();
    this._build();
  }

  _el(tag, cls, html) { const n = this.doc.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  isModeless() { const m = this.o.modeless; return typeof m === 'function' ? !!m() : !!m; }
  /** Re-read modeless (the phone rule flipped while it is open). */
  refreshMode() {
    const m = this.isOpen && this.isModeless();
    this.el.classList.toggle('modeless', !!m);
    this.overlay.classList.toggle('open', this.isOpen && !m);
    this.doc.documentElement.classList.toggle('shell-drawer-open', this.isOpen && !m);
  }
  _save() { try { localStorage.setItem(this.key, JSON.stringify({ open: this.state.open })); } catch (e) { /* storage blocked */ } }

  _build() {
    const d = this.doc;
    this.overlay = this._el('div', 'shell-drawer-overlay');
    this.overlay.addEventListener('click', () => this.close());
    this.el = this._el('aside', 'shell-drawer');
    this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-modal', 'true'); this.el.setAttribute('aria-label', 'Menu');
    this.el.tabIndex = -1;
    this.side = this.o.side === 'right' ? 'right' : 'left';
    this.el.dataset.side = this.side;
    const head = this._el('div', 'shell-drawer-head');
    const brand = this._el('div', 'shell-drawer-brand'); brand.textContent = this.o.brand || '';
    const x = this._el('button', 'shell-drawer-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close the menu');
    x.addEventListener('click', () => this.close());
    head.appendChild(brand); head.appendChild(x);
    this.el.appendChild(head);
    if (this.o.modes && this.o.modes.length) {
      this.modesVp = this._el('div', 'shell-drawer-modes');
      this.el.appendChild(this.modesVp);
      this.modes = new Endless(this.modesVp, () => this._renderModes(), { axis: 'x', doc: d });
    }
    this.catsVp = this._el('div', 'shell-drawer-cats');
    this.el.appendChild(this.catsVp);
    this.cats = new Endless(this.catsVp, () => this._renderCats(), { axis: 'y', doc: d });
    d.body.appendChild(this.overlay);
    d.body.appendChild(this.el);
    this._gestures();
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen && !this.isModeless()) this.close(); });
  }

  /** Read the live shell into categories. */
  model() {
    const d = this.doc, cats = [];
    const bar = this.o.menuBar || d.querySelector('.menu-bar');
    const items = bar ? bar.querySelectorAll('.menu-list-item[data-menu]') : [];
    for (const b of items) {
      const id = b.dataset.menu;
      const rows = menuRows(d.getElementById(id + 'MenuDropdown'));
      if (rows.length) cats.push({ key: 'menu:' + id, title: b.textContent.trim(), rows });
    }
    cats.push(...ribbonCategories(this.o.ribbon || d.querySelector('.ribbon')));
    if (typeof this.o.categories === 'function') for (const c of this.o.categories() || []) cats.push(c);
    return cats;
  }

  _renderModes() {
    const strip = this._el('div', 'shell-mode-strip');
    for (const m of this.o.modes) {
      const b = this._el('button', 'shell-mode-btn' + (m.id === this.state.mode ? ' active' : '') + (m.action ? ' shell-mode-action' : '') + (m.danger ? ' danger' : ''));
      b.type = 'button'; b.dataset.key = 'mode:' + m.id;
      b.innerHTML = (m.icon ? `<span class="shell-mode-ic" aria-hidden="true">${m.icon}</span>` : '') + `<span>${esc(m.label)}</span>`;
      b.addEventListener('click', () => {
        if (!m.action) { this.state.mode = m.id; this.modes.refresh({ anchor: b }); }
        if (typeof m.run === 'function') m.run(m.id);
        if (m.closes && !this.isModeless()) this.close();
      });
      strip.appendChild(b);
    }
    return strip;
  }

  _renderCats() {
    const wrap = this._el('div', 'shell-cats');
    for (const cat of this._model || []) {
      const open = this.state.open[cat.key] !== false;           // open unless shut by hand
      const w = this._el('section', 'shell-cat' + (open ? ' open' : ''));
      const lab = this._el('div', 'shell-cat-label');
      lab.dataset.key = cat.key; lab.setAttribute('role', 'button'); lab.tabIndex = 0;
      lab.setAttribute('aria-expanded', String(open));
      lab.innerHTML = `<span class="shell-cat-arrow" aria-hidden="true">${open ? '▼' : '▶'}</span><span class="shell-cat-name">${esc(cat.title)}</span>`;
      const pin = this._el('button', 'shell-cat-pin', PIN_SVG); pin.type = 'button';
      pin.title = 'Pin to the Tools Dock Strip'; pin.setAttribute('aria-label', 'Pin ' + cat.title + ' to the Tools Dock Strip');
      pin.addEventListener('click', (e) => { e.stopPropagation(); this._pin(cat); });
      lab.appendChild(pin);
      const toggle = () => { this.state.open[cat.key] = !open; this._save(); this.cats.refresh({ anchor: lab }); };
      lab.addEventListener('click', toggle);
      lab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      w.appendChild(lab);
      if (open) {
        const rows = this._el('div', 'shell-cat-rows');
        for (const r of cat.rows) rows.appendChild(this._row(r));
        w.appendChild(rows);
      }
      wrap.appendChild(w);
    }
    return wrap;
  }

  _row(r) {
    if (r.kind === 'sep') return this._el('div', 'shell-cat-sep');
    if (r.kind === 'label') { const l = this._el('div', 'shell-cat-sub'); l.textContent = r.label; return l; }
    if (r.kind === 'control' && r.el) {
      // a ribbon select / input: a twin that writes through to the real one
      const row = this._el('label', 'shell-cat-row shell-cat-control');
      const t = this._el('span', 'shell-cat-row-label'); t.textContent = r.label || '';
      const twin = r.el.cloneNode(true);
      twin.removeAttribute('id'); twin.removeAttribute('onchange'); twin.removeAttribute('oninput');
      twin.value = r.el.value;
      twin.addEventListener('change', () => { r.el.value = twin.value; r.el.dispatchEvent(new Event('input', { bubbles: true })); r.el.dispatchEvent(new Event('change', { bubbles: true })); });
      row.appendChild(t); row.appendChild(twin);
      return row;
    }
    const b = this._el('button', 'shell-cat-row' + (r.pressed ? ' pressed' : '') + (r.danger ? ' danger' : ''));
    b.type = 'button'; b.disabled = !!r.disabled;
    b.innerHTML = `<span class="shell-cat-row-ic" aria-hidden="true">${r.svgIcon || esc(r.icon || '')}</span><span class="shell-cat-row-label">${esc(r.label)}</span>` + (r.kbd ? `<kbd>${esc(r.kbd)}</kbd>` : '');
    b.addEventListener('click', () => {
      if (!this.isModeless()) this.close();
      if (r.el) r.el.click(); else if (typeof r.run === 'function') r.run();
    });
    return b;
  }

  _pin(cat) {
    const detail = { key: cat.key, title: cat.title, rows: cat.rows.filter((r) => r.kind === 'item').map((r) => ({ label: r.label, run: () => (r.el ? r.el.click() : r.run && r.run()) })) };
    if (typeof this.o.onPin === 'function') this.o.onPin(detail);
    else this.doc.dispatchEvent(new CustomEvent('shell:pin', { detail }));
    this._emit('pin', detail);
  }

  // ---- open / close ------------------------------------------------------------------------

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this._model = this.model();
    this.el.classList.add('open');
    this.refreshMode();
    // measured once SHOWN (bug 2): the lists have their real size now
    const W = this.doc.defaultView || window;
    W.requestAnimationFrame(() => { if (this.modes) this.modes.refresh(); this.cats.refresh(); });
    if (!this.isModeless()) this.el.focus({ preventScroll: true });
    this._emit('open');
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.doc.documentElement.classList.remove('shell-drawer-open');
    this.el.classList.remove('open'); this.overlay.classList.remove('open');
    this._emit('close');
  }
  toggle() { if (this.isOpen) this.close(); else this.open(); return this.isOpen; }
  setMode(id) { this.state.mode = id; if (this.isOpen && this.modes) this.modes.refresh(); }
  on(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _emit(type, detail) { for (const f of this._subs) { try { f(type, detail); } catch (e) { /* listener */ } } }

  /** Swipe in from the left edge opens it (phone only); a swipe left on it closes it. */
  _gestures() {
    const d = this.doc;
    let g = null;
    d.addEventListener('pointerdown', (e) => {
      if (!d.documentElement.classList.contains('shell-phone')) return;
      const W = d.defaultView || window;
      const fromEdge = this.side === 'left' ? e.clientX : W.innerWidth - e.clientX;
      if (!this.isOpen && fromEdge <= 18 && !this.isModeless()) g = { x: e.clientX, y: e.clientY, kind: 'open' };
      else if (this.isOpen && this.el.contains(e.target) && !(this.modesVp && this.modesVp.contains(e.target))) g = { x: e.clientX, y: e.clientY, kind: 'close' };
    }, true);
    d.addEventListener('pointermove', (e) => {
      if (!g) return;
      const dx = (e.clientX - g.x) * (this.side === 'left' ? 1 : -1), dy = e.clientY - g.y;   // dx > 0 = inward
      if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }     // a scroll, not a swipe
      if (g.kind === 'open' && dx > 40) { g = null; this.open(); }
      else if (g.kind === 'close' && dx < -50) { g = null; this.close(); }
    }, true);
    const end = () => { g = null; };
    d.addEventListener('pointerup', end, true); d.addEventListener('pointercancel', end, true);
  }

  destroy() { if (this.modes) this.modes.destroy(); this.cats.destroy(); this.el.remove(); this.overlay.remove(); }
}

function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
