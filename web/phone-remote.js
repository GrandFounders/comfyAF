/**
 * ComfyAF — the phone remote, ComfyUI's side (2026-11-13).
 *
 * The phone talks to ComfyAF's own server (comfyaf/remote.py, port 8796). That server asks THIS page to
 * do things (ComfyUI's "comfyaf.call" event), and this page answers (POST /comfyaf/reply). It plays the
 * part the KcadaBRA apps' hostKit agentlink.js plays for EcoRemote, with the same tool names, so the phone page is
 * EcoRemote's:
 *   canvas_state     camera, viewport, selection, nodes
 *   canvas_command   panBy · zoomBy · fitContent · zoomReset · undo · redo · moveSelection · selectAll · queue
 *   canvas_select    select these nodes (none = clear)
 *   canvas_snapshot  a picture of the graph
 * Every 2 s (and at once on a change) it tells the server it is here: visible / focused, the workflow's name,
 * the theme and the progress of a run. The server drives the tab in front.
 *
 * Settings › ComfyAF › Phone remote: on/off (OFF by default — nothing listens on the network until you turn
 * it on), the port, and whether the phone may use the computer's mouse and keyboard (also OFF by default).
 * The ComfyAF side panel (📱 in ComfyUI's left bar) shows the switch, the QR code and the link to pair a phone;
 * Extensions › ComfyAF › Pair a phone… opens the same thing as a page.
 *
 * Inside a KCadabra window (ComfyUI in a frame) this page does not answer: EcoRemote drives it there.
 */
import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';
import qrcode from './lib/qrcode.js';

const ID = 'ComfyAF.PhoneRemote';
const TAB = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).slice(0, 36);
const framed = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
let on = false, beat = null, progress = null, moving = null;

