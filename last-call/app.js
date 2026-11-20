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
  h, region, obj, arr, str, num, safeColor, titleCase, fmtCountdown, buzz, reducedMotion, icon, longestWord, plural,
  drinkAmount, drinkAmountShort,
} from './ui.js';
import { chime, unlockAudio, setChimeEnabled, holdScreenAwake, audioNeedsTap, onAudioState } from './attention.js';
import { preparePhoto, splitChunks } from './photo.js';

// ============================================================================
// 1. State
// ============================================================================

const ROOM_STALE_MS = 15000; // no `room` for this long -> "Waiting for the Table…"
const PING_EVERY_MS = 5000; // ...and ping this often while waiting
const PEEK_MS = 5000; // hidden sections re-cover after this
const RESULT_MS = 4500; // how long a prompt_close result stays up
// A SECRET prompt's result on a shared phone waits behind "Private result · Tap to see" (11/20
// review fix: "Alex IS the Snake." sat uncovered under whoever had the phone). It waits there until
// its player has opened it (11/20 final review: it used to expire unseen once the phone moved on),
// then stays this long.
const SECRET_RESULT_MS = 20000;
const TAP_LOCK_MS = 1000; // after a new card, its buttons ignore taps this long (a double tap can't hit them)
// The prompt kinds this page can answer. Anything else (a newer Table's kind) is display-only:
// "Look at the Table for this one." It never moves or holds a shared phone (11/20 final review).
const ANSWERABLE_KINDS = ['choose', 'vote', 'tap', 'number', 'text'];
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
// Shared phones (11/19): after someone on this phone answers or presses a button, wait this long
// before the phone switches to the next person (so "Sent" shows, and a prompt the button opens
// can arrive first).
const TURN_HOLD_MS = 1000;
// Photo Proof (11/19): the pause between photo pieces (Realtime rate limits), how long to wait
// for the Table's answer, and how many rounds before it says "didn't send".
const PHOTO_PACE_MS = 70;
const PHOTO_ACK_MS = 6000;
const PHOTO_ROUNDS = 4;

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
// The decoy goes exactly where the real box sits (11/19 Phase 2b review: it used to go FIRST,
// while the holder's real box comes after the role and mission boxes, so where the box was could
// give the holder away). The engine puts the real "thumb" box just before these sections (or at
// the end): LastCallEngine.sections(for:) / withThumbDecoy.
const THUMB_COMES_BEFORE = ['cursed', 'debt', 'firesale'];
function withThumbDecoy(sections) {
  const at = sections.findIndex((s) => THUMB_COMES_BEFORE.includes(s.id));
  const out = [...sections];
  out.splice(at < 0 ? out.length : at, 0, DECOY_THUMB);
  return out;
}

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
  // Shared phones (11/19): no whole-screen "Pass to Sam" cover any more. The phone switches by
  // itself to whoever needs it (evaluateTurn). lastKey = the need it last switched for; done =
  // needs a player has dealt with; holdUntil / force = the short pause after an answer or a press.
  turn: { lastKey: null, holdUntil: 0, force: false, done: new Set() },
  // The phone just switched player by itself (11/20 final review): { pid, until }. Until then a
  // full-screen "Jake's turn" catches every tap, so the last player's thumb can't press the next
  // player's buttons.
  handover: null,
  secretOpen: {}, // `${pid}:${promptId}` -> true: a secret prompt opened on a shared phone
  drafts: {}, // `${pid}:${promptId}` -> what's typed (kept while a secret prompt is covered)
  photo: null, // the Photo Proof sheet (openPhoto)
  room: null, // last public `room` body
  lastRoomAt: 0,
  enteredAt: 0,
  lastPingAt: 0,
  lastBeatAt: 0, // the last presence beat (or real hello) we sent
  stale: false,
  priv: {}, // playerId -> `private` body
  prompts: {}, // playerId -> Map(promptId -> { p, answered, label, receivedAt })
  results: [], // [{ pid, title, text, secret, quiet, key, until (null = waits until seen), seenAt }]
  pressed: {}, // `${pid}:${actionId}` -> until (brief "Sent" state)
  // Buttons pressed while the page KNOWS the Table can't hear it (11/20 final review): held here,
  // not sent, and sent once the Table is back if that button is still offered.
  // `${pid}:${actionId}` -> { pid, id, label }
  queued: {},
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
  recap: null, // playerId whose Wrapped story is open (11/20: a story you tap through)
  storyIndex: 0, // which screen of it
  unseenRecap: new Set(),
  wrapped: {}, // playerId -> stored wrapped record (mirror of localStorage)
  showWrappedLanding: false,
  // "How to play" (11/20 build, room.howTo): { index, auto } while it's open. `auto` = it opened by
  // itself in the lobby (once per room); it closes when the night moves on (Start, the first card).
  howTo: null,
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
  hiddenAt: null, // leader-clock ms the page left the screen (the Distraction Tax report)
  // Whose camera hid the page (11/20 review fix): the page went hidden while this player's photo
  // sheet was open, so the report goes on THEIR channel, not the phone owner's.
  hiddenFor: null,
  resultSeq: 0, // numbers each prompt_close result (its tap-to-see key)
};

const clock = new LeaderClock();
const seqs = new SeqTracker(); // leader seq per channel
const mySeq = new Map(); // our own seq per channel
const subs = new Map(); // channel name -> unsubscribe()
let transport = null;
let modalSeq = 0;
// This page's own random id (11/20 review fix), sent in every hello on every player's channel.
// Two players with the same id share this phone, so the Table never picks either of them for a
// job whose WHO is secret (the Anonymous Ask's asker). New on every load; it's not stored.
let pageId = null;
const thisPage = () => pageId || (pageId = randomId(9));

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
  onAudioState(() => render()); // "Tap anywhere to turn the chime on" comes and goes with it

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
    // (A shared phone opens on whoever needs it: evaluateTurn. Secrets stay behind their own taps.)

    // A stored recap and no fresh per-player link -> the game is (probably) over: open on it, with
    // the story playing (11/20: Wrapped is at the end of the game, and stays on this page to reopen;
    // there's no noon "Morning-After" version any more).
    S.showWrappedLanding = Object.keys(S.wrapped).length > 0 && !frag.s;
    if (S.showWrappedLanding) {
      const ids = Object.keys(S.wrapped).filter((id) => S.wrapped[id] && S.wrapped[id].wrapped);
      openStory(ids.includes(S.activeId) ? S.activeId : ids[0] || null);
    }

    if (transport && !S.fatal && (frag.r || S.sessions.length)) enterRoom();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resync();
      resendJoin(); // still waiting to be let in: the locked phone may have missed the answer
    }
    // The page left the screen: note when (leader clock). The first hello after it comes
    // back says how long it was gone (the Table decides if that cost anything).
    else if (S.hiddenAt == null && S.roomId && !nightOver()) {
      S.hiddenAt = clock.leaderNow();
      // The camera (the photo sheet's "Take the photo") is what hid it: that player's report.
      S.hiddenFor = S.photo ? S.photo.pid : null;
    }
  });
  window.addEventListener('pageshow', (e) => e.persisted && resync());
  // The Wrapped story and How to play (11/20 build) by keyboard too: arrows, Escape.
  document.addEventListener('keydown', (e) => {
    if (S.recap && S.wrapped[S.recap]) {
      if (e.key === 'ArrowRight') storyStep(1);
      else if (e.key === 'ArrowLeft') storyStep(-1);
      else if (e.key === 'Escape') closeStory();
    } else if (S.howTo) {
      if (e.key === 'ArrowRight') howToGo(S.howTo.index + 1);
      else if (e.key === 'ArrowLeft') howToGo(S.howTo.index - 1);
      else if (e.key === 'Escape') closeHowTo();
    }
  });
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
  if (!known || S.activeId !== frag.p) setActive(frag.p);
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
    S.sessions.push(markLate({ roomId: S.roomId, secret, playerId, name: playerName(playerId) || '', savedAt: Date.now() }));
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
  // Back from being hidden: how long (leader clock), on ONE session: the photographer's if their
  // camera hid it (11/20 review fix), else this page's first (a shared phone is its owner's).
  // The Distraction Tax lives on the Table.
  let away = null;
  let reporter = S.sessions[0]?.playerId;
  if (S.hiddenAt != null) {
    const ms = Math.round(clock.leaderNow() - S.hiddenAt);
    if (ms >= 1000) away = { hiddenAt: Math.round(S.hiddenAt), hiddenMs: ms };
    if (S.hiddenFor && S.sessions.some((s) => s.playerId === S.hiddenFor)) reporter = S.hiddenFor;
    S.hiddenAt = null;
    S.hiddenFor = null;
  }
  for (const s of S.sessions) sendHello(s.secret, s.playerId === reporter ? away : null);
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

function sendHello(secret, away) {
  // The leader answers a hello with `private`, then every prompt it is still waiting on this
  // player for. Note when we asked, so that reply can be matched (see noteHelloReply).
  // `away` (Phase 2b): { hiddenAt, hiddenMs } after the page was hidden.
  const s = S.sessions.find((x) => x.secret === secret);
  if (s) S.resync[s.playerId] = { helloAt: Date.now(), start: 0, until: 0, keep: new Set() };
  sendPrivate(secret, 'hello', { lastSeq: seqs.lastSeq(privateChannel(secret)), page: thisPage(), ...(away || {}) });
}

/**
 * The presence beat: "this phone is still here" on every player's private channel. It's a
 * `hello` marked `beat: true`, which the leader answers with nothing (no resync is started).
 */
