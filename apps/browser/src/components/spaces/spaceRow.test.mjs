import test from "node:test";
import assert from "node:assert/strict";
import { centres, cellWidths, iconWindow, ICON_SLOT } from "./spaceRow.ts";
import { DOTS_CELL, SPACE_GAP } from "./constants.ts";

const show = (icons) => icons.map((icon) => (icon ? "I" : ".")).join("");

// Room for six spaces' dots and three icons, not for six icons.
const room = 6 * DOTS_CELL + 3 * (ICON_SLOT - DOTS_CELL);

test("every space keeps its icon while they all fit", () => {
  assert.equal(show(iconWindow(4, 2, 4 * ICON_SLOT - SPACE_GAP)), "IIII");
});

test("past that, the current space and its neighbours keep theirs, held inside the row at either end", () => {
  assert.equal(show(iconWindow(6, 0, room)), "III...");
  assert.equal(show(iconWindow(6, 1, room)), "III...");
  assert.equal(show(iconWindow(6, 3, room)), "..III.");
  assert.equal(show(iconWindow(6, 5, room)), "...III");
});

test("never more than three, and fewer when the row is narrower", () => {
  // Room for four icons among the dots, still not for all six.
  assert.equal(show(iconWindow(6, 2, room + ICON_SLOT)), ".III..");
  assert.equal(show(iconWindow(6, 3, 6 * DOTS_CELL + (ICON_SLOT - DOTS_CELL))), "...I..");
  assert.equal(show(iconWindow(6, 3, 6 * DOTS_CELL)), "...I..", "the current space always has its icon");
  assert.equal(show(iconWindow(6, -1, room)), "......", "an incognito window has no current space here");
});

test("a cell's centre is halfway across it, after the cells before it", () => {
  assert.deepEqual(centres(cellWidths([true, false, false])), [ICON_SLOT / 2, ICON_SLOT + DOTS_CELL / 2, ICON_SLOT + DOTS_CELL * 1.5]);
});
