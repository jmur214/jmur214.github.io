// crypto.js — the join handshake from last-call-protocol.md §Joining.
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
