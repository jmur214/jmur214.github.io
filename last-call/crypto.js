// crypto.js — the join handshake from last-call-protocol.md §Joining, and (11/20 security) the
// check that a message on the room channel really came from the Table (§The Table signs the room).
//
// Only WebCrypto (crypto.subtle), so it runs in every modern browser on HTTPS and in
// Node 20+ (tests/crypto-vectors.mjs imports this same file).
//
//   page:   ECDH P-256 key pair, sends its raw 65-byte public key (base64url)
//   leader: ephemeral P-256 key pair, shared = ECDH(leader priv, page pub)  -> 32 bytes (x-coordinate)
//           key    = HKDF-SHA256(ikm = shared, salt = "last-call-v1", info = requestId) -> 32 bytes
//           ct     = AES-256-GCM(key, iv = 12 random bytes, no AAD) -> ciphertext || 16-byte tag
//   page:   same shared secret from ECDH(page priv, leader pub), same key, decrypts.

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export const HKDF_SALT = 'last-call-v1';
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

// ---------- base64url (no padding) ----------

export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('not base64url');
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `nBytes` random bytes as base64url. 9 bytes -> 12 chars (requestId), 16 bytes -> 22 chars (ids/secrets). */
export function randomId(nBytes) {
  return b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(nBytes)));
}

// ---------- key handling ----------

/** The page's throwaway key pair. The private key is not extractable; it never leaves memory. */
export function generateJoinKeyPair(extractable = false) {
  return subtle.generateKey(CURVE, extractable, ['deriveBits']);
}

/** Raw uncompressed public key (0x04 || X || Y, 65 bytes) as base64url. */
export async function exportPublicKey(publicKey) {
  return b64urlEncode(await subtle.exportKey('raw', publicKey));
}

function importPublicKey(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('public key must be 65-byte uncompressed P-256');
  }
  return subtle.importKey('raw', raw, CURVE, false, []);
}

/** ECDH shared secret (32-byte x-coordinate). Exported for the test-vector script. */
export async function sharedSecret(privateKey, peerPublicRaw) {
  const peer = await importPublicKey(peerPublicRaw);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
}

/** HKDF-SHA256(shared, salt "last-call-v1", info requestId) -> 32 raw key bytes. */
export async function hkdfKeyBytes(shared, requestId) {
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(HKDF_SALT), info: utf8.encode(requestId) },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

async function aesKey(privateKey, peerPublicRaw, requestId, usage) {
  const keyBytes = await hkdfKeyBytes(await sharedSecret(privateKey, peerPublicRaw), requestId);
  return subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [usage]);
}

// ---------- the two halves of the handshake ----------

const SECRET_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * PAGE side. Decrypts a `join_ok` body ({lpub, iv, ct}) with our private key.
 * Returns { secret, playerId }. Throws on any tampering (GCM tag check) or bad shape.
 */
export async function openJoinReply(privateKey, body, requestId) {
  const lpub = b64urlDecode(body.lpub);
  const iv = b64urlDecode(body.iv);
  const ct = b64urlDecode(body.ct);
  if (iv.length !== 12) throw new Error('iv must be 12 bytes');
  if (ct.length < 17) throw new Error('ciphertext too short');
  const key = await aesKey(privateKey, lpub, requestId, 'decrypt');
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ct);
  const obj = JSON.parse(fromUtf8.decode(plain));
  if (!obj || typeof obj.secret !== 'string' || !SECRET_RE.test(obj.secret)) throw new Error('bad secret');
  if (typeof obj.playerId !== 'string' || !obj.playerId) throw new Error('bad playerId');
  return { secret: obj.secret, playerId: obj.playerId };
}

/**
 * LEADER side (the Swift app does this for real; used here by tests and the vector script).
 * Encrypts `payload` (an object) to the page's public key. `opts.leaderKeyPair` / `opts.iv`
 * let the vector script make the output deterministic.
 */
export async function sealJoinReply(pagePubB64, requestId, payload, opts = {}) {
  const leader = opts.leaderKeyPair || (await generateJoinKeyPair());
  const iv = opts.iv || globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(leader.privateKey, b64urlDecode(pagePubB64), requestId, 'encrypt');
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8.encode(JSON.stringify(payload)));
  return { lpub: await exportPublicKey(leader.publicKey), iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
}

// ---------- the Table's signature (11/20 security, protocol §The Table signs the room) ----------
//
// The room QR and every per-player link carry the Table's public key in the fragment (`k`). The
// Table signs every message it sends on the ROOM channel (`room`, `join_ok`, `join_no`) with the
// matching private key, which never leaves its phone. A page that was given `k` drops anything on
// the room channel that claims to be the Table but doesn't verify, so a prankster's fake card or
// hijacking `join_ok` goes nowhere. No `k` (an older QR / older Table): nothing is checked.
//
//   signed bytes = canonical([ "last-call-sig-v1", roomId, v, t, seq, from, at, body ])
//   envelope.sig = base64url( ECDSA P-256 / SHA-256 signature, raw r || s, 64 bytes )
//   k            = base64url( compressed SEC1 public key, 33 bytes ) (65-byte uncompressed also read)
//
// canonical(value) is a small tagged, length-prefixed byte format, the same on the Swift side
// (LastCallCrypto.canonicalBytes), so both sides sign / check exactly the same bytes whatever
// order or spacing the JSON travelled in:
//   null 'n' · false 'f' · true 't'
//   number 'd' + 8 bytes IEEE-754 double, big-endian (-0 written as 0)
//   string 's' + u32 big-endian UTF-8 length + the UTF-8 bytes
//   array  'a' + u32 count + each value
//   object 'o' + u32 count + (key as a string, value) for each key, keys sorted by their UTF-8 bytes

