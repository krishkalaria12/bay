// Drives the Expo app's browser helpers (incoming links, page errors, saved logins, downloads, favicons) through cases
// their own tests don't reach, so `record-fixtures.mjs browser` records them too. Each call only has to run; the Rust
// port is checked against what it returned.
import test from "node:test";

import { opensWhenFinished, downloadsFrom } from "../../../apps/mobile/src/browser/downloads.ts";
import { iconWidth, isImage, knownSitesWithoutIcons } from "../../../apps/mobile/src/browser/favicons.ts";
import { bayCommand, incomingLink, shareLink } from "../../../apps/mobile/src/browser/incomingLink.ts";
import { formatSavedLogins, originOf, parseSavedLogins } from "../../../apps/mobile/src/browser/logins.ts";
import { describePageError, pageErrorId } from "../../../apps/mobile/src/browser/pageErrors.ts";
import { createTab, initialBrowserData } from "../../../apps/mobile/src/store/model.ts";
import type { BrowserData } from "../../../apps/mobile/src/store/types.ts";

const LINKS = [
  "https://example.com",
  "  HTTPS://Example.COM/a b?c=d#e  ",
  "http://localhost:3000/",
  "https://user:pw@example.com/",
  "mailto:me@example.com",
  "exp+bay://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081",
  "bay://share?url=https%3A%2F%2Fshared.example%2Fpage",
  "bay://share?url=https://plain.example/?x=1&y=2",
  "bay://share?title=Hi&url=https%3A%2F%2Ftitled.example%2F",
  "bay://share?url=javascript%3Aalert(1)",
  "bay://share?url=bay%3A%2F%2Fshare%3Furl%3Dhttps%253A%252F%252Fnested.example%252F",
  "bay://share",
  "bay://SHARE?url=https%3A%2F%2Fupper.example%2F",
  "bay://share:80?url=https%3A%2F%2Fport.example%2F",
  "bay:share?url=https%3A%2F%2Fopaque.example%2F",
  "bay://share?url=+https%3A%2F%2Fplus.example%2F+",
  "ftp://files.example/",
  "https://bücher.example/",
  "not a url",
  "",
];

const COMMANDS = [
  "bay://new-tab",
  "bay://new-tab/",
  "bay://NEW-TAB",
  "bay://private-tab",
  "bay://search",
  "bay://voice",
  "  bay://voice  ",
  "bay://search?q=x",
  "bay://search?",
  "bay://search/x",
  "bay://search#frag",
  "bay://search:8080",
  "bay:search",
  "bay://other",
  "https://new-tab",
  "",
];

const ERRORS = [
  "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_NETWORK_CHANGED",
  "The Internet connection appears to be offline.",
  "The network connection was lost.",
  "net::ERR_NAME_NOT_RESOLVED",
  "A server with the specified hostname could not be found.",
  "net::ERR_TIMED_OUT",
  "The request timed out.",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_ADDRESS_UNREACHABLE",
  "Could not connect to the server.",
  "net::ERR_CERT_AUTHORITY_INVALID",
  "net::ERR_SSL_PROTOCOL_ERROR",
  "The certificate for this server is invalid.",
  "A secure connection cannot be made.",
  "net::ERR_BLOCKED_BY_CLIENT",
  "ſsl and K",
  "",
];

const LOGIN_DOCUMENTS = [
  null,
  "",
  "not json",
  "{}",
  "[]",
  JSON.stringify([
    { origin: " https://a.example ", username: "me", password: "one", savedAt: 1_700_000_000_000 },
    { origin: "https://b.example", username: "you", password: "two", savedAt: 1_700_000_000_001.5 },
    { origin: "https://a.example", username: "me", password: "newer", savedAt: 1_700_000_000_002 },
    { origin: "", username: "nobody", password: "x", savedAt: 1 },
    { origin: "https://c.example", username: "", password: "x", savedAt: 1 },
  ]),
  JSON.stringify([{ origin: "https://a.example", username: "me", password: "one", savedAt: "soon" }]),
  JSON.stringify([{ origin: "https://a.example", username: "me", password: "one" }]),
  JSON.stringify([null]),
  JSON.stringify([{ origin: "https://a.example", username: "me", password: 'p"w\n \u0001', savedAt: 0, extra: true }]),
];

const ORIGINS = [
  "https://example.com/path?q",
  "http://example.com:8080/",
  "https://example.com:443/",
  "HTTPS://EXAMPLE.COM",
  "https://bücher.example/",
  "https://user:pw@example.com/",
  "ftp://example.com/",
  "about:blank",
  "nonsense",
];

const FILES = ["pass.pkpass", "PASSES.PKPASSES", " invite.ics ", "invite.ics.txt", "photo.jpg", "ics", ".ICS", ""];