function sendBeats() {
  S.lastBeatAt = Date.now();
  for (const s of S.sessions) {
    sendPrivate(s.secret, 'hello', { lastSeq: seqs.lastSeq(privateChannel(s.secret)), beat: true, page: thisPage() });
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
      // Bar Crawl (11/20 final review): remember the resting line, so a page that reloads mid-walk
      // (Safari drops the tab for Maps or Uber; the link opened again) reads as resting before any
      // room comes, not "Can't reach the Table's phone". A room without `rest` forgets it.
      store.setRest(S.roomId, restText());
      // Fill in names we only knew by id (per-player links).
      for (const s of S.sessions) if (!s.name) s.name = playerName(s.playerId);
      // A player who joined before any room had come: late or not, now we know (11/20 build).
      if (S.sessions.some((s) => s.lateCheck)) {
        for (const s of S.sessions) if (s.lateCheck) markLate(s);
        store.saveSessions(S.roomId, S.sessions);
      }
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
      // A new "you're up" spotlight for someone on this phone (the Snake's victim, the Polygraph
      // subject, Collections, Settle up): chime, like a card that names them (11/20 final review:
      // iPhones ignore the buzz, so a face-down phone stayed silent). chime() skips a second
      // chime within 0.8 s, so a card that names them AND spotlights them chimes once.
      const spot = str(obj(body.spotlight).text);
      if (spot && spot !== str(obj(obj(S.priv[pid]).spotlight).text)) chime();
      S.priv[pid] = body;
      noteHelloReply(pid, 'private');
      // The buttons this player has now. A dialog or a photo sheet for one that's gone (the card
      // moved on) closes or says so; buttons held while the Table couldn't hear go out now.
      dropStaleButtons(pid, after);
      flushQueued(pid, body);
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
    case 'photo_ack':
      photoAck(pid, body); // Photo Proof: the Table has the photo (or wants pieces again)
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
    // A hidden-who prompt (the Anonymous Ask's asker) arrives silently (11/20 review fix): a buzz
    // or a chime the moment the card lands would point at this phone. The card itself tells
    // everyone to look.
    const quiet = p.hideWho === true;
    if (pid === S.activeId && !quiet) buzz(80);
    // A new question for someone on this phone. (Quick Draw chimes when its button appears.)
    if (str(p.kind) !== 'tap' && !isExpired(p) && !quiet) chime();
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
    dropDraft(pid, id);
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
  // "How to play" (11/20 build): it opens by itself once per room while everyone waits in the
  // lobby, and gets out of the way once the night moves on (Start, a new card).
  if (S.howTo && ((prev && str(prev.phase) !== str(room.phase)) || newCard || !howToPages(room).length)) S.howTo = null;
  if (!S.howTo && str(room.phase) === 'lobby' && howToPages(room).length && S.sessions.length && !store.getHowToSeen(S.roomId)) {
    S.howTo = { index: 0, auto: true };
    store.setHowToSeen(S.roomId);
  }
  if (newCard) {
    lockTaps();
    if (currentView() === 'game') window.scrollTo(0, 0);
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
  dropDraft(pid, str(body.id));
  const result = str(body.result);
  if (!result) return;
  // A secret prompt's result is secret too (the leader marks it; an older leader doesn't, so the
  // prompt's own `secret` counts as well). `quiet`: the prompt's very recipient was the secret
  // (hideWho): a shared phone doesn't show its result at all (11/20 review fix).
  const secret = body.secret === true || entry?.p.secret === true;
  const quiet = entry?.p.hideWho === true;
  // On a shared phone a secret result waits behind its player's tap until they've opened it
  // (until: null), with a badge on their name, and only then starts its 20 s (resultSeen).
  const waits = secret && !quiet && sharedPhone();
  S.results.push({
    pid, title: str(entry?.p.title), text: result, secret, quiet, key: `${str(body.id)}~${++S.resultSeq}`,
    until: waits ? null : Date.now() + RESULT_MS, seenAt: null,
  });
  if (S.results.length > 30) S.results = S.results.slice(-30);
}

/** A secret result waiting, unopened, for its player on this shared phone. */
const resultUnseen = (r) => r.until == null && !r.seenAt;

/** Its player opened it: from now it stays 20 s (covered again on a switch or by Hide). */
function resultSeen(r) {
  if (r.seenAt) return;
  r.seenAt = Date.now();
  r.until = r.seenAt + SECRET_RESULT_MS;
}

function storeWrapped(session, w) {
  // (No `showAt` any more, 11/20: Wrapped is at the end of the game only. It stays on this page,
  // so it can be opened again any time; an older leader's showAt is simply ignored.)
  const rec = { wrapped: w, name: session.name || '', receivedAt: Date.now() };
  S.wrapped[session.playerId] = rec;
  store.saveWrapped(S.roomId, session.playerId, rec);
  if (session.playerId === S.activeId) openStory(session.playerId);
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
    const body = { requestId, name: j.name, pub };
    if (j.claimPlayerId) body.claimPlayerId = j.claimPlayerId;
    j.tries.push({ requestId, keyPair, body });
    Object.assign(j, { status: 'waiting', error: null, sentAt: Date.now(), hint: false });
    sendRoom('join', body);
  } catch (err) {
    console.error(err);
    if (S.joining === j) Object.assign(j, { status: 'error', error: "This browser can't do the secure join. Try Safari or Chrome." });
  }
}

/**
 * Back on screen while still waiting to be let in (11/20 final review): the phone may have locked
 * and missed the one-shot `join_ok`. Send the SAME request again (same requestId, same key), so it
 * can never add a second "Riley": today's leader ignores a requestId it has already seen; a leader
 * that answers a handled requestId again with its join_ok lets this page in.
 */
function resendJoin() {
  const j = S.joining;
  const last = j && j.status === 'waiting' && j.tries[j.tries.length - 1];
  if (last && last.body && S.roomId && subs.size) sendRoom('join', last.body);
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
    const session = markLate({ roomId: S.roomId, secret, playerId, name: j.name, savedAt: Date.now() });
    const existing = S.sessions.find((s) => s.playerId === playerId);
    if (existing) {
      unsubscribe(privateChannel(existing.secret));
      Object.assign(existing, session);
    } else S.sessions.push(session);
    store.saveSessions(S.roomId, S.sessions);
    store.setLastRoom(S.roomId);
    setActive(playerId);
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
  dropDraft(pid, promptId);
  if (isHiddenWho(entry)) toast('Sent'); // (a shared phone keeps no "Sent" box for it)
  noteTurnActivity(pid, null); // a shared phone moves on to the next person in a moment
  render();
}

// Option buttons that a stray second tap could hit. Never Quick Draw's TAP (a race) or a
// text box (you can't type by accident).
const isLockable = (p) => ['choose', 'vote', 'number'].includes(str(p.kind));
const tapsLocked = () => Date.now() < S.lockUntil;

function pressAction(pid, action) {
  const session = S.sessions.find((s) => s.playerId === pid);
  if (!session || tapsLocked()) return;
  // Photo Proof: a photo button opens the camera sheet first (its text is the "are you sure").
  if (action.photo === true) {
    openPhoto(pid, action);
    return;
  }
  const go = () => sendAct(pid, action.id, str(action.label));
  if (str(action.confirm)) {
    openModal({
      text: action.confirm,
      // Whose button it asks about: if the card moves on meanwhile, the dialog closes (11/20 final review).
      action: { pid, id: action.id },
      buttons: [
        { label: 'Cancel', style: 'ghost' },
        { label: 'Yes', style: 'primary', run: go },
      ],
    });
  } else go();
}

/** The page knows the Table can't hear it right now: no room for 15 s, or our own connection is down. */
const tableUnreachable = () => S.stale || ownConnectionDown();

/**
 * Send a button press (`act`). While the Table can't hear us (11/20 final review: the press used
 * to say "Sent" and was lost), it is NOT sent: the button says "Waiting for the Table…" and the
 * press goes out once the Table is back, if that same button is still offered (flushQueued). Acts
 * aren't safe to send twice, so it's sent exactly once, or not at all.
 */
function sendAct(pid, actionId, label) {
  const session = S.sessions.find((s) => s.playerId === pid);
  if (!session) return;
  const key = `${pid}:${actionId}`;
  noteTurnActivity(pid, actionId); // (a shared phone moves on either way: they've dealt with it)
  if (tableUnreachable()) {
    S.queued[key] = { pid, id: actionId, label };
    toast("The Table can't hear you right now. Your tap goes through once it's back.", 3500);
    return;
  }
  sendPrivate(session.secret, 'act', { actionId });
  S.pressed[key] = Date.now() + 1200;
  render();
}

/**
 * A fresh `private` for this player: the Table is back. Send the presses held for them, but only
 * a button that's still there with the same label ("I drank (3 sips)" is not "I drank (5 sips)");
 * the rest are dropped, and the guest is told.
 */
function flushQueued(pid, priv) {
  const held = Object.entries(S.queued).filter(([, q]) => q.pid === pid);
  if (!held.length || isOffline()) return;
  const session = S.sessions.find((s) => s.playerId === pid);
  const offered = arr(obj(priv).actions).map(obj);
  let sent = 0;
  let lost = 0;
  for (const [key, q] of held) {
    delete S.queued[key];
    if (session && offered.some((a) => str(a.id) === q.id && str(a.label) === q.label)) {
      sendPrivate(session.secret, 'act', { actionId: q.id });
      S.pressed[key] = Date.now() + 1200;
      sent++;
    } else lost++;
  }
  // (No button names in these: a press inside a peek is a secret on a shared phone.)
  if (lost) toast("The Table's back, but the game moved on: that tap didn't count. Check your buttons.", 4000);
  else if (sent) toast("The Table's back: your tap went through.", 2500);
}

/**
 * The buttons this player has now (`ids`). A confirm dialog for a button that's gone closes; a
 * photo sheet for one says "This card has moved on" and stops (11/20 final review: "Yes" sent a
 * refusal for the last card, and a photo went to a dare the Table had skipped).
 */
function dropStaleButtons(pid, ids) {
  const m = S.modal;
  if (m && m.action && m.action.pid === pid && !ids.includes(m.action.id)) {
    S.modal = null;
    toast('That card has moved on.', 2500);
  }
  const ph = S.photo;
  if (ph && ph.pid === pid && !ids.includes(ph.actionId) && !['sent', 'moved'].includes(ph.status)) {
    ph.cancelled = true; // an upload in progress stops (uploadPhoto checks it)
    if (ph.waiter) {
      const w = ph.waiter;
      ph.waiter = null;
      clearTimeout(ph.waitTimer);
      w(null);
    }
    ph.status = 'moved';
    ph.prepared = null;
    ph.error = null;
  }
}

function openModal(m) {
  S.modal = { id: ++modalSeq, ...m };
  render();
}

function toast(text, ms = 1800) {
  S.toast = { text, until: Date.now() + ms };
  render();
}

// Half-written answers (11/20 final review: a mission typed out was lost when Safari reloaded the
// tab, and pasting isn't allowed). Kept in memory and mirrored into sessionStorage (this tab only),
// per room, player and prompt; forgotten once it's answered, closed or gone.
function draftFor(pid, promptId) {
  const key = `${pid}:${promptId}`;
  if (S.drafts[key] == null) {
    const saved = store.getDraft(S.roomId, pid, promptId);
    if (saved) S.drafts[key] = saved;
  }
  return S.drafts[key] || '';
}

function saveDraft(pid, promptId, text) {
  S.drafts[`${pid}:${promptId}`] = text;
  store.setDraft(S.roomId, pid, promptId, text);
}

function dropDraft(pid, promptId) {
  delete S.drafts[`${pid}:${promptId}`];
  store.setDraft(S.roomId, pid, promptId, '');
}

// ============================================================================
// 6. Sessions & profiles (one page, several players)
// ============================================================================

/**
 * Another player has the phone now. Every secret covers itself again (peeks and opened secret
 * prompts are per player and get cleared), and the last player's recap closes.
 */
function setActive(pid) {
  S.activeId = pid;
  S.peek = {};
  S.secretOpen = {};
  S.recap = null;
  S.flashedKey = null;
  if (S.unseenRecap.has(pid)) {
    S.unseenRecap.delete(pid);
    openStory(pid);
  }
  store.setActive(S.roomId, pid);
}

/** A chip in the small switcher: a manual switch (it sticks until something new needs the phone). */
function switchTo(pid) {
  if (pid === S.activeId) return;
  setActive(pid);
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
  S.results = S.results.filter((r) => r.pid !== pid);
  for (const [k, q] of Object.entries(S.queued)) if (q.pid === pid) delete S.queued[k];
  if (S.sessions.length) setActive(S.sessions[0].playerId);
  else {
    S.activeId = null;
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
const sharedPhone = () => S.sessions.length > 1;
const playerName = (id) => str(arr(S.room?.players).find((p) => obj(p).id === id)?.name);
const sessionName = (s) => (s && (s.name || playerName(s.playerId))) || 'Player';

// ============================================================================
// 6b. Shared phones: who has the phone (Jackson 11/19)
// ============================================================================
// "if people are sharing phones, it should just auto switch. we don't need to tap to reveal each
// time, just keep the sensative info hidden and only have to tap to reveal that". So there's no
// whole-screen "Pass to Sam" cover: public things (the card, Owe / Bank, banners, curses, their
// public role, Drank it / Put it on my tab, Did it / Refuse, votes) show straight away for whoever
// has the phone; each secret sits behind its own tap (hidden sections; prompts marked `secret`);
// and the phone switches by itself to whoever needs it. Same rules as the leader's "My stuff"
// (LastCallEngine.phoneNeeds / phoneTurn). The page still knows no game rules: it only reads
// prompts, card.targets, spotlights and `attention` buttons.

/**
 * An open question nobody has answered yet. Not a Quick Draw TAP (every player's TAP shows at
 * once), and not a kind this page can't answer (display-only: it never holds the phone).
 */
const isWaitingPrompt = (e) =>
  e.answered === undefined && !isExpired(e.p) && str(e.p.kind) !== 'tap' && ANSWERABLE_KINDS.includes(str(e.p.kind));

/**
 * A `hideWho` prompt on a shared phone (11/20 review fix): WHO it's for is the secret (the
 * Anonymous Ask's asker, a deal offer's buyer). It never moves the phone, never names anyone in
 * the header or a badge, and only shows (covered, nameless) while nothing else needs the phone.
 */
const isHiddenWho = (e) => e.p.hideWho === true && sharedPhone();
const hiddenWhoWaiting = (pid) => [...(S.prompts[pid]?.values() || [])].filter((e) => isHiddenWho(e) && isWaitingPrompt(e));

const waitingPrompts = (pid) =>
  [...(S.prompts[pid]?.values() || [])].filter(isWaitingPrompt).sort((a, b) => a.receivedAt - b.receivedAt);

/**
 * What the players on this phone need it for, most urgent first:
 *   0. a question for them (in the phone's order, oldest first: a vote asks each one in turn);
 *      then a secret result they haven't opened yet (it waits for them, 11/20 final review);
 *   1. the card names them ({A}, then {B}, {C}), or their phone has a spotlight;
 *   2. a button marked `attention` (a charge they can still put on their tab).
 * Keys are unique per need; the phone switches when the most urgent key changes.
 */
function phoneNeeds() {
  const order = S.sessions.map((s) => s.playerId);
  const needs = [];
  for (const pid of order) {
    for (const e of waitingPrompts(pid)) {
      if (isHiddenWho(e)) continue; // never moves the phone (it would name its player)
      needs.push({ pid, rank: 0, key: `p:${pid}:${e.p.id}`, kind: str(e.p.kind), endsAt: num(e.p.endsAt) });
    }
  }
  for (const pid of order) {
    for (const r of S.results) if (r.pid === pid && resultUnseen(r)) needs.push({ pid, rank: 0, key: `r:${pid}:${r.key}` });
  }
  const card = S.room && S.room.card ? obj(S.room.card) : null;
  const targets = arr(card?.targets);
  for (const t of targets) if (order.includes(t)) needs.push({ pid: t, rank: 1, key: `c:${str(card.id)}:${t}` });
  for (const pid of order) {
    const spot = obj(obj(S.priv[pid]).spotlight);
    if (!targets.includes(pid) && str(spot.text)) needs.push({ pid, rank: 1, key: `s:${pid}:${str(spot.text)}` });
  }
  for (const pid of order) {
    for (const a of arr(obj(S.priv[pid]).actions).map(obj)) {
      if (a.attention === true && str(a.id)) needs.push({ pid, rank: 2, key: `a:${pid}:${a.id}` });
    }
  }
  return needs.filter((n) => !S.turn.done.has(n.key));
}

/**
 * The player on screen is still answering something, or reading a secret result they opened: the
 * phone never switches away mid-answer (or mid-read: Hide, or its 20 s, lets it go). A hidden-who
 * box only counts once they've opened it.
 */
const activeBusy = () =>
  waitingPrompts(S.activeId).some((e) => !isHiddenWho(e) || S.secretOpen[`${S.activeId}:${e.p.id}`]) ||
  S.results.some((r) => r.pid === S.activeId && r.secret && S.secretOpen[`${S.activeId}:result:${r.key}`]);

/** Nothing on this phone needs it right now (a hidden-who box may show). */
const phoneIdle = () => phoneNeeds().length === 0;

/**
 * Hand the phone to whoever needs it (called before every render). It switches when the most
 * urgent need is new, or right after someone answered or pressed something (`force`: the next
 * voter's turn). Never away from someone mid-answer, never while a dialog or the camera sheet is
 * open (unless the sheet is folded away for a timed question: photoFold), and a manual switch
 * sticks until something new comes up.
 */
function evaluateTurn() {
  if (!sharedPhone() || S.modal || Date.now() < S.turn.holdUntil) return false;
  const fold = photoFold();
  if (S.photo && fold !== 'turn') {
    // The photo sheet is back after someone else's question: its owner's screen goes behind it.
    if (!fold && S.photo.foldedForTurn && S.photo.pid !== S.activeId && S.sessions.some((s) => s.playerId === S.photo.pid)) {
      setActive(S.photo.pid);
    }
    if (S.photo) S.photo.foldedForTurn = false;
    return false;
  }
  if (S.photo) S.photo.foldedForTurn = true;
  const force = S.turn.force;
  S.turn.force = false;
  const top = phoneNeeds()[0];
  if (!top) return false;
  if (activeBusy() && top.pid !== S.activeId) return false;
  if (!force && top.key === S.turn.lastKey) return false;
  S.turn.lastKey = top.key;
  if (top.pid === S.activeId) return false;
  setActive(top.pid);
  startHandover(top.pid);
  window.scrollTo(0, 0);
  return true;
}

/**
 * The phone just switched player by itself (11/20 final review: Sam's thumb, a beat late, pressed
 * Jake's "Put it on my tab", or cast Jake's anonymous vote). For a second every button is locked and
 * a full-screen "Jake's turn" says who has the phone now, catching any tap; then it lets go. (Not
 * over a running Quick Draw: nothing covers a TAP. The lock never touches a TAP either.)
 */
function startHandover(pid) {
  lockTaps();
  S.handover = { pid, until: S.lockUntil };
}

/**
 * Someone on this phone answered (actionId null) or pressed a button: pause a moment, then hand
 * the phone on. A press also counts as dealing with their spotlight, their card (a `card:`
 * button) or that button's own `attention`.
 */
function noteTurnActivity(pid, actionId) {
  S.turn.holdUntil = Date.now() + TURN_HOLD_MS;
  S.turn.force = true;
  if (actionId == null) return;
  for (const n of phoneNeeds()) {
    if (n.pid !== pid || n.rank === 0) continue;
    if (n.key.startsWith('s:') || (n.key.startsWith('c:') && actionId.startsWith('card:')) || n.key === `a:${pid}:${actionId}`) {
      S.turn.done.add(n.key);
    }
  }
  if (S.turn.done.size > 300) S.turn.done = new Set([...S.turn.done].slice(-100));
}

/** "Sam's vote" while they have a vote open, otherwise "Sam's turn". */
function turnTitle(pid) {
  const name = sessionName(S.sessions.find((s) => s.playerId === pid));
  const first = waitingPrompts(pid).find((e) => !isHiddenWho(e));
  return str(first?.p.kind) === 'vote' ? `${name}'s vote` : `${name}'s turn`;
}

/** A `secret` prompt on a shared phone stays behind "Sam: something private for you" until tapped. */
const secretCovered = (pid, e) =>
  (e.p.secret === true || e.p.hideWho === true) && sharedPhone() && e.answered === undefined && !S.secretOpen[`${pid}:${e.p.id}`];

// ============================================================================
// 6c. Photo Proof (Jackson 11/19: "they were supposed to have to take pictures")
// ============================================================================
// A button marked `photo` (a photo mission's claim, a photo dare's "I did it") opens this sheet.
// "Take the photo" opens the camera (a file input with capture); the photo is shrunk and
// re-encoded here (photo.js: 1024 px, JPEG, no EXIF) and goes to the leader in pieces over this
// player's secret private channel (`photo_chunk`: plain JSON on a secret-named channel, over TLS;
// not end-to-end encrypted). The leader answers `photo_ack`: ok (then the
// button's `act` goes out with the `photoId`), the pieces to send again, or why it was refused.
// No answer: everything again, up to PHOTO_ROUNDS times, then "Try again". "Send without a photo"
// sends the plain act: the leader checks it by eye, as before. Nothing is kept on this phone.

function openPhoto(pid, action) {
  S.photo = {
    pid, actionId: action.id, label: str(action.label) || 'Photo', text: str(action.confirm),
    status: 'pick', prepared: null, error: null, sent: 0, count: 0, photoId: null, attempt: 0,
    early: null, waiter: null, waitTimer: null, cancelled: false, openedAt: Date.now(), foldedForTurn: false,
  };
  render();
}

/**
 * Why the photo sheet is folded away right now, or null (it's up). The upload, if one is going,
 * keeps going either way.
 *   'tap'    a Quick Draw / Bank Heist is running: nothing may cover a TAP (a small strip shows);
 *   'banner' a takeover is up (Mirror, Silent Round, the Snake's strike): it shows instead of the
 *            sheet, and the sheet comes back after "Got it" (11/20 final review);
 *   'turn'   a timed question came in for someone on this phone after the sheet opened (Jake's vote
 *            while Sam lines up his shot): the phone goes to them, and the sheet comes back once
 *            it's answered or over (11/20 final review: the vote ran out unseen under the sheet).
 */
function photoFold() {
  const ph = S.photo;
  if (!ph) return null;
  if (hasOpenTap()) return 'tap';
  if (currentView() === 'game' && S.room && S.room.banner && !S.bannerMin) return 'banner';
  const late = (e) => num(e.p.endsAt) != null && e.receivedAt > ph.openedAt && !isHiddenWho(e);
  if (S.sessions.some((s) => waitingPrompts(s.playerId).some(late))) return 'turn';
  return null;
}

function closePhoto() {
  const ph = S.photo;
  if (ph) {
    ph.cancelled = true;
    if (ph.waiter) {
      const w = ph.waiter;
      ph.waiter = null;
      clearTimeout(ph.waitTimer);
      w(null);
    }
  }
  S.photo = null;
  render();
}

/** "Take the photo": the camera (or the photo picker, on a phone without one). */
function takePhoto() {
  photoInput.value = '';
  photoInput.click();
}

async function onPhotoPicked() {
  const ph = S.photo;
  const file = photoInput.files && photoInput.files[0];
  if (!ph || !file) return;
  ph.status = 'preparing';
  ph.error = null;
  render();
  try {
    const prepared = await preparePhoto(file);
    if (S.photo !== ph) return;
    ph.prepared = prepared;
    ph.status = 'preview';
  } catch (err) {
    console.error(err);
    if (S.photo !== ph) return;
    ph.prepared = null;
    ph.status = 'failed';
    ph.error = "Couldn't open that photo. Take it again.";
  }
  render();
}

/** "Send without a photo": the plain button press (the Table checks it by eye). */
function sendWithoutPhoto() {
  const ph = S.photo;
  if (ph) sendAct(ph.pid, ph.actionId, ph.label); // (held, like any press, while the Table can't hear)
  closePhoto();
}

/** "Send it" / "Try again": upload the prepared photo, then press the button with its id. */
async function sendPhoto() {
  const ph = S.photo;
  const session = ph && S.sessions.find((s) => s.playerId === ph.pid);
  if (!ph || !ph.prepared || !session || ph.status === 'sending') return;
  ph.photoId = randomId(9); // a fresh id every try: a half-sent one is just abandoned
  ph.attempt += 1;
  ph.status = 'sending';
  ph.error = null;
  ph.early = null;
  const chunks = splitChunks(ph.prepared.b64);
  ph.count = chunks.length;
  ph.sent = 0;
  render();
  const result = await uploadPhoto(ph, session, chunks);
  if (S.photo !== ph || ph.cancelled) return;
  if (result.ok) {
    ph.status = 'sent';
    sendPrivate(session.secret, 'act', { actionId: ph.actionId, photoId: ph.photoId });
    S.pressed[`${ph.pid}:${ph.actionId}`] = Date.now() + 1200;
    noteTurnActivity(ph.pid, ph.actionId);
    render();
    setTimeout(() => {
      if (S.photo === ph) {
        S.photo = null;
        render();
      }
    }, 1200);
  } else {
    ph.status = 'failed';
    ph.error = result.reason || "It didn't reach the Table. Check your signal, then try again.";
    render();
  }
}

/**
 * Send every piece (paced), wait for the Table's answer, and send again what it says is
 * missing (or everything, if it said nothing). Resolves { ok } or { ok: false, reason }.
 */
async function uploadPhoto(ph, session, chunks) {
  const base = { photoId: ph.photoId, count: chunks.length, hash: ph.prepared.hash, bytes: ph.prepared.bytes, mime: 'image/jpeg' };
  let todo = chunks.map((_, i) => i);
  for (let round = 0; round < PHOTO_ROUNDS; round++) {
    for (const i of todo) {
      if (S.photo !== ph || ph.cancelled) return { ok: false };
      sendPrivate(session.secret, 'photo_chunk', { ...base, index: i, data: chunks[i] });
      if (round === 0) {
        ph.sent = i + 1;
        render();
      }
      await new Promise((r) => setTimeout(r, PHOTO_PACE_MS));
    }
    ph.sent = chunks.length;
    ph.checking = true;
    render();
    const ack = await waitPhotoAck(ph, PHOTO_ACK_MS);
    ph.checking = false;
    if (S.photo !== ph || ph.cancelled) return { ok: false };
    if (ack && ack.ok === true) return { ok: true };
    if (ack && str(ack.reason)) return { ok: false, reason: str(ack.reason) };
    const missing = ack ? arr(ack.missing).filter((i) => Number.isInteger(i) && i >= 0 && i < chunks.length) : [];
    todo = missing.length ? [...new Set(missing)] : chunks.map((_, i) => i);
  }
  return { ok: false };
}

/** The Table's next `photo_ack` for this photo (one that came early is used at once), or null. */
function waitPhotoAck(ph, ms) {
  if (ph.early) {
    const a = ph.early;
    ph.early = null;
    return Promise.resolve(a);
  }
  return new Promise((resolve) => {
    ph.waiter = resolve;
    ph.waitTimer = setTimeout(() => {
      if (ph.waiter === resolve) {
        ph.waiter = null;
        resolve(null);
      }
    }, ms);
  });
}

function photoAck(pid, body) {
  const ph = S.photo;
  if (!ph || ph.pid !== pid || !ph.photoId || str(body.photoId) !== ph.photoId) return;
  if (ph.waiter) {
    const w = ph.waiter;
    ph.waiter = null;
    clearTimeout(ph.waitTimer);
    w(body);
  } else if (body.ok === true || !ph.early) {
    ph.early = body; // arrived mid-round: used as soon as the round ends
  }
}

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
  // (until null: a secret result waiting to be seen on a shared phone. If the phone isn't shared
  // any more, it's simply on screen: start its clock.)
  for (const r of S.results) if (r.until == null && !sharedPhone()) r.until = now + SECRET_RESULT_MS;
  S.results = S.results.filter((r) => r.until == null || r.until > now);
  if (S.results.length !== before) dirty = true;
  // The hand-over second is over: "Jake's turn" lifts and his buttons take taps.
  if (S.handover && now >= S.handover.until) {
    S.handover = null;
    dirty = true;
  }
  if (S.toast && S.toast.until <= now) {
    S.toast = null;
    dirty = true;
  }
  // Shared phones: the short pause after an answer is over: let evaluateTurn hand the phone on.
  if (S.turn.holdUntil && now >= S.turn.holdUntil) {
    S.turn.holdUntil = 0;
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
  for (const [pid, map] of Object.entries(S.prompts)) {
    for (const [id, e] of map) {
      const ends = num(e.p.endsAt);
      if (ends == null) continue;
      if (leaderNow >= ends + EXPIRED_KEEP_MS) {
        map.delete(id);
        dropDraft(pid, id);
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
  handover: h('div', { class: 'layer-handover' }), // "Jake's turn": the second after the phone switched
  howto: h('div', { class: 'layer-howto' }), // "How to play" (11/20 build)
  recap: h('div', { class: 'layer-recap' }), // the Wrapped story
  photo: h('div', { class: 'layer-photo' }), // the Photo Proof sheet
  modal: h('div', { class: 'layer-modal' }),
  toast: h('div', { class: 'layer-toast', role: 'status', 'aria-live': 'polite' }),
  flash: h('div', { class: 'flash', 'aria-hidden': 'true' }),
};
root.replaceChildren(...Object.values(layers));
// The Photo Proof sheet: a region for the sheet, plus the one camera input (kept in the page, so
// iPhones open the camera from it).
const photoBox = h('div', { class: 'photo-box' });
const photoInput = h('input', {
  type: 'file', accept: 'image/*', capture: 'environment', hidden: true, tabindex: '-1', 'aria-hidden': 'true',
  'data-testid': 'photo-input',
});
photoInput.addEventListener('change', onPhotoPicked);
layers.photo.append(photoBox, photoInput);

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
  // Shared phones: hand the phone to whoever needs it before drawing (11/19).
  if (view === 'game') evaluateTurn();
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
  renderHandover(view);
  renderHowTo(view);
  renderStory(view);
  renderPhoto(view);
  renderModal();
  region(layers.toast, S.toast?.text || null, (t) => t && h('div', { class: 'toast', text: t }));
  // Keep the screen on while the night runs; let it sleep again at Wrapped / the end, and while
  // the game rests (Bar Crawl: walking between bars, room.rest). Also while waiting to be let in
  // (11/20 final review: a phone that auto-locks there can miss the one-shot join_ok).
  const waitingToJoin = view === 'join' && !!S.joining && (S.joining.status === 'waiting' || S.joining.status === 'opening');
  holdScreenAwake((view === 'game' && !!S.room && S.room.phase !== 'ended' && !restText()) || waitingToJoin);
  updateLive();
}

/** The resting line to show while no `room` has come yet (a page reloaded mid-walk), or null. */
const savedRest = () => (S.room ? null : store.getRest(S.roomId));

// ---------- shared bits ----------

const brand = () =>
  h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('glass', 18)), h('span', { text: 'LAST CALL' }));

/**
 * The spinner block. Before the first `room`: "Finding the Table…". After a long silence it
 * says whose connection it is: ours (no network, or our own channel failed) or the Table's.
 * `mine` is passed in so the caller's region() redraws when it changes.
 */
function waitingBlock(big, mine, rest = null) {
  const finding = !S.stale && !isOffline();
  // The game is resting on purpose (room.rest: Bar Crawl, walking between bars) and the Table's
  // phone is asleep in a pocket: say so calmly, no alarm, no spinner.
  if (!finding && !mine && rest) {
    return h(
      'div',
      { class: big ? 'waiting big resting' : 'waiting resting', 'data-testid': 'resting', 'data-cause': 'rest' },
      h('div', { class: 'waiting-title', text: rest }),
    );
  }
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

/** room.rest's line (protocol, Bar Crawl 11/20): the game is resting on purpose. null = playing. */
function restText() {
  const rest = obj(S.room?.rest);
  return str(rest.text) || null;
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
      turn: h('section', { class: 'turn-wrap', 'aria-live': 'polite' }),
      stale: h('div', { class: 'stale-bar', role: 'status' }),
      card: h('section', { class: 'card-wrap', 'aria-live': 'polite' }),
      curses: h('section', { class: 'curses' }),
      me: h('section', { class: 'me' }),
      priv: h('section', { class: 'private' }),
      players: h('section', { class: 'players' }),
      ticker: h('section', { class: 'ticker' }),
      foot: h('footer', { class: 'foot' }),
      phase: h('div', { class: 'phase' }),
      // room.strip (Bar Crawl 11/20): "STOP 2 · The Owl", "ON THE MOVE", "TRANSIT ROUND".
      strip: h('section', { class: 'strip-wrap', 'aria-live': 'polite' }),
      // 11/20 build: "The Table's phone is low on battery" (room.tableBattery), and a late
      // joiner's quick rules for their first 3 cards.
      battery: h('div', { class: 'battery-wrap', role: 'status' }),
      rules: h('section', { class: 'rules-wrap' }),
      // "Tap anywhere to turn the chime on" (11/20 final review): sound needs a tap on iPhones. A
      // pill fixed above the sheet (it takes no room, so nothing moves when it goes mid-tap).
      unlock: h('div', { class: 'unlock-wrap' }),
    };
    v.root = h(
      'main',
      { class: 'screen game' },
      h('header', { class: 'top' }, brand(), v.phase),
      v.strip, v.battery, v.turn, v.profiles, v.stale, v.rules, v.card, v.curses, v.me, v.priv, v.players, v.ticker, v.foot, v.unlock,
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

    const rest = room ? restText() : savedRest();
    region(V.status, { stale: S.stale, room: !!room, notice: S.notice, mine, off: isOffline(), rest }, () => [
      S.notice && h('div', { class: 'notice', text: S.notice }),
      !room && waitingBlock(true, mine, rest),
      room && (S.stale || isOffline()) && waitingBlock(false, mine, rest),
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
    // No whole-screen cover (11/19): public things show for whoever has the phone; each secret
    // has its own tap (hidden sections, secret prompts).
    const priv = obj(S.priv[pid]);

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

    // The status strip (protocol `room.strip`, optional): a title and a line, nothing else.
    const strip = obj(room?.strip);
    const stripData = str(strip.title) || str(strip.text) ? [str(strip.title), str(strip.text)] : null;
    region(V.strip, stripData, (d) => d && h('div', { class: 'strip', 'data-testid': 'stop-strip', role: 'status' },
      d[0] && h('b', { class: 'strip-title', text: d[0] }),
      d[1] && h('span', { class: 'strip-text', text: d[1] })));
    V.strip.hidden = !stripData;

    // The Table's battery (11/20 build, optional room.tableBattery): only sent at 15% or lower.
    const batt = room && room.phase !== 'ended' ? num(room.tableBattery) : null;
    region(V.battery, batt, (b) => b != null && h('div', { class: 'battery-note', 'data-testid': 'table-battery' },
      icon('battery', 20), h('span', { text: `The Table's phone is low on battery (${Math.max(0, Math.round(b))}%). Find it a charger!` })));
    V.battery.hidden = batt == null;

    // The chime is on but this page load can't make sound yet (iPhones need a tap first: after
    // Safari reloads the tab, or the per-player link opened it). Any tap anywhere fixes it, and
    // the pill goes (audioNeedsTap; never shown where the browser has no sound at all). Tapping
    // the pill itself plays the chime once, as a sample.
    const needTap = S.chime && audioNeedsTap() && !!room && room.phase !== 'ended';
    region(V.unlock, needTap, (show) => show && h('button', {
      class: 'unlock', type: 'button', 'data-testid': 'chime-unlock',
      onclick: () => { unlockAudio(); chime(); },
    }, icon('bell', 20), h('span', { text: 'Tap anywhere to turn the chime on' })));
    V.unlock.hidden = !needTap;

    // Shared phone: whose turn it is, big ("Sam's vote"), then a small manual switcher whose
    // badges count what's waiting for each player.
    const needs = sharedPhone() ? phoneNeeds() : [];
    region(V.turn, sharedPhone() && pid ? [turnTitle(pid), pid] : null, (d) => d && h('div', { class: 'turn', 'data-testid': 'turn' },
      h('span', { class: 'turn-label', text: 'On this phone now' }),
      h('b', { class: 'turn-name', 'data-testid': 'turn-name', style: { '--fit': String(longestWord(d[0])) }, text: d[0] })));
    V.turn.hidden = !(sharedPhone() && pid);
    const counts = S.sessions.map((s) => needs.filter((n) => n.pid === s.playerId).length + (S.unseenRecap.has(s.playerId) ? 1 : 0));
    region(V.profiles, [S.sessions.map((s) => [s.playerId, sessionName(s)]), pid, counts], ([list, active, cs]) =>
      list.length < 2 ? [] : [h('span', { class: 'profiles-label', text: 'Switch:' }), ...list.map(([id, name], i) =>
        h('button', {
          class: `profile${id === active ? ' on' : ''}`, 'data-profile': id, 'aria-pressed': String(id === active),
          onclick: () => switchTo(id),
        }, h('span', { text: i === 0 ? `Me · ${name}` : name }), cs[i] > 0 && id !== active && h('span', { class: 'badge', text: String(cs[i]) })))]);

    // The error bar: after 15 s without the Table, or straight away when this phone is offline.
    const showBar = (S.stale || isOffline()) && !!room;
    const mine = ownConnectionDown();
    const rest = restText();
    region(V.stale, [showBar, mine, rest], ([show, m, r]) => show && waitingBlock(false, m, r));
    V.stale.hidden = !showBar;

    // A late joiner's quick rules (11/20 build, Jackson's four lines), for their first 3 cards.
    const late = lateRulesFor(me, room);
    region(V.rules, late ? [howToPages(room).length > 0] : null, (d) => d && h('section', { class: 'quick-rules', 'data-testid': 'quick-rules' },
      h('span', { class: 'quick-rules-title', text: 'Quick rules' }),
      h('ul', { class: 'quick-rules-list' }, QUICK_RULES.map((t) => h('li', { text: t }))),
      d[0] && h('button', { class: 'btn small', type: 'button', 'data-testid': 'quick-rules-more', onclick: () => openHowTo() }, icon('book', 18), 'How to play')));
    V.rules.hidden = !late;

    renderCard(room, pid, priv);

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
    const meter = you.drink ?? null; // 11/20 economy #3 (see drinkMeterLine below)
    region(V.me, [sessionName(me), owe, oweText, bank, meter], ([name, o, ot, b, m]) => [
      h('div', { class: 'me-name' }, h('span', { class: 'dim', text: 'You are' }), h('b', { text: name })),
      h('div', { class: 'me-stats' },
        h('div', { class: `stat owe${o > 0 ? ' hot' : ''}`, 'data-testid': 'owe' }, h('span', { class: 'stat-l', text: 'Owe' }),
          h('span', { class: `stat-n${ot !== String(o) ? ' words' : ''}`, text: ot })),
        h('div', { class: 'stat bank', 'data-testid': 'bank' }, h('span', { class: 'stat-l', text: 'Bank' }), h('span', { class: 'stat-n', text: String(b) }))),
      drinkMeterLine(m),
    ]);

    // Private sections + actions
    const now = Date.now();
    let sections = arr(priv?.sections).map(obj).filter((s) => str(s.id) || str(s.title));
    // Thumb Master power live: everyone gets the same covered box (only the holder's is real),
    // in the very spot the real one would be.
    if (thumbPowerLive(room) && !sections.some((s) => s.id === THUMB_SECTION && s.hidden === true)) {
      sections = withThumbDecoy(sections);
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
    const held = allActions.filter((a) => S.queued[`${pid}:${a.id}`]).map((a) => a.id); // (actionButton reads S.queued)
    region(V.priv, [pid, sections, peeked, allActions, pressed, locked, held], () => [
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

    const hasHowTo = howToPages(room).length > 0 && room?.phase !== 'ended';
    region(V.foot, [S.sessions.length, S.chime, hasHowTo], ([, ch, howTo]) => [
      howTo && h('button', { class: 'btn ghost small', type: 'button', 'data-testid': 'howto-open', onclick: () => openHowTo() }, icon('book'), 'How to play'),
      h('button', { class: 'btn ghost small', 'data-testid': 'add-player', onclick: () => { S.addingPlayer = true; S.joinMode = 'pick'; S.joining = null; render(); } }, icon('userPlus'), 'Someone sharing this phone'),
      chimeToggle(ch, true),
      h('button', { class: 'btn ghost small danger-text', 'data-testid': 'leave', onclick: confirmLeave }, icon('exit'), 'Leave game'),
    ]);
  },

  wrapped() {
    // The Wrapped is here (11/20): its story plays over this screen; closed, it can be opened again.
    const recs = Object.entries(S.wrapped).filter(([, r]) => r && r.wrapped);
    const data = [recs.map(([id, r]) => [id, r.receivedAt, r.name || '']), S.sessions.length, S.room?.phase || null];
    region(V.root, data, () => [
      h('header', { class: 'top' }, brand()),
      h('h1', { class: 'hero wrapped-hero', text: 'Your Wrapped is here.' }),
      h('p', { class: 'lead', text: 'Your night, screen by screen. Open it again any time.' }),
      ...recs.map(([id, r]) => h('button', {
        class: 'btn primary big', type: 'button', 'data-testid': `wrapped-open-${id}`,
        text: recs.length > 1 && r.name ? `Open ${r.name}'s Wrapped` : 'Open your Wrapped', onclick: () => { openStory(id); render(); },
      })),
      S.sessions.length > 0 && h('button', {
        class: 'btn ghost big', 'data-testid': 'back-to-game',
        text: S.room && S.room.phase !== 'ended' ? 'The game is still on — back to the Table' : 'Back to the game',
        onclick: () => { S.showWrappedLanding = false; render(); },
      }),
    ]);
  },
};

// ---------- "This drink: 7 of 10 sips" (11/20 economy review #3) ----------
// Every sip drunk tonight counts toward the next full drink (the Table's "Sips per drink"),
// and a full drink rolls over, so a pile of teeny sips still adds up to a glass. The leader
// sends it as the OPTIONAL `private.you.drink` ({ sips, of, drinks, shots?, text }); an older
// leader sends none and nothing shows. Its "I drank a full drink" button (`drank:one`) is an
// ordinary action, so it needs nothing here.

/** The line under Owe / Bank from `private.you.drink`: the words, and a thin bar for how
 *  far into this drink. Anything missing or malformed: nothing (null). */
function drinkMeterLine(drink) {
  const d = obj(drink);
  const text = str(d.text);
  if (!text) return null;
  const of = Math.max(1, num(d.of, 10));
  const pct = Math.max(0, Math.min(100, Math.round((num(d.sips, 0) / of) * 100)));
  return h('div', { class: 'drink-meter', 'data-testid': 'drink-meter' },
    h('span', { class: 'drink-meter-text', text }),
    h('span', { class: 'drink-meter-bar', 'aria-hidden': 'true' },
      h('span', { class: 'drink-meter-fill', style: { width: `${pct}%` } })));
}

// ---------- the big card ----------

function currentSpotlight(room, pid, priv) {
  if (!pid) return null;
  const card = room && room.card ? obj(room.card) : null;
  const ps = priv && priv.spotlight ? obj(priv.spotlight) : null;
  const targeted = !!card && arr(card.targets).includes(pid);
  if (!targeted && !(ps && str(ps.text))) return null;
  return {
    text: (ps && str(ps.text)) || 'This card is for YOU',
    key: `${pid}|${targeted ? str(card.id) : ''}|${ps ? str(ps.text) : ''}`,
  };
}

function renderCard(room, pid, priv) {
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
    ended: room?.phase === 'ended', hasRecap: !!S.wrapped[pid], howTo: howToPages(room).length > 0,
    card: card && {
      id: str(card.id), kind: str(card.kind), title: str(card.title), text: str(card.text),
      level: num(card.level), accent: safeColor(card.accent, DEFAULT_ACCENT),
      tax: num(card.chickenTax), endsAt: num(obj(card.timer).endsAt),
      taxText: num(card.chickenTax) != null ? drinkAmount(num(card.chickenTax), num(room?.sipsPerDrink), room?.hardLiquor === true) : null,
    },
    spot: spot && spot.text, name: spot ? sessionName(activeSession()) : '',
    // No room yet: whose connection it is, and the resting line kept from before a reload.
    mine: !room && ownConnectionDown(), rest: room ? null : savedRest(),
  };
  region(V.card, data, (d) => {
    if (!d.has) return waitingBlock(true, d.mine, d.rest);
    if (!d.card) {
      // No card up (an interrupt, the Finale): a spotlight still shows (e.g. "THE SNAKE
      // STRUCK YOU", "Settle up: drink 3 sips").
      const idle = h('div', { class: 'card idle' },
        h('div', { class: 'card-band' }, h('span', { class: 'card-kind', text: PHASES[d.phase] || titleCase(d.phase) || 'Last Call' })),
        h('div', { class: 'card-idle-body' },
          h('p', { class: 'card-text', text: d.ended ? "That's a wrap. Thanks for playing!" : 'Eyes on the Table.' }),
          d.ended && d.hasRecap && h('button', { class: 'btn primary', 'data-testid': 'see-wrapped', text: 'See your Wrapped', onclick: () => { openStory(pid); render(); } }),
          d.phase === 'lobby' && d.howTo && h('button', { class: 'btn primary', type: 'button', 'data-testid': 'howto-lobby', onclick: () => openHowTo() }, icon('book', 20), 'How to play'),
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

/**
 * One action button. `inPeek`: it sits inside a peeking section, so its tap mustn't also re-cover it.
 * Pressed while the Table couldn't hear it: "Waiting for the Table…" until it goes (sendAct).
 */
function actionButton(pid, a, sent, locked, inPeek) {
  const style = ACTION_STYLES.includes(a.style) ? a.style : 'normal';
  const held = !sent && !!S.queued[`${pid}:${a.id}`];
  return h('button', {
    class: `btn act ${style}${sent ? ' sent' : ''}${held ? ' held' : ''}`, 'data-action': a.id, disabled: sent || locked || held,
    'data-state': held ? 'held' : sent ? 'sent' : null,
    onclick: (e) => {
      if (inPeek) e.stopPropagation();
      pressAction(pid, a);
    },
  }, sent ? [icon('check', 22), 'Sent'] : held ? [icon('clock', 22), 'Waiting for the Table…']
    : a.photo === true ? [icon('camera', 22), a.label] : a.label);
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
  if (b && !S.bannerMin && hasOpenTap()) S.bannerMin = true;
  // A running card clock also shows on the takeover: nobody pays for a timer they couldn't see.
  // Phase 3 (protocol: banner.endsAt / banner.meter, optional): a banner can carry its own
  // countdown (the Silent Round's minute) and a live level ("quiet" / "loud"). Neither is in
  // the banner's key, so a meter update never replays the takeover or its buzz.
  const card = S.room?.card;
  const own = b ? num(b.endsAt) : null;
  const ends = b && cardTimerRunning(card) ? cardTimerEnds(card) : own;
  const meter = b && (b.meter === 'loud' || b.meter === 'quiet') ? b.meter : null;
  const style = b && BANNER_STYLES.includes(b.style) ? b.style : 'info';
  const meterEl = (m) => m && h('span', { class: `banner-meter m-${m}`, 'data-testid': 'banner-meter', role: 'status',
    'aria-label': m === 'loud' ? 'Loud' : 'Quiet', text: m === 'loud' ? 'LOUD!' : 'QUIET' });
  region(layers.banner, b && [style, str(b.title), str(b.text), S.bannerMin, ends, meter], (d) => {
    if (!d) return [];
    const [st, title, text, min, endsAt, level] = d;
    if (min) {
      return h('button', { class: `banner-strip b-${st}`, onclick: () => { S.bannerMin = false; render(); } },
        h('b', { text: title || 'Heads up' }), text && h('span', { text }),
        endsAt != null && h('span', { class: 'timer strip-timer', 'data-testid': 'strip-timer', 'data-ends-at': String(endsAt), 'aria-label': 'seconds left' }),
        meterEl(level));
    }
    // Full-screen takeover: chip, tilted title sticker, the one-line rule, one huge button.
    return h('div', { class: `banner b-${st}`, role: 'alert', 'data-testid': 'banner' },
      h('div', { class: 'banner-top' },
        h('span', { class: 'banner-chip', text: BANNER_CHIPS[st] }),
        h('span', { class: 'banner-brand', 'aria-hidden': 'true', text: 'LAST CALL' })),
      title && h('div', { class: 'banner-sticker' },
        h('div', { class: 'banner-title', style: { '--fit': String(longestWord(title)) }, text: title })),
      text && h('div', { class: 'banner-text', text }),
      (endsAt != null || level) && h('div', { class: 'banner-live' },
        endsAt != null && h('span', { class: 'timer banner-timer', 'data-testid': 'banner-timer', 'data-ends-at': String(endsAt), 'aria-label': 'seconds left' }),
        meterEl(level)),
      h('button', { class: 'btn ghost', text: 'Got it', onclick: () => { S.bannerMin = true; render(); } }));
  });
}

/**
 * The hand-over (startHandover): for a second after the phone switched player by itself, a
 * full-screen "On this phone now: Jake's turn" sits over the screen and the prompt sheet and
 * swallows every tap. It names only who has the phone (the header says it too). Never over a
 * running Quick Draw (nothing covers a TAP), and under a banner takeover.
 */
function renderHandover(view) {
  const ho = view === 'game' && S.handover && sharedPhone() && !hasOpenTap() ? S.handover : null;
  region(layers.handover, ho ? [ho.pid, turnTitle(ho.pid)] : null, (d) => d && h('div', {
    class: 'handover', 'data-testid': 'handover', 'aria-hidden': 'true',
    // Catch the tap: it was meant for the last player's button.
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); },
  }, h('div', { class: 'handover-card' },
    h('span', { class: 'handover-label', text: 'On this phone now' }),
    h('b', { class: 'handover-name', style: { '--fit': String(longestWord(d[1])) }, text: d[1] }))));
}

/** Someone on this phone has a Quick Draw (tap) prompt still running. */
function hasOpenTap() {
  for (const map of Object.values(S.prompts)) {
    for (const e of map.values()) if (str(e.p.kind) === 'tap' && e.answered === undefined && !isExpired(e.p)) return true;
  }
  return false;
}

// ---------- prompts (bottom sheet) ----------

const promptEls = new Map(); // `${pid}:${id}` -> element (kept so typing survives re-renders)

function renderSheet(view) {
  const pid = S.activeId;
  const show = view === 'game' && !!pid;
  // The player on screen: all their prompts. Anyone else on this phone: only a running Quick
  // Draw TAP (a race can't wait for the phone to come round), labelled with their name.
  const items = [];
  const idle = show && sharedPhone() && phoneIdle();
  if (show) {
    for (const e of S.prompts[pid]?.values() || []) {
      // A hidden-who box: only while nothing else needs the phone; once answered, gone (its
      // "Sent" would point at its player).
      if (isHiddenWho(e) && (!idle || e.answered !== undefined)) continue;
      items.push({ owner: pid, e });
    }
    // Someone ELSE on this phone has a hidden-who box waiting (and the phone is idle): the same
    // nameless covered box here too, so no screen stands out (like the Thumb Master's decoy).
    if (idle && !hiddenWhoWaiting(pid).length && S.sessions.some((s) => s.playerId !== pid && hiddenWhoWaiting(s.playerId).length)) {
      items.push({ owner: pid, e: { p: { id: '__quiet', kind: 'quiet', hideWho: true, secret: true }, decoy: true, receivedAt: 0 } });
    }
    for (const s of S.sessions) {
      if (s.playerId === pid) continue;
      for (const e of S.prompts[s.playerId]?.values() || []) {
        if (str(e.p.kind) === 'tap' && e.answered === undefined && !isExpired(e.p)) items.push({ owner: s.playerId, e });
      }
    }
    items.sort((a, b) => b.e.receivedAt - a.e.receivedAt);
  }
  const entries = items.filter((x) => x.owner === pid && !x.e.decoy).map((x) => x.e);
  // Results: a hidden-who prompt's never shows on a shared phone; a secret one waits behind a tap.
  const results = show ? S.results.filter((r) => r.pid === pid && !(r.quiet && sharedPhone())) : [];

  let sheet = layers.sheet.firstElementChild;
  if (!sheet) {
    sheet = h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }),
      h('div', { class: 'sheet-results' }),
      h('div', { class: 'sheet-list' }));
    layers.sheet.append(sheet);
    // The page leaves room under its foot for the sheet's real height (11/20 final review: with a
    // vote and a bet open, "Leave game" and the chime switch sat under the sheet, unreachable).
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty('--sheet-h', `${sheet.hidden ? 0 : sheet.offsetHeight}px`);
      }).observe(sheet);
    }
  }
  const [head, resultsEl, list] = sheet.children;
  sheet.hidden = !items.length && !results.length;
  sheet.classList.toggle('min', S.sheetMin && items.length > 0);

  const live = (e) => e.answered === undefined && !isExpired(e.p);
  const open = entries.filter((e) => live(e) && ANSWERABLE_KINDS.includes(str(e.p.kind))).length;
  // A kind this page can't answer (a newer Table's): it only says "Look at the Table for this one".
  const lookOnly = entries.some((e) => live(e) && !ANSWERABLE_KINDS.includes(str(e.p.kind)));
  const sent = entries.some((e) => e.answered !== undefined);
  // Only a hidden-who box (real or decoy) on the sheet: the same neutral title on every screen.
  const quietOnly = items.length > 0 && items.every((x) => x.e.decoy || isHiddenWho(x.e));
  // On a shared phone the sheet says whose it is, big: "Sam's vote".
  const whose = sharedPhone() && open > 0 && !quietOnly ? turnTitle(pid) : null;
  region(head, [items.length, open, sent, S.sheetMin, whose, quietOnly, lookOnly], ([n, o, any, min, w, q, look]) => n === 0 ? [] : [
    // "Sent" only if something was really answered; a prompt that just ran out says so.
    h('span', {
      class: `sheet-title${w ? ' whose' : ''}`, 'data-testid': 'sheet-title',
      text: q ? 'Something private' : w || (o > 0 ? `Your move${o > 1 ? ` · ${o}` : ''}` : any ? 'Sent'
        : look ? 'Look at the Table' : n > entries.length ? 'Quick Draw' : "Time's up"),
    }),
    h('button', { class: 'btn ghost small', text: min ? 'Show' : 'Hide', onclick: () => { S.sheetMin = !S.sheetMin; render(); } }),
  ]);
  const resultRows = results.map((r) => {
    const k = `${pid}:result:${r.key}`;
    return [r.title, r.text, r.secret && sharedPhone() ? (S.secretOpen[k] ? 'open' : 'covered') : 'plain', k];
  });
  region(resultsEl, resultRows, (rs) =>
    rs.map(([title, text, look, k]) => {
      if (look === 'covered') {
        // Nothing about it shows (not even the question's title) until its player taps. Its 20 s
        // only start then: until it's opened once it waits (11/20 final review).
        return h('button', {
          class: 'result secret-result', type: 'button', 'data-testid': 'prompt-result', 'data-secret': 'covered',
          onclick: () => {
            S.secretOpen[k] = true;
            const r = S.results.find((x) => `${pid}:result:${x.key}` === k);
            if (r) resultSeen(r);
            render();
          },
        }, icon('eye', 22), h('span', { class: 'result-text', text: 'Private result · Tap to see' }));
      }
      return h('div', { class: `result${look === 'open' ? ' secret-result open' : ''}`, 'data-testid': 'prompt-result' },
        title && h('div', { class: 'result-title', text: title }), h('div', { class: 'result-text', text }),
        look === 'open' && h('button', {
          class: 'btn hide-secret', type: 'button', 'data-testid': 'result-hide', text: 'Hide',
          onclick: () => { delete S.secretOpen[k]; render(); },
        }));
    }));

  // Keyed reconciliation: reuse existing elements; never detach the one being typed in.
  const wanted = new Set();
  items.forEach(({ owner, e }, i) => {
    const key = `${owner}:${e.p.id}`;
    wanted.add(key);
    const covered = e.decoy || secretCovered(owner, e);
    const named = sharedPhone() && str(e.p.kind) === 'tap';
    const sig = JSON.stringify([e.p, e.answered, e.label, covered, named, sharedPhone(), !!e.decoy]);
    let el = promptEls.get(key);
    if (!el || el._sig !== sig) {
      const fresh = buildPrompt(owner, e, { covered, named });
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
  if (!before || !after) return;
  if (!after.value && before.value) {
    after.value = before.value;
    after.dispatchEvent(new Event('input'));
  }
  if (document.activeElement === before) {
    const [a, b] = [before.selectionStart, before.selectionEnd];
    queueMicrotask(() => {
      after.focus();
      try { after.setSelectionRange(a, b); } catch { /* ignore */ }
    });
  }
}

function buildPrompt(pid, entry, opts = {}) {
  const p = entry.p;
  const kind = str(p.kind);
  const answered = entry.answered !== undefined;
  const key = `${pid}:${p.id}`;
  const who = sessionName(S.sessions.find((s) => s.playerId === pid));
  const timer = num(p.endsAt) != null && h('span', { class: 'p-timer', 'data-ends-at': String(p.endsAt) });
  // A secret prompt (a mission being written, a sealed bid, a Showdown stake…) on a shared
  // phone: nothing about it shows until its player taps it open. Its clock still runs.
  if (opts.covered) {
    // A hidden-who box (and its decoy on everyone else's screen) says no name, and shows no clock.
    const quiet = p.hideWho === true;
    const open = entry.decoy
      ? () => toast("Not for you. Whoever it's for: switch to your name, then tap it.", 3000)
      : () => { S.secretOpen[key] = true; render(); };
    const covered = h('section', {
      class: 'prompt secret-covered', 'data-prompt': entry.decoy ? null : p.id, 'data-pid': pid, 'data-secret': 'covered',
      'data-quiet': quiet ? '1' : null,
    },
      h('button', { class: 'secret-open', type: 'button', 'data-testid': 'secret-open', onclick: open }, icon('eye', 30),
        h('span', { class: 'peek-text', text: quiet ? 'Something private for someone on this phone' : `${who}: something private for you` }),
        h('span', { class: 'peek-sub', text: 'Tap to open' })),
      !quiet && timer);
    if (num(p.endsAt) != null) covered.dataset.expires = String(p.endsAt);
    return covered;
  }
  const secret = p.secret === true || p.hideWho === true; // (hideWho always comes with secret)
  // Answered and secret: just "Sent" (what was typed or bid never sits on screen). On a shared
  // phone not even its title (11/20 review fix: "Strike: who's on the next card?" said it all).
  if (secret && answered) {
    return h('section', { class: 'prompt answered secret-sent', 'data-prompt': p.id, 'data-pid': pid, 'data-kind': kind },
      !sharedPhone() && h('div', { class: 'p-head' }, h('h3', { class: 'p-title', text: str(p.title) || 'Quick question' })),
      h('div', { class: 'p-state', 'data-testid': 'secret-sent' }, 'Sent', icon('check', 16)));
  }
  // Anonymous vote: never echo the name back ("Sent: Alex" sat on screen for 20 s).
  const anon = p.anonymous === true;
  const fs = h('fieldset', { disabled: answered || (isLockable(p) && tapsLocked()) });
  const opened = secret && sharedPhone();
  const title = opts.named ? `${who}: ${str(p.title) || 'Quick Draw'}` : str(p.title) || 'Quick question';
  const el = h('section', {
    class: `prompt k-${kind || 'unknown'}${answered ? ' answered' : ''}${opened ? ' secret-open' : ''}`,
    'data-prompt': p.id, 'data-kind': kind, 'data-pid': pid,
  },
  h('div', { class: 'p-head' },
    h('h3', { class: 'p-title', text: title }),
    timer,
    // Opened on a shared phone: "Hide" covers it again (so does the phone switching player).
    opened && h('button', {
      class: 'btn hide-secret', type: 'button', 'data-testid': 'secret-hide', text: 'Hide',
      onclick: () => { delete S.secretOpen[key]; render(); },
    })),
  opened && h('div', { class: 'priv-note' }, icon('eyeOff', 18), `Only ${who} should see this`),
  str(p.text) && h('p', { class: 'p-text', text: p.text }),
  anon && h('div', { class: 'pill anon', text: 'Anonymous' }),
  fs,
  answered && anon
    ? h('div', { class: 'p-state', 'data-testid': 'vote-sent' }, 'Vote sent', icon('check', 16))
    : h('div', { class: 'p-state', text: answered ? `Sent: ${entry.label}` : '' }));
  if (num(p.endsAt) != null) el.dataset.expires = String(p.endsAt);
  if (isLockable(p)) el.dataset.lockable = '1';
  if (opts.named) el.dataset.tapLabel = `${who}: TAP!`;

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
    const s = num(p.step, 1); // (`step` is optional: an absent one used to give "NaN", 11/20 final review)
    const step = s > 0 ? s : 1;
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
    // A number prompt with `options` (Phase 2b: a bet's picks, a loan's lenders, a deal's
    // buyers, "Bid") has one send button per option; the one tapped goes along as `option`.
    // Otherwise a single Send.
    const sendOpts = arr(p.options).map(obj).filter((o) => str(o.id));
    fs.append(h('div', { class: 'stepper' }, minus, out, plus),
      sendOpts.length
        ? h('div', { class: `options num-sends${sendOpts.length > 4 ? ' many' : ''}` }, sendOpts.map((o, i) =>
          h('button', {
            class: `btn ${i === 0 ? 'primary' : 'opt'} send-opt`, 'data-send-option': o.id, text: str(o.label) || o.id,
            onclick: () => answer(pid, p.id, value, `${value} · ${str(o.label) || o.id}`, o.id),
          })))
        : h('button', { class: 'btn primary big', 'data-testid': 'send-number', text: 'Send', onclick: () => send(value, String(value)) }));
    set(value);
    if (answered) minus.disabled = plus.disabled = true;
  } else if (kind === 'text') {
    const maxLength = Math.max(1, Math.min(2000, num(p.maxLength, 280)));
    const ta = h('textarea', {
      class: 'text-in', rows: 3, maxlength: maxLength, placeholder: str(p.placeholder) || 'Type it out…',
      autocomplete: 'off', 'aria-label': str(p.title) || 'Your answer',
    });
    if (answered) ta.value = String(entry.answered);
    else ta.value = draftFor(pid, p.id); // typed before it was covered, or before the tab reloaded
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
    ta.addEventListener('input', () => saveDraft(pid, p.id, ta.value));
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
          if (!session) return;
          // (Not held for later like a card button: it only helps with this open question.)
          if (tableUnreachable()) toast("The Table can't hear you right now. Try again once it's back.", 3000);
          else sendPrivate(session.secret, 'act', { actionId: a.id });
        },
      }))));
  }
  return el;
}

function armTap(el) {
  el.classList.add('armed');
  const zone = el.querySelector('.tap-zone');
  if (!zone) return;
  // Whose TAP it is (several players on one phone each get their own button).
  const pid = el.dataset.pid || S.activeId;
  const id = el.dataset.prompt;
  zone.replaceChildren(h('button', {
    class: `btn tap${el.dataset.tapLabel ? ' named' : ''}`, 'data-testid': 'tap', text: el.dataset.tapLabel || 'TAP!',
    onpointerdown: (e) => { e.preventDefault(); answer(pid, id, 'tap', 'TAP'); },
    onclick: () => answer(pid, id, 'tap', 'TAP'),
  }));
  buzz(120);
  chime(); // Quick Draw is armed: a face-down phone hears it
}

// ---------- Wrapped: the story (11/20 build) ----------
// Jackson 11/20: Wrapped at the end of the game only (no noon "Morning-After" comeback), and "really
// improve how this looks": a full-screen story, one big moment per screen, tapped (right = next, the
// left third = back) or swiped through, with a progress bar across the top. Fun first, numbers small.
// The slides come from the Table (`wrapped.story`, protocol §wrapped); an older leader's Wrapped (or
// one stored by an older page) has none, so the page makes a plain story from its title / stats /
// lines. The page draws whatever slides it gets: it knows no game rules.

const STORY_KINDS = ['intro', 'number', 'person', 'quote', 'list', 'photos', 'summary'];
const STORY_YELLOW = '#FFD23F';
// Dark slide colors become their light partner: the story stays on the yellow theme, ink text.
const STORY_LIGHT = { '#111111': '#FF9FCE', '#9B5DE5': '#FF9FCE', '#3A86FF': '#7FD1FF', '#2EC4B6': '#7FD1FF', '#1F5FD1': '#7FD1FF' };
const lightColor = (c, fallback) => {
  const safe = safeColor(c, fallback);
  return STORY_LIGHT[String(safe).toUpperCase()] || safe;
};

/** One slide, every field checked (the wire can send anything). */
function storySlide(raw) {
  const s = obj(raw);
  return {
    kind: STORY_KINDS.includes(str(s.kind)) ? str(s.kind) : 'number',
    id: str(s.id).slice(0, 40),
    kicker: str(s.kicker),
    big: str(s.big),
    title: str(s.title),
    sticker: str(s.sticker),
    quote: str(s.quote),
    lines: arr(s.lines).map(str).filter(Boolean).slice(0, 8),
    rows: arr(s.rows).map(obj).map((r) => [str(r.label), str(r.value)]).filter(([l, v]) => l || v).slice(0, 12),
    color: lightColor(s.color, STORY_YELLOW),
    accent: s.accent == null ? null : safeColor(s.accent, null),
  };
}

/** A stored Wrapped's screens: the Table's story, or (an older one) a plain story from its parts. */
function storySlides(rec) {
  const w = obj(rec && rec.wrapped);
  const sent = arr(w.story).map(storySlide)
    // (The photos live on the Table's phone only; a guest never gets that screen.)
    .filter((s) => s.kind !== 'photos' && (s.kicker || s.big || s.title || s.quote || s.lines.length || s.rows.length));
  return sent.length ? sent : olderStory(rec);
}

/** An older Wrapped (title, stats, lines; no story) as a story: who, the number, the lines a few at a
 *  time, and the tiles on the last screen. */
function olderStory(rec) {
  const w = obj(rec && rec.wrapped);
  const stats = arr(w.stats).map(obj).filter((x) => str(x.label));
  const lines = arr(w.lines).map(str).filter(Boolean);
  const out = [storySlide({
    kind: 'intro', id: 'intro', kicker: 'LAST CALL · WRAPPED', big: rec?.name || str(w.title) || 'Your night',
    title: str(w.title) || "Here's your night.", sticker: 'TAP TO START', color: STORY_YELLOW, accent: '#FF5A36',
  })];
  const sips = stats.find((x) => /^sips taken$/i.test(str(x.label)));
  if (sips) {
    out.push(storySlide({ kind: 'number', id: 'you', kicker: 'YOUR NIGHT IN ONE NUMBER', big: str(sips.value),
      title: str(sips.value) === '1' ? 'sip you took' : 'sips you took', color: '#FF5A36', accent: STORY_YELLOW }));
  }
  const colors = ['#FF9FCE', '#9BE564', '#7FD1FF'];
  for (let i = 0; i < lines.length; i += 3) {
    out.push(storySlide({ kind: 'list', id: `older-${i / 3}`, kicker: i === 0 ? 'YOUR NIGHT' : 'AND THEN…',
      lines: lines.slice(i, i + 3), color: colors[(i / 3) % colors.length] }));
  }
  out.push(storySlide({ kind: 'summary', id: 'summary', kicker: 'THAT WAS YOUR NIGHT', big: str(w.title) || 'Your night',
    sticker: 'WRAPPED', rows: stats.slice(0, 6).map((x) => ({ label: str(x.label), value: str(x.value) })),
    color: STORY_YELLOW, accent: '#FF5A36' }));
  return out;
}

/** Open a player's Wrapped at its first screen. */
function openStory(pid) {
  S.recap = pid || null;
  S.storyIndex = 0;
}

function closeStory() {
  S.recap = null;
  render();
}

function storyGo(i) {
  const rec = S.recap && S.wrapped[S.recap];
  if (!rec) return;
  const n = storySlides(rec).length;
  S.storyIndex = Math.max(0, Math.min(n - 1, i));
  render();
}

/** Right / left: the next screen, the one before. */
const storyStep = (d) => storyGo(S.storyIndex + d);

function renderStory(view) {
  const pid = view === 'game' || view === 'wrapped' ? S.recap : null;
  const rec = pid && S.wrapped[pid];
  const slides = rec ? storySlides(rec) : [];
  const i = Math.max(0, Math.min(S.storyIndex, slides.length - 1));
  const who = rec && sharedPhone() ? rec.name || sessionName(S.sessions.find((x) => x.playerId === pid)) : '';
  region(layers.recap, rec ? [pid, rec.receivedAt, i, slides.length, who] : null, () => {
    if (!rec || !slides.length) return null;
    const s = slides[i];
    const last = i === slides.length - 1;
    const el = h('div', {
      class: `overlay story kind-${s.kind}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Your Wrapped',
      'data-testid': 'wrapped-story', 'data-slide': s.id || s.kind, 'data-index': String(i),
      style: { '--story-bg': s.color, '--story-accent': s.accent || 'var(--ink)', '--story-accent-text': s.accent ? 'var(--ink)' : 'var(--surface)' },
    },
    h('div', { class: 'story-progress', 'aria-hidden': 'true' }, slides.map((_, k) => h('i', { class: k <= i ? 'on' : null }))),
    h('div', { class: 'story-top' },
      h('span', { class: 'story-brand', text: 'Last Call · Wrapped' }),
      h('span', { class: 'story-count', text: `${i + 1} / ${slides.length}` }),
      h('button', { class: 'btn small story-close', type: 'button', 'data-testid': 'story-close', text: 'Close', onclick: closeStory })),
    who && h('div', { class: 'story-who', text: `${who}'s Wrapped` }),
    h('div', { class: 'story-body', 'data-testid': 'story-body' },
      s.kicker && h('span', { class: 'story-kicker', text: s.kicker }),
      s.sticker && h('span', { class: 'story-sticker', text: s.sticker }),
      s.big && h('h2', {
        class: `story-big${s.big.length <= 6 ? ' huge' : ''}`, 'data-testid': 'story-big', text: s.big,
        style: { '--fit': String(longestWord(s.big)) },
      }),
      s.title && h('p', { class: 'story-title', text: s.title }),
      s.quote && h('blockquote', { class: 'story-quote', 'data-testid': 'story-quote' }, h('span', { class: 'story-quote-band', 'aria-hidden': 'true' }), h('p', { text: s.quote })),
      s.lines.length > 0 && h('div', { class: 'story-lines' }, s.lines.map((l) => h('p', { text: l }))),
      s.rows.length > 0 && h('ul', { class: 'story-rows' }, s.rows.map(([l, v]) =>
        h('li', { class: 'story-row' }, l && h('b', { text: l }), v && h('span', { text: v }))))),
    h('div', { class: 'story-foot' },
      last
        ? [
          h('button', { class: 'btn primary big', type: 'button', 'data-testid': 'story-done', text: 'Close', onclick: closeStory }),
          h('button', { class: 'btn small', type: 'button', 'data-testid': 'story-again', text: 'See it again', onclick: () => storyGo(0) }),
        ]
        : [
          h('button', { class: 'btn small', type: 'button', 'data-testid': 'story-back', text: 'Back', disabled: i === 0, onclick: () => storyStep(-1) }),
          h('span', { class: 'story-hint', text: i === 0 ? 'Tap to start' : 'Tap for more' }),
          h('button', { class: 'btn small story-next', type: 'button', 'data-testid': 'story-next', text: 'Next', onclick: () => storyStep(1) }),
        ]));
    // Tap anywhere (not a button): the left third goes back, the rest goes on.
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const box = el.getBoundingClientRect();
      storyStep(e.clientX - box.left < box.width * 0.3 ? -1 : 1);
    });
    swipeable(el, storyStep);
    return el;
  });
}

