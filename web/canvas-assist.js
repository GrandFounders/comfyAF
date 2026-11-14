/**
 * ComfyAF — CanvasAssist for ComfyUI (2026-11-13).
 *
 * Navigation aids for ComfyUI's graph, from the KCadabra workspace (https://kcadabra — see README.md):
 *   · hover-zoom — rest the mouse on a node that is small on screen and the view glides toward it; rest on
 *     empty canvas (or click empty canvas after working in it) and the view goes back to where you had it
 *   · edge scroll — rest the mouse near an edge of the canvas and the view scrolls that way
 *   · selection box past the edge (off by default) — ComfyUI's own Auto-pan (Settings › LiteGraph) already scrolls
 *     while you drag a node or a wire against an edge, so ComfyAF leaves those alone; this only adds the same
 *     for a selection box, should your ComfyUI not do it
 *   · circle to zoom — circle the mouse over an area: clockwise zooms in there, anticlockwise out. A faint ring
 *     in the middle of the circle shows it happening: it fills as you turn, blue + to zoom in, gold − to zoom out
 *
 * ON by default; Settings › ComfyAF turns each part on or off. Nothing is saved to your workflows.
 *
 * Inside a KCadabra window (ComfyUI shown in a frame), this stays OFF: the KcadaBRA app runs CanvasAssist there
 * through its own kadabra-bridge extension, with the app's settings, so the two never both run.
 *
 * Made from kadabra-bridge/web/canvas-assist.js (KcadaBRA, 2026-11-07). The shared logic (planAssist, SpringGlide)
 * is ./lib/canvas_assist.js, a copy of KcadaBRA _EcoCore/jsCANVAS/canvas_assist.js — copy it again after changing it there.
 * If this ComfyUI's canvas does not look as expected (a frontend update), it stays off and says so in the console.
 */
import { app } from '../../scripts/app.js';
import * as lib from './lib/canvas_assist.js';

const ID = 'ComfyAF.CanvasAssist';
let opts = null, on = false;
const st = { press: null, home: null, assisted: null, engaged: false, glide: null, raf: null, wrote: null, dwell: null, edge: null, drag: null, ret: null };
const offs = [];

// ── ComfyUI's canvas (LiteGraph) as a camera: screen = (graph + offset) × scale  ⇔  { x: offset·scale, zoom: scale } ──
const C = () => (app && app.canvas) || null;
function supported() {
  const c = C();
  return !!(c && c.ds && c.ds.offset && c.ds.offset.length >= 2 && Number.isFinite(c.ds.scale) && c.canvas && app.graph && typeof app.graph.getNodeOnPos === 'function');
}
function cam() {
  const ds = C().ds, s = ds.scale;
  return { x: ds.offset[0] * s, y: ds.offset[1] * s, zoom: s, minZoom: Number.isFinite(ds.min_scale) ? ds.min_scale : 0.1, maxZoom: Number.isFinite(ds.max_scale) ? ds.max_scale : 10 };
}
function write(c) {
  const ds = C().ds;
  ds.scale = c.zoom; ds.offset[0] = c.x / c.zoom; ds.offset[1] = c.y / c.zoom;
  st.wrote = { x: c.x, y: c.y, zoom: c.zoom };
  try { C().setDirty(true, true); } catch (e) { /* older canvas */ }
}
const same = (a, b) => !!a && !!b && Math.abs(a.zoom - b.zoom) < 1e-6 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
const rect = () => C().canvas.getBoundingClientRect();
function local(e) { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; }
function toGraph(p) { const c = cam(); return { x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom }; }
/** The node under the pointer: a Vue node says so itself ([data-node-id], ComfyUI's "Vue nodes");
 *  on the classic canvas, ask the graph. */
