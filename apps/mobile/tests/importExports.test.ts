import assert from "node:assert/strict";
import test from "node:test";

import {
  bookmarkLinks,
  decodeEntities,
  FAVORITES_LIMIT,
  isBookmarksHTML,
  linkCount,
  parseBookmarksHTML,
  parseHistoryJSON,
  readExport,
  UnknownExportError,
} from "../src/import/exports.ts";

// Safari's Bookmarks.html (from Settings → Apps → Safari → Export): Favorites, a folder, the Reading List.
const SAFARI = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<HTML>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<Title>Bookmarks</Title>
<H1>Bookmarks</H1>
<DT><H3 FOLDED id="com.apple.FavoritesBar">Favorites</H3>
<DL><p>
<DT><A HREF="https://www.apple.com/">Apple</A>
<DT><A HREF="https://news.ycombinator.com/">Hacker News</A>
</DL><p>
<DT><H3 FOLDED>Recipes &amp; food</H3>
<DL><p>
<DT><A HREF="https://cooking.example/soup?a=1&amp;b=2">Soup</A>
<DT><H3 FOLDED>Empty</H3>
<DL><p>
</DL><p>
</DL><p>
<DT><H3 FOLDED id="com.apple.ReadingList">Reading List</H3>
<DL><p>
<DT><A HREF="https://blog.example/post">A long read</A>
</DL><p>
<DT><A HREF="javascript:alert(1)">Bookmarklet</A>
</HTML>`;

// Chrome's (Takeout's Bookmarks.html): the bar is marked, "Other bookmarks" sits at the top level, uppercase tags.
const CHROME = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000100" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000001" ICON="data:image/png;base64,AAAA">GitHub</A>
        <DT><H3 ADD_DATE="1700000002">Work</H3>
        <DL><p>
            <DT><A HREF="https://linear.app/" ADD_DATE="1700000003">Linear</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://example.com/other">Other one</A>
    <DT><A HREF="https://user:pw@example.com/secret">Has credentials</A>
</DL><p>`;

test("reads Safari's bookmarks: folders, favorites and the reading list, without empty folders or bookmarklets", () => {
  const root = parseBookmarksHTML(SAFARI);
  const [favorites, recipes, reading] = root.children ?? [];

  assert.equal(root.children?.length, 3);
  assert.equal(favorites?.role, "favorites");
  assert.deepEqual(
    favorites?.children?.map((child) => child.title),
    ["Apple", "Hacker News"],
  );
  assert.equal(recipes?.title, "Recipes & food");
  assert.deepEqual(recipes?.children, [{ title: "Soup", url: "https://cooking.example/soup?a=1&b=2" }]);
  assert.equal(reading?.role, "readingList");
  assert.equal(linkCount(root), 4);
});

test("reads Chrome's bookmarks: the bar, nested folders, dates, and links at the top level", () => {
  const root = parseBookmarksHTML(CHROME);
  const bar = root.children?.[0];

  assert.equal(bar?.role, "toolbar");
  assert.equal(bar?.addedAt, 1_700_000_000_000);
  assert.deepEqual(
    bookmarkLinks(root).map((link) => link.url),
    ["https://github.com/", "https://linear.app/", "https://example.com/other"],
  );
  assert.equal(bar?.children?.[1]?.title, "Work");
  assert.equal(bar?.children?.[1]?.children?.[0]?.addedAt, 1_700_000_003_000);
});

test("a list with no heading keeps its links in the folder around it, and closing it doesn't close that folder", () => {
  const root = parseBookmarksHTML(`<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>
    <DT><H3>Outer</H3><DL>
      <DL><DT><A HREF="https://a.example/">A</A></DL>
      <DT><A HREF="https://b.example/">B</A>
    </DL>
    <DT><A HREF="https://c.example/">C</A>
  </DL>`);

  assert.deepEqual(
    root.children?.[0]?.children?.map((child) => child.title),
    ["A", "B"],
  );
  assert.equal(root.children?.[1]?.title, "C");
});

test("a link with no title is named by its address", () => {
  const root = parseBookmarksHTML('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://untitled.example/"></A></DL>');

  assert.equal(root.children?.[0]?.title, "https://untitled.example/");
});

test("tells a bookmarks file by its doctype", () => {
  assert.equal(isBookmarksHTML(SAFARI), true);
  assert.equal(isBookmarksHTML("<!doctype html><html></html>"), false);
});

