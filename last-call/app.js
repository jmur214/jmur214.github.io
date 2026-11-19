// app.js — the Last Call guest page.
//
// A GENERIC RENDERER (docs/02-architecture/last-call-protocol.md): it shows the public
// `room` view, this player's private `sections`, open `prompts` and `actions`, and sends
// back taps. It knows no game rules — the leader's phone decides everything.
//
// Layout of this file:
//   1. state          4. join flow              7. live ticker (timers, waiting, peeks)
//   2. boot           5. answering / actions    8. rendering
//   3. messaging      6. sessions & profiles

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createTransport } from './transport.js';
import { generateJoinKeyPair, exportPublicKey, openJoinReply, randomId } from './crypto.js';
import {
  parseFragment, roomChannel, privateChannel, makeEnvelope, isEnvelope, SeqTracker, LeaderClock,
} from './protocol.js';
import * as store from './storage.js';
import {
  h, region, obj, arr, str, num, safeColor, titleCase, fmtCountdown, fmtClockTime, buzz, reducedMotion, icon, longestWord,
} from './ui.js';

// ============================================================================
// 1. State
// ============================================================================

const ROOM_STALE_MS = 15000; // no `room` for this long -> "Waiting for the Table…"
const PING_EVERY_MS = 5000; // ...and ping this often while waiting
const PEEK_MS = 5000; // hidden sections re-cover after this
const RESULT_MS = 4500; // how long a prompt_close result stays up

// Card band color when the leader sends no (or a bad) `card.accent`: Sticker Pop "game" teal.
const DEFAULT_ACCENT = '#2ec4b6';
const SECTION_STYLES = ['normal', 'secret', 'mission', 'warning', 'good'];
const ACTION_STYLES = ['primary', 'normal', 'secret', 'mission', 'warning', 'good', 'danger'];
const BANNER_STYLES = ['interrupt', 'info', 'alert'];
const BANNER_CHIPS = { interrupt: 'Interrupt!', info: 'Heads up', alert: 'Alert!' };
const PHASES = {
  lobby: 'Lobby', writing: 'Writing', warmup: 'Warm-up', main: 'Main game',
  lastcall: 'Last Call', finale: 'Finale', ended: "That's a wrap",
};

const S = {
  fatal: null, // a message when the page can't work at all
  roomId: null,
  sessions: [], // [{ roomId, secret, playerId, name, savedAt }]
  activeId: null, // playerId of the profile on screen
  cover: false, // "Pass to X" cover is up
  room: null, // last public `room` body
  lastRoomAt: 0,
  enteredAt: 0,
  lastPingAt: 0,
  stale: false,
  priv: {}, // playerId -> `private` body
  prompts: {}, // playerId -> Map(promptId -> { p, answered, label, receivedAt })
  results: [], // [{ pid, title, text, until }]
  pressed: {}, // `${pid}:${actionId}` -> until (brief "Sent" state)
  joining: null, // { requestId, keyPair, name, claimPlayerId, status, error }
  joinMode: 'pick', // 'pick' (who are you?) | 'new' (type a name)
  addingPlayer: false,
  notice: null,
  peek: {}, // `${pid}:${sectionId}` -> until
  modal: null, // { id, title, text, buttons: [{ label, style, run }] }
  toast: null, // { text, until }
  recap: null, // playerId whose "Tonight's recap" overlay is open
  unseenRecap: new Set(),
  wrapped: {}, // playerId -> stored wrapped record (mirror of localStorage)
  showWrappedLanding: false,
  bannerKey: null,
  bannerMin: false,
  flashedKey: null,
  sheetMin: false,
};

const clock = new LeaderClock();
const seqs = new SeqTracker(); // leader seq per channel
const mySeq = new Map(); // our own seq per channel
const subs = new Map(); // channel name -> unsubscribe()
let transport = null;
let modalSeq = 0;

// ============================================================================
// 2. Boot
// ============================================================================

function boot() {
  // Read the fragment, then wipe it from the address bar so it can't be shoulder-surfed
  // or shared by accident.
  const frag = parseFragment(location.hash);
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);

  store.prune();

  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    S.fatal = 'This page needs a secure (https) link. Scan the QR code again.';
  }
  try {
    const kind = new URLSearchParams(location.search).get('transport') === 'local' ? 'local' : 'supabase';
    transport = createTransport({ kind, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_ANON_KEY });
  } catch (err) {
    console.error(err);
    S.fatal = "Couldn't load the game connection. Check your signal and reload.";
  }

  const roomId = frag.r || store.getLastRoom();
  if (roomId) {
    S.roomId = roomId;
    if (frag.r) store.setLastRoom(roomId);
    S.sessions = store.loadSessions(roomId);
    S.wrapped = store.loadWrapped(roomId);
    if (frag.s) adoptLinkSession(frag.s, frag.p);

    const saved = frag.p || store.getActive(roomId);
    S.activeId = (S.sessions.find((s) => s.playerId === saved) || S.sessions[0] || {}).playerId || null;
    S.cover = S.sessions.length > 1; // shared phone: never open straight onto someone's secrets

    // A stored recap and no fresh per-player link -> the game is (probably) over: open on it.
    S.showWrappedLanding = Object.keys(S.wrapped).length > 0 && !frag.s;

    if (transport && !S.fatal && (frag.r || S.sessions.length)) enterRoom();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resync();
  });
  window.addEventListener('pageshow', (e) => e.persisted && resync());
  window.addEventListener('hashchange', onHashChange);

  render();
  setInterval(tick, 250);
}

/**
 * A QR scanned while this page is already open can arrive as a same-page #fragment change
 * instead of a fresh load. Same room: take the new player link in place. Other room: reload
 * with the fragment so boot() starts clean.
 */
function onHashChange() {
  const frag = parseFragment(location.hash);
  if (!frag.r) return;
  if (frag.r !== S.roomId || S.fatal || !subs.size) {
    location.reload();
    return;
  }
  history.replaceState(history.state, '', location.pathname + location.search);
  if (!frag.s) return; // the room QR again: nothing new
  const known = S.sessions.some((s) => s.playerId === frag.p && s.secret === frag.s);
  adoptLinkSession(frag.s, frag.p);
  subscribePrivate(S.sessions.find((s) => s.playerId === frag.p));
  if (!known || S.activeId !== frag.p) setActive(frag.p, S.sessions.length > 1);
  S.showWrappedLanding = false;
  S.addingPlayer = false;
  render();
}

/** A per-player link (#r&s&p): add that player, or give an existing one its new secret. */
function adoptLinkSession(secret, playerId) {
  const existing = S.sessions.find((s) => s.playerId === playerId);
  if (existing) {
    if (existing.secret !== secret) {
      unsubscribe(privateChannel(existing.secret));
      existing.secret = secret;
      existing.savedAt = Date.now();
    }
  } else {
    S.sessions.push({ roomId: S.roomId, secret, playerId, name: playerName(playerId) || '', savedAt: Date.now() });
  }
  store.saveSessions(S.roomId, S.sessions);
}

