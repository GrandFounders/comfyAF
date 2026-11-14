/**
 * hostKit/shell/endless.js — an endless (wrap-around) scroller, done right.
 *
 * GuaP's phone drawer had one (`setupInfiniteScroll` / `setupModeToggleScroll` in
 * GuaP/menu/sidebar_mMenu.html). It had four bugs, all fixed here:
 *
 *   1. The loop length was measured ONCE. Opening a category changed the length, so the wrap
 *      point was wrong and the list jumped.        → re-measured on every render and resize.
 *   2. It could be measured while hidden (size 0), so the loop never started.
 *                                                  → `refresh()` measures when shown; a
 *                                                     ResizeObserver catches the first real size.
 *   3. The copy was a DOM clone: its state drifted (a category open in one copy was shut in the
 *      other), and the clone carried duplicate ids.  → every copy is RENDERED from one model, so
 *                                                     they cannot drift; renderers write no ids.
 *   4. It started at scroll 0 — exactly the wrap point — so the first swipe back hit the
 *      browser's edge and jumped a whole length.     → three copies; the view starts in the
 *                                                     middle one and is kept there.
 *
 * If everything fits in the viewport, nothing loops: one copy, ordinary scrolling.
 *
 *     const e = new Endless(viewport, () => buildOneSegment(), { axis: 'y' });
 *     e.refresh();               // after the model changes (keeps what is under the finger in place)
 *     e.refresh({ anchor: el }); // …keeping THIS element where it is on screen
 */
export class Endless {
  constructor(viewport, render, { axis = 'y', doc } = {}) {
    this.vp = viewport;
    this.render = render;
    this.axis = axis;
    this.doc = doc || viewport.ownerDocument || document;
    this.looping = false;
    this.seg = 0;                         // one copy's length (px)
    this.inner = this.doc.createElement('div');
    this.inner.className = 'shell-endless-inner';
    if (axis === 'x') this.inner.style.cssText = 'display:flex;width:max-content';
    this.vp.appendChild(this.inner);
    this._raf = 0;
    this._onScroll = () => {
      if (this._raf) return;
      this._raf = (this.doc.defaultView || window).requestAnimationFrame(() => { this._raf = 0; this._wrap(); });
    };
    this.vp.addEventListener('scroll', this._onScroll, { passive: true });
    const W = this.doc.defaultView || window;
    if (W.ResizeObserver) {
      this._ro = new W.ResizeObserver(() => { if (!this._busy) this.refresh(); });
      this._ro.observe(this.vp);
    }
  }

  _pos(v) { if (v === undefined) return this.axis === 'x' ? this.vp.scrollLeft : this.vp.scrollTop; if (this.axis === 'x') this.vp.scrollLeft = v; else this.vp.scrollTop = v; return v; }
  _size(el) { const r = el.getBoundingClientRect(); return this.axis === 'x' ? r.width : r.height; }
  _start(el) { const r = el.getBoundingClientRect(); return this.axis === 'x' ? r.left : r.top; }

  /** Re-render every copy from the model and re-measure. `anchor`: an element to keep in place on screen. */
  refresh({ anchor } = {}) {
    this._busy = true;
    // where we are: which copy, and how far into it; or where the anchor sits on screen
    let keep = null;
    if (anchor && anchor.isConnected) {
      const copy = anchor.closest('[data-copy]');
      keep = { key: anchor.dataset.key, copy: copy ? copy.dataset.copy : '0', at: this._start(anchor) - this._start(this.vp) };
    }
    const offset = this.looping && this.seg ? ((this._pos() - this.seg) % this.seg + this.seg) % this.seg : this._pos();
    this.inner.textContent = '';
    const first = this._copy(0);
    this.inner.appendChild(first);
    const vpLen = this.axis === 'x' ? this.vp.clientWidth : this.vp.clientHeight;
    this.seg = this._size(first);
    this.looping = vpLen > 0 && this.seg > vpLen + 1;
    if (this.looping) { this.inner.appendChild(this._copy(1)); this.inner.appendChild(this._copy(2)); }
    if (keep && keep.key != null) {
      const sel = `[data-copy="${this.looping ? keep.copy : '0'}"] [data-key="${CSS.escape(keep.key)}"]`;
      const el = this.inner.querySelector(sel);
      if (el) this._pos(this._pos() + (this._start(el) - this._start(this.vp)) - keep.at);
    } else this._pos(this.looping ? this.seg + Math.min(offset, this.seg - 1) : Math.min(offset, Math.max(0, this.seg - vpLen)));
    this._wrap();
    this._busy = false;
  }

  _copy(i) {
    const c = this.render(i);
    c.dataset.copy = String(i);
    if (i > 0) c.setAttribute('aria-hidden', 'true');         // a screen reader reads the list once
    if (this.axis === 'x') c.style.flex = '0 0 auto';
    return c;
  }

  /** Keep the view inside the middle copy: [ A | A* | A ], view starts at A*. */
  _wrap() {
    if (!this.looping || !this.seg) return;
    const p = this._pos();
    if (p < this.seg * 0.5) this._pos(p + this.seg);
    else if (p >= this.seg * 1.5) this._pos(p - this.seg);
  }

  destroy() {
    this.vp.removeEventListener('scroll', this._onScroll);
    if (this._ro) this._ro.disconnect();
    this.inner.remove();
  }
}