function nodeAt(p, target) {
  const el = target && target.closest ? target.closest('[data-node-id]') : null;
  if (el) { const n = app.graph.getNodeById(isNaN(+el.dataset.nodeId) ? el.dataset.nodeId : +el.dataset.nodeId); if (n) return n; }
  const g = toGraph(p), graph = app.graph;
  try { return graph.getNodeOnPos(g.x, g.y, graph._nodes || graph.nodes) || null; } catch (e) { return null; }
}
const area = () => C().canvas.parentElement || C().canvas;          // #graph-canvas-container: the canvas + the node layer
/** On the graph: empty canvas, or a node (Vue nodes are elements over the canvas). Not ComfyUI's own chrome. */
function onGraph(t) {
  const c = C().canvas;
  if (t === c) return true;
  return !!(t && t.closest && area().contains(t) && t.closest('[data-node-id]'));
}
function boxOf(n) {
  const T = (window.LiteGraph && window.LiteGraph.NODE_TITLE_HEIGHT) || 30;
  const collapsed = n.flags && n.flags.collapsed;
  return { x: n.pos[0], y: n.pos[1] - T, w: collapsed ? (n._collapsed_width || 160) : n.size[0], h: collapsed ? T : n.size[1] + T };
}
const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const editing = () => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || '')); };
function busy() {
  const c = C(), s = c.state || {};
  return !!((c.pointer && c.pointer.isDown) || s.draggingItems || s.draggingCanvas || c.dragging_canvas || c.dragging_rectangle
    || (c.linkConnector && c.linkConnector.isConnecting) || editing());
}
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

