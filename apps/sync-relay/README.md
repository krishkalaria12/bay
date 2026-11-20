# Bay sync relay

A Cloudflare Worker that lets phones and computers sync without a shared folder. Bay's sync (`packages/sync`) writes
each change as a file sealed with AES-GCM under a key only the account's devices hold, in a folder per sync chain and
scope, each named by an HMAC. The relay keeps those same files, by those same names, and never opens them: it is a
folder in the cloud. The pairing boxes after Yab's (`sync-server/src/pairing.ts`, Apache-2.0) hand the key to a new
device.

- `src/index.ts`: the router. `GET /v1/health` answers `{"ok":true,"v":1}`.
- `src/chain.ts`: one Durable Object (SQLite) per chain: its claim, its files in 1 MB parts, a version that changes
  with every write.
- `src/pairing.ts`: the ten-minute pairing boxes, one object for all of them.

Deployed as `bay-sync`: <https://bay-sync.codewithkrish12.workers.dev>.

## Protocol v1

Every name is 26 characters of lowercase base32: `{chain}` is the chain tag, `{scope}` a scope tag, `{id}` a file id,
as the folder transport names its folders and files. File bodies are the sealed bytes (`NNS1`, nonce, ciphertext,
tag).

A chain's requests carry `Authorization: Bearer <secret>`, the chain key's relay secret (HKDF-SHA256 of the key, salt
`bay-sync/v1`, info `relay-auth`, base64url). The first write claims the chain with it; the chain keeps its SHA-256,
and any other secret gets 403.

- `GET /v1/chains/{chain}` → `{"version", "size"}`, 404 `none` before the first write. `version` changes with every
  write or removal, so a device polls this one request to know whether to read.
- `DELETE /v1/chains/{chain}` → 204: every file and the claim.
- `GET /v1/chains/{chain}/scopes/{scope}` → `{"ids", "version"}`.
- `POST /v1/chains/{chain}/scopes/{scope}/read` `{"ids"}` (≤ 500) → `{"files": [{"id", "data"}], "missing",
  "later"}`: `data` is base64; at most 8 MB a read, the rest named in `later`.
- `PUT /v1/chains/{chain}/scopes/{scope}/files/{id}` with the sealed bytes (≤ 8 MB) → 204. A name already there keeps
  its first file (a retry). 413 `too-big` or `full` (a chain over 512 MB).
- `POST /v1/chains/{chain}/scopes/{scope}/remove` `{"ids"}` → 204.

Pairing, no secret:

- `POST /v1/pair` `{"box", "pub"}` → 204, 409 `taken`. `box` is 64 hex characters stretched from the code the new
  device shows; `pub` its one-time X25519 key and the key's tag.
- `GET /v1/pair/{box}` → `{"pub", "envelope"?}`. The envelope can be read 20 times.
- `PUT /v1/pair/{box}` `{"envelope"}` → 204, once.

Boxes live ten minutes; an address asking more than 100 times a minute gets 429.

## Test, run and deploy

```sh
cd apps/sync-relay
pnpm install
pnpm test          # vitest inside the Workers runtime
pnpm typecheck
pnpm dev           # http://localhost:8787
CLOUDFLARE_API_TOKEN=… pnpm run deploy
```

The token is an "Edit Cloudflare Workers" API token for the account. Durable Objects on SQLite run on the free plan.
