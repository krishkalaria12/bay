// Bytes in the forms sync names and sends them: lowercase base32 (the tags and file names, as SyncCrypto.swift
// writes them), base64 and base64url, hex, and UTF-8.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Lowercase base32 without padding: SyncCrypto.swift's `Base32.encode`. */
export function base32(data: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }

    buffer &= (1 << bits) - 1;
  }

  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];

  return out;
}

/** A tag: 16 bytes in base32, the length every chain, scope and file name has. */
export const isTag = (name: string): boolean => /^[a-z2-7]{26}$/.test(name);

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(data: Uint8Array): string {
  let out = "";

  for (let i = 0; i < data.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [data[i], data[i + 1], data[i + 2]];
    const word = (a << 16) | (b << 8) | c;

    out += BASE64[(word >> 18) & 63]! + BASE64[(word >> 12) & 63]!;
    out += i + 1 < data.length ? BASE64[(word >> 6) & 63]! : "=";
    out += i + 2 < data.length ? BASE64[word & 63]! : "=";
  }

  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;

  for (const char of clean) {
    const value = BASE64.indexOf(char);

    if (value < 0) throw new Error("Not base64");

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }

  return out.subarray(0, at);
}

export const base64url = (data: Uint8Array): string => base64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const hex = (data: Uint8Array): string => [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);

  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);

  return out;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const fromUtf8 = (data: Uint8Array): string => new TextDecoder().decode(data);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;

  return diff === 0;
}