function enterRoom() {
  S.enteredAt = Date.now();
  subscribe(roomChannel(S.roomId), onRoomMessage, (status) => {
    if (status === 'SUBSCRIBED') ping();
  });
  for (const s of S.sessions) subscribePrivate(s);
}

/** Phone woke up / tab came back: ask for everything again (cheap, and sockets drop when locked). */
function resync() {
  if (!S.roomId || !subs.size) return;
  ping();
  for (const s of S.sessions) sendHello(s.secret);
}

// ============================================================================
// 3. Messaging
// ============================================================================

function subscribe(name, onMessage, onStatus) {
  if (subs.has(name) || !transport) return;
  subs.set(name, transport.subscribe(name, onMessage, onStatus));
}

function unsubscribe(name) {
  const off = subs.get(name);
  if (off) off();
  subs.delete(name);
  seqs.forget(name);
  mySeq.delete(name);
}

function subscribePrivate(session) {
  const secret = session.secret;
  subscribe(
    privateChannel(secret),
    (env) => onPrivateMessage(secret, env),
    (status) => {
      if (status === 'SUBSCRIBED') sendHello(secret); // first join AND every reconnect
    },
  );
}

function send(channel, t, body, from) {
  if (!transport) return;
  const seq = (mySeq.get(channel) || 0) + 1;
  mySeq.set(channel, seq);
  transport.send(channel, makeEnvelope(t, body, from, seq, clock.leaderNow()));
}

// Room-channel messages from a page: `from` is the page's first player, or "guest" before joining.
const sendRoom = (t, body) => send(roomChannel(S.roomId), t, body, S.sessions[0]?.playerId || 'guest');

function sendPrivate(secret, t, body) {
  const s = S.sessions.find((x) => x.secret === secret);
  if (s) send(privateChannel(secret), t, body, s.playerId);
}

function ping() {
  S.lastPingAt = Date.now();
  sendRoom('ping', {});
}

function sendHello(secret) {
  sendPrivate(secret, 'hello', { lastSeq: seqs.lastSeq(privateChannel(secret)) });
}

function onRoomMessage(env) {
  if (!isEnvelope(env) || env.from !== 'leader') return; // other guests' join/ping, junk
  clock.sample(env.at);
  const gap = seqs.check(roomChannel(S.roomId), env.seq);
  // `room` is a full replace, so a missed one doesn't matter — but if we skipped ahead on
  // something else, ask for a fresh room.
  if ((gap === 'gap' || gap === 'reset') && env.t !== 'room') ping();

  const body = obj(env.body);
  switch (env.t) {
    case 'room':
      S.room = body;
      S.lastRoomAt = Date.now();
      S.stale = false;
      // Fill in names we only knew by id (per-player links).
      for (const s of S.sessions) if (!s.name) s.name = playerName(s.playerId);
      break;
    case 'join_ok':
      onJoinOk(body);
      return;
    case 'join_no':
      onJoinNo(body);
      break;
    default:
      return; // unknown type: ignore
  }
  render();
}

function onPrivateMessage(secret, env) {
  const session = S.sessions.find((s) => s.secret === secret);
  if (!session || !isEnvelope(env) || env.from !== 'leader') return;
  clock.sample(env.at);
  const gap = seqs.check(privateChannel(secret), env.seq);
  if (gap === 'gap' || gap === 'reset') sendHello(secret); // missed something: full resend please

  const pid = session.playerId;
  const body = obj(env.body);
  switch (env.t) {
    case 'private':
      S.priv[pid] = body;
      if (str(body.name) && body.name !== session.name) {
        session.name = body.name;
        store.saveSessions(S.roomId, S.sessions);
      }
      break;
    case 'prompt':
      addPrompt(pid, body);
      break;
    case 'prompt_close':
      closePrompt(pid, body);
      break;
    case 'wrapped':
      storeWrapped(session, body);
      break;
    default:
      return;
  }
  render();
}

function addPrompt(pid, p) {
  if (!str(p.id)) return;
  const map = S.prompts[pid] || (S.prompts[pid] = new Map());
  const prev = map.get(p.id);
  // A re-send (after hello) keeps what we already answered and its place in the stack.
  map.set(p.id, { p, answered: prev?.answered, label: prev?.label, receivedAt: prev?.receivedAt || Date.now() });
  if (!prev) {
    S.sheetMin = false;
    if (pid === S.activeId && !S.cover) buzz(80);
  }
}

function closePrompt(pid, body) {
  const map = S.prompts[pid];
  const entry = map && map.get(str(body.id));
  if (map) map.delete(str(body.id));
  const result = str(body.result);
  if (result) S.results.push({ pid, title: str(entry?.p.title), text: result, until: Date.now() + RESULT_MS });
}

function storeWrapped(session, w) {
  const rec = {
    wrapped: w,
    name: session.name || '',
    // showAt is leader-clock; store it on this phone's clock for tomorrow's visit.
    localShowAt: num(w.showAt) != null ? clock.toLocal(w.showAt) : null,
    receivedAt: Date.now(),
  };
  S.wrapped[session.playerId] = rec;
  store.saveWrapped(S.roomId, session.playerId, rec);
  if (session.playerId === S.activeId && !S.cover) S.recap = session.playerId;
  else S.unseenRecap.add(session.playerId);
}

// ============================================================================
// 4. Join flow (room QR) — protocol §Joining
// ============================================================================

async function startJoin(name, claimPlayerId) {
  name = str(name).trim().slice(0, 32);
  if (!name || (S.joining && S.joining.status === 'waiting')) return;
  try {
    const keyPair = await generateJoinKeyPair();
    const pub = await exportPublicKey(keyPair.publicKey);
    const requestId = randomId(9); // 12 base64url chars
    S.joining = { requestId, keyPair, name, claimPlayerId: claimPlayerId || null, status: 'waiting', at: Date.now() };
    const body = { requestId, name, pub };
    if (claimPlayerId) body.claimPlayerId = claimPlayerId;
    sendRoom('join', body);
  } catch (err) {
    console.error(err);
    S.joining = { status: 'error', error: "This browser can't do the secure join. Try Safari or Chrome." };
  }
  render();
}

