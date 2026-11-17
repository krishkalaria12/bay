// Importing from another browser: which browsers the sheet lists and how each one's data arrives (src/import/browsers.ts),
// what an export adds (src/import/apply.ts), and reading a chosen file (src/import/importer.ts), with the phone faked.
import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ImportFiles, ImportFilesError, type ExportListing, type PickedFile } from "../src/effect/ports/importFiles.ts";
import { bookmarkDrafts, draftLinkCount, exportNotes } from "../src/import/apply.ts";
import { androidBrowsers, androidMethod, IOS_BROWSERS, iosBrowsers } from "../src/import/browsers.ts";
import { chooseExport, NothingToImport, phoneBrowsers } from "../src/import/importer.ts";
import { BOOKMARK_LIMIT, BOOKMARKS_ROOT, draftNodes, emptyBookmarks } from "../src/store/bookmarks.ts";
import { createTab, initialBrowserData, reduceBrowserData } from "../src/store/model.ts";

const BOOKMARKS = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>
<DT><H3 id="com.apple.FavoritesBar">Favorites</H3><DL><DT><A HREF="https://a.example/">A</A></DL>
<DT><H3>Work</H3><DL><DT><A HREF="https://b.example/">B</A><DT><A HREF="https://a.example/">A again</A></DL>
</DL>`;

test("Chrome comes through Takeout, Arc Search by pasting tabs, every other browser by a bookmarks file", () => {
  assert.equal(androidMethod("com.android.chrome"), "takeout");
  assert.equal(androidMethod("com.chrome.beta"), "takeout");
  assert.equal(androidMethod("company.thebrowser.arc"), "paste");
  assert.equal(androidMethod("com.brave.browser"), "bookmarksFile");
  assert.equal(androidMethod("com.opera.browser"), "bookmarksFile");
  assert.deepEqual(androidBrowsers([{ id: "com.android.chrome", name: "Chrome", icon: "" }]), [
    { id: "com.android.chrome", name: "Chrome", method: "takeout", icon: null },
  ]);
});

test("iOS lists Safari first, then the browsers that answered their URL scheme", () => {
  const answered = IOS_BROWSERS.map((browser) => browser.id === "chrome" || browser.id === "brave");

  assert.deepEqual(
    iosBrowsers(answered).map((browser) => [browser.id, browser.method]),
    [
      ["safari", "safari"],
      ["chrome", "takeout"],
      ["brave", "bookmarksFile"],
    ],
  );
});

test("what an archive left behind says whether passwords or cards stayed in it", () => {
  assert.deepEqual(exportNotes({ skipped: ["Passwords.csv", "Extensions.json"], tooLarge: [] }), { passwords: true, cards: false, tooLarge: [] });
  assert.deepEqual(exportNotes({ skipped: ["PaymentCards.json"], tooLarge: ["History.json"] }), { passwords: false, cards: true, tooLarge: ["History.json"] });
});

test("drafts leave out pages bookmarked already or named twice, and folders left empty by that", () => {
  const existing = reduceBrowserData(initialBrowserData(createTab("t", 0)), {
    type: "add-bookmarks",
    spaceId: "personal",
    nodes: draftNodes([{ title: "B", url: "https://b.example/" }], BOOKMARKS_ROOT, () => "b", 0, BOOKMARK_LIMIT),
  }).bookmarks.personal!;

  const root = {
    title: "",
    children: [
      { title: "Favorites", role: "favorites" as const, children: [{ title: "A", url: "https://a.example/", addedAt: 7 }] },
      {
        title: "Work",
        children: [
          { title: "B", url: "https://b.example/" },
          { title: "A again", url: "https://a.example/" },
        ],
      },
    ],
  };

  const drafts = bookmarkDrafts(root, existing);

  assert.deepEqual(drafts, [{ title: "Favorites", children: [{ title: "A", url: "https://a.example/", addedAt: 7 }] }]);
  assert.equal(draftLinkCount(drafts), 1);
  assert.equal(draftLinkCount(bookmarkDrafts(root, emptyBookmarks())), 2);
});

/** The phone, faked: a picker that hands over one file, and an archive that unpacks into the files given. */
const fakePhone = (options: { picked: PickedFile | null; listing?: ExportListing; texts?: Record<string, string>; failRead?: boolean }) => {
  const discarded: (PickedFile | null)[] = [];

  return {
    discarded,
    layer: Layer.succeed(ImportFiles)({
      pick: () => Effect.succeed(options.picked),
      unpack: () => Effect.succeed(options.listing ?? { files: [], skipped: [], tooLarge: [] }),
      readText: (path) =>
        options.failRead
          ? Effect.fail(new ImportFilesError({ operation: { name: "import.read", resource: path }, cause: "gone" }))
          : Effect.succeed(options.texts?.[path] ?? ""),
      discard: (picked) => Effect.sync(() => void discarded.push(picked)),
      androidBrowsers: () => Effect.succeed([{ id: "com.android.chrome", name: "Chrome", icon: "data:image/png;base64,AA" }]),
      canOpen: (url) => Effect.succeed(url === "firefox://"),
    }),
  };
};

const picked = { path: "/cache/Safari Export.zip", name: "Safari Export.zip" };

test("a chosen export is unpacked, read, reviewed, and its unpacked files deleted", async () => {
  const phone = fakePhone({
    picked,
    listing: { files: [{ name: "Bookmarks.html", path: "/x/0-Bookmarks.html" }], skipped: ["Passwords.csv"], tooLarge: [] },
    texts: { "/x/0-Bookmarks.html": BOOKMARKS },
  });

  const chosen = await Effect.runPromise(chooseExport.pipe(Effect.provide(phone.layer)));

  assert.equal(chosen?.name, "Safari Export.zip");
  assert.deepEqual(
    chosen?.contents.favorites.map((favorite) => favorite.url),
    ["https://a.example/"],
  );
  assert.equal(chosen?.notes.passwords, true);
  assert.deepEqual(phone.discarded, [picked]);
});

test("a dismissed picker reads nothing", async () => {
  const phone = fakePhone({ picked: null });

  assert.equal(await Effect.runPromise(chooseExport.pipe(Effect.provide(phone.layer))), null);
  assert.deepEqual(phone.discarded, []);
});

test("a file with nothing Bay reads says so, and what was unpacked is still deleted", async () => {
  const phone = fakePhone({
    picked,
    listing: { files: [{ name: "notes.html", path: "/x/notes.html" }], skipped: [], tooLarge: ["History.json"] },
    texts: { "/x/notes.html": "<p>hi</p>" },
  });

  // An answer, not a failure: the user chose the wrong file, and nothing is reported.
  const nothing = await Effect.runPromise(chooseExport.pipe(Effect.provide(phone.layer)));

  assert.ok(nothing instanceof NothingToImport);
  assert.equal(nothing.tooLarge, true);
  assert.deepEqual(phone.discarded, [picked]);
});

test("a read that fails part way still deletes what was unpacked", async () => {
  const phone = fakePhone({ picked, listing: { files: [{ name: "Bookmarks.html", path: "/x/b.html" }], skipped: [], tooLarge: [] }, failRead: true });
  const error = await Effect.runPromise(Effect.flip(chooseExport).pipe(Effect.provide(phone.layer)));

  assert.ok(error instanceof ImportFilesError);
  assert.deepEqual(phone.discarded, [picked]);
});

test("the phone's browsers: Android's from the system, iOS's by URL scheme", async () => {
  const phone = fakePhone({ picked: null });
  const android = await Effect.runPromise(phoneBrowsers("android").pipe(Effect.provide(phone.layer)));
  const ios = await Effect.runPromise(phoneBrowsers("ios").pipe(Effect.provide(phone.layer)));

  assert.deepEqual(
    android.map((browser) => [browser.name, browser.method, Boolean(browser.icon)]),
    [["Chrome", "takeout", true]],
  );
  assert.deepEqual(
    ios.map((browser) => browser.id),
    ["safari", "firefox"],
  );
});
