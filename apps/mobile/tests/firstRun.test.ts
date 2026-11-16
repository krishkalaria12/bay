// The welcome's way through (src/onboarding/flow.ts): which page follows which, what the dots count, what Skip does,
// and that its drawing fits the screen.
import assert from "node:assert/strict";
import test from "node:test";

import { asksAboutLinks, back, forward, hero, pageCount, pageOf, skipOpensField, STAGE, stageNeeds, stageScale, type Step } from "../src/onboarding/flow.ts";

const steps: Step[] = ["welcome", "desktop", "field", "private", "links", "end"];

test("the button walks every page, and links only while Bay can ask", () => {
  const walk = (asksLinks: boolean) => {
    const seen: Step[] = [];
    let step: Step | "finish" = "welcome";

    while (step !== "finish") {
      seen.push(step);
      step = forward(step, asksLinks);
    }

    return seen;
  };

  assert.deepEqual(walk(true), ["welcome", "desktop", "field", "private", "links"]);
  assert.deepEqual(walk(false), ["welcome", "desktop", "field", "private"]);
});

test("back retraces the pages, and there's no going back from the first or the end", () => {
  assert.equal(back("welcome"), null);
  assert.equal(back("end"), null);
  assert.equal(back("desktop"), "welcome");
  assert.equal(back("links"), "private");
});

test("the dots count the pages there are, and the last dot stays lit at the end", () => {
  assert.equal(pageCount(true), 5);
  assert.equal(pageCount(false), 4);
  assert.deepEqual(
    steps.map((step) => pageOf(step, true)),
    [0, 1, 2, 3, 4, 4],
  );
  assert.equal(pageOf("end", false), 3);
});

test("skip opens the real field, except once past the field's page", () => {
  assert.equal(skipOpensField("welcome"), true);
  assert.equal(skipOpensField("field"), true);
  assert.equal(skipOpensField("private"), false);
  assert.equal(skipOpensField("links"), false);
});

test("Bay asks to be the default browser only where it can be and isn't", () => {
  assert.equal(asksAboutLinks("not"), true);
  assert.equal(asksAboutLinks("unknown"), true);
  assert.equal(asksAboutLinks("default"), false);
  assert.equal(asksAboutLinks("unavailable"), false);
});

test("the glass stays on the stage on every page", () => {
  for (const step of steps) {
    const rect = hero(step);

    assert.ok(rect.x >= 0 && rect.x + rect.width <= STAGE.width, step);
    assert.ok(rect.y >= 0 && rect.y + rect.height <= STAGE.height, step);
  }
});

test("the drawing scales to the screen's width, and down to leave the words their room", () => {
  assert.equal(stageScale(402, 1000, "field"), 1);
  assert.equal(stageScale(1000, 1000, "field"), 1.1);
  assert.ok(Math.abs(stageScale(402, 200, "field") - 200 / stageNeeds("field")) < 1e-9);
  assert.equal(stageScale(402, 10, "field"), 0.45);
});