// ── moving the view ──
function stopGlide() { if (st.raf) cancelAnimationFrame(st.raf); st.raf = null; st.glide = null; }
function glideTo(to, focus) {
  const from = cam();
  if (opts.glide !== 'spring' || reduced()) { stopGlide(); write(to); return; }
  if (st.glide) st.glide.retarget(to, focus, lib.glideOmega(from, to, opts));
  else st.glide = new lib.SpringGlide(from, to, focus, lib.glideOmega(from, to, opts));
  if (st.raf) return;
  let last = performance.now();
  const step = (now) => {
    if (!st.glide) return;
    if (st.wrote && !same(cam(), st.wrote)) { stopGlide(); tookOver(); return; }   // the person moved the view mid-glide
    const c = st.glide.step((now - last) / 1000); last = now;
    write(c);
    if (st.glide && st.glide.done) { stopGlide(); return; }
    st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}
/** The view is the person's again (wheel, pan, a fit, an edge scroll): no way back to remember. */
function tookOver() { st.home = null; st.assisted = null; st.engaged = false; clearTimeout(st.ret); st.ret = null; }
function checkTakeover() { if (st.home && !st.glide && st.wrote && !same(cam(), st.wrote)) tookOver(); }
function returnHome() {
  if (!st.home) return;
  const home = st.home, n = st.assisted != null ? app.graph.getNodeById(st.assisted) : null;
  st.home = null; st.assisted = null; st.engaged = false;
  glideTo(home, n ? centre(boxOf(n)) : null);
}
/** Put the chosen view back at once (leaving the page, turning it off with an assist in place). */
function restoreNow() { if (!st.home) return; stopGlide(); write(st.home); tookOver(); }

// ── hover-zoom ──
function cancelDwell() { if (st.dwell) clearTimeout(st.dwell.timer); st.dwell = null; }
function dwellMove(p, target) {
  const d = st.dwell;
  if (d && Math.hypot(p.x - d.p.x, p.y - d.p.y) <= opts.stillPx) return;         // still resting
  cancelDwell();
  const at = { p, timer: null };
  at.timer = setTimeout(() => { if (st.dwell === at) { st.dwell = null; rest(p, target); } }, opts.dwellMs);
  st.dwell = at;
}
function rest(p, target) {
  if (!on || busy()) return;
  checkTakeover();
  const n = nodeAt(p, target);
  if (!n) { if (st.home && !st.engaged && opts.returnOnLeave) returnHome(); return; }   // empty canvas: give the view back
  if (opts.hoverZoom === false || st.assisted === n.id) return;
  const plan = lib.planAssist({ box: boxOf(n), camera: cam(), viewport: { width: p.w, height: p.h }, pointer: p, options: { ...opts, insets: insets() } });
  if (!plan.assist) {
    // a node that was already easy to see at YOUR zoom is a backdrop: resting on it also gives the view back
    if (st.home && !st.engaged && opts.returnOnLeave) {
      const atHome = lib.planAssist({ box: boxOf(n), camera: st.home, viewport: { width: p.w, height: p.h }, options: opts });
      if (atHome.reason === 'already-visible') returnHome();
    }
    return;
  }
  if (!st.home) st.home = cam();
  st.assisted = n.id; st.engaged = false;
  glideTo(plan.camera, centre(boxOf(n)));
}

// ── edge scroll (resting near an edge) ──
function stopEdge() { const e = st.edge; if (!e) return; clearTimeout(e.timer); if (e.raf) cancelAnimationFrame(e.raf); st.edge = null; }
/** How far ComfyUI's own chrome (sidebar, top bar, a panel) reaches in from each edge of the canvas: walk in from
 *  the edge at a quarter, half and three quarters until the pointer would be on the graph. Measured again every
 *  1.5 s (panels open and close). The band sits just inside it. */
let insetsAt = 0, insetsNow = { left: 0, right: 0, top: 0, bottom: 0 };
function insets() {
  const now = performance.now();
  if (now - insetsAt < 1500) return insetsNow;
  insetsAt = now;
  const r = rect(), cap = (v, span) => Math.min(v, span * 0.45);
  const walk = (at, max) => { for (let i = 0; i < max; i += 2) { const p = at(i); if (onGraph(document.elementFromPoint(p.x, p.y))) return i; } return max; };
  const side = (fn, span) => cap(Math.max(...[0.25, 0.5, 0.75].map((f) => walk((i) => fn(i, f), Math.round(span * 0.45)))), span);
  insetsNow = {
    left: side((i, f) => ({ x: r.left + i, y: r.top + r.height * f }), r.width),
    right: side((i, f) => ({ x: r.right - 1 - i, y: r.top + r.height * f }), r.width),
    top: side((i, f) => ({ x: r.left + r.width * f, y: r.top + i }), r.height),
    bottom: side((i, f) => ({ x: r.left + r.width * f, y: r.bottom - 1 - i }), r.height),
  };
  return insetsNow;
}
function edgeDir(p, z) {
  const ins = insets();
  let dx = 0, dy = 0;
  if (p.x >= 0 && p.x < ins.left + z) dx = 1; else if (p.x <= p.w && p.x > p.w - ins.right - z) dx = -1;
  if (p.y >= 0 && p.y < ins.top + z) dy = 1; else if (p.y <= p.h && p.y > p.h - ins.bottom - z) dy = -1;
  return { x: dx, y: dy };
}
function edgeMove(p) {
  const dir = edgeDir(p, opts.edgePx);
  if (!dir.x && !dir.y) return stopEdge();
  if (st.edge) { st.edge.dir = dir; return; }
  const at = { dir, timer: null, raf: null };
  at.timer = setTimeout(() => {
    if (st.edge !== at || busy()) return stopEdge();
    tookOver(); stopGlide();                                                        // the view is yours again
    const t0 = performance.now(); let last = t0;
    const step = (now) => {
      if (st.edge !== at) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const v = opts.edgeSpeed * (0.25 + 0.75 * Math.min(1, (now - t0) / 500)) * dt;
      const c = cam(); write({ x: c.x + at.dir.x * v, y: c.y + at.dir.y * v, zoom: c.zoom });
      at.raf = requestAnimationFrame(step);
    };
    at.raf = requestAnimationFrame(step);
  }, opts.edgeDwellMs);
  st.edge = at;
}

// ── circle to zoom (the same gesture as jsCANVAS canvas_assist.js › _circleMove) ──
// Add up how much the mouse's direction turns. Ordinary movement turns a little and turns back; circling keeps
// turning one way. Past circleTurns, every further turn zooms by circleZoomPerTurn about the middle of the circle.
let circle = null;
function resetCircle() { circle = { pts: [], acc: 0, on: false, last: 0, used: 0 }; hideGuide(); }
function circleMove(e) {
  const now = performance.now();
  if (editing()) { resetCircle(); return false; }
  if (now - circle.last > 350) resetCircle();                                      // a pause ends a gesture
  const K = circle; K.last = now;
  const p = { x: e.clientX, y: e.clientY, t: now };
  const pts = K.pts, prev = pts[pts.length - 1];
  if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 6) return K.on;             // resample by distance
  pts.push(p);
  while (pts.length && now - pts[0].t > 1600) pts.shift();                         // the last moment of movement
  if (pts.length < 3) return K.on;
  const a = pts[pts.length - 3], b = pts[pts.length - 2], c = pts[pts.length - 1];
  const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
  let d = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);                 // + clockwise on screen (y down)
  if (Math.abs(d) > 2.4) d = 0;                                                     // a jerk back, not a turn
  if (K.acc && Math.sign(d) !== Math.sign(K.acc) && Math.abs(d) > 0.6) { K.acc = d; K.on = false; hideGuide(); return false; }
  K.acc += d;
  // a circle-sized movement: not a jitter, not a sweep across the screen
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  const size = Math.max(maxX - minX, maxY - minY);
  if ((size < 30 || size > 700) && !K.on) { hideGuide(); return false; }
  const need = opts.circleTurns * 2 * Math.PI;
  drawGuide(K, { minX, minY, maxX, maxY }, need);
  if (!K.on) {
    if (Math.abs(K.acc) < need) return false;
    K.on = true; K.used = Math.sign(K.acc) * need;
    stopGlide(); tookOver();                                                        // the view is the person's now
  }
  const more = K.acc - K.used; K.used = K.acc;
  if (!more) return true;
  const f = Math.pow(opts.circleZoomPerTurn, (opts.circleInvert ? -more : more) / (2 * Math.PI));
  const r = rect(), cx = (minX + maxX) / 2 - r.left, cy = (minY + maxY) / 2 - r.top;
  const c0 = cam(), zoom = Math.max(c0.minZoom || 0.1, Math.min(c0.maxZoom || 10, c0.zoom * f)), k = zoom / c0.zoom;
  if (k !== 1) write({ x: cx - (cx - c0.x) * k, y: cy - (cy - c0.y) * k, zoom });
  return true;
}

