import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCall, hostAllowed, readLinkDecision, readLiveItems, readSandboxMessage, settingValue, webOrigin } from "./protocol.ts";

const manifest = (permissions = {}, contributes = {}) => ({
  id: "hello",
  name: "Hello",
  version: "1",
  description: "",
  main: "main.js",
  permissions: { hosts: [], tabs: false, links: false, ...permissions },
  settings: [],
  contributes: { commands: [], toolbar: [], tabMenu: [], sidebarViews: [], liveSources: [], themes: [], ...contributes },
});

test("hosts match by scheme, host and port; a wildcard takes the domain and its subdomains", () => {
  const hosts = ["https://api.example.com", "https://*.example.org", "http://localhost:3000"];

  assert.ok(hostAllowed(hosts, "https://api.example.com/v1/items?x=1"));
  assert.ok(hostAllowed(hosts, "https://api.example.com:443/"));
  assert.ok(hostAllowed(hosts, "https://example.org/"));
  assert.ok(hostAllowed(hosts, "https://a.b.example.org/"));
  assert.ok(hostAllowed(hosts, "http://localhost:3000/"));

  for (const url of [
    "http://api.example.com/",
    "https://api.example.com:8443/",
    "https://evil.com/?https://api.example.com",
    "https://notexample.org/",
    "https://api.example.com.evil.com/",
    "http://localhost/",
  ])
    assert.ok(!hostAllowed(hosts, url), url);
});

test("addresses that parse two ways are refused", () => {
  for (const url of [
    "https://evil.com\\@api.example.com/",
    "https://user:pass@api.example.com/",
    "https://api%2eexample.com/",
    "https://api.example.com /",
    "javascript:alert(1)",
    "file:///etc/passwd",
  ])
    assert.equal(webOrigin(url), null, url);
});

test("fetch needs a listed host and plain options", () => {
  const m = manifest({ hosts: ["https://api.example.com"] });
  const get = { method: "GET", headers: { Authorization: "Bearer x" }, body: null };

  assert.deepEqual(checkCall(m, "fetch", ["https://api.example.com/x", get]), {
    ok: true,
    call: { method: "fetch", url: "https://api.example.com/x", init: get },
  });
  assert.match(checkCall(m, "fetch", ["https://other.example.com/", get]).error, /permissions\.hosts/);
  assert.match(checkCall(m, "fetch", ["https://api.example.com/", { ...get, headers: { Cookie: "a=b" } }]).error, /Cookie/);
  assert.match(checkCall(m, "fetch", ["https://api.example.com/", { ...get, body: "x" }]).error, /no body/);
  assert.equal(checkCall(m, "fetch", ["https://api.example.com/", { ...get, method: "TRACE" }]).ok, false);
  assert.equal(checkCall(m, "fetch", ["https://api.example.com/", { ...get, extra: 1 }]).ok, false);
});

test("calls reach only what the manifest adds and asks for", () => {
  const m = manifest({}, { toolbar: [{ id: "b", title: "B", icon: "star", command: "c" }], sidebarViews: [{ id: "inbox", title: "Inbox", icon: "tray" }] });

  assert.match(checkCall(m, "tabs.active", []).error, /permissions\.tabs/);
  assert.equal(checkCall(manifest({ tabs: true }), "tabs.active", []).ok, true);
  assert.equal(checkCall(m, "tabs.open", ["javascript:alert(1)", {}]).ok, false);
  assert.deepEqual(checkCall(m, "tabs.open", ["https://a.example/", { background: true }]).call, {
    method: "tabs.open",
    url: "https://a.example/",
    background: true,
  });
  assert.deepEqual(checkCall(m, "toolbar.set", ["b", { badge: " 12 " }]).call, { method: "toolbar.set", id: "b", state: { badge: "12" } });
  assert.equal(checkCall(m, "toolbar.set", ["b", { badge: "12345" }]).ok, false);
  assert.equal(checkCall(m, "toolbar.set", ["nope", {}]).ok, false);
  assert.equal(checkCall(m, "view.set", ["inbox", [{ id: "1", title: "One", url: "https://a.example/" }]]).ok, true);
  assert.equal(checkCall(m, "view.set", ["inbox", [{ id: "1", title: "One", url: "file:///etc" }]]).ok, false);
  assert.equal(checkCall(m, "storage.set", ["k", "x".repeat(70 * 1024)]).ok, false);
  assert.equal(checkCall(m, "storage.set", ["bad key", 1]).ok, false);
  assert.match(checkCall(m, "eval", []).error, /no plugin call/);
});

test("sandbox messages, live items and link answers are read strictly", () => {
  assert.deepEqual(readSandboxMessage('{"t":"call","n":1,"m":"settings.get","a":[]}'), { t: "call", n: 1, m: "settings.get", a: [] });
  assert.equal(readSandboxMessage('{"t":"call","n":0,"m":"x","a":[]}'), null);
  assert.equal(readSandboxMessage("not json"), null);

  assert.equal(readLiveItems([{ id: "1", url: "https://a.example/", title: "One", updatedAt: 5 }]).ok, true);
  assert.equal(readLiveItems([{ id: "1", url: "https://a.example/", title: "" }]).ok, false);
  assert.equal(readLiveItems("nope").ok, false);

  assert.deepEqual(readLinkDecision({ space: "Work" }), { kind: "space", space: "Work" });
  assert.deepEqual(readLinkDecision({ littleBay: true }), { kind: "littleBay" });
  assert.equal(readLinkDecision(null), null);
  assert.equal(readLinkDecision({ space: "Work", newWindow: true }), null);
});

test("setting values follow their type", () => {
  const choice = { key: "m", title: "M", type: "choice", default: "a", options: [{ value: "a", title: "A" }] };

  assert.equal(settingValue(choice, "a"), "a");
  assert.equal(settingValue(choice, "b"), null);
  assert.equal(settingValue({ key: "t", title: "T", type: "toggle", default: false, options: [] }, true), true);
  assert.equal(settingValue({ key: "s", title: "S", type: "secret", default: null, options: [] }, "x"), null);
});
