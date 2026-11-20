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

// ---------- amounts: sips -> a full drink (Jackson 11/19) ----------
// The same words as the Table (LastCallEngine.drinkAmount / drinkAmountShort).
// Under `perDrink` it's "3 sips"; at or over it "a full drink and 3 sips",
// "2 full drinks", or with hard liquor "a shot and 3 sips", "2 shots".
// No `perDrink` from the Table (an older leader) = plain sips.

const sipWord = (n) => (n === 1 ? '1 sip' : `${n} sips`);

/** "3 sips" · "a full drink and 3 sips" · "2 shots" */
export function drinkAmount(n, perDrink, shots) {
  const size = Number.isFinite(perDrink) && perDrink >= 1 ? Math.floor(perDrink) : Infinity;
  if (!(n >= size)) return sipWord(n);
  const whole = Math.floor(n / size);
  const rest = n % size;
  const unit = shots ? (whole === 1 ? 'a shot' : `${whole} shots`) : whole === 1 ? 'a full drink' : `${whole} full drinks`;
  return rest > 0 ? `${unit} and ${sipWord(rest)}` : unit;
}

/** For the Owe number and chips: "3" · "1 drink + 3" · "2 shots" */
export function drinkAmountShort(n, perDrink, shots) {
  const size = Number.isFinite(perDrink) && perDrink >= 1 ? Math.floor(perDrink) : Infinity;
  if (!(n >= size)) return String(n);
  const whole = Math.floor(n / size);
  const rest = n % size;
  const unit = shots ? `${whole} shot${whole === 1 ? '' : 's'}` : `${whole} drink${whole === 1 ? '' : 's'}`;
  return rest > 0 ? `${unit} + ${rest}` : unit;
}

/** Only real CSS colors get through (keeps a bad accent from breaking the card). */
export function safeColor(c, fallback) {
  if (typeof c !== 'string' || c.length > 40) return fallback;
  try {
    return CSS.supports('color', c) ? c : fallback;
  } catch {
    return fallback;
  }
}

// ---------- icons: stroke SVGs in the current text color (no emoji anywhere) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  glass: ['M5 4h14l-7 8z', 'M12 12v8', 'M8 20h8'],
  eye: ['M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z'],
  eyeOff: [
    'M3 3l18 18', 'M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4.1',
    'M6.6 6.6A17 17 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2',
  ],
  check: ['M4.5 12.5l5 5L19.5 7'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  userPlus: ['M15 20a6 6 0 0 0-12 0', 'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M19 8v6', 'M16 11h6'],
  exit: ['M10 4H5v16h5', 'M14 8l4 4-4 4', 'M18 12H9'],
  camera: ['M3.5 8h3.5l2-3h6l2 3h3.5v11h-17z', 'M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7z'],
};

/** icon('eye', 20) -> a decorative <svg> (aria-hidden; the button's text is its label). */
export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = {
    class: 'icon', viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Length of the longest word ("BANK HEIST!" -> 6). Big sticker titles use it as the CSS
 * variable --fit, so the font shrinks just enough for that word to fit on one line.
 */
export function longestWord(s) {
  return Math.max(1, ...str(s).split(/[\s\-–—]+/).map((w) => w.length));
}

/** plural(1, 'card') -> "1 card", plural(3, 'card') -> "3 cards" (never "1 CARDS"). */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
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
