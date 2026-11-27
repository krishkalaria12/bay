#!/usr/bin/env node
// Signs the remote kill switch feed (apps/web/public/switches.json) after an edit, writing switches.json.sig beside it,
// and stamps "issued" with now so apps take it over the copy they kept. The website deploy then publishes both.
//
//   node scripts/release/sign-switches.mjs [--key <private.pem>]
//
// The key defaults to ~/Documents/bay-switches-key/switches-private.pem (Ed25519, PKCS#8). Its public half is in
// packages/rust/bay-switches/src/lib.rs (PUBLIC_KEYS); `cargo test -p bay-switches` checks the shipped feed with it.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const feedPath = path.join(root, "apps/web/public/switches.json");
const keyAt = process.argv.indexOf("--key");
const keyPath = keyAt > 0 ? process.argv[keyAt + 1] : path.join(homedir(), "Documents/bay-switches-key/switches-private.pem");

const feed = JSON.parse(readFileSync(feedPath, "utf8"));
const platforms = new Set(["macos", "windows", "linux"]);

for (const s of feed.switches ?? []) {
  if (!s.id || !s.feature || !s.reason) throw new Error(`Switch ${JSON.stringify(s)} needs an id, a feature and a reason.`);
  const unknown = (s.platforms ?? []).filter((p) => !platforms.has(p));

  if (unknown.length) throw new Error(`Switch ${s.id} names unknown platforms: ${unknown.join(", ")}`);
}

feed.issued = Math.floor(Date.now() / 1000);

const text = `${JSON.stringify(feed, null, 2)}\n`;
const signature = sign(null, Buffer.from(text), createPrivateKey(readFileSync(keyPath)));

writeFileSync(feedPath, text);

writeFileSync(`${feedPath}.sig`, `${signature.toString("base64")}\n`);

console.log(`Signed ${feed.switches?.length ?? 0} switches, issued ${new Date(feed.issued * 1000).toISOString()}.`);
