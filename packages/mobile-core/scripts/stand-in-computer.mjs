// A stand-in computer on Bay's real sync relay, for testing a phone without a Mac: it keeps a test chain's key and
// state in a file, publishes a computer's records (its name, two profiles, open tabs, bookmarks, history), lets a phone
// in by its code, prints the chain's recovery phrase, shows what it reads back, and clears the chain.
//   node packages/mobile-core/scripts/stand-in-computer.mjs sync | pair <CODE> | phrase | clear
// The state lives in $BAY_STAND_IN (default: the system's temp folder). Clear any chain you make when done.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const relay = (path) => import(join(here, "../../sync/src", path));
const { Clock } = await relay("hlc.ts");
const { emptyScope, syncScope, visible } = await relay("scope.ts");
const { SyncKeys } = await relay("relay/keys.ts");
const { base64, fromBase64 } = await relay("relay/bytes.ts");
const { phraseWords } = await relay("relay/phrase.ts");
const { Joining } = await relay("relay/pairing.ts");
const { relayTransport } = await relay("relay/transport.ts");

const file = process.env.BAY_STAND_IN ?? join(tmpdir(), "bay-stand-in-computer.json");

const saved = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : { entropy: base64(crypto.getRandomValues(new Uint8Array(32))), scopes: {}, clock: null };

const keys = new SyncKeys(fromBase64(saved.entropy));
const transport = relayTransport({ keys });
const now = Date.now();

const records = {
  app: {
    "dev:mac": { n: "Stand-in Mac" },
    "prof:personal": { n: "Personal", c: "blue", i: null, d: true },
    "prof:work": { n: "Work", c: "purple", i: "💼" },
  },
  "p:personal": {
    "tabs:mac": { n: "Stand-in Mac", tabs: [{ u: "https://bay.example/", t: "Bay on the Mac" }] },
    "bm:folder-1": { k: "f", p: "bar", t: "Work", a: 1, pos: "V" },
    "bm:link-1": { k: "u", p: "folder-1", t: "Docs", u: "https://docs.example/", a: 2, pos: "V" },
    "h:https://visited.example/": { t: "Visited on the Mac", n: 3, vt: [now - 60_000] },
  },
  "p:work": { "pin:t:mail": { g: null, u: "https://mail.example/", t: null, i: null, ti: "Mail", pos: "V" } },
};

async function sync() {
  const clock = new Clock("mac", saved.clock, Date.now);

  for (const [scope, entries] of Object.entries(records)) {
    const values = new Map(Object.entries(entries));
    const prefixes = [...new Set([...values.keys()].map((key) => key.slice(0, key.indexOf(":") + 1)))];
    const state = (saved.scopes[scope] ??= emptyScope());

    await syncScope({
      scope,
      state,
      transport,
      clock,
      device: "mac",
      adapters: [...new Set([...prefixes, "dev:", "tabs:", "h:"])].map((prefix) => ({
        prefix,
        extract: () => ({ values: new Map([...values].filter(([key]) => key.startsWith(prefix))), ignore: (key) => !values.has(key) }),
        apply: () => true,
      })),
    });
  }

  saved.clock = clock.last;
  writeFileSync(file, JSON.stringify(saved));

  for (const [scope, state] of Object.entries(saved.scopes)) {
    const seen = [...visible(state, "")].filter(([key]) => !(key in (records[scope] ?? {})));

    console.log(`${scope}: ${seen.length ? seen.map(([key, value]) => `\n  ${key} ${JSON.stringify(value)}`).join("") : "nothing from other devices"}`);
  }
}

const [command, argument] = process.argv.slice(2);

if (command === "sync") await sync();
else if (command === "phrase") console.log(phraseWords(fromBase64(saved.entropy)).join(" "));
else if (command === "pair") {
  await sync();

  const joining = await Joining.find(argument.toUpperCase().replace(/[^A-Z0-9]/g, ""));

  if (!(joining instanceof Joining)) throw new Error(`No phone to let in: ${joining}`);

  console.log(`digits ${joining.digits}`);
  await joining.letIn(fromBase64(saved.entropy));
  console.log("let in");
} else if (command === "clear") {
  await transport.clear().catch(() => undefined);
  rmSync(file, { force: true });
  console.log("cleared");
} else console.log("commands: sync | pair <CODE> | phrase | clear");