// ── the circling ring (as jsCANVAS canvas_assist.js › _drawCircleGuide, 2026-11-12) ──
// Faint, in the middle of the circle, never bigger than circleGuideMaxPx. It fills as you turn (full = the zoom
// starts) and shows + (zooms in, blue) or − (zooms out, gold). Ordinary movement (under a fifth) shows nothing.
const NS = 'http://www.w3.org/2000/svg';
let guide = null, guideTimer = null;
function guideEl() {
  if (guide) return guide;
  const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const svg = mk('svg', { class: 'comfyaf-circle-guide', 'aria-hidden': 'true' });
  Object.assign(svg.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', overflow: 'visible',
    pointerEvents: 'none', zIndex: '9999', opacity: '0', color: '#3E6AE1', transition: reduced() ? 'none' : 'opacity 160ms ease, color 160ms ease' });
  const track = mk('circle', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-opacity': '0.35' });
  const arc = mk('path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
  const sign = mk('path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round' });
  svg.appendChild(track); svg.appendChild(arc); svg.appendChild(sign);
  document.body.appendChild(svg);
  guide = { svg, track, arc, sign };
  return guide;
}
function drawGuide(K, b, need) {
  if (!opts.circleGuide) return;
  const k = K.on ? 1 : Math.min(1, Math.abs(K.acc) / need);
  if (!K.on && k < 0.2) { hideGuide(); return; }
  const g = guideEl();
  const x = (b.minX + b.maxX) / 2, y = (b.minY + b.maxY) / 2;             // client coordinates: the ring is position: fixed
  const r = Math.max(12, Math.min(Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2, Math.max(12, +opts.circleGuideMaxPx || 30)));
  const cw = K.acc > 0, zoomIn = opts.circleInvert ? !cw : cw;
  g.svg.style.color = zoomIn ? 'var(--comfyaf-guide-in, #3E6AE1)' : 'var(--comfyaf-guide-out, #D9A441)';
  g.track.setAttribute('cx', x); g.track.setAttribute('cy', y); g.track.setAttribute('r', r);
  const a1 = -Math.PI / 2, a2 = a1 + (cw ? 1 : -1) * Math.min(k, 0.9999) * 2 * Math.PI;
  g.arc.setAttribute('d', `M${x + r * Math.cos(a1)} ${y + r * Math.sin(a1)} A${r} ${r} 0 ${k > 0.5 ? 1 : 0} ${cw ? 1 : 0} ${x + r * Math.cos(a2)} ${y + r * Math.sin(a2)}`);
  const s = Math.max(3, r * 0.3);
  g.sign.setAttribute('d', `M${x - s} ${y} H${x + s}` + (zoomIn ? ` M${x} ${y - s} V${y + s}` : ''));
  g.svg.style.opacity = K.on ? '0.7' : String(0.25 + 0.35 * k);
  clearTimeout(guideTimer);
  guideTimer = setTimeout(hideGuide, 380);                                          // a pause ends the gesture
}
function hideGuide() { clearTimeout(guideTimer); guideTimer = null; if (guide) guide.svg.style.opacity = '0'; }
resetCircle();

