// Writes fixtures/pairing.json: one pairing run by the TypeScript code (packages/sync/src/relay/pairing.ts), with
// fixed random bytes, against a relay in memory. The Rust tests check the same code stretches to the same box, the
// posted key's tag verifies, both sides show the same digits, and the envelope opens to the chain key.
//   node packages/mobile-core/scripts/pairing-vector.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { Joining, Waiting } = await import(join(here, "../../sync/src/relay/pairing.ts"));
const { hex } = await import(join(here, "../../sync/src/relay/bytes.ts"));

// A counter as randomness, so every run writes the same vector.
let counter = 0;
const draws = [];

const random = (length) => {
  const bytes = Uint8Array.from({ length }, () => (counter++ * 37 + 11) & 0xff);

  draws.push(hex(bytes));

  return bytes;
};

const boxes = new Map();
let envelopeSent = null;

const fetcher = async (input, init = {}) => {
  const path = new URL(input).pathname;
  const method = init.method ?? "GET";

  if (path === "/v1/pair" && method === "POST") {
    const body = JSON.parse(init.body);

    boxes.set(body.box, { pub: body.pub });

    return new Response(null, { status: 204 });
  }

  const box = boxes.get(path.split("/").pop());

  if (method === "PUT") {
    box.envelope = JSON.parse(init.body).envelope;
    envelopeSent = box.envelope;

    return new Response(null, { status: 204 });
  }

  return new Response(JSON.stringify(box), { status: 200 });
};

const url = "https://relay.test";
const waiting = await Waiting.start({ url, fetch: fetcher, random });
const [codeBytes, waitingSecret] = draws;
const [box, posted] = [...boxes.entries()][0];
const joining = await Joining.find(waiting.code, { url, fetch: fetcher, random });
const entropy = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

await joining.letIn(entropy);

const joined = await waiting.poll();

writeFileSync(
  join(here, "../fixtures/pairing.json"),
  `${JSON.stringify(
    {
      code: waiting.code,
      codeBytes,
      waitingSecret,
      box,
      posted: posted.pub,
      digits: waiting.digits,
      joiningDigits: joining.digits,
      envelope: envelopeSent,
      entropy: hex(entropy),
      opened: hex(joined.entropy),
    },
    null,
    2,
  )}\n`,
);
