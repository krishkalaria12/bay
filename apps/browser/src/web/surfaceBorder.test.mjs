import assert from "node:assert/strict";
import { test } from "node:test";
import { surfaceBorderColors } from "../../../../packages/desktop/src/webSurfaceBorder.ts";

test("a surface with no border colour never falls back to the browser's black", () => {
  assert.deepEqual(surfaceBorderColors(undefined, undefined), { borderColor: "transparent" });
  assert.deepEqual(surfaceBorderColors(undefined, []), { borderColor: "transparent" });
  assert.deepEqual(surfaceBorderColors("#123456", undefined), { borderColor: "#123456" });
});

test("two border colours run from top to bottom, as the theme's selected tab asks", () => {
  const { borderTopColor, borderBottomColor, borderLeftColor, borderRightColor } = surfaceBorderColors(undefined, ["#FFFFFF00", "#00000010"]);
  assert.equal(borderTopColor, "#FFFFFF00");
  assert.equal(borderBottomColor, "#00000010");
  assert.equal(borderLeftColor, "color-mix(in srgb, #FFFFFF00, #00000010)");
  assert.equal(borderRightColor, borderLeftColor);
});
