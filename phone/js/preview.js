/* ComfyAF phone — the preview window (corner, resize, tap to select a node / aim the mouse) and its picture (from EcoRemote's preview.js) */
import { $, buzz, clamp, LS, ls, S, settings } from './state.js';
import { call, canvasReady, input } from './connection.js';
import { refreshState, renderHud, toast } from './view.js';
import { g, glideRaf } from './pad.js';
// ---------------------------------------------------------------- the preview window
/* It never moves with the canvas: it is a picture of the computer's view (or, in Mouse mode, of its
   screen), refreshed when you stop. Drag it anywhere and it snaps to the nearest corner; pull the grip
   (or pinch it) to resize, between PIP_MIN and the largest that fits the pad. */
export const pad = $('#pad'), pip = $('#pip'), shot = $('#shot');
export const PIP_MIN = 132, BAR_H = 32, M = 8;
export const pipState = Object.assign({ corner: 'tr', w: 190, min: false }, ls.get(LS.pip, {}));
export const savePip = () => ls.set(LS.pip, pipState);
export function pipAspect() {   // width / height of what it shows
  if (S.mouse && S.screen) return S.screen.width / S.screen.height;
  if (!S.mouse && S.viewport && S.viewport.w && S.viewport.h) return S.viewport.w / S.viewport.h;
  if (shot.naturalWidth) return shot.naturalWidth / shot.naturalHeight;
  return 16 / 10;
}
export function pipMax() {
  const r = pad.getBoundingClientRect(), a = pipAspect();
  return Math.max(PIP_MIN, Math.min(r.width - 2 * M, (r.height - 2 * M - BAR_H) * a, 900));
}
export function pipSize() { const w = clamp(pipState.w, PIP_MIN, pipMax()); return { w, h: BAR_H + w / pipAspect() }; }
export function cornerXY(corner, w, h) {
  const r = pad.getBoundingClientRect();
  return { x: corner[1] === 'l' ? M : r.width - w - M, y: corner[0] === 't' ? M : r.height - h - M };
}
export function layoutPip() {
  if (pip.hidden) { pad.style.setProperty('--save-bottom', '10px'); return; }
  pip.classList.toggle('min', !!pipState.min);
  const { w, h } = pipSize();
  if (!pipState.min) { pip.style.width = w + 'px'; pip.style.height = h + 'px'; } else { pip.style.width = ''; pip.style.height = ''; }
  const pw = pipState.min ? pip.offsetWidth : w, ph = pipState.min ? pip.offsetHeight : h;
  const { x, y } = cornerXY(pipState.corner, pw, ph);
  pip.style.transform = `translate(${x}px, ${y}px)`;
  pad.style.setProperty('--save-bottom', (pipState.corner === 'br' ? ph + M + 8 : 10) + 'px');   // the pad's ⇩ steps above a preview docked bottom-right
  // the grip sits on the corner that points into the pad
  const grip = $('#pipGrip'), c = pipState.corner;
  grip.style.left = c[1] === 'r' ? '0' : 'auto'; grip.style.right = c[1] === 'l' ? '0' : 'auto';
  grip.style.top = c[0] === 'b' ? BAR_H + 'px' : 'auto'; grip.style.bottom = c[0] === 't' ? '0' : 'auto';
  grip.querySelector('svg').style.transform = `rotate(${({ tl: 0, tr: 90, br: 180, bl: 270 })[c]}deg)`;
  $('#pipMin').querySelector('use').setAttribute('href', pipState.min ? '#i-max' : '#i-min');
  renderMarks(); placeCursor();
}

