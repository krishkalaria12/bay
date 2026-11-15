// The chrome's layout and motion rules (src/chrome/layout.ts), ported with their measurements from Cra's CraCore tests.
import assert from "node:assert/strict";
import test from "node:test";

import {
  opensSwitcher,
  openSpring,
  pageBehindSearchTransform,
  pageMenuTileLefts,
  pageMenuTileWidth,
  searchSheetHeight,
  searchSheetRows,
  settleSpring,
  springConfig,
  springRemaining,
  swipeDirection,
  swipeMayStart,
  swipeNavigation,
  switcherProgress,
  tabCardCloses,
  tabCardLook,
  zoomStep,
} from "../src/chrome/layout.ts";

test("the search sheet sits where Arc Search puts it, and keeps its field in landscape", () => {
  assert.equal(searchSheetHeight(), 302);
  assert.equal(searchSheetRows(852, 291, 59), 4);
  assert.equal(searchSheetRows(402, 199, 0), 2);
  assert.equal(searchSheetRows(300, 290, 0), 0);
});

test("the page behind the sheet is a card 10 pt in, its top under the status bar", () => {
  const { scale, shiftDown } = pageBehindSearchTransform(393, 852, 59);
  assert.ok(Math.abs(scale - 373 / 393) < 1e-9);
  assert.ok(Math.abs((852 * (1 - scale)) / 2 + shiftDown - 59) < 1e-9);
});

test("four tiles fill the page menu's width and fewer stay centred", () => {
  assert.ok(Math.abs(pageMenuTileWidth(440) - 86) < 0.1);
  const three = pageMenuTileLefts(3, 440);
  const tile = pageMenuTileWidth(440);
  assert.ok(Math.abs(three[1]! + tile / 2 - 220) < 1e-9);
  assert.deepEqual(pageMenuTileLefts(0, 440), []);
});

test("zoom steps by tenths within its limits", () => {
  assert.equal(zoomStep(100, true), 110);
  assert.equal(zoomStep(110, false), 100);
  assert.equal(zoomStep(80, false, 80, 200), 80);
  assert.equal(zoomStep(200, true, 80, 200), 200);
  assert.equal(zoomStep(104, true), 110);
});

test("cards behind dim and shrink, cards to come grow a little", () => {
  assert.deepEqual(tabCardLook(0), { scale: 1, dim: 0 });
  const behind = tabCardLook(-1);
  assert.ok(Math.abs(behind.scale - 0.977) < 0.001);
  assert.equal(behind.dim, 0.16);
  assert.equal(tabCardLook(-0.5).dim, 0.08);
  assert.equal(tabCardLook(-10).scale, 0.9);
  assert.ok(tabCardLook(1).scale > 1);
  assert.equal(tabCardLook(10).scale, 1.02);
});

test("a card is thrown away by distance or by a flick", () => {
  assert.ok(tabCardCloses(-130, 0));
  assert.ok(tabCardCloses(-40, -900));
  assert.ok(!tabCardCloses(-40, -100));
  assert.ok(!tabCardCloses(200, 900));
});

test("the tab row settles at Arc Search's rate and a card opens within five frames", () => {
  const frame = 1 / 30;
  const ratio = springRemaining(settleSpring, 6 * frame) / springRemaining(settleSpring, 5 * frame);
  assert.ok(Math.abs(ratio - 0.6) < 0.08);
  assert.ok(springRemaining(settleSpring, 0.3) < 0.03);
  const config = springConfig(settleSpring);
  assert.ok(Math.abs(config.stiffness - 341.5) < 1);
  assert.ok(Math.abs(config.damping - 36.96) < 0.1);
  assert.ok(springRemaining(openSpring, 5 / 30) < 0.1);
});

test("dragging the bar up opens the switcher by distance or by a flick", () => {
  assert.equal(switcherProgress(150), 0.5);
  assert.equal(switcherProgress(900), 1);
  assert.ok(opensSwitcher(120, 0));
  assert.ok(opensSwitcher(40, 800));
  assert.ok(!opensSwitcher(40, 100));
});

test("a swipe commits by distance or by a flick in its own direction", () => {
  assert.equal(swipeDirection(150, 0, 393), 1);
  assert.equal(swipeDirection(-150, 0, 393), -1);
  assert.equal(swipeDirection(60, 0, 393), 0);
  assert.equal(swipeDirection(60, 900, 393), 1);
  assert.equal(swipeDirection(60, -900, 393), 0);
  assert.equal(swipeDirection(10, 2000, 393), 0);
});

test("back on a tab's first page archives it, and forward right after brings it back", () => {
  const state = (over: Partial<Parameters<typeof swipeNavigation>[1]> = {}) => ({
    canGoBack: false,
    canGoForward: false,
    hasOtherTab: true,
    canReopenTab: false,
    ...over,
  });

  assert.equal(swipeNavigation(1, state({ canGoBack: true })), "back");
  assert.equal(swipeNavigation(1, state()), "archiveTab");
  assert.equal(swipeNavigation(1, state({ hasOtherTab: false })), "none");
  assert.equal(swipeNavigation(-1, state({ canGoForward: true, canReopenTab: true })), "forward");
  assert.equal(swipeNavigation(-1, state({ canReopenTab: true })), "reopenTab");
  assert.equal(swipeNavigation(-1, state()), "none");
  assert.equal(swipeNavigation(0, state({ canGoBack: true })), "none");
});

test("edges only keeps the swipe to the sides, and off keeps it nowhere", () => {
  assert.ok(swipeMayStart(200, 393, "anywhere"));
  assert.ok(!swipeMayStart(200, 393, "edges"));
  assert.ok(swipeMayStart(10, 393, "edges"));
  assert.ok(swipeMayStart(385, 393, "edges"));
  assert.ok(!swipeMayStart(10, 393, "off"));
});
