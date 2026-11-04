#!/usr/bin/env node
// Builds the fake Chrome home that scripts/e2e.mjs imports from. Everything here is invented.
//
//   node packages/import/scripts/e2e_fixture.mjs <home dir> [safe storage secret] [fixture server port]
//
// Writes <home>/Library/Application Support/Google/Chrome/{Local State, Default/{Preferences, Network/Cookies, Web Data}}.
// <home> is wiped first. Cookie values and the card number use Chrome's macOS v10 encryption,
// AES-128-CBC with PBKDF2(secret, "saltysalt", 1003). The app receives BAY_IMPORT_TEST_SECRET,
// so no Keychain item is read. The card is Visa's published test number.
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [home, secret = "e2e-test-secret", portArg = "80"] = process.argv.slice(2);
if (!home || home === "-h" || home === "--help") {
  const header = readFileSync(new URL(import.meta.url), "utf8")
    .split("\n")
    .slice(1);
  console.log(
    header
      .slice(
        0,
        header.findIndex((line) => !line.startsWith("//")),
      )
      .map((line) => line.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
  process.exit(home ? 0 : 64);
}

const root = path.resolve(home);
const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
const port = Number(portArg);
if (!/^[+-]?\d+$/.test(portArg) || !Number.isSafeInteger(port)) throw new Error("fixture server port must be an integer");
rmSync(root, { recursive: true, force: true });
const chrome = path.join(root, "Library", "Application Support", "Google", "Chrome");
const profile = path.join(chrome, "Default");
mkdirSync(path.join(profile, "Network"), { recursive: true });
writeFileSync(path.join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "E2E" } }, last_used: "Default" } }));
writeFileSync(path.join(profile, "Preferences"), JSON.stringify({ profile: { name: "E2E" } }));

function v10(plain) {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

function hashed(host, value) {
  // Cookies DB v24+: the plaintext starts with SHA-256(host_key).
  return v10(Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]));
}

function webkit(unix) {
  return BigInt(Math.trunc((unix + 11644473600) * 1_000_000));
}

const now = Date.now() / 1000;
const future = now + 30 * 86400;
const cookies = new DatabaseSync(path.join(profile, "Network", "Cookies"));
try {
  cookies.exec(`
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
INSERT INTO meta VALUES ('version', '24');
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
BEGIN;
`);
  // Five cookies import; the rest are refused or skipped on purpose.
  // host, top frame, name, plaintext, ciphertext, path, expiry (0 = session), secure, httponly,
  // priority, samesite, source scheme, source port (0 = the fixture server's).
  const rows = [
    ["localhost", "", "nn_sid", "", hashed("localhost", "s3ss10n-e2e"), "/", future, 1, 1, 2, 1, 2, 443],
    ["localhost", "", "nn_legacy", "", v10(Buffer.from("no-host-prefix")), "/", future, 0, 0, 1, 2, 1, 80], // undecryptable
    ["localhost", "", "nn_session", "until-quit", Buffer.alloc(0), "/", 0, 0, 0, 0, -1, 1, 0],
    ["localhost", "", "nn_expired", "", hashed("localhost", "gone"), "/", now - 86400, 0, 0, 1, 0, 1, 80],
    ["localhost", "", "nn_other_path", "", hashed("localhost", "elsewhere"), "/private", future, 0, 0, 1, 1, 1, 0],
    [".example.com", "", "nn_domain", "", hashed(".example.com", "dom"), "/", future, 1, 0, 1, 0, 2, 443],
    ["localhost", "", "nn_dotdot", "", hashed("localhost", "widened"), "/private/../", future, 0, 0, 1, 1, 1, 0],
    [".com", "", "nn_supercookie", "", hashed(".com", "everywhere"), "/", future, 1, 0, 1, 0, 2, 443],
    ["partitioned.example", "https://top.example", "nn_chips", "", hashed("partitioned.example", "chips"), "/", future, 1, 0, 1, 0, 2, 443],
  ];
  const insert = cookies.prepare("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)");
  for (const [host, top, name, value, encrypted, cookiePath, expiry, secure, httpOnly, priority, sameSite, scheme, sourcePort] of rows) {
    const persistent = expiry ? 1 : 0;
    insert.run(
      webkit(now - 3600),
      host,
      top,
      name,
      value,
      encrypted,
      cookiePath,
      expiry ? webkit(expiry) : 0,
      secure,
      httpOnly,
      webkit(now - 60),
      persistent,
      persistent,
      priority,
      sameSite,
      scheme,
      sourcePort || port,
      webkit(now - 60),
    );
  }
  cookies.exec("COMMIT;");
} finally {
  cookies.close();
}

const webData = new DatabaseSync(path.join(profile, "Web Data"));
try {
  webData.exec(`
CREATE TABLE addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR, label VARCHAR, initial_creator_id INTEGER DEFAULT 0, record_type INTEGER);
CREATE TABLE address_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0, observations BLOB, PRIMARY KEY (guid, type));
CREATE TABLE credit_cards (guid VARCHAR PRIMARY KEY, name_on_card VARCHAR, expiration_month INTEGER, expiration_year INTEGER, card_number_encrypted BLOB, date_modified INTEGER NOT NULL DEFAULT 0, origin VARCHAR DEFAULT '', use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0, billing_address_id VARCHAR, nickname VARCHAR);
BEGIN;
`);
  const guid = "00000000-0000-4000-8000-00000000e2e1";
  webData.prepare("INSERT INTO addresses VALUES (?,1,0,0,'en','',0,0)").run(guid);
  // Chrome's FieldType numbers: name, company, street, city, state, zip, country, phone, email.
  const insert = webData.prepare("INSERT INTO address_type_tokens VALUES (?,?,?,0,NULL)");
  for (const [type, value] of [
    [7, "Test User"],
    [60, "Bay Test Co"],
    [77, "1 Fixture Way"],
    [33, "Testville"],
    [34, "CA"],
    [35, "94000"],
    [36, "US"],
    [14, "+14155550100"],
    [9, "testuser@example.com"],
  ]) {
    insert.run(guid, type, value);
  }
  webData
    .prepare("INSERT INTO credit_cards VALUES ('00000000-0000-4000-8000-00000000e2c1','Test User',12,2031,?,0,'',0,0,'',NULL)")
    .run(v10(Buffer.from("4111111111111111")));
  webData.exec("COMMIT;");
} finally {
  webData.close();
}
console.log(root);