async function onJoinOk(body) {
  const j = S.joining;
  if (!j || j.status !== 'waiting' || body.requestId !== j.requestId) return; // someone else's
  j.status = 'opening';
  try {
    const { secret, playerId } = await openJoinReply(j.keyPair.privateKey, body, j.requestId);
    S.joining = null;
    S.addingPlayer = false;
    S.notice = null;
    const session = { roomId: S.roomId, secret, playerId, name: j.name, savedAt: Date.now() };
    const existing = S.sessions.find((s) => s.playerId === playerId);
    if (existing) {
      unsubscribe(privateChannel(existing.secret));
      Object.assign(existing, session);
    } else S.sessions.push(session);
    store.saveSessions(S.roomId, S.sessions);
    store.setLastRoom(S.roomId);
    setActive(playerId, S.sessions.length > 1);
    subscribePrivate(existing || session);
  } catch (err) {
    console.error(err);
    j.status = 'error';
    j.error = "Couldn't unlock your invite. Try again.";
  }
  render();
}

function onJoinNo(body) {
  const j = S.joining;
  if (!j || body.requestId !== j.requestId) return;
  j.status = 'denied';
  j.error = str(body.reason) || 'The Table said no.';
}

// ============================================================================
// 5. Answering prompts, pressing actions
// ============================================================================

function isExpired(p) {
  const ends = num(p.endsAt);
  return ends != null && clock.leaderNow() >= ends;
}

function answer(pid, promptId, value, label) {
  const entry = S.prompts[pid]?.get(promptId);
  const session = S.sessions.find((s) => s.playerId === pid);
  if (!entry || !session || entry.answered !== undefined || isExpired(entry.p)) return;
  entry.answered = value;
  entry.label = label ?? String(value);
  sendPrivate(session.secret, 'answer', { promptId, value });
  render();
}

function pressAction(pid, action) {
  const session = S.sessions.find((s) => s.playerId === pid);
  if (!session) return;
  const go = () => {
    sendPrivate(session.secret, 'act', { actionId: action.id });
    S.pressed[`${pid}:${action.id}`] = Date.now() + 1200;
    render();
  };
  if (str(action.confirm)) {
    openModal({
      text: action.confirm,
      buttons: [
        { label: 'Cancel', style: 'ghost' },
        { label: 'Yes', style: 'primary', run: go },
      ],
    });
  } else go();
}

function openModal(m) {
  S.modal = { id: ++modalSeq, ...m };
  render();
}

function toast(text, ms = 1800) {
  S.toast = { text, until: Date.now() + ms };
  render();
}

// ============================================================================
// 6. Sessions & profiles (one page, several players)
// ============================================================================

function setActive(pid, withCover) {
  S.activeId = pid;
  S.cover = !!withCover;
  S.flashedKey = null;
  store.setActive(S.roomId, pid);
}

function switchTo(pid) {
  if (pid === S.activeId) return;
  setActive(pid, true);
  render();
}

function uncover() {
  S.cover = false;
  if (S.unseenRecap.has(S.activeId)) {
    S.unseenRecap.delete(S.activeId);
    S.recap = S.activeId;
  }
  render();
}

function leave(pid) {
  const s = S.sessions.find((x) => x.playerId === pid);
  if (!s) return;
  sendPrivate(s.secret, 'bye', {});
  unsubscribe(privateChannel(s.secret));
  S.sessions = S.sessions.filter((x) => x !== s);
  store.saveSessions(S.roomId, S.sessions);
  delete S.priv[pid];
  delete S.prompts[pid];
  if (S.sessions.length) setActive(S.sessions[0].playerId, true);
  else {
    S.activeId = null;
    S.cover = false;
    S.notice = 'You left the game. Tap your name to jump back in.';
  }
  render();
}

function confirmLeave() {
  const s = activeSession();
  if (!s) return;
  openModal({
    title: 'Leave the game?',
    text: `${s.name || 'You'} will be dropped from the Table on this phone.`,
    buttons: [
      { label: 'Stay', style: 'ghost' },
      { label: 'Leave', style: 'danger', run: () => leave(s.playerId) },
    ],
  });
}

const activeSession = () => S.sessions.find((s) => s.playerId === S.activeId) || null;
const playerName = (id) => str(arr(S.room?.players).find((p) => obj(p).id === id)?.name);
const sessionName = (s) => (s && (s.name || playerName(s.playerId))) || 'Player';

// ============================================================================
// 7. Live ticker: countdowns, arming, waiting-for-the-Table, expiries
// ============================================================================

function tick() {
  const now = Date.now();
  let dirty = false;

  if (S.roomId && subs.size) {
    const stale = now - (S.lastRoomAt || S.enteredAt) > ROOM_STALE_MS;
    if (stale !== S.stale) {
      S.stale = stale;
      dirty = true;
    }
    if (stale && now - S.lastPingAt >= PING_EVERY_MS) ping();
  }
  for (const [k, until] of Object.entries(S.peek)) {
    if (until <= now) {
      delete S.peek[k];
      dirty = true;
    }
  }
  for (const [k, until] of Object.entries(S.pressed)) {
    if (until <= now) {
      delete S.pressed[k];
      dirty = true;
    }
  }
  const before = S.results.length;
  S.results = S.results.filter((r) => r.until > now);
  if (S.results.length !== before) dirty = true;
  if (S.toast && S.toast.until <= now) {
    S.toast = null;
    dirty = true;
  }
  if (dirty) render();
  else updateLive();
}

/** Cheap per-tick DOM updates that don't need a re-render. */
function updateLive() {
  const now = clock.leaderNow();
  for (const el of document.querySelectorAll('[data-ends-at]')) {
    const left = Number(el.dataset.endsAt) - now;
    el.textContent = fmtCountdown(left);
    el.classList.toggle('done', left <= 0);
    el.classList.toggle('hurry', left > 0 && left <= 5000);
  }
  for (const el of document.querySelectorAll('.prompt[data-expires]')) {
    const expired = now >= Number(el.dataset.expires);
    if (expired !== el.classList.contains('expired')) {
      el.classList.toggle('expired', expired);
      const fs = el.querySelector('fieldset');
      if (fs && expired) fs.disabled = true;
      const note = el.querySelector('.p-state');
      if (note && expired && !el.classList.contains('answered')) note.textContent = "Time's up";
    }
  }
  // Tap race: the button is only CREATED at armAt, so there's nothing to tap early.
  for (const el of document.querySelectorAll('.prompt[data-arm-at]:not(.armed)')) {
    if (now >= Number(el.dataset.armAt)) armTap(el);
  }
}

// ============================================================================
// 8. Rendering
// ============================================================================

const root = document.getElementById('app');
const layers = {
  view: h('div', { class: 'layer-view' }),
  banner: h('div', { class: 'layer-banner' }),
  sheet: h('div', { class: 'layer-sheet' }),
  recap: h('div', { class: 'layer-recap' }),
  cover: h('div', { class: 'layer-cover' }),
  modal: h('div', { class: 'layer-modal' }),
  toast: h('div', { class: 'layer-toast', role: 'status', 'aria-live': 'polite' }),
  flash: h('div', { class: 'flash', 'aria-hidden': 'true' }),
};
root.replaceChildren(...Object.values(layers));

let mountedView = null;
let V = {}; // the current view's region elements