// ── a selection box past the edge (off by default; nodes and wires are ComfyUI's own Auto-pan) ──
function endDrag() { const d = st.drag; if (!d) return; if (d.raf) cancelAnimationFrame(d.raf); st.drag = null; }
/** A selection box is being dragged. Nodes and wires are not ours: ComfyUI's own Auto-pan scrolls for those. */
function dragging() {
  const c = C(), s = c.state || {};
  if (s.draggingCanvas || c.dragging_canvas || s.draggingItems || (c.linkConnector && c.linkConnector.isConnecting) || c.connecting_links) return false;
  return !!(c.dragging_rectangle || s.selectingRectangle);
}
function dragMove(e) {
  if (!opts.dragScroll || !dragging()) { endDrag(); return; }
  const r = rect(), z = Math.max(1, opts.edgePx), lx = e.clientX - r.left, ly = e.clientY - r.top;
  const ins = insets();
  const axis = (p, lo, hi) => (p < lo + z ? Math.min(2, (lo + z - p) / z) : p > hi - z ? -Math.min(2, (p - (hi - z)) / z) : 0);
  const ax = axis(lx, ins.left, r.width - ins.right), ay = axis(ly, ins.top, r.height - ins.bottom);
  const d = st.drag || (st.drag = { raf: null, x: 0, y: 0, dir: { x: 0, y: 0 }, depth: 0, ev: null });
  d.x = e.clientX; d.y = e.clientY; d.target = (e.target && e.target.isConnected) ? e.target : (d.target || C().canvas); d.ev = { buttons: e.buttons, pointerId: e.pointerId, pointerType: e.pointerType || 'mouse', altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
  d.dir = { x: Math.sign(ax), y: Math.sign(ay) }; d.depth = Math.max(Math.abs(ax), Math.abs(ay));
  if ((d.dir.x || d.dir.y) && !d.raf) {
    tookOver(); stopGlide();
    let last = performance.now();
    const step = (now) => {
      if (st.drag !== d) return;
      if (!d.dir.x && !d.dir.y) { d.raf = null; return; }                          // back inside: wait for the next push
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const v = opts.edgeSpeed * (0.3 + d.depth) * dt;
      const c = cam(); write({ x: c.x + d.dir.x * v, y: c.y + d.dir.y * v, zoom: c.zoom });
      // the thing being dragged follows: ComfyUI places it from where the pointer is ON THE GRAPH, which just moved
      try {
        const ev = new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: d.x, clientY: d.y, ...d.ev });
        Object.defineProperty(ev, '__comfyAF', { value: true });
        (d.target && d.target.isConnected ? d.target : C().canvas).dispatchEvent(ev);
      } catch (err) { /* the view still scrolls */ }
      d.raf = requestAnimationFrame(step);
    };
    d.raf = requestAnimationFrame(step);
  }
}

