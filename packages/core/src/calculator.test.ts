import assert from "node:assert/strict";
import { test } from "node:test";
import { calculate } from "./calculator.ts";

test("keeps arithmetic calculations working", () => {
  assert.equal(calculate("2 + 3 * 4")?.display, "14");
  assert.equal(calculate("sqrt(9)")?.display, "3");
});

test("converts the command bar examples", () => {
  assert.equal(calculate("5 km in mi")?.display, "3.10685596 mi");
  assert.equal(calculate("350 f to c")?.display, "176.666667 °C");
  assert.equal(calculate("5km in mi")?.display, "3.10685596 mi");
});

test("supports additional vendor unit categories", () => {
  assert.equal(calculate("1 acre in m2")?.display, "4046.85642 square meter");
  assert.equal(calculate("1 bar in psi")?.display, "14.5037744 psi");
  assert.equal(calculate("1 kwh in j")?.display, "3600000 joule");
  assert.equal(calculate("1 m² in cm²")?.display, "10000 square centimeter");
});

test("preserves exact freezing points, existing time aliases and binary data labels", () => {
  assert.equal(calculate("32 F to C")?.display, "0 °C");
  assert.equal(calculate("0 C to F")?.display, "32 °F");
  assert.equal(calculate("273.15 K in C")?.display, "0 °C");
  assert.equal(calculate("32 F in F")?.display, "32 °F");
  assert.equal(calculate("120 secs in min")?.display, "2 min");
  assert.equal(calculate("1024 bytes in KiB")?.display, "1 KiB");
});

test("rejects incompatible and non-finite conversions", () => {
  assert.equal(calculate("1 km in kg"), null);
  assert.equal(calculate("1e309 km in mi"), null);
});

test("capital mega symbols do not resolve to milli units", () => {
  assert.equal(calculate("1 MW in W")?.value, 1e6);
  assert.equal(calculate("1 mW in W")?.value, 0.001);
  assert.equal(calculate("1 MV in V")?.value, 1e6);
  assert.equal(calculate("1 mV in V")?.value, 0.001);
  assert.equal(calculate("1 MA in A")?.value, 1e6);
  assert.equal(calculate("1 mA in A")?.value, 0.001);
});
