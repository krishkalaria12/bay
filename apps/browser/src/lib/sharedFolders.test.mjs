import assert from "node:assert/strict";
import { test } from "node:test";
import { fileNameFor, linkText, parseLink, planChanges, planSync } from "./sharedFolders.ts";

const A = { url: "https://a.example/", title: "A" };

test("each kind of link file reads back what it writes", () => {
  for (const format of ["webloc", "url", "desktop"]) {
    const link = { url: "https://a.example/?q=1&r=<2>", title: "A & B" };

    assert.deepEqual(parseLink(`A & B.${format}`, linkText(link, format)), link, format);
  }
});

test("links from other apps, and files that aren't web links", () => {
  assert.deepEqual(parseLink("Docs.url", "[InternetShortcut]\r\nIDList=\r\nURL=https://docs.example/\r\nIconIndex=0"), {
    url: "https://docs.example/",
    title: "Docs",
  });
  assert.deepEqual(parseLink("x.desktop", "[Desktop Entry]\nType=Link\nName=Wiki\nURL=https://wiki.example/"), { url: "https://wiki.example/", title: "Wiki" });
  assert.equal(parseLink("app.desktop", "[Desktop Entry]\nType=Application\nExec=rm -rf ~"), null);
  assert.equal(parseLink("js.url", "[InternetShortcut]\nURL=javascript:alert(1)"), null);
  assert.equal(parseLink("bin.webloc", "bplist00\u0000\u0001"), null);
  assert.equal(parseLink("notes.txt", "https://a.example/"), null);
});

test("file names are safe everywhere and never clash", () => {
  assert.equal(fileNameFor('a/b:c*?"<>|', "url", new Set()), "a b c.url");
  assert.equal(fileNameFor("A", "webloc", new Set(["a.webloc"])), "A 2.webloc");
  assert.equal(fileNameFor("...", "desktop", new Set()), "Link.desktop");
});

test("a change on one side goes to the other", () => {
  const known = { "A.webloc": { ...A, tabId: "t1" }, "B.webloc": { url: "https://b.example/", title: "B", tabId: "t2" } };

  const files = [
    { name: "A.webloc", ...A },
    { name: "C.webloc", url: "https://c.example/", title: "C" },
  ];

  const tabs = [
    { id: "t1", ...A },
    { id: "t2", url: "https://b.example/", title: "B" },
    { id: "t3", url: "https://d.example/", title: "D" },
  ];

  const plan = planSync(known, files, tabs, "webloc");

  // B left the directory: its tab goes. C arrived: a tab for it. D is new here: a file for it.
  assert.deepEqual(plan.removeTabs, ["t2"]);
  assert.deepEqual(plan.addTabs, [{ name: "C.webloc", url: "https://c.example/", title: "C" }]);
  assert.deepEqual(plan.writeFiles, [{ name: "D.webloc", url: "https://d.example/", title: "D", tabId: "t3" }]);
  assert.deepEqual(Object.keys(plan.known).sort(), ["A.webloc", "D.webloc"]);
});

test("a tab removed here removes its file, unless someone changed the file since", () => {
  const known = { "A.url": { ...A, tabId: "t1" } };

  assert.deepEqual(planSync(known, [{ name: "A.url", ...A }], [], "url").removeFiles, ["A.url"]);
  assert.deepEqual(planSync(known, [{ name: "A.url", url: "https://a2.example/", title: "A" }], [], "url").addTabs.length, 1);
});

test("an address changed in the directory updates the tab; a renamed tab renames its file", () => {
  const known = { "A.url": { ...A, tabId: "t1" } };
  const moved = planSync(known, [{ name: "A.url", url: "https://a2.example/", title: "A" }], [{ id: "t1", ...A }], "url");

  assert.deepEqual(moved.updateTabs, [{ tabId: "t1", url: "https://a2.example/", title: "A" }]);
  const renamed = planSync(known, [{ name: "A.url", ...A }], [{ id: "t1", url: A.url, title: "Alpha" }], "url");

  assert.deepEqual(renamed.removeFiles, ["A.url"]);
  assert.deepEqual(renamed.writeFiles, [{ name: "Alpha.url", url: A.url, title: "Alpha", tabId: "t1" }]);
  assert.equal(planChanges(planSync({ "A.url": { ...A, tabId: "t1" } }, [{ name: "A.url", ...A }], [{ id: "t1", ...A }], "url")), false);
});
