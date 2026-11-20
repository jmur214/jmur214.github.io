// storage.js — everything the page keeps in localStorage. Every access is wrapped in
// try/catch: private mode, blocked storage or a full quota must never break the game
// (the page just forgets on reload).
//
//   lc.session.<roomId>   [{ roomId, secret, playerId, name?, savedAt }]   (protocol: "stores an array")
//   lc.active.<roomId>    playerId of the profile last shown
//   lc.lastRoom           roomId of the most recent game (for visits without a #fragment)
//   lc.wrapped.<roomId>   { <playerId>: { wrapped, name, localShowAt, receivedAt } }
//   lc.chime              true / false: "Chime when it's my turn" (every game; on unless turned off)

import { isRoomId, isSecret, isPlayerId } from './protocol.js';

const KEEP_MS = 7 * 24 * 3600 * 1000; // forget games older than a week

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

// ---------- housekeeping ----------

/** Drops sessions and recaps from games more than a week old. */
export function prune(now = Date.now()) {
  for (const k of keys()) {
    if (!k) continue;
    if (k.startsWith('lc.session.')) {
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
