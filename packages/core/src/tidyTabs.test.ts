import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TIDY_TABS, MIN_TIDY_TABS, offersTidy, planTidyTabs, tidyTabsPrompt } from "./tidyTabs.ts";

test("tidy is offered from six tabs with one loose, and again only after a new tab", () => {
  assert.equal(offersTidy(MIN_TIDY_TABS - 1, ["a"], null), false);
  assert.equal(offersTidy(MIN_TIDY_TABS, ["a"], null), true);
  assert.equal(offersTidy(MIN_TIDY_TABS, [], null), false);
  assert.equal(offersTidy(MIN_TIDY_TABS, ["a"], new Set(["a"])), false);
  assert.equal(offersTidy(MIN_TIDY_TABS, ["a", "b"], new Set(["a"])), true);
});

test("the prompt lists each tab with its site and the groups it can join", () => {
  const prompt = tidyTabsPrompt(
    [
      { title: "Mars\n facts", host: "nasa.gov" },
      { title: "", host: "example.com" },
      { title: "Local", host: "" },
    ],
    ["Planets"],
  );

  assert.equal(
    prompt,
    `Here are my tabs, as 'id: title (site)':\n0: Mars facts (nasa.gov)\n1: example.com (example.com)\n2: Local\n\nI already have these groups. Reuse a name exactly only for a tab about that group's subject; a tab that isn't stays out of it: "Planets".`,
  );
});

test("the prompt stops at the model's limit and clips long titles", () => {
  const tabs = Array.from({ length: MAX_TIDY_TABS + 5 }, (_, i) => ({ title: "x".repeat(200), host: `${i}.com` }));
  const lines = tidyTabsPrompt(tabs, []).split("\n");
  assert.equal(lines.length, MAX_TIDY_TABS + 1);
  assert.ok(lines[1]!.length < 100);
});

test("a plan drops lone tabs, unknown ids and tabs another group took", () => {
  const plan = planTidyTabs(
    [
      { name: "Planets", tabs: [5, 0, 99, -1, 1.5] },
      { name: "Trip", tabs: [0, 2, 2] },
      { name: "Lone", tabs: [3] },
    ],
    6,
    [],
  );

  assert.deepEqual(plan, { newGroups: [{ name: "Planets", tabs: [0, 5] }], joins: [] });
});

test("a plan keeps groups in the order of their first tab and merges one name given twice", () => {
  const plan = planTidyTabs(
    [
      { name: "Work", tabs: [4, 5] },
      { name: "Trip", tabs: [0] },
      { name: "trip.", tabs: [3] },
    ],
    6,
    [],
  );

  assert.deepEqual(plan.newGroups, [
    { name: "Trip", tabs: [0, 3] },
    { name: "Work", tabs: [4, 5] },
  ]);
});

test("a name matching an existing group adds to it, even for one tab", () => {
  const plan = planTidyTabs([{ name: "PLANÉTS", tabs: [2] }], 3, ["Other group", "Planets"]);
  assert.deepEqual(plan, { newGroups: [], joins: [{ group: 1, tabs: [2] }] });
});

test("catch-all and empty names leave their tabs loose", () => {
  const plan = planTidyTabs(
    [
      { name: "Miscellaneous", tabs: [0, 1] },
      { name: " … ", tabs: [2, 3] },
    ],
    4,
    [],
  );

  assert.deepEqual(plan, { newGroups: [], joins: [] });
});

test("a name is capped to fit a row", () => {
  const [group] = planTidyTabs([{ name: "A very long group name that keeps going on and on", tabs: [0, 1] }], 2, []).newGroups;
  assert.ok(group!.name.length <= 32);
});