export const SIG_TAG = 'last-call-sig-v1';
const SIGN_ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_HASH = { name: 'ECDSA', hash: 'SHA-256' };

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** The canonical bytes of a JSON value (see above). Throws on anything that isn't plain JSON. */
export function canonicalBytes(value) {
  const parts = [];
  let size = 0;
  const push = (u8) => {
    parts.push(u8);
    size += u8.length;
  };
  const head = (tag, n) => {
    const b = new Uint8Array(5);
    b[0] = tag.charCodeAt(0);
    new DataView(b.buffer).setUint32(1, n);
    push(b);
  };
  const walk = (v, depth) => {
    if (depth > 64) throw new Error('too deep');
    if (v === null) return push(Uint8Array.of(0x6e)); // 'n'
    if (v === false) return push(Uint8Array.of(0x66)); // 'f'
    if (v === true) return push(Uint8Array.of(0x74)); // 't'
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('not a finite number');
      const b = new Uint8Array(9);
      b[0] = 0x64; // 'd'
      new DataView(b.buffer).setFloat64(1, v === 0 ? 0 : v); // -0 === 0, so -0 is written as 0
      return push(b);
    }
    if (typeof v === 'string') {
      const bytes = utf8.encode(v);
      head('s', bytes.length);
      return push(bytes);
    }
    if (Array.isArray(v)) {
      head('a', v.length);
      for (const x of v) walk(x, depth + 1);
      return undefined;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v).map((k) => [utf8.encode(k), k]).sort((a, b) => compareBytes(a[0], b[0]));
      head('o', keys.length);
      for (const [kb, k] of keys) {
        head('s', kb.length);
        push(kb);
        walk(v[k], depth + 1);
      }
      return undefined;
    }
    throw new Error('not a JSON value');
  };
  walk(value, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The bytes the Table signs for one room-channel envelope: binds the room, the type, seq and time. */
export function leaderSignedBytes(roomId, env) {
  return canonicalBytes([SIG_TAG, roomId, env.v, env.t, env.seq, env.from, env.at, env.body]);
}

// P-256: y² = x³ − 3x + b over p. A compressed key (0x02 / 0x03 ‖ X) is opened here, because not
// every browser's WebCrypto imports one. BigInt(…) calls, not 1n literals, so a browser without
// BigInt still loads this file (it just can't check signatures, and the page carries on as before).
function decompressP256(raw) {
  const B = (x) => BigInt(x);
  const p = B('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  const b = B('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
  const hexOf = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
  const x = B(`0x${hexOf(raw.subarray(1, 33))}`);
  if (x >= p) throw new Error('bad point');
  const pow = (base, exp) => {
    let r = B(1);
    let q = base % p;
    let e = exp;
    while (e > B(0)) {
      if (e & B(1)) r = (r * q) % p;
      q = (q * q) % p;
      e >>= B(1);
    }
    return r;
  };
  const y2 = (((((x * x) % p) * x - B(3) * x + b) % p) + p) % p;
  let y = pow(y2, (p + B(1)) / B(4)); // p ≡ 3 (mod 4), so this is a square root
  if ((y * y) % p !== y2) throw new Error('not on the curve');
  if ((y & B(1)) !== B(raw[0] & 1)) y = p - y;
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(raw.subarray(1, 33), 1);
  const yHex = y.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) out[33 + i] = parseInt(yHex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The raw uncompressed public key (65 bytes) for a `k` from a link: compressed (33) or raw (65). */
export function leaderKeyBytes(k) {
  const raw = b64urlDecode(k);
  if (raw.length === 33 && (raw[0] === 2 || raw[0] === 3)) return decompressP256(raw);
  if (raw.length === 65 && raw[0] === 4) return raw;
  throw new Error('leader key must be a 33- or 65-byte P-256 point');
}

/** The Table's public key (`k` from the link) as a verify-only CryptoKey. Rejects if it can't. */
export async function importLeaderKey(k) {
  return subtle.importKey('raw', leaderKeyBytes(k), SIGN_ALG, false, ['verify']);
}

/** True only if `env.sig` is the Table's signature over this room's signed bytes. Never throws. */
export async function verifyLeaderEnvelope(publicKey, roomId, env) {
  try {
    if (!env || typeof env.sig !== 'string') return false;
    const sig = b64urlDecode(env.sig);
    if (sig.length !== 64) return false;
    return await subtle.verify(SIGN_HASH, publicKey, sig, leaderSignedBytes(roomId, env));
  } catch {
    return false;
  }
}

/**
 * The Table's half (the Swift app does this for real: LastCallCrypto.signedRoomEnvelope). Used by
 * the vector script. `privateKey` is an ECDSA P-256 signing CryptoKey. Returns the `sig` string.
 */
export async function signLeaderEnvelope(privateKey, roomId, env) {
  return b64urlEncode(await subtle.sign(SIGN_HASH, privateKey, leaderSignedBytes(roomId, env)));
}
