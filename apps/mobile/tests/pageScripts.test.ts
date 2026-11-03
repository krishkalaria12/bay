import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

import { ARTICLE_HELPERS } from "../src/pagescripts/article.ts";
import { MARKDOWN_SCRIPT } from "../src/pagescripts/markdown.ts";
import { hideElementsScript, PICK_PARENT_SCRIPT, START_PICKER_SCRIPT, STOP_PICKER_SCRIPT } from "../src/pagescripts/picker.ts";
import { CLOSE_READER_SCRIPT, DEFAULT_READER, openReaderScript, updateReaderScript } from "../src/pagescripts/reader.ts";
import { READABILITY, TURNDOWN } from "../src/pagescripts/vendor.generated.ts";

function fixture(html = '<section id="card"><a id="link" href="/next">Next</a></section>') {
  const dom = new JSDOM(html, { url: "https://example.com/story", runScripts: "outside-only" });
  const { window } = dom;
  const { document } = window;
  // Compatibility-click timing must not depend on host CPU load during parallel test runs.
  window.Date.now = () => 1_000;
  let target = document.getElementById("link");
  // Hit testing needs a layout engine. Everything else (DOM, selectors, shadow roots, CSS and events) is jsdom.
  document.elementFromPoint = () => target!;
  window.CSS = { escape: (str: string) => str } as any;
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
    add(type, listener, options);
  }) as typeof add;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => {
    listeners.get(type)?.delete(listener);
    remove(type, listener, options);
  }) as typeof remove;
  const messages: any[] = [];
  (window as any).post = (message: any) => messages.push(message);
  const context = dom.getInternalVMContext();
  // Both native bridges serialize the return value before delivering it back to React Native.
  const run = (source: string) => {
    const json = vm.runInContext(`JSON.stringify((() => { ${source}\n })())`, context);
    return json === undefined ? undefined : JSON.parse(json);
  };
  const event = (type: string, values: any = {}) => {
    const result = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(result, { clientX: 20, clientY: 30, touches: [], changedTouches: [], ...values });
    window.dispatchEvent(result);
    return { prevented: result.defaultPrevented };
  };
  return {
    document,
    window: window as any,
    messages,
    listeners,
    context,
    run,
    event,
    target: (el: any) => {
      target = el;
    },
  };
}

test("article markup strips executable content, handlers and unsafe URL schemes", () => {
  const { run } = fixture();
  const html = `<p onclick="evil()" style="color:red">Text <a href="javascript:evil()">bad</a><a href="/next">safe</a><img src="data:image/svg+xml,bad" onerror="evil()"><img src="/photo.png" alt="photo"><script>evil()</script><iframe src="/frame"></iframe><svg onload="evil()"></svg><bay-widget>custom</bay-widget></p>`;
  const output = run(`${ARTICLE_HELPERS}\nreturn safeArticle(${JSON.stringify(html)}).innerHTML;`);
  assert.doesNotMatch(output, /onclick|onerror|onload|style=|javascript:|data:|script|iframe|svg|bay-widget|custom/);
  assert.match(output, /href="https:\/\/example.com\/next"/);
  assert.match(output, /src="https:\/\/example.com\/photo.png"/);
  assert.match(output, /alt="photo"/);
});