export let shotTimer = null, shotBusy = false, shotAgain = false, screenTimer = null;
export function clearShot() { shot.classList.remove('ready'); shot.removeAttribute('src'); $('#pipNone').textContent = 'Waiting for a picture…'; $('#pipNone').hidden = false; S.items = null; renderMarks(); placeCursor(); }
export function scheduleShot(ms = 450) { clearTimeout(shotTimer); shotTimer = setTimeout(takeShot, ms); }
export async function takeShot() {
  if (!settings.live || pip.hidden || pipState.min || !S.open || document.visibilityState !== 'visible') return;
  if (g || glideRaf) { scheduleShot(300); return; }
  if (shotBusy) { shotAgain = true; return; }
  const mouseMode = S.mouse;
  if (mouseMode ? !S.input : !canvasReady()) return;
  shotBusy = true; $('#pipRefresh').classList.add('spin');
  const myGen = S.gen;
  try {
    const maxSide = Math.round(clamp(pipSize().w * Math.min(2.5, window.devicePixelRatio || 1) * 1.25, 360, 1600));
    let img;
    if (mouseMode) {
      img = await input('screen', { maxSide });
      S.screen = { left: img.left, top: img.top, width: img.width, height: img.height }; S.cursor = { x: img.cx, y: img.cy };
    } else {
      [img] = await Promise.all([call('canvas_snapshot', { maxSide }), refreshState(true)]);
    }
    if (mouseMode !== S.mouse) return;
    await new Promise((res) => { shot.onload = res; shot.onerror = res; shot.src = 'data:' + img.mimeType + ';base64,' + img.data; });
    shot.classList.add('ready'); $('#pipNone').hidden = true;
    layoutPip();
    if (myGen !== S.gen) shotAgain = true;                 // it moved meanwhile: one more, soon
  } catch (e) {
    $('#pipNone').textContent = e.message; $('#pipNone').hidden = false;
  } finally {
    shotBusy = false; $('#pipRefresh').classList.remove('spin');
    if (shotAgain) { shotAgain = false; scheduleShot(350); }
  }
}
// in Mouse mode the screen changes on its own (typing, videos): refresh it every few seconds
export function loopScreen() { clearTimeout(screenTimer); if (!S.mouse) return; screenTimer = setTimeout(() => { if (!g) takeShot(); loopScreen(); }, 2500); }

