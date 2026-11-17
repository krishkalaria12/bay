// Drives the Expo app's import code (src/import and src/browser/importTabs.ts) through files its own tests don't reach,
// so `record-fixtures.mjs import` records them too: odd bookmark files, history rows Bay must skip, merges and the
// browser lists. Each call only has to run; the Rust port is checked against what it returned.
import test from "node:test";

import { bookmarkDrafts, draftLinkCount, exportNotes } from "../../../apps/mobile/src/import/apply.ts";
import { androidBrowsers, androidMethod, iosBrowsers } from "../../../apps/mobile/src/import/browsers.ts";
import {
  bookmarkLinks,
  decodeEntities,
  isBookmarksHTML,
  linkCount,
  parseBookmarksHTML,
  parseHistoryJSON,
  readExport,
  webAddress,
} from "../../../apps/mobile/src/import/exports.ts";
import { importedTabs } from "../../../apps/mobile/src/browser/importTabs.ts";
import type { Bookmarks } from "../../../apps/mobile/src/store/types.ts";

const DOCTYPE =
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n';

const BOOKMARK_FILES = [
  // Chrome's export: the bar, other bookmarks, nesting.
  `${DOCTYPE}<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000100" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000001">GitHub</A>
        <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1700000002">Hacker News</A>
        <DT><H3 ADD_DATE="1700000003">Reading</H3>
        <DL><p>
            <DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="1700000004">Article &amp; more</A>
            <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
        </DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000005">GitHub again</A>
    </DL><p>
    <DT><H3 UNFILED_BOOKMARKS_FOLDER="TRUE">Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://other.example/">Other</A>
    </DL><p>
</DL><p>`,
  // Safari's: Favorites and the Reading List by id.
  `${DOCTYPE}<DL><p>
<DT><H3 id="com.apple.FavoritesBar">Favourites</H3>
<DL><p>
<DT><A HREF="https://www.apple.com/">Apple</A>
<DT><A HREF="https://www.apple.com/">Apple twice</A>
<DT><A HREF="https://bay.example/">Bay</A>
</DL><p>
<DT><H3 id="com.apple.ReadingList">Reading List</H3>
<DL><p>
<DT><A HREF="https://read.example/later">Later</A>
</DL><p>
<DT><A HREF="https://loose.example/">Loose</A>
</DL><p>`,
  // Firefox's lower case, quotes of both kinds and unquoted values.
  `<!doctype netscape-bookmark-file-1>
<dl><p>
<dt><h3 add_date='1600000000' personal_toolbar_folder=true>Toolbar</h3>
<dl><p>
<dt><a href=https://firefox.example/ add_date=1600000001>Firefox</a>
<dt><a href='https://single.example/' ADD_DATE=' 12 '>Single</a>
<dt><a href="place:sort=8">Recent tags</a>
</dl><p>
<dt><h3>Empty</h3>
<dl><p></dl><p>
<dt><h3>Only bad links</h3>
<dl><p><dt><a href="file:///etc/hosts">Hosts</a><dt><a href="ftp://ftp.example/">FTP</a></dl>
</dl>`,
  // Titles: markup, entities, white space, none.
  `${DOCTYPE}<DL>
<DT><A HREF="https://a.example/"><b>Bold</b> &lt;title&gt; &#169; &#x1F600; &#X41; &#0; &#99999999; &bogus; &NBSP;x</A>
<DT><A HREF="https://b.example/">
   spread
   over   lines  </A>
<DT><A HREF="https://c.example/"></A>
<DT><A HREF="https://d.example/">　wide space\u0085nel</A>
<DT><A HREF="https://e.example/">emoji 🌊 and ü</A>
<DT><A HREF=" https://f.example/path with space ">padded</A>
<DT><A HREF="HTTPS://UPPER.EXAMPLE/Path">Upper</A>
<DT><A HREF="https://user:pw@creds.example/">Credentials</A>
<DT><A HREF="https://bücher.example/">IDN</A>
<DT><A>No address</A>
<DT><ABBR title="x">not a link</ABBR>
<DT><A HREF="https://g.example/" HREF="https://h.example/">Two hrefs</A>
</DL>`,
  // Dates Number() reads its own way.
  `${DOCTYPE}<DL>
<DT><A HREF="https://d1.example/" ADD_DATE="">empty</A>
<DT><A HREF="https://d2.example/" ADD_DATE="0">zero</A>
<DT><A HREF="https://d3.example/" ADD_DATE="abc">letters</A>
<DT><A HREF="https://d4.example/" ADD_DATE="1.5">fraction</A>
<DT><A HREF="https://d5.example/" ADD_DATE="0x10">hex</A>
<DT><A HREF="https://d6.example/" ADD_DATE="1e3">exponent</A>
<DT><A HREF="https://d7.example/" ADD_DATE="0.0001">tiny</A>
<DT><A HREF="https://d8.example/" ADD_DATE="-5">negative</A>
<DT><A HREF="https://d9.example/" ADD_DATE="+7">plus</A>
<DT><A HREF="https://d10.example/" ADD_DATE="Infinity">infinite</A>
<DT><A HREF="https://d11.example/" ADD_DATE="12abc">trailing</A>
<DT><A HREF="https://d12.example/" ADD_DATE=".5">leading dot</A>
<DT><A HREF="https://d13.example/" ADD_DATE="0b101">binary</A>
</DL>`,
  // Broken structure: unclosed lists and tags, stray closers, a heading with no list.
  `${DOCTYPE}<DL>
<DT><H3>Never closed
<DT><A HREF="https://open.example/">Open link
<DT><H3>Folder</H3>
<DL>
<DT><A HREF="https://inside.example/">Inside</A>
<DT><H3>Deeper</H3>
<DL>
<DT><A HREF="https://deep.example/">Deep</A>
</DL>
</DL>
</DL>
</DL>
<DT><A HREF="https://after.example/">After the end</A>
<DT><H3>Last heading</H3>`,
  `${DOCTYPE}<DL><DT><H3>Unclosed list</H3><DL><DT><A HREF="https://unclosed.example/">In it</A>`,
  `${DOCTYPE}<dl><dt><h3>Tail</h3><dl><dt><a href="https://tail.example/">Tail link`,
  `${DOCTYPE}`,
  "<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF='https://x.example/'>x</A></DL>",
  "not a bookmarks file at all <a href='https://x.example/'>x</a>",
];

