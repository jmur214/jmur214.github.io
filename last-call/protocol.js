// protocol.js — small, game-agnostic pieces of last-call-protocol.md:
// envelopes, the URL fragment, seq-gap tracking and the leader-clock offset.

export const PROTOCOL_VERSION = 1;

// roomId / secret: 22 chars of [A-Za-z0-9_-] per the protocol. We accept 16–64 so a
// future length change doesn't lock guests out, but never other characters (they end
// up inside channel names).
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PLAYER_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;

// The Table's public key (11/20 security): base64url of a compressed (33 bytes = 44 chars) or raw
// (65 bytes = 87 chars) P-256 point. crypto.js checks it really is one.
const LEADER_KEY_RE = /^[A-Za-z0-9_-]{43,88}$/;

export const isRoomId = (s) => typeof s === 'string' && ID_RE.test(s);
export const isSecret = isRoomId;
export const isPlayerId = (s) => typeof s === 'string' && PLAYER_ID_RE.test(s);
export const isLeaderKey = (s) => typeof s === 'string' && LEADER_KEY_RE.test(s);

/**
 * Reads `#r=<roomId>[&s=<secret>&p=<playerId>][&k=<the Table's public key>]`. Invalid parts come
 * back as null. `k` (11/20 security) only counts with a room: it's that room's Table.
 */
export function parseFragment(hash) {
  const out = { r: null, s: null, p: null, k: null };
  if (typeof hash !== 'string' || hash.length < 2) return out;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const r = params.get('r');
  const s = params.get('s');
  const p = params.get('p');
  const k = params.get('k');
  if (isRoomId(r)) out.r = r;
  if (out.r && isSecret(s) && isPlayerId(p)) {
    out.s = s;
    out.p = p;
  }
  if (out.r && isLeaderKey(k)) out.k = k;
  return out;
}

export const roomChannel = (roomId) => `lc-${roomId}`;
export const privateChannel = (secret) => `lcp-${secret}`;

/** Builds one wire envelope. `at` is the sender's estimate of leader-clock ms. */
export function makeEnvelope(t, body, from, seq, at) {
  return { v: PROTOCOL_VERSION, t, seq, from, at: Math.round(at), body: body || {} };
}

/** True for something we can act on. Unknown `t` is still "valid" (the caller ignores it). */
export function isEnvelope(e) {
  return !!e && typeof e === 'object' && e.v === PROTOCOL_VERSION && typeof e.t === 'string';
}

/**
 * Tracks the leader's seq per channel.
 * check() returns: 'first' (nothing seen yet), 'ok' (+1), 'gap' (skipped ahead),
 * 'reset' (went backwards: leader restarted / resumed), or 'none' (no numeric seq).
 */
export class SeqTracker {
  constructor() {
    this.last = new Map();
  }
  check(channel, seq) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return 'none';
    const prev = this.last.get(channel);
    this.last.set(channel, seq);
    if (prev === undefined) return 'first';
    if (seq === prev + 1) return 'ok';
    if (seq > prev + 1) return 'gap';
    return 'reset';
  }
  lastSeq(channel) {
    return this.last.get(channel) ?? 0;
  }
  forget(channel) {
    this.last.delete(channel);
  }
}

/**
 * Leader clock. offset = envelope.at − Date.now(), median of the last few leader messages
 * (the median shrugs off one slow delivery). leaderNow() is what endsAt / armAt compare to.
 */
export class LeaderClock {
  constructor(size = 7) {
    this.size = size;
    this.samples = [];
    this.offset = 0;
  }
  sample(at) {
    if (typeof at !== 'number' || !Number.isFinite(at)) return;
    this.samples.push(at - Date.now());
    if (this.samples.length > this.size) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    this.offset = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  get synced() {
    return this.samples.length > 0;
  }
  leaderNow() {
    return Date.now() + this.offset;
  }
  /** Converts a leader-clock time to this device's clock (for things stored for later). */
  toLocal(leaderMs) {
    return leaderMs - this.offset;
  }
}