/** Left / right swipes on `el` call step(+1) / step(-1). */
function swipeable(el, step) {
  let x0 = null;
  let y0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0]?.clientX ?? null; y0 = e.touches[0]?.clientY ?? null; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = (t?.clientX ?? x0) - x0;
    const dy = (t?.clientY ?? y0) - y0;
    x0 = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault(); // a swipe isn't also a tap
      step(dx < 0 ? 1 : -1);
    }
  });
}

// ---------- How to play (11/20 build) ----------
// The Table sends tonight's pages in the room (`room.howTo`, optional): only the parts that are on.
// They open by themselves once per room while everyone waits in the lobby (Skip any time), and again
// from "How to play" (the lobby card, the foot, a late joiner's quick rules). An older leader sends
// none: no walkthrough.

/** Tonight's pages from the room, every field checked. */
function howToPages(room) {
  return arr(room?.howTo).map(obj)
    .map((p) => ({ id: str(p.id).slice(0, 40), title: str(p.title), lines: arr(p.lines).map(str).filter(Boolean).slice(0, 6), color: lightColor(p.color, STORY_YELLOW) }))
    .filter((p) => p.title && p.lines.length);
}

function openHowTo() {
  if (!howToPages(S.room).length) return;
  S.howTo = { index: 0, auto: false };
  render();
}