// ── wiring ──
function onMove(e) {
  if (!on || e.__comfyAF) return;
  if (e.pointerType && e.pointerType !== 'mouse') return;                          // touch and pen have no real hover
  const overCanvas = onGraph(e.target);
  if (e.buttons) {
    cancelDwell(); stopEdge(); resetCircle();
    if (st.press && !st.press.moved && Math.hypot(e.clientX - st.press.x, e.clientY - st.press.y) > 4) st.press.moved = true;
    if (overCanvas || st.drag) dragMove(e);
    return;
  }
  st.press = null;
  if (st.drag) endDrag();                                                          // released where we did not see it
  if (!overCanvas) { cancelDwell(); stopEdge(); resetCircle(); return; }          // a widget, a menu, the sidebar
  checkTakeover();
  const c = C(), s = c.state || {};
  if (s.draggingCanvas || c.dragging_canvas) { tookOver(); return; }
  if (opts.circleZoom && circleMove(e)) { cancelDwell(); stopEdge(); return; }    // circling: no hover, no edge
  const p = local(e);
  if (opts.edgeScroll) edgeMove(p); else stopEdge();
  if (st.edge && st.edge.raf) { cancelDwell(); return; }                           // scrolling: no hover-zoom
  dwellMove(p, e.target);
}
const WIDGET = 'input, textarea, select, button, [contenteditable], [role="slider"], [role="combobox"], [role="button"], .p-slider, .p-inputnumber, .p-select';
function onDown(e) {
  cancelDwell(); stopEdge(); resetCircle();
  const t = e.target;
  st.press = { x: e.clientX, y: e.clientY, moved: false, onNode: !!(t && t.closest && t.closest('[data-node-id]')), onWidget: !!(t && t.closest && t.closest(WIDGET)) };
  if (!onGraph(e.target)) return;
  if (st.home && st.assisted != null) {
    const n = nodeAt(local(e), e.target);
    if (n && n.id === st.assisted) st.engaged = true;                                // working in it: the view stays
  }
}
function onUp(e) {
  endDrag(); st.press = null;
  if (!st.home || !st.engaged || !opts.returnAfterWork || !onGraph(e.target)) return;
  // finished with it: nothing selected any more (a click on empty canvas, Escape) → the view goes back
  clearTimeout(st.ret);
  st.ret = setTimeout(() => {
    st.ret = null;
    const sel = C().selectedItems || C().selected_nodes;
    const any = sel && (sel.size != null ? sel.size : Object.keys(sel).length);
    if (st.home && st.engaged && !any && !editing() && !busy()) { st.engaged = false; returnHome(); }
  }, opts.returnDelayMs);
}
function bind() {
  const add = (t, type, fn, cap = true) => { t.addEventListener(type, fn, cap); offs.push(() => t.removeEventListener(type, fn, cap)); };
  add(window, 'pointermove', onMove);
  add(window, 'pointerdown', onDown);
  add(window, 'pointerup', onUp);
  add(window, 'pointercancel', () => { endDrag(); st.press = null; });
  add(window, 'blur', () => { cancelDwell(); stopEdge(); endDrag(); resetCircle(); st.press = null; });
  add(document, 'mouseout', (e) => { if (!e.relatedTarget) { cancelDwell(); stopEdge(); resetCircle(); } });           // left the page
  add(area(), 'wheel', () => { stopGlide(); tookOver(); }, { capture: true, passive: true });
  add(window, 'pagehide', () => restoreNow());
  add(document, 'keydown', (e) => { if (e.key === 'Escape') setTimeout(() => { const sel = C().selectedItems; if (st.home && st.engaged && !(sel && sel.size)) { st.engaged = false; returnHome(); } }, 0); });
  on = true;
}
function unbind() {
  cancelDwell(); stopEdge(); endDrag(); resetCircle(); clearTimeout(st.ret);
  restoreNow();
  while (offs.length) { try { offs.pop()(); } catch (e) { /* gone */ } }
  on = false;
}

