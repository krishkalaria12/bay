// The recovery phrase, as RecoveryPhrase.swift writes and reads it: the chain key's 32 bytes and the first byte of
// their SHA-256 as 24 BIP-39 English words. A word may be typed by its first four letters or more.
import { sha256 } from "@noble/hashes/sha2.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const PHRASE_WORDS = 24;

/** Why a phrase didn't read. */
export type PhraseProblem = { kind: "wordCount"; count: number } | { kind: "unknownWord"; word: string } | { kind: "checksum" };

export function phraseWords(entropy: Uint8Array): string[] {
  if (entropy.length !== 32) throw new Error("A sync key is 32 bytes");

  const bits = [...entropy, sha256(entropy)[0]!].flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => (byte >> shift) & 1));
  const words: string[] = [];

  for (let start = 0; start < bits.length; start += 11) {
    words.push(wordlist[bits.slice(start, start + 11).reduce((index, bit) => (index << 1) | bit, 0)]!);
  }

  return words;
}

const lookup = new Map(wordlist.map((word, index) => [word, index]));
const prefixes = new Map(wordlist.map((word, index) => [word.slice(0, 4), index]));

function indexOf(token: string): number | undefined {
  const exact = lookup.get(token);

  if (exact !== undefined || token.length < 4) return exact;

  const index = prefixes.get(token.slice(0, 4));

  return index !== undefined && wordlist[index]!.startsWith(token) ? index : undefined;
}

/** A phrase's words as typed: letters only, lowercase. */
export const phraseTokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

/** The chain key a phrase holds, or why it holds none. */
export function phraseEntropy(text: string): { entropy: Uint8Array } | { problem: PhraseProblem } {
  const tokens = phraseTokens(text);

  if (tokens.length !== PHRASE_WORDS) return { problem: { kind: "wordCount", count: tokens.length } };

  const bits: number[] = [];

  for (const token of tokens) {
    const index = indexOf(token);

    if (index === undefined) return { problem: { kind: "unknownWord", word: token } };

    for (let shift = 10; shift >= 0; shift--) bits.push((index >> shift) & 1);
  }

  const entropy = new Uint8Array(32);

  for (let i = 0; i < 32; i++) entropy[i] = bits.slice(i * 8, i * 8 + 8).reduce((byte, bit) => (byte << 1) | bit, 0);

  const checksum = bits.slice(256).reduce((byte, bit) => (byte << 1) | bit, 0);

  return sha256(entropy)[0] === checksum ? { entropy } : { problem: { kind: "checksum" } };
}
