// How many bytes we feed to String.fromCharCode at a time. Spreading the whole
// array at once overflows the call stack past roughly 100k arguments on most JS
// engines, so we build the binary string up in 32 KB slices instead.
const CHUNK = 0x8000;

export function bytesToBase64url(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function base64urlToBytes(encoded: string): Uint8Array {
  if (encoded.length === 0) return new Uint8Array(0);
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
