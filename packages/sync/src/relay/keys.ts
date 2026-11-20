// A sync chain's keys, as SyncCrypto.swift makes them, so a phone and a computer read each other's files: from the
// chain's 32 random bytes (the recovery phrase's entropy), HKDF-SHA256 with the salt `bay-sync/v1` gives the file key
// (AES-256-GCM over each file, its chain, scope and name bound in as associated data) and the name key (HMAC-SHA256
// of a label, the first 16 bytes in base32: a chain's or a scope's name, which says nothing of what it is). The relay
// secret, also from the entropy, proves to the relay that a device holds the key; the relay keeps only its SHA-256.
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base32, base64url, concat, utf8 } from "./bytes.ts";

/** Random bytes from the platform: crypto.getRandomValues, or a native module where there is none. */
export type Random = (length: number) => Uint8Array;

export const systemRandom: Random = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

const MAGIC = utf8("NNS1");
const SALT = utf8("bay-sync/v1");
const PADDING = 1024;
const NONCE = 12;
const TAG = 16;

/** Why a file didn't open: it isn't a sealed file, or it was changed, moved or sealed with another key. */
export class SealError extends Error {
  readonly reason: "format" | "authentication";

  constructor(reason: "format" | "authentication") {
    super(reason === "format" ? "Not a sync file" : "A sync file didn't open with this key");
    this.reason = reason;
  }
}

export class SyncKeys {
  /** The chain's 32 bytes: the recovery phrase's entropy. */
  readonly entropy: Uint8Array;
  readonly fileKey: Uint8Array;
  readonly nameKey: Uint8Array;
  /** The bearer secret a relay knows this chain by. */
  readonly relaySecret: string;
  readonly chainTag: string;
  private readonly random: Random;

  constructor(entropy: Uint8Array, random: Random = systemRandom) {
    if (entropy.length !== 32) throw new Error("A sync key is 32 bytes");

    this.entropy = entropy;
    this.random = random;
    this.fileKey = hkdf(sha256, entropy, SALT, utf8("file-key"), 32);
    this.nameKey = hkdf(sha256, entropy, SALT, utf8("name-key"), 32);
    this.relaySecret = base64url(hkdf(sha256, entropy, SALT, utf8("relay-auth"), 32));
    this.chainTag = this.tag("chain");
  }

  scopeTag(scope: string): string {
    return this.tag(`scope/${scope}`);
  }

  private tag(label: string): string {
    return base32(hmac(sha256, this.nameKey, utf8(label)).subarray(0, 16));
  }

  private associatedData(scopeTag: string, fileId: string): Uint8Array {
    return concat(MAGIC, utf8(`${this.chainTag}/${scopeTag}/${fileId}`));
  }

  /** A new file's name: 16 random bytes in base32. */
  newFileId(): string {
    return base32(this.random(16));
  }

  /**
   * A payload sealed as a sync file: its length, the payload, zeros to the next kilobyte (so sizes say little), all
   * AES-GCM sealed under the file key. `nonce` is for tests; a file always gets a fresh random one.
   */
  seal(payload: Uint8Array, scopeTag: string, fileId: string, nonce: Uint8Array = this.random(NONCE)): Uint8Array {
    const length = 4 + payload.length;
    const plain = new Uint8Array(length + ((PADDING - (length % PADDING)) % PADDING));

    new DataView(plain.buffer).setUint32(0, payload.length);
    plain.set(payload, 4);

    // noble writes the tag after the ciphertext, as the file keeps them.
    const sealed = gcm(this.fileKey, nonce, this.associatedData(scopeTag, fileId)).encrypt(plain);

    return concat(MAGIC, nonce, sealed);
  }

  open(file: Uint8Array, scopeTag: string, fileId: string): Uint8Array {
    if (file.length < MAGIC.length + NONCE + TAG + 4 || !MAGIC.every((byte, i) => file[i] === byte)) throw new SealError("format");

    let plain: Uint8Array;

    try {
      const nonce = file.subarray(MAGIC.length, MAGIC.length + NONCE);

      plain = gcm(this.fileKey, nonce, this.associatedData(scopeTag, fileId)).decrypt(file.subarray(MAGIC.length + NONCE));
    } catch {
      throw new SealError("authentication");
    }

    const length = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);

    if (length > plain.length - 4) throw new SealError("format");

    return plain.slice(4, 4 + length);
  }
}
