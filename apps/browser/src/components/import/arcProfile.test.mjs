import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

// Metro provides require to the optional native import loader.
globalThis.require = createRequire(import.meta.url);

const tokens = new Set();
const writes = [];
globalThis.nnTestNativeModules = {
  BayImport: {
    writeImported: async (token, profile, kinds) => {
      assert.ok(tokens.delete(token), "each native token is consumed once");
      writes.push({ token, profile, kinds });
      return JSON.stringify({ cookies: 1, addresses: 1, cards: 0 });
    },
    discardImported: (token) => tokens.delete(token),
  },
};
const { useBrowser } = await import("../../store/browser.ts");
const { engineProfile, favoriteTabIds } = await import("../../store/model.ts");
const { applyArcProfile } = await import("./apply.ts");
const S = () => useBrowser.getState();
const source = () => ({
  browserId: "arc",
  profileId: "Default",
  history: [{ url: "https://shared.example", title: "Shared", visits: 1, lastVisit: 100 }],
  bookmarks: { type: "folder", title: "Root", children: [{ type: "url", title: "Saved", url: "https://saved.example" }] },
  tabs: [],
  favorites: [{ url: "https://favorite.example", title: "Favorite", pinned: true, windowIndex: 0, active: false }],
  spaces: [{ id: "one" }, { id: "two" }],
  credentials: [],
  failed: [],
  warnings: [],
  vaultToken: "first",
  cookieCount: 1,
  addressCount: 1,
  cardCount: 0,
});
const destinations = () => {
  S().hydrate({});
  const first = S().settings.defaultSpaceId;
  const second = S().createSpace({ name: "Work" });
  S().createWindow({ spaceId: first });
  return [first, second].map((spaceId, i) => ({
    spaceId,
    space: {
      id: String(i),
      name: String(i),
      profileId: "Default",
      pinned: [],
      tabs: [{ url: `https://space-${i}.example`, title: String(i), pinned: false, windowIndex: 0, active: false }],
    },
  }));
};

test("Arc spaces receive independent profile data and fresh native tokens, retaining only their own tabs", async () => {
  writes.length = 0;
  tokens.clear();
  tokens.add("first");
  const dest = destinations();
  let reads = 0;
  const total = await applyArcProfile(dest, source(), "Arc", async () => {
    reads++;
    tokens.add("second");
    return { vaultToken: "second", failed: [] };
  });
  assert.equal(reads, 1);
  assert.deepEqual(
    writes.map((w) => w.token),
    ["first", "second"],
  );
  assert.deepEqual(
    writes.map((w) => w.profile),
    dest.map((d) => engineProfile(d.spaceId)),
  );
  assert.notEqual(writes[0].profile, writes[1].profile);
  assert.equal(total.cookies, 2);
  assert.equal(total.addresses, 2);
  assert.equal(total.history, 2);
  assert.equal(total.bookmarks, 2);
  assert.equal(total.tabs, 4);
  const [a, b] = dest.map((d) => d.spaceId);
  assert.notEqual(S().history[a], S().history[b]);
  assert.notDeepEqual(S().bookmarks.roots[a], S().bookmarks.roots[b]);
  assert.deepEqual(
    Object.values(S().tabs)
      .filter((t) => t.spaceId === b)
      .map((t) => t.url)
      .sort(),
    ["https://favorite.example", "https://space-1.example"],
  );
  const w = S().windowOrder[0];
  assert.notEqual(favoriteTabIds(S(), w, a)[0], favoriteTabIds(S(), w, b)[0]);
  S().removeHistory(a, ["https://shared.example"]);
  assert.equal(S().history[b].length, 1, "later changes stay in their own profile");
});

test("a later native read failure is reported while its Arc space still receives reusable data", async () => {
  tokens.clear();
  tokens.add("first");
  const failed = [];
  const dest = destinations();
  await applyArcProfile(
    dest,
    source(),
    "Arc",
    async () => {
      throw new Error("unreadable");
    },
    (kind) => failed.push(kind),
  );
  assert.deepEqual(failed, ["cookies", "autofill"]);
  assert.equal(S().history[dest[1].spaceId].length, 1);
});