function currentView() {
  if (S.fatal) return 'fatal';
  if (S.showWrappedLanding) return 'wrapped';
  if (!S.roomId) return 'landing';
  if (S.addingPlayer || !S.sessions.length) return 'join';
  return 'game';
}

function render() {
  const view = currentView();
  if (view !== mountedView) {
    mountedView = view;
    V = MOUNT[view]();
    layers.view.replaceChildren(V.root);
    document.body.dataset.view = view;
    window.scrollTo(0, 0);
  }
  UPDATE[view]();
  renderBanner(view);
  renderSheet(view);
  renderRecap(view);
  renderCover(view);
  renderModal();
  region(layers.toast, S.toast?.text || null, (t) => t && h('div', { class: 'toast', text: t }));
  document.body.classList.toggle('has-cover', view === 'game' && S.cover);
  updateLive();
}

// ---------- shared bits ----------

const brand = () =>
  h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('glass', 18)), h('span', { text: 'LAST CALL' }));

function waitingBlock(big) {
  const finding = !S.stale;
  return h(
    'div',
    { class: big ? 'waiting big' : 'waiting', 'data-testid': finding ? 'finding' : 'waiting' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('div', { class: 'waiting-title', text: finding ? 'Finding the Table…' : 'Waiting for the Table…' }),
    !finding && h('div', { class: 'waiting-sub', text: "Make sure the leader's phone is awake and online." }),
  );
}

// ---------- views ----------

const MOUNT = {
  fatal: () => ({
    root: h('main', { class: 'screen center' }, brand(), h('p', { class: 'lead', text: S.fatal })),
  }),

  landing: () => ({
    root: h(
      'main',
      { class: 'screen center landing' },
      brand(),
      h('h1', { class: 'hero', text: 'Scan the QR code on the Table.' }),
      h('p', { class: 'lead', text: "Ask whoever's running the game to show you the code. No app, no account." }),
    ),
  }),

  join: () => {
    const nameInput = h('input', {
      class: 'name-input', type: 'text', maxlength: 24, autocomplete: 'off', autocapitalize: 'words',
      enterkeyhint: 'go', placeholder: 'Your name', 'aria-label': 'Your name',
    });
    const v = {
      nameInput,
      status: h('div', { class: 'join-status' }),
      body: h('div', { class: 'join-body' }),
      root: null,
    };
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && startJoin(nameInput.value));
    v.root = h('main', { class: 'screen join' }, h('header', { class: 'top' }, brand()), v.status, v.body);
    return v;
  },

  game: () => {
    const v = {
      profiles: h('nav', { class: 'profiles', 'aria-label': 'Players on this phone' }),
      stale: h('div', { class: 'stale-bar', role: 'status' }),
      card: h('section', { class: 'card-wrap', 'aria-live': 'polite' }),
      curses: h('section', { class: 'curses' }),
      me: h('section', { class: 'me' }),
      priv: h('section', { class: 'private' }),
      players: h('section', { class: 'players' }),
      ticker: h('section', { class: 'ticker' }),
      foot: h('footer', { class: 'foot' }),
      phase: h('div', { class: 'phase' }),
    };
    v.root = h(
      'main',
      { class: 'screen game' },
      h('header', { class: 'top' }, brand(), v.phase),
      v.profiles, v.stale, v.card, v.curses, v.me, v.priv, v.players, v.ticker, v.foot,
    );
    return v;
  },

  wrapped: () => ({ root: h('main', { class: 'screen wrapped-landing' }), body: null }),
};

