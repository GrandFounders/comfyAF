/**
 * jsCANVAS — CanvasAssist (P42): the canvas leans in to what you are pointing at.
 *
 * An infinite canvas is hard to read when the thing you want is small on screen. With CanvasAssist
 * on, resting the mouse on an item for a moment zooms the view toward it — but only when that helps.
 * The decision is about how big the item looks ON SCREEN, which is its size × the current zoom:
 *
 *     A4 page (800×1123) at 100%   covers more than the view already  → nothing happens
 *     A4 page at 30%               ~40% of the view, text unreadable  → zoom to ~52%, the page fills ~70%
 *     Note (210×140) at 100%       ~20% of the view                   → zoom to 200% (the cap)
 *     Note at 200%                 already at the cap                 → nothing happens
 * (fractions for a 1000×800 view)
 *
 * The rule, in numbers (all options, see DEFAULTS):
 *   fill      = the larger of (item width on screen ÷ view width) and (item height ÷ view height)
 *   fill ≥ comfortFill          → already easy to see: no assist
 *   wanted    = the zoom at which fill would be targetFill, capped at maxZoom (and the camera's max)
 *   wanted ÷ zoom < minGain     → not worth moving the view for: no assist
 *
 * HOW IT MOVES. It zooms about the mouse, so the item stays under your hand instead of the whole
 * scene jumping, and then nudges the view just enough to bring the item fully on screen. The move
 * is a SPRING GLIDE (`glide: 'spring'`, the default): two critically damped springs in series, so
 * it eases in (speed builds from nothing), peaks about a third of the way, and settles without
 * overshoot. Zoom springs in log space (each step looks equally big) and the item's centre springs
 * on screen, so the item glides rather than swings. If the target changes mid-glide — another item,
 * or the way back — the glide KEEPS ITS VELOCITY and curves to the new target instead of stopping
 * dead and restarting. `glideMs` (700) is when it has visibly arrived (95%); bigger zoom changes take
 * a little longer. `glide: 'ease'` is the plain timed tween. Instant under prefers-reduced-motion.
 *
 * FINISHED WITH IT. After you click or type in the item, the view stays while you work. When you are done —
 * nothing on the canvas is selected any more and you are not typing in it (you clicked empty canvas,
 * pressed Escape, deselected) — the view goes back to the zoom you had chosen (`returnAfterWork`).
 * Selecting something else means you are still working: the view stays.
 *
 * GIVING THE VIEW BACK. Rest the mouse on empty canvas — or on a BACKDROP: an item that was already
 * easy to see at the original zoom, like the page a note sits on — and the view returns to where it
 * was before the first assist (`returnOnLeave`). Resting on another small item instead hops to it. It does NOT return when you:
 *   · clicked or typed in the item (you are working there now),
 *   · moved the view yourself (wheel, pinch, pan, fit, a zoom button) — the view is yours again,
 *   · left the canvas for the chrome (the toolbox, a panel) — you are probably about to use it on the item.
 *
 * WHEN IT STAYS QUIET: off by default (an app turns it on); mouse only (touch has no hover); the
 * Select tool only — not while drawing, placing, using Hand/Zoom, dragging, pinching or gliding;
 * Canvas Mode only (not Panel Mode, not a full-view tab); never for ink strokes or Always-in-View
 * items (a menu torn off and pinned to the canvas IS assisted, like any small item — and USING one
 * unselected does not keep the view: leave it, close it or deselect it and the view returns, unless
 * the canvas's pinnedMenus.returnAfterUse is false — torn_menu.js); and a hook (`rule`) lets an app veto or force it per item.
 *
 *     const canvas = mountCanvas({ mount, canvasAssist: true });        // on
 *     mountCanvas({ mount, canvasAssist: { enabled: false, storageKey: 'myapp.assist' } }); // a setting, off until toggled
 *     canvas.actions.setCanvasAssist(true);     // the settings checkbox
 *     canvas.parts.canvasAssist.setOptions({ maxZoom: 1.5 });
 *
 * The decision (`planAssist`) and the movement (`cameraAt`) are pure functions, tested headlessly;
 * the controller only feeds them pointer positions and the camera.
 */

import { aabb } from './snapping.js';