const HISTORY_FILES = [
  JSON.stringify({
    history: [
      { url: "https://a.example/", title: "A", time_usec: 1_700_000_000_000_000, visit_count: 3 },
      { url: "https://a.example/", title: "A newer", time_usec: 1_700_000_100_000_000, visit_count: 2 },
      { url: "https://b.example/", title: "  B  ", time_usec: "1700000050000000", visit_count: 2.7 },
      { url: "https://c.example/", title: "", time_usec: 1_700_000_020_000_000, visit_count: 0 },
      { url: "https://d.example/", time_usec: 1_700_000_030_000_000, visit_count: -4 },
      { url: "https://e.example/", title: "Redirect", time_usec: 1_700_000_040_000_000, destination_url: "https://f.example/" },
      { url: "https://g.example/", title: "No time" },
      { url: "https://h.example/", title: "Bad time", time_usec: "soon" },
      { url: "https://i.example/", title: "Tiny time", time_usec: 999 },
      { url: "https://j.example/", title: null, time_usec: 1_700_000_060_000_000 },
      { url: 42, title: "Number url", time_usec: 1_700_000_070_000_000 },
      { url: "javascript:void(0)", title: "Script", time_usec: 1_700_000_080_000_000 },
      { url: "https://k.example/", title: "Half visit", time_usec: 1_700_000_090_000_000, visit_count: 0.5 },
      { url: "https://l.example/", title: "Null redirect", time_usec: 1_700_000_090_000_000, destination_url: null },
      { url: "https://m.example/", title: "Tie one", time_usec: 1_700_000_090_000_000 },
      null,
      [1, 2],
      "row",
    ],
  }),
  JSON.stringify({
    "Browser History": [
      { url: "https://t.example/", title: "First visit", time_usec: 1_600_000_000_000_000, page_transition: "LINK" },
      { url: "https://t.example/", title: "", time_usec: 1_600_000_500_000_000 },
      { url: "https://t.example/", title: "Older title", time_usec: 1_500_000_000_000_000 },
      { url: "https://u.example/", title: "U", time_usec: "1600000100000000" },
      { url: "https://v.example/", title: "V", time_usec: 1_600_000_100_000_000, visit_count: 9 },
      { url: "https://user:pw@w.example/", title: "Creds", time_usec: 1_600_000_200_000_000 },
      { title: "No url", time_usec: 1_600_000_300_000_000 },
    ],
  }),
  JSON.stringify({ history: [], "Browser History": [{ url: "https://both.example/", time_usec: 1 }] }),
  JSON.stringify({ history: "nope", "Browser History": [{ url: "https://fallback.example/", time_usec: 1_600_000_000_000_000 }] }),
  JSON.stringify({ other: [] }),
  JSON.stringify([{ url: "https://array.example/" }]),
  "null",
  "{ not json",
  '  \n {"history": []}',
  '﻿{"history": []}',
];

