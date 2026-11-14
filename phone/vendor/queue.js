/**
 * hostKit/host/queue.js — one dialog at a time; the rest WAIT (decided 2026-10-18, PROPOSAL_L2 §4.2).
 *
 *   · FIFO across all callers; a caller's own requests stay in its order.
 *   · dropOwner(instanceId): queued requests of a closed document are dropped silently, and its
 *     open dialog (if any) is cancelled — a dialog never outlives the document that asked.
 *   · Each job is `run(ctx)` returning a Promise of `{ ok, result }`. A job registers how to
 *     dismiss itself with `ctx.onCancel(fn)`; dropOwner calls that, and the job then resolves
 *     `cancelled` through its normal path.
 */
export class DialogQueue {
  constructor() {
    this._items = [];
    this._current = null;
  }

  /** @returns {Promise<{ok:boolean, result:object}|null>} null = dropped (owner closed). */
  enqueue(owner, run) {
    return new Promise((resolve) => {
      this._items.push({ owner, run, resolve, cancel: null, done: false });
      this._pump();
    });
  }

  get busy() { return !!this._current; }
  get waiting() { return this._items.length; }

  _pump() {
    if (this._current || !this._items.length) return;
    const job = (this._current = this._items.shift());
    const ctx = { onCancel: (fn) => { job.cancel = fn; } };
    let p;
    try { p = Promise.resolve(job.run(ctx)); } catch (e) { p = Promise.reject(e); }
    p.then(
      (res) => this._finish(job, res),
      (err) => this._finish(job, { ok: false, result: { reason: 'error', message: String((err && err.message) || err) } }),
    );
  }

  _finish(job, res) {
    if (job.done) return;
    job.done = true;
    if (this._current === job) this._current = null;
    job.resolve(res);
    this._pump();
  }

  dropOwner(owner) {
    this._items = this._items.filter((j) => {
      if (j.owner !== owner) return true;
      j.done = true;
      j.resolve(null);
      return false;
    });
    const c = this._current;
    if (c && c.owner === owner && typeof c.cancel === 'function') c.cancel();
  }
}