const UPDATE = {
  fatal() {},
  landing() {},

  join() {
    const room = S.room;
    const j = S.joining;
    const unclaimed = arr(room?.players).map(obj).filter((p) => p.claimed === false && str(p.id) && str(p.name));

    region(V.status, { stale: S.stale, room: !!room, notice: S.notice }, () => [
      S.notice && h('div', { class: 'notice', text: S.notice }),
      !room && waitingBlock(true),
      room && S.stale && waitingBlock(false),
    ]);

    const picking = S.joinMode === 'pick' && unclaimed.length > 0;
    const data = {
      ready: !!room, mode: picking ? 'pick' : 'new', adding: S.addingPlayer,
      // While typing a new name, only "are there names to pick?" matters, so a heartbeat
      // with a changed list doesn't rebuild (and blur) the name box.
      players: picking ? unclaimed.map((p) => [p.id, p.name]) : unclaimed.length > 0,
      j: j && { status: j.status, error: j.error, name: j.name },
      title: str(room?.title) || 'Last Call', leader: str(room?.leaderName),
    };
    region(V.body, data, (d) => {
      if (!d.ready) return [];
      const cancelAdd = d.adding && h('button', { class: 'btn ghost', text: 'Cancel', onclick: () => { S.addingPlayer = false; S.joining = null; render(); } });

      if (d.j && (d.j.status === 'waiting' || d.j.status === 'opening')) {
        return [
          h('h1', { class: 'hero', text: `Hey ${d.j.name}!` }),
          h('div', { class: 'waiting big', 'data-testid': 'join-waiting' },
            h('div', { class: 'spinner', 'aria-hidden': 'true' }),
            h('div', { class: 'waiting-title', text: 'Asking the Table to let you in…' }),
            h('div', { class: 'waiting-sub', text: d.leader ? `${d.leader} taps "Let in" on their phone.` : 'The leader lets you in from their phone.' })),
          h('button', { class: 'btn ghost', text: 'Cancel', onclick: () => { S.joining = null; render(); } }),
        ];
      }
      const err = d.j && (d.j.status === 'denied' || d.j.status === 'error') &&
        h('div', { class: 'notice bad', 'data-testid': 'join-error', text: d.j.error });

      if (d.mode === 'new') {
        const nameInput = V.nameInput;
        return [
          h('h1', { class: 'hero', text: d.adding ? "Who's joining on this phone?" : `Welcome to ${d.title}` }),
          err,
          h('label', { class: 'label', text: "What's your name?" }),
          nameInput,
          h('button', { class: 'btn primary big', 'data-testid': 'join-new', text: "Let's go", onclick: () => startJoin(nameInput.value) }),
          d.players === true && h('button', { class: 'btn ghost', onclick: () => { S.joinMode = 'pick'; render(); } }, icon('back', 20), 'Pick my name instead'),
          cancelAdd,
        ];
      }
      return [
        h('h1', { class: 'hero', text: d.adding ? "Who's joining on this phone?" : 'Who are you?' }),
        h('p', { class: 'lead', text: d.leader ? `Tap your name to join ${d.leader}'s game.` : 'Tap your name to join.' }),
        err,
        h('div', { class: 'name-grid' },
          d.players.map(([id, name]) =>
            h('button', { class: 'btn name', 'data-player': id, text: name, onclick: () => startJoin(name, id) }))),
        h('button', { class: 'btn ghost big', 'data-testid': 'im-new', text: "I'm new", onclick: () => { S.joinMode = 'new'; render(); setTimeout(() => V.nameInput?.focus(), 0); } }),
        cancelAdd,
      ];
    });
  },

  game() {
    const room = S.room ? S.room : null;
    const me = activeSession();
    const pid = me?.playerId;
    const covered = S.cover;
    const priv = covered ? null : obj(S.priv[pid]);

    // Header phase chip
    region(V.phase, [str(room?.phase), str(room?.vibe), num(room?.cardCount)], ([phase, vibe, count]) => [
      phase && h('span', { class: `chip phase-${phase}`, text: PHASES[phase] || titleCase(phase) }),
      vibe && h('span', { class: 'chip dim', text: titleCase(vibe) }),
      count != null && h('span', { class: 'chip dim', text: `${count} cards` }),
    ]);

    // Profile switcher (only when this phone holds more than one player)
    const counts = S.sessions.map((s) => openCount(s.playerId) + (S.unseenRecap.has(s.playerId) ? 1 : 0));
    region(V.profiles, [S.sessions.map((s) => [s.playerId, sessionName(s)]), pid, counts], ([list, active, cs]) =>
      list.length < 2 ? [] : list.map(([id, name], i) =>
        h('button', {
          class: `profile${id === active ? ' on' : ''}`, 'data-profile': id, 'aria-pressed': String(id === active),
          onclick: () => switchTo(id),
        }, h('span', { text: i === 0 ? `Me · ${name}` : name }), cs[i] > 0 && id !== active && h('span', { class: 'badge', text: String(cs[i]) }))));

    region(V.stale, [S.stale && !!room], ([show]) => show && waitingBlock(false));
    V.stale.hidden = !(S.stale && room);

    renderCard(room, pid, priv, covered);

    // Curses: sticker tags. A curse on you is purple; curses on others / everyone are white.
    const curses = arr(room?.curses).map(obj).filter((c) => str(c.text));
    region(V.curses, [curses.map((c) => [c.id, c.text, c.who, num(c.cardsLeft)]), pid], ([list, me]) => !list.length ? [] : [
      h('h2', { class: 'section-label', text: list.length > 1 ? `${list.length} curses active` : 'Curse active' }),
      h('ul', { class: 'curse-list' }, list.map(([, text, who, left]) =>
        h('li', { class: `curse${me && who === me ? ' mine' : ''}` },
          h('span', { class: 'curse-text', text }),
          h('span', { class: 'curse-meta' },
            h('span', { text: who === 'everyone' || !who ? 'Everyone' : playerName(who) || str(who) }),
            left != null && h('b', { text: `${left} card${left === 1 ? '' : 's'} left` }))))),
    ]);
    V.curses.hidden = !curses.length;

    // Owe / Bank (big)
    const pub = obj(arr(room?.players).find((p) => obj(p).id === pid));
    const you = obj(priv?.you);
    const owe = num(you.owe, num(pub.owe, 0));
    const bank = num(you.bank, num(pub.bank, 0));
    region(V.me, [sessionName(me), owe, bank, covered], ([name, o, b, cov]) => cov ? [] : [
      h('div', { class: 'me-name' }, h('span', { class: 'dim', text: 'You are' }), h('b', { text: name })),
      h('div', { class: 'me-stats' },
        h('div', { class: `stat owe${o > 0 ? ' hot' : ''}`, 'data-testid': 'owe' }, h('span', { class: 'stat-l', text: 'Owe' }), h('span', { class: 'stat-n', text: String(o) })),
        h('div', { class: 'stat bank', 'data-testid': 'bank' }, h('span', { class: 'stat-l', text: 'Bank' }), h('span', { class: 'stat-n', text: String(b) }))),
    ]);

    // Private sections + actions
    const now = Date.now();
    const sections = arr(priv?.sections).map(obj).filter((s) => str(s.id) || str(s.title));
    const peeked = sections.filter((s) => S.peek[`${pid}:${s.id}`] > now).map((s) => s.id);
    const actions = arr(priv?.actions).map(obj).filter((a) => str(a.id) && str(a.label));
    const pressed = actions.filter((a) => S.pressed[`${pid}:${a.id}`] > now).map((a) => a.id);
    region(V.priv, [pid, covered, sections, peeked, actions, pressed], () => covered ? [] : [
      sections.length > 0 && h('div', { class: 'sections' }, sections.map((s) => renderSection(pid, s, peeked.includes(s.id)))),
      actions.length > 0 && h('div', { class: 'actions' }, actions.map((a) => {
        const style = ACTION_STYLES.includes(a.style) ? a.style : 'normal';
        const sent = pressed.includes(a.id);
        return h('button', {
          class: `btn act ${style}${sent ? ' sent' : ''}`, 'data-action': a.id, disabled: sent,
          onclick: () => pressAction(pid, a),
        }, sent ? [icon('check', 22), 'Sent'] : a.label);
      })),
    ]);

    // Players strip
    const players = arr(room?.players).map(obj).filter((p) => str(p.id));
    region(V.players, [players, pid], ([list, active]) => !list.length ? [] : [
      h('h2', { class: 'section-label', text: 'The Table' }),
      h('ul', { class: 'player-grid' }, list.map((p) =>
        h('li', { class: `pl${p.id === active ? ' me' : ''}${p.online === false ? ' off' : ''}`, 'data-pl': p.id },
          h('div', { class: 'pl-name', text: str(p.name) || '?' }),
          h('div', { class: 'pl-nums' },
            h('span', { class: 'pl-owe', text: `Owe ${num(p.owe, 0)}` }),
            h('span', { class: 'pl-bank', text: `Bank ${num(p.bank, 0)}` })),
          arr(p.badges).length > 0 && h('div', { class: 'pl-badges' }, arr(p.badges).map((b) => h('span', { class: 'pill', text: str(b) })))))),
    ]);
    V.players.hidden = !players.length;

    // Ticker (newest first)
    const ticker = arr(room?.ticker).map(str).filter(Boolean).slice(-6).reverse();
    region(V.ticker, ticker, (lines) => !lines.length ? [] : [
      h('h2', { class: 'section-label', text: 'Just happened' }),
      h('ul', { class: 'ticker-list' }, lines.map((t) => h('li', { text: t }))),
    ]);
    V.ticker.hidden = !ticker.length;

    region(V.foot, [S.sessions.length, covered], ([, cov]) => cov ? [] : [
      h('button', { class: 'btn ghost small', 'data-testid': 'add-player', onclick: () => { S.addingPlayer = true; S.joinMode = 'pick'; S.joining = null; render(); } }, icon('userPlus'), 'Someone sharing this phone'),
      h('button', { class: 'btn ghost small danger-text', 'data-testid': 'leave', onclick: confirmLeave }, icon('exit'), 'Leave game'),
    ]);
  },

  wrapped() {
    const recs = Object.entries(S.wrapped).filter(([, r]) => r && r.wrapped);
    const now = Date.now();
    const data = [recs.map(([id, r]) => [id, r.receivedAt, r.localShowAt != null && now >= r.localShowAt]), S.sessions.length, S.room?.phase || null];
    region(V.root, data, () => [
      h('header', { class: 'top' }, brand()),
      ...recs.map(([, r]) => wrappedCard(r, r.localShowAt != null && now >= r.localShowAt ? 'morning' : 'tonight', recs.length > 1)),
      S.sessions.length > 0 && h('button', {
        class: 'btn ghost big', 'data-testid': 'back-to-game',
        text: S.room && S.room.phase !== 'ended' ? 'The game is still on — back to the Table' : 'Back to the game',
        onclick: () => { S.showWrappedLanding = false; S.cover = S.sessions.length > 1; render(); },
      }),
    ]);
  },
};

