// Sync through Bay's relay (apps/sync-relay): the same files a folder holds, sealed on the device with the chain's
// keys, kept by the relay under their tags. It reads and writes what the folder transport does, so the scope logic
// (scope.ts) runs over either without knowing which.
import * as v from "valibot";

import type { Listing, Transport } from "../scope.ts";
import { base64, fromBase64, fromUtf8, utf8 } from "./bytes.ts";
import { SealError, type SyncKeys } from "./keys.ts";

/** The relay every Bay syncs through unless told otherwise. */
export const DEFAULT_RELAY = "https://bay-sync.codewithkrish12.workers.dev";

/** The protocol this code speaks (apps/sync-relay/README.md). */
export const RELAY_PROTOCOL = 1;

/** Names asked for in one read. */
const READ_BATCH = 200;

/** Why a request to the relay failed: no answer, or an answer that says why. */
export class RelayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(status === 0 ? "The sync relay didn't answer" : `The sync relay said ${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const ErrorSchema = v.object({ error: v.string() });
const StateSchema = v.object({ version: v.number(), size: v.number() });
const ListSchema = v.object({ ids: v.array(v.string()), version: v.number() });

const ReadSchema = v.object({
  files: v.array(v.object({ id: v.string(), data: v.string() })),
  missing: v.array(v.string()),
  later: v.array(v.string()),
});

const HealthSchema = v.object({ ok: v.boolean(), v: v.number() });

/** A relay's answer as `schema` reads it; a refusal or no answer as a RelayError. */
async function answer<S extends v.GenericSchema>(response: Promise<Response>, schema: S): Promise<v.InferOutput<S>> {
  let reply: Response;

  try {
    reply = await response;
  } catch {
    throw new RelayError(0, "offline");
  }

  const body: unknown = reply.status === 204 ? null : await reply.json().catch(() => null);

  if (!reply.ok) throw new RelayError(reply.status, v.is(ErrorSchema, body) ? body.error : "unknown");

  return v.parse(schema, body);
}

/** Whether a relay answers, and speaks this code's protocol. */
export async function relayAnswers(url: string = DEFAULT_RELAY, fetcher: Fetch = fetch): Promise<boolean> {
  try {
    const health = await answer(fetcher(`${url}/v1/health`), HealthSchema);

    return health.ok && health.v === RELAY_PROTOCOL;
  } catch {
    return false;
  }
}

export interface RelayTransport extends Transport {
  /** Writes a file under a name it already has: a file the folder holds, mirrored (mirror.ts). */
  writeAs(scope: string, id: string, payload: string): Promise<void>;
  /** The chain's version, which changes with every write, and size; null before the chain's first file. */
  state(): Promise<{ version: number; size: number } | null>;
  /** Every file of the chain, and its claim. */
  clear(): Promise<void>;
}

export function relayTransport({ keys, url = DEFAULT_RELAY, fetch: fetcher = fetch }: { keys: SyncKeys; url?: string; fetch?: Fetch }): RelayTransport {
  const chain = `${url}/v1/chains/${keys.chainTag}`;
  const headers = { authorization: `Bearer ${keys.relaySecret}` };
  const json = { ...headers, "content-type": "application/json" };
  const scopeUrl = (scope: string) => `${chain}/scopes/${keys.scopeTag(scope)}`;

  const writeAs = async (scope: string, id: string, payload: string) => {
    // A copy on its own ArrayBuffer, as a request body takes it.
    const body = new Uint8Array(keys.seal(utf8(payload), keys.scopeTag(scope), id));

    await answer(
      fetcher(`${scopeUrl(scope)}/files/${id}`, { method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, body }),
      v.null(),
    );
  };

  return {
    write: async (scope, payload) => {
      const id = keys.newFileId();

      await writeAs(scope, id, payload);

      return id;
    },
    writeAs,
    read: async (scope, known) => {
      const listing: Listing = { files: [], pending: [], damaged: [], present: [] };
      const { ids } = await answer(fetcher(scopeUrl(scope), { headers }), ListSchema);
      const skip = new Set(known);
      const scopeTag = keys.scopeTag(scope);

      listing.present = ids;

      let wanted = ids.filter((id) => !skip.has(id));

      while (wanted.length) {
        const batch = wanted.slice(0, READ_BATCH);
        const reply = await answer(fetcher(`${scopeUrl(scope)}/read`, { method: "POST", headers: json, body: JSON.stringify({ ids: batch }) }), ReadSchema);

        for (const file of reply.files) {
          try {
            listing.files.push({ id: file.id, payload: fromUtf8(keys.open(fromBase64(file.data), scopeTag, file.id)) });
          } catch (error) {
            if (!(error instanceof SealError)) throw error;

            listing.damaged.push({ id: file.id, age: 0 });
          }
        }

        // A file removed since the listing is gone, as one removed from a folder is.
        const gone = new Set(reply.missing);

        listing.present = listing.present.filter((id) => !gone.has(id));
        wanted = [...reply.later, ...wanted.slice(READ_BATCH)];
      }

      return listing;
    },
    remove: async (scope, ids) => {
      for (let at = 0; at < ids.length; at += 500) {
        await answer(fetcher(`${scopeUrl(scope)}/remove`, { method: "POST", headers: json, body: JSON.stringify({ ids: ids.slice(at, at + 500) }) }), v.null());
      }
    },
    state: async () => {
      try {
        return await answer(fetcher(chain, { headers }), StateSchema);
      } catch (error) {
        if (error instanceof RelayError && error.status === 404) return null;

        throw error;
      }
    },
    clear: async () => {
      await answer(fetcher(chain, { method: "DELETE", headers }), v.null());
    },
  };
}

/** Bytes as the relay's read answers them, for a stand-in relay in tests. */
export const encodeFile = base64;
