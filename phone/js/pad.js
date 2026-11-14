/* ComfyAF phone — the touch pad: pan, drag the selected nodes, pinch, mouse gestures (from EcoRemote's pad.js) */
import { $, buzz, clamp, S, settings } from './state.js';
import { call, canvasReady, input, sendRaw } from './connection.js';
import { render, renderHud, toast } from './view.js';
import { pad, placeCursor, ripple, scheduleShot } from './preview.js';
import { command } from './commands.js';
// ---------------------------------------------------------------- the pad
/* Canvas mode — one finger: pan, or with a selection, move the selection · two fingers: pinch-zoom + pan
   double-tap: fit · hold: deselect.
   Mouse mode — one finger: move the mouse · tap: click · tap then drag: drag · tap-tap: double-click
   two-finger tap: right-click · two fingers: scroll. */
export const pts = new Map();
export let g = null, lastTap = { t: 0, x: 0, y: 0 }, pressTimer = null, glideRaf = 0, clickTimer = null;
export const out = { dx: 0, dy: 0, f: 1, fx: 0.5, fy: 0.5, mdx: 0, mdy: 0, kdx: 0, kdy: 0 };
export let outRaf = 0;
export function flushOut() {
  outRaf = 0;
  if (Math.abs(out.f - 1) > 0.0005) sendRaw({ t: 'zoom', f: out.f, fx: out.fx, fy: out.fy });
  if (out.dx || out.dy) sendRaw({ t: 'pan', dx: out.dx, dy: out.dy });
  if (out.mdx || out.mdy) sendRaw({ t: 'drag', phase: 'move', dx: out.mdx, dy: out.mdy });
  if (out.kdx || out.kdy) sendRaw({ t: 'mouse', dx: out.kdx, dy: out.kdy });
  out.dx = out.dy = out.mdx = out.mdy = out.kdx = out.kdy = 0; out.f = 1;
}
export const queueOut = () => { if (!outRaf) outRaf = requestAnimationFrame(flushOut); };
export const gridOff = { x: 0, y: 0 };
export function moveGrid(dx, dy) { gridOff.x += dx; gridOff.y += dy; $('#grid').style.transform = `translate(${gridOff.x % 24}px, ${gridOff.y % 24}px)`; }
/** Pad pixels → the computer's screen pixels: at 1×, a swipe across the pad moves one view-width. */
export function canvasGain() { const w = pad.getBoundingClientRect().width || 1; return (S.viewport && S.viewport.w ? S.viewport.w / w : 2.5) * settings.speed; }
export function panPad(dx, dy) {
  const s = settings.invert ? -1 : 1, k = canvasGain() * s;
  out.dx += dx * k; out.dy += dy * k; moveGrid(dx * s, dy * s);
  S.gen++; queueOut();
}
export function dragPad(dx, dy) { const k = canvasGain(); out.mdx += dx * k; out.mdy += dy * k; moveGrid(dx, dy); S.gen++; queueOut(); }
export function zoomPad(f, px, py) {
  const r = pad.getBoundingClientRect();
  out.f *= f; out.fx = clamp(px / r.width, 0, 1); out.fy = clamp(py / r.height, 0, 1);
  S.gen++; queueOut();
  if (S.camera) { S.camera = { ...S.camera, zoom: clamp(S.camera.zoom * f, S.camera.minZoom || 0.1, S.camera.maxZoom || 10) }; $('#zoomPill').textContent = Math.round(S.camera.zoom * 100) + '%'; }
}
export function mousePad(dx, dy, v) {
  const k = 1.6 * settings.mouseSpeed * (1 + Math.min(3, v * 1.15));   // faster finger → further, like a trackpad
  out.kdx += dx * k; out.kdy += dy * k; moveGrid(dx, dy);
  if (S.cursor && S.screen) { S.cursor = { x: clamp(S.cursor.x + dx * k, S.screen.left, S.screen.left + S.screen.width - 1), y: clamp(S.cursor.y + dy * k, S.screen.top, S.screen.top + S.screen.height - 1) }; placeCursor(); }
  S.gen++; queueOut();
}
export let wheelAcc = { y: 0, x: 0 }, wheelBusy = false;
export function scrollPad(dx, dy) { wheelAcc.y += dy * 4 * settings.mouseSpeed; wheelAcc.x += -dx * 4 * settings.mouseSpeed; moveGrid(dx, dy); pumpWheel(); }
export async function pumpWheel() {
  if (wheelBusy) return;
  const y = Math.trunc(wheelAcc.y), x = Math.trunc(wheelAcc.x);
  if (!y && !x) return;
  wheelAcc.y -= y; wheelAcc.x -= x; wheelBusy = true;
  try { await input('wheel', { dy: y, dx: x }); } catch (e) { toast(e.message, 'error'); wheelAcc = { y: 0, x: 0 }; }
  finally { wheelBusy = false; pumpWheel(); }
}
export async function click(action = 'click', button = 'left') {
  buzz(action === 'dbl' ? 14 : 8);
  flushOut();                                            // the moves first
  try { await input('button', { button, action }); if (action !== 'down') scheduleShot(320); }
  catch (e) { toast(e.message, 'error'); }
}
export const local = (e) => { const r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
export function twoFinger() { const [a, b] = [...pts.values()]; return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; }
export function stopGlide() { if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; } }
export const padReady = () => S.open && (S.mouse ? S.input : canvasReady());

