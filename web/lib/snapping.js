/**
 * jsCANVAS — snapping · guides · grid (P9).
 *
 * Two halves, deliberately separate:
 *
 *   - `SnapEngine` — PURE math (DOM-free, headless-testable, like `geometry.js`). Given a
 *     proposed box and a set of candidate lines, it returns the corrected box plus the
 *     lines that matched, so the caller can draw feedback. Knows nothing about the canvas.
 *   - `GuideLayer` — the DOM half: user guides pulled off the rulers, plus the transient
 *     "smart guide" feedback lines drawn during a drag. Overlay/viewport space, mapped
 *     through the ONE camera (§13 r10) like every other piece of screen-fixed chrome.
 *
 * WHAT SNAPS TO WHAT. A moving box offers three lines per axis (near edge, centre, far
 * edge) and looks for a match against: user guides, every other element's three lines
 * (Illustrator/Figma "smart guides"), container edges + centres, and optionally the grid.
 * The threshold is in SCREEN pixels — converted to scene units by dividing by zoom — so
 * snapping feels the same at every zoom level, which is the whole point of the one-camera
 * rule.
 *
 * Rotated elements are snapped by their axis-aligned bounding box: the honest thing to do
 * without pretending an oriented box has meaningful "edges" to align to.
 */

// how close (in SCREEN px) a line must be to grab
export const SNAP_PX = 6;

/** The three interesting lines of a box on one axis: near edge, centre, far edge. */
function linesOf(v0, size) { return [v0, v0 + size / 2, v0 + size]; }

/** A box's axis-aligned extent in scene coords, honouring scale (and rotation, loosely). */
export function aabb(geom) {
  const w = geom.w * (geom.sx == null ? 1 : geom.sx);
  const h = geom.h * (geom.sy == null ? 1 : geom.sy);
  if (!geom.angle) return { x: geom.x, y: geom.y, w, h };
  // rotated: use the enclosing axis-aligned box about the same centre
  const a = (geom.angle * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const bw = w * c + h * s, bh = w * s + h * c;
  return { x: geom.x + (w - bw) / 2, y: geom.y + (h - bh) / 2, w: bw, h: bh };
}

export class SnapEngine {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.toElements = opts.toElements !== false;   // smart guides off other elements
    this.toGuides = opts.toGuides !== false;       // user guides pulled off the rulers
    this.toGrid = !!opts.toGrid;                   // optional grid snap (off by default)
    this.grid = opts.grid || 20;                   // Kairos dot spacing
    this.threshold = opts.threshold || SNAP_PX;    // in SCREEN px
  }

  /**
   * Snap a proposed box.
   *
   *   box       { x, y, w, h }  the AABB being moved/resized, in scene coords
   *   targets   { v: [...], h: [...] }  candidate scene lines (vertical x, horizontal y)
   *   zoom      current camera zoom (the threshold is screen-px, so we divide by it)
   *   axes      which of the box's own lines may snap — 'all' (move) or a subset (resize)
   *
   * Returns { dx, dy, vLine, hLine }: the correction to apply, and the scene coordinate of
   * each matched line (or null) so the caller can draw the feedback.
   */
  snap(box, targets, zoom, axes) {
    const out = { dx: 0, dy: 0, vLine: null, hLine: null };
    if (!this.enabled) return out;
    const tol = this.threshold / (zoom || 1);

    const own = axes || { v: linesOf(box.x, box.w), h: linesOf(box.y, box.h) };
    const cand = {
      v: (targets && targets.v) || [],
      h: (targets && targets.h) || [],
    };
    if (this.toGrid && this.grid > 0) {
      for (const v of own.v) cand.v.push(Math.round(v / this.grid) * this.grid);
      for (const h of own.h) cand.h.push(Math.round(h / this.grid) * this.grid);
    }

    // best (smallest) correction per axis
    let bestV = null, bestH = null;
    for (const mine of own.v) {
      for (const theirs of cand.v) {
        const d = theirs - mine;
        if (Math.abs(d) <= tol && (bestV === null || Math.abs(d) < Math.abs(bestV.d))) bestV = { d, line: theirs };
      }
    }
    for (const mine of own.h) {
      for (const theirs of cand.h) {
        const d = theirs - mine;
        if (Math.abs(d) <= tol && (bestH === null || Math.abs(d) < Math.abs(bestH.d))) bestH = { d, line: theirs };
      }
    }
    if (bestV) { out.dx = bestV.d; out.vLine = bestV.line; }
    if (bestH) { out.dy = bestH.d; out.hLine = bestH.line; }
    return out;
  }

  /**
   * Collect candidate lines from the canvas: every element except `excludeIds`, plus the
   * user guides. Containers contribute their edges + centres too (aligning to the page is
   * the most common case of all).
   */
  targetsFrom(ws, excludeIds, guides) {
    const skip = new Set(excludeIds || []);
    const v = [], h = [];
    if (this.toGuides && guides) {
      for (const g of guides) (g.axis === 'v' ? v : h).push(g.pos);
    }
    if (this.toElements) {
      for (const id of ws.instanceIds()) {
        if (skip.has(id)) continue;
        const comp = ws.component(id);
        if (!comp || typeof comp.getGeom !== 'function') continue;
        if (comp.el && comp.el.style && comp.el.style.display === 'none') continue;  // dormant
        if (ws.isPanelHidden && ws.isPanelHidden(id)) continue;                        // P21: off-screen in a panel
        const b = aabb(comp.getGeom());
        v.push(...linesOf(b.x, b.w));
        h.push(...linesOf(b.y, b.h));
      }
    }
    return { v, h };
  }
}

