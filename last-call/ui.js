// ui.js — tiny DOM helpers. All text goes in through textContent, never innerHTML,
// because every string on this page comes from the network.

/** h('div', { class: 'x', text: 'hi', onclick }, child, [children]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === '') continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/**
 * Re-renders `el` only when `data` changed (compared as JSON). Keeps heartbeat `room`
 * messages from rebuilding the screen (and restarting animations) every 10 seconds.
 */
export function region(el, data, build) {
  const sig = JSON.stringify(data) ?? 'null';
  if (el._sig === sig) return false;
  el._sig = sig;
  el.replaceChildren(...[].concat(build(data) || []).filter(Boolean));
  return true;
}

// ---------- defensive readers: the wire can send anything ----------

export const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
export const arr = (x) => (Array.isArray(x) ? x : []);
export const str = (x) => (typeof x === 'string' ? x : typeof x === 'number' && Number.isFinite(x) ? String(x) : '');
export const num = (x, fallback = null) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

/** Only real CSS colors get through (keeps a bad accent from breaking the card). */
export function safeColor(c, fallback) {
  if (typeof c !== 'string' || c.length > 40) return fallback;
  try {
    return CSS.supports('color', c) ? c : fallback;
  } catch {
    return fallback;
  }
}

/** "house_party" -> "House Party" */
export function titleCase(s) {
  return str(s)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

/** 8 -> "8", 75000 -> "1:15", <=0 -> "0" */
export function fmtCountdown(ms) {
  if (!(ms > 0)) return '0';
  const s = Math.ceil(ms / 1000);
  return s < 60 ? String(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtClockTime(localMs) {
  try {
    return new Date(localMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function buzz(pattern) {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    /* not supported (iOS Safari) — the flash still happens */
  }
}

export const reducedMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
