import assert from "node:assert/strict";
import { test } from "node:test";
const { hideDragCard, showDragCard } = await import("./webDragCard.ts");

const node = () => ({
  style: {},
  children: [],
  append(...children) {
    this.children.push(...children);
  },
  remove() {
    this.removed = true;
  },
});
const page = () => ({ createElement: node, body: node() });

test("the card follows the pointer, shows the tab, and reuses one element", () => {
  const document = page();
  showDragCard([300, 200], "Docs", "data:image/png;base64,AA", document);
  const card = document.body.children[0];
  assert.deepEqual([card.style.left, card.style.top], ["195.5px", "145px"]);
  assert.equal(card.style.pointerEvents, "none");
  const [icon, title] = card.children;
  assert.equal(title.textContent, "Docs");
  assert.equal(icon.src, "data:image/png;base64,AA");
  showDragCard([310, 210], "Docs", "data:image/png;base64,AA", document);
  assert.equal(document.body.children.length, 1);
  assert.equal(card.style.left, "205.5px");
  hideDragCard();
  assert.equal(card.removed, true);
});

test("a tab with no icon shows its title alone", () => {
  const document = page();
  showDragCard([0, 0], "New Tab", null, document);
  assert.equal(document.body.children[0].children[0].style.display, "none");
  hideDragCard();
  hideDragCard();
});