test("Reader opens once, updates in place and restores the page overflow declaration", () => {
  const f = fixture();
  f.window[Symbol.for("bay.reader")] = {
    Readability: class {
      parse() {
        return { content: "<p>Article</p>", length: 300, title: "Story" };
      }
    },
  };
  f.document.documentElement.style.setProperty("overflow", "scroll", "important");
  assert.equal(f.run(openReaderScript(DEFAULT_READER)).ok, true);
  const state = f.window[Symbol.for("bay.reader")];
  const host = state.host;
  assert.equal(host.shadowRoot, null);
  assert.equal(f.document.getElementsByTagName("bay-reader").length, 1);
  assert.equal(f.run(openReaderScript({ ...DEFAULT_READER, theme: "black", size: 100 })).ok, true);
  assert.equal(state.host, host);
  assert.equal(host.style.getPropertyValue("--bay-size"), "28px");
  assert.equal(f.run(updateReaderScript({ ...DEFAULT_READER, size: NaN })), true);
  assert.equal(host.style.getPropertyValue("--bay-size"), "19px");
  assert.equal(f.run(CLOSE_READER_SCRIPT), true);
  assert.equal(f.document.getElementsByTagName("bay-reader").length, 0);
  assert.equal(f.document.documentElement.style.getPropertyValue("overflow"), "scroll");
  assert.equal(f.document.documentElement.style.getPropertyPriority("overflow"), "important");
  assert.equal(f.run(updateReaderScript(DEFAULT_READER)), false);
  assert.equal(f.run(CLOSE_READER_SCRIPT), true);
});

test("Reader declines pages without an article without changing the page", () => {
  const f = fixture();
  f.window[Symbol.for("bay.reader")] = {
    Readability: class {
      parse() {
        return null;
      }
    },
  };
  assert.equal(f.run(openReaderScript(DEFAULT_READER)).ok, false);
  assert.equal(f.document.getElementsByTagName("bay-reader").length, 0);
  assert.equal(f.document.documentElement.style.getPropertyValue("overflow"), "");
});

test("picker handles touch taps directly, suppresses page actions and lets a drag scroll", () => {
  const f = fixture();
  f.run(START_PICKER_SCRIPT);
  f.run(START_PICKER_SCRIPT);
  assert.equal(f.listeners.get("touchend")?.size, 1);
  assert.equal(f.event("pointerdown").prevented, false);
  const point = { clientX: 20, clientY: 30 };
  f.event("touchstart", { touches: [point] });
  const tap = f.event("touchend", { changedTouches: [point] });
  assert.equal(tap.prevented, true);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].type, "picked");
  assert.match(f.messages[0].selector, /a/);
  assert.equal(f.messages[0].label, "Link “Next”");
  assert.equal(f.messages[0].tag, "<a>");
  f.event("click");
  assert.equal(f.messages.length, 1, "compatibility click must not pick twice");
  f.event("touchstart", { touches: [point] });
  const move = f.event("touchmove", { touches: [{ clientX: 20, clientY: 100 }] });
  assert.equal(move.prevented, false);
  assert.equal(f.event("touchend", { changedTouches: [point] }).prevented, false);
  assert.equal(f.messages.length, 1, "a drag must not pick");
  assert.equal(f.run(PICK_PARENT_SCRIPT), true);
  assert.equal(f.messages[1].label, "Section “Next”");
  assert.equal(f.run(PICK_PARENT_SCRIPT), false);
  const picker = f.window[Symbol.for("bay.picker")];
  f.run(STOP_PICKER_SCRIPT);
  f.run(STOP_PICKER_SCRIPT);
  for (const type of picker.events) assert.equal(f.listeners.get(type)?.has(picker.onTap), false, type);
  assert.equal(f.listeners.get("scroll")?.has(picker.onScroll), false);
  assert.equal(f.listeners.get("resize")?.has(picker.onResize), false);
  assert.equal(f.document.getElementsByTagName("bay-picker").length, 0);
  f.event("click");
  assert.equal(f.messages.length, 2);
  f.run(START_PICKER_SCRIPT);
  f.event("click");
  assert.equal(f.messages.length, 3, "picker can restart after cleanup");
});

test("the picker describes elements in words, with whitespace collapsed", () => {
  const f = fixture('<section id="card"><a id="link" href="/past">  past\n   stories </a></section>');
  f.run(START_PICKER_SCRIPT);
  const point = { clientX: 20, clientY: 30 };
  f.event("touchstart", { touches: [point] });
  f.event("touchend", { changedTouches: [point] });
  assert.equal(f.messages[0].label, "Link “past stories”");
  f.run(STOP_PICKER_SCRIPT);
});