// File heads as JavaScript reads them: one character per byte.
const bytes = (...values: number[]) => String.fromCharCode(...values);

const HEADS = [
  bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 180, 0, 0, 0, 180),
  bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a),
  `GIF89a${bytes(64, 1, 32, 0)}`,
  "GIF8",
  bytes(0, 0, 1, 0, 2, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  bytes(0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0),
  bytes(0, 0, 1, 0, 9, 0, 48),
  bytes(0, 0, 1, 0),
  bytes(0xff, 0xd8, 0xff, 0xe0),
  `RIFF${bytes(0, 0, 0, 0)}WEBPVP8 `,
  `RIFF${bytes(0, 0, 0, 0)}WAVE`,
  "BM",
  "<html>",
  "",
];

function browserData(): BrowserData {
  const now = 1_700_000_000_000;
  const tab = (id: string, url: string, isPrivate = false, spaceId = "personal") => ({ ...createTab(id, now, url, isPrivate, spaceId), title: id });
  const base = initialBrowserData(tab("t1", "https://www.tabs.example/a"));

  const tree = (id: string, urls: string[]) => ({
    bookmarks: { kind: "folder" as const, id: "bookmarks", parentId: null, title: "", children: urls.map((_, index) => `${id}${index}`), addedAt: 0 },
    ...Object.fromEntries(
      urls.map((url, index) => [`${id}${index}`, { kind: "url" as const, id: `${id}${index}`, parentId: "bookmarks", title: url, url, addedAt: index }]),
    ),
  });

  // SAFETY: every field comes from initialBrowserData or is written here in the store's own shape.
  return {
    ...base,
    tabs: [tab("t1", "https://www.tabs.example/a"), tab("t2", "https://secret.example/", true), tab("t3", "about:blank"), tab("t4", "HTTP://Upper.example/")],
    spaces: [...base.spaces, { ...base.spaces[0]!, id: "work", name: "Work" }],
    pinnedSites: [{ id: "p1", url: "https://pinned.example/", title: "Pinned", spaceId: "personal", kind: "essential", folderId: null }],
    archive: [{ ...tab("a1", "https://archived.example/"), closedAt: now }],
    bookmarks: {
      personal: tree("b", ["https://marked.example/", "https://tabs.example/again", "javascript:void(0)"]),
      work: tree("w", ["https://work.example/"]),
    },
    history: [
      { spaceId: "personal", url: "https://old.example/", title: "Old", visits: 1, lastVisit: now - 5000 },
      { spaceId: "personal", url: "https://new.example/", title: "New", visits: 1, lastVisit: now - 10 },
      { spaceId: "work", url: "https://iconed.example/", title: "Has one", visits: 1, lastVisit: now - 20 },
      { spaceId: "work", url: "https://tie.example/", title: "Tie", visits: 1, lastVisit: now - 10 },
    ],
    favicons: { "iconed.example": "file:///icons/iconed", "pinned.example": "" },
    downloads: [
      { id: "d1", url: "https://www.files.example/a.pdf", filename: "a.pdf", state: "finished", received: 1, total: 1, startedAt: now, private: false },
      { id: "d2", url: "https://files.example/b.pdf", filename: "b.pdf", state: "finished", received: 1, total: 1, startedAt: now, private: true },
      { id: "d3", url: "https://FILES.example/c.ics", filename: "c.ics", state: "downloading", received: 1, total: 2, startedAt: now, private: false },
      { id: "d4", url: "https://other.example/d", filename: "d", state: "failed", received: 0, total: 0, startedAt: now, private: false },
    ],
  } as BrowserData;
}

test("browser helper scenarios run", () => {
  for (const link of LINKS) {
    incomingLink(link);
    shareLink(link);
    bayCommand(link);
  }

  incomingLink(null);
  bayCommand(null);

  for (const command of COMMANDS) bayCommand(command);

  for (const message of ERRORS) {
    describePageError(message);
    pageErrorId(message);
  }

  for (const document of LOGIN_DOCUMENTS) formatSavedLogins(parseSavedLogins(document));

  for (const origin of ORIGINS) originOf(origin);

  for (const file of FILES) opensWhenFinished(file);

  for (const head of HEADS) {
    isImage(head);
    iconWidth(head);
  }

  const data = browserData();

  knownSitesWithoutIcons(data);
  knownSitesWithoutIcons(data, 3);
  knownSitesWithoutIcons(data, 1);

  for (const page of ["https://files.example/x", "https://www.FILES.example/", "https://other.example/", "about:blank", "https://none.example/"]) {
    downloadsFrom(data.downloads, page);
  }
});
