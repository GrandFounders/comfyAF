/**
 * hostKit/host/dialogs.js — L2 `dialogs` row: confirm / alert / prompt, drawn by the host.
 *
 * Every dialog goes through the shared DialogQueue, whether a plugin asked by message
 * (`host.confirm` …, see router.js) or host code called `hostDialogs.confirm(…)` in-process.
 * Under Electron, confirm/alert are meant to map to dialog.showMessageBox via KairosPlatform
 * (MOTHERSHIP_SPEC §7) — not wired yet; this is the PWA implementation.
 */
import { h } from './util.js';

const CANCELLED = { ok: false, result: { reason: 'cancelled' } };

/** Draw one dialog. Resolves { ok, result } — cancel is a normal answer, not an error. */
function show(kind, args, ctx) {
  const a = args || {};
  return new Promise((resolve) => {
    const isPrompt = kind === 'prompt';
    const isAlert = kind === 'alert';
    const titleId = 'hostDialogTitle' + Math.random().toString(36).slice(2, 8);
    const input = isPrompt
      ? h('input', { class: 'host-input', type: 'text', value: a.defaultValue != null ? String(a.defaultValue) : '', placeholder: a.placeholder || '' })
      : null;
    const okBtn = h('button', {
      type: 'button',
      class: 'host-btn ' + (a.danger ? 'host-btn-danger' : 'host-btn-primary'),
      text: a.confirmLabel || (isAlert ? 'OK' : isPrompt ? 'OK' : 'Confirm'),
    });
    const cancelBtn = isAlert ? null : h('button', { type: 'button', class: 'host-btn', text: a.cancelLabel || 'Cancel' });
    // confirm with a third answer (2026-10-31): e.g. "Always allow" — resolves { ok: true, result: { confirmed, also: true } }
    const alsoBtn = kind === 'confirm' && a.alsoLabel ? h('button', { type: 'button', class: 'host-btn', text: String(a.alsoLabel), title: a.alsoTitle || '' }) : null;
    const dialog = h('div', { class: 'host-modal host-dialog', role: isAlert ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'host-modal-header' }, h('h2', { class: 'host-modal-title', id: titleId, text: a.title || (isAlert ? 'Notice' : isPrompt ? 'Enter a value' : 'Are you sure?') })),
      h('div', { class: 'host-modal-body' },
        a.message ? h('p', { class: 'host-dialog-message', text: String(a.message) }) : null,
        input),
      h('div', { class: 'host-modal-footer' }, cancelBtn, alsoBtn, okBtn));
    const overlay = h('div', { class: 'host-modal-overlay show host-dialog-overlay' }, dialog);

    let closed = false;
    const prevFocus = document.activeElement;
    function close(res) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
      resolve(res);
    }
    const accept = () => {
      if (isPrompt) close({ ok: true, result: { value: input.value } });
      else if (isAlert) close({ ok: true, result: {} });
      else close({ ok: true, result: { confirmed: true } });
    };
    const dismiss = () => (isAlert ? close({ ok: true, result: {} }) : close(CANCELLED));
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
      else if (e.key === 'Enter' && (!isPrompt || document.activeElement === input || document.activeElement === okBtn)) { e.preventDefault(); e.stopPropagation(); accept(); }
      else if (e.key === 'Tab') {                    // keep focus inside the dialog
        const f = [input, cancelBtn, alsoBtn, okBtn].filter(Boolean);
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    }
    okBtn.addEventListener('click', accept);
    if (cancelBtn) cancelBtn.addEventListener('click', dismiss);
    if (alsoBtn) alsoBtn.addEventListener('click', () => close({ ok: true, result: { confirmed: true, also: true } }));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) dismiss(); });
    document.addEventListener('keydown', onKey, true);
    if (ctx && ctx.onCancel) ctx.onCancel(() => close(CANCELLED));
    document.body.appendChild(overlay);
    setTimeout(() => { (input || okBtn).focus(); if (input) input.select(); }, 0);
  });
}

/**
 * @param {import('./queue.js').DialogQueue} queue
 */
export function createDialogs(queue) {
  return {
    /** Message binding: run one dialog inside the queue job the router already holds. */
    run(kind, args, ctx) { return show(kind, args, ctx); },

    /** In-process API (host code). Queued like everything else. */
    confirm(args, owner = 'host') {
      return queue.enqueue(owner, (ctx) => show('confirm', args, ctx)).then((r) => !!(r && r.ok));
    },
    /** confirm with a third button (args.alsoLabel, e.g. "Always allow"): resolves 'yes' | 'also' | 'no'. */
    confirmMore(args, owner = 'host') {
      return queue.enqueue(owner, (ctx) => show('confirm', args, ctx)).then((r) => (r && r.ok ? (r.result && r.result.also ? 'also' : 'yes') : 'no'));
    },
    alert(args, owner = 'host') {
      return queue.enqueue(owner, (ctx) => show('alert', typeof args === 'string' ? { message: args } : args, ctx)).then(() => undefined);
    },
    prompt(args, owner = 'host') {
      return queue.enqueue(owner, (ctx) => show('prompt', args, ctx)).then((r) => (r && r.ok ? r.result.value : null));
    },
  };
}
