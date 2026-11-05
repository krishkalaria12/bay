import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

import { FIND_CLEAR_SCRIPT, findScript, findStepScript } from "../src/pagescripts/find.ts";
import { INSPECT_SCRIPT } from "../src/pagescripts/inspect.ts";
import { parseMediaMessage } from "../src/pagescripts/media.ts";
import { START_PICKER_SCRIPT } from "../src/pagescripts/picker.ts";

function page(body: string, { highlights = false } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>.lead { color: rgb(255, 0, 0); font-family: "Brand Sans", Georgia, serif; }</style></head><body>${body}</body></html>`,
    {
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  // Layout isn't part of jsdom: every range is on screen.
  (window.Range.prototype as any).getBoundingClientRect = () => ({ top: 100, bottom: 120, left: 0, right: 10, width: 10, height: 20 });
  window.scrollBy = (() => {}) as any;
  (window as any).CSS = { escape: (value: string) => value };
  (window as any).post = () => {};
  const marks = new Map<string, unknown[]>();
  if (highlights) {
    (window as any).CSS.highlights = marks;
    (window as any).Highlight = class {
      ranges: unknown[];
      constructor(...ranges: unknown[]) {
        this.ranges = ranges;
      }
    };
    (window as any).CSSStyleSheet = class {
      text = "";
      replaceSync(text: string) {
        this.text = text;
      }
    };
    (window.document as any).adoptedStyleSheets = [];
  }
  const context = dom.getInternalVMContext();
  const run = (source: string) => JSON.parse(vm.runInContext(`JSON.stringify((() => { ${source}\n })())`, context));
  return { window, document: window.document, run, marks };
}

test("find counts matches case-insensitively in visible text only", () => {
  const { run, window } = page(`<p>Cat cat CAT</p><p hidden-style style="display:none">cat</p><script>var cat</script><p>concatenate</p>`);
  const found = run(findScript("cat"));
  assert.deepEqual(found, { count: 4, index: 0 });
  assert.equal(window.getSelection()!.toString(), "Cat");
});

test("find steps through matches and wraps", () => {
  const { run, window } = page(`<p>one two one</p><p>one</p>`);
  run(findScript("one"));
  assert.deepEqual(run(findStepScript(1)), { count: 3, index: 1 });
  assert.deepEqual(run(findStepScript(1)), { count: 3, index: 2 });
  assert.deepEqual(run(findStepScript(1)), { count: 3, index: 0 });
  assert.deepEqual(run(findStepScript(-1)), { count: 3, index: 2 });
  assert.equal(window.getSelection()!.toString(), "one");
});

test("find with no matches, an empty query, or after clearing reports none", () => {
  const { run } = page(`<p>hello</p>`);
  assert.deepEqual(run(findScript("absent")), { count: 0, index: -1 });
  assert.deepEqual(run(findScript("   ")), { count: 0, index: -1 });
  run(findScript("hello"));
  assert.equal(run(FIND_CLEAR_SCRIPT), true);
  assert.deepEqual(run(findStepScript(1)), { count: 0, index: -1 });
});

test("find marks matches with highlights and a constructed style sheet, and clearing removes them", () => {
  const { run, document, marks } = page(`<p>ab ab ab</p>`, { highlights: true });
  run(findScript("ab"));
  assert.equal((marks.get("bay-find") as any).ranges.length, 3);
  assert.equal((marks.get("bay-find-current") as any).ranges.length, 1);
  assert.equal((document as any).adoptedStyleSheets.length, 1);
  assert.match((document as any).adoptedStyleSheets[0].text, /::highlight\(bay-find-current\)/);
  // The page's DOM is untouched.
  assert.equal(document.body.innerHTML, "<p>ab ab ab</p>");
  run(FIND_CLEAR_SCRIPT);
  assert.equal(marks.size, 0);
  assert.equal((document as any).adoptedStyleSheets.length, 0);
});

test("inspect describes the picked element with its font and matched rules", () => {
  const { run, window, document } = page(`<main><p id="intro" class="lead">Hello <b>there</b></p></main>`);
  assert.equal(run(INSPECT_SCRIPT), null);
  run(START_PICKER_SCRIPT);
  (window as any)[Symbol.for("bay.picker")].current = document.getElementById("intro");
  const element = run(INSPECT_SCRIPT);
  assert.equal(element.name, "p#intro.lead");
  assert.equal(element.selector, "#intro");
  assert.equal(element.text, "Hello there");
  assert.equal(element.color, "#ff0000");
  // jsdom has no canvas, so the swatch keeps the page's value.
  assert.equal(element.swatches.color, "#ff0000");
  assert.deepEqual(element.font.stack, ["Brand Sans", "Georgia", "serif"]);
  // jsdom can't measure text, so no named family is installed: the generic fallback renders it.
  assert.equal(element.font.rendered, "serif");
  assert.equal(element.font.web, false);
  assert.deepEqual(element.rules[0].selector, ".lead");
  assert.match(element.agent, /Element `p#intro.lead`/);
  assert.match(element.agent, /```css/);
});

test("media reports from the page are checked before they're used", () => {
  assert.deepEqual(parseMediaMessage(JSON.stringify({ type: "media", playing: true, title: "Song", video: false })), {
    type: "media",
    playing: true,
    title: "Song",
    video: false,
  });
  assert.equal(parseMediaMessage(JSON.stringify({ type: "media", playing: "yes", title: "Song", video: false })), null);
  assert.equal(parseMediaMessage("not json"), null);
});
