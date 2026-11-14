/* ComfyAF phone — graph commands and the Tools Dock Strip (from EcoRemote's commands.js) */
import { $, buzz, S } from './state.js';
import { call } from './connection.js';
import { render, toast } from './view.js';
import { scheduleShot } from './preview.js';
// ---------------------------------------------------------------- graph commands
export async function command(cmd, extra = {}, { shotAfter = true } = {}) {
  buzz();
  try {
    const r = await call('canvas_command', { command: cmd, ...extra });
    if (r && r.camera) S.camera = r.camera;
    if (r && r.selected) S.selected = r.selected;
    render();
    if (shotAfter) { S.gen++; scheduleShot(150); }
    return r;
  } catch (e) { toast(e.message, 'error'); return null; }
}

/** Wire this part up — called by main.js once every module has loaded (they import each other). */
export function wire() {
  $('#dock').addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b) command(b.dataset.cmd); });
}
