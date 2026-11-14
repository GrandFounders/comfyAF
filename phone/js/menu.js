/* ComfyAF phone — the ☰ menu (GuaP's drawer, hostKit/shell/drawer.js) and Settings (from EcoRemote's menu.js) */
import { ShellDrawer } from '../vendor/drawer.js';
import { $, applyTheme, buzz, dialogs, LS, ls, S, saveSettings, settings, THEMES } from './state.js';
import { call, canvasReady, comfy, reconnect, showPair } from './connection.js';
import { render, renderHud, toast } from './view.js';
import { layoutPip, pipState, savePip, scheduleShot } from './preview.js';
import { command } from './commands.js';
import { openViewer } from './viewer.js';
import { setMouse } from './tools.js';
import { openKbd } from './keyboard.js';
// --- the menu: one category per job
export const nudge = (x, y) => async () => {
  if (!S.selected.length) return command('panBy', { dx: -x * 160, dy: -y * 160 });
  // the selected nodes, 10 px on the computer's screen: one undo step
  await command('moveSelection', { phase: 'begin' }, { shotAfter: false });
  await command('moveSelection', { phase: 'move', dx: x * 10, dy: y * 10 }, { shotAfter: false });
  return command('moveSelection', { phase: 'end' });
};
export function drawerCategories() {
  if (settingsOnly) return [{ key: 'settings', title: 'Settings', rows: settingsRows() }];
  const cats = [];
  if (canvasReady()) {
    cats.push({ key: 'comfy', title: 'ComfyUI', rows: [
      { label: 'Queue', icon: '▶', kbd: 'Ctrl+Enter', run: async () => { try { await comfy('queue'); toast('Queued', 'ok'); } catch (e) { toast(e.message, 'error'); } } },
      { label: 'Cancel the run', icon: '■', disabled: !(S.comfy.running || S.comfy.progress), run: async () => { try { await comfy('cancel'); toast('Cancelled'); } catch (e) { toast(e.message, 'error'); } } },
      { label: 'Latest image', icon: '🖼', disabled: !S.comfy.latest, run: () => openViewer(S.comfy.latest) },
    ] });
    cats.push({ key: 'graph', title: 'Graph', rows: [
      { label: 'Select all', icon: '⬚', kbd: 'Ctrl+A', run: () => command('selectAll') },
      { label: 'Clear selection', icon: '⊘', run: async () => { try { const r = await call('canvas_select', { ids: [] }); S.selected = r.selected || []; renderHud(); scheduleShot(150); } catch (e) { toast(e.message, 'error'); } } },
      { label: 'Undo', icon: '↶', kbd: 'Ctrl+Z', run: () => command('undo') },
      { label: 'Redo', icon: '↷', kbd: 'Ctrl+Y', run: () => command('redo') },
    ] });
    cats.push({ key: 'move', title: S.selected.length ? 'Move · the selection' : 'Move · the view', rows: [
      { label: 'Zoom in', icon: '＋', run: () => command('zoomBy', { factor: 1.25 }) },
      { label: 'Zoom out', icon: '－', run: () => command('zoomBy', { factor: 0.8 }) },
      { label: 'Fit everything', icon: '⤢', run: () => command('fitContent') },
      { label: '100%', icon: '1:1', run: () => command('zoomReset') },
      { kind: 'sep' },
      { label: 'Left', icon: '←', run: nudge(-1, 0) }, { label: 'Right', icon: '→', run: nudge(1, 0) },
      { label: 'Up', icon: '↑', run: nudge(0, -1) }, { label: 'Down', icon: '↓', run: nudge(0, 1) },
    ] });
  }
  cats.push({ key: 'computer', title: 'This computer', rows: [
    { label: 'Mouse (the whole computer)', icon: '🖱', pressed: S.mouse, disabled: !S.input, run: () => setMouse(!S.mouse) },
    { label: 'Keyboard', icon: '⌨', disabled: !S.input, run: () => openKbd() },
    ...(S.input ? [] : [{ kind: 'label', label: S.inputWhy || 'Mouse and keyboard are off on the computer.' }]),
  ] });
  cats.push({ key: 'settings', title: 'Settings', rows: settingsRows() });
  return cats;
}
export const drawer = new ShellDrawer({
  appId: 'comfyaf', brand: 'COMFYAF',
  modes: [
    { id: 'graph', label: 'Graph', icon: '✋', closes: true, run: () => { if (S.mouse) setMouse(false); } },
    { id: 'mouse', label: 'Mouse', icon: '🖱', closes: true, run: () => setMouse(true) },
    { id: 'keys', label: 'Keys', icon: '⌨', action: true, closes: true, run: () => openKbd() },
  ],
  activeMode: 'graph',
  modeless: () => settingsOnly,   // ⚙: a side menu that stays open while you change things
  categories: drawerCategories,
});