export const CANVAS_ASSIST_DEFAULTS = Object.freeze({
  enabled: true,         // when constructed — mountCanvas only constructs it if the app asks
  dwellMs: 450,          // the mouse rests this long on an item before the view moves
  stillPx: 6,            // movement inside this radius still counts as resting
  comfortFill: 0.5,      // an item covering half the view is already easy to see
  targetFill: 0.7,       // an assist zooms until the item covers this much of the view…
  maxZoom: 2,            // …but never past this (a button is not blown up to 500%)
  minGain: 1.25,         // a zoom change smaller than this is not worth moving the view for
  padding: 32,           // after the zoom, the item is kept this far inside the view's edge…
  insets: null,          // …plus room for chrome floating OVER the canvas: { top, right, bottom, left } px
                         // (a dock, a toolbox) — so an assisted item never ends up underneath it. A function
                         // is asked each time (chrome moves); mountCanvas measures its own parts by default
  target: 'root',        // 'root': the top-level item (a page, not the text on it) | 'innermost'
  returnOnLeave: true,   // resting on empty canvas gives the view back
  returnAfterWork: true, // after you worked in the item: deselecting it (nothing selected, not typing) gives the view back
  returnDelayMs: 650,
  glide: 'spring',       // 'spring' (eases in and out, keeps momentum when retargeted) | 'ease' (timed tween)
  glideMs: 700,          // spring: visibly arrived (95%) after this long; +15% per zoom doubling (up to 4)
  baseMs: 380,           // 'ease' only: base duration…
  perOctaveMs: 180,      // …plus this for every doubling/halving of the zoom
  maxMs: 900,
  exclude: Object.freeze(['element.ink']),   // type ids never assisted (pinned torn-off menus ARE assisted — 2026-10-23)
  rule: null,            // (info) => false (never) | true (skip the size test) | { zoom } | undefined (default rule)
  // NAVIGATION AIDS (2026-10-28) — the hands' habits, read as intent:
  hoverZoom: true,       // the hover-to-zoom above (it can be off while the aids below stay on)
  holdRepeat: true,      // HOLD a zoom button (+ / −): it keeps zooming, faster the longer you hold
  holdDelayMs: 350,      //   a press shorter than this is one step (a click)
  holdRate: 2,           //   zoom × per second while held (×2 = doubles every second), up to 2.5× that after 1.5 s
  edgeScroll: true,      // REST the mouse near an edge of the canvas: the view scrolls that way
  edgePx: 36,            //   how near (inside any chrome floating over that edge)
  edgeDwellMs: 1000,     //   how long it rests there first
  edgeSpeed: 700,        //   screen px per second (it ramps up over half a second)
  circleZoom: true,      // CIRCLE the mouse over an area: clockwise zooms in there, anticlockwise out
  circleTurns: 1.25,     //   turns of circling before it starts (ordinary movement never adds up to this)
  circleZoomPerTurn: 1.6, //  then zoom × per further turn, about the middle of the circle
  circleInvert: false,   //   true: anticlockwise zooms in, clockwise out
  circleGuide: true,     //   a faint ring in the middle of the circle while you circle: it fills as you turn, + or − inside
  circleGuideMaxPx: 30,  //   the ring's largest radius, however big the circle you draw (it never covers the work)
  dragScroll: true,      // DRAG something into the edge band or past the edge: the view scrolls that way at once,
                         //   faster the further you push, and the thing stays under the pointer (edgePx, edgeSpeed)
  storageKey: null,      // remember on/off in localStorage under this key
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** The circling ring's two colours (2026-11-12): a theme may set either variable. */
const GUIDE_IN = 'var(--jsc-circle-guide-in, #3E6AE1)';
const GUIDE_OUT = 'var(--jsc-circle-guide-out, #D9A441)';

/**
 * The values a PERSON may tune (a settings screen builds its sliders from this — hostKit's Settings ›
 * Canvas does). `scale` turns the stored value into what is shown (0.5 → 50 %, 1.6 → 160 %).
 * Everything else (exclude, rule, insets, padding…) is the app's business, not the user's.
 */
export const CANVAS_ASSIST_TUNING = Object.freeze([
  { key: 'hoverZoom', label: 'Zoom toward a small item when the mouse rests on it', type: 'toggle' },
  { key: 'dwellMs', label: 'Wait before zooming in', hint: 'How long the mouse rests on an item first', min: 150, max: 1500, step: 50, unit: 'ms' },
  { key: 'glideMs', label: 'Glide', hint: 'Shorter is snappier, longer is calmer', min: 250, max: 1500, step: 50, unit: 'ms' },
  { key: 'maxZoom', label: 'Zoom in at most to', min: 1, max: 4, step: 0.1, scale: 100, unit: '%' },
  { key: 'comfortFill', label: 'Only zoom when an item covers less than', min: 0.15, max: 0.9, step: 0.05, scale: 100, unit: '% of the view' },
  { key: 'targetFill', label: 'Zoom until the item covers', min: 0.3, max: 0.95, step: 0.05, scale: 100, unit: '% of the view' },
  { key: 'returnOnLeave', label: 'Zoom back out when the mouse rests on empty canvas (or the page behind)', type: 'toggle' },
  { key: 'returnAfterWork', label: 'Zoom back out when you finish with an item (click away, Escape)', type: 'toggle' },
  { key: 'returnDelayMs', label: 'Wait before zooming back', min: 200, max: 2500, step: 50, unit: 'ms', when: 'returnOnLeave' },
  { key: 'holdRepeat', label: 'Hold a zoom button (+ / −) to keep zooming', type: 'toggle' },
  { key: 'holdRate', label: 'Zoom speed while holding', min: 1.2, max: 4, step: 0.1, unit: '× per second', when: 'holdRepeat' },
  { key: 'edgeScroll', label: 'Scroll when the mouse rests near an edge of the canvas', type: 'toggle' },
  { key: 'edgePx', label: 'Edge zone', min: 12, max: 120, step: 2, unit: 'px', when: 'edgeScroll' },
  { key: 'edgeDwellMs', label: 'Rest at the edge for', min: 200, max: 2500, step: 50, unit: 'ms', when: 'edgeScroll' },
  { key: 'edgeSpeed', label: 'Edge scroll speed', min: 150, max: 2500, step: 50, unit: 'px/s', when: 'edgeScroll' },
  { key: 'dragScroll', label: 'Scroll when you drag something to (or past) an edge', type: 'toggle' },
  { key: 'circleZoom', label: 'Circle the mouse to zoom there (clockwise in, anticlockwise out)', type: 'toggle' },
  { key: 'circleTurns', label: 'Circling before it zooms', min: 0.5, max: 3, step: 0.25, unit: 'turns', when: 'circleZoom' },
  { key: 'circleZoomPerTurn', label: 'Zoom per turn', min: 1.1, max: 3, step: 0.05, unit: '×', when: 'circleZoom' },
  { key: 'circleInvert', label: 'Invert: anticlockwise zooms in, clockwise zooms out', type: 'toggle', when: 'circleZoom' },
  { key: 'circleGuide', label: 'Show a faint ring while circling', type: 'toggle', when: 'circleZoom' },
  { key: 'circleGuideMaxPx', label: 'Largest ring', min: 14, max: 60, step: 2, unit: 'px', when: 'circleGuide' },
]);
const TUNABLE = CANVAS_ASSIST_TUNING.map((t) => t.key);
/** comfortFill must stay below targetFill (else an assist could never be worth it) — by this much. */
const FILL_GAP = 0.05;

/**
 * THE DECISION. Should hovering this box move the camera, and to where?
 *
 * @param {object} a
 * @param {{x,y,w,h}} a.box            the item's axis-aligned box, scene coords
 * @param {{x,y,zoom,minZoom?,maxZoom?}} a.camera
 * @param {{width,height}} a.viewport  view size, px
 * @param {{x,y}} [a.pointer]          the mouse, viewport px (default: the item's centre)
 * @param {object} [a.options]         CANVAS_ASSIST_DEFAULTS overrides
 * @param {boolean|object} [a.force]   true: skip the comfort test · { zoom }: use exactly this zoom
 * @returns {{ assist: boolean, reason: string, fill: number, zoom: number, camera?: {x,y,zoom} }}
 */
export function planAssist({ box, camera, viewport, pointer, options = {}, force } = {}) {
  const o = { ...CANVAS_ASSIST_DEFAULTS, ...options };
  const vw = viewport && viewport.width, vh = viewport && viewport.height;
  const z0 = camera && camera.zoom;
  if (!box || !(box.w > 0) || !(box.h > 0) || !(vw > 0) || !(vh > 0) || !(z0 > 0)) {
    return { assist: false, reason: 'no-geometry', fill: 0, zoom: z0 || 1 };
  }
  // how much of the view the item covers along its tighter side, now — and per unit of zoom
  const perZoom = Math.max(box.w / vw, box.h / vh);
  const fill = perZoom * z0;
  const forcedZoom = force && typeof force === 'object' && Number.isFinite(force.zoom) ? force.zoom : null;
  if (forcedZoom == null && force !== true && fill >= o.comfortFill) {
    return { assist: false, reason: 'already-visible', fill, zoom: z0 };
  }
  const camMax = Number.isFinite(camera.maxZoom) ? camera.maxZoom : Infinity;
  const camMin = Number.isFinite(camera.minZoom) ? camera.minZoom : 0;
  let z1 = forcedZoom != null ? forcedZoom : Math.min(o.targetFill / perZoom, o.maxZoom);
  z1 = clamp(z1, camMin, camMax);
  if (forcedZoom == null) {
    if (z1 / z0 < o.minGain) return { assist: false, reason: z1 <= z0 ? 'at-limit' : 'small-gain', fill, zoom: z0 };
  } else if (Math.abs(z1 - z0) < 1e-9) {
    return { assist: false, reason: 'at-limit', fill, zoom: z0 };
  }

  // Zoom ABOUT THE MOUSE: the scene point under it stays under it, so the item does not run away
  // from the hand that is pointing at it…
  const px = pointer && Number.isFinite(pointer.x) ? pointer.x : box.x * z0 + camera.x + (box.w * z0) / 2;
  const py = pointer && Number.isFinite(pointer.y) ? pointer.y : box.y * z0 + camera.y + (box.h * z0) / 2;
  const sx = (px - camera.x) / z0, sy = (py - camera.y) / z0;
  let x1 = px - sx * z1, y1 = py - sy * z1;
  // …then the smallest nudge that brings the whole item into the CLEAR part of the view — inside
  // the padding and clear of floating chrome (insets) — centred there if it cannot fit.
  const pad = Math.max(0, o.padding), ins = o.insets || {};
  const side = (k) => pad + Math.max(0, +ins[k] || 0);
  const fit = (lo, size, x, span, a, b) => {     // lo: item's leading edge on screen; a/b: clear margins
    const room = span - a - b;
    if (size > room) return x + (a + (room - size) / 2) - lo;
    if (lo < a) return x + (a - lo);
    if (lo + size > span - b) return x - (lo + size - (span - b));
    return x;
  };
  x1 = fit(box.x * z1 + x1, box.w * z1, x1, vw, side('left'), side('right'));
  y1 = fit(box.y * z1 + y1, box.h * z1, y1, vh, side('top'), side('bottom'));
  return { assist: true, reason: 'assist', fill, zoom: z1, camera: { x: x1, y: y1, zoom: z1 } };
}

/** How long the move takes: longer for a bigger zoom change, capped. */
export function assistDuration(from, to, options = {}) {
  const o = { ...CANVAS_ASSIST_DEFAULTS, ...options };
  const octaves = Math.abs(Math.log2((to.zoom || 1) / (from.zoom || 1)));
  return Math.round(Math.min(o.maxMs, o.baseMs + o.perOctaveMs * octaves));
}

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** One critically damped spring step toward T — exact for a constant T over dt (no overshoot, ever). */
function springStep(s, T, w, dt) {
  const d = s.p - T, e = Math.exp(-w * dt), k = (s.v + w * d) * dt;
  s.p = T + (d + k) * e;
  s.v = (s.v - w * k) * e;
}

/** ω for a glide that visibly arrives (95%) after `ms` — two springs in series reach 95% at ≈ 7.75/ω. */
export function glideOmega(from, to, options = {}) {
  const o = { ...CANVAS_ASSIST_DEFAULTS, ...options };
  const octaves = Math.min(4, Math.abs(Math.log2((to.zoom || 1) / (from.zoom || 1))));
  return 7.75 / Math.max(0.05, (o.glideMs / 1000) * (1 + 0.15 * octaves));
}

/**
 * THE SPRING GLIDE. Pure: give it a camera to start from, one to reach and the scene point to keep
 * steady (the item's centre); call `step(seconds)` per frame for the camera to show. Channels are
 * log(zoom) and the focus point's SCREEN position — the same space as `cameraAt` — each driven by two
 * critically damped springs in series (goal → a → b; b is what you see), which is what makes it ease
 * IN as well as out. `retarget()` changes the goal (and the focus) without touching the velocity.
 */
export class SpringGlide {
  constructor(from, to, focus, omega = glideOmega(from, to)) {
    this.w = omega;
    this.f = { x: focus ? focus.x : 0, y: focus ? focus.y : 0 };
    const p = this._space(from);
    this.a = p.map((v) => ({ p: v, v: 0 }));
    this.b = p.map((v) => ({ p: v, v: 0 }));
    this.done = false;
    this._goal(to);
  }
  _space(cam) { return [Math.log(cam.zoom), this.f.x * cam.zoom + cam.x, this.f.y * cam.zoom + cam.y]; }
  _goal(to) { this.to = { x: to.x, y: to.y, zoom: to.zoom }; this.goal = this._space(to); }
  /** The camera being shown now. */
  camera() {
    const z = Math.exp(this.b[0].p);
    return { x: this.b[1].p - this.f.x * z, y: this.b[2].p - this.f.y * z, zoom: z };
  }
  /** New goal mid-glide. The camera does not jump and its velocity carries on into the new curve. */
  retarget(to, focus, omega) {
    if (focus && (focus.x !== this.f.x || focus.y !== this.f.y)) {
      // same camera, described about a different scene point: shift each stage (and its velocity)
      const dx = focus.x - this.f.x, dy = focus.y - this.f.y;
      for (const s of [this.a, this.b]) {
        const z = Math.exp(s[0].p);
        s[1].p += dx * z; s[1].v += dx * z * s[0].v;
        s[2].p += dy * z; s[2].v += dy * z * s[0].v;
      }
      this.f = { x: focus.x, y: focus.y };
    }
    if (Number.isFinite(omega) && omega > 0) this.w = omega;
    this.done = false;
    this._goal(to);
  }
  /** Advance by `dt` seconds (a long frame is capped, so a stall never becomes a lurch). */
  step(dt) {
    if (this.done) return { ...this.to };
    let left = clamp(+dt || 0, 0, 0.05);
    while (left > 1e-9) {
      const h = Math.min(left, 1 / 240);
      for (let i = 0; i < 3; i++) { springStep(this.a[i], this.goal[i], this.w, h); springStep(this.b[i], this.a[i].p, this.w, h); }
      left -= h;
    }
    const g = this.goal, near = (s, i, ep, ev) => Math.abs(s[i].p - g[i]) < ep && Math.abs(s[i].v) < ev;
    if ([this.a, this.b].every((s) => near(s, 0, 2e-4, 4e-3) && near(s, 1, 0.3, 4) && near(s, 2, 0.3, 4))) {
      this.done = true;                  // settled: land EXACTLY on the goal
      return { ...this.to };
    }
    return this.camera();
  }
}

/**
 * THE MOVEMENT. The camera `t` (0…1, already eased) of the way from `from` to `to`.
 * Zoom moves geometrically (each step looks equally big), and one scene point — `focus`, the
 * item's centre — slides in a straight line on screen, so the item glides instead of swinging.
 * t = 0 and t = 1 return exactly `from` and `to`.
 */
export function cameraAt(from, to, t, focus) {
  if (t <= 0) return { x: from.x, y: from.y, zoom: from.zoom };
  if (t >= 1) return { x: to.x, y: to.y, zoom: to.zoom };
  const z = from.zoom * Math.pow(to.zoom / from.zoom, t);
  const f = focus || { x: 0, y: 0 };
  const s0x = f.x * from.zoom + from.x, s0y = f.y * from.zoom + from.y;
  const s1x = f.x * to.zoom + to.x, s1y = f.y * to.zoom + to.y;
  return { x: s0x + (s1x - s0x) * t - f.x * z, y: s0y + (s1y - s0y) * t - f.y * z, zoom: z };
}

const isEditable = (n) => !!n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName || ''));