// ── the graph's camera (LiteGraph): screen = (graph + offset) × scale ⇔ { x: offset·scale, zoom: scale } ──
const C = () => app.canvas;
function cam() {
  const ds = C().ds, s = ds.scale;
  return { x: ds.offset[0] * s, y: ds.offset[1] * s, zoom: s, minZoom: ds.min_scale || 0.1, maxZoom: ds.max_scale || 10 };
}
function write(c) { const ds = C().ds; ds.scale = c.zoom; ds.offset[0] = c.x / c.zoom; ds.offset[1] = c.y / c.zoom; try { C().setDirty(true, true); } catch (e) { /* */ } }
function viewport() { const r = C().canvas.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }
const nodes = () => (app.graph && (app.graph._nodes || app.graph.nodes)) || [];
function selectedNodes() {
  const s = C().selectedItems || C().selected_nodes;
  if (!s) return [];
  const list = s instanceof Set ? [...s] : Object.values(s);
  return list.filter((n) => n && n.pos && n.size && n.id != null);          // nodes (and groups): what dragging moves
}
const selectedIds = () => selectedNodes().map((n) => n.id);
function boxOf(n) {
  const T = (window.LiteGraph && window.LiteGraph.NODE_TITLE_HEIGHT) || 30, col = n.flags && n.flags.collapsed;
  return { x: n.pos[0], y: n.pos[1] - T, w: col ? (n._collapsed_width || 160) : n.size[0], h: col ? T : n.size[1] + T };
}
const tracker = () => { try { return app.extensionManager.workflow.activeWorkflow.changeTracker; } catch (e) { return null; } };
async function run(id) {
  const cmd = app.extensionManager && app.extensionManager.command;
  if (!cmd || typeof cmd.execute !== 'function') throw new Error('This ComfyUI has no "' + id + '" command.');
  await cmd.execute(id);
}
function theme() {
  // the phone follows the computer: ComfyUI's dark palettes → a dark phone theme, light → a light one
  let id = '';
  try { id = String(app.extensionManager.setting.get('Comfy.ColorPalette') || ''); } catch (e) { /* */ }
  return /light/i.test(id) ? 'warm' : 'photoshop';
}
function zoomAbout(factor, px, py) {
  const c = cam(), zoom = Math.max(c.minZoom, Math.min(c.maxZoom, c.zoom * factor)), k = zoom / c.zoom;
  write({ x: px - (px - c.x) * k, y: py - (py - c.y) * k, zoom });
}
function fitAll() {
  const list = nodes(); if (!list.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of list) { const b = boxOf(n); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  const v = viewport(), pad = 40, c = cam();
  const zoom = Math.max(c.minZoom, Math.min(c.maxZoom, 1.5, Math.min((v.w - 2 * pad) / (x1 - x0 || 1), (v.h - 2 * pad) / (y1 - y0 || 1))));
  write({ x: v.w / 2 - ((x0 + x1) / 2) * zoom, y: v.h / 2 - ((y0 + y1) / 2) * zoom, zoom });
}

// ── the tools the phone may call (the server checks the list too) ──
const TOOLS = {
  canvas_state({ ids } = {}) {
    const items = (ids && ids[0] === '__none__') ? undefined : nodes().map((n) => ({ id: n.id, ...boxOf(n), title: n.title || n.type, type: n.type }));
    return { camera: cam(), viewport: viewport(), selected: selectedIds(), items, mode: 'canvas', tool: 'hand', theme: theme() };
  },
  async canvas_command(a = {}) {
    const v = viewport();
    switch (a.command) {
      case 'panBy': { const c = cam(); write({ ...c, x: c.x + (+a.dx || 0), y: c.y + (+a.dy || 0) }); break; }
      case 'zoomBy': zoomAbout(Math.max(0.2, Math.min(5, +a.factor || 1)), (Number.isFinite(+a.fx) ? +a.fx : 0.5) * v.w, (Number.isFinite(+a.fy) ? +a.fy : 0.5) * v.h); break;
      case 'fitContent': try { await run('Comfy.Canvas.FitView'); } catch (e) { fitAll(); } break;
      case 'zoomReset': zoomAbout(1 / cam().zoom, v.w / 2, v.h / 2); break;
      case 'undo': await run('Comfy.Undo'); break;
      case 'redo': await run('Comfy.Redo'); break;
      case 'selectAll': try { C().selectItems ? C().selectItems() : C().selectNodes(); } catch (e) { /* */ } break;
      case 'queue':
        try { await run('Comfy.QueuePrompt'); } catch (e) { await app.queuePrompt(0, 1); }
        return { queued: true };
      case 'moveSelection': {
        // begin … move … end: one undo step, like dragging the nodes with the mouse
        if (a.phase === 'begin') {
          const list = selectedNodes();
          moving = list.length ? { list, t: Date.now() } : null;
          if (moving) { const t = tracker(); try { t && t.beforeChange && t.beforeChange(); } catch (e) { /* */ } }
          return { moved: list.length, selected: list.map((n) => n.id) };
        }
        if (!moving) return { moved: 0 };
        if (a.phase === 'move') {
          const z = cam().zoom;
          for (const n of moving.list) { n.pos[0] += (+a.dx || 0) / z; n.pos[1] += (+a.dy || 0) / z; }
          try { C().setDirty(true, true); } catch (e) { /* */ }
          return { moved: moving.list.length };
        }
        if (a.phase === 'end') {
          const t = tracker(); moving = null;
          try { if (t && t.afterChange) t.afterChange(); else if (t && t.checkState) t.checkState(); } catch (e) { /* */ }
          return { moved: 0, done: true };
        }
        return { moved: 0 };
      }
      default: throw new Error('Unknown command ' + a.command);
    }
    return { camera: cam(), selected: selectedIds() };
  },
  canvas_select({ ids = [] } = {}) {
    const want = new Set(ids.map(String));
    try { C().deselectAll ? C().deselectAll() : C().deselectAllNodes(); } catch (e) { /* */ }
    for (const n of nodes()) if (want.has(String(n.id))) { try { C().select ? C().select(n) : C().selectNode(n, true); } catch (e) { /* */ } }
    try { C().setDirty(true, true); } catch (e) { /* */ }
    return { selected: selectedIds() };
  },
  canvas_snapshot({ maxSide = 900 } = {}) {
    const src = C().canvas, w = src.width, h = src.height, k = Math.min(1, maxSide / Math.max(w, h));
    const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(w * k)); out.height = Math.max(1, Math.round(h * k));
    const g = out.getContext('2d');
    g.fillStyle = getComputedStyle(document.body).backgroundColor || '#202020'; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(src, 0, 0, out.width, out.height);
    drawVueNodes(g, k * (src.width / (src.getBoundingClientRect().width || src.width)));
    const png = maxSide >= 2000, url = out.toDataURL(png ? 'image/png' : 'image/jpeg', 0.82);
    return { mimeType: png ? 'image/png' : 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
  },
};

/** Nodes 2.0 ("Vue nodes") draws the nodes as page elements over the canvas, so the canvas picture has the wires
 *  and the background only. Draw each node's box and title on the picture, where ComfyUI shows it. */
function drawVueNodes(g, k) {
  const els = document.querySelectorAll('[data-node-id]');
  if (!els.length) return;
  const base = C().canvas.getBoundingClientRect(), sel = new Set(selectedIds().map(String));
  const css = getComputedStyle(document.documentElement);
  const accent = (css.getPropertyValue('--p-primary-color') || '').trim() || '#3E8BFF';
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right < base.left || r.bottom < base.top || r.left > base.right || r.top > base.bottom) continue;
    const id = el.dataset.nodeId, n = app.graph && app.graph.getNodeById(isNaN(+id) ? id : +id);
    const x = (r.left - base.left) * k, y = (r.top - base.top) * k, w = r.width * k, h = r.height * k, rad = Math.min(8 * k, w / 4, h / 4);
    let bg = getComputedStyle(el).backgroundColor;
    if (!bg || /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) bg = (n && n.bgcolor) || '#353535';
    g.save();
    g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, rad) : g.rect(x, y, w, h);
    g.fillStyle = bg; g.globalAlpha = 0.96; g.fill(); g.globalAlpha = 1;
    const th = Math.min(h, 30 * k * (r.height / Math.max(1, el.offsetHeight || r.height)));
    g.save(); g.clip(); g.fillStyle = (n && n.color) || 'rgba(0,0,0,.28)'; g.fillRect(x, y, w, th); g.restore();
    g.lineWidth = Math.max(1, (sel.has(String(id)) ? 2.5 : 1) * k * 1.5);
    g.strokeStyle = sel.has(String(id)) ? accent : 'rgba(255,255,255,.18)'; g.stroke();
    const title = (n && (n.title || n.type)) || '';
    const fs = th * 0.5;
    if (title && fs >= 4) {
      g.beginPath(); g.rect(x, y, w, th); g.clip();
      g.fillStyle = '#e8e8e8'; g.font = `600 ${fs}px system-ui, sans-serif`; g.textBaseline = 'middle';
      g.fillText(title, x + th * 0.4, y + th / 2);
    }
    g.restore();
  }
}