test("replacing hidden rules supports undo and ignores invalid selectors", () => {
  const f = fixture();
  assert.equal(f.run(hideElementsScript(["#card", "["])), 1);
  assert.match(f.document.head.textContent, /#card\{display:none!important\}/);
  assert.doesNotMatch(f.document.head.textContent, /\[\{/);
  assert.equal(f.run(hideElementsScript([])), 0);
  assert.equal(f.document.head.textContent, "");
  assert.equal(f.document.head.children.length, 1, "undo replaces the existing sheet");
  assert.ok(f.document.getElementById("card"), "hiding must preserve the page DOM");
});

test("embedded vendor constructors and every generated script parse as standalone page code", () => {
  assert.equal(typeof vm.runInNewContext(READABILITY), "function");
  assert.equal(typeof vm.runInNewContext(TURNDOWN, { window: {} }), "function");
  for (const script of [
    MARKDOWN_SCRIPT,
    openReaderScript(DEFAULT_READER),
    updateReaderScript(DEFAULT_READER),
    CLOSE_READER_SCRIPT,
    START_PICKER_SCRIPT,
    PICK_PARENT_SCRIPT,
    STOP_PICKER_SCRIPT,
    hideElementsScript([]),
  ])
    new vm.Script(`(async () => { ${script}\n })()`);
});

const paragraphs = Array.from(
  { length: 6 },
  (_, index) =>
    `<p>Paragraph ${index + 1}. ${"This is a readable article about the coast, the harbour, and the people who work there. ".repeat(6)} <a href="/next">Read more</a>.</p>`,
).join("");

test("real Readability and Turndown extract an article and produce Markdown with its address", () => {
  const f = fixture(`<title>Harbour story</title><article><h1>Harbour story</h1>${paragraphs}</article>`);
  const article = f.run(openReaderScript(DEFAULT_READER));
  assert.equal(article.ok, true);
  assert.equal(article.title, "Harbour story");
  const { markdown } = f.run(MARKDOWN_SCRIPT);
  assert.ok(markdown.startsWith("# Harbour story\n\n"));
  assert.match(markdown, /Paragraph 1\./);
  assert.match(markdown, /\[Read more\]\(https:\/\/example.com\/next\)/);
  assert.ok(markdown.endsWith("\n\nhttps://example.com/story\n"));
  assert.doesNotMatch(markdown, /bay-reader|--bay-/);
});

test("Markdown falls back to short page content when Readability finds no article", () => {
  const f = fixture('<title>Short page</title><p>Hello <strong>world</strong>. <a href="/next">Next</a></p>');
  f.window[Symbol.for("bay.markdown")] = {
    Readability: class {
      parse() {
        return null;
      }
    },
  };
  const { markdown } = f.run(MARKDOWN_SCRIPT);
  assert.match(markdown, /Hello \*\*world\*\*/);
  assert.match(markdown, /\[Next\]\(https:\/\/example.com\/next\)/);
});

test("the favicon script picks the page's best non-SVG icon, else /favicon.ico", async () => {
  const { FAVICON_SCRIPT } = await import("../src/pagescripts/favicon.ts");
  const icon = (head: string) => {
    const dom = new JSDOM(`<head>${head}</head>`, { url: "https://example.com/a/b", runScripts: "outside-only" });
    return JSON.parse(vm.runInContext(`JSON.stringify((() => { ${FAVICON_SCRIPT}\n })())`, dom.getInternalVMContext())).href;
  };
  assert.equal(icon(""), "https://example.com/favicon.ico");
  assert.equal(
    icon('<link rel="icon" href="/16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/i.svg" type="image/svg+xml">'),
    "https://example.com/touch.png",
  );
  assert.equal(icon('<link rel="shortcut icon" href="https://cdn.example.net/f.ico"><link rel="icon" href="/logo.svg">'), "https://cdn.example.net/f.ico");
});
