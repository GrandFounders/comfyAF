/* ComfyAF phone — shared state, settings, themes, small helpers (from EcoRemote's state.js) */
import { createDialogs } from '../vendor/dialogs.js';
import { DialogQueue } from '../vendor/queue.js';

/* The phone page — one WebSocket to ComfyAF's server (comfyaf/remote.py), which asks the ComfyUI page in
   the browser on the computer to do things (web/phone-remote.js). */
export const $ = (s, r = document) => r.querySelector(s);
export const LS = { key: 'comfyaf:key', set: 'comfyaf:settings', pip: 'comfyaf:pip', tips: 'comfyaf:tips' };
export const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
// 2026-11-14: the plugin was called ComfyRemote — keep this phone's pairing key and settings from then
try { for (const k of ['key', 'settings', 'pip', 'tips']) if (localStorage.getItem('comfyaf:' + k) == null && localStorage.getItem('comfyremote:' + k) != null) localStorage.setItem('comfyaf:' + k, localStorage.getItem('comfyremote:' + k)); } catch (e) { /* private mode */ }
export const settings = Object.assign({ theme: 'auto', speed: 1, mouseSpeed: 1, live: true, glide: true, haptics: true, invert: false }, ls.get(LS.set, {}));
export const saveSettings = () => ls.set(LS.set, settings);
export let pcTheme = null;   // ComfyUI's theme on the computer (light → Warm, dark → Photoshop)
/* 'auto' + the ecosystem themes, the same list as every app (hostKit settings.js › ECOSYSTEM_THEMES) */
export const THEMES = [['auto', 'Follow the computer'], ['warm', 'Warm'], ['slate', 'Slate'], ['forest', 'Forest'], ['photoshop', 'Photoshop'], ['kairos', 'Kairos Teal'],
  ['blackred', 'BlackRED'], ['blackyellow', 'BlackYELLOW'], ['blackgreen', 'BlackGREEN'], ['blackbrown', 'BlackBROWN'],
  ['darkasfk', 'DarkAsFK'], ['darkasfkdeep', 'DarkAsFK Deep'], ['darkasfkabyss', 'DarkAsFK Abyss']];
export const applyTheme = () => { document.documentElement.dataset.shellTheme = settings.theme === 'auto' ? (pcTheme || 'photoshop') : (settings.theme === 'default' ? 'warm' : settings.theme); const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = getComputedStyle(document.documentElement).getPropertyValue('--kairos-bg').trim(); };
export function setPcTheme(t) { if (t && t !== pcTheme) { pcTheme = t; if (settings.theme === 'auto') applyTheme(); } }
applyTheme();
export const dialogs = createDialogs(new DialogQueue());   // hostDialogs: the same confirm / prompt as every app
export const buzz = (ms = 8) => { if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* */ } } };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const S = {
  ws: null, open: false, everOpened: false, fails: 0, retry: 0, timer: null,
  apps: [],                                                  // the ComfyUI page in front on the computer ([] = none open)
  input: false, inputWhy: '',                                // Mouse mode + keyboard allowed on the computer (and why not)
  camera: null, tool: null, viewport: null, selected: [], items: null, mode: 'canvas',
  comfy: { queue: 0, running: false, progress: null, latest: null },   // ComfyUI: queue, the run, the latest image
  gen: 0,                                                    // bumps on every gesture / change (the preview refreshes)
  mouse: false, holding: false,   // holding: 'left' | 'right' | 'middle' while a mouse button is kept pressed
  screen: null, cursor: null,     // Mouse mode: the computer's screen the cursor is on
};