function openCount(pid) {
  const map = S.prompts[pid];
  if (!map) return 0;
  let n = 0;
  for (const e of map.values()) if (e.answered === undefined && !isExpired(e.p)) n++;
  return n;
}

// ---------- the big card ----------

function currentSpotlight(room, pid, priv) {
  if (!pid || S.cover) return null;
  const card = room && room.card ? obj(room.card) : null;
  const ps = priv && priv.spotlight ? obj(priv.spotlight) : null;
  const targeted = !!card && arr(card.targets).includes(pid);
  if (!targeted && !(ps && str(ps.text))) return null;
  return {
    text: (ps && str(ps.text)) || 'This card is for YOU',
    key: `${pid}|${targeted ? str(card.id) : ''}|${ps ? str(ps.text) : ''}`,
  };
}

function renderCard(room, pid, priv, covered) {
  const card = room && room.card ? obj(room.card) : null;
  const spot = currentSpotlight(room, pid, priv);

  // Flash + buzz once per new spotlight.
  if (spot && spot.key !== S.flashedKey) {
    S.flashedKey = spot.key;
    flash(safeColor(card?.accent, DEFAULT_ACCENT));
    buzz([250, 80, 250]);
  }

  const data = {
    has: !!room, stale: S.stale, phase: str(room?.phase), leader: str(room?.leaderName),
    ended: room?.phase === 'ended', hasRecap: !!S.wrapped[pid],
    card: card && {
      id: str(card.id), kind: str(card.kind), title: str(card.title), text: str(card.text),
      level: num(card.level), accent: safeColor(card.accent, DEFAULT_ACCENT),
      tax: num(card.chickenTax), endsAt: num(obj(card.timer).endsAt),
    },
    spot: spot && spot.text, name: spot ? sessionName(activeSession()) : '', covered,
  };
  region(V.card, data, (d) => {
    if (!d.has) return waitingBlock(true);
    if (!d.card) {
      return h('div', { class: 'card idle' },
        h('div', { class: 'card-band' }, h('span', { class: 'card-kind', text: PHASES[d.phase] || titleCase(d.phase) || 'Last Call' })),
        h('div', { class: 'card-idle-body' },
          h('p', { class: 'card-text', text: d.ended ? "That's a wrap. Thanks for playing!" : 'Eyes on the Table.' }),
          d.ended && d.hasRecap && h('button', { class: 'btn primary', text: 'See your recap', onclick: () => { S.recap = pid; render(); } }),
          !d.ended && d.leader && h('p', { class: 'card-sub', text: `${d.leader} is running the game.` })));
    }
    const c = d.card;
    const len = c.text.length;
    return [
      // "You're up" sticker: only on the targeted player's phone. The leader's own line goes under it.
      d.spot && h('div', { class: 'spot', 'data-testid': 'spotlight' },
        h('span', { class: 'spot-head', text: `You're up, ${d.name}!` }),
        h('span', { class: 'spot-text', text: d.spot })),
      h('article', {
        class: `card${d.spot ? ' is-target' : ''}`, style: { '--accent': c.accent }, 'data-card': c.id,
      },
      // Colored type band (ink text on every band color), then the card text, then the footer.
      h('div', { class: 'card-band' },
        h('span', { class: 'card-kind', text: c.title || titleCase(c.kind) || 'Card' }),
        c.level != null && levelPips(c.level)),
      h('p', { class: `card-text${len > 220 ? ' xlong' : len > 120 ? ' long' : ''}`, text: c.text }),
      (c.tax != null || c.endsAt != null) && h('div', { class: 'card-foot' },
        c.tax != null && h('div', { class: 'tax-row' },
          h('span', { class: 'tax-label', text: 'Chicken out?' }),
          h('span', { class: 'tax', 'data-testid': 'chicken-tax', text: `${c.tax} sip${c.tax === 1 ? '' : 's'}` })),
        c.endsAt != null && h('span', { class: 'timer', 'data-testid': 'card-timer', 'data-ends-at': String(c.endsAt), 'aria-label': 'seconds left' }))),
    ];
  });
}

/** "LVL 3" plus five pips, filled in ink up to the level (clamped to 0–5). */
function levelPips(level) {
  const n = Math.max(0, Math.min(5, Math.round(level)));
  return h('span', { class: 'card-level' },
    h('span', { class: 'card-level-n', 'aria-hidden': 'true', text: `LVL ${n}` }),
    h('span', { class: 'dots', role: 'img', 'aria-label': `Level ${n} of 5`, 'data-level': String(n) },
      [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= n ? 'on' : '' }))));
}

function flash(color) {
  if (reducedMotion()) return;
  const el = layers.flash;
  el.style.setProperty('--flash', color);
  el.classList.remove('go');
  void el.offsetWidth; // restart the animation
  el.classList.add('go');
}

// ---------- private sections ----------

function renderSection(pid, s, peeked) {
  const style = SECTION_STYLES.includes(s.style) ? s.style : 'normal';
  const key = `${pid}:${s.id}`;
  const toggle = () => {
    if (S.peek[key] > Date.now()) delete S.peek[key];
    else S.peek[key] = Date.now() + PEEK_MS;
    render();
  };
  const hidden = s.hidden === true;
  if (hidden && !peeked) {
    // Privacy screen: even the title stays hidden (it can say "Your role: The Snake").
    return h('button', { class: 'sec covered', 'data-section': str(s.id), onclick: toggle },
      icon('eye', 30),
      h('span', { class: 'peek-text', text: 'Tap to peek' }),
      h('span', { class: 'peek-sub', text: "Make sure nobody's looking" }));
  }
  // Hidden (peeking) and `secret` sections get the black "private look". When peeking, the
  // content sits on its own sticker card inside it (pink for missions).
  const privateLook = hidden || style === 'secret';
  return h('div', {
    class: `sec sec-${style}${hidden ? ' peeking' : ''}`, 'data-section': str(s.id),
    onclick: hidden ? toggle : null,
  },
  privateLook && h('div', { class: 'priv-head' },
    h('span', { class: 'priv-note' }, icon('eyeOff', 18), 'Only you can see this'),
    // No handler of its own: the tap bubbles up to the section's toggle, which re-covers it.
    hidden && h('button', { class: 'btn hide', type: 'button', text: 'Hide' })),
  str(s.title) && h('h3', { class: 'sec-title', text: s.title }),
  h('div', { class: 'sec-body' }, arr(s.lines).map(str).filter(Boolean).map((l) => h('p', { class: 'sec-line', text: l }))),
  hidden && h('div', { class: 'peek-hint', text: 'Hides itself in 5 s' }));
}

