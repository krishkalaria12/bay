// What every route shares: JSON answers, errors with a code, bearer tokens, digests and request bodies parsed at the
// door.
import * as v from "valibot";

/** A chain's, a scope's or a file's name: 26 characters of lowercase base32 (16 bytes), as Bay's sync writes them. */
export const TAG = /^[a-z2-7]{26}$/;

/** A response body: whatever JSON.stringify takes. */
type Body = Parameters<typeof JSON.stringify>[0];

export function json(body: Body, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function fail(status: number, code: string, message?: string): Response {
  return json(message ? { error: code, message } : { error: code }, status);
}

export function empty(): Response {
  return new Response(null, { status: 204 });
}

export async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two equal-length digests without saying where they differ. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;
}

export function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");

  return match?.[1] ?? null;
}

/** A request's JSON body as `schema` reads it, or null when it is something else. */
export async function readBody<S extends v.GenericSchema>(request: Request, schema: S): Promise<v.InferOutput<S> | null> {
  try {
    const parsed = v.safeParse(schema, await request.json());

    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

/** A tag, as the routes name a chain, a scope or a file. */
export const TagSchema = v.pipe(v.string(), v.regex(TAG));

export function base64(bytes: Uint8Array): string {
  let text = "";

  // In slices: spreading a megabyte into fromCharCode overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return btoa(text);
}
