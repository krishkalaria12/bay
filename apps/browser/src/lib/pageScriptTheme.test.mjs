import assert from "node:assert/strict";
import * as v from "valibot";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../../../../packages/chromium/ios/page_script.js", import.meta.url), "utf8");
const start = script.indexOf("  // MARK: Theme color");
const end = script.indexOf("  // MARK: Pinch zoom", start);

assert.ok(start > 0 && end > start, "extract the complete production theme block, including its event wiring");

const source = script.slice(start, end);

function page(contents = [], initialOverride = null) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const observers = [];
  const queries = new Map();
  const sent = [];
  const samples = [];
  const stats = { probes: 0, probeAppends: 0, probeRemovals: 0, hitTests: 0 };
  const appearance = { color: "rgb(10, 20, 30)", override: initialOverride };
  const listeners = new Map();

  const listen = (target, type, fn) => {
    const key = `${target}:${type}`;

    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
  };

  const fire = (target, type, event = {}) => {
    for (const fn of listeners.get(`${target}:${type}`) || []) fn({ type, ...event });
  };

  const mutate = (target, type, attributeName) => {
    for (const observer of observers) {
      if (
        observer.targets.some(([node, options]) => {
          const within = target === node || (options.subtree && target.parentElement === node);

          return within && options[type] && (type !== "attributes" || !options.attributeFilter || options.attributeFilter.includes(attributeName));
        })
      )
        observer.callback([{ target, type, attributeName }]);
    }
  };

  class Element {
    constructor(parentElement = null, attributes = {}) {
      this.parentElement = parentElement;
      this.attributes = attributes;
      const priorities = {};
      this.style = {
        setProperty(name, value, priority) {
          this[name] = value;
          priorities[name] = priority;
        },
        getPropertyPriority: (name) => priorities[name] ?? "",
      };
      this.backgroundColor = "rgba(0, 0, 0, 0)";
      this.position = "static";
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
      mutate(this, "attributes", name);
    }
    appendChild(child) {
      if (child.probe) stats.probeAppends++;
      child.parentElement = this;
      mutate(this, "childList");
    }
    remove() {
      if (this.probe) stats.probeRemovals++;
      const parent = this.parentElement;
      this.parentElement = null;
      mutate(parent, "childList");
    }
  }

  const root = new Element();
  const head = new Element(root);
  const body = new Element(root);
  body.backgroundColor = "rgb(255, 255, 255)";
  const header = new Element(body);
  header.position = "sticky";
  header.backgroundColor = "rgb(20, 30, 40)";

  const metas = contents.map(
    (content) => new Element(head, v.is(v.string(), content) ? { name: "theme-color", content } : { name: "theme-color", ...content }),
  );

  const matchMedia = (media) => {
    if (!queries.has(media)) {
      const handlers = new Set();
      queries.set(media, {
        matches: false,
        addEventListener: (_type, fn) => handlers.add(fn),
        removeEventListener: (_type, fn) => handlers.delete(fn),
        change(matches) {
          this.matches = matches;

          for (const fn of handlers) fn();
        },
        handlers,
      });
    }

    return queries.get(media);
  };

  const resolveColor = (value, important) => {
    if (appearance.override && !important) return appearance.override;

    if (/^(?:var\(|currentcolor$|canvas$|light-dark\(|rgb\(from)/i.test(value)) return appearance.color;

    if (value === "red") return "rgb(255, 0, 0)";

    if (value === "transparent") return "rgba(0, 0, 0, 0)";

    if (value.startsWith("#")) {
      const hex =
        value.length === 4
          ? value
              .slice(1)
              .split("")
              .map((c) => c + c)
              .join("")
          : value.slice(1);

      return `rgb(${[0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    }

    return value;
  };

  const document = {
    documentElement: root,
    head,
    body,
    querySelectorAll: () => metas.filter((m) => m.parentElement === head && m.getAttribute("name") === "theme-color"),
    createElement: () => Object.assign(new Element(), { probe: true }),
    elementFromPoint: () => {
      stats.hitTests++;
      samples.push(now);

      return header;
    },
    addEventListener: (type, fn) => listen("document", type, fn),
  };

  const setTimeout = (fn, ms) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + ms, fn });

    return id;
  };

  const window = { scrollY: 0 };
  runInNewContext(
    source,
    {
      window,
      document,
      innerWidth: 1000,
      matchMedia,
      getComputedStyle: (el) => {
        if (el.style.color) {
          stats.probes++;

          return { color: resolveColor(el.style.color, el.style.getPropertyPriority("color") === "important") };
        }

        return { backgroundColor: el.backgroundColor, position: el.position, colorScheme: "light dark" };
      },
      MutationObserver: class {
        constructor(callback) {
          this.callback = callback;
          this.targets = [];
          observers.push(this);
        }
        observe(node, options) {
          this.targets.push([node, options]);
        }
      },
      performance: { now: () => now },
      setTimeout,
      clearTimeout: (id) => timers.delete(id),
      requestAnimationFrame: (fn) => setTimeout(fn, 16),
      addEventListener: (type, fn) => listen("window", type, fn),
      onReady: (fn) => fn(),
      guard: (fn) => fn,
      send: (kind, data) => sent.push({ at: now, kind, ...JSON.parse(JSON.stringify(data)) }),
    },
    { filename: "page_script.theme.js" },
  );

  const advance = (ms) => {
    const until = now + ms;

    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];

      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }

    now = until;
  };

  const warm = () => {
    advance(3100);

    for (const key of Object.keys(stats)) stats[key] = 0;
    samples.length = sent.length = 0;
  };

  return {
    stats,
    sent,
    samples,
    root,
    head,
    header,
    metas,
    appearance,
    matchMedia,
    advance,
    warm,
    fire: (type, event) => fire("window", type, event),
    fireDocument: (type) => fire("document", type),
    mutate,
    scroll: () => {
      window.scrollY++;
      fire("window", "scroll");
    },
  };
}

for (const value of ["#123456", "#abc", "red", "rgb(12, 34, 56)", "rgba(12, 34, 56, 0.8)"]) {
  test(`stable ${value} meta avoids repeated normalization probes while scrolling`, () => {
    const p = page([value]);
    assert.equal(p.stats.probes, 1);
    p.warm();

    for (let i = 0; i < 60; i++) {
      p.scroll();
      p.advance(16);
    }

    p.advance(116);
    assert.equal(p.stats.probes, 0);
    assert.equal(p.stats.probeAppends, 0);
    assert.equal(p.stats.probeRemovals, 0);
    assert.equal(p.stats.hitTests, 0);
    assert.equal(p.sent.length, 0, "unchanged reports remain deduplicated");
  });
}

test("scroll hit-testing is bounded and a final sample captures the settled dynamic header", () => {
  const p = page();
  p.warm();

  for (let i = 1; i <= 60; i++) {
    p.header.backgroundColor = `rgb(${i}, 0, 0)`;
    p.scroll();
    p.advance(16);
  }

  p.advance(116);
  assert.ok(p.stats.hitTests > 1 && p.stats.hitTests <= 11, `sampled ${p.stats.hitTests} times for 60 scroll frames`);

  for (let i = 1; i < p.samples.length; i++) assert.ok(p.samples[i] - p.samples[i - 1] >= 100);
  assert.equal(p.sent.at(-1).color, "#3C0000");
  assert.equal(p.sent.at(-1).source, "header");
});

test("a scroll inside the throttle interval still gets a trailing update", () => {
  const p = page();
  p.header.backgroundColor = "rgb(100, 0, 0)";
  p.advance(1);
  p.scroll();
  p.advance(99);
  assert.equal(p.stats.hitTests, 1);
  p.advance(17);
  assert.equal(p.stats.hitTests, 2);
  assert.equal(p.sent.at(-1).color, "#640000");
});

for (const value of ["var(--theme)", "currentColor", "Canvas", "light-dark(white, black)", "rgb(from currentColor r g b)"]) {
  test(`${value} remains live instead of entering the literal cache`, () => {
    const p = page([value]);
    p.warm();
    p.appearance.color = "rgb(90, 80, 70)";
    p.scroll();
    p.advance(116);
    assert.ok(p.stats.probes > 0);
    assert.equal(p.sent.at(-1).color, "#5A5046");
  });
}

test("cached literals normalize independently of author important rules and unobserved style changes", () => {
  const p = page(["#123456"], "rgb(255, 255, 255)");
  assert.equal(p.sent.at(-1).color, "#123456");
  p.warm();
  p.appearance.override = "rgb(1, 2, 3)";
  p.root.setAttribute("data-mode", "dark");
  p.scroll();
  p.advance(116);
  assert.equal(p.stats.probes, 0);
  assert.equal(p.sent.length, 0, "an author rule does not change an absolute meta color");
});

test("meta content and root appearance mutations invalidate cached normalization immediately", () => {
  const p = page(["#123456"]);
  p.metas[0].setAttribute("content", "#654321");
  p.advance(16);
  assert.equal(p.sent.at(-1).color, "#654321");
  p.metas[0].setAttribute("content", "currentColor");
  p.advance(16);
  p.appearance.override = "rgb(1, 2, 3)";
  p.root.setAttribute("class", "dark");
  p.advance(16);
  assert.equal(p.sent.at(-1).color, "#010203");
  assert.equal(p.stats.probes, 4);
  p.metas[0].setAttribute("name", "other");
  p.advance(16);
  assert.equal(p.sent.at(-1).source, "header");
});

test("stylesheet text mutations and dark appearance changes refresh contextual colors", () => {
  const p = page(["currentColor"]);
  p.appearance.color = "rgb(2, 4, 6)";
  p.mutate({ parentElement: p.head }, "characterData");
  p.advance(16);
  assert.equal(p.sent.at(-1).color, "#020406");
  p.appearance.color = "rgb(9, 8, 7)";
  p.matchMedia("(prefers-color-scheme: dark)").change(true);
  p.advance(16);
  assert.equal(p.sent.at(-1).color, "#090807");
});

test("all meta media queries are watched, including inactive entries, and old listeners are removed", () => {
  const p = page([{ content: "#111111", media: "(min-width: 800px)" }, { content: "#222222", media: "(prefers-contrast: more)" }, "#333333"]);
  assert.equal(p.sent.at(-1).color, "#333333");
  p.matchMedia("(prefers-contrast: more)").change(true);
  p.advance(16);
  assert.equal(p.sent.at(-1).color, "#222222");
  p.matchMedia("(min-width: 800px)").change(true);
  p.advance(16);
  assert.equal(p.sent.at(-1).color, "#111111");
  p.metas[0].setAttribute("media", "print");
  p.advance(16);
  assert.equal(p.sent.at(-1).color, "#222222");
  assert.equal(p.matchMedia("(min-width: 800px)").handlers.size, 0);
  p.metas[1].remove();
  p.advance(16);
  assert.equal(p.matchMedia("(prefers-contrast: more)").handlers.size, 0);
  assert.equal(p.sent.at(-1).color, "#333333");
});

for (const event of ["load", "resize"]) {
  test(`${event} bypasses scroll throttling and refreshes cached colors`, () => {
    const p = page(["currentColor"]);
    p.appearance.override = "rgb(3, 2, 1)";
    p.fire(event);
    p.advance(16);
    assert.equal(p.sent.at(-1).color, "#030201");
    assert.equal(p.stats.probes, 2);
  });
}

test("restored and prerendered documents resend even an unchanged color", () => {
  const p = page(["red"]);
  p.fire("pageshow", { persisted: true });
  p.fireDocument("prerenderingchange");
  assert.equal(p.sent.length, 3);
  assert.ok(p.sent.every((message) => message.color === "#FF0000"));
});
