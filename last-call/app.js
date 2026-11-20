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
  h, region, obj, arr, str, num, safeColor, titleCase, fmtCountdown, fmtClockTime, buzz, reducedMotion, icon, longestWord, plural,
  drinkAmount, drinkAmountShort,
} from './ui.js';
import { chime, unlockAudio, setChimeEnabled, holdScreenAwake } from './attention.js';

// ============================================================================
// 1. State
// ============================================================================

const ROOM_STALE_MS = 15000; // no `room` for this long -> "Waiting for the Table…"
const PING_EVERY_MS = 5000; // ...and ping this often while waiting
const PEEK_MS = 5000; // hidden sections re-cover after this
const RESULT_MS = 4500; // how long a prompt_close result stays up
const TAP_LOCK_MS = 1000; // after a new card, its buttons ignore taps this long (a double tap can't hit them)
const EXPIRED_KEEP_MS = 4000; // a timed-out prompt whose close never arrived goes away after this
const HELLO_REPLY_MS = 10000; // the leader's reply to a `hello` has to start within this...
const RESYNC_WINDOW_MS = 1500; // ...and its re-sent prompts arrive within this of each other
const JOIN_HINT_MS = 60000; // "Still waiting?" + "Ask again" after a minute
// The leader's phone quietly drops join requests nobody answered after 5 minutes
// (LastCallHost.tidyUp), and sends no message when it does. So at 5 minutes we say so.
const JOIN_EXPIRE_MS = 5 * 60000;
// Presence (11/19 audit A12): while this page is on screen it tells the leader "still here"
// every 15 s with a `hello` marked `beat: true` (no reply expected). A phone that goes quiet
// for 45 s counts as away on the leader's side: votes stop waiting for it, Quick Draw won't
// charge it.
const BEAT_MS = 15000;

// Thumb Master is a secret: only the holder gets the hidden "thumb" section. A black box on
// one phone only gives the holder away across the table, so while the power is live EVERY
// phone shows the same covered box: during the Thumb Master card, and after it for as long as
// the room says `thumbLive` (up to 20 cards, until it's used). Peeking on anyone else's says
// "Not you this time".
const THUMB_SECTION = 'thumb';
const isThumbMasterCard = (card) => !!card && str(card.kind) === 'classic' && str(card.title) === 'THUMB MASTER';
const thumbPowerLive = (room) => !!room && (room.thumbLive === true || isThumbMasterCard(room.card));
const DECOY_THUMB = {
  id: THUMB_SECTION, hidden: true, style: 'secret', decoy: true, title: 'Not you this time',
  lines: ['Someone else is the Thumb Master.', 'When a thumb goes down on the table, copy it fast.', 'The last one to copy drinks.'],
};

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
  lastBeatAt: 0, // the last presence beat (or real hello) we sent
  stale: false,
  priv: {}, // playerId -> `private` body
  prompts: {}, // playerId -> Map(promptId -> { p, answered, label, receivedAt })
  results: [], // [{ pid, title, text, until }]
  pressed: {}, // `${pid}:${actionId}` -> until (brief "Sent" state)
  // { name, claimPlayerId, move, status, error, tries: [{ requestId, keyPair }], sentAt, hint }
  // status: waiting | opening | denied | expired | error. Every "Ask again" adds a try.
  joining: null,
  joinMode: 'pick', // 'pick' (who are you?) | 'new' (type a name)
  showMoving: false, // the "Already playing? Moving phones" list is open
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
  bannerFresh: false, // a new banner arrived: buzz/flash it once
  flashedKey: null,
  sheetMin: false,
  cardId: null, // the card on the table (to notice a new one)
  lockUntil: 0, // until then, action and vote buttons are locked (a new card just landed)
  resync: {}, // playerId -> { helloAt, start, until, keep: Set } while matching a hello's reply
  chan: {}, // channel name -> its last transport status ('SUBSCRIBED', 'CHANNEL_ERROR'…)
  chime: store.getChime(), // "Chime when it's my turn"
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
  // or shared by accident. A per-player link (#…&s=) is that player's key. The plain room
  // link (#r=) stays wiped too: picking a name the leader added gets in WITHOUT the leader
  // tapping anything (LastCallHost.canAutoApprove), so a forwarded link could claim one.
  const frag = parseFragment(location.hash);
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);

  store.prune();
  setChimeEnabled(S.chime);

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
  // Our own Wi-Fi/signal: the error bar says whose connection it is.
  window.addEventListener('offline', () => render());
  window.addEventListener('online', () => {
    resync();
    render();
  });

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
  S.lastBeatAt = Date.now(); // each private channel says hello as it subscribes
  subscribe(roomChannel(S.roomId), onRoomMessage, (status) => {
    if (status === 'SUBSCRIBED') ping();
  });
  for (const s of S.sessions) subscribePrivate(s);
}

/** Phone woke up / tab came back: ask for everything again (cheap, and sockets drop when locked). */
function resync() {
  if (!S.roomId || !subs.size) return;
  ping();
  S.lastBeatAt = Date.now(); // the hellos below count as this round's beat
  for (const s of S.sessions) sendHello(s.secret);
}

// ============================================================================
// 3. Messaging
// ============================================================================

function subscribe(name, onMessage, onStatus) {
  if (subs.has(name) || !transport) return;
  // Remember each channel's last status, so the error bar can tell OUR dropped connection
  // apart from a quiet Table.
  const tracked = (status) => {
    const wasDown = ownConnectionDown();
    S.chan[name] = status;
    if (onStatus) onStatus(status);
    if (ownConnectionDown() !== wasDown) render();
  };
  subs.set(name, transport.subscribe(name, onMessage, tracked));
}

function unsubscribe(name) {
  const off = subs.get(name);
  if (off) off();
  subs.delete(name);
  delete S.chan[name];
  seqs.forget(name);
  mySeq.delete(name);
}

