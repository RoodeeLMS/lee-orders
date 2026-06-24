// WebCrypto helpers — AES-256-GCM with PBKDF2(SHA-256) key derivation.
// Blob layout (base64): salt(16) | iv(12) | ciphertext | gcmTag(16)
const PBKDF2_ITERATIONS = 150000;

function b64ToBytes(b64) {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

async function deriveKey(password, salt, usages) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

// Returns the decrypted UTF-8 string, or throws if the password is wrong / data corrupt.
async function decryptBlob(b64, password) {
  const raw = b64ToBytes(b64);
  const salt = raw.slice(0, 16);
  const iv = raw.slice(16, 28);
  const data = raw.slice(28); // ciphertext + 16-byte GCM tag
  const key = await deriveKey(password, salt, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(pt);
}

// Returns base64 blob. Used by the admin encrypt tool.
async function encryptText(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ['encrypt']);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
  );
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(16 + 12 + ctBytes.length);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(ctBytes, 28);
  return bytesToB64(out);
}

export { decryptBlob, encryptText };
