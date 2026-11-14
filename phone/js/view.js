/* ComfyAF phone — what the screen shows (top bar, empty states, pills, toasts) and reading the graph's state (from EcoRemote's view.js) */
import { $, buzz, esc, S, setPcTheme, settings } from './state.js';
import { renderComfy } from './comfy.js';
import { call, canvasReady, currentApp } from './connection.js';
import { layoutPip, renderMarks } from './preview.js';


// ---------------------------------------------------------------- rendering
export function render() {
  const app = currentApp();
  $('#dot').className = 'dot' + (S.open && (S.mouse ? S.input : app) ? ' on' : S.open ? ' half' : '');
  const name = $('#targetName'), sub = $('#targetSub');
  if (!S.open) { name.textContent = 'Not connected'; sub.textContent = S.everOpened ? 'Reconnecting to the computer…' : 'Looking for the computer…'; }
  else if (S.mouse) { name.textContent = 'Mouse — the whole computer'; sub.textContent = S.input ? 'Tap to click · two fingers scroll · tap the preview to aim' : S.inputWhy; }
  else if (!app) { name.textContent = 'ComfyUI is not open'; sub.textContent = 'Open ComfyUI in the browser on the computer'; }
  else { name.textContent = 'ComfyUI' + (app.title ? ' — ' + app.title.replace(/\.json$/i, '') : ''); sub.textContent = comfyLine(); }
  const ok = canvasReady();
  for (const el of document.querySelectorAll('#tools .tool, #dock .act')) el.classList.toggle('disabled', !ok && el.id !== 'selectTool');
  for (const el of document.querySelectorAll('#comfyRow .act')) el.classList.toggle('disabled', !ok);
  if (window.__drawer) window.__drawer.setMode(S.mouse ? 'mouse' : 'graph');
  $('#dock').hidden = S.mouse; $('#mouseRow').hidden = !S.mouse;   // the tools stay; the bottom row is the dock or the mouse buttons
  $('#pad').classList.toggle('mouse', S.mouse); $('#pip').classList.toggle('mouse', S.mouse);
  $('#padSave').hidden = !(S.open && (S.mouse ? S.input : ok));   // the ⇩ on the pad
  $('#mousePill').hidden = !S.mouse; $('#holdPill').hidden = !S.holding; $('#holdPill').textContent = S.holding ? 'Holding ' + S.holding : '';
  for (const b of document.querySelectorAll('#mouseRow [data-m]')) b.classList.toggle('on', b.dataset.m === S.holding);
  $('#kbdBtn').classList.toggle('on', !$('#kbd').hidden);
  const empty = $('#empty');
  empty.hidden = false;
  if (!S.open) empty.innerHTML = '<div><b>Not connected</b>Is this phone on the same Wi-Fi as the computer, and is the phone remote on in ComfyUI (the ComfyAF panel)?</div>';
  else if (S.mouse) { if (S.input) empty.hidden = true; else empty.innerHTML = '<div><b>Mouse is not available</b>' + esc(S.inputWhy) + '</div>'; }
  else if (!app) empty.innerHTML = '<div><b>ComfyUI is not open</b>Open ComfyUI in the browser on the computer — it shows up here by itself.<br><br>Tap <b>Select</b> for the mouse.</div>';
  else empty.hidden = true;
  $('#hint').innerHTML = S.mouse
    ? 'Move a finger to move the mouse · Hand drives the graph again<br>tap = click · two-finger tap = right-click<br>two fingers = scroll · tap, then drag = drag'
    : 'Drag to pan · pinch to zoom<br>with nodes selected, drag moves them<br>tap the preview to select a node · double-tap to fit · hold to deselect<br><span style="color:var(--mouse)">Select = the computer’s mouse · Hand = the graph</span>';
  $('#pip').hidden = !settings.live || !(S.mouse ? S.input : ok);
  $('#pipTitle').textContent = S.mouse ? 'Screen' : 'Graph';
  layoutPip();
  renderHud();
  renderComfy();
}
/** "Running KSampler · 12/30 · 2 queued", "Idle", "3 queued" */
export function comfyLine() {
  const c = S.comfy || {}, p = c.progress, parts = [];
  if (p && p.node) parts.push('Running ' + p.node + (p.max ? ' · ' + p.value + '/' + p.max : ''));
  else if (c.running) parts.push('Running');
  const waiting = Math.max(0, (c.queue || 0) - (c.running ? 1 : 0));
  if (waiting) parts.push(waiting + ' queued');
  return parts.length ? parts.join(' · ') : 'Idle';
}
export function renderHud() {
  $('#zoomPill').hidden = S.mouse;
  $('#zoomPill').textContent = S.camera ? Math.round(S.camera.zoom * 100) + '%' : '—';
  const n = S.selected.length;
  $('#selPill').hidden = !n || S.mouse; $('#selPill').textContent = n === 1 ? '1 node selected · drag moves it' : n + ' selected · drag moves them';
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('on', b.dataset.tool === (S.mouse ? 'select' : 'hand'));
  renderMarks();
}
export function toast(text, level = '') {
  const el = document.createElement('div'); el.className = 'toast ' + level; el.textContent = text;
  $('#toasts').append(el); setTimeout(() => el.remove(), level === 'error' ? 4200 : 2400);
  if (level === 'error') buzz(30);
}

// ---------------------------------------------------------------- state
export async function refreshState(withItems = false) {
  const app = currentApp();
  if (!S.open || !app || S.mouse) return null;
  try {
    const s = await call('canvas_state', withItems ? {} : { ids: ['__none__'] });
    S.camera = s.camera || S.camera; S.viewport = s.viewport || S.viewport; S.selected = s.selected || [];
    if (s.theme) setPcTheme(s.theme);
    if (withItems) S.items = s.items || [];
    renderHud();
    return s;
  } catch (e) { return null; }
}