test("decodes named and numeric entities", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry &#8212; &#x1F600; &quot;hi&quot; &bogus;"), 'Tom & Jerry — 😀 "hi" &bogus;');
});

test("reads Safari's History.json: visit counts kept, redirects and non-web pages left out, newest first", () => {
  const history = parseHistoryJSON(
    JSON.stringify({
      metadata: { browser_name: "Safari", data_type: "history", schema_version: 1 },
      history: [
        { url: "https://old.example/", title: "Old", time_usec: 1_600_000_000_000_000, visit_count: 4 },
        { url: "https://new.example/", title: "New", time_usec: 1_700_000_000_000_000, visit_count: 1 },
        { url: "http://redirect.example/", title: "", time_usec: 1_700_000_000_000_000, destination_url: "https://new.example/" },
        { url: "about:blank", title: "", time_usec: 1_700_000_000_000_000 },
      ],
    }),
  );

  assert.deepEqual(history, [
    { url: "https://new.example/", title: "New", visits: 1, lastVisit: 1_700_000_000_000 },
    { url: "https://old.example/", title: "Old", visits: 4, lastVisit: 1_600_000_000_000 },
  ]);
});

test("reads Takeout's History.json: one row per visit, counted per address, the newest title kept", () => {
  const history = parseHistoryJSON(
    JSON.stringify({
      "Browser History": [
        { url: "https://a.example/", title: "A (old)", time_usec: 1_600_000_000_000_000, page_transition: "LINK" },
        { url: "https://a.example/", title: "A", time_usec: 1_700_000_000_000_000, page_transition: "TYPED" },
        { url: "https://b.example/", title: "B", time_usec: "1650000000000000" },
        { url: "https://no-time.example/", title: "Never" },
        { title: "No address" },
      ],
    }),
  );

  assert.deepEqual(history, [
    { url: "https://a.example/", title: "A", visits: 2, lastVisit: 1_700_000_000_000 },
    { url: "https://b.example/", title: "B", visits: 1, lastVisit: 1_650_000_000_000 },
  ]);
});

test("history JSON in some other shape is not history", () => {
  assert.equal(parseHistoryJSON(JSON.stringify({ extensions: [] })), null);
  assert.equal(parseHistoryJSON("[1, 2]"), null);
  assert.equal(parseHistoryJSON("{ not json"), null);
});

test("an export's files merge: bookmarks from each HTML file, history from each JSON file, favorites from the bar", () => {
  const contents = readExport([
    { name: "Bookmarks.html", text: SAFARI },
    { name: "History.json", text: JSON.stringify({ history: [{ url: "https://a.example/", title: "A", time_usec: 2_000_000, visit_count: 2 }] }) },
    { name: "History - Work.json", text: JSON.stringify({ history: [{ url: "https://a.example/", title: "A2", time_usec: 1_000_000, visit_count: 3 }] }) },
    { name: "Extensions.json", text: JSON.stringify({ extensions: [{ display_name: "Something" }] }) },
    { name: "notes.html", text: "<html>not bookmarks</html>" },
  ]);

  assert.equal(linkCount(contents.bookmarks), 4);
  assert.deepEqual(
    contents.favorites.map((favorite) => favorite.url),
    ["https://www.apple.com/", "https://news.ycombinator.com/"],
  );
  assert.deepEqual(contents.history, [{ url: "https://a.example/", title: "A", visits: 5, lastVisit: 2000 }]);
});

test("favorites fall back to the bookmarks bar, and the start page takes only so many", () => {
  const links = Array.from({ length: FAVORITES_LIMIT + 3 }, (_, index) => `<DT><A HREF="https://site${index}.example/">Site ${index}</A>`).join("\n");

  const contents = readExport([
    { name: "Bookmarks.html", text: `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bar</H3><DL>${links}</DL></DL>` },
  ]);

  assert.equal(contents.favorites.length, FAVORITES_LIMIT);
  assert.equal(contents.favorites[0]?.url, "https://site0.example/");
});

test("an export with nothing Bay can read says so", () => {
  assert.throws(() => readExport([{ name: "readme.txt", text: "hello" }]), UnknownExportError);

  assert.throws(() => readExport([]), UnknownExportError);
});
