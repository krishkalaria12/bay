// Pairing a new device with one already syncing, by a code, after Yab's (docs/sync.md, "The key and the account",
// Apache-2.0). The new device shows eight characters and waits under them with a one-time X25519 key; you type them
// on the device that syncs, which finds the key, and both show four digits worked out from the code and the key. Once
// you say they match, it seals the chain's key to the new device's key and leaves the envelope in the box.
//
// The relay never sees the code: it's stretched by PBKDF2, and HKDF of that names the box, tags the waiting key (so a
// relay that swaps in a key of its own fails the tag) and salts the envelope's key. The four digits catch anyone who
// read the code off the screen and got in first.
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as v from "valibot";

import { base64, concat, equal, fromBase64, hex, utf8 } from "./bytes.ts";
import { systemRandom, type Random } from "./keys.ts";
import { DEFAULT_RELAY, RelayError, type Fetch } from "./transport.ts";

/** The code's letters: no 0, O, 1 or I, which read alike. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const CODE_LENGTH = 8;

/** Rounds of PBKDF2: enough that trying every code within a box's ten minutes is out of reach, quick on a phone. */
const ROUNDS = 20_000;

const KEY = 32;
const TAG = 32;
const NONCE = 12;

/** A code as typed: its letters and digits, uppercase, without the dash or spaces. */
export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Whether a typed code has all its characters, from the code's own letters. */
export const isCode = (code: string): boolean => code.length === CODE_LENGTH && [...code].every((char) => ALPHABET.includes(char));

