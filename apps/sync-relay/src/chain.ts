// One sync chain: the sealed files of each of its scopes, under the names Bay's sync gives them. The relay can't read
// them (each is AES-GCM sealed with a key only the chain's devices hold) nor tell what a scope is (its name is an
// HMAC of it). It keeps the files, lists them and hands them back, as a shared folder would.
//
// Whoever writes first claims the chain with its auth secret (derived from the chain's key on each device); the chain
// keeps only the secret's SHA-256, and every later request must carry the same secret.
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { base64, bearer, empty, fail, json, readBody, sameDigest, sha256hex, TAG, TagSchema } from "./util";

/** A file larger than this isn't a sync file: snapshots of 90 days of history stay well under it. */
export const MAX_FILE = 8 * 1024 * 1024;

/** A chain larger than this is full: a person's bookmarks, history and tabs, many times over. */
export const MAX_CHAIN = 512 * 1024 * 1024;

/** SQLite keeps a value of at most 2 MB: files are kept in parts this size. */
const PART = 1024 * 1024;

/** One read answers at most this many bytes of files; the rest come in the next. */
const MAX_READ = 8 * 1024 * 1024;

/** At most this many names in one read or removal. */
const MAX_IDS = 500;

const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** A read's or a removal's names. */
const IdsSchema = v.object({ ids: v.pipe(v.array(TagSchema), v.maxLength(MAX_IDS)) });

export class Chain extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.createTables();
  }

  /** The tables; again after a deletion, which takes them with it. */
  private createTables() {
    const sql = this.ctx.storage.sql;

    sql.exec("CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 1), hash TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS files (
      scope TEXT NOT NULL, id TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (scope, id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS parts (
      scope TEXT NOT NULL, id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (scope, id, n))`);
  }

  async fetch(request: Request): Promise<Response> {
    const rest = new URL(request.url).pathname.split("/").slice(4);
    const secret = bearer(request);

    if (!secret || !SECRET.test(secret)) return fail(401, "auth");

    const hash = await sha256hex(secret);
    const claimed = this.ctx.storage.sql.exec<{ hash: string }>("SELECT hash FROM auth").toArray()[0];

    if (claimed && !sameDigest(claimed.hash, hash)) return fail(403, "auth");

    // GET /v1/chains/{chain}: whether it exists, how much it holds, and a version that changes with every write.
    if (rest.length === 0 && request.method === "GET") {
      if (!claimed) return fail(404, "none");

      return json({ version: this.version(), size: this.size() });
    }

    // DELETE /v1/chains/{chain}: every file and the claim, so the chain can start again.
    if (rest.length === 0 && request.method === "DELETE") {
      if (claimed) {
        await this.ctx.storage.deleteAll();
        this.createTables();
      }

      return empty();
    }

    if (rest[0] !== "scopes" || !rest[1] || !TAG.test(rest[1])) return fail(404, "not-found");

    const scope = rest[1];

    // GET …/scopes/{scope}: the scope's file names.
    if (rest.length === 2 && request.method === "GET") {
      const ids = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM files WHERE scope = ? ORDER BY id", scope).toArray();

      return json({ ids: ids.map((row) => row.id), version: claimed ? this.version() : 0 });
    }

    // POST …/scopes/{scope}/read {ids}: the files, base64, up to MAX_READ bytes; `later` names the rest.
    if (rest.length === 3 && rest[2] === "read" && request.method === "POST") {
      const body = await readBody(request, IdsSchema);

      if (!body) return fail(400, "bad", "ids");

      return json(this.read(scope, body.ids));
    }

    // POST …/scopes/{scope}/remove {ids}
    if (rest.length === 3 && rest[2] === "remove" && request.method === "POST") {
      const body = await readBody(request, IdsSchema);

      if (!body) return fail(400, "bad", "ids");

      if (claimed) this.remove(scope, body.ids);

      return empty();
    }

    // PUT …/scopes/{scope}/files/{id}: a sealed file. A file's name is random and its contents never change, so
    // writing a name that's there already (a retry) keeps the first.
    if (rest.length === 4 && rest[2] === "files" && rest[3] && TAG.test(rest[3]) && request.method === "PUT") {
      const data = new Uint8Array(await request.arrayBuffer());

      if (data.length === 0) return fail(400, "bad", "empty");

      if (data.length > MAX_FILE) return fail(413, "too-big");

      if (this.size() + data.length > MAX_CHAIN) return fail(413, "full");

      if (!claimed) this.ctx.storage.sql.exec("INSERT INTO auth (id, hash) VALUES (1, ?)", hash);

      this.write(scope, rest[3], data);

      return empty();
    }

    return fail(404, "not-found");
  }

  private version(): number {
    return this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'version'").toArray()[0]?.value ?? 0;
  }

  private bump() {
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('version', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1");
  }

  private size(): number {
    return this.ctx.storage.sql.exec<{ total: number | null }>("SELECT SUM(size) AS total FROM files").one().total ?? 0;
  }

  private write(scope: string, id: string, data: Uint8Array) {
    const sql = this.ctx.storage.sql;

    if (sql.exec("SELECT 1 FROM files WHERE scope = ? AND id = ?", scope, id).toArray().length) return;

    this.ctx.storage.transactionSync(() => {
      for (let n = 0; n * PART < data.length; n++) {
        sql.exec("INSERT INTO parts (scope, id, n, data) VALUES (?, ?, ?, ?)", scope, id, n, data.subarray(n * PART, (n + 1) * PART));
      }

      sql.exec("INSERT INTO files (scope, id, size, at) VALUES (?, ?, ?, ?)", scope, id, data.length, Date.now());
      this.bump();
    });
  }

  private read(scope: string, ids: string[]) {
    const sql = this.ctx.storage.sql;
    const files: { id: string; data: string }[] = [];
    const missing: string[] = [];
    const later: string[] = [];
    let bytes = 0;

    for (const id of ids) {
      const file = sql.exec<{ size: number }>("SELECT size FROM files WHERE scope = ? AND id = ?", scope, id).toArray()[0];

      if (!file) {
        missing.push(id);
        continue;
      }

      // Always at least one file, however large; then only while the answer stays under MAX_READ.
      if (files.length && bytes + file.size > MAX_READ) {
        later.push(id);
        continue;
      }

      const data = new Uint8Array(file.size);
      let at = 0;

      for (const part of sql.exec<{ data: ArrayBuffer }>("SELECT data FROM parts WHERE scope = ? AND id = ? ORDER BY n", scope, id)) {
        data.set(new Uint8Array(part.data), at);
        at += part.data.byteLength;
      }

      files.push({ id, data: base64(data) });
      bytes += file.size;
    }

    return { files, missing, later };
  }

  private remove(scope: string, ids: string[]) {
    const sql = this.ctx.storage.sql;

    this.ctx.storage.transactionSync(() => {
      let removed = 0;

      for (const id of ids) {
        removed += sql.exec("DELETE FROM files WHERE scope = ? AND id = ?", scope, id).rowsWritten;
        sql.exec("DELETE FROM parts WHERE scope = ? AND id = ?", scope, id);
      }

      if (removed) this.bump();
    });
  }
}
