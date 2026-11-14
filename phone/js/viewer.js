/* ComfyAF phone — the full-screen viewer: the graph's picture, or ComfyUI's latest image, at scale (pinch to zoom, drag to move) (from EcoRemote's viewer.js) */
import { $, buzz, clamp, S } from './state.js';
import { call, canvasReady, input } from './connection.js';
import { imageBlob } from './comfy.js';
import { toast } from './view.js';

const box = () => $('#viewer'), img = () => $('#viewerImg');
const v = { sc: 1, tx: 0, ty: 0, fit: 1, open: false, busy: false, image: null };   // image: ComfyUI's latest (else the graph)
const MAX = 8;                                   // up to 8× the fit-to-screen size

function size() { const r = box().getBoundingClientRect(); return { W: r.width, H: r.height }; }
function apply() { img().style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.sc})`; }
/** Keep the picture on screen: centred when smaller than the screen, edges never past the middle when larger. */
function bound() {
  const { W, H } = size(), w = img().naturalWidth * v.sc, h = img().naturalHeight * v.sc;
  v.tx = w <= W ? (W - w) / 2 : clamp(v.tx, W - w, 0);
  v.ty = h <= H ? (H - h) / 2 : clamp(v.ty, H - h, 0);
}
function fit() {
  const { W, H } = size(), iw = img().naturalWidth || 1, ih = img().naturalHeight || 1;
  v.fit = Math.min(W / iw, H / ih); v.sc = v.fit; bound(); apply();
}
function zoomAt(f, x, y) {
  const next = clamp(v.sc * f, v.fit, v.fit * MAX);
  const k = next / v.sc;
  v.tx = x - k * (x - v.tx); v.ty = y - k * (y - v.ty); v.sc = next;
  bound(); apply();
}

/** Show a new picture without jumping: the same part stays in view at the same size. */
function swapIn(src) {
  const el = img(), oldW = el.naturalWidth;
  return new Promise((res) => {
    const probe = new Image();
    probe.onload = () => {
      const k = oldW ? oldW / probe.naturalWidth : 1;
      el.src = src;
      if (oldW) { v.sc *= k; v.fit *= k; bound(); apply(); } else fit();
      res();
    };
    probe.onerror = res;
    probe.src = src;
  });
}
/** A sharper picture than the corner window uses — the same request, larger. */
async function fetchSharp() {
  if (v.busy) return;
  v.busy = true; $('#viewerRefresh').classList.add('spin');
  try {
    const maxSide = Math.round(clamp(Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) * 1.5, 1200, 2400));
    if (v.image) { const b = await imageBlob(v.image); if (v.open) await swapIn(URL.createObjectURL(b)); return; }   // the image itself, full size
    let r;
    if (S.mouse) { if (!S.input) return; r = await input('screen', { maxSide, quality: 80 }); }
    else { if (!canvasReady()) return; r = await call('canvas_snapshot', { maxSide }); }
    if (v.open) await swapIn('data:' + r.mimeType + ';base64,' + r.data);
  } catch (e) { toast(e.message, 'error'); }
  finally { v.busy = false; $('#viewerRefresh').classList.remove('spin'); }
}

/** The best picture there is. ComfyUI's image: the file itself, as ComfyUI saved it (a PNG keeps its workflow).
 *  The graph: the viewer's sharp picture if it is open, else a fresh one up to 2400 px, as PNG. */
async function bestPicture() {
  if (v.image) return { blob: await imageBlob(v.image), name: v.image.filename };
  const el = img();
  let url = (v.open && el.naturalWidth >= 1200 && el.src.startsWith('data:')) ? el.src : null;
  if (!url) {
    let r;
    if (S.mouse) {
      if (!S.input) throw new Error(S.inputWhy || 'The mouse is not available.');
      r = await input('screen', { maxSide: 2400, quality: 92 });
    } else {
      if (!canvasReady()) throw new Error('ComfyUI is not open on the computer.');
      r = await call('canvas_snapshot', { maxSide: 2400 });
    }
    url = 'data:' + r.mimeType + ';base64,' + r.data;
  }
  const [, mime, b64] = /^data:([^;]+);base64,(.*)$/.exec(url) || [];
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const name = 'ComfyAF_' + (S.mouse ? 'screen_' : 'graph_') + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '_' + p2(d.getHours()) + '-' + p2(d.getMinutes()) + '-' + p2(d.getSeconds()) + (mime === 'image/jpeg' ? '.jpg' : '.png');
  return { blob: new Blob([bytes], { type: mime }), name };
}
/** Save the picture to the phone (Downloads / Files; on an iPhone, Files › Downloads). */
export async function savePicture() {
  buzz(8); toast(v.image ? 'Getting the image…' : 'Taking a full-size picture…');
  try {
    const { blob, name } = await bestPicture();
    const href = URL.createObjectURL(blob);
    const dims = await new Promise((res) => { const im = new Image(); im.onload = () => res(im.naturalWidth + '×' + im.naturalHeight); im.onerror = () => res(''); im.src = href; });
    if ('download' in HTMLAnchorElement.prototype) {
      const a = document.createElement('a'); a.href = href; a.download = name; document.body.append(a); a.click(); a.remove();
    } else window.open(href, '_blank');                         // old browsers: open it, then long-press › Save image
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    toast('Saved ' + dims + ' (' + Math.round(blob.size / 1024) + ' KB) — ' + name, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

/** Open the viewer on the graph (no argument) or on one of ComfyUI's images ({ filename, subfolder, type }). */
export function openViewer(image = null, quick = '') {
  buzz(8);
  v.image = image;
  v.open = true; box().hidden = false;
  $('#viewerTitle').textContent = image ? image.filename : (S.mouse ? 'Screen' : 'Graph');
  img().removeAttribute('src');
  const first = image ? quick : ($('#shot').getAttribute('src') ? $('#shot').src : '');   // something to show at once, then the sharp one
  if (first) { img().onload = () => { img().onload = null; fit(); }; img().src = first; }
  fetchSharp();
}
export function closeViewer() { v.open = false; v.image = null; box().hidden = true; const src = img().src; img().removeAttribute('src'); if (src.startsWith('blob:')) URL.revokeObjectURL(src); buzz(5); }

export function wire() {
  $('#pipFull').addEventListener('click', (e) => { e.stopPropagation(); v.open ? closeViewer() : openViewer(); });
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerSave').addEventListener('click', savePicture);
  $('#padSave').addEventListener('click', () => { v.image = null; savePicture(); });
  $('#pipSave').addEventListener('click', (e) => { e.stopPropagation(); v.image = null; savePicture(); });
  $('#viewerFit').addEventListener('click', () => { buzz(5); fit(); });
  $('#viewerRefresh').addEventListener('click', () => { buzz(5); fetchSharp(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && v.open) closeViewer(); });
  window.addEventListener('resize', () => { if (v.open) { const was = v.sc / v.fit; fit(); zoomAt(was, size().W / 2, size().H / 2); } });

  // one finger: move · two fingers: pinch around them · double-tap: zoom in there / back to fit
  const stage = box(), P = new Map();
  let g = null, lastTap = 0;
  const at = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const two = () => { const [a, b] = [...P.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* */ }
    P.set(e.pointerId, at(e));
    g = P.size === 1 ? { kind: 'one', ...at(e), t: performance.now(), moved: false } : { kind: 'two', ...two() };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!P.has(e.pointerId) || !g) return;
    P.set(e.pointerId, at(e));
    if (g.kind === 'one' && P.size === 1) {
      const p = at(e);
      if (!g.moved && Math.hypot(p.x - g.x, p.y - g.y) < 6) return;
      if (!g.moved) { g.moved = true; g.x0 = p.x; g.y0 = p.y; }
      v.tx += p.x - (g.lx ?? g.x0); v.ty += p.y - (g.ly ?? g.y0); g.lx = p.x; g.ly = p.y;
      bound(); apply();
    } else if (g.kind === 'two' && P.size >= 2) {
      const t = two();
      v.tx += t.x - g.x; v.ty += t.y - g.y;
      zoomAt(t.d / g.d, t.x, t.y);
      g.x = t.x; g.y = t.y; g.d = t.d;
    }
  });
  const end = (e) => {
    if (!P.has(e.pointerId)) return;
    P.delete(e.pointerId);
    if (g && g.kind === 'two') { g = P.size === 1 ? { kind: 'one', ...[...P.values()][0], t: 0, moved: true, lx: [...P.values()][0].x, ly: [...P.values()][0].y } : null; return; }
    if (!g || P.size) return;
    const gg = g; g = null;
    if (gg.moved || e.type !== 'pointerup' || performance.now() - gg.t > 300) return;
    const now = performance.now();
    if (now - lastTap < 320) {                       // double-tap
      lastTap = 0; buzz(6);
      if (v.sc > v.fit * 1.05) fit(); else zoomAt(3, gg.x, gg.y);
    } else lastTap = now;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const p = at(e); zoomAt(Math.exp(-e.deltaY * 0.0025), p.x, p.y); }, { passive: false });
}
