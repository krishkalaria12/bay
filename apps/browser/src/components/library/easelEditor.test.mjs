import test from "node:test";
import assert from "node:assert/strict";
import { contentBounds, EaselEditor, safeUrl } from "../../../../../packages/shell/src/easelEditor.ts";

const none = { shift: false, option: false, command: false };
const click = { ...none, button: 0, clickCount: 1 };
const doc = (items = [], extra = {}) =>
  JSON.stringify({ id: "easel", title: "T", background: "#FFFFFF", items, createdAt: 1, updatedAt: 1, spaceId: "s", ...extra });
const rect = (id, x, y, width = 100, height = 100) => ({ id, kind: "rect", x, y, width, height });

function editor(items = []) {
  const events = { emitted: [], opened: [], links: [], text: null };
  const easel = new EaselEditor({
    size: () => ({ width: 800, height: 600 }),
    changed() {},
    emit: (state) => events.emitted.push(state),
    openLink: (url) => events.links.push(url),
    openEditor: (item, key) => {
      events.opened.push({ item, key });
      events.text = String(item[key] ?? "");
    },
    editorText: () => events.text,
    closeEditor: () => (events.text = null),
  });
  easel.load(doc(items));
  return { easel, events, last: () => events.emitted.at(-1) };
}
const drag = (easel, from, to, modifiers = none) => {
  easel.pointerDown(from, { ...modifiers, button: 0, clickCount: 1 });
  easel.pointerMove(to, modifiers);
  easel.pointerUp();
};

test("a dragged shape moves, and the document is reported once, when it lands", () => {
  const { easel, events } = editor([rect("a", 10, 10)]);
  easel.pointerDown({ x: 20, y: 20 }, click);
  const before = events.emitted.at(-1).document;
  easel.pointerMove({ x: 60, y: 90 }, none);
  easel.pointerMove({ x: 70, y: 100 }, none);
  assert.equal(events.emitted.at(-1).document, before, "no save while it's dragged");
  easel.pointerUp();
  const moved = JSON.parse(events.emitted.at(-1).document).items[0];
  assert.deepEqual([moved.x, moved.y], [60, 90]);
});

test("undo and redo step through edits, and a new edit drops the redo", () => {
  const { easel } = editor([rect("a", 0, 0)]);
  drag(easel, { x: 10, y: 10 }, { x: 110, y: 10 });
  assert.equal(easel.items[0].x, 100);
  easel.undo();
  assert.equal(easel.items[0].x, 0);
  assert.equal(easel.canRedo, true);
  easel.redo();
  assert.equal(easel.items[0].x, 100);
  easel.undo();
  easel.addText("hi");
  assert.equal(easel.canRedo, false);
});

test("an echo of the canvas's own edit keeps its selection and undo", () => {
  const { easel, last } = editor([rect("a", 0, 0)]);
  drag(easel, { x: 10, y: 10 }, { x: 110, y: 10 });
  const echoed = JSON.parse(last().document);
  easel.load(JSON.stringify({ ...echoed, title: "Renamed", updatedAt: 99 }));
  assert.equal(easel.document.title, "Renamed");
  assert.equal(easel.canUndo, true);
  assert.deepEqual([...easel.selection], ["a"]);
});

test("an older echo of its own edit doesn't undo a newer one", () => {
  const { easel, last } = editor([rect("a", 0, 0)]);
  drag(easel, { x: 10, y: 10 }, { x: 110, y: 10 });
  const older = last().document;
  drag(easel, { x: 110, y: 10 }, { x: 210, y: 10 });
  easel.load(older);
  assert.equal(easel.items[0].x, 200);
});

test("another window's edit replaces the canvas and its undo", () => {
  const { easel } = editor([rect("a", 0, 0)]);
  drag(easel, { x: 10, y: 10 }, { x: 110, y: 10 });
  easel.load(doc([rect("b", 5, 5)], { nativeEditId: "elsewhere" }));
  assert.deepEqual(
    easel.items.map((i) => i.id),
    ["b"],
  );
  assert.equal(easel.canUndo, false);
  assert.equal(easel.selection.size, 0);
});