export function endPointer(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  clearTimeout(pressTimer);
  if (!g) return;
  const now = performance.now();
  if (g.kind === 'two' || g.kind === 'scroll') {
    if (g.kind === 'scroll' && !g.moved && now - g.t < 300 && !g.done) { g.done = true; click('click', 'right'); }   // two-finger tap
    if (!pts.size) { g = null; scheduleShot(); }
    return;
  }
  if (pts.size) return;
  const gg = g; g = null;
  if (gg.kind === 'press') return;
  if (gg.kind === 'drag') { flushOut(); sendRaw({ t: 'drag', phase: 'end' }); return; }
  if (gg.kind === 'tapdrag') {
    if (gg.down) click('up');
    else if (e.type === 'pointerup') { lastTap.t = 0; ripple(gg.sx, gg.sy); click('dbl'); }   // tap-tap = double-click
    return;
  }
  if (gg.kind === 'mouse') {
    if (!gg.moved && e.type === 'pointerup' && now - gg.t < 280) {
      ripple(gg.sx, gg.sy);
      lastTap = { t: now, x: gg.sx, y: gg.sy };
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { clickTimer = null; if (S.holding) { const held = S.holding; S.holding = false; render(); click('up', held); } else click('click'); }, 230);
    } else { flushOut(); scheduleShot(350); }
    return;
  }
  if (!gg.moved && e.type === 'pointerup' && now - gg.t < 320) { tap(gg.sx, gg.sy); return; }
  if (gg.kind === 'pan' && settings.glide && now - gg.lt < 60 && Math.hypot(gg.vx, gg.vy) > 0.35) { glide(gg.vx, gg.vy); return; }
  scheduleShot();
}

export function glide(vx, vy) {
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(32, now - last); last = now;
    const decay = Math.pow(0.94, dt / 16);
    vx *= decay; vy *= decay;
    if (Math.hypot(vx, vy) < 0.03) { glideRaf = 0; scheduleShot(); return; }
    panPad(vx * dt, vy * dt);
    glideRaf = requestAnimationFrame(step);
  };
  glideRaf = requestAnimationFrame(step);
}
export function tap(x, y) {
  const now = performance.now();
  if (now - lastTap.t < 330 && Math.hypot(x - lastTap.x, y - lastTap.y) < 34) {
    lastTap.t = 0; ripple(x, y); buzz(12);
    command('fitContent');
    return;
  }
  lastTap = { t: now, x, y };
  ripple(x, y);
}
export async function longPress(p) {
  buzz(20); ripple(p.x, p.y);
  try { const r = await call('canvas_select', { ids: [] }); S.selected = r.selected || []; renderHud(); toast('Selection cleared'); scheduleShot(150); }
  catch (e) { toast(e.message, 'error'); }
}

