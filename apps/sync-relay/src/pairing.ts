// The pairing boxes: how a new device gets the chain's key from one already syncing, after Yab's
// (sync-server/src/pairing.ts, Apache-2.0). The new device posts its one-time public key under a name stretched
// from the code it shows; the device you type the code on reads that key, both screens show four digits worked out
// from it, and once you say they match it seals the chain's key to it and puts the envelope back. The relay never
// sees the code, only the name stretched from it, and can't open the envelope.
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { empty, fail, json, readBody } from "./util";

/** A box lives this long. */
const TTL = 10 * 60 * 1000;

/** Reads that carry the envelope away; reading the public key alone is free. */
const MAX_READS = 20;
const MAX_PUB = 200;
const MAX_ENVELOPE = 4096;
const BOX = /^[0-9a-f]{64}$/;

/** One address asking no faster than people pair: a hundred a minute is noise, not a device joining. */
export const HITS = 100;
export const HITS_WINDOW = 60 * 1000;

/** A non-empty string no longer than `max`. */
const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));

/** A new device waiting under its code: the box and its one-time key. */
const WaitSchema = v.object({ box: v.pipe(v.string(), v.regex(BOX)), pub: text(MAX_PUB) });

/** The chain's key, sealed to the waiting key. */
const EnvelopeSchema = v.object({ envelope: text(MAX_ENVELOPE) });

// One instance holds every box: they're tiny and live minutes.
export class Pairing extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS boxes (
      box TEXT PRIMARY KEY, pub TEXT NOT NULL, envelope TEXT, reads INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL)`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (ip TEXT PRIMARY KEY, at INTEGER NOT NULL, n INTEGER NOT NULL)");
  }

  async fetch(request: Request): Promise<Response> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();

    sql.exec("DELETE FROM boxes WHERE expires <= ?", now);

    const ip = request.headers.get("cf-connecting-ip");

    if (ip && ip.length <= 64) {
      const hit = sql.exec<{ at: number; n: number }>("SELECT at, n FROM hits WHERE ip = ?", ip).toArray()[0];

      if (hit && now - hit.at < HITS_WINDOW) {
        if (hit.n >= HITS) return fail(429, "later");

        sql.exec("UPDATE hits SET n = n + 1 WHERE ip = ?", ip);
      } else {
        sql.exec("INSERT INTO hits (ip, at, n) VALUES (?, ?, 1) ON CONFLICT (ip) DO UPDATE SET at = excluded.at, n = 1", ip, now);
      }
    }

    sql.exec("DELETE FROM hits WHERE at <= ?", now - HITS_WINDOW);

    const path = new URL(request.url).pathname;

    // POST /v1/pair {box, pub}: a new device waits under its code. A live box belongs to whoever posted it first.
    if (path === "/v1/pair") {
      if (request.method !== "POST") return fail(405, "bad");

      const body = await readBody(request, WaitSchema);

      if (!body) return fail(400, "bad");

      if (sql.exec("SELECT 1 FROM boxes WHERE box = ?", body.box).toArray().length) return fail(409, "taken");

      sql.exec("INSERT INTO boxes (box, pub, expires) VALUES (?, ?, ?)", body.box, body.pub, now + TTL);
      await this.cleanUpAt(now + TTL);

      return empty();
    }

    const box = path.slice("/v1/pair/".length);

    if (!BOX.test(box)) return fail(400, "bad");

    const row = sql.exec<{ pub: string; envelope: string | null; reads: number }>("SELECT pub, envelope, reads FROM boxes WHERE box = ?", box).toArray()[0];

    if (!row) return fail(404, "not-found");

    // GET /v1/pair/{box}: the waiting key, and the envelope once it's there.
    if (request.method === "GET") {
      if (row.envelope === null) return json({ pub: row.pub });

      if (row.reads >= MAX_READS) {
        sql.exec("DELETE FROM boxes WHERE box = ?", box);

        return fail(404, "not-found");
      }

      sql.exec("UPDATE boxes SET reads = reads + 1 WHERE box = ?", box);

      return json({ pub: row.pub, envelope: row.envelope });
    }

    // PUT /v1/pair/{box} {envelope}: the chain's key, sealed to the waiting key. Once.
    if (request.method === "PUT") {
      const body = await readBody(request, EnvelopeSchema);

      if (!body) return fail(400, "bad");

      if (row.envelope !== null) return fail(409, "taken");

      sql.exec("UPDATE boxes SET envelope = ? WHERE box = ?", body.envelope, box);

      return empty();
    }

    return fail(405, "bad");
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;

    sql.exec("DELETE FROM boxes WHERE expires <= ?", Date.now());

    const next = sql.exec<{ at: number | null }>("SELECT MIN(expires) AS at FROM boxes").one().at;

    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  private async cleanUpAt(at: number) {
    const current = await this.ctx.storage.getAlarm();

    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