test("a marquee selects what it touches, and shift adds to the selection", () => {
  const { easel } = editor([rect("a", 0, 0, 50, 50), rect("b", 200, 0, 50, 50), rect("c", 400, 0, 50, 50)]);
  drag(easel, { x: 300, y: 300 }, { x: 240, y: 10 });
  assert.deepEqual([...easel.selection], ["b"]);
  drag(easel, { x: 500, y: 300 }, { x: 440, y: 10 }, { ...none, shift: true });
  assert.deepEqual([...easel.selection].sort(), ["b", "c"]);
});

test("the pen keeps its points, and stays ready for the next mark", () => {
  const { easel } = editor();
  easel.setTool("pen");
  easel.pointerDown({ x: 10, y: 10 }, click);
  easel.pointerMove({ x: 20, y: 30 }, none);
  easel.pointerMove({ x: 40, y: 20 }, none);
  easel.pointerUp();
  const [stroke] = easel.items;
  assert.equal(stroke.kind, "pen");
  assert.deepEqual(stroke.points, [
    [0, 0],
    [10, 20],
    [30, 10],
  ]);
  assert.equal(easel.selection.size, 0);
  assert.equal(easel.tool, "pen");
});

test("a tiny shape is dropped, and shift draws a square", () => {
  const { easel } = editor();
  easel.setTool("rect");
  drag(easel, { x: 10, y: 10 }, { x: 11, y: 11 });
  assert.equal(easel.items.length, 0);
  drag(easel, { x: 10, y: 10 }, { x: 110, y: 40 }, { ...none, shift: true });
  assert.deepEqual([easel.items[0].width, easel.items[0].height], [100, 100]);
});

test("dragging a corner scales a shape from the opposite corner, and its stroke points and text", () => {
  const { easel } = editor([
    {
      ...rect("a", 0, 0, 100, 100),
      kind: "pen",
      points: [
        [0, 0],
        [100, 100],
      ],
    },
  ]);
  easel.selectAll();
  drag(easel, { x: 100, y: 100 }, { x: 200, y: 50 });
  const [item] = easel.items;
  assert.deepEqual([item.x, item.y, item.width, item.height], [0, 0, 200, 50]);
  assert.deepEqual(item.points[1], [200, 50]);
});

test("alt-drag duplicates in one undo step", () => {
  const { easel } = editor([rect("a", 0, 0)]);
  drag(easel, { x: 10, y: 10 }, { x: 210, y: 10 }, { ...none, option: true });
  assert.equal(easel.items.length, 2);
  assert.equal(easel.items[1].x, 200);
  easel.undo();
  assert.equal(easel.items.length, 1);
});

test("zooming keeps the point under the pointer still", () => {
  const { easel } = editor();
  const anchor = { x: 200, y: 150 };
  const before = easel.world(anchor);
  easel.zoomBy(2, anchor);
  const after = easel.world(anchor);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(easel.zoom, 2);
});

test("keys pick tools, nudge the selection and delete it; Ctrl+Z undoes", () => {
  const { easel } = editor([rect("a", 0, 0)]);
  assert.equal(easel.keyDown({ ...none, key: "p" }), true);
  assert.equal(easel.tool, "pen");
  easel.keyDown({ ...none, key: "v" });
  easel.selectAll();
  easel.keyDown({ ...none, key: "ArrowRight", shift: true });
  assert.equal(easel.items[0].x, 10);
  easel.keyDown({ ...none, key: "Delete" });
  assert.equal(easel.items.length, 0);
  easel.keyDown({ ...none, key: "z", command: true });
  assert.equal(easel.items.length, 1);
  assert.equal(easel.keyDown({ ...none, key: "q" }), false);
});

