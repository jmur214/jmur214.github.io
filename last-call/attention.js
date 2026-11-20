// attention.js — getting a guest's attention without a voice (Jackson took read-aloud out):
//
//   1. a short two-note chime when it's this phone's turn (Web Audio, made on the fly: no
//      sound file to download), and
//   2. a screen wake lock while the night runs, so the page doesn't go dark mid-game.
//
// iPhones ignore the web's vibrate, so the chime is the only "you're up" signal a face-down
// iPhone gets. Both fail silently where the browser can't do them.
//
// iOS Safari only lets a page make sound after a tap on that page. So `unlockAudio()` runs on
// every tap (see the listeners at the bottom); the first one with the chime turned on creates
// the audio and plays a silent blip, which is what really unlocks it. A chime before any tap
// is simply skipped. (The iPhone's silent switch also mutes it; that's up to the guest.)

let enabled = true;
let ctx = null; // the AudioContext, created on the first tap
let lastChimeAt = 0;
let stateListener = null; // app.js redraws when sound becomes possible (or stops being possible)

const CHIME_GAP_MS = 800; // two reasons at once (named on the card + a vote) = one chime

/** The "Chime when it's my turn" setting (app.js loads it from storage). */
export function setChimeEnabled(on) {
  enabled = !!on;
}

let noAudio = false; // this browser has no Web Audio, or making it failed: a tap won't help

/**
 * Should the page ask for a tap? The chime is on, this browser can make sound, and right now it
 * can't: before the first tap on this page load (iOS), and again while iOS keeps the audio paused
 * (after the phone was locked). The page shows "Tap anywhere to turn the chime on" while it's true
 * (11/20 final review: after Safari reloaded the tab, the chime was silently dead until the guest
 * happened to tap).
 */
export function audioNeedsTap() {
  if (!enabled || noAudio) return false;
  if (!(globalThis.AudioContext || globalThis.webkitAudioContext)) return false;
  return !ctx || ctx.state !== 'running';
}

/** `fn()` runs whenever audioReady() may have changed. */
export function onAudioState(fn) {
  stateListener = fn;
}

function audioChanged() {
  if (stateListener) {
    try {
      stateListener();
    } catch {
      /* the page's redraw failed: nothing to do here */
    }
  }
}

function audioContext() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    // iOS pauses ("interrupted" / "suspended") and resumes it by itself: tell the page.
    if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', audioChanged);
  } catch {
    ctx = null;
    noAudio = true;
    audioChanged();
  }
  return ctx;
}

/** Call from inside a tap. Makes later chimes possible on iOS. */
export function unlockAudio() {
  if (!enabled) return;
  const c = audioContext();
  if (!c) return;
  try {
    if (c.state !== 'running') c.resume().then(audioChanged, () => {});
    // One silent sample, played inside the tap: iOS treats the page as allowed to play sound.
    const silent = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = silent;
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* no audio on this browser */
  }
}

/** Plays the "your turn" ding-dong. Returns true if it played. */
export function chime() {
  if (!enabled || !ctx) return false; // no tap yet = no sound allowed
  const now = Date.now();
  if (now - lastChimeAt < CHIME_GAP_MS) return false;
  lastChimeAt = now;
  const c = ctx;
  const play = () => {
    // Two soft bell notes going up (G5 then C6), the second starting just after the first.
    note(c, 784, 0);
    note(c, 1046.5, 0.14);
  };
  try {
    if (c.state === 'running') play();
    // iOS pauses audio when the phone locks; try to wake it, then play.
    else c.resume().then(() => c.state === 'running' && play()).catch(() => {});
  } catch {
    return false;
  }
  return true;
}

/** One bell-like note: a sine wave that starts fast and fades out over about half a second. */
function note(c, freq, delay) {
  const t = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.012); // quick attack
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6); // bell-like fade
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.65);
}

// ---------------------------------------------------------------------------
// Screen wake lock
// ---------------------------------------------------------------------------
// The browser drops the lock by itself whenever the page is hidden (phone locked, other app),
// so we ask again each time the page comes back. If asking fails (some browsers want a tap
// first), we try again on the next tap instead of hammering it on every render.

let wantAwake = false;
let sentinel = null; // the WakeLockSentinel while we hold the lock
let asking = false;
let failedAt = 0;
const RETRY_AFTER_FAIL_MS = 10000;

/** true while the night runs, false at Wrapped / the end. Safe to call on every render. */
export function holdScreenAwake(on) {
  wantAwake = !!on;
  if (wantAwake) acquire(false);
  else release();
}

async function acquire(userAction) {
  if (!wantAwake || sentinel || asking) return;
  if (document.visibilityState !== 'visible') return;
  if (!userAction && failedAt && Date.now() - failedAt < RETRY_AFTER_FAIL_MS) return;
  const wl = navigator.wakeLock;
  if (!wl || typeof wl.request !== 'function') return; // not supported: nothing to do
  asking = true;
  try {
    const s = await wl.request('screen');
    asking = false;
    failedAt = 0;
    if (!wantAwake) {
      // The night ended while we were asking.
      s.release().catch(() => {});
      return;
    }
    sentinel = s;
    s.addEventListener('release', () => {
      if (sentinel === s) sentinel = null; // the browser let go (page hidden): re-ask on return
    });
  } catch {
    asking = false;
    failedAt = Date.now();
  }
}

function release() {
  const s = sentinel;
  sentinel = null;
  if (s) {
    try {
      s.release().catch(() => {});
    } catch {
      /* already released */
    }
  }
}

// ---------------------------------------------------------------------------
// Listeners: every tap unlocks audio and (re)takes the wake lock; coming back re-takes it.
// ---------------------------------------------------------------------------

function onUserAction() {
  if (enabled && (!ctx || ctx.state !== 'running')) unlockAudio();
  acquire(true);
}

for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(type, onUserAction, { capture: true, passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  acquire(true);
  if (ctx && ctx.state !== 'running') ctx.resume().then(audioChanged, () => {});
  audioChanged(); // (still paused? the page asks for a tap again)
});
