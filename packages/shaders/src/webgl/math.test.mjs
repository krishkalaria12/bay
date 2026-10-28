import assert from "node:assert/strict";
import { test } from "node:test";
import { adjustLightness, oklab, palette, parseHex } from "./colors.ts";
import { grainHash, grainInputs } from "./grain.ts";
import { targetSize } from "./surface.ts";
import { areaLightUniforms, backdropUniforms, edgeLightUniforms, powerUpUniforms, POWER_UP_PALETTES, validRect } from "./uniforms.ts";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("hex parsing matches SIMD4(hex:)", () => {
  assert.deepEqual(parseHex("#FF0000"), [1, 0, 0, 1]);
  assert.deepEqual(parseHex("00000080"), [0, 0, 0, 128 / 255]);
  assert.equal(parseHex("#FFF"), null);
  assert.equal(parseHex("#GG0000"), null);
});

test("OKLab of white and black", () => {
  const [l, a, b] = oklab([1, 1, 1, 1]);
  near(l, 1, 1e-4);
  near(a, 0, 1e-4);
  near(b, 0, 1e-4);
  near(oklab([0, 0, 0, 1])[0], 0);
});

test("lightness shift keeps hue and clamps", () => {
  assert.deepEqual(adjustLightness([0.5, 0.5, 0.5, 1], 0.25), [0.75, 0.75, 0.75, 1]);
  assert.deepEqual(adjustLightness([0.5, 0.5, 0.5, 1], 2), [1, 1, 1, 1]);
  const [r, g, b] = adjustLightness([0.8, 0.2, 0.2, 1], 0.1);
  assert.ok(r > g && g === b);
});

test("palettes: named, custom, invalid, capped", () => {
  assert.equal(palette("pink", POWER_UP_PALETTES, "pink").length, 5);
  assert.equal(palette(["#000000", "nope"], POWER_UP_PALETTES, "pink").length, 1);
  assert.equal(palette(["nope"], POWER_UP_PALETTES, "pink").length, 5);
  assert.equal(palette(Array(40).fill("#000000"), POWER_UP_PALETTES, "pink").length, 16);
});

test("grain inputs clamp and reject nonfinite values", () => {
  const d = { opacity: 0.09, scale: 1 };
  assert.deepEqual(grainInputs(undefined, undefined, d), d);
  assert.deepEqual(grainInputs(NaN, Infinity, d), d);
  assert.deepEqual(grainInputs(-1, 0.1, d), { opacity: 0, scale: 0.25 });
  assert.deepEqual(grainInputs(4, 3, d), { opacity: 1, scale: 3 });
});

test("grain is fixed per cell and spread over 0-1", () => {
  assert.equal(grainHash(3, 7), grainHash(3, 7));
  let sum = 0;
  const n = 64 * 64;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) sum += grainHash(x, y);
  near(sum / n, 0.5, 0.03);
});

test("backdrop uniforms: angle, grain and CSS size", () => {
  const u = backdropUniforms({ colors: ["#000000", "#FFFFFF"], angle: 90, grainOpacity: 0.05 }, 300, 200);
  near(u.direction[0], 1);
  near(u.direction[1], 0);
  assert.deepEqual(u.viewSize, [300, 200]);
  assert.equal(u.grainOpacity, 0.05);
  assert.equal(u.grainScale, 1);
  assert.equal(backdropUniforms({ colors: ["#000000", "#FFFFFF"] }, 1, 1).grainOpacity, 0.09);
});

test("render targets cap DPR at 2 and area at 8 megapixels", () => {
  assert.deepEqual(targetSize(100, 50, 3), { width: 200, height: 100 });
  assert.deepEqual(targetSize(100, 50, 1.25), { width: 125, height: 63 });
  const big = targetSize(3840, 2160, 2);
  assert.ok(big.width * big.height <= 8_000_000 + 4000);
  near(big.width / big.height, 3840 / 2160, 0.01);
  assert.ok(targetSize(20000, 10, 1, 4096).width <= 4096);
  for (const bad of [
    [0, 10],
    [10, 0],
    [NaN, 10],
    [Infinity, 10],
  ])
    assert.equal(targetSize(bad[0], bad[1], 1), null);
});

test("degenerate rects are not drawn", () => {
  assert.equal(validRect(null), null);
  assert.equal(validRect({ x: 0, y: 0, width: 0, height: 10 }), null);
  assert.equal(validRect({ x: NaN, y: 0, width: 10, height: 10 }), null);
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(validRect(rect), rect);
  const u = edgeLightUniforms({ rectFrame: { x: 0, y: 0, width: -1, height: 4 }, lightStart: { x: 0, y: 0 }, lightEnd: { x: 1, y: 1 } }, 0, 10, 10);
  assert.deepEqual(u.rectFrame, [0, 0, 0, 0]);
  assert.deepEqual(u.diaLogoFrame, [0, 0, 0, 0]);
});

test("area light settles: no tilt before the intro, half lift when unfocused, still after its run", () => {
  const props = { source: { x: 0, y: 0, width: 100, height: 50 } };
  const start = areaLightUniforms(props, 1, 0, true, true, 400, 300);
  near(start.rotationTrig[1], 0, 0.02);
  const focused = areaLightUniforms(props, 1, 5, true, true, 400, 300);
  const blurred = areaLightUniforms(props, 1, 5, false, true, 400, 300);
  assert.ok(focused.lift > blurred.lift);
  near(areaLightUniforms(props, 1, 60, true, true, 400, 300).time, 0.75 * 60 + 0.25 * 60 * 0.5);
});

test("power-up colours are OKLab, one stop per palette colour", () => {
  const u = powerUpUniforms({ palette: ["#FFFFFF", "#000000"] }, 0);
  assert.equal(u.numberOfColors, 2);
  near(u.colors[0], 1, 1e-4);
  near(u.colors[4], 0);
});
