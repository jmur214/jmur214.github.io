// storage.js — everything the page keeps in localStorage. Every access is wrapped in
// try/catch: private mode, blocked storage or a full quota must never break the game
// (the page just forgets on reload).
//
//   lc.session.<roomId>   [{ roomId, secret, playerId, name?, savedAt }]   (protocol: "stores an array")
//   lc.active.<roomId>    playerId of the profile last shown
//   lc.lastRoom           roomId of the most recent game (for visits without a #fragment)
//   lc.wrapped.<roomId>   { <playerId>: { wrapped, name, localShowAt, receivedAt } }
//   lc.chime              true / false: "Chime when it's my turn" (every game; on unless turned off)
//   lc.rest.<roomId>      { text, at }: the last `room.rest` line (Bar Crawl: walking between bars),
//                         so a page opened mid-walk reads as resting before any room arrives. 2 h.
//
// And in sessionStorage (this tab only, gone when the tab closes):
//   lc.draft.<roomId>.<playerId>.<promptId>   what's typed in a text prompt, until it's sent

import { isRoomId, isSecret, isPlayerId } from './protocol.js';

const KEEP_MS = 7 * 24 * 3600 * 1000; // forget games older than a week
const REST_KEEP_MS = 2 * 3600 * 1000; // a resting line older than 2 hours means nothing any more

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function keys() {
  try {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
    return out;
  } catch {
    return [];
  }
}

// ---------- sessions ----------

export function loadSessions(roomId) {
  let list = read(`lc.session.${roomId}`, []);
  if (list && !Array.isArray(list)) list = [list]; // tolerate a single object
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s) => s && s.roomId === roomId && isSecret(s.secret) && isPlayerId(s.playerId),
  );
}

export function saveSessions(roomId, sessions) {
  if (!sessions.length) return remove(`lc.session.${roomId}`);
  write(
    `lc.session.${roomId}`,
    sessions.map((s) => ({
      roomId: s.roomId,
      secret: s.secret,
      playerId: s.playerId,
      name: s.name || undefined,
      savedAt: s.savedAt || Date.now(),
    })),
  );
}

export const getActive = (roomId) => read(`lc.active.${roomId}`, null);
export const setActive = (roomId, playerId) => write(`lc.active.${roomId}`, playerId);

export function getLastRoom() {
  const r = read('lc.lastRoom', null);
  return isRoomId(r) ? r : null;
}
export const setLastRoom = (roomId) => write('lc.lastRoom', roomId);

// ---------- chime setting ----------

/** On by default: only an explicit "off" turns it off. */
export const getChime = () => read('lc.chime', true) !== false;
export const setChime = (on) => write('lc.chime', !!on);

// ---------- wrapped ----------

export function loadWrapped(roomId) {
  const all = read(`lc.wrapped.${roomId}`, {});
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

export function saveWrapped(roomId, playerId, record) {
  const all = loadWrapped(roomId);
  all[playerId] = record;
  write(`lc.wrapped.${roomId}`, all);
}

// ---------- the resting line (Bar Crawl, 11/20 final review) ----------

/** The last `room.rest` text for this room, if it's under 2 hours old; else null. */
export function getRest(roomId, now = Date.now()) {
  const r = read(`lc.rest.${roomId}`, null);
  if (!r || typeof r.text !== 'string' || !r.text || typeof r.at !== 'number') return null;
  return now - r.at < REST_KEEP_MS && r.at <= now + 60000 ? r.text : null;
}

/** Remember the room's resting line (`text`), or forget it (null: the room isn't resting). */
export function setRest(roomId, text) {
  if (!roomId) return;
  if (text) write(`lc.rest.${roomId}`, { text: String(text).slice(0, 300), at: Date.now() });
  else remove(`lc.rest.${roomId}`);
}

// ---------- drafts (sessionStorage, 11/20 final review) ----------

const draftKey = (roomId, playerId, promptId) => `lc.draft.${roomId}.${playerId}.${promptId}`;

/** What was typed in a text prompt before the tab reloaded, or null. */
export function getDraft(roomId, playerId, promptId) {
  try {
    const v = sessionStorage.getItem(draftKey(roomId, playerId, promptId));
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** Keep what's typed (an empty `text` forgets it). */
export function setDraft(roomId, playerId, promptId, text) {
  if (!roomId || !playerId || !promptId) return;
  try {
    if (text) sessionStorage.setItem(draftKey(roomId, playerId, promptId), String(text).slice(0, 2000));
    else sessionStorage.removeItem(draftKey(roomId, playerId, promptId));
  } catch {
    /* private mode / full: the draft just lives in memory */
  }
}

// ---------- housekeeping ----------

/** Drops sessions and recaps from games more than a week old, and resting lines over 2 hours. */
export function prune(now = Date.now()) {
  for (const k of keys()) {
    if (!k) continue;
    if (k.startsWith('lc.rest.')) {
      const r = read(k, null);
      if (!r || typeof r.at !== 'number' || now - r.at >= REST_KEEP_MS) remove(k);
    } else if (k.startsWith('lc.session.')) {
      const list = read(k, []);
      const fresh = Array.isArray(list) ? list.filter((s) => s && now - (s.savedAt || now) < KEEP_MS) : [];
      if (!fresh.length) {
        remove(k);
        remove(k.replace('lc.session.', 'lc.active.'));
      } else if (fresh.length !== list.length) write(k, fresh);
    } else if (k.startsWith('lc.wrapped.')) {
      const all = read(k, {});
      const recs = all && typeof all === 'object' ? Object.values(all) : [];
      if (!recs.some((r) => r && now - (r.receivedAt || 0) < KEEP_MS)) remove(k);
    }
  }
}
