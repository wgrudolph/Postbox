// Web Crypto helpers: AES-GCM token encryption, HMAC session signing, PKCE.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- encoding ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

// ---------- constant-time comparison ----------

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Constant-time string comparison that does not leak length: both inputs are
 * HMAC'd with a per-call random key, then the fixed-length digests compared.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  return timingSafeEqualBytes(new Uint8Array(da), new Uint8Array(db));
}

// ---------- HMAC (session cookies) ----------

async function hmacKey(secretB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(secretB64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hmacSign(data: string, secretB64: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secretB64), enc.encode(data));
  return bytesToBase64Url(new Uint8Array(sig));
}

export async function hmacVerify(data: string, signature: string, secretB64: string): Promise<boolean> {
  const expected = await hmacSign(data, secretB64);
  return timingSafeEqualBytes(enc.encode(expected), enc.encode(signature));
}

// ---------- AES-GCM (token storage) ----------

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyB64);
  if (raw.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypts a string. Output: base64(12-byte IV || ciphertext+tag). */
export async function encryptString(plaintext: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), enc.encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return bytesToBase64(out);
}

export async function decryptString(payload: string, keyB64: string): Promise<string> {
  const bytes = base64ToBytes(payload);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), ct);
  return dec.decode(pt);
}

// ---------- PKCE ----------

const PKCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** 64 random characters from the RFC 7636 unreserved alphabet (66 chars, rejection-sampled). */
export function pkceVerifier(length = 64): string {
  let out = "";
  while (out.length < length) {
    const buf = crypto.getRandomValues(new Uint8Array(length));
    for (const b of buf) {
      if (b >= 198) continue; // keep 0..197 (3 × 66) so every character is equally likely
      out += PKCE_ALPHABET[b % 66];
      if (out.length === length) break;
    }
  }
  return out;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}
