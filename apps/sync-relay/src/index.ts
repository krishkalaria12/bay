// Bay's sync relay (apps/sync-relay/README.md): /v1/chains/{chain}/… to that chain's object, /v1/pair… to the pairing
// boxes, /v1/health for a device to tell whether the relay answers.
import "./env";
import { Chain } from "./chain";
import { Pairing } from "./pairing";
import { fail, json, preflight, readableAnywhere, TAG } from "./util";

export { Chain, Pairing };

/** The relay's protocol version: a device that speaks another says so instead of syncing. */
export const PROTOCOL = 1;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return request.method === "OPTIONS" ? preflight() : readableAnywhere(await route(request, env));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/v1/health" && request.method === "GET") return json({ ok: true, v: PROTOCOL });

  if (path === "/v1/pair" || path.startsWith("/v1/pair/")) return env.PAIRING.get(env.PAIRING.idFromName("pairing")).fetch(request);

  const chain = /^\/v1\/chains\/([^/]+)(?:\/.*)?$/.exec(path)?.[1];

  if (chain !== undefined) {
    if (!TAG.test(chain)) return fail(400, "bad", "chain");

    return env.CHAIN.get(env.CHAIN.idFromName(chain)).fetch(request);
  }

  return fail(404, "not-found");
}