// ── settings (Settings › ComfyAF) ──
// The person's switches and a few sliders; everything else is CanvasAssist's own defaults.
const SETTINGS = [
  { key: 'enabled', id: `${ID}.Enabled`, name: 'CanvasAssist (navigation aids)', type: 'boolean', defaultValue: true,
    tooltip: 'Hover-zoom, edge scroll and circle to zoom. Turns all of them on or off.' },
  { key: 'hoverZoom', id: `${ID}.HoverZoom`, name: 'Zoom toward a small node when the mouse rests on it', type: 'boolean', defaultValue: true },
  { key: 'dwellMs', id: `${ID}.DwellMs`, name: 'Wait before zooming in (ms)', type: 'slider', defaultValue: lib.CANVAS_ASSIST_DEFAULTS.dwellMs, attrs: { min: 150, max: 1500, step: 50 } },
  { key: 'maxZoom', id: `${ID}.MaxZoom`, name: 'Zoom in at most to (×)', type: 'slider', defaultValue: lib.CANVAS_ASSIST_DEFAULTS.maxZoom, attrs: { min: 1, max: 4, step: 0.1 } },
  { key: 'circleZoom', id: `${ID}.CircleZoom`, name: 'Circle the mouse to zoom there (clockwise in, anticlockwise out)', type: 'boolean', defaultValue: true },
  { key: 'circleGuide', id: `${ID}.CircleGuide`, name: 'Show a faint ring while circling', type: 'boolean', defaultValue: true },
  { key: 'circleInvert', id: `${ID}.CircleInvert`, name: 'Invert circling: anticlockwise zooms in', type: 'boolean', defaultValue: false },
  { key: 'edgeScroll', id: `${ID}.EdgeScroll`, name: 'Scroll when the mouse rests near an edge of the canvas', type: 'boolean', defaultValue: true },
  { key: 'dragScroll', id: `${ID}.DragScroll`, name: 'Scroll when you drag a selection box to an edge', type: 'boolean', defaultValue: false,
    tooltip: 'For nodes and wires, ComfyUI has its own Auto-pan (Settings › LiteGraph). Turn this on only if a selection box does not scroll already.' },
];
function readSetting(s) {
  try {
    const em = app.extensionManager && app.extensionManager.setting;
    const v = em && typeof em.get === 'function' ? em.get(s.id) : (app.ui && app.ui.settings && app.ui.settings.getSettingValue(s.id));
    return v === undefined || v === null ? s.defaultValue : v;
  } catch (e) { return s.defaultValue; }
}
/** Inside a frame (a KCadabra window shows ComfyUI that way) the host app runs CanvasAssist itself. */
const framed = () => { try { return window.self !== window.top; } catch (e) { return true; } };
let settingsTimer = null;
function apply() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    const v = {}; for (const s of SETTINGS) v[s.key] = readSetting(s);
    opts = { ...lib.CANVAS_ASSIST_DEFAULTS, ...v, dwellMs: +v.dwellMs, maxZoom: +v.maxZoom, insets: null, rule: null };
    const want = !!v.enabled && !framed();
    if (want && !supported()) { console.warn('[ComfyAF] this ComfyUI canvas is not one I know — CanvasAssist stays off'); if (on) unbind(); return; }
    if (want && !on) bind(); else if (!want && on) unbind();
  }, 0);
}

/** 2026-11-14: the plugin was called ComfyRemote. Its settings were saved under "ComfyRemote.…": carry them over once. */
async function carryOver(ids) {
  try {
    if (localStorage.getItem('comfyaf:settings-carried:' + ids[0])) return;
    const st = app.extensionManager && app.extensionManager.setting;
    if (!st) return;
    for (const id of ids) {
      const old = st.get(id.replace(/^ComfyAF\./, 'ComfyRemote.'));
      if (old !== undefined && old !== null && old !== st.get(id)) await st.set(id, old);
    }
    localStorage.setItem('comfyaf:settings-carried:' + ids[0], '1');
  } catch (e) { /* nothing to carry */ }
}

app.registerExtension({
  name: 'ComfyAF.CanvasAssist',
  settings: SETTINGS.map(({ key, ...s }) => ({ ...s, category: ['ComfyAF', 'CanvasAssist', key], onChange: () => { if (opts) apply(); } })),
  async setup() { await carryOver(SETTINGS.map((s) => s.id)); apply(); },
});

/** A look from the console: window.__comfyAF.state() */
window.__comfyAF = { state: () => ({ on, framed: framed(), assisted: st.assisted, home: st.home, gliding: !!st.glide, edge: !!st.edge, drag: !!st.drag, circling: !!(circle && circle.on) }), restoreNow };
