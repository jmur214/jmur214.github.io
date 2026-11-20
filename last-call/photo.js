// photo.js — Photo Proof's camera-side helpers (Jackson 11/19: "they were supposed to have to
// take pictures but nothing for that"). Pure helpers, no game rules:
//
//   preparePhoto(file)  -> shrink the camera's photo to at most 1024 px on its long side and
//                          re-encode it as a JPEG (quality 0.7) on a canvas. Re-encoding drops
//                          the camera's EXIF data, location included. Returns the base64, its
//                          size, its SHA-256 (base64url) and a data: URL for the preview.
//   splitChunks(b64)    -> the base64 in pieces small enough for one Realtime message each.
//
// The photo goes ONLY to the leader's phone, over this player's secret private channel
// (protocol: `photo_chunk` / `photo_ack`): plain JSON on a channel whose name is an unguessable
// secret handed over in the sealed join, sent over TLS. It is NOT end-to-end encrypted, and the
// relay (Supabase Realtime broadcast) stores nothing. Nothing is uploaded anywhere else, and
// nothing is saved on this phone.

export const PHOTO_MAX_SIDE = 1024;
export const PHOTO_QUALITY = 0.7;
// Base64 characters per piece. A piece plus its envelope stays far under the leader's 64 KB
// inbound limit and Supabase Realtime's message size (protocol: "Photo Proof").
export const CHUNK_CHARS = 24000;
// A JPEG bigger than this after shrinking is encoded again at a lower quality.
const MAX_BYTES = 900000;

/** Decode the picked file. createImageBitmap applies the camera's rotation; the fallback reads
 *  it as a data: URL (the page's CSP allows data: images, not blob:). */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* older Safari: no options object, or an odd file. Try the other way. */
    }
  }
  const url = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of the bytes, base64url without padding (what the leader checks). */
export async function sha256b64url(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToB64url(new Uint8Array(digest));
}

/**
 * The picked photo, ready to send: { dataUrl, b64, bytes, hash, width, height }.
 * Throws if the file isn't a picture this browser can open.
 */
export async function preparePhoto(file) {
  const src = await decode(file);
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new Error('empty image');
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // a see-through PNG turns white, not black, as a JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(src, 0, 0, width, height);
  if (typeof src.close === 'function') src.close();
  let dataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
  let b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if ((b64.length * 3) / 4 > MAX_BYTES) {
    dataUrl = canvas.toDataURL('image/jpeg', 0.5);
    b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  }
  if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('no JPEG encoder');
  const bytes = base64ToBytes(b64);
  return { dataUrl, b64, bytes: bytes.length, hash: await sha256b64url(bytes), width, height };
}

/** The base64 in pieces of at most `size` characters, in order. */
export function splitChunks(b64, size = CHUNK_CHARS) {
  const out = [];
  for (let i = 0; i < b64.length; i += size) out.push(b64.slice(i, i + size));
  return out;
}