/**
 * The controller: listens for the mouse on the canvas host, decides with `planAssist`, moves the
 * camera with `cameraAt`. One per mounted canvas; it follows tab switches by itself.
 */
export class CanvasAssist {
  /**
   * @param {object} o
   * @param {object} o.workspace      the canvas (`TabbedWorkspace` facade or a single `Workspace`)
   * @param {Element} [o.el]          where to listen (default: workspace.el)
   * @param {Document} [o.doc]
   * …plus any CANVAS_ASSIST_DEFAULTS key.
   * Test seams: `now`, `raf`, `cancelRaf`, `setTimer`, `clearTimer`, `reducedMotion`, `storage`.
   */
  constructor(o = {}) {
    if (!o.workspace) throw new Error('CanvasAssist needs a workspace');
    this.ws = o.workspace;
    this.doc = o.doc || this.ws.doc || (typeof document !== 'undefined' ? document : null);
    this.el = o.el || this.ws.el;
    const { workspace, el, doc, now, raf, cancelRaf, setTimer, clearTimer, reducedMotion, storage, ...opts } = o;
    this._opts = { ...CANVAS_ASSIST_DEFAULTS, ...opts };
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    // wrapped, never stored bare: a built-in like requestAnimationFrame called as `this._raf(…)`
    // throws "Illegal invocation" in a browser (it must be called on window)
    const hasRaf = typeof requestAnimationFrame === 'function';
    this._raf = raf || (hasRaf ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(() => fn(this._now()), 16));
    this._cancelRaf = cancelRaf || (hasRaf && typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h));
    this._setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = clearTimer || ((h) => clearTimeout(h));
    this._reducedMotion = reducedMotion != null ? reducedMotion : null;
    this._store = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);

    this._enabled = !!this._opts.enabled;
    const remembered = this._readStored();
    if (remembered != null) this._enabled = remembered;
    // the APP's values (mount options over the defaults) — what "Reset to defaults" goes back to —
    // then whatever this person tuned, remembered under `${storageKey}:options`
    this._appTuning = this._pick(this._opts);
    const tuned = this._readTuned();
    if (tuned) Object.assign(this._opts, this._sane({ ...this._pick(this._opts), ...tuned }));

    this._dwell = null;          // { id, x, y, timer }
    this._anim = null;           // { handle, to }
    this._driving = false;       // our own camera writes are not "the user moved the view"
    this._home = null;           // the camera before the first assist — where a return goes
    this._assisted = null;       // id currently assisted
    this._engaged = false;       // pressed/typed in the assisted item: no automatic return
    this._returnTimer = null;
    this._pressing = false;
    this._subs = new Set();
    this._offs = [];
    this._edge = null;           // { dir: {x,y}, timer, raf, since } — edge scroll
    this._drag = null;           // { target, pointerId, x, y, panX, panY, raf, mods } — drag past the edge
    this._circle = { pts: [], acc: 0, on: false, last: 0 };   // circle-to-zoom
    try { this.ws._canvasAssist = this; } catch (e) { /* a frozen facade */ }
    this._bind();
  }

  /**
   * The camera before the first assist. Kept ON the workspace it belongs to as well (`_assistHome`), so
   * `serialize()` saves the view the PERSON chose, not the leaned-in one (2026-11-07: an app that saves its desks
   * a moment after every change stored the assisted zoom, and every reload opened somewhere else).
   */
  get _home() { return this.__home || null; }
  set _home(v) {
    const was = this.__homeWs;
    if (was) { try { if (was._assistHome) was._assistHome = null; } catch (e) { /* a frozen facade */ } }
    this.__home = v || null; this.__homeWs = null;
    if (!v || !this.ws) return;
    const w = this._active();
    if (w && typeof w === 'object') { try { w._assistHome = { x: v.x, y: v.y, zoom: v.zoom }; this.__homeWs = w; } catch (e) { /* a frozen facade */ } }
  }

  // ---- public ---------------------------------------------------------------

  isEnabled() { return this._enabled; }
  /** Turn it on or off (the app's setting). Off also cancels anything in flight; the view stays where it is. */
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return on;
    this._enabled = on;
    if (!on) { this._cancelDwell(); this._cancelReturn(); this._stopAnim(); this._forget(); this._resetCircle(); }
    this._writeStored(on);
    this._fire({ action: 'enabled', enabled: on });
    return on;
  }
  enable() { return this.setEnabled(true); }
  disable() { return this.setEnabled(false); }
  toggle() { return this.setEnabled(!this._enabled); }
  options() { const { enabled, ...rest } = this._opts; return { ...rest, enabled: this._enabled }; }
  /**
   * Tune it live — `{ maxZoom: 1.5, dwellMs: 300, … }`. `enabled` here is the same as setEnabled.
   * `{ remember: true }`: a PERSON tuned it (a settings slider) — the tunable values are kept on this
   * device under `${storageKey}:options` and come back next time; comfortFill/targetFill keep their gap.
   */
  setOptions(patch = {}, { remember = false } = {}) {
    const { enabled, ...rest } = patch;
    Object.assign(this._opts, rest);
    if (remember) {
      Object.assign(this._opts, this._sane(this._pick(this._opts), Object.keys(rest)));
      this._writeTuned();
    }
    if (enabled !== undefined) this.setEnabled(enabled);
    if (Object.keys(rest).length) this._fire({ action: 'options', options: this.options() });
    return this.options();
  }
  /** What a settings screen shows: each tunable value with its label, range, unit and current value. */
  tuning() { return CANVAS_ASSIST_TUNING.map((t) => ({ ...t, value: this._opts[t.key], appDefault: this._appTuning[t.key] })); }
  /** Back to the app's own values (its mount options), forgetting what this person tuned. */
  resetOptions() {
    Object.assign(this._opts, this._appTuning);
    const k = this._opts.storageKey;
    if (k && this._store) { try { this._store.removeItem(k + ':options'); } catch (e) { /* private mode */ } }
    this._fire({ action: 'options', options: this.options() });
    return this.options();
  }
  /** fn({ action: 'assist'|'return'|'enabled'|'options', id?, camera?, enabled?, options? }). Returns unsubscribe. */
  onChange(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }

  /** What hovering `id` would do right now (pointer in viewport px, optional) — for an app's own UI. */
  plan(id, pointer) {
    const info = this._info(id);
    if (!info) return { assist: false, reason: 'not-an-item', fill: 0, zoom: this._camera().zoom };
    const veto = this._veto(info);
    if (veto) return { assist: false, reason: veto, fill: 0, zoom: info.camera.zoom };
    const r = this._ruleFor(info);
    if (r === false) return { assist: false, reason: 'rule', fill: 0, zoom: info.camera.zoom };
    let insets = this._opts.insets;
    if (typeof insets === 'function') { try { insets = insets(); } catch (e) { insets = null; } }
    return planAssist({ box: info.box, camera: info.camera, viewport: info.viewport, pointer, options: { ...this._opts, insets }, force: r === true || (r && typeof r === 'object') ? r : undefined });
  }

  /** Assist `id` now (a keyboard shortcut, "show me this"), ignoring the dwell. True if the view moves. */
  assist(id, pointer) {
    if (!this._enabled || !this._canNavigate()) return false;
    const p = this.plan(id, pointer);
    if (!p.assist) return false;
    this._cancelReturn();
    if (!this._home) this._home = this._camera();
    this._engaged = false;
    this._setAssisted(id);
    this._animateTo(p.camera, this._focusOf(id));
    this._fire({ action: 'assist', id, camera: p.camera });
    return true;
  }

  /** Give the view back to where it was before the first assist. True if there was somewhere to go. */
  restore() {
    this._cancelReturn();
    if (!this._home) return false;
    const home = this._home, id = this._assisted;
    this._home = null; this._engaged = false; this._menuHeld = false;
    this._setAssisted(null);
    this._animateTo(home, id ? this._focusOf(id) : null);
    this._fire({ action: 'return', id, camera: home });
    return true;
  }

  /** Is the view currently leaned in (an assist that a return would undo)? */
  isAssisting() { return !!this._home; }
  assistedId() { return this._assisted; }

  destroy() {
    this._cancelDwell(); this._cancelReturn(); this._stopAnim(); this._setAssisted(null); this._stopEdge(); this._resetCircle(); this._endDrag();
    for (const off of this._offs.splice(0)) { try { off(); } catch (e) { /* teardown */ } }
    this._subs.clear();
    this._home = null;
  }

  // ---- wiring ---------------------------------------------------------------

  _bind() {
    const el = this.el;
    if (el && el.addEventListener) {
      const on = (type, fn, capture = true) => { el.addEventListener(type, fn, capture); this._offs.push(() => el.removeEventListener(type, fn, capture)); };
      on('pointermove', (e) => { if (this._dragMove(e)) return; this._onMove(e); });
      on('pointerdown', (e) => this._onDown(e));
      on('pointerup', () => this._endDrag());
      on('pointercancel', () => this._endDrag());
      // when a click finishes, look again: a click on empty canvas means "done with it"
      // (the selection may already have been empty, so no selection message would come)
      on('pointerup', () => { this._pressing = false; this._setTimer(() => this._checkDone(), 0); });
      on('pointercancel', () => { this._pressing = false; });
      on('pointerleave', () => { this._cancelDwell(); this._stopEdge(); this._resetCircle(); }, false);
      // into a document/plugin window (an iframe): this canvas hears nothing more from the pointer until it
      // comes back, so an edge scroll or a dwell started here must stop now, not run on unseen (2026-11-07)
      on('pointerover', (e) => { const t = e && e.target; if (t && t.tagName === 'IFRAME') { this._cancelDwell(); this._stopEdge(); this._resetCircle(); } });
      // (a wheel that moves the view arrives through onCamera below; one that only scrolls a
      // note's text does not, and must not cost the person their way back)
      on('keydown', (e) => { if (this._assisted && isEditable(e.target)) this._engaged = true; });
    }
    const view = this.doc && this.doc.defaultView;
    if (view && view.addEventListener) {
      const onWin = (type, fn) => { view.addEventListener(type, fn, true); this._offs.push(() => view.removeEventListener(type, fn, true)); };
      // a release anywhere on the page ends our press and any drag-scroll; leaving the window stops everything
      onWin('pointerup', () => { if (this._pressing) this._pressing = false; this._endDrag(); });
      onWin('pointercancel', () => { this._pressing = false; this._endDrag(); });
      onWin('blur', () => { this._pressing = false; this._endDrag(); this._cancelDwell(); this._stopEdge(); this._resetCircle(); });
    }
    if (typeof this.ws.onCamera === 'function') {
      this._offs.push(this.ws.onCamera((ev) => {
        if (this._driving) return;
        if (ev && ev.reason && ev.reason !== 'camera') return;   // geometry moves are not view moves
        this._userTookOver();
      }));
    }
    // "finished with the item": the selection emptied, or focus left an editor
    if (typeof this.ws.onMessage === 'function') {
      this._offs.push(this.ws.onMessage((env) => {
        if (!env) return;
        if (env.action === 'selection:changed') { this._onPinnedMenuSelection(); this._checkDone(); }
        else if (env.action === 'instance:dispose') this._onPinnedMenuClosed(env.instanceId);
      }));
    }
    const d = this.doc;
    if (d && d.addEventListener) {
      const onOut = () => this._setTimer(() => this._checkDone(), 0);   // after focus has moved
      d.addEventListener('focusout', onOut, true);
      this._offs.push(() => d.removeEventListener('focusout', onOut, true));
    }
    if (typeof this.ws.onDocument === 'function') {
      this._offs.push(this.ws.onDocument(() => { this._cancelDwell(); this._cancelReturn(); this._stopAnim(); this._forget(); }));
    }
  }

  _onDown(e) {
    this._pressing = true;
    this._stopEdge(); this._resetCircle();
    this._beginDrag(e);
    this._cancelDwell();
    this._cancelReturn();
    // a press while leaned in — on the item, its handles, anywhere — means "I'm working here now":
    // keep this view (a drag that then pans the camera hands it over to the user anyway).
    // Except USING a pinned menu (a row, its title bar, its ✕) while it is not selected: a menu is a
    // tool you reach for, so the view still goes back once you leave, close or deselect it (2026-10-24).
    if (this._assisted && !this._usingPinnedMenu(e)) this._engaged = true;
    // returnAfterUse: false — a press in the menu holds the view like a selected item would (a pinned
    // menu is never selected by a click, so "nothing selected" must not read as "finished"); the next
    // press anywhere else lets go of it.
    this._menuHeld = !!(this._assisted && this._assistedMenu && !this._pinnedMenuReturns() && this._idFromEvent(e) === this._assisted);
  }

  /** Pinned menus: does CanvasAssist give the view back after one is used? (torn_menu.js PINNED MENUS) */
  _pinnedMenuReturns() { const p = this.ws.pinnedMenus; return !(p && typeof p === 'object' && p.returnAfterUse === false); }

  /** A press inside the ASSISTED pinned menu while that menu is not selected. */
  _usingPinnedMenu(e) {
    if (!this._assistedMenu || !this._pinnedMenuReturns()) return false;
    if (this._idFromEvent(e) !== this._assisted) return false;
    const sel = typeof this.ws.selectedIds === 'function' ? this.ws.selectedIds() : [];
    return !sel.includes(this._assisted);
  }

  /** The selection changed while leaned in on a pinned menu: selecting it means working on it now. */
  _onPinnedMenuSelection() {
    if (!this._assistedMenu || !this._home || !this._pinnedMenuReturns()) return;
    const sel = typeof this.ws.selectedIds === 'function' ? this.ws.selectedIds() : [];
    if (sel.includes(this._assisted)) this._engaged = true;
  }

  /** The assisted pinned menu was closed: finished with it — give the view back. */
  _onPinnedMenuClosed(id) {
    if (!this._assistedMenu || id !== this._assisted || !this._home || !this._pinnedMenuReturns()) return;
    this._cancelDwell();
    this._cancelReturn();
    this._returnTimer = this._setTimer(() => { this._returnTimer = null; if (this._home && this._canNavigate()) this.restore(); }, 0);
  }

  _onMove(e) {
    if (!this._enabled) return;
    if (e.pointerType && e.pointerType !== 'mouse') return;     // touch and pen have no real hover
    // a move with no button down: any press we still think is on ended where we could not see the release
    // (over a document/plugin iframe, outside the window). Without this, edge scroll and hover stayed dead
    // until the next release on the canvas itself — "the edge detection gets worse over time" (2026-11-07).
    if (this._pressing && !e.buttons) { this._pressing = false; this._endDrag(); }
    if (this._pressing || (e.buttons && e.buttons !== 0)) { this._cancelDwell(); this._stopEdge(); this._resetCircle(); return; }
    // circling happens with no button down, so it never gets in a tool's way: it works with ANY tool (pen, shapes,
    // hand, placing…), not only Select (2026-11-07). Hover-zoom and edge scroll stay Select-only.
    if (!this._canNavigate({ anyTool: true })) { this._cancelDwell(); this._stopEdge(); this._resetCircle(); return; }
    // the navigation aids read the hand first: circling, then resting at an edge
    if (this._opts.circleZoom) {
      const cr = this.ws._circleRotate;            // circle_rotate.js: over the selected item, circling TURNS it
      if (cr && typeof cr.claims === 'function' && cr.claims(e)) {
        this._resetCircle();
        // turning the item: no hover-zoom toward it meanwhile (the view leaning in mid-turn is a jolt)
        if (typeof cr.isCircling === 'function' && cr.isCircling()) { this._cancelDwell(); this._stopEdge(); return; }
      } else {
        const zooming = this._circleMove(e);
        this._drawCircleGuide();
        if (zooming) { this._cancelDwell(); this._stopEdge(); return; }
      }
    }
    if (!this._canNavigate()) { this._cancelDwell(); this._stopEdge(); return; }
    if (this._opts.edgeScroll) this._edgeMove(e); else this._stopEdge();
    if (this._edge && this._edge.raf != null) { this._cancelDwell(); return; }   // scrolling: no hover-zoom
    if (!this._opts.hoverZoom) { this._cancelDwell(); this._cancelReturn(); return; }
    const id = this._idFromEvent(e);
    const empty = !id && this._isEmptyCanvas(e);
    // a return is pending only while resting on EMPTY canvas
    if (id || !empty) this._cancelReturn();
    if (!id) {
      this._cancelDwell();
      if (empty && this._home && !this._engaged && this._opts.returnOnLeave && !this._returnTimer) {
        this._returnTimer = this._setTimer(() => { this._returnTimer = null; if (this._canNavigate()) this.restore(); }, this._opts.returnDelayMs);
      }
      return;
    }
    if (id === this._assisted) { this._cancelDwell(); return; }   // already leaned in on this one
    // a BACKDROP (it was easy to see before we leaned in — the page the note sits on): leaving onto it
    // is leaving, so it gives the view back, like empty canvas. Without this, a desk covered by a big
    // page (GuaP's invoice) would never zoom back out.
    if (this._home && this._isBackdrop(id)) {
      this._cancelDwell();
      if (!this._engaged && this._opts.returnOnLeave && !this._returnTimer) {
        this._returnTimer = this._setTimer(() => { this._returnTimer = null; if (this._canNavigate()) this.restore(); }, this._opts.returnDelayMs);
      }
      return;
    }
    const d = this._dwell;
    if (d && d.id === id && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= this._opts.stillPx) return;  // still resting
    this._cancelDwell();
    const at = { id, x: e.clientX, y: e.clientY, timer: null };
    at.timer = this._setTimer(() => {
      if (this._dwell !== at) return;
      this._dwell = null;
      if (!this._enabled || this._pressing || !this._canNavigate() || this._typing()) return;
      this.assist(id, this._toViewport(at.x, at.y));
    }, this._opts.dwellMs);
    this._dwell = at;
  }

  // ---- navigation aids (2026-10-28) ----------------------------------------------

  /** Over a control (a button, a field, the chrome) the hand is using it, not navigating. */
  _overControl(e) {
    let n = e.composedPath ? e.composedPath()[0] : e.target;
    if (n && n.nodeType !== 1) n = n.parentElement;
    return !!(n && n.closest && n.closest('button, input, textarea, select, a, [contenteditable="true"], .jsc-zoombar, .jsc-drawer, .jsc-toolbox, [role="menu"], [role="toolbar"]'));
  }
  _insets() {
    const i = typeof this._opts.insets === 'function' ? this._opts.insets() : this._opts.insets;
    return { top: 0, right: 0, bottom: 0, left: 0, ...(i || {}) };
  }

  /** EDGE SCROLL: the mouse rests in the band along an edge (inside any chrome over it) → after edgeDwellMs
   *  the view scrolls toward that edge, ramping up, for as long as the mouse stays in the band. */
  /** A window on this desk is MAXIMIZED (it fills the view, at 100%): the view belongs to it, and the canvas
   *  must not scroll out from under it — no edge scroll, no drag-past-the-edge (2026-11-07). */
  _maximized() {
    try {
      const ids = typeof this.ws.instanceIds === 'function' ? this.ws.instanceIds() : [];
      return ids.some((id) => { const c = this.ws.component(id); return !!(c && c.isWindow && c.windowState === 'maximized'); });
    } catch (e) { return false; }
  }
  _edgeMove(e) {
    if (this._maximized()) return this._stopEdge();
    const r = this._viewRect(); if (!r.width || !r.height) return this._stopEdge();
    const x = e.clientX - r.left, y = e.clientY - r.top, z = this._opts.edgePx, ins = this._insets();
    let dx = 0, dy = 0;
    if (x >= 0 && x < ins.left + z) dx = 1; else if (x <= r.width && x > r.width - ins.right - z) dx = -1;
    if (y >= 0 && y < ins.top + z) dy = 1; else if (y <= r.height && y > r.height - ins.bottom - z) dy = -1;
    if ((!dx && !dy) || this._overControl(e) || this._typing()) return this._stopEdge();
    const ed = this._edge;
    if (ed) { ed.dir = { x: dx, y: dy }; return; }                       // still in the band: keep waiting / scrolling
    const at = { dir: { x: dx, y: dy }, timer: null, raf: null, since: 0 };
    const fire = () => {
      if (this._edge !== at) return;
      at.timer = null;
      if (!this._enabled || this._pressing || !this._canNavigate() || this._maximized()) return this._stopEdge();
      // resting on empty canvas also gives an assisted view back: let that finish first, then scroll
      if (this._home || this._anim || this._returnTimer) { at.timer = this._setTimer(fire, 250); return; }
      this._userTookOver(); this._edge = at;                              // the view is the person's again
      at.since = this._now(); let last = at.since;
      const step = () => {
        if (this._edge !== at) return;
        const now = this._now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
        const ramp = Math.min(1, (now - at.since) / 500);
        const v = this._opts.edgeSpeed * (0.25 + 0.75 * ramp) * dt;
        const c = this._camera();
        this._write({ x: c.x + at.dir.x * v, y: c.y + at.dir.y * v, zoom: c.zoom });
        at.raf = this._raf(step);
      };
      at.raf = this._raf(step);
    };
    at.timer = this._setTimer(fire, this._opts.edgeDwellMs);
    this._edge = at;
  }
  _stopEdge() {
    const ed = this._edge; if (!ed) return;
    if (ed.timer) this._clearTimer(ed.timer);
    if (ed.raf != null) { try { this._cancelRaf(ed.raf); } catch (e) { /* gone */ } }
    this._edge = null;
  }

  /** CIRCLE TO ZOOM: add up how much the mouse's direction turns. Ordinary movement turns a little and turns
   *  back; circling keeps turning one way. Past circleTurns, every further turn zooms by circleZoomPerTurn
   *  about the middle of the circle — clockwise in, anticlockwise out. Returns true while it is zooming. */
  _circleMove(e) {
    const now = this._now();
    if (this._overControl(e) || this._typing()) { this._resetCircle(); return false; }
    if (now - this._circle.last > 350) this._resetCircle();              // a pause ends a gesture
    const C = this._circle;
    C.last = now;
    const p = { x: e.clientX, y: e.clientY, t: now };
    const pts = C.pts; const prev = pts[pts.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 6) return C.on;   // resample by distance
    pts.push(p);
    while (pts.length && now - pts[0].t > 1600) pts.shift();             // the last moment of movement
    if (pts.length < 3) return C.on;
    const a = pts[pts.length - 3], b = pts[pts.length - 2], c = pts[pts.length - 1];
    const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
    let d = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);     // + clockwise on screen (y down)
    if (Math.abs(d) > 2.4) d = 0;                                         // a jerk back, not a turn
    if (C.acc && Math.sign(d) !== Math.sign(C.acc) && Math.abs(d) > 0.6) { C.acc = d; C.on = false; return false; }
    C.acc += d;
    // the circle must be a circle-sized movement: not a jitter, not a sweep across the screen
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
    const size = Math.max(maxX - minX, maxY - minY);
    if (size < 30 || size > 700) { if (!C.on) return false; }
    const need = this._opts.circleTurns * 2 * Math.PI;
    if (!C.on) {
      if (Math.abs(C.acc) < need) return false;
      C.on = true; C.used = Math.sign(C.acc) * need;
      this._userTookOver();
    }
    const more = C.acc - C.used; C.used = C.acc;
    if (!more) return true;
    const f = Math.pow(this._opts.circleZoomPerTurn, (this._opts.circleInvert ? -more : more) / (2 * Math.PI));
    const r = this._viewRect();
    const cx = (minX + maxX) / 2 - r.left, cy = (minY + maxY) / 2 - r.top;
    const cam = this._camera();
    const zoom = clamp(cam.zoom * f, cam.minZoom || 0.05, cam.maxZoom || 8);
    const k = zoom / cam.zoom;
    if (k !== 1) this._write({ x: cx - (cx - cam.x) * k, y: cy - (cy - cam.y) * k, zoom });
    return true;
  }
  _resetCircle() { this._circle = { pts: [], acc: 0, on: false, last: 0, used: 0 }; this._hideCircleGuide(); }

  /** THE CIRCLE GUIDE (2026-11-12): circle-to-zoom has no other sign that it is happening, so while you circle a faint
   *  ring sits in the middle of the circle. It fills as you turn (full = the zoom starts) and shows + (zooms in) or −
   *  (zooms out). Its radius follows the circle you draw but stops at circleGuideMaxPx, so it never covers the work.
   *  Ordinary movement (under a fifth of the turning needed) shows nothing. Colours: zooming in is blue
   *  (--jsc-circle-guide-in), zooming out is gold (--jsc-circle-guide-out). Drawn from this._circle, the same
   *  numbers that decide the zoom. */
  _drawCircleGuide() {
    const C = this._circle, o = this._opts;
    if (!o.circleGuide || !this._enabled || !C || !C.pts || C.pts.length < 3) { this._hideCircleGuide(); return; }
    const need = o.circleTurns * 2 * Math.PI;
    const k = C.on ? 1 : Math.min(1, Math.abs(C.acc) / need);
    if (!C.on && k < 0.2) { this._hideCircleGuide(); return; }
    const g = this._circleGuideEl();
    if (!g) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of C.pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
    const box = g.svg.getBoundingClientRect ? g.svg.getBoundingClientRect() : { left: 0, top: 0 };
    const x = (minX + maxX) / 2 - box.left, y = (minY + maxY) / 2 - box.top;
    const r = clamp(Math.max(maxX - minX, maxY - minY) / 2, 12, Math.max(12, +o.circleGuideMaxPx || 30));
    const cw = C.acc > 0, zoomIn = o.circleInvert ? !cw : cw;
    g.track.setAttribute('cx', x); g.track.setAttribute('cy', y); g.track.setAttribute('r', r);
    const a1 = -Math.PI / 2, a2 = a1 + (cw ? 1 : -1) * Math.min(k, 0.9999) * 2 * Math.PI;
    g.arc.setAttribute('d', `M${x + r * Math.cos(a1)} ${y + r * Math.sin(a1)} A${r} ${r} 0 ${k > 0.5 ? 1 : 0} ${cw ? 1 : 0} ${x + r * Math.cos(a2)} ${y + r * Math.sin(a2)}`);
    const s = Math.max(3, r * 0.3);
    g.sign.setAttribute('d', `M${x - s} ${y} H${x + s}` + (zoomIn ? ` M${x} ${y - s} V${y + s}` : ''));
    g.svg.style.color = zoomIn ? GUIDE_IN : GUIDE_OUT;               // blue zooms in, gold zooms out
    g.svg.style.opacity = C.on ? '0.7' : String(0.25 + 0.35 * k);
    if (this._guideTimer != null) this._clearTimer(this._guideTimer);
    this._guideTimer = this._setTimer(() => { this._guideTimer = null; this._hideCircleGuide(); }, 380);   // a pause ends the gesture
  }
  _circleGuideEl() {
    if (this._guide) return this._guide;
    const doc = this.doc, host = this.el;
    if (!doc || typeof doc.createElementNS !== 'function' || !host || typeof host.appendChild !== 'function') return null;
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => { const n = doc.createElementNS(NS, tag); for (const a in attrs) n.setAttribute(a, attrs[a]); return n; };
    const svg = mk('svg', { class: 'jsc-circle-guide', 'aria-hidden': 'true' });
    const still = this._reducedMotion != null ? this._reducedMotion
      : !!(doc.defaultView && doc.defaultView.matchMedia && doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches);
    Object.assign(svg.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'visible',
      pointerEvents: 'none', zIndex: '36', opacity: '0', color: GUIDE_IN,
      transition: still ? 'none' : 'opacity 160ms ease, color 160ms ease' });
    const track = mk('circle', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-opacity': '0.35' });
    const arc = mk('path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
    const sign = mk('path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round' });
    svg.appendChild(track); svg.appendChild(arc); svg.appendChild(sign);
    host.appendChild(svg);
    this._guide = { svg, track, arc, sign };
    this._offs.push(() => { if (svg.parentNode) svg.parentNode.removeChild(svg); this._guide = null; });
    return this._guide;
  }
  _hideCircleGuide() {
    if (this._guideTimer != null) { this._clearTimer(this._guideTimer); this._guideTimer = null; }
    if (this._guide) this._guide.svg.style.opacity = '0';
  }

  /** DRAG PAST THE EDGE: a press on an item may become a drag. While it is held in the edge band (or beyond the
   *  view — the pointer is captured), the view scrolls that way at once, faster the deeper you push. The item is
   *  kept under the pointer: every move of this drag is handed on with the scroll so far taken off its position
   *  (the item's own drag code then places it where the pointer now is on the scene). */
  _beginDrag(e) {
    this._endDrag();
    if (!this._enabled || !this._opts.dragScroll || (e.button != null && e.button !== 0)) return;
    if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    if (!this._canNavigate() || this._overControl(e) || isEditable(e.target)) return;
    if (!this._idFromEvent(e)) return;                                       // empty canvas: that press pans
    this._drag = { target: null, pointerId: e.pointerId, x: e.clientX, y: e.clientY, panX: 0, panY: 0, raf: null, dir: { x: 0, y: 0 }, depth: 0, mods: {} };
  }
  _dragMove(e) {
    const d = this._drag;
    if (d && !e.__assistSynthetic && !e.buttons) { this._endDrag(); return false; }   // released where we could not see it
    if (!d || e.__assistSynthetic || (d.pointerId != null && e.pointerId !== d.pointerId) || !e.buttons) return false;
    d.x = e.clientX; d.y = e.clientY; d.target = e.target || d.target;
    d.mods = { altKey: !!e.altKey, shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, buttons: e.buttons, pointerType: e.pointerType || 'mouse' };
    // where is the pointer: in the band (depth 0…1) or past the edge (up to 2)?
    const r = this._viewRect(); const z = Math.max(1, this._opts.edgePx); const ins = this._insets();
    const lx = e.clientX - r.left, ly = e.clientY - r.top;
    const axis = (p, lo, hi) => (p < lo + z ? Math.min(2, (lo + z - p) / z) : p > hi - z ? -Math.min(2, (p - (hi - z)) / z) : 0);
    const ax = r.width ? axis(lx, ins.left, r.width - ins.right) : 0, ay = r.height ? axis(ly, ins.top, r.height - ins.bottom) : 0;
    d.dir = { x: Math.sign(ax), y: Math.sign(ay) }; d.depth = Math.max(Math.abs(ax), Math.abs(ay));
    if (this._maximized()) d.dir = { x: 0, y: 0 };                         // a maximized window owns the view
    if ((d.dir.x || d.dir.y) && d.raf == null && this._canNavigate()) this._startDragScroll();
    if (d.panX || d.panY) { this._handOn(e.target, e.clientX, e.clientY); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); return true; }
    return false;
  }
  _startDragScroll() {
    const d = this._drag; if (!d) return;
    this._userTookOver();
    let last = this._now();
    const step = () => {
      if (this._drag !== d) return;
      if (!d.dir.x && !d.dir.y) { d.raf = null; return; }                    // back inside: wait for the next push
      const now = this._now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const v = this._opts.edgeSpeed * (0.3 + d.depth) * dt;
      const c = this._camera();
      const vx = d.dir.x * v, vy = d.dir.y * v;
      this._write({ x: c.x + vx, y: c.y + vy, zoom: c.zoom });
      d.panX += vx; d.panY += vy;
      this._handOn(d.target, d.x, d.y);                                       // the item follows, though the pointer is still
      d.raf = this._raf(step);
    };
    d.raf = this._raf(step);
  }
  /** Hand the drag a move at the pointer, minus the scroll so far (so the item lands under the pointer). */
  _handOn(target, x, y) {
    const d = this._drag; if (!d || !target || typeof target.dispatchEvent !== 'function') return;
    const View = (this.doc && this.doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    const Ctor = View && (View.PointerEvent || View.MouseEvent);
    if (!Ctor) return;
    try {
      const ev = new Ctor('pointermove', { bubbles: true, cancelable: true, composed: true, clientX: x - d.panX, clientY: y - d.panY, pointerId: d.pointerId, ...d.mods });
      Object.defineProperty(ev, '__assistSynthetic', { value: true });
      target.dispatchEvent(ev);
    } catch (err) { /* an old browser: the view still scrolls */ }
  }
  _endDrag() {
    const d = this._drag; if (!d) return;
    if (d.raf != null) { try { this._cancelRaf(d.raf); } catch (e) { /* gone */ } }
    this._drag = null;
  }

  /**
   * Done working? Only after a press or typing in the leaned-in view (engaged), and only when nothing
   * is selected and nothing in the canvas has the keyboard. Then, after returnDelayMs, the view goes back.
   */
  _checkDone() {
    if (!this._enabled || !this._home || !this._engaged || !this._opts.returnAfterWork) return;
    const sel = typeof this.ws.selectedIds === 'function' ? this.ws.selectedIds() : [];
    if (sel.length || this._typing() || this._menuHeld) { this._cancelReturn(); return; }
    this._cancelReturn();
    this._returnTimer = this._setTimer(() => {
      this._returnTimer = null;
      const still = typeof this.ws.selectedIds === 'function' ? this.ws.selectedIds() : [];
      if (this._home && this._engaged && !still.length && !this._typing() && !this._pressing && this._canNavigate()) this.restore();
    }, this._opts.returnDelayMs);
  }

  /** The user moved the view: theirs again — stop, and forget where a return would have gone. */
  _userTookOver() {
    if (this._driving) return;
    this._cancelDwell();
    this._cancelReturn();
    this._stopAnim();
    this._forget();
  }

  _forget() { this._home = null; this._engaged = false; this._menuHeld = false; this._setAssisted(null); }

  // ---- reading the canvas -----------------------------------------------------

  _active() { return typeof this.ws.active === 'function' ? this.ws.active() : this.ws; }
  _camera() {
    const c = typeof this.ws.getCamera === 'function' ? this.ws.getCamera() : null;
    return c ? { x: c.x, y: c.y, zoom: c.zoom, minZoom: c.minZoom, maxZoom: c.maxZoom } : { x: 0, y: 0, zoom: 1 };
  }
  _viewRect() {
    const w = this._active();
    const el = w && w.el;
    return el && el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  }
  _toViewport(cx, cy) { const r = this._viewRect(); return { x: cx - r.left, y: cy - r.top }; }

  /** May the view move now? `anyTool`: whatever tool is active (circle-to-zoom) — Canvas Mode, a navigable desk and no
   *  gesture in flight are still required; otherwise also the Select tool, not placing, not drawing. */
  _canNavigate({ anyTool = false } = {}) {
    const ws = this.ws;
    if (!this._active()) return false;
    try {
      if (ws.slot && ws.slot().mode !== 'canvas') return false;
      if (ws.slotPolicy && !ws.slotPolicy().navigable) return false;
      if (ws.fullView && ws.fullView()) return false;
      if (ws.isGesturing && ws.isGesturing()) return false;
      if (anyTool) return true;
      if (ws.isPlacing && ws.isPlacing()) return false;
      if (ws.drawsThrough && ws.drawsThrough()) return false;
      const tool = ws.activeTool ? ws.activeTool() : 'select';
      if (tool && tool !== 'select') return false;
    } catch (e) { return false; }
    return true;
  }

  _typing() {
    let a = this.doc && this.doc.activeElement;
    const host = a;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;   // into shadow DOM
    if (!isEditable(a)) return false;
    const w = this._active();
    return !!(w && w.el && w.el.contains && w.el.contains(host));
  }

  _idFromEvent(e, innermost = false) {
    const path = e && typeof e.composedPath === 'function' ? e.composedPath() : (e && e.target ? [e.target] : []);
    const w = this._active();
    let id = null;
    for (const n of path) {
      if (!n || (w && (n === w.el || n === w.world))) break;
      const cand = n.dataset && n.dataset.instanceId;
      if (cand && this.ws.component(cand)) { id = cand; break; }
    }
    if (!id || innermost || this._opts.target === 'innermost') return id;
    let guard = 0;
    while (guard++ < 64) { const o = this.ws.ownerOf ? this.ws.ownerOf(id) : null; if (!o) break; id = o; }
    return id;
  }

  /** The pasteboard itself — not an item, not chrome drawn over the canvas (handles, the selection bar). */
  _isEmptyCanvas(e) {
    const w = this._active();
    const t = e && e.target;
    return !!(w && t && (t === w.el || t === w.world));
  }

  _info(id) {
    const comp = id && this.ws.component(id);
    if (!comp) return null;
    const g = this.ws.geomOf ? this.ws.geomOf(id) : (comp.getGeom && comp.getGeom());
    if (!g) return null;
    const r = this._viewRect();
    return {
      id, typeId: comp.typeId || null, kind: comp.elementKind || null, component: comp,
      box: aabb(g), camera: this._camera(), viewport: { width: r.width, height: r.height },
    };
  }

  /** Was this item already easy to see at the zoom we will return to? (then it is backdrop, not a target) */
  _isBackdrop(id) {
    const info = this._info(id), home = this._home;
    if (!info || !home || !(info.viewport.width > 0) || !(info.viewport.height > 0)) return false;
    const fill = Math.max(info.box.w / info.viewport.width, info.box.h / info.viewport.height) * home.zoom;
    return fill >= this._opts.comfortFill;
  }

  _veto(info) {
    const ws = this.ws;
    if ((this._opts.exclude || []).includes(info.typeId)) return 'excluded';
    if (ws.isAlwaysInView && ws.isAlwaysInView(info.id)) return 'always-in-view';
    if (ws.isVisible && !ws.isVisible(info.id)) return 'hidden';
    return null;
  }

  _ruleFor(info) {
    const fn = this._opts.rule;
    if (typeof fn !== 'function') return undefined;
    try { return fn({ id: info.id, typeId: info.typeId, kind: info.kind, box: info.box, camera: info.camera, viewport: info.viewport }); }
    catch (e) { return undefined; }
  }

  _focusOf(id) {
    const g = this.ws.geomOf ? this.ws.geomOf(id) : null;
    if (!g) return null;
    const b = aabb(g);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  _setAssisted(id) {
    const prev = this._assisted && this.ws.component(this._assisted);
    if (prev && prev.el && prev.el.classList) prev.el.classList.remove('jsc-assist-target');
    this._assisted = id || null;
    const next = id && this.ws.component(id);
    this._assistedMenu = !!(next && next.isPinnedMenu);
    if (next && next.el && next.el.classList) next.el.classList.add('jsc-assist-target');
  }

  // ---- moving the camera ------------------------------------------------------

  _prefersReducedMotion() {
    if (this._reducedMotion != null) return !!this._reducedMotion;
    const view = this.doc && this.doc.defaultView;
    try { return !!(view && view.matchMedia && view.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  _write(cam) {
    this._driving = true;
    try { this.ws.setCamera({ x: cam.x, y: cam.y, zoom: cam.zoom }); }
    finally { this._driving = false; }
  }

  _animateTo(to, focus) {
    if (this.ws.stopGlide) this.ws.stopGlide();
    const from = this._camera();
    if (this._prefersReducedMotion()) { this._stopAnim(); this._write(to); return; }
    if (this._opts.glide !== 'ease') return this._springTo(from, to, focus);
    this._stopAnim();
    const ms = assistDuration(from, to, this._opts);
    if (ms <= 0) { this._write(to); return; }
    const t0 = this._now();
    const anim = { handle: null, to };
    const step = () => {
      if (this._anim !== anim) return;
      const t = clamp((this._now() - t0) / ms, 0, 1);
      this._write(cameraAt(from, to, easeInOutCubic(t), focus));
      if (t >= 1) { this._anim = null; return; }
      anim.handle = this._raf(step);
    };
    this._anim = anim;
    anim.handle = this._raf(step);
  }

  /** The spring glide. Already gliding? Steer the same glide — its momentum carries into the new target. */
  _springTo(from, to, focus) {
    const f = focus || this._viewCentreScene(from);
    const omega = glideOmega(from, to, this._opts);
    if (this._anim && this._anim.spring) { this._anim.spring.retarget(to, f, omega); return; }
    this._stopAnim();
    const spring = new SpringGlide(from, to, f, omega);
    const anim = { handle: null, spring, last: this._now() };
    const step = () => {
      if (this._anim !== anim) return;
      const now = this._now();
      const cam = spring.step((now - anim.last) / 1000);
      anim.last = now;
      this._write(cam);
      if (spring.done) { this._anim = null; return; }
      anim.handle = this._raf(step);
    };
    this._anim = anim;
    anim.handle = this._raf(step);
  }

  _viewCentreScene(cam) {
    const r = this._viewRect();
    return { x: (r.width / 2 - cam.x) / cam.zoom, y: (r.height / 2 - cam.y) / cam.zoom };
  }

  _stopAnim() {
    if (!this._anim) return;
    if (this._anim.handle != null) { try { this._cancelRaf(this._anim.handle); } catch (e) { /* gone */ } }
    this._anim = null;
  }

  _cancelDwell() { if (this._dwell) { this._clearTimer(this._dwell.timer); this._dwell = null; } }
  _cancelReturn() { if (this._returnTimer) { this._clearTimer(this._returnTimer); this._returnTimer = null; } }

  _fire(ev) { for (const fn of [...this._subs]) { try { fn(ev); } catch (e) { /* a listener must not break the canvas */ } } }

  _pick(o) { const out = {}; for (const k of TUNABLE) if (o[k] !== undefined) out[k] = o[k]; return out; }
  /** Clamp tuned values to their ranges and keep comfortFill < targetFill, moving the one NOT just changed. */
  _sane(v, changed = []) {
    const out = { ...v };
    for (const t of CANVAS_ASSIST_TUNING) {
      if (!(t.key in out)) continue;
      if (t.type === 'toggle') { out[t.key] = !!out[t.key]; continue; }
      const n = +out[t.key];
      out[t.key] = Number.isFinite(n) ? clamp(n, t.min, t.max) : this._appTuning[t.key];
    }
    if (out.comfortFill != null && out.targetFill != null && out.targetFill < out.comfortFill + FILL_GAP) {
      if (changed.includes('targetFill') && !changed.includes('comfortFill')) out.comfortFill = Math.max(0.15, +(out.targetFill - FILL_GAP).toFixed(4));
      else out.targetFill = Math.min(0.95, +(out.comfortFill + FILL_GAP).toFixed(4));
      if (out.targetFill < out.comfortFill + FILL_GAP) out.comfortFill = +(out.targetFill - FILL_GAP).toFixed(4);
    }
    return out;
  }
  _readTuned() {
    const k = this._opts.storageKey;
    if (!k || !this._store) return null;
    try { const raw = this._store.getItem(k + ':options'); const v = raw ? JSON.parse(raw) : null; return v && typeof v === 'object' ? this._pick(v) : null; } catch (e) { return null; }
  }
  _writeTuned() {
    const k = this._opts.storageKey;
    if (!k || !this._store) return;
    const diff = {};
    for (const key of TUNABLE) if (this._opts[key] !== this._appTuning[key]) diff[key] = this._opts[key];
    try { if (Object.keys(diff).length) this._store.setItem(k + ':options', JSON.stringify(diff)); else this._store.removeItem(k + ':options'); } catch (e) { /* private mode */ }
  }

  _readStored() {
    const k = this._opts.storageKey;
    if (!k || !this._store) return null;
    try { const v = this._store.getItem(k); return v === '1' ? true : v === '0' ? false : null; } catch (e) { return null; }
  }
  _writeStored(on) {
    const k = this._opts.storageKey;
    if (!k || !this._store) return;
    try { this._store.setItem(k, on ? '1' : '0'); } catch (e) { /* private mode */ }
  }
}

export default CanvasAssist;