export async function openMenu() {
  buzz(5);
  if (!S.open) { reconnect(true); toast('Reconnecting…'); return; }
  drawer.el.querySelector('.shell-drawer-brand').textContent = 'COMFYAF';
  drawer.open();
}

// --- settings: a category of the same drawer; ⚙ opens it on its own, as a side menu that stays open
export let settingsOnly = false;
export const controls = document.createElement('div');  
export function rangeEl(key, min, max) {   // the real inputs; the drawer shows a twin that writes through to them
  const r = document.createElement('input'); r.type = 'range'; r.min = String(min); r.max = String(max); r.step = '0.1';
  r.addEventListener('input', () => { settings[key] = +r.value; saveSettings(); });
  controls.append(r); return r;
}
export const speedEl = rangeEl('speed', 0.3, 4), mouseSpeedEl = rangeEl('mouseSpeed', 0.3, 4);
export function refreshDrawer() { if (drawer.isOpen) { drawer._model = drawer.model(); drawer.cats.refresh(); } }
export const onOff = (key, label, icon, after) => ({ label, icon, kbd: settings[key] ? 'On' : 'Off', pressed: !!settings[key],
  run: () => { settings[key] = !settings[key]; saveSettings(); buzz(5); if (after) after(); refreshDrawer(); } });
export function settingsRows() {
  speedEl.value = settings.speed; mouseSpeedEl.value = settings.mouseSpeed;
  return [
    { kind: 'label', label: 'Theme' },
    ...THEMES.map(([id, label]) => ({ label, icon: settings.theme === id ? '●' : '○', pressed: settings.theme === id,
      run: () => { settings.theme = id; saveSettings(); applyTheme(); refreshDrawer(); } })),
    { kind: 'label', label: 'Graph' },
    { kind: 'control', label: 'Pan speed', el: speedEl },
    onOff('glide', 'Glide after a flick', '↝'),
    onOff('invert', 'Reverse direction', '⇄'),
    { kind: 'label', label: 'Mouse' },
    { kind: 'control', label: 'Mouse speed', el: mouseSpeedEl },
    { kind: 'label', label: 'Preview' },
    onOff('live', 'Show the preview', '▣', () => { render(); if (settings.live) scheduleShot(30); }),
    ...[['tl', 'Top left', '◰'], ['tr', 'Top right', '◳'], ['bl', 'Bottom left', '◱'], ['br', 'Bottom right', '◲']].map(([c, label, icon]) => ({
      label: 'Corner: ' + label, icon, pressed: pipState.corner === c, run: () => { pipState.corner = c; savePip(); layoutPip(); refreshDrawer(); } })),
    { kind: 'label', label: 'This phone' },
    onOff('haptics', 'Vibration', '〰'),
    { label: 'Forget this computer…', icon: '⏏', danger: true, run: forgetComputer },
    { kind: 'label', label: location.host + ' · ' + (S.open ? (S.apps.length ? 'ComfyUI open' : 'ComfyUI not open') : 'not connected') + ' · mouse & keyboard ' + (S.input ? 'on' : 'off') },
  ];
}
export async function forgetComputer() {
  const yes = await dialogs.confirm({ title: 'Forget this computer?', message: 'You will need to scan the code on the computer again (Extensions › ComfyAF › Pair a phone… in ComfyUI) to pair this phone.', confirmLabel: 'Forget', cancelLabel: 'Keep', danger: true });
  if (!yes) return;
  drawer.close(); ls.set(LS.key, ''); reconnect(false); render(); showPair();
}
export function openSettings() {
  buzz(5);
  if (drawer.isOpen) drawer.close();
  settingsOnly = true;
  drawer.el.querySelector('.shell-drawer-brand').textContent = 'SETTINGS';
  drawer.open();
}

/** Wire this part up — called by main.js once every module has loaded (they import each other). */
export function wire() {
  window.__drawer = drawer;
  $('#menuBtn').addEventListener('click', openMenu);
  $('#targetBtn').addEventListener('click', openMenu);
  controls.hidden = true;
  document.body.append(controls);
  drawer.on((type) => { if (type === 'close') settingsOnly = false; });
  $('#settingsBtn').addEventListener('click', openSettings);
}