// ---------- banner (interrupts) ----------

function renderBanner(view) {
  const b = view === 'game' && S.room && S.room.banner ? obj(S.room.banner) : null;
  const key = b ? JSON.stringify([b.style, b.title, b.text]) : null;
  if (key !== S.bannerKey) {
    S.bannerKey = key;
    S.bannerMin = false;
    if (b && b.buzz === true) {
      buzz([400, 120, 400]);
      flash(b.style === 'alert' ? '#ff5a36' : b.style === 'info' ? '#7fd1ff' : '#ffd23f');
    }
  }
  const style = b && BANNER_STYLES.includes(b.style) ? b.style : 'info';
  region(layers.banner, b && [style, str(b.title), str(b.text), S.bannerMin], (d) => {
    if (!d) return [];
    const [st, title, text, min] = d;
    if (min) {
      return h('button', { class: `banner-strip b-${st}`, onclick: () => { S.bannerMin = false; render(); } },
        h('b', { text: title || 'Heads up' }), text && h('span', { text }));
    }
    // Full-screen takeover: chip, tilted title sticker, the one-line rule, one huge button.
    return h('div', { class: `banner b-${st}`, role: 'alert', 'data-testid': 'banner' },
      h('div', { class: 'banner-top' },
        h('span', { class: 'banner-chip', text: BANNER_CHIPS[st] }),
        h('span', { class: 'banner-brand', 'aria-hidden': 'true', text: 'LAST CALL' })),
      title && h('div', { class: 'banner-sticker' },
        h('div', { class: 'banner-title', style: { '--fit': String(longestWord(title)) }, text: title })),
      text && h('div', { class: 'banner-text', text }),
      h('button', { class: 'btn ghost', text: 'Got it', onclick: () => { S.bannerMin = true; render(); } }));
  });
}

// ---------- prompts (bottom sheet) ----------

const promptEls = new Map(); // `${pid}:${id}` -> element (kept so typing survives re-renders)

function renderSheet(view) {
  const pid = S.activeId;
  const show = view === 'game' && !S.cover && pid;
  const entries = show ? [...(S.prompts[pid]?.values() || [])].sort((a, b) => b.receivedAt - a.receivedAt) : [];
  const results = show ? S.results.filter((r) => r.pid === pid) : [];

  let sheet = layers.sheet.firstElementChild;
  if (!sheet) {
    sheet = h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }),
      h('div', { class: 'sheet-results' }),
      h('div', { class: 'sheet-list' }));
    layers.sheet.append(sheet);
  }
  const [head, resultsEl, list] = sheet.children;
  sheet.hidden = !entries.length && !results.length;
  sheet.classList.toggle('min', S.sheetMin && entries.length > 0);

  const open = entries.filter((e) => e.answered === undefined && !isExpired(e.p)).length;
  region(head, [entries.length, open, S.sheetMin], ([n, o, min]) => n === 0 ? [] : [
    h('span', { class: 'sheet-title', text: o > 0 ? `Your move${o > 1 ? ` · ${o}` : ''}` : 'Sent' }),
    h('button', { class: 'btn ghost small', text: min ? 'Show' : 'Hide', onclick: () => { S.sheetMin = !S.sheetMin; render(); } }),
  ]);
  region(resultsEl, results.map((r) => [r.title, r.text]), (rs) =>
    rs.map(([title, text]) => h('div', { class: 'result', 'data-testid': 'prompt-result' },
      title && h('div', { class: 'result-title', text: title }), h('div', { class: 'result-text', text }))));

  // Keyed reconciliation: reuse existing elements; never detach the one being typed in.
  const wanted = new Set();
  entries.forEach((e, i) => {
    const key = `${pid}:${e.p.id}`;
    wanted.add(key);
    const sig = JSON.stringify([e.p, e.answered, e.label]);
    let el = promptEls.get(key);
    if (!el || el._sig !== sig) {
      const fresh = buildPrompt(pid, e);
      fresh._sig = sig;
      if (el) el.replaceWith(fresh);
      el = fresh;
      promptEls.set(key, el);
    }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  for (const [key, el] of promptEls) {
    if (!wanted.has(key)) {
      el.remove();
      promptEls.delete(key);
    }
  }
}

function buildPrompt(pid, entry) {
  const p = entry.p;
  const kind = str(p.kind);
  const answered = entry.answered !== undefined;
  const fs = h('fieldset', { disabled: answered });
  const el = h('section', {
    class: `prompt k-${kind || 'unknown'}${answered ? ' answered' : ''}`, 'data-prompt': p.id, 'data-kind': kind,
  },
  h('div', { class: 'p-head' },
    h('h3', { class: 'p-title', text: str(p.title) || 'Quick question' }),
    num(p.endsAt) != null && h('span', { class: 'p-timer', 'data-ends-at': String(p.endsAt) })),
  str(p.text) && h('p', { class: 'p-text', text: p.text }),
  p.anonymous === true && h('div', { class: 'pill anon', text: 'Anonymous' }),
  fs,
  h('div', { class: 'p-state', text: answered ? `Sent: ${entry.label}` : '' }));
  if (num(p.endsAt) != null) el.dataset.expires = String(p.endsAt);

  const send = (value, label) => answer(pid, p.id, value, label);

  if (kind === 'choose' || kind === 'vote') {
    const opts = arr(p.options).map(obj).filter((o) => str(o.id));
    fs.append(h('div', { class: `options${opts.length > 4 ? ' many' : ''}` }, opts.map((o) =>
      h('button', {
        class: `btn opt${answered && entry.answered === o.id ? ' picked' : ''}`, 'data-option': o.id,
        text: str(o.label) || o.id, onclick: () => send(o.id, str(o.label) || o.id),
      }))));
  } else if (kind === 'tap') {
    const arm = num(p.armAt);
    if (answered) {
      el.classList.add('armed');
      fs.append(h('div', { class: 'tap-zone' }, h('div', { class: 'tap-done', text: 'Tapped!' })));
    } else {
      fs.append(h('div', { class: 'tap-zone' },
        h('div', { class: 'tap-wait' },
          h('span', { text: 'Get ready…' }),
          arm != null && h('b', { 'data-ends-at': String(arm) }))));
    }
    el.dataset.armAt = String(arm ?? 0);
  } else if (kind === 'number') {
    let min = num(p.min, 0);
    let max = num(p.max, min + 10);
    if (max < min) [min, max] = [max, min];
    const step = num(p.step, 1) > 0 ? p.step : 1;
    const clamp = (v) => Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min));
    let value = answered && typeof entry.answered === 'number' ? entry.answered : clamp(num(p.default, min));
    const out = h('output', { class: 'num-val', text: String(value) });
    const set = (v) => {
      value = clamp(v);
      out.textContent = String(value);
      minus.disabled = value <= min;
      plus.disabled = value >= max;
    };
    const minus = h('button', { class: 'btn step', 'aria-label': 'less', text: '−', onclick: () => set(value - step) });
    const plus = h('button', { class: 'btn step', 'aria-label': 'more', text: '+', onclick: () => set(value + step) });
    fs.append(h('div', { class: 'stepper' }, minus, out, plus),
      h('button', { class: 'btn primary big', 'data-testid': 'send-number', text: 'Send', onclick: () => send(value, String(value)) }));
    set(value);
    if (answered) minus.disabled = plus.disabled = true;
  } else if (kind === 'text') {
    const maxLength = Math.max(1, Math.min(2000, num(p.maxLength, 280)));
    const ta = h('textarea', {
      class: 'text-in', rows: 3, maxlength: maxLength, placeholder: str(p.placeholder) || 'Type it out…',
      autocomplete: 'off', 'aria-label': str(p.title) || 'Your answer',
    });
    if (answered) ta.value = String(entry.answered);
    const count = h('span', { class: 'count', text: `${ta.value.length}/${maxLength}` });
    const go = h('button', { class: 'btn primary', 'data-testid': 'send-text', text: 'Send', disabled: !ta.value.trim() });
    const refresh = () => {
      count.textContent = `${ta.value.length}/${maxLength}`;
      go.disabled = !ta.value.trim();
    };
    // No pasting, no dropping: you type every word yourself (his design).
    const block = (e) => {
      e.preventDefault();
      toast('No pasting — type it yourself.');
    };
    ta.addEventListener('paste', block);
    ta.addEventListener('drop', block);
    ta.addEventListener('dragover', (e) => e.preventDefault());
    ta.addEventListener('beforeinput', (e) => {
      if (/^insertFrom(Paste|Drop|PasteAsQuotation|Yank)/.test(e.inputType || '')) block(e);
    });
    ta.addEventListener('input', refresh);
    go.addEventListener('click', () => ta.value.trim() && send(ta.value.trim(), ta.value.trim()));
    fs.append(ta, h('div', { class: 'text-row' }, count, go));
  } else {
    fs.append(h('p', { class: 'dim', text: 'Look at the Table for this one.' }));
  }
  return el;
}

