/* ComfyAF phone — start: load every part, wire them up in order (they import each other), then connect (from EcoRemote's main.js) */
import './state.js';
import { wire as wire_connection } from './connection.js';
import './view.js';
import { wire as wire_preview } from './preview.js';
import { wire as wire_pad } from './pad.js';
import { wire as wire_tools } from './tools.js';
import { wire as wire_keyboard } from './keyboard.js';
import { wire as wire_commands } from './commands.js';
import { wire as wire_comfy } from './comfy.js';
import { wire as wire_menu } from './menu.js';
import { wire as wire_viewer } from './viewer.js';
import { connect } from './connection.js';
import { render } from './view.js';
// keep the screen awake while the remote is open (where the browser allows it — usually https only)
export async function keepAwake() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed here */ } }
document.addEventListener('visibilitychange', keepAwake);

// wire every part, in the order the page was written, then start
wire_connection(); wire_preview(); wire_pad(); wire_tools(); wire_keyboard(); wire_commands(); wire_comfy(); wire_menu(); wire_viewer();
render(); connect(); keepAwake();
