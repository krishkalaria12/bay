// The TypeScript keys against the Mac's: fixtures/golden.json was made by CryptoKit with SyncCrypto.swift
// (packages/sync/windows/tests/generate-vectors.swift on feat/windows), so a file sealed on either side opens on the
// other. And the recovery phrase is BIP-39's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import * as v from "valibot";

import { fromHex, fromUtf8, hex, utf8 } from "./bytes.ts";
import { SealError, SyncKeys } from "./keys.ts";
import { phraseEntropy, phraseWords } from "./phrase.ts";

const GoldenSchema = v.object({
  entropy: v.string(),
  chainTag: v.string(),
  scope: v.string(),
  scopeTag: v.string(),
  fileId: v.string(),
  nonce: v.string(),
  payload: v.string(),
  sealed: v.string(),
});

const golden = v.parse(GoldenSchema, JSON.parse(readFileSync(new URL("../../fixtures/golden.json", import.meta.url), "utf8")));
const keys = new SyncKeys(fromHex(golden.entropy));

test("the chain's and a scope's names are the Mac's", () => {
  assert.equal(keys.chainTag, golden.chainTag);
  assert.equal(keys.scopeTag(golden.scope), golden.scopeTag);
});

test("a file sealed here is byte for byte the one CryptoKit sealed, and the Mac's opens here", () => {
  const sealed = keys.seal(utf8(golden.payload), golden.scopeTag, golden.fileId, fromHex(golden.nonce));

  assert.equal(hex(sealed), golden.sealed);
  assert.equal(fromUtf8(keys.open(fromHex(golden.sealed), golden.scopeTag, golden.fileId)), golden.payload);
});

test("a changed file, or one moved to another scope or name, doesn't open", () => {
  const sealed = fromHex(golden.sealed);

  for (const at of [0, 20, sealed.length - 1]) {
    const changed = sealed.slice();

    changed[at]! ^= 1;
    assert.throws(() => keys.open(changed, golden.scopeTag, golden.fileId), SealError);
  }

  assert.throws(() => keys.open(sealed, keys.scopeTag("another-profile"), golden.fileId), SealError);
  assert.throws(() => keys.open(sealed, golden.scopeTag, "zzzzzzzzzzzzzzzzzzzzzzzzzz"), SealError);
});

test("a fresh file seals and opens, padded to a kilobyte", () => {
  const sealed = keys.seal(utf8("hello"), golden.scopeTag, keys.newFileId());

  assert.equal(sealed.length, 4 + 12 + 1024 + 16);
});

test("the recovery phrase is BIP-39's, and reads back from its four-letter prefixes", () => {
  const entropy = fromHex(golden.entropy);
  const words = phraseWords(entropy);

  assert.equal(words.join(" "), entropyToMnemonic(entropy, wordlist));
  assert.deepEqual(phraseEntropy(words.join(" ")), { entropy });
  assert.deepEqual(
    phraseEntropy(
      words
        .map((word) => word.slice(0, 4))
        .join(", ")
        .toUpperCase(),
    ),
    { entropy },
  );
  assert.deepEqual(phraseEntropy(words.slice(1).join(" ")), { problem: { kind: "wordCount", count: 23 } });
  assert.deepEqual(phraseEntropy([...words.slice(0, 23), "zzzz"].join(" ")), { problem: { kind: "unknownWord", word: "zzzz" } });
  assert.deepEqual(phraseEntropy([...words.slice(0, 23), words[0]].join(" ")).hasOwnProperty("problem"), words[23] !== words[0]);
});
