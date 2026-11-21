import test from "node:test";
import assert from "node:assert/strict";
import { profiling, setProfiling, span, spanStart, timed } from "./profiling.ts";

// The measures performance.measure was asked for.
function recordMeasures(t) {
  const measures = [];
  t.mock.method(performance, "measure", (name, options) => void measures.push({ name, ...options }));
  t.mock.method(performance, "clearMeasures", () => {});
  t.after(() => setProfiling(false));

  return measures;
}

test("nothing is measured until a trace records", (t) => {
  const measures = recordMeasures(t);
  assert.equal(profiling(), false);
  assert.equal(spanStart(), -1);
  span("Bay.command openTab", 0);
  assert.equal(
    timed("Bay.reduce openTab", () => 7),
    7,
  );
  assert.deepEqual(measures, []);
});

test("while recording, spans are measures with their detail", (t) => {
  const measures = recordMeasures(t);
  setProfiling(true);
  const start = spanStart();
  assert.ok(start >= 0);
  span("Bay.native BayCEF.engineCall", start, { sent: 12, received: 30 });
  assert.equal(
    timed("Bay.reduce openTab", () => "done", { tabs: 3 }),
    "done",
  );
  setProfiling(false);
  assert.deepEqual(
    measures.map((m) => [m.name, m.detail]),
    [
      ["Bay.native BayCEF.engineCall", { sent: 12, received: 30 }],
      ["Bay.reduce openTab", { tabs: 3 }],
    ],
  );
  assert.ok(measures.every((m) => m.end >= m.start));
});

test("a span begun before recording started is dropped, not drawn from the page's start", (t) => {
  const measures = recordMeasures(t);
  const before = spanStart();
  setProfiling(true);
  span("Bay.command openTab", before);
  span("Bay.startup bundle", 0, undefined, 5);
  assert.deepEqual(
    measures.map((m) => [m.name, m.start, m.end]),
    [["Bay.startup bundle", 0, 5]],
  );
});

test("a CDP client or the preview can start and stop it", (t) => {
  recordMeasures(t);
  globalThis.bayProfiling.start();
  assert.equal(globalThis.bayProfiling.active, true);
  globalThis.bayProfiling.stop();
  assert.equal(profiling(), false);
});
