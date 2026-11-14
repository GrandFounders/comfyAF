/**
 * hostKit/host/util.js — small helpers shared by the Kairos L2 host services.
 * L2 rule (PROPOSAL_L2 §8 rule 23): nothing under hostKit/ imports from an app or its plugins/.
 */

/** Resolve a manifest path against the PAGE (never against the manifest file's own URL). */
export function resolveUrl(pathOrUrl) {
  if (!pathOrUrl) return '';
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return pathOrUrl;
    return new URL(pathOrUrl, window.location.href).href;
  } catch (e) {
    return pathOrUrl;
  }
}

/**
 * Resolve a path a MANIFEST gave. An app plugin's paths are relative to the page (the long-standing
 * rule: "plugins/GuapXL/invoice/invoice.html"). An ECOSYSTEM plugin (_EcoPlugs/_Plugins, shared by
 * every app) cannot know where the app's page is, so its paths are relative to its OWN folder.
 * "host:page.html" is the HOST app's own page, whatever the scope (e.g. GuapXL's "host:dashboard.html").
 */
export function resolveFor(m, pathOrUrl) {
  if (!pathOrUrl) return '';
  if (String(pathOrUrl).indexOf('host:') === 0) return resolveUrl(String(pathOrUrl).slice(5));
  if (!m || m._scope !== 'ecosystem' || /^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl) || String(pathOrUrl).startsWith('/')) return resolveUrl(pathOrUrl);
  try { return new URL(pathOrUrl, resolveUrl(m._manifestUrl)).href; } catch (e) { return resolveUrl(pathOrUrl); }
}

const warned = new Set();
/** console.warn once per key — a misconfiguration is worth saying, not worth saying 400 times. */
export function warnOnce(key, ...msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[host]', ...msg);
}

/** Create an element with props and children. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Parse a CSS length like "320px" to a number, or null. */
export function px(v) {
  if (typeof v === 'number') return v;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(String(v || ''));
  return m ? Number(m[1]) : null;
}