function closeHowTo() {
  S.howTo = null;
  store.setHowToSeen(S.roomId);
  render();
}

function howToGo(i) {
  const n = howToPages(S.room).length;
  if (!S.howTo || !n) return;
  if (i >= n) return closeHowTo();
  S.howTo.index = Math.max(0, i);
  render();
}

function renderHowTo(view) {
  const pages = view === 'game' && S.howTo ? howToPages(S.room) : [];
  const i = pages.length ? Math.max(0, Math.min(S.howTo.index, pages.length - 1)) : 0;
  region(layers.howto, pages.length ? [pages, i] : null, () => {
    if (!pages.length) return null;
    const p = pages[i];
    const last = i === pages.length - 1;
    const el = h('div', {
      class: 'overlay howto', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How to play',
      'data-testid': 'howto', 'data-page': p.id, 'data-index': String(i), style: { '--howto-bg': p.color },
    },
    h('div', { class: 'howto-top' },
      h('span', { class: 'howto-count', text: `How to play · ${i + 1} of ${pages.length}` }),
      h('button', { class: 'btn small', type: 'button', 'data-testid': 'howto-skip', text: 'Skip', onclick: closeHowTo })),
    h('div', { class: 'howto-body' },
      h('h2', { class: 'howto-title', 'data-testid': 'howto-title', text: p.title, style: { '--fit': String(longestWord(p.title)) } }),
      h('ol', { class: 'howto-lines' }, p.lines.map((l, k) => h('li', {}, h('b', { class: 'howto-n', text: String(k + 1) }), h('span', { text: l }))))),
    h('div', { class: 'howto-dots', 'aria-hidden': 'true' }, pages.map((_, k) => h('i', { class: k === i ? 'on' : null }))),
    h('div', { class: 'howto-foot' },
      i > 0 && h('button', { class: 'btn small', type: 'button', 'data-testid': 'howto-back', text: 'Back', onclick: () => howToGo(i - 1) }),
      h('button', { class: 'btn primary big', type: 'button', 'data-testid': 'howto-next', text: last ? "Let's play" : 'Next', onclick: () => howToGo(i + 1) })),
    h('p', { class: 'howto-note', text: 'Phone locked? Just open this page again.' }));
    swipeable(el, (d) => howToGo(i + d));
    return el;
  });
}

