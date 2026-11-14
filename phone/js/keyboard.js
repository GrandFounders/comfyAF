/* ComfyAF phone — the keyboard bar: typing on the computer (EcoRemote's keyboard.js) */
import { $, buzz, S } from './state.js';
import { input } from './connection.js';
import { render, toast } from './view.js';
import { layoutPip, scheduleShot } from './preview.js';

// ---------------------------------------------------------------- the keyboard
/* What you type goes to the computer (the window in front), through the input helper. The text field
   keeps a few invisible characters so Backspace always has something to delete, and every change is
   sent as "delete n, type this" — which also follows autocorrect and word suggestions. */
export const kbd = $('#kbd'), kin = $('#kbdInput');
export const SENT = '​​​​​​';
export let kprev = SENT, composing = false, kchain = Promise.resolve();
export const mods = new Set();
export const kq = (fn) => { kchain = kchain.then(fn).catch((e) => toast(e.message, 'error')); };
export function keyPress(key, extraMods) {
  const ms = [...new Set([...(extraMods || []), ...mods])];
  if (mods.size) { mods.clear(); paintMods(); }
  kq(() => input('key', { key, mods: ms })); buzz(5);
  scheduleShot(500);
}
export function typeText(text) {
  if (!text) return;
  if (mods.size) {                    // Ctrl (armed) + a letter typed on the phone's keyboard = a shortcut
    for (const ch of text) { if (/^[a-z0-9]$/i.test(ch)) keyPress(ch.toUpperCase()); else kq(() => input('text', { text: ch })); }
    return;
  }
  kq(() => input('text', { text })); scheduleShot(700);
}
export function kreset() { kin.value = SENT; kprev = SENT; try { kin.setSelectionRange(SENT.length, SENT.length); } catch (e) { /* */ } }

export function paintMods() { for (const b of kbd.querySelectorAll('.key.mod')) b.classList.toggle('on', mods.has(b.dataset.mod)); }
export function keyBtn(label, fn, cls = '') { const b = document.createElement('button'); b.className = 'key ' + cls; b.textContent = label; b.addEventListener('pointerdown', (e) => e.preventDefault()); b.onclick = fn; return b; }

export function openKbd() {
  if (!S.input) { toast(S.inputWhy || 'The keyboard is not available on this computer.', 'error'); return; }
  kbd.hidden = false; document.body.classList.add('kbd-open'); kreset(); kin.focus(); fitKbd(); render();
}
export function closeKbd() { kbd.hidden = true; kin.blur(); document.body.classList.remove('kbd-open'); mods.clear(); paintMods(); fitKbd(); render(); }

export function fitKbd() {   // keep the bar on top of the phone's own keyboard, and the pad above both
  const vv = window.visualViewport;
  const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  kbd.style.bottom = covered + 'px';
  document.body.style.setProperty('--kbd-h', kbd.hidden ? '0px' : (kbd.offsetHeight + covered) + 'px');
  setTimeout(layoutPip, 30);
}

/** Wire this part up — called by main.js once every module has loaded (they import each other). */
export function wire() {
  kin.addEventListener('compositionstart', () => { composing = true; });
  kin.addEventListener('compositionend', () => { composing = false; setTimeout(() => { if (!composing) kreset(); }, 0); });
  kin.addEventListener('input', () => {
    const cur = kin.value;
    let p = 0; while (p < kprev.length && p < cur.length && kprev[p] === cur[p]) p++;
    const del = kprev.length - p, ins = cur.slice(p).replace(/​/g, '');
    for (let i = 0; i < del; i++) keyPress('Backspace');
    typeText(ins);
    kprev = cur;
    if (!composing && (cur.length > 48 || !cur.startsWith(SENT))) kreset();
  });
  kin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); keyPress('Enter'); kreset(); }
    else if (e.key === 'Tab') { e.preventDefault(); keyPress('Tab'); }
    else if (/^Arrow/.test(e.key) && !composing) { e.preventDefault(); keyPress(e.key); }
    else if (e.key === 'Escape') { e.preventDefault(); keyPress('Escape'); }
  });
  $('#krow1').append(
    keyBtn('Esc', () => keyPress('Escape')), keyBtn('Tab', () => keyPress('Tab')), keyBtn('⌫', () => keyPress('Backspace')), keyBtn('Del', () => keyPress('Delete')),
    keyBtn('⏎', () => keyPress('Enter')), keyBtn('←', () => keyPress('ArrowLeft')), keyBtn('↑', () => keyPress('ArrowUp')), keyBtn('↓', () => keyPress('ArrowDown')), keyBtn('→', () => keyPress('ArrowRight')),
    keyBtn('Home', () => keyPress('Home')), keyBtn('End', () => keyPress('End')),
  );
  for (const [m, label] of [['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt'], ['win', 'Win']]) {
    const b = keyBtn(label, () => { mods.has(m) ? mods.delete(m) : mods.add(m); paintMods(); buzz(5); }, 'mod'); b.dataset.mod = m; $('#krow2').append(b);
  }
  $('#krow2').append(
    keyBtn('Copy', () => keyPress('C', ['ctrl'])), keyBtn('Paste', () => keyPress('V', ['ctrl'])), keyBtn('Cut', () => keyPress('X', ['ctrl'])),
    keyBtn('All', () => keyPress('A', ['ctrl'])), keyBtn('Undo', () => keyPress('Z', ['ctrl'])),
  );
  $('#kbdBtn').addEventListener('click', () => { buzz(5); kbd.hidden ? openKbd() : closeKbd(); });
  $('#kbdClose').addEventListener('click', closeKbd);
  if (window.visualViewport) { visualViewport.addEventListener('resize', fitKbd); visualViewport.addEventListener('scroll', fitKbd); }
}