const EXISTING: Bookmarks = {
  bookmarks: { kind: "folder", id: "bookmarks", parentId: null, title: "", children: ["have", "folder"], addedAt: 0 },
  have: { kind: "url", id: "have", parentId: "bookmarks", title: "GitHub", url: "https://github.com/", addedAt: 1 },
  folder: { kind: "folder", id: "folder", parentId: "bookmarks", title: "Saved", children: ["deep"], addedAt: 2 },
  deep: { kind: "url", id: "deep", parentId: "folder", title: "Other", url: "https://other.example/", addedAt: 3 },
};

const TAB_TEXTS = [
  "Arc Search tabs\n1. The quiet bay - https://example.com/bay\nHacker News (https://news.ycombinator.com/)\nhttps://notitle.example/",
  "- [Markdown title](https://md.example/page).\n* Star: https://star.example/x?y=1,\n• Bullet — https://bullet.example/\n2) Paren | https://paren.example/)\n",
  "Two on a line https://one.example/ and https://two.example/!\r\nWindows line https://crlf.example/\r\n",
  "Dupes https://dup.example/ https://dup.example/ HTTPS://DUP.EXAMPLE/",
  "Not links: ftp://x.example/ mailto:a@b.example https://user:pw@creds.example/ https:// http://[bad",
  `Quoted "https://quoted.example/a" and <https://angle.example/> and \`https://tick.example/\``,
  `${"Long title ".repeat(40)}https://long.example/`,
  "Emoji 🌊 title: https://emoji.example/ü?q=ä",
  "[[Nested]] https://nested.example/",
  "　Wide space　https://wide.example/",
  "",
];

test("import scenarios run", () => {
  for (const html of BOOKMARK_FILES) {
    isBookmarksHTML(html);
    const tree = parseBookmarksHTML(html);

    linkCount(tree);
    bookmarkLinks(tree);
    bookmarkDrafts(tree, EXISTING);
    draftLinkCount(bookmarkDrafts(tree, EXISTING));
  }

  for (const json of HISTORY_FILES) parseHistoryJSON(json);

  for (const text of ["", "plain", "&amp;&lt;&gt;&quot;&apos;&nbsp;", "&#38;amp; &#x26; &AMP; &unknown; &#; &#x; & alone", "a&b"]) {
    decodeEntities(text);
  }

  for (const value of [
    "https://example.com",
    " https://example.com/a b ",
    "http://localhost:8080/x",
    "HTTPS://Example.COM/",
    "https://user@example.com/",
    "ftp://example.com/",
    "example.com",
    "",
    "https://xn--bcher-kva.example/",
    "https://bücher.example/",
  ]) {
    webAddress(value);
  }

  const files = [
    { name: "Bookmarks.html", text: BOOKMARK_FILES[0]! },
    { name: "Safari/Bookmarks.html", text: BOOKMARK_FILES[1]! },
    { name: "History.json", text: HISTORY_FILES[0]! },
    { name: "Takeout/History.json", text: HISTORY_FILES[1]! },
    { name: "notes.txt", text: "nothing" },
  ];

  readExport(files);
  readExport(files.slice(2));
  readExport([files[1]!, files[0]!]);
  readExport([
    { name: "History.json", text: HISTORY_FILES[0]! },
    { name: "again.json", text: HISTORY_FILES[0]! },
  ]);

  try {
    readExport([{ name: "notes.txt", text: "nothing" }]);
  } catch {
    // Recorded as the error it is.
  }

  try {
    readExport([]);
  } catch {
    // Recorded as the error it is.
  }

  exportNotes({ skipped: ["Passwords.csv", "Payment Cards.json"], tooLarge: ["History.json"] });
  exportNotes({ skipped: ["PASSWORD.txt"], tooLarge: [] });
  exportNotes({ skipped: ["export.CSV", "Autofill.json"], tooLarge: [] });
  exportNotes({ skipped: [], tooLarge: [] });

  for (const id of [
    "com.android.chrome",
    "com.chrome.beta",
    "com.chrome.canary",
    "com.chrome.stable",
    "company.thebrowser.arc",
    "org.mozilla.firefox",
    "com.brave.browser",
  ]) {
    androidMethod(id);
  }

  androidBrowsers([
    { id: "com.android.chrome", name: "Chrome", icon: "data:image/png;base64,AAAA" },
    { id: "company.thebrowser.arc", name: "Arc Search", icon: "" },
    { id: "org.mozilla.firefox", name: "Firefox", icon: "data:image/png;base64,BBBB" },
  ]);
  androidBrowsers([]);

  for (const answered of [[], [true], [false, true, false, true, true], [true, true, true, true, true], [true, true, true, true, true, true]])
    iosBrowsers(answered);

  for (const text of TAB_TEXTS) importedTabs(text);
});