// ---------- A late joiner's quick rules (11/20 build) ----------
// Jackson's four lines, for anyone who joins once the cards have started, for their first 3 cards
// (the cards dealt from when they got in). The page decides this on its own (any leader works).

const QUICK_RULES = ['Do it, or pay the tax.', 'Owe is your tab.', 'Bank is sips you can give away.', 'Phone locked? Reopen this page.'];
const QUICK_RULES_CARDS = 3;
const PLAYING = ['warmup', 'main', 'lastcall'];

/** A player who just got in on this page: late (the cards are going) or not. No room yet: decide
 *  at the first one. Returns the session. */
function markLate(session) {
  if (!S.room) {
    session.lateCheck = true;
    return session;
  }
  delete session.lateCheck;
  if (PLAYING.includes(str(S.room.phase))) session.lateUntil = num(S.room.cardCount, 0) + QUICK_RULES_CARDS;
  return session;
}

/** Show the quick rules to this player now? */
function lateRulesFor(session, room) {
  if (!session || !room || !PLAYING.includes(str(room.phase))) return false;
  const until = num(session.lateUntil);
  return until != null && num(room.cardCount, 0) < until;
}

// ---------- Photo Proof sheet ----------

/** The photo sheet: take it, check it, send it (with progress), or say why it didn't go. */
function renderPhoto(view) {
  const ph = view === 'game' ? S.photo : null;
  // Folded away (photoFold): during a Quick Draw / Bank Heist (11/20 review fix: the sheet sat over
  // the TAP and the no-show was charged) and for a timed question that came in meanwhile (11/20
  // final review), as a small strip at the top; under a fresh takeover (11/20 final review: the
  // Mirror pose fired under the sheet) not at all, the takeover is the screen. The upload keeps
  // going, and the sheet comes back once the race / question / takeover is over.
  const fold = ph ? photoFold() : null;
  const data = ph && [ph.pid, ph.status, ph.sent, ph.count, ph.checking === true, ph.error, ph.attempt, ph.label, ph.text, fold];
  region(photoBox, data, () => {
    if (!ph) return [];
    if (fold === 'banner') return [];
    if (fold) {
      const after = fold === 'tap' ? 'Waiting for you after the race' : 'Back after this question';
      const what = ph.status === 'sending' ? `Sending… ${ph.sent} of ${ph.count}` : ph.status === 'sent' ? 'Sent to the Table' : after;
      return h('div', { class: 'photo-strip', role: 'status', 'data-testid': 'photo-strip', 'data-fold': fold },
        icon('camera', 18), h('b', { text: 'Photo proof' }), h('span', { text: what }));
    }
    const who = sharedPhone() ? sessionName(S.sessions.find((s) => s.playerId === ph.pid)) : '';
    const preview = ph.prepared && h('img', { class: 'photo-preview', 'data-testid': 'photo-preview', src: ph.prepared.dataUrl, alt: 'Your photo' });
    const cancel = h('button', { class: 'btn ghost', type: 'button', 'data-testid': 'photo-cancel', text: 'Cancel', onclick: closePhoto });
    const skip = h('button', { class: 'btn ghost', type: 'button', 'data-testid': 'photo-skip', text: 'Send without a photo', onclick: sendWithoutPhoto });
    let body;
    if (ph.status === 'pick') {
      body = [
        h('button', { class: 'btn primary big', type: 'button', 'data-testid': 'photo-take', onclick: takePhoto }, icon('camera', 26), 'Take the photo'),
        skip, cancel,
      ];
    } else if (ph.status === 'preparing') {
      body = [h('div', { class: 'waiting' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('div', { class: 'waiting-title', text: 'Getting it ready…' })), cancel];
    } else if (ph.status === 'preview') {
      body = [
        preview,
        h('button', { class: 'btn primary big', type: 'button', 'data-testid': 'photo-send', text: 'Send it', onclick: sendPhoto }),
        h('button', { class: 'btn normal', type: 'button', 'data-testid': 'photo-retake', text: 'Take it again', onclick: takePhoto }),
        cancel,
      ];
    } else if (ph.status === 'sending') {
      const pct = ph.count ? Math.round((ph.sent / ph.count) * 100) : 0;
      body = [
        preview,
        h('div', { class: 'photo-progress', 'data-testid': 'photo-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
          h('div', { class: 'photo-bar' }, h('i', { style: { width: `${pct}%` } })),
          h('span', { text: ph.checking ? 'Checking with the Table…' : `Sending… ${ph.sent} of ${ph.count}` })),
        cancel,
      ];
    } else if (ph.status === 'sent') {
      body = [preview, h('div', { class: 'p-state photo-done', 'data-testid': 'photo-sent' }, icon('check', 18), 'Sent to the Table')];
    } else if (ph.status === 'moved') {
      // The Table took this button away meanwhile (the dare was skipped, the card moved on):
      // nothing more goes out for it (11/20 final review).
      body = [
        h('div', { class: 'notice bad', 'data-testid': 'photo-moved', text: "This card has moved on, so the photo didn't go." }),
        h('button', { class: 'btn primary big', type: 'button', 'data-testid': 'photo-close', text: 'Close', onclick: closePhoto }),
      ];
    } else {
      body = [
        preview,
        h('div', { class: 'notice bad', 'data-testid': 'photo-error', text: ph.error || "It didn't send." }),
        ph.prepared
          ? h('button', { class: 'btn primary big', type: 'button', 'data-testid': 'photo-retry', text: 'Try again', onclick: sendPhoto })
          : h('button', { class: 'btn primary big', type: 'button', 'data-testid': 'photo-take', onclick: takePhoto }, icon('camera', 26), 'Take it again'),
        ph.prepared && h('button', { class: 'btn normal', type: 'button', 'data-testid': 'photo-retake', text: 'Take a new one', onclick: takePhoto }),
        skip, cancel,
      ];
    }
    return h('div', { class: 'overlay photo-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo proof', 'data-testid': 'photo-sheet', 'data-status': ph.status },
      h('div', { class: 'photo-card' },
        h('div', { class: 'photo-kicker' }, icon('camera', 18), who ? `Photo proof · ${who}` : 'Photo proof'),
        h('h2', { class: 'photo-title', text: ph.label }),
        ph.text && h('p', { class: 'photo-text', text: ph.text }),
        body,
        h('p', { class: 'photo-note', text: 'It goes only to the Table\'s phone. Nothing is posted or saved here.' })));
  });
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