/** Wire this part up — called by main.js once every module has loaded (they import each other). */
export function wire() {
  pad.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#pip, #padSave')) return;
    if (e.clientX <= 18 && document.documentElement.classList.contains('shell-phone')) return;   // the left edge belongs to the drawer's swipe
    if (!padReady()) return;
    try { pad.setPointerCapture(e.pointerId); } catch (err) { /* */ }
    stopGlide();
    pts.set(e.pointerId, local(e));
    $('#hint').style.opacity = 0;
    const now = performance.now();
    if (pts.size === 1) {
      const p = local(e);
      // Mouse: a touch right after a tap = drag or double-click (the pending click is cancelled)
      const second = S.mouse && clickTimer && now - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40;
      if (second) { clearTimeout(clickTimer); clickTimer = null; }
      g = { kind: S.mouse ? (second ? 'tapdrag' : 'mouse') : 'one', sx: p.x, sy: p.y, lx: p.x, ly: p.y, t: now, lt: now, moved: false, vx: 0, vy: 0, down: false };
      clearTimeout(pressTimer);
      if (!S.mouse) pressTimer = setTimeout(() => { if (g && g.kind === 'one' && !g.moved) { g.kind = 'press'; longPress(p); } }, 520);
    } else if (pts.size === 2) {
      clearTimeout(pressTimer);
      if (g && g.kind === 'drag') { flushOut(); sendRaw({ t: 'drag', phase: 'end' }); }
      if (g && g.kind === 'tapdrag' && g.down) click('up');
      const t = twoFinger();
      g = { kind: S.mouse ? 'scroll' : 'two', cx: t.cx, cy: t.cy, d: t.d, moved: false, t: now, travel: 0 };
    }
  });
  pad.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, local(e));
    if (pts.size === 1 && ['one', 'pan', 'drag', 'mouse', 'tapdrag'].includes(g.kind)) {
      const p = local(e), dx = p.x - g.lx, dy = p.y - g.ly;
      if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < (S.mouse ? 4 : 7)) return;
      const now = performance.now(), dt = Math.max(1, now - g.lt);
      g.vx = 0.8 * (dx / dt) + 0.2 * g.vx; g.vy = 0.8 * (dy / dt) + 0.2 * g.vy; g.lt = now;
      g.lx = p.x; g.ly = p.y;
      if (!g.moved) {
        g.moved = true; clearTimeout(pressTimer);
        if (g.kind === 'one') {
          // something selected → this drag moves it · nothing selected → it moves the view
          if (S.selected.length) { g.kind = 'drag'; sendRaw({ t: 'drag', phase: 'begin', dx: 0, dy: 0 }); buzz(6); }
          else g.kind = 'pan';
        }
        if (g.kind === 'tapdrag') { g.down = true; click('down'); }
      }
      if (g.kind === 'pan') panPad(dx, dy);
      else if (g.kind === 'drag') dragPad(dx, dy);
      else mousePad(dx, dy, Math.hypot(g.vx, g.vy));
    } else if (pts.size >= 2 && (g.kind === 'two' || g.kind === 'scroll')) {
      const t = twoFinger(), f = t.d / g.d, ddx = t.cx - g.cx, ddy = t.cy - g.cy;
      g.travel += Math.hypot(ddx, ddy) + Math.abs(t.d - g.d);
      if (g.travel > 10) g.moved = true;
      if (g.kind === 'two') { if (Math.abs(f - 1) > 0.003) zoomPad(f, t.cx, t.cy); panPad(ddx, ddy); }
      else if (g.moved) scrollPad(ddx, ddy);
      g.cx = t.cx; g.cy = t.cy; g.d = t.d;
    }
  });
  pad.addEventListener('pointerup', endPointer);
  pad.addEventListener('pointercancel', endPointer);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  pad.addEventListener('wheel', (e) => {   // testing from a desktop browser: the wheel zooms (or scrolls, in Mouse mode)
    if (e.target.closest('#pip') || !padReady()) return;
    e.preventDefault();
    if (S.mouse) { scrollPad(0, -e.deltaY / 4); return; }
    const p = local(e); zoomPad(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y); scheduleShot();
  }, { passive: false });
}