const isOffline = () => navigator.onLine === false;

/** This phone's own connection is down (no network, or one of our channels failed). */
function ownConnectionDown() {
  if (isOffline()) return true;
  return Object.values(S.chan).some((st) => st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED');
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
  // The leader answers a hello with `private`, then every prompt it is still waiting on this
  // player for. Note when we asked, so that reply can be matched (see noteHelloReply).
  const s = S.sessions.find((x) => x.secret === secret);
  if (s) S.resync[s.playerId] = { helloAt: Date.now(), start: 0, until: 0, keep: new Set() };
  sendPrivate(secret, 'hello', { lastSeq: seqs.lastSeq(privateChannel(secret)) });
}

/**
 * The presence beat: "this phone is still here" on every player's private channel. It's a
 * `hello` marked `beat: true`, which the leader answers with nothing (no resync is started).
 */
function sendBeats() {
  S.lastBeatAt = Date.now();
  for (const s of S.sessions) {
    sendPrivate(s.secret, 'hello', { lastSeq: seqs.lastSeq(privateChannel(s.secret)), beat: true });
  }
}

const pageVisible = () => document.visibilityState !== 'hidden';
const nightOver = () => S.room?.phase === 'ended';

function onRoomMessage(env) {
  if (!isEnvelope(env) || env.from !== 'leader') return; // other guests' join/ping, junk
  clock.sample(env.at);
  const gap = seqs.check(roomChannel(S.roomId), env.seq);
  // `room` is a full replace, so a missed one doesn't matter — but if we skipped ahead on
  // something else, ask for a fresh room.
  if ((gap === 'gap' || gap === 'reset') && env.t !== 'room') ping();
  // Lost room messages, or a long silence, mean the Table's phone (or ours) dropped out for
  // a while, and an answer we sent then may never have arrived. Say hello again: the leader
  // re-sends every prompt it's still waiting on us for, and addPrompt re-sends the answer.
  const cameBack = S.stale || gap === 'gap' || gap === 'reset';

  const body = obj(env.body);
  switch (env.t) {
    case 'room': {
      const prev = S.room;
      S.room = body;
      S.lastRoomAt = Date.now();
      S.stale = false;
      // Fill in names we only knew by id (per-player links).
      for (const s of S.sessions) if (!s.name) s.name = playerName(s.playerId);
      onRoomChanged(prev, body);
      if (cameBack && prev) for (const s of S.sessions) sendHello(s.secret);
      break;
    }
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
    case 'private': {
      // New buttons where the old ones were (the card was settled and the next one dealt):
      // lock them a moment so the second half of a double tap can't press one.
      const before = actionIds(S.priv[pid]);
      const after = actionIds(body);
      if (before.length && after.length && before.join('|') !== after.join('|')) lockTaps();
      S.priv[pid] = body;
      noteHelloReply(pid, 'private');
      if (str(body.name) && body.name !== session.name) {
        session.name = body.name;
        store.saveSessions(S.roomId, S.sessions);
      }
      break;
    }
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

const actionIds = (priv) => arr(obj(priv).actions).map((a) => str(obj(a).id)).filter(Boolean);

function addPrompt(pid, p) {
  if (!str(p.id)) return;
  const map = S.prompts[pid] || (S.prompts[pid] = new Map());
  const prev = map.get(p.id);
  // A re-send (after hello) keeps what we already answered and its place in the stack.
  map.set(p.id, { p, answered: prev?.answered, option: prev?.option, label: prev?.label, receivedAt: prev?.receivedAt || Date.now() });
  noteHelloReply(pid, 'prompt', p.id);
  if (!prev) {
    S.sheetMin = false;
    if (pid === S.activeId && !S.cover) buzz(80);
    // A new question for someone on this phone. (Quick Draw chimes when its button appears.)
    if (str(p.kind) !== 'tap' && !isExpired(p)) chime();
  } else if (prev.answered !== undefined && !isExpired(p)) {
    // The leader only re-sends a prompt it is STILL waiting on us for, so the answer we sent
    // never arrived (it went out while the Table's phone was reconnecting). Send it again.
    // A copy that does arrive twice is harmless: the leader keeps the first answer only.
    const session = S.sessions.find((s) => s.playerId === pid);
    const body = prev.option ? { promptId: p.id, value: prev.answered, option: prev.option } : { promptId: p.id, value: prev.answered };
    if (session) sendPrivate(session.secret, 'answer', body);
  }
}

/**
 * Matching the reply to a `hello`. The reply is `private` followed by every prompt the leader
 * still has open for this player. So once it's in, any prompt we show that the leader did NOT
 * re-send is stale: we missed its prompt_close (the phone was locked, the socket dropped).
 * tick() drops those when the reply has gone quiet (finishResync).
 */
function noteHelloReply(pid, kind, promptId) {
  const rs = S.resync[pid];
  if (!rs) return;
  const now = Date.now();
  if (!rs.start) {
    // The reply starts with `private`. A prompt before it belongs to something else.
    if (kind !== 'private' || now - rs.helloAt > HELLO_REPLY_MS) return;
    rs.start = now;
  }
  if (now > rs.until && rs.until) return; // the window already closed (tick will finish it)
  if (promptId) rs.keep.add(promptId);
  rs.until = now + RESYNC_WINDOW_MS;
}

/** The hello's reply has gone quiet: drop the prompts it didn't include. */
function finishResync(pid) {
  const rs = S.resync[pid];
  delete S.resync[pid];
  const map = S.prompts[pid];
  if (!rs || !map) return false;
  let dropped = false;
  for (const [id, e] of map) {
    if (rs.keep.has(id) || e.receivedAt >= rs.start) continue;
    // An answered prompt with time left isn't re-sent (the leader has our answer) but may
    // still be waiting on others: keep it until it closes or times out.
    if (e.answered !== undefined && num(e.p.endsAt) != null && !isExpired(e.p)) continue;
    map.delete(id);
    dropped = true;
  }
  return dropped;
}

/** A new card (or new buttons) just landed: ignore taps on its buttons for a moment. */
function lockTaps() {
  S.lockUntil = Date.now() + TAP_LOCK_MS;
}

const cardTimerEnds = (card) => num(obj(obj(card).timer).endsAt);
const cardTimerRunning = (card) => {
  const ends = cardTimerEnds(card);
  return ends != null && ends > clock.leaderNow();
};

/**
 * What changed between two `room` states. A new card: lock its buttons, scroll to the top,
 * chime if it names someone on this phone. A new banner: full-screen takeover or strip.
 */
function onRoomChanged(prev, room) {
  const card = room.card ? obj(room.card) : null;
  const cardId = card ? str(card.id) : null;
  const newCard = !!prev && cardId !== S.cardId; // the first room after loading isn't "new"
  S.cardId = cardId;
  if (newCard) {
    lockTaps();
    if (currentView() === 'game' && !S.cover) window.scrollTo(0, 0);
    const targets = arr(card?.targets);
    if (S.sessions.some((s) => targets.includes(s.playerId))) chime(); // {A}/{B}/{C} is on this phone
  }

  const b = room.banner ? obj(room.banner) : null;
  const key = b ? JSON.stringify([b.style, b.title, b.text]) : null;
  if (key !== S.bannerKey) {
    S.bannerKey = key;
    S.bannerFresh = !!b;
    // A quiet banner that rides in with a new card (SPEED ROUND, DOUBLE TIME, LAST CALL each
    // card) or lands on a running clock is a reminder, not news: start it as the small strip
    // at the top. Its takeover already played (with a buzz) when it began, and covering the
    // card again would hide the card's countdown.
    S.bannerMin = !!b && b.buzz !== true && ((newCard && !!card) || cardTimerRunning(card));
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

/**
 * Join as `name`. `claimPlayerId` = a player on the list (their name button). With
 * `move: true` it's someone already playing who is moving to this phone: the same `join`
 * message, and the leader's "Let in" moves them here and locks their old phone out.
 */
async function startJoin(name, claimPlayerId, opts = {}) {
  name = str(name).trim().slice(0, 32);
  if (!name || (S.joining && (S.joining.status === 'waiting' || S.joining.status === 'opening'))) return;
  unlockAudio(); // this tap is what lets the page chime later on iPhones
  S.joining = {
    name, claimPlayerId: claimPlayerId || null, move: !!opts.move,
    status: 'waiting', error: null, tries: [], sentAt: Date.now(), hint: false,
  };
  render(); // "Asking the Table…" right away, so a second tap can't send a second request
  await sendJoinRequest(S.joining);
  render();
}

/**
 * Sends the join request (again, for "Ask again"). Each try gets its own key pair and
 * requestId; the leader keeps only the newest request from the same person. A late
 * join_ok for an earlier try still works, because we keep every try's key.
 */
async function sendJoinRequest(j) {
  try {
    const keyPair = await generateJoinKeyPair();
    const pub = await exportPublicKey(keyPair.publicKey);
    if (S.joining !== j) return; // cancelled meanwhile
    const requestId = randomId(9); // 12 base64url chars
    j.tries.push({ requestId, keyPair });
    Object.assign(j, { status: 'waiting', error: null, sentAt: Date.now(), hint: false });
    const body = { requestId, name: j.name, pub };
    if (j.claimPlayerId) body.claimPlayerId = j.claimPlayerId;
    sendRoom('join', body);
  } catch (err) {
    console.error(err);
    if (S.joining === j) Object.assign(j, { status: 'error', error: "This browser can't do the secure join. Try Safari or Chrome." });
  }
}

function askAgain() {
  const j = S.joining;
  if (!j || j.status === 'opening') return;
  sendJoinRequest(j).then(render);
}

function cancelJoin() {
  S.joining = null;
  render();
}

/** One tap claimed a name before, so a prank stole "Kim". Now: "You're Kim? Yes / Not me". */
function confirmName(playerId, name) {
  openModal({
    title: `You're ${name}?`,
    buttons: [
      { label: 'Not me', style: 'ghost' },
      { label: 'Yes', style: 'primary', run: () => startJoin(name, playerId) },
    ],
  });
}

/** "Already playing? Moving phones": take over a player who's already in the game. */
function confirmMove(playerId, name) {
  const leader = str(S.room?.leaderName) || 'The leader';
  openModal({
    title: `Move ${name} to this phone?`,
    text: `${leader} gets asked on their phone. Once they say yes, ${name}'s old phone stops working. Owe and Bank come with you.`,
    buttons: [
      { label: 'Cancel', style: 'ghost' },
      { label: 'Move me', style: 'primary', run: () => startJoin(name, playerId, { move: true }) },
    ],
  });
}

function toggleChime() {
  S.chime = !S.chime;
  store.setChime(S.chime);
  setChimeEnabled(S.chime);
  if (S.chime) {
    unlockAudio(); // this tap unlocks sound on iPhones...
    chime(); // ...and they hear what it sounds like
  }
  render();
}

async function onJoinOk(body) {
  const j = S.joining;
  const attempt = j && j.tries.find((t) => t.requestId === body.requestId);
  if (!attempt || j.status === 'opening') return; // someone else's (or already opening ours)
  j.status = 'opening';
  try {
    const { secret, playerId } = await openJoinReply(attempt.keyPair.privateKey, body, attempt.requestId);
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
  if (!j || j.status === 'opening' || !j.tries.some((t) => t.requestId === body.requestId)) return;
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

/**
 * Answer a prompt. `option`: which send button on a text prompt with options (e.g. "Save it" /
 * "Save: needs a photo"); it rides along as `option` in the answer.
 */
function answer(pid, promptId, value, label, option) {
  const entry = S.prompts[pid]?.get(promptId);
  const session = S.sessions.find((s) => s.playerId === pid);
  if (!entry || !session || entry.answered !== undefined || isExpired(entry.p)) return;
  if (isLockable(entry.p) && tapsLocked()) return; // a new card just landed (double-tap guard)
  entry.answered = value;
  entry.option = option;
  entry.label = label ?? String(value);
  sendPrivate(session.secret, 'answer', option ? { promptId, value, option } : { promptId, value });
  render();
}

// Option buttons that a stray second tap could hit. Never Quick Draw's TAP (a race) or a
// text box (you can't type by accident).
const isLockable = (p) => ['choose', 'vote', 'number'].includes(str(p.kind));
const tapsLocked = () => Date.now() < S.lockUntil;

function pressAction(pid, action) {
  const session = S.sessions.find((s) => s.playerId === pid);
  if (!session || tapsLocked()) return;
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
    S.notice = 'You left the game. To jump back in, tap "Already playing? Moving phones" and pick your name.';
  }
  render();
}

function confirmLeave() {
  const s = activeSession();
  if (!s) return;
  openModal({
    title: 'Leave the game?',
    // The leader's phone sits them out (no cards, no votes, no interest) until they rejoin.
    text: `${s.name || 'You'} will sit out: no more cards until you come back. Your Owe and Bank wait for you.`,
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
    // Once the night has ended the Table closes its room: that silence is expected, so no
    // "Can't reach the Table" bar and no pinging (11/19 audit A20).
    const stale = !nightOver() && now - (S.lastRoomAt || S.enteredAt) > ROOM_STALE_MS;
    if (stale !== S.stale) {
      S.stale = stale;
      dirty = true;
    }
    if (stale && now - S.lastPingAt >= PING_EVERY_MS) ping();
    // Presence beat, only while this page is on screen (a pocketed phone goes quiet).
    if (S.sessions.length && !nightOver() && pageVisible() && now - S.lastBeatAt >= BEAT_MS) sendBeats();
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
  // The double-tap lock is over: unlock the buttons.
  if (S.lockUntil && now >= S.lockUntil) {
    S.lockUntil = 0;
    dirty = true;
  }
  // A prompt past its time whose prompt_close never reached us (phone locked, socket
  // dropped) would otherwise sit there forever. Give it a few seconds, then let it go.
  const leaderNow = clock.leaderNow();
  for (const map of Object.values(S.prompts)) {
    for (const [id, e] of map) {
      const ends = num(e.p.endsAt);
      if (ends == null) continue;
      if (leaderNow >= ends + EXPIRED_KEEP_MS) {
        map.delete(id);
        dirty = true;
      } else if (leaderNow >= ends && !e.ranOut) {
        e.ranOut = true; // just ran out: redraw once (the sheet title, the profile badges)
        dirty = true;
      }
    }
  }
  // A hello's reply has gone quiet (or never came): drop prompts the leader no longer has.
  for (const [pid, rs] of Object.entries(S.resync)) {
    if (rs.start && now > rs.until) {
      if (finishResync(pid)) dirty = true;
    } else if (!rs.start && now - rs.helloAt > HELLO_REPLY_MS) {
      delete S.resync[pid];
    }
  }
  // Join request: "Still waiting?" after a minute; after 5, the leader's phone has dropped it.
  const j = S.joining;
  if (j && j.status === 'waiting') {
    if (now - j.sentAt >= JOIN_EXPIRE_MS) {
      j.status = 'expired';
      dirty = true;
    } else if (!j.hint && now - j.sentAt >= JOIN_HINT_MS) {
      j.hint = true;
      dirty = true;
    }
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
  const locked = tapsLocked();
  for (const el of document.querySelectorAll('.prompt')) {
    if (el.dataset.expires) {
      const expired = now >= Number(el.dataset.expires);
      if (expired !== el.classList.contains('expired')) {
        el.classList.toggle('expired', expired);
        const note = el.querySelector('.p-state');
        if (note && expired && !el.classList.contains('answered')) note.textContent = "Time's up";
      }
    }
    // Answered, timed out, or a new card just landed (double-tap lock): no taps.
    const fs = el.querySelector('fieldset');
    const off = el.classList.contains('answered') || el.classList.contains('expired') || (locked && el.dataset.lockable === '1');
    if (fs && fs.disabled !== off) fs.disabled = off;
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
  // Keep the screen on while the night runs; let it sleep again at Wrapped / the end.
  holdScreenAwake(view === 'game' && !!S.room && S.room.phase !== 'ended');
  updateLive();
}

// ---------- shared bits ----------

const brand = () =>
  h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('glass', 18)), h('span', { text: 'LAST CALL' }));

/**
 * The spinner block. Before the first `room`: "Finding the Table…". After a long silence it
 * says whose connection it is: ours (no network, or our own channel failed) or the Table's.
 * `mine` is passed in so the caller's region() redraws when it changes.
 */
function waitingBlock(big, mine) {
  const finding = !S.stale && !isOffline();
  let title = 'Finding the Table…';
  let sub = null;
  if (!finding && mine) {
    title = 'Your connection dropped — reconnecting…';
    sub = 'Check your Wi-Fi or signal. This page keeps trying.';
  } else if (!finding) {
    title = "Can't reach the Table's phone…";
    sub = "Make sure the leader's phone is awake and online.";
  }
  return h(
    'div',
    { class: big ? 'waiting big' : 'waiting', 'data-testid': finding ? 'finding' : 'waiting', 'data-cause': finding ? null : mine ? 'mine' : 'table' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('div', { class: 'waiting-title', text: title }),
    sub && h('div', { class: 'waiting-sub', text: sub }),
  );
}

/** "Chime when it's my turn": a switch. */
const chimeToggle = (on, small) =>
  h('button', {
    class: `btn ghost toggle${small ? ' small' : ''}${on ? ' on' : ''}`, type: 'button', role: 'switch',
    'aria-checked': String(on), 'data-testid': small ? 'chime-foot' : 'chime-toggle', onclick: toggleChime,
  }, h('span', { class: 'switch', 'aria-hidden': 'true' }), small ? `Chime ${on ? 'on' : 'off'}` : "Chime when it's my turn");

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
    const players = arr(room?.players).map(obj).filter((p) => str(p.id) && str(p.name));
    const unclaimed = players.filter((p) => p.claimed === false);
    // Already in the game (their name is taken): the "Moving phones" list. Not the leader
    // (the leader's phone IS the Table) and not anyone already on this page.
    const leaderName = str(room?.leaderName);
    const taken = players.filter((p) => p.claimed === true && !arr(p.badges).includes('Leader') &&
      p.name !== leaderName && !S.sessions.some((s) => s.playerId === p.id));
    const mine = ownConnectionDown();

    region(V.status, { stale: S.stale, room: !!room, notice: S.notice, mine, off: isOffline() }, () => [
      S.notice && h('div', { class: 'notice', text: S.notice }),
      !room && waitingBlock(true, mine),
      room && (S.stale || isOffline()) && waitingBlock(false, mine),
    ]);

    const picking = S.joinMode === 'pick' && unclaimed.length > 0;
    const data = {
      ready: !!room, mode: picking ? 'pick' : 'new', adding: S.addingPlayer,
      // While typing a new name, only "are there names to pick?" matters, so a heartbeat
      // with a changed list doesn't rebuild (and blur) the name box.
      players: picking ? unclaimed.map((p) => [p.id, p.name]) : unclaimed.length > 0,
      // Same idea for the moving list: the names only matter while it's open.
      moving: taken.length === 0 ? false : S.showMoving ? taken.map((p) => [p.id, p.name]) : true,
      j: j && { status: j.status, error: j.error, name: j.name, move: j.move, hint: j.hint },
      title: str(room?.title) || 'Last Call', leader: leaderName, chime: S.chime,
    };
    region(V.body, data, (d) => {
      if (!d.ready) return [];
      const cancelAdd = d.adding && h('button', { class: 'btn ghost', text: 'Cancel', onclick: () => { S.addingPlayer = false; S.joining = null; render(); } });

      if (d.j && (d.j.status === 'waiting' || d.j.status === 'opening' || d.j.status === 'expired')) {
        const expired = d.j.status === 'expired';
        const who = d.leader || 'The leader';
        return [
          h('h1', { class: 'hero', text: `Hey ${d.j.name}!` }),
          expired
            ? h('div', { class: 'notice bad', 'data-testid': 'join-expired', text: "Your request timed out on the leader's phone. Ask again?" })
            : h('div', { class: 'waiting big', 'data-testid': 'join-waiting' },
              h('div', { class: 'spinner', 'aria-hidden': 'true' }),
              h('div', { class: 'waiting-title', text: d.j.move ? `Asking ${who} to move you to this phone…` : 'Asking the Table to let you in…' }),
              h('div', { class: 'waiting-sub', text: d.j.move ? `Once they say yes, your old phone stops working.` : `${who} taps "Let in" on their phone.` })),
          // After a minute with no answer (or once it's timed out): a nudge and a re-send.
          (d.j.hint || expired) && h('div', { class: 'join-hint', 'data-testid': 'join-hint' },
            !expired && h('p', { class: 'lead', text: 'Still waiting? Ask the leader to check their phone.' }),
            h('button', { class: 'btn primary big', 'data-testid': 'ask-again', text: 'Ask again', onclick: askAgain })),
          h('button', { class: 'btn ghost', text: 'Cancel', onclick: cancelJoin }),
        ];
      }
      const err = d.j && (d.j.status === 'denied' || d.j.status === 'error') &&
        h('div', { class: 'notice bad', 'data-testid': 'join-error', text: d.j.error });

      // "Already playing? Moving phones": closed, it's one quiet button; open, the taken names.
      const moving = d.moving && (Array.isArray(d.moving)
        ? h('div', { class: 'moving', 'data-testid': 'moving-list' },
          h('h2', { class: 'section-label', text: 'Already playing? Moving phones' }),
          h('p', { class: 'lead', text: `Tap your name. ${d.leader || 'The leader'} says yes on their phone, and your old phone stops working.` }),
          h('div', { class: 'name-grid' }, d.moving.map(([id, name]) =>
            h('button', { class: 'btn name taken', 'data-move': id, text: name, onclick: () => confirmMove(id, name) }))),
          h('button', { class: 'btn ghost small', text: 'Hide', onclick: () => { S.showMoving = false; render(); } }))
        : h('button', { class: 'btn ghost', 'data-testid': 'moving', text: 'Already playing? Moving phones', onclick: () => { S.showMoving = true; render(); } }));

      if (d.mode === 'new') {
        const nameInput = V.nameInput;
        return [
          h('h1', { class: 'hero', text: d.adding ? "Who's joining on this phone?" : `Welcome to ${d.title}` }),
          err,
          h('label', { class: 'label', text: "What's your name?" }),
          nameInput,
          h('button', { class: 'btn primary big', 'data-testid': 'join-new', text: "Let's go", onclick: () => startJoin(nameInput.value) }),
          chimeToggle(d.chime, false),
          d.players === true && h('button', { class: 'btn ghost', onclick: () => { S.joinMode = 'pick'; render(); } }, icon('back', 20), 'Pick my name instead'),
          moving,
          cancelAdd,
        ];
      }
      return [
        h('h1', { class: 'hero', text: d.adding ? "Who's joining on this phone?" : 'Who are you?' }),
        h('p', { class: 'lead', text: d.leader ? `Tap your name to join ${d.leader}'s game.` : 'Tap your name to join.' }),
        err,
        h('div', { class: 'name-grid' },
          d.players.map(([id, name]) =>
            h('button', { class: 'btn name', 'data-player': id, text: name, onclick: () => confirmName(id, name) }))),
        h('button', { class: 'btn ghost big', 'data-testid': 'im-new', text: "I'm new", onclick: () => { S.joinMode = 'new'; render(); setTimeout(() => V.nameInput?.focus(), 0); } }),
        chimeToggle(d.chime, false),
        moving,
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

    // Amounts read like the Table's: "a full drink and 3 sips" once they're that big.
    const perDrink = num(room?.sipsPerDrink);
    const shots = room?.hardLiquor === true;

    // Header phase chip. During the Last Call round: "Last Call · 3 cards to the Finale".
    const lastLeft = num(room?.lastCallLeft);
    region(V.phase, [str(room?.phase), str(room?.vibe), num(room?.cardCount), lastLeft], ([phase, vibe, count, left]) => [
      phase && h('span', {
        class: `chip phase-${phase}${left != null ? ' countdown' : ''}`, 'data-testid': left != null ? 'lastcall-left' : null,
        text: left != null
          ? `Last Call · ${left <= 1 ? 'last card before the Finale' : `${left} cards to the Finale`}`
          : PHASES[phase] || titleCase(phase),
      }),
      vibe && left == null && h('span', { class: 'chip dim', text: titleCase(vibe) }),
      count != null && left == null && h('span', { class: 'chip dim', text: plural(count, 'card') }),
    ]);

    // Profile switcher (only when this phone holds more than one player)
    const counts = S.sessions.map((s) => openCount(s.playerId) + (S.unseenRecap.has(s.playerId) ? 1 : 0));
    region(V.profiles, [S.sessions.map((s) => [s.playerId, sessionName(s)]), pid, counts], ([list, active, cs]) =>
      list.length < 2 ? [] : list.map(([id, name], i) =>
        h('button', {
          class: `profile${id === active ? ' on' : ''}`, 'data-profile': id, 'aria-pressed': String(id === active),
          onclick: () => switchTo(id),
        }, h('span', { text: i === 0 ? `Me · ${name}` : name }), cs[i] > 0 && id !== active && h('span', { class: 'badge', text: String(cs[i]) }))));

    // The error bar: after 15 s without the Table, or straight away when this phone is offline.
    const showBar = (S.stale || isOffline()) && !!room;
    const mine = ownConnectionDown();
    region(V.stale, [showBar, mine], ([show, m]) => show && waitingBlock(false, m));
    V.stale.hidden = !showBar;

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
            left != null && h('b', { text: `${plural(left, 'card')} left` }))))),
    ]);
    V.curses.hidden = !curses.length;

    // Owe / Bank (big)
    const pub = obj(arr(room?.players).find((p) => obj(p).id === pid));
    const you = obj(priv?.you);
    const owe = num(you.owe, num(pub.owe, 0));
    const bank = num(you.bank, num(pub.bank, 0));
    const oweText = drinkAmountShort(owe, perDrink, shots);
    region(V.me, [sessionName(me), owe, oweText, bank, covered], ([name, o, ot, b, cov]) => cov ? [] : [
      h('div', { class: 'me-name' }, h('span', { class: 'dim', text: 'You are' }), h('b', { text: name })),
      h('div', { class: 'me-stats' },
        h('div', { class: `stat owe${o > 0 ? ' hot' : ''}`, 'data-testid': 'owe' }, h('span', { class: 'stat-l', text: 'Owe' }),
          h('span', { class: `stat-n${ot !== String(o) ? ' words' : ''}`, text: ot })),
        h('div', { class: 'stat bank', 'data-testid': 'bank' }, h('span', { class: 'stat-l', text: 'Bank' }), h('span', { class: 'stat-n', text: String(b) }))),
    ]);

    // Private sections + actions
    const now = Date.now();
    let sections = arr(priv?.sections).map(obj).filter((s) => str(s.id) || str(s.title));
    // Thumb Master power live: everyone gets the same covered box (only the holder's is real).
    if (priv && thumbPowerLive(room) && !sections.some((s) => s.id === THUMB_SECTION && s.hidden === true)) {
      sections = [DECOY_THUMB, ...sections];
    }
    const peeked = sections.filter((s) => S.peek[`${pid}:${s.id}`] > now).map((s) => s.id);
    const allActions = arr(priv?.actions).map(obj).filter((a) => str(a.id) && str(a.label));
    // An action named after a hidden section ("thumb:used" for "thumb") goes INSIDE that
    // section's peek, so it isn't sitting in plain view under the black box.
    const hiddenIds = sections.filter((s) => s.hidden === true && str(s.id)).map((s) => s.id);
    const homeOf = (a) => hiddenIds.find((id) => a.id.startsWith(`${id}:`)) || null;
    const actions = allActions.filter((a) => !homeOf(a));
    const pressed = allActions.filter((a) => S.pressed[`${pid}:${a.id}`] > now).map((a) => a.id);
    const locked = tapsLocked();
    region(V.priv, [pid, covered, sections, peeked, allActions, pressed, locked], () => covered ? [] : [
      sections.length > 0 && h('div', { class: 'sections' }, sections.map((s) =>
        renderSection(pid, s, peeked.includes(s.id), allActions.filter((a) => homeOf(a) === s.id), pressed, locked))),
      actions.length > 0 && h('div', { class: 'actions' }, actions.map((a) => actionButton(pid, a, pressed.includes(a.id), locked, false))),
    ]);

    // Players strip
    const players = arr(room?.players).map(obj).filter((p) => str(p.id));
    region(V.players, [players, pid, perDrink, shots], ([list, active]) => !list.length ? [] : [
      h('h2', { class: 'section-label', text: 'The Table' }),
      h('ul', { class: 'player-grid' }, list.map((p) =>
        h('li', { class: `pl${p.id === active ? ' me' : ''}${p.online === false ? ' off' : ''}`, 'data-pl': p.id },
          h('div', { class: 'pl-name', text: str(p.name) || '?' }),
          h('div', { class: 'pl-nums' },
            h('span', { class: 'pl-owe', text: `Owe ${drinkAmountShort(num(p.owe, 0), perDrink, shots)}` }),
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

    region(V.foot, [S.sessions.length, covered, S.chime], ([, cov, ch]) => cov ? [] : [
      h('button', { class: 'btn ghost small', 'data-testid': 'add-player', onclick: () => { S.addingPlayer = true; S.joinMode = 'pick'; S.joining = null; render(); } }, icon('userPlus'), 'Someone sharing this phone'),
      chimeToggle(ch, true),
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
      taxText: num(card.chickenTax) != null ? drinkAmount(num(card.chickenTax), num(room?.sipsPerDrink), room?.hardLiquor === true) : null,
    },
    spot: spot && spot.text, name: spot ? sessionName(activeSession()) : '', covered,
  };
  region(V.card, data, (d) => {
    if (!d.has) return waitingBlock(true, false);
    if (!d.card) {
      // No card up (an interrupt, the Finale): a spotlight still shows (e.g. "THE SNAKE
      // STRUCK YOU", "Settle up: drink 3 sips").
      const idle = h('div', { class: 'card idle' },
        h('div', { class: 'card-band' }, h('span', { class: 'card-kind', text: PHASES[d.phase] || titleCase(d.phase) || 'Last Call' })),
        h('div', { class: 'card-idle-body' },
          h('p', { class: 'card-text', text: d.ended ? "That's a wrap. Thanks for playing!" : 'Eyes on the Table.' }),
          d.ended && d.hasRecap && h('button', { class: 'btn primary', text: 'See your recap', onclick: () => { S.recap = pid; render(); } }),
          !d.ended && d.leader && h('p', { class: 'card-sub', text: `${d.leader} is running the game.` })));
      if (!d.spot) return idle;
      return [
        h('div', { class: 'spot', 'data-testid': 'spotlight' },
          h('span', { class: 'spot-head', text: `Heads up, ${d.name}!` }),
          h('span', { class: 'spot-text', text: d.spot })),
        idle,
      ];
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
          h('span', { class: 'tax', 'data-testid': 'chicken-tax', text: c.taxText })),
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

/** One action button. `inPeek`: it sits inside a peeking section, so its tap mustn't also re-cover it. */
function actionButton(pid, a, sent, locked, inPeek) {
  const style = ACTION_STYLES.includes(a.style) ? a.style : 'normal';
  return h('button', {
    class: `btn act ${style}${sent ? ' sent' : ''}`, 'data-action': a.id, disabled: sent || locked,
    onclick: (e) => {
      if (inPeek) e.stopPropagation();
      pressAction(pid, a);
    },
  }, sent ? [icon('check', 22), 'Sent'] : a.label);
}

/**
 * One private section. `inside`: actions that belong in this hidden section's peek (shown
 * only while peeking). A decoy (DECOY_THUMB) gets a look-alike "Got it" button, so the
 * holder's peek and everyone else's look the same from across the table.
 */
function renderSection(pid, s, peeked, inside = [], pressed = [], locked = false) {
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
  hidden && inside.length > 0 && h('div', { class: 'actions sec-actions' },
    inside.map((a) => actionButton(pid, a, pressed.includes(a.id), locked, true))),
  // The decoy's button has no handler of its own: the tap bubbles up and re-covers the box.
  hidden && s.decoy === true && h('div', { class: 'actions sec-actions' },
    h('button', { class: 'btn act normal', type: 'button', 'data-testid': 'decoy-ok', text: 'Got it' })),
  hidden && h('div', { class: 'peek-hint', text: 'Hides itself in 5 s' }));
}

// ---------- banner (interrupts) ----------

function renderBanner(view) {
  const b = view === 'game' && S.room && S.room.banner ? obj(S.room.banner) : null;
  // onRoomChanged decided takeover vs strip for a new banner; buzz and flash it once here.
  if (S.bannerFresh) {
    S.bannerFresh = false;
    if (b && b.buzz === true) {
      buzz([400, 120, 400]);
      flash(b.style === 'alert' ? '#ff5a36' : b.style === 'info' ? '#7fd1ff' : '#ffd23f');
    }
  }
  // Quick Draw: nothing may cover the TAP button mid-race, so the banner folds into the strip.
  if (b && !S.bannerMin && hasOpenTap(S.activeId)) S.bannerMin = true;
  // A running card clock also shows on the takeover: nobody pays for a timer they couldn't see.
  const card = S.room?.card;
  const ends = b && cardTimerRunning(card) ? cardTimerEnds(card) : null;
  const style = b && BANNER_STYLES.includes(b.style) ? b.style : 'info';
  region(layers.banner, b && [style, str(b.title), str(b.text), S.bannerMin, ends], (d) => {
    if (!d) return [];
    const [st, title, text, min, endsAt] = d;
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
      endsAt != null && h('span', { class: 'timer banner-timer', 'data-testid': 'banner-timer', 'data-ends-at': String(endsAt), 'aria-label': 'seconds left' }),
      h('button', { class: 'btn ghost', text: 'Got it', onclick: () => { S.bannerMin = true; render(); } }));
  });
}

/** This player has a Quick Draw (tap) prompt still running. */
function hasOpenTap(pid) {
  const map = pid && S.prompts[pid];
  if (!map) return false;
  for (const e of map.values()) if (str(e.p.kind) === 'tap' && e.answered === undefined && !isExpired(e.p)) return true;
  return false;
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
  const sent = entries.some((e) => e.answered !== undefined);
  region(head, [entries.length, open, sent, S.sheetMin], ([n, o, any, min]) => n === 0 ? [] : [
    // "Sent" only if something was really answered; a prompt that just ran out says so.
    h('span', { class: 'sheet-title', text: o > 0 ? `Your move${o > 1 ? ` · ${o}` : ''}` : any ? 'Sent' : "Time's up" }),
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
      // The same prompt came again with something new (e.g. its ideas arrived): keep what
      // was typed, and the cursor, so nobody loses a half-written mission.
      if (el) keepTyping(el, fresh);
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

/** Carry a text box's value, focus and cursor from an old prompt element to its rebuild. */
function keepTyping(oldEl, freshEl) {
  const before = oldEl.querySelector('textarea');
  const after = freshEl.querySelector('textarea');
  if (!before || !after || after.value || !before.value) return;
  after.value = before.value;
  after.dispatchEvent(new Event('input'));
  if (document.activeElement === before) {
    const [a, b] = [before.selectionStart, before.selectionEnd];
    queueMicrotask(() => {
      after.focus();
      try { after.setSelectionRange(a, b); } catch { /* ignore */ }
    });
  }
}

function buildPrompt(pid, entry) {
  const p = entry.p;
  const kind = str(p.kind);
  const answered = entry.answered !== undefined;
  // Anonymous vote: never echo the name back ("Sent: Alex" sat on screen for 20 s).
  const anon = p.anonymous === true;
  const fs = h('fieldset', { disabled: answered || (isLockable(p) && tapsLocked()) });
  const el = h('section', {
    class: `prompt k-${kind || 'unknown'}${answered ? ' answered' : ''}`, 'data-prompt': p.id, 'data-kind': kind,
  },
  h('div', { class: 'p-head' },
    h('h3', { class: 'p-title', text: str(p.title) || 'Quick question' }),
    num(p.endsAt) != null && h('span', { class: 'p-timer', 'data-ends-at': String(p.endsAt) })),
  str(p.text) && h('p', { class: 'p-text', text: p.text }),
  anon && h('div', { class: 'pill anon', text: 'Anonymous' }),
  fs,
  answered && anon
    ? h('div', { class: 'p-state', 'data-testid': 'vote-sent' }, 'Vote sent', icon('check', 16))
    : h('div', { class: 'p-state', text: answered ? `Sent: ${entry.label}` : '' }));
  if (num(p.endsAt) != null) el.dataset.expires = String(p.endsAt);
  if (isLockable(p)) el.dataset.lockable = '1';

  const send = (value, label) => answer(pid, p.id, value, label);

  if (kind === 'choose' || kind === 'vote') {
    const opts = arr(p.options).map(obj).filter((o) => str(o.id));
    fs.append(h('div', { class: `options${opts.length > 4 ? ' many' : ''}` }, opts.map((o) =>
      h('button', {
        // (No "picked" highlight on an anonymous vote either: it shows who you chose.)
        class: `btn opt${answered && !anon && entry.answered === o.id ? ' picked' : ''}`, 'data-option': o.id,
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
    // A text prompt with `options` has one send button per option ("Save it" / "Save: needs a
    // photo"); the one tapped goes along as `option`. Otherwise a single Send.
    const sendOpts = arr(p.options).map(obj).filter((o) => str(o.id));
    const sends = sendOpts.length
      ? sendOpts.map((o, i) => h('button', {
        class: `btn ${i === 0 ? 'primary' : 'normal'} send-opt`, 'data-send-option': o.id,
        text: str(o.label) || o.id, disabled: !ta.value.trim(),
      }))
      : [h('button', { class: 'btn primary', 'data-testid': 'send-text', text: 'Send', disabled: !ta.value.trim() })];
    const refresh = () => {
      count.textContent = `${ta.value.length}/${maxLength}`;
      for (const b of sends) b.disabled = !ta.value.trim();
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
    sends.forEach((b, i) => b.addEventListener('click', () => {
      const v = ta.value.trim();
      if (v) answer(pid, p.id, v, v, sendOpts[i] ? sendOpts[i].id : undefined);
    }));
    fs.append(ta, sendOpts.length
      ? h('div', { class: 'text-row multi' }, count, h('div', { class: 'send-opts' }, sends))
      : h('div', { class: 'text-row' }, count, sends[0]));
  } else {
    fs.append(h('p', { class: 'dim', text: 'Look at the Table for this one.' }));
  }
  // Read-only notes (e.g. "Help me think of one" ideas): plain text you can read but not tap,
  // select or copy into the box. You still type your own.
  const notes = arr(p.notes).map(str).filter(Boolean);
  if (notes.length) {
    el.append(h('div', { class: 'p-notes', 'data-testid': 'prompt-notes', 'aria-label': 'Ideas (read only)' },
      notes.map((n, i) => h('p', { class: i === 0 ? 'p-note-head' : 'p-note', text: n }))));
  }
  // Buttons inside the prompt that press an ordinary action without answering it.
  const inner = arr(p.actions).map(obj).filter((a) => str(a.id) && str(a.label));
  if (inner.length && !answered) {
    el.append(h('div', { class: 'p-actions' }, inner.map((a) =>
      h('button', {
        class: 'btn ghost small p-act', type: 'button', 'data-prompt-action': a.id, text: a.label,
        onclick: () => {
          const session = S.sessions.find((x) => x.playerId === pid);
          if (session) sendPrivate(session.secret, 'act', { actionId: a.id });
        },
      }))));
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
  chime(); // Quick Draw is armed: a face-down phone hears it
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
