import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import { selfCheckProblems } from "../src/effect/selfCheck.ts";

test("the self-check finds nothing wrong where Effect behaves", async () => {
  const problems = await Effect.runPromise(selfCheckProblems);

  assert.deepEqual(problems, []);
});
