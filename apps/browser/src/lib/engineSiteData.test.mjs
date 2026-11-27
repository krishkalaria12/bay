import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieKey, planCarry, storageFrom, writeStorageScript } from "./engineSiteData.ts";

const cookie = (name, value, patch = {}) => ({ name, value, domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", ...patch });

test("a first carry copies the leaving engine's cookies and removes nothing", () => {
  const plan = planCarry([cookie("sid", "a"), cookie("pref", "1")], [cookie("theme", "dark")], new Set());
  assert.deepEqual(
    plan.set.map((c) => c.name),
    ["sid", "pref"],
  );
  assert.deepEqual(plan.remove, []);
  assert.deepEqual([...plan.known].sort(), [cookieKey(cookie("pref", "")), cookieKey(cookie("sid", ""))].sort());
});

test("the leaving engine's values win, and unchanged cookies aren't written again", () => {
  const plan = planCarry([cookie("sid", "new"), cookie("pref", "1")], [cookie("sid", "old"), cookie("pref", "1")], new Set());
  assert.deepEqual(
    plan.set.map((c) => `${c.name}=${c.value}`),
    ["sid=new"],
  );
});

test("a sign-out in one engine signs the other out on the next switch, but its own cookies stay", () => {
  const known = new Set([cookieKey(cookie("sid", "")), cookieKey(cookie("pref", ""))]);
  const plan = planCarry([cookie("pref", "1")], [cookie("sid", "a"), cookie("pref", "1"), cookie("theme", "dark")], known);
  assert.deepEqual(plan.remove, [{ name: "sid", domain: ".example.com", path: "/" }]);
  assert.deepEqual(plan.set, []);
});

test("cookie identity is its name, domain (any case) and path", () => {
  assert.equal(cookieKey(cookie("a", "1", { domain: ".Example.com" })), cookieKey(cookie("a", "2")));
  assert.notEqual(cookieKey(cookie("a", "1", { path: "/x" })), cookieKey(cookie("a", "1")));
});

test("storage carries as entries, and the write leaves the page's other keys alone", () => {
  assert.deepEqual(storageFrom('{"local":[["a","1"],["b","2"]],"session":[["tab","3"]]}'), {
    local: [
      ["a", "1"],
      ["b", "2"],
    ],
    session: [["tab", "3"]],
  });
  assert.equal(storageFrom('[["a","1"]]'), null);
  assert.equal(storageFrom('{"a":1}'), null);
  assert.equal(storageFrom("not json"), null);
  assert.equal(storageFrom(null), null);
  const store = new Map([["keep", "x"]]);
  const session = new Map();
  const area = (map) => ({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) });
  globalThis.localStorage = area(store);
  globalThis.sessionStorage = area(session);

  try {
    new Function(writeStorageScript({ local: [["a", "1"]], session: [["tab", "3"]] }))();
    assert.deepEqual(
      [...store],
      [
        ["keep", "x"],
        ["a", "1"],
      ],
    );
    assert.deepEqual([...session], [["tab", "3"]]);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
});

test("the ledger outlives the app, so a sign-out still carries after a relaunch", async () => {
  const { cookieCarry, docs } = await import("@bay/desktop");
  const cookie = (name) => ({ name, value: "1", domain: ".a.example", path: "/", secure: true, httpOnly: false, sameSite: "lax" });

  cookieCarry.can = true;
  cookieCarry.cookies = { chromium: [cookie("session"), cookie("prefs")], webkit: [] };
  const first = await import("./engineSiteData.ts?run=1");
  assert.equal(await first.carrySignIns("chromium", "webkit", "", "a.example", "https://a.example"), true);
  assert.ok(docs.get("engine-sign-ins.json").includes("session|.a.example|/"));
  assert.ok(!docs.get("engine-sign-ins.json").includes('"1"'), "no cookie values are kept");

  // Signed out in Chromium, then Bay restarts: WebKit's copy of the session goes on the next switch.
  cookieCarry.cookies = { chromium: [cookie("prefs")], webkit: [cookie("session"), cookie("prefs")] };
  cookieCarry.applied = [];
  const relaunched = await import("./engineSiteData.ts?run=2");
  assert.equal(await relaunched.carrySignIns("chromium", "webkit", "", "a.example", "https://a.example"), true);
  assert.deepEqual(cookieCarry.applied[0].remove, [{ name: "session", domain: ".a.example", path: "/" }]);
  cookieCarry.can = false;
});