test("Escape puts a drag back without an undo step", () => {
  const { easel } = editor([rect("a", 0, 0)]);
  easel.pointerDown({ x: 10, y: 10 }, click);
  easel.pointerMove({ x: 90, y: 10 }, none);
  easel.keyDown({ ...none, key: "Escape" });
  easel.pointerUp();
  assert.equal(easel.items[0].x, 0);
  assert.equal(easel.canUndo, false);
});

test("the text tool opens a field, and committing keeps the text", () => {
  const { easel, events } = editor();
  easel.setTool("text");
  easel.pointerDown({ x: 30, y: 30 }, click);
  assert.equal(events.opened.length, 1);
  events.text = "hello";
  easel.commitText();
  assert.equal(easel.items[0].text, "hello");
  assert.equal(events.text, null);
});

test("a link's URL only takes a web address", () => {
  const { easel, events } = editor([{ ...rect("a", 0, 0), kind: "link", url: "https://a.example/", text: "A" }]);
  easel.selectAll();
  easel.runMenu("editLink");
  events.text = "javascript:alert(1)";
  easel.commitText();
  assert.equal(easel.items[0].url, "https://a.example/");
});

test("Ctrl+click opens a link, and only a web one", () => {
  const { easel, events } = editor([{ ...rect("a", 0, 0), kind: "link", url: "https://a.example/" }]);
  easel.pointerDown({ x: 10, y: 10 }, { ...click, command: true });
  assert.deepEqual(events.links, ["https://a.example/"]);
});

test("copied items paste at the point with new ids; pasted text becomes a link or text", () => {
  const { easel } = editor([rect("a", 0, 0)]);
  easel.selectAll();
  const copied = easel.copySelection();
  assert.equal(easel.pasteItems(copied.items, { x: 300, y: 300 }), true);
  assert.equal(easel.items.length, 2);
  assert.notEqual(easel.items[1].id, "a");
  easel.pasteText("https://b.example/page");
  assert.equal(easel.items[2].kind, "link");
  easel.pasteText("plain words");
  assert.equal(easel.items[3].kind, "text");
  assert.equal(easel.pasteText("   "), false);
  assert.equal(easel.pasteItems("not json"), false);
});

test("images land at their size, at most 640 across, and offset from each other", () => {
  const { easel } = editor();
  easel.insertImages(
    [
      { path: "/m/a.png", width: 1280, height: 640 },
      { path: "/m/b.png", width: 100, height: 50 },
    ],
    { x: 0, y: 0 },
  );
  assert.deepEqual([easel.items[0].width, easel.items[0].height], [640, 320]);
  assert.deepEqual([easel.items[1].x, easel.items[1].width], [24, 100]);
  assert.equal(easel.selection.size, 2);
});

test("bring to front and send to back reorder the selection", () => {
  const { easel } = editor([rect("a", 0, 0), rect("b", 0, 0), rect("c", 0, 0)]);
  easel.selection = new Set(["a"]);
  easel.reorder(true);
  assert.deepEqual(
    easel.items.map((i) => i.id),
    ["b", "c", "a"],
  );
  easel.reorder(false);
  assert.deepEqual(
    easel.items.map((i) => i.id),
    ["a", "b", "c"],
  );
});

test("fit shows every item, and the viewport reports with the state", () => {
  const { easel, last } = editor([rect("a", 0, 0, 1000, 1000)]);
  easel.fit();
  assert.ok(easel.zoom < 1);
  assert.equal(last().zoom, easel.zoom);
  assert.deepEqual(last().viewport, { x: easel.viewport.x, y: easel.viewport.y, zoom: easel.zoom });
});

test("safeUrl only allows http(s) with a host, and bounds include strokes", () => {
  assert.equal(safeUrl("https://a.example"), "https://a.example/");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "nope"]) assert.equal(safeUrl(bad), null);
  assert.deepEqual(contentBounds([{ ...rect("a", 10, 10, 20, 20), lineWidth: 4 }]), { x: 2, y: 2, width: 36, height: 36 });
  assert.equal(contentBounds([]), null);
});
