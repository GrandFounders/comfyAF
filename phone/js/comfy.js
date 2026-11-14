/* ComfyAF phone — ComfyUI's own row: Queue, Cancel, the latest image, and the progress of a run (new for ComfyUI) */
import { $, buzz, S } from './state.js';
import { canvasReady, comfy, getKey } from './connection.js';
import { render, toast } from './view.js';
import { openViewer } from './viewer.js';

/** One of ComfyUI's images as a Blob. The key goes in a header, never in the address. maxSide: a lighter JPEG. */
export async function imageBlob(im, maxSide = 0) {
  const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' });
  if (maxSide) q.set('maxSide', String(maxSide));
  const r = await fetch('/image?' + q, { headers: { 'X-Remote-Key': getKey() }, cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 404 ? 'That image is not on the computer any more.' : 'Could not get the image (' + r.status + ').');
  return r.blob();
}

let thumbFor = '', thumbUrl = '';
const keyOf = (im) => (im ? [im.prompt, im.type, im.subfolder, im.filename].join('|') : '');
async function loadThumb(im) {
  const k = keyOf(im);
  if (k === thumbFor) return;
  thumbFor = k;
  const el = $('#latestImg');
  if (!im) { el.hidden = true; if (thumbUrl) URL.revokeObjectURL(thumbUrl); thumbUrl = ''; return; }
  try {
    const b = await imageBlob(im, 320);
    if (thumbFor !== k) return;
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    thumbUrl = URL.createObjectURL(b); el.src = thumbUrl; el.hidden = false;
  } catch (e) { thumbFor = ''; }
}

/** The row and the progress bar, from the latest status (the server sends it when something changes). */
export function renderComfy() {
  const c = S.comfy || {}, ok = canvasReady(), p = c.progress;
  $('#queueBtn').classList.toggle('disabled', !ok);
  $('#cancelBtn').classList.toggle('disabled', !S.open || !(c.running || p));
  $('#latestBtn').classList.toggle('disabled', !S.open || !c.latest);
  const waiting = Math.max(0, (c.queue || 0) - (c.running ? 1 : 0));
  $('#queueCount').textContent = waiting ? String(waiting) : ''; $('#queueCount').hidden = !waiting;
  const bar = $('#progress'), busy = !!(S.open && (c.running || p));
  bar.hidden = !busy;
  if (busy) { const f = p && p.max ? Math.max(0, Math.min(1, p.value / p.max)) : 0; bar.classList.toggle('busy', !(p && p.max)); bar.firstElementChild.style.width = (f * 100).toFixed(1) + '%'; }
  if (S.open) loadThumb(c.latest);
}

export function wire() {
  $('#queueBtn').addEventListener('click', async () => {
    buzz(14);
    try { await comfy('queue'); toast('Queued', 'ok'); } catch (e) { toast(e.message, 'error'); }
  });
  $('#cancelBtn').addEventListener('click', async () => {
    buzz(14);
    try { await comfy('cancel'); toast('Cancelled'); } catch (e) { toast(e.message, 'error'); }
  });
  $('#latestBtn').addEventListener('click', () => { const im = S.comfy && S.comfy.latest; if (im) openViewer(im, thumbUrl); });
  render();
}
