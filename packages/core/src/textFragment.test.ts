import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseTextFragment, withTextFragment } from "./textFragment.ts";

test("a short quote uses an exact, encoded fragment and preserves the page anchor", () => {
  const fragment = chooseTextFragment({ selected: "a meaningful quote", before: "", after: "", pageText: "a meaningful quote" });
  assert.deepEqual(fragment, { start: "a meaningful quote" });
  assert.equal(withTextFragment("https://example.com/#section:~:text=old", fragment!), "https://example.com/#section:~:text=a%20meaningful%20quote");
});

test("long repetitive selections retain their range and context", () => {
  const words = Array.from({ length: 2000 }, () => "a");
  assert.deepEqual(chooseTextFragment({ selected: words.join(" "), before: "intro ", after: "", pageText: `intro ${words.join(" ")}` }), {
    prefix: "intro",
    start: words.slice(0, 1000).join(" "),
    end: words.slice(0, 1000).join(" "),
  });
});

test("range disambiguation still chooses the first unique prefix", () => {
  const selected = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
  for (let uniqueAt = 4; uniqueAt <= 8; uniqueAt++) {
    const words = selected.split(" ");
    const repeated = words.slice(0, uniqueAt - 1).join(" ");
    const fragment = chooseTextFragment({ selected, before: "", after: "", pageText: `${selected}\n${repeated} different` });
    assert.deepEqual(fragment, { start: words.slice(0, uniqueAt).join(" "), end: words.slice(-uniqueAt).join(" ") });
  }
});

test("multi-paragraph quotes choose start and end from their respective blocks", () => {
  const selected = "the first paragraph has enough words\nthe final paragraph ends here";
  assert.deepEqual(chooseTextFragment({ selected, before: "", after: "", pageText: selected }), { start: "the first paragraph", end: "paragraph ends here" });
});
