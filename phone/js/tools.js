/* ComfyAF phone — the tool band: Select = the computer's own mouse (Mouse mode) · Hand = the graph (from EcoRemote's tools.js) */
import { $, buzz, LS, ls, S } from './state.js';
import { canvasReady } from './connection.js';
import { refreshState, render, renderHud, toast } from './view.js';
import { clearShot, loopScreen, scheduleShot } from './preview.js';
import { click } from './pad.js';
// ---------------------------------------------------------------- Mouse mode: Select = the computer's own mouse · Hand = the graph
export function setMouse(on) {
  if (on && !S.input) { toast(S.inputWhy || 'Mouse is not available on this computer.', 'error'); return; }
  if (!on && S.holding) { click('up', S.holding); S.holding = false; }
  S.mouse = on; S.cursor = null; buzz(on ? 25 : 10);
  clearShot(); render(); scheduleShot(60); loopScreen();
  if (!on) { refreshState(); }
  if (on && !ls.get(LS.tips, {}).mouse) { toast('Select moves the computer\'s real mouse — tap the preview to jump there. Tap Hand to drive ComfyUI\'s graph again.'); const t = ls.get(LS.tips, {}); t.mouse = 1; ls.set(LS.tips, t); }
}
const TOOLS = [
  { tool: 'select', icon: '➚', label: 'Select', title: 'The computer\'s mouse — the whole screen' },
  { tool: 'hand', icon: '✋', label: 'Hand', title: 'Drive ComfyUI\'s graph' },
];

/** Wire this part up — called by main.js once every module has loaded (they import each other). */
export function wire() {
  for (const t of [...TOOLS].reverse()) {                     // first in the band, before ComfyUI's buttons
    const b = document.createElement('button'); b.className = 'tool'; b.dataset.tool = t.tool; b.title = t.title;
    if (t.tool === 'select') b.id = 'selectTool';
    b.innerHTML = '<span class="gl">' + t.icon + '</span>' + t.label;
    $('#tools').prepend(b);
  }
  $('#tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]'); if (!b) return;
    if (b.dataset.tool === 'select' && !S.mouse) setMouse(true);      // Select = the computer's own mouse (the whole screen)
    else if (b.dataset.tool === 'hand' && S.mouse) setMouse(false);   // Hand = the pad drives the graph
    renderHud();
  });
  // the mouse buttons: tap = click · long-press = keep that button pressed (drag with the pad, tap to let go)
  const row = $('#mouseRow');
  let pressT = null, longDone = false;
  const BUTTON = { left: 'left', right: 'right', middle: 'middle', dbl: 'left' };   // holding Double holds the left button
  const hold = (btn) => {
    if (S.holding) click('up', S.holding);
    S.holding = btn; click('down', btn); render(); buzz(20);
    toast('Holding the ' + btn + ' button — move with the pad, then tap to let go.');
  };
  const release = () => { const held = S.holding; S.holding = false; render(); click('up', held); };
  row.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    longDone = false; clearTimeout(pressT);
    pressT = setTimeout(() => { longDone = true; hold(BUTTON[b.dataset.m]); }, 450);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => row.addEventListener(ev, () => clearTimeout(pressT)));
  row.addEventListener('contextmenu', (e) => e.preventDefault());
  row.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (longDone) { longDone = false; return; }                // that press was the long one
    if (S.holding) { release(); return; }                      // while holding, any tap lets go
    const m = b.dataset.m;
    if (m === 'dbl') click('dbl'); else click('click', BUTTON[m]);
  });
  void canvasReady;
}