async function post(path, body) {
  const r = await api.fetchApi(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
async function onCall(e) {
  const m = e.detail || {};
  if (framed || !on || m.tab !== TAB) return;
  let reply;
  try { const fn = TOOLS[m.name]; if (!fn) throw new Error('Unknown tool ' + m.name); reply = { id: m.id, ok: true, data: (await fn(m.args || {})) || {} }; }
  catch (err) { reply = { id: m.id, ok: false, error: String((err && err.message) || err) }; }
  post('/comfyaf/reply', reply).catch(() => {});
}

// ── "I am here" ──
function title() {
  try { const w = app.extensionManager.workflow.activeWorkflow; return (w && (w.filename || w.path)) || ''; } catch (e) { return ''; }
}
let beatT = 0;
function sayHere(gone = false) {
  if (framed || !on) return;
  const now = Date.now();
  if (!gone && now - beatT < 200) { clearTimeout(sayHere.t); sayHere.t = setTimeout(() => sayHere(), 220); return; }
  beatT = now;
  post('/comfyaf/tab', gone ? { tab: TAB, gone: true } : { tab: TAB, visible: document.visibilityState === 'visible', focused: document.hasFocus(), title: title(), theme: theme(), progress })
    .catch(() => {});
}
function nodeTitle(id) { try { const n = app.graph.getNodeById(id); return (n && (n.title || n.type)) || ''; } catch (e) { return ''; } }
function listen() {
  api.addEventListener('comfyaf.call', onCall);
  api.addEventListener('progress', (e) => { const d = e.detail || {}; progress = { value: d.value, max: d.max, node: nodeTitle(d.node) }; sayHere(); });
  api.addEventListener('executing', (e) => {
    const d = e.detail, id = d && typeof d === 'object' ? d.node : d;
    progress = id == null ? null : { value: 0, max: 0, node: nodeTitle(id) }; sayHere();
  });
  for (const ev of ['execution_success', 'execution_error', 'execution_interrupted']) api.addEventListener(ev, () => { progress = null; sayHere(); });
  document.addEventListener('visibilitychange', () => sayHere());
  window.addEventListener('focus', () => sayHere());
  window.addEventListener('blur', () => sayHere());
  window.addEventListener('pagehide', () => sayHere(true));
}

// ── on / off ──
function setting(id, d) {
  try { const v = app.extensionManager.setting.get(id); return v == null ? d : v; } catch (e) { return d; }
}
function toast(severity, summary, detail) {
  try { app.extensionManager.toast.add({ severity, summary, detail, life: severity === 'error' ? 8000 : 5000 }); } catch (e) { console.log('[ComfyAF]', summary, detail || ''); }
}
let syncing = null;
async function sync(announce = false) {
  if (framed) return null;
  const want = !!setting(`${ID}.Enabled`, false), port = +setting(`${ID}.Port`, 8796) || 8796, input = !!setting(`${ID}.Input`, false);
  syncing = (async () => {
    const info = await post('/comfyaf/remote', { on: want, port, input });
    on = !!info.on;
    clearInterval(beat); beat = null;
    if (on) { beat = setInterval(() => sayHere(), 2000); sayHere(); }
    if (want && !info.on) toast('error', 'Phone remote did not start', info.error || '');
    else if (announce && on) toast('info', 'Phone remote on', 'The ComfyAF panel (📱 in the left bar) shows the QR code.');
    paintPanel();
    return info;
  })();
  try { return await syncing; } catch (e) { toast('error', 'Phone remote', String(e.message || e)); return null; }
}
/** Extensions › ComfyAF › Pair a phone…: turn the remote on and show the panel with the QR code. */
async function pairPhone() {
  if (framed) { toast('info', 'ComfyUI is inside KCadabra', 'Pair the phone with EcoRemote there.'); return; }
  if (!setting(`${ID}.Enabled`, false)) { try { await app.extensionManager.setting.set(`${ID}.Enabled`, true); } catch (e) { /* */ } }
  await sync();
  try { app.extensionManager.command.execute('Workspace.ToggleSidebarTab.comfyaf'); return; } catch (e) { /* older ComfyUI */ }
  const info = await fetch(api.apiURL ? api.apiURL('/comfyaf/remote') : '/api/comfyaf/remote').then((r) => r.json()).catch(() => null);
  if (info && info.on) window.open('http://127.0.0.1:' + info.port + '/pair', '_blank', 'noopener');
}

// ── the side panel: the switch, the QR code, the link ──
let panel = null, panelTimer = null;
const h = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const k in attrs) { if (k === 'style') Object.assign(n.style, attrs[k]); else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]); else n.setAttribute(k, attrs[k]); } for (const c of kids) if (c != null) n.append(c); return n; };
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 3, c = 6, size = (n + m * 2) * c; let d = '';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) d += `M${(k + m) * c},${(r + m) * c}h${c}v${c}h-${c}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code to pair a phone" style="width:100%;height:auto;display:block;border-radius:8px"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}
function toggleRow(label, id, hint) {
  const box = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', accentColor: 'var(--p-primary-color, #3E8BFF)' } });
  box.checked = !!setting(id, false);
  box.addEventListener('change', async () => { try { await app.extensionManager.setting.set(id, box.checked); } catch (e) { /* */ } });
  return h('label', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', margin: '10px 0' } }, box,
    h('span', {}, h('b', { style: { display: 'block', fontWeight: 600 } }, label), hint ? h('small', { style: { opacity: 0.7, lineHeight: 1.4 } }, hint) : null));
}
async function paintPanel() {
  if (!panel || !panel.isConnected) { clearInterval(panelTimer); panelTimer = null; return; }
  let info = null;
  try { info = await api.fetchApi('/comfyaf/pair-info').then((r) => r.json()); } catch (e) { /* */ }
  const body = h('div', { style: { padding: '12px 14px', fontSize: '13px', lineHeight: 1.45 } });
  body.append(h('h3', { style: { margin: '0 0 4px', fontSize: '15px' } }, 'Phone remote'),
    h('p', { style: { margin: '0 0 6px', opacity: 0.75 } }, 'Drive ComfyUI from a phone on the same Wi-Fi: pan, pinch, Queue, Cancel, the latest image.'),
    toggleRow('Phone remote on', `${ID}.Enabled`, 'Listens on your network (port ' + (setting(`${ID}.Port`, 8796)) + ') and lets in only a paired phone.'));
  if (!info) body.append(h('p', {}, 'ComfyAF is not answering. Restart ComfyUI.'));
  else if (info.error) body.append(h('p', { style: { color: '#ef6b5e' } }, info.error));
  else if (info.on && !info.local) body.append(h('p', {}, 'Pairing is shown on the computer running ComfyUI only. Open ComfyUI there (http://127.0.0.1:8188) to see the QR code.'));
  else if (info.on && info.urls) {
    if (!info.urls.length) body.append(h('p', {}, 'This computer has no network address. Connect it to the same Wi-Fi as the phone.'));
    info.urls.forEach((u, i) => {
      const fig = h('div', { style: { margin: '10px 0', padding: '10px', borderRadius: '10px', background: 'rgba(127,127,127,.12)', opacity: i ? 0.7 : 1 } });
      fig.innerHTML = qrSvg(u.url);
      fig.append(h('div', { style: { marginTop: '8px', fontWeight: 600 } }, u.address + ':' + info.port),
        h('a', { href: u.url, target: '_blank', rel: 'noopener', style: { fontSize: '11px', wordBreak: 'break-all', opacity: 0.8 } }, u.url));
      body.append(fig);
    });
    body.append(h('p', { style: { margin: '6px 0' } }, 'Scan with the phone\'s camera, or open the address on the phone and type the key ',
        h('b', { style: { fontFamily: 'ui-monospace, monospace', letterSpacing: '.06em' } }, info.key), '.'),
      h('p', { style: { margin: '6px 0', opacity: 0.75 } }, info.phones === 1 ? '1 phone connected.' : info.phones + ' phones connected.'),
      h('button', { class: 'p-button p-button-sm p-button-secondary', style: { marginTop: '4px' }, onclick: async () => {
        if (!confirm('Make a new key? Every phone paired before will have to scan again.')) return;
        await post('/comfyaf/new-key', {}); paintPanel();
      } }, 'New key — un-pair every phone'));
  }
  body.append(h('hr', { style: { border: 0, borderTop: '1px solid rgba(127,127,127,.25)', margin: '14px 0 4px' } }),
    toggleRow('Let the phone use the mouse and keyboard', `${ID}.Input`, 'Mouse mode (Select on the phone) moves this computer\'s real mouse, and ⌨ types, in any window, not just ComfyUI. Windows only.'),
    h('p', { style: { margin: '10px 0 0', opacity: 0.6, fontSize: '12px' } }, 'Firewall: if the phone cannot load the page, allow Python on Private networks when Windows asks.'));
  panel.replaceChildren(body);
}

/** 2026-11-14: the plugin was called ComfyRemote. Its settings were saved under "ComfyRemote.…": carry them over once. */
async function carryOver(ids) {
  try {
    if (localStorage.getItem('comfyaf:settings-carried:' + ids[0])) return;
    const st = app.extensionManager && app.extensionManager.setting;
    if (!st) return;
    for (const id of ids) {
      const old = st.get(id.replace(/^ComfyAF\./, 'ComfyRemote.'));
      if (old !== undefined && old !== null && old !== st.get(id)) await st.set(id, old);
    }
    localStorage.setItem('comfyaf:settings-carried:' + ids[0], '1');
  } catch (e) { /* nothing to carry */ }
}

app.registerExtension({
  name: 'ComfyAF.PhoneRemote',
  settings: [
    { id: `${ID}.Enabled`, category: ['ComfyAF', 'Phone remote', 'Enabled'], name: 'Phone remote (listens on your network with a pairing key)', type: 'boolean', defaultValue: false,
      tooltip: 'Drive ComfyUI from a phone on the same Wi-Fi: pan, pinch, fit, undo, move nodes, Queue, Cancel, the latest image. The ComfyAF panel (📱 in the left bar) shows the QR code.',
      onChange: (v, old) => { if (old !== undefined && v !== old) sync(!!v); } },
    { id: `${ID}.Input`, category: ['ComfyAF', 'Phone remote', 'Input'], name: 'Let the phone use the mouse and keyboard (the whole computer, Windows)', type: 'boolean', defaultValue: false,
      tooltip: "Mouse mode (Select on the phone) moves this computer's real mouse and the phone's keyboard types, in any window. Off: the phone drives ComfyUI only.",
      onChange: (v, old) => { if (old !== undefined && v !== old) sync(); } },
    { id: `${ID}.Port`, category: ['ComfyAF', 'Phone remote', 'Port'], name: 'Phone remote port', type: 'number', defaultValue: 8796, attrs: { min: 1024, max: 65535, step: 1 },
      onChange: (v, old) => { if (old !== undefined && v !== old && on) sync(); } },
  ],
  commands: [
    { id: 'ComfyAF.PairPhone', label: 'Pair a phone…', icon: 'pi pi-mobile', function: pairPhone },
  ],
  menuCommands: [{ path: ['Extensions', 'ComfyAF'], commands: ['ComfyAF.PairPhone'] }],
  setup() {
    if (framed) return;
    listen();
    carryOver([`${ID}.Enabled`, `${ID}.Input`, `${ID}.Port`]).then(() => sync());
    try {
      app.extensionManager.registerSidebarTab({
        id: 'comfyaf', icon: 'pi pi-mobile', title: 'ComfyAF', tooltip: 'ComfyAF — pair a phone', type: 'custom',
        render: (el) => { panel = el; paintPanel(); clearInterval(panelTimer); panelTimer = setInterval(paintPanel, 3000); },
      });
    } catch (e) { console.warn('[ComfyAF] no side panel in this ComfyUI:', e); }
  },
});