/** Outlines of the selected items in the preview (canvas mode). */
export function renderMarks() {
  const box = $('#marks'); box.innerHTML = '';
  if (S.mouse || pip.hidden || pipState.min || !S.items || !S.camera || !S.selected.length || !S.viewport) return;
  const v = $('#pipView').getBoundingClientRect(), k = v.width / S.viewport.w, c = S.camera;
  for (const id of S.selected) {
    const it = S.items.find((x) => x.id === id); if (!it) continue;
    const el = document.createElement('div'); el.className = 'mark';
    el.style.left = ((it.x * c.zoom + c.x) * k) + 'px'; el.style.top = ((it.y * c.zoom + c.y) * k) + 'px';
    el.style.width = Math.max(4, it.w * c.zoom * k) + 'px'; el.style.height = Math.max(4, it.h * c.zoom * k) + 'px';
    box.append(el);
  }
}
/** Mouse mode: a ring where the cursor is now (the picture shows where it was). */
export function placeCursor() {
  const dot = $('#cursorDot');
  if (!S.mouse || !S.screen || !S.cursor || pipState.min || pip.hidden) { dot.hidden = true; return; }
  const v = $('#pipView').getBoundingClientRect();
  dot.hidden = false;
  dot.style.left = ((S.cursor.x - S.screen.left) / S.screen.width * v.width) + 'px';
  dot.style.top = ((S.cursor.y - S.screen.top) / S.screen.height * v.height) + 'px';
}
export function ripple(x, y) { const r = document.createElement('div'); r.className = 'ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; pad.append(r); setTimeout(() => r.remove(), 500); }

export async function pipTap(fx, fy, px, py) {
  ripple(px, py);
  if (S.mouse) {                                         // aim: the cursor jumps there; tap the pad to click
    try {
      const r = await input('moveTo', { fx, fy }); buzz(10);
      S.cursor = { x: r.x, y: r.y }; placeCursor(); scheduleShot(300);
    } catch (e) { toast(e.message, 'error'); }
    return;
  }
  const s = await refreshState(true); if (!s || !S.camera || !S.viewport) return;
  const c = S.camera, vx = fx * S.viewport.w, vy = fy * S.viewport.h;
  const sx = (vx - c.x) / c.zoom, sy = (vy - c.y) / c.zoom;
  const hits = (S.items || []).filter((it) => !it.hidden && it.w > 0 && it.h > 0 && sx >= it.x && sx <= it.x + it.w && sy >= it.y && sy <= it.y + it.h);
  hits.sort((a, b) => a.w * a.h - b.w * b.h);            // the smallest thing under the finger
  const hit = hits[0];
  try {
    const r = await call('canvas_select', { ids: hit ? [hit.id] : [] });
    S.selected = r.selected || []; renderHud(); buzz(hit ? 10 : 5);
    if (hit) toast(String(hit.title || hit.type || 'Node').slice(0, 50) + ' — selected. Drag on the pad to move it.');
    scheduleShot(150);
  } catch (e) { toast(e.message, 'error'); }
}

/** Wire this part up — called by main.js once every module has loaded (they import each other). */
export function wire() {
  window.addEventListener('resize', () => { layoutPip(); scheduleShot(300); });
  $('#pipMin').addEventListener('click', (e) => { e.stopPropagation(); pipState.min = !pipState.min; savePip(); buzz(5); layoutPip(); if (!pipState.min) scheduleShot(30); });
  $('#pipRefresh').addEventListener('click', (e) => { e.stopPropagation(); buzz(); takeShot(); });
  (() => {   // move (drag anywhere on it), resize (grip or pinch), tap (select / aim the mouse)
    const P = new Map(); let op = null;
    pip.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.pip-bar button')) return;
      e.stopPropagation();
      try { pip.setPointerCapture(e.pointerId); } catch (err) { /* */ }
      P.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const r = pip.getBoundingClientRect(), pr = pad.getBoundingClientRect();
      if (P.size === 2) { const [a, b] = [...P.values()]; op = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, w0: pipSize().w }; pip.classList.add('moving'); return; }
      op = { kind: e.target.closest('#pipGrip') ? 'resize' : 'press', inView: !!e.target.closest('#pipView'), x0: e.clientX, y0: e.clientY, w0: pipSize().w, left: r.left - pr.left, top: r.top - pr.top, t: performance.now(), moved: false };
      if (op.kind === 'resize') pip.classList.add('moving');
    });
    pip.addEventListener('pointermove', (e) => {
      if (!P.has(e.pointerId) || !op) return;
      P.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (op.kind === 'pinch' && P.size >= 2) {
        const [a, b] = [...P.values()];
        pipState.w = clamp(op.w0 * (Math.hypot(a.x - b.x, a.y - b.y) / op.d0), PIP_MIN, pipMax()); layoutPip(); return;
      }
      const dx = e.clientX - op.x0, dy = e.clientY - op.y0;
      if (op.kind === 'resize') {
        const c = pipState.corner, sx = c[1] === 'r' ? -1 : 1, sy = c[0] === 'b' ? -1 : 1;
        const grow = Math.abs(dx) > Math.abs(dy * pipAspect()) ? sx * dx : sy * dy * pipAspect();
        pipState.w = clamp(op.w0 + grow, PIP_MIN, pipMax()); layoutPip(); return;
      }
      if (!op.moved && Math.hypot(dx, dy) < 8) return;
      if (!op.moved) { op.moved = true; op.kind = 'move'; pip.classList.add('moving'); }
      const pr = pad.getBoundingClientRect(), w = pip.offsetWidth, h = pip.offsetHeight;
      pip.style.transform = `translate(${clamp(op.left + dx, 0, pr.width - w)}px, ${clamp(op.top + dy, 0, pr.height - h)}px)`;
    });
    const end = (e) => {
      if (!P.has(e.pointerId)) return;
      P.delete(e.pointerId);
      if (!op) return;
      if (P.size) { if (op.kind === 'pinch') { op = null; pip.classList.remove('moving'); savePip(); } return; }
      const o = op; op = null;
      pip.classList.remove('moving');
      if (o.kind === 'move') {
        const pr = pad.getBoundingClientRect(), r = pip.getBoundingClientRect();
        const cx = r.left + r.width / 2 - pr.left, cy = r.top + r.height / 2 - pr.top;
        pipState.corner = (cy < pr.height / 2 ? 't' : 'b') + (cx < pr.width / 2 ? 'l' : 'r');
        savePip(); buzz(6); layoutPip(); return;
      }
      if (o.kind === 'resize' || o.kind === 'pinch') { savePip(); scheduleShot(150); return; }
      if (o.kind === 'press' && e.type === 'pointerup' && performance.now() - o.t < 450 && o.inView) {   // (with pointer capture the target is #pip itself)
        const v = $('#pipView').getBoundingClientRect(), pr = pad.getBoundingClientRect();
        pipTap((e.clientX - v.left) / v.width, (e.clientY - v.top) / v.height, e.clientX - pr.left, e.clientY - pr.top);
      }
    };
    pip.addEventListener('pointerup', end); pip.addEventListener('pointercancel', end);
  })();
}