/** A code to show: ABCD-EFGH. */
export const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export function newCode(random: Random = systemRandom): string {
  return [...random(CODE_LENGTH)].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

/** What a code stretches to: the box's name, the key that tags the waiting key, the envelope's salt. */
interface Stretched {
  box: string;
  tagKey: Uint8Array;
  joinSalt: Uint8Array;
}

function stretch(code: string): Stretched {
  const seed = pbkdf2(sha256, utf8(code), utf8("bay sync pairing v1"), { c: ROUNDS, dkLen: KEY });
  const derive = (info: string) => hkdf(sha256, seed, undefined, utf8(info), KEY);

  return { box: hex(derive("box")), tagKey: derive("pub-tag"), joinSalt: derive("join") };
}

/** The four digits both screens show: from the code and the waiting key, so a swapped key shows others. */
export function checkDigits(code: string, pub: Uint8Array): string {
  const digest = sha256(concat(utf8("bay sync check v1"), utf8(code), pub));
  const number = new DataView(digest.buffer, digest.byteOffset).getUint32(0) % 10_000;

  return String(number).padStart(4, "0");
}

const PubSchema = v.object({ pub: v.string(), envelope: v.optional(v.string()) });
const ErrorSchema = v.object({ error: v.string() });

async function call(fetcher: Fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch {
    throw new RelayError(0, "offline");
  }
}

async function refusal(reply: Response): Promise<RelayError> {
  const body: unknown = await reply.json().catch(() => null);

  return new RelayError(reply.status, v.is(ErrorSchema, body) ? body.error : "unknown");
}

/** The new device's side: wait under a code for the chain's key. */
export class Waiting {
  readonly code: string;
  readonly digits: string;
  private readonly secret: Uint8Array;
  private readonly pub: Uint8Array;
  private readonly stretched: Stretched;
  private readonly url: string;
  private readonly fetcher: Fetch;

  private constructor(code: string, secret: Uint8Array, url: string, fetcher: Fetch) {
    this.code = code;
    this.secret = secret;
    this.pub = x25519.getPublicKey(secret);
    this.stretched = stretch(code);
    this.digits = checkDigits(code, this.pub);
    this.url = url;
    this.fetcher = fetcher;
  }

  /** Posts a fresh code's waiting key; a code someone else holds already is tried again with another. */
  static async start({
    url = DEFAULT_RELAY,
    fetch: fetcher = fetch,
    random = systemRandom,
  }: { url?: string; fetch?: Fetch; random?: Random } = {}): Promise<Waiting> {
    for (let attempt = 0; ; attempt++) {
      const waiting = new Waiting(newCode(random), random(KEY), url, fetcher);
      const tag = hmac(sha256, waiting.stretched.tagKey, concat(utf8("bay sync pub v1"), waiting.pub));

      const reply = await call(fetcher, `${url}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ box: waiting.stretched.box, pub: base64(concat(waiting.pub, tag)) }),
      });

      if (reply.ok) return waiting;

      if (reply.status !== 409 || attempt >= 2) throw await refusal(reply);
    }
  }

  /** The chain's key, once the other device has sealed it here; null while it hasn't, or when the box ran out. */
  async poll(): Promise<{ entropy: Uint8Array } | { expired: true } | null> {
    const reply = await call(this.fetcher, `${this.url}/v1/pair/${this.stretched.box}`);

    if (reply.status === 404) return { expired: true };

    if (!reply.ok) throw await refusal(reply);

    const body = v.parse(PubSchema, await reply.json());

    if (!body.envelope) return null;

    const envelope = fromBase64(body.envelope);
    const theirs = envelope.subarray(0, KEY);
    const nonce = envelope.subarray(KEY, KEY + NONCE);
    const key = joinKey(x25519.getSharedSecret(this.secret, theirs), this.stretched.joinSalt, theirs, this.pub);
    const entropy = gcm(key, nonce, utf8("bay sync join v1")).decrypt(envelope.subarray(KEY + NONCE));

    if (entropy.length !== KEY) throw new RelayError(200, "envelope");

    return { entropy };
  }
}

function joinKey(shared: Uint8Array, salt: Uint8Array, sender: Uint8Array, receiver: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, salt, concat(utf8("bay sync join v1"), sender, receiver), KEY);
}

/** The syncing device's side: a typed code's waiting device, its digits, and letting it in. */
export class Joining {
  readonly digits: string;
  private readonly pub: Uint8Array;
  private readonly stretched: Stretched;
  private readonly url: string;
  private readonly fetcher: Fetch;
  private readonly random: Random;

  private constructor(code: string, pub: Uint8Array, stretched: Stretched, url: string, fetcher: Fetch, random: Random) {
    this.pub = pub;
    this.stretched = stretched;
    this.digits = checkDigits(code, pub);
    this.url = url;
    this.fetcher = fetcher;
    this.random = random;
  }

  /**
   * The device waiting under a code, or why there's none: no one waits under it (mistyped, or it ran out), or the key
   * there wasn't tagged with the code (posted by someone who doesn't know it).
   */
  static async find(
    code: string,
    { url = DEFAULT_RELAY, fetch: fetcher = fetch, random = systemRandom }: { url?: string; fetch?: Fetch; random?: Random } = {},
  ): Promise<Joining | "not-found" | "not-verified" | "taken"> {
    const stretched = stretch(code);
    const reply = await call(fetcher, `${url}/v1/pair/${stretched.box}`);

    if (reply.status === 404) return "not-found";

    if (!reply.ok) throw await refusal(reply);

    const body = v.parse(PubSchema, await reply.json());

    if (body.envelope) return "taken";

    const posted = fromBase64(body.pub);
    const pub = posted.subarray(0, KEY);
    const tag = posted.subarray(KEY);
    const expected = hmac(sha256, stretched.tagKey, concat(utf8("bay sync pub v1"), pub));

    if (tag.length !== TAG || !equal(tag, expected)) return "not-verified";

    return new Joining(code, pub, stretched, url, fetcher, random);
  }

  /** Seals the chain's key to the waiting device. Only once the person has said the digits match. */
  async letIn(entropy: Uint8Array): Promise<void> {
    const secret = this.random(KEY);
    const mine = x25519.getPublicKey(secret);
    const nonce = this.random(NONCE);
    const key = joinKey(x25519.getSharedSecret(secret, this.pub), this.stretched.joinSalt, mine, this.pub);
    const sealed = gcm(key, nonce, utf8("bay sync join v1")).encrypt(entropy);

    const reply = await call(this.fetcher, `${this.url}/v1/pair/${this.stretched.box}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: base64(concat(mine, nonce, sealed)) }),
    });

    if (!reply.ok) throw await refusal(reply);
  }
}