function armTap(el) {
  el.classList.add('armed');
  const zone = el.querySelector('.tap-zone');
  if (!zone) return;
  const pid = S.activeId;
  const id = el.dataset.prompt;
  zone.replaceChildren(h('button', {
    class: 'btn tap', 'data-testid': 'tap', text: 'TAP!',
    onpointerdown: (e) => { e.preventDefault(); answer(pid, id, 'tap', 'TAP'); },
    onclick: () => answer(pid, id, 'tap', 'TAP'),
  }));
  buzz(120);
}

// ---------- wrapped ----------

function wrappedCard(rec, mode, showName) {
  const w = obj(rec.wrapped);
  const stats = arr(w.stats).map(obj).filter((s) => str(s.label));
  return h('article', { class: `wrapped ${mode}`, 'data-testid': `wrapped-${mode}` },
    h('div', { class: 'wr-kicker', text: mode === 'morning' ? 'Morning-After Wrapped' : "Tonight's recap" }),
    h('h2', { class: 'wr-title', text: str(w.title) || 'Your night' }),
    showName && rec.name && h('div', { class: 'wr-name', text: rec.name }),
    stats.length > 0 && h('div', { class: 'wr-stats' }, stats.map((s) =>
      h('div', { class: 'wr-stat' }, h('span', { text: s.label }), h('b', { text: str(s.value) })))),
    arr(w.lines).map(str).filter(Boolean).map((l) => h('p', { class: 'wr-line', text: l })),
    mode === 'tonight' && rec.localShowAt != null && Date.now() < rec.localShowAt &&
      h('p', { class: 'wr-note', text: `Your Morning-After Wrapped unlocks ${sameDay(rec.localShowAt) ? 'at' : 'tomorrow at'} ${fmtClockTime(rec.localShowAt)}. Open this page again then.` }));
}

const sameDay = (ms) => new Date(ms).toDateString() === new Date().toDateString();

function renderRecap(view) {
  const rec = view === 'game' && !S.cover && S.recap && S.wrapped[S.recap];
  region(layers.recap, rec ? [S.recap, rec.receivedAt] : null, () => rec && h('div', { class: 'overlay recap' },
    wrappedCard(rec, 'tonight', false),
    h('button', { class: 'btn primary big', text: 'Close', onclick: () => { S.recap = null; render(); } })));
}

// ---------- pass-the-phone cover ----------

function renderCover(view) {
  const s = view === 'game' && S.cover ? activeSession() : null;
  const name = s ? sessionName(s) : '';
  region(layers.cover, s ? [s.playerId, name] : null, () => s && h('div', { class: 'cover', 'data-testid': 'pass-cover' },
    brand(),
    h('div', { class: 'cover-title' }, h('span', { text: 'Pass to' }), h('b', { style: { '--fit': String(longestWord(name)) }, text: name })),
    h('p', { class: 'cover-sub' }, icon('eyeOff', 22), 'Everyone else look away.'),
    h('button', { class: 'btn primary big', 'data-testid': 'reveal', text: `I'm ${name} — show me`, onclick: uncover })));
}

// ---------- modal ----------

function renderModal() {
  const m = S.modal;
  region(layers.modal, m ? m.id : null, () => m && h('div', { class: 'overlay modal-back', onclick: (e) => { if (e.target === e.currentTarget) { S.modal = null; render(); } } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'data-testid': 'confirm' },
      m.title && h('h2', { class: 'modal-title', text: m.title }),
      m.text && h('p', { class: 'modal-text', text: m.text }),
      h('div', { class: 'modal-buttons' }, m.buttons.map((b) => h('button', {
        class: `btn ${b.style || 'normal'}`, text: b.label,
        onclick: () => { S.modal = null; render(); if (b.run) b.run(); },
      }))))));
}

boot();

// For tests and debugging only: a read-only peek at state.
if (new URLSearchParams(location.search).get('transport') === 'local') {
  window.__lastCall = { state: S, clock };
}
