/* ComfyAF phone — pairing and the WebSocket to the computer (from EcoRemote's connection.js) */
import { $, LS, ls, S, setPcTheme } from './state.js';
import { refreshState, render, renderHud, toast } from './view.js';
import { clearShot, scheduleShot } from './preview.js';
import { g } from './pad.js';
import { renderComfy } from './comfy.js';
// ---------------------------------------------------------------- pairing key
export function takeKeyFromHash() {
  const m = /[#&]k=([A-Za-z0-9-]+)/.exec(location.hash);
  if (m) { ls.set(LS.key, m[1].toUpperCase()); history.replaceState(null, '', location.pathname); return true; }
  return false;
}

export const getKey = () => ls.get(LS.key, '');
export function showPair(msg) { $('#pair').hidden = false; $('#pairErr').textContent = msg || ''; $('#pairKey').value = getKey(); }

// ---------------------------------------------------------------- connection
export let seq = 0;
export const waiting = new Map();
export function rpc(m, timeout = 140000) {
  return new Promise((resolve, reject) => {
    if (!S.open) return reject(new Error('Not connected to the computer.'));
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('The computer did not answer in time.')); }, timeout);
    waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    S.ws.send(JSON.stringify({ ...m, id }));
  });
}
export const call = (name, args = {}) => rpc({ t: 'call', name, args });
export const comfy = (op) => rpc({ t: 'comfy', op }, 35000);   // ComfyUI itself: queue, cancel
export const input = (op, extra = {}) => rpc({ t: 'input', op, ...extra }, 25000);   // Mouse mode + keyboard
export const sendRaw = (m) => { if (S.open) { try { S.ws.send(JSON.stringify(m)); } catch (e) { /* */ } } };

export function connect() {
  const key = getKey();
  if (!key) { render(); showPair(); return; }
  clearTimeout(S.timer);
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?k=' + encodeURIComponent(key));
  S.ws = ws;
  ws.onopen = () => { S.open = true; S.everOpened = true; S.fails = 0; S.retry = 0; render(); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
  ws.onclose = async () => {
    if (S.ws !== ws) return;
    const was = S.open; S.open = false; S.ws = null;
    for (const w of waiting.values()) w.reject(new Error('Connection lost.'));
    waiting.clear();
    S.holding = false; render();
    if (!was) {
      const up = await fetch('/health', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
      if (up && ++S.fails >= 2) { showPair('The computer did not accept this key. Scan the code again (Extensions › ComfyAF › Pair a phone… in ComfyUI) or type the key.'); return; }
    }
    const wait = Math.min(15000, 800 * Math.pow(1.7, S.retry++));
    S.timer = setTimeout(connect, wait);
  };
}
export function reconnect(now) {
  clearTimeout(S.timer);
  if (S.ws) { const w = S.ws; S.ws = null; S.open = false; try { w.close(); } catch (e) { /* */ } }
  if (now) connect();
}

export function onMessage(m) {
  if (m.t === 'reply') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.ok ? w.resolve(m.data) : w.reject(new Error(m.error || 'failed')); } return; }
  if (m.t === 'hello' || m.t === 'status') { applyStatus(m); if (m.t === 'hello') { refreshState(); scheduleShot(30); } return; }
  if (m.t === 'view') { if (m.camera) S.camera = m.camera; renderHud(); return; }
  if (m.t === 'drag') {
    if (m.done) { scheduleShot(120); return; }
    if (!m.moved && g && g.kind === 'drag') { g.kind = 'pan'; S.selected = m.selected || []; renderHud(); toast('Nothing is selected — panning instead.'); }
    return;
  }
  if (m.t === 'toast') toast(m.text, m.level);
}
export function applyStatus(m) {
  const before = currentApp() && currentApp().id;
  S.apps = m.apps || [];
  if (m.comfy) S.comfy = m.comfy;
  S.input = !!m.input; S.inputWhy = m.inputWhy || '';
  const app = currentApp(); if (app && app.theme) setPcTheme(app.theme);
  render(); renderComfy();
  const after = currentApp() && currentApp().id;
  if (after && after !== before && !S.mouse) { S.camera = null; S.items = null; S.selected = []; clearShot(); refreshState(); scheduleShot(30); }   // another ComfyUI tab came to the front
}
/** The ComfyUI page in front on the computer (the server picks it: focused, then visible, then the latest). */
export const currentApp = () => S.apps[0] || null;
export const canvasReady = () => !!(S.open && currentApp());

/** Wire this part up — called by main.js once every module has loaded (they import each other). */
export function wire() {
  takeKeyFromHash();
  window.addEventListener('hashchange', () => { if (takeKeyFromHash()) { S.fails = 0; $('#pair').hidden = true; reconnect(true); } });
  $('#pairForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const k = $('#pairKey').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (k.length < 8) { $('#pairErr').textContent = 'That key looks too short.'; return; }
    ls.set(LS.key, k); $('#pair').hidden = true; S.fails = 0; reconnect(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!S.open) reconnect(true);
    else { rpc({ t: 'status' }).then(applyStatus).catch(() => {}); scheduleShot(50); }
  });
}