// ---- the DOM half: user guides + transient smart-guide feedback -------------

export class GuideLayer {
  constructor(ws) {
    this.ws = ws;
    this.doc = ws.doc;
    this._guides = [];              // { id, axis: 'v'|'h', pos } in SCENE coords
    this._seq = 0;
    this._els = new Map();          // guideId -> line element
    this._feedback = { v: null, h: null };

    this.layer = this.doc.createElement('div');
    this.layer.className = 'jsc-guide-layer';
    Object.assign(this.layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: 30 });
    if (ws.el && ws.el.appendChild) ws.el.appendChild(this.layer);

    ws.onCamera(() => this.refresh());
  }

  guides() { return this._guides.map((g) => ({ ...g })); }

  add(axis, pos) {
    const g = { id: `guide_${++this._seq}`, axis: axis === 'v' ? 'v' : 'h', pos };
    this._guides.push(g);
    this.refresh();
    return g.id;
  }
  move(id, pos) { const g = this._guides.find((x) => x.id === id); if (g) { g.pos = pos; this.refresh(); } return !!g; }
  remove(id) {
    const i = this._guides.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this._guides.splice(i, 1);
    const el = this._els.get(id);
    if (el && el.remove) el.remove();
    this._els.delete(id);
    this.refresh();
    return true;
  }
  clear() { for (const g of [...this._guides]) this.remove(g.id); this._seq = 0; }
  /** Replace the whole set (P3 load). */
  setAll(list) {
    this.clear();
    for (const g of list || []) { const id = this.add(g.axis, g.pos); void id; }
  }

  _lineEl(cls) {
    const d = this.doc.createElement('div');
    d.className = cls;
    this.layer.appendChild(d);
    return d;
  }

  refresh() {
    const r = this.ws._viewportRect();
    for (const g of this._guides) {
      let el = this._els.get(g.id);
      if (!el) {
        el = this._lineEl('jsc-guide');
        el.style.pointerEvents = 'auto';          // guides are grabbable
        el.dataset.guideId = g.id;
        this._wireDrag(g.id, el);
        this._els.set(g.id, el);
      }
      el.classList.toggle('jsc-guide-v', g.axis === 'v');
      el.classList.toggle('jsc-guide-h', g.axis === 'h');
      if (g.axis === 'v') {
        const x = this.ws.toView(g.pos, 0).x;
        Object.assign(el.style, { left: x + 'px', top: '0', width: '', height: r.height + 'px' });
        el.style.display = (x < -2 || x > r.width + 2) ? 'none' : '';
      } else {
        const y = this.ws.toView(0, g.pos).y;
        Object.assign(el.style, { top: y + 'px', left: '0', height: '', width: r.width + 'px' });
        el.style.display = (y < -2 || y > r.height + 2) ? 'none' : '';
      }
    }
  }

  /** Drag a placed guide; drop it off the edge (or onto a ruler) to delete it. */
  _wireDrag(id, el) {
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); if (e.preventDefault) e.preventDefault();
      dragging = true;
      if (el.setPointerCapture && e.pointerId != null) el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const g = this._guides.find((x) => x.id === id); if (!g) return;
      const r = this.ws._viewportRect();
      const p = this.ws.toScene(e.clientX - r.left, e.clientY - r.top);
      this.move(id, g.axis === 'v' ? p.x : p.y);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      const r = this.ws._viewportRect();
      const vx = e.clientX - r.left, vy = e.clientY - r.top;
      // dropped outside the viewport (i.e. back onto a ruler) = delete, the Illustrator gesture
      if (vx < 0 || vy < 0 || vx > r.width || vy > r.height) this.remove(id);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---- transient feedback while a gesture is snapped ----

  showFeedback(vLine, hLine) {
    const r = this.ws._viewportRect();
    for (const axis of ['v', 'h']) {
      const pos = axis === 'v' ? vLine : hLine;
      let el = this._feedback[axis];
      if (pos == null) { if (el) el.style.display = 'none'; continue; }
      if (!el) { el = this._lineEl('jsc-snapline jsc-snapline-' + axis); this._feedback[axis] = el; }
      el.style.display = '';
      if (axis === 'v') {
        Object.assign(el.style, { left: this.ws.toView(pos, 0).x + 'px', top: '0', height: r.height + 'px' });
      } else {
        Object.assign(el.style, { top: this.ws.toView(0, pos).y + 'px', left: '0', width: r.width + 'px' });
      }
    }
  }
  hideFeedback() { for (const axis of ['v', 'h']) { const el = this._feedback[axis]; if (el) el.style.display = 'none'; } }
}
