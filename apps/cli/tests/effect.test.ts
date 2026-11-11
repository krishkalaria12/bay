// The CLI's Effect pieces: the scripts store's lock and status wait, and how the command line reads its flags.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { main } from "../src/cli.ts";
import { lockStore, openStore, Store, waitForStatus } from "../src/scriptsStore.ts";

let root = "";

beforeEach(() => {
  root = join(tmpdir(), `bay-effect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the scripts store", () => {
  it("waits for another holder to let go of the lock, and gives it back with its scope", async () => {
    const other = new Store(root);
    other.open(true);
    expect(other.tryLock()).toBe(true);

    setTimeout(() => other.unlock(), 150);

    const started = Date.now();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(root, true);

          yield* lockStore(store!);
        }),
      ),
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(100);

    // The scope closed: the lock is free again.
    const after = new Store(root);
    after.open(true);
    expect(after.tryLock()).toBe(true);
    after.close();
  });

  it("stops waiting for Bay's report when Bay is gone, and reads a report that came", async () => {
    const store = new Store(root);
    store.open(true);

    expect(await Effect.runPromise(waitForStatus(store, 1, () => false))).toEqual(["quit", null]);

    writeFileSync(join(store.path, "status.json"), JSON.stringify({ generation: 2, profiles: {} }));

    const [outcome] = await Effect.runPromise(waitForStatus(store, 1, () => true));

    expect(outcome).toBe("superseded");
  });
});

describe("the command line", () => {
  it("never takes the code after --json as the flag's value", async () => {
    const env = { ...process.env };

    process.env.BAY_DATA_DIR = "/nonexistent";
    process.env.BAY_CDP_URL = "";

    try {
      // The code is read, and is a syntax error: status 1, not "give CODE".
      expect(await main(["exec", "--json", "("])).toBe(1);
      // The code is read, and Bay isn't there: status 2.
      expect(await main(["exec", "--json", "1"])).toBe(2);
    } finally {
      process.env.BAY_DATA_DIR = env.BAY_DATA_DIR;
      process.env.BAY_CDP_URL = env.BAY_CDP_URL;
    }
  });

  it("shows help with status 0, and a rejected flag with status 1", async () => {
    expect(await main([])).toBe(0);
    expect(await main(["exec", "--help"])).toBe(0);
    expect(await main(["exec", "1", "--port", "70000"])).toBe(1);
  });
});
