import assert from "node:assert/strict";
import { test } from "node:test";
import LZString from "lz-string";
import {
  decodeSharedCollection,
  encodeSharedCollection,
  sharedCollectionAppUrl,
  sharedCollectionToken,
  sharedCollectionUrl,
  sharedLinkCount,
  type SharedCollection,
  type SharedItem,
  type SharedLink,
} from "./sharedCollection.ts";

const link = (url = "https://example.com/", title = "Example"): SharedLink => ({ kind: "link", title, url });
const collection = (children: SharedItem[] = [link()]): SharedCollection => ({ version: 1, kind: "folder", title: "Reading", children });
const compress = (value: unknown): string => LZString.compressToEncodedURIComponent(JSON.stringify(value));

function rejectsBoth(value: unknown, error: RegExp): void {
  assert.throws(() => encodeSharedCollection(value as SharedCollection), error);
  assert.throws(() => decodeSharedCollection(compress(value)), error);
}

function nested(depth: number): SharedCollection {
  let item: SharedItem = link();
  for (let i = 1; i < depth; i++) item = { kind: "folder", title: `Level ${i}`, children: [item] };
  return collection([item]);
}

function rawSizedCollection(size: number): SharedCollection {
  const result = collection(Array.from({ length: 100 }, () => link("https://example.com/", "文".repeat(1_000))));
  let needed = size - JSON.stringify(result).length;
  for (const item of result.children as SharedLink[]) {
    const added = Math.min(needed, 8_192 - item.url.length);
    item.url += "x".repeat(added);
    needed -= added;
    if (!needed) break;
  }
  assert.equal(needed, 0);
  assert.equal(JSON.stringify(result).length, size);
  return result;
}

test("30 nested Unicode tabs round-trip without losing folders, ordering, titles, or URL fragments", () => {
  const tabs = Array.from({ length: 30 }, (_, i) => link(`https://例え.jp/記事/${i}?q=☕&name=élève#段落-${i}`, `タブ ${i} · مرحبا · नमस्ते · 👩🏽‍💻`));
  const value = collection([
    ...tabs.slice(0, 10),
    { kind: "folder", title: "研究 📚", children: [...tabs.slice(10, 20), { kind: "folder", title: "Nested", children: tabs.slice(20) }] },
  ]);
  value.title = "共同研究 🌍 e\u0301";
  const token = encodeSharedCollection(value);
  assert.match(token, /^[A-Za-z0-9+-]+$/);
  assert.ok(token.length < JSON.stringify(value).length);
  assert.deepEqual(decodeSharedCollection(token), value);
  assert.equal(sharedLinkCount(value), 30);
  assert.equal(encodeSharedCollection(value), token);
});

test("all collection kinds, empty folders, empty titles, and zero links are supported", () => {
  for (const kind of ["folder", "split", "selection"] as const) {
    const value: SharedCollection = { version: 1, kind, title: "", children: [{ kind: "folder", title: "", children: [] }] };
    assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), value);
    assert.equal(sharedLinkCount(value), 0);
  }
});

test("exports and imports rebuild only allowed fields at every level", () => {
  const value = {
    ...collection(),
    id: "secret-root-id",
    profile: { cookies: "secret-cookie" },
    children: [
      { kind: "folder", title: "Folder", databaseId: "secret-folder-id", children: [{ ...link(), history: ["secret-history"], favicon: "secret-icon" }] },
    ],
  };
  const clean = collection([{ kind: "folder", title: "Folder", children: [link()] }]);
  const token = encodeSharedCollection(value as SharedCollection);
  assert.equal(LZString.decompressFromEncodedURIComponent(token), JSON.stringify(clean));
  assert.deepEqual(decodeSharedCollection(compress(value)), clean);
  assert.ok(!LZString.decompressFromEncodedURIComponent(token).includes("secret"));
  assert.equal(value.id, "secret-root-id");
  assert.ok("history" in value.children[0]!.children[0]!);
});

test("extra fields cannot run toJSON or leak through prototypes during serialization", () => {
  const value = collection();
  Object.assign(value, {
    toJSON: () => {
      throw new Error("metadata was serialized");
    },
  });
  Object.assign(value.children[0]!, { toJSON: () => ({ leaked: true }), __proto__: { leaked: true } });
  assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), collection());
  const polluted = JSON.parse('{"version":1,"kind":"folder","title":"Reading","children":[],"__proto__":{"polluted":true}}');
  assert.deepEqual(decodeSharedCollection(compress(polluted)), collection([]));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("malformed shapes and unsupported versions fail on export and import", () => {
  const cases: [unknown, RegExp][] = [
    [null, /collection must be an object/],
    [[], /collection must be an object/],
    [{ ...collection(), version: 2 }, /unsupported version/],
    [{ ...collection(), version: "1" }, /unsupported version/],
    [{ ...collection(), version: undefined }, /unsupported version/],
    [{ ...collection(), kind: "link" }, /collection.kind/],
    [{ ...collection(), title: 12 }, /collection.title/],
    [{ ...collection(), children: {} }, /children must be an array/],
    [collection([null as unknown as SharedItem]), /must be an object/],
    [collection([{ kind: "split", title: "Invalid" } as unknown as SharedItem]), /kind must be link or folder/],
    [collection([{ kind: "folder", title: "Invalid" } as unknown as SharedItem]), /children must be an array/],
    [collection([{ ...link(), title: false } as unknown as SharedItem]), /title must be a string/],
    [collection([{ ...link(), url: 123 } as unknown as SharedItem]), /nonempty HTTP/],
    [collection([link("")]), /nonempty HTTP/],
  ];
  for (const [value, error] of cases) rejectsBoth(value, error);
  assert.throws(() => encodeSharedCollection(collection(Array<SharedItem>(1))), /must be an object/);
});

test("non-HTTP protocols, relative paths, credentials, and ambiguous URL spellings are rejected", () => {
  for (const url of [
    "file:///Users/private/notes",
    "bay://history",
    "javascript:alert(1)",
    "data:text/plain,secret",
    "ftp://example.com/",
    "//example.com/",
    "/path",
    "https:example.com",
    "https://",
    "https:///example.com/",
    "http://[bad]/",
    "https://user:password@example.com/",
    "https://user@example.com/",
    "https://@example.com/",
    "https://example.com\\@127.0.0.1/",
    " https://example.com/",
    "https://example.com/\nsecret",
    "https://example.com/a b",
  ])
    rejectsBoth(collection([link(url)]), /HTTP\(S\)|credentials/);
});

test("local hostnames and IPv4 private, loopback, link-local, shared, and reserved addresses are rejected", () => {
  for (const host of [
    "localhost",
    "LOCALHOST.",
    "nested.localhost",
    "printer",
    "printer.local",
    "printer.lan",
    "printer.internal",
    "printer.intranet",
    "printer.corp",
    "printer.home",
    "router.home.arpa",
    "localhost.localdomain",
    "%6cocalhost",
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "127.99.1.2",
    "0.0.0.0",
    "0.1.2.3",
    "169.254.1.2",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "255.255.255.255",
    "127.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "0x0a000001",
    "3232235777",
    "10.0.0.1.",
  ])
    rejectsBoth(collection([link(`https://${host}/private`)]), /localhost|private network/);
});

test("IPv6 local, mapped private, and transition addresses are rejected", () => {
  for (const host of [
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
    "::ffff:c0a8:101",
    "::127.0.0.1",
    "2002:7f00:1::",
    "2001:0:1234::1",
    "64:ff9b::7f00:1",
  ])
    rejectsBoth(collection([link(`http://[${host}]/`)]), /localhost|private network/);
});

test("private URL checks remain consistent with React Native's regex URL shim", () => {
  // Mirrors the installed RN URL getters without loading native modules/Babel.
  class ReactNativeURL {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
    get hostname() {
      return this.value.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/)?.[1] ?? "";
    }
    get username() {
      return this.value.match(/^https?:\/\/([^:@]+)(?::[^@]*)?@/)?.[1] ?? "";
    }
    get password() {
      return this.value.match(/https?:\/\/.*:(.*)@/)?.[1] ?? "";
    }
  }
  const browserURL = globalThis.URL;
  globalThis.URL = ReactNativeURL as unknown as typeof URL;
  try {
    for (const url of [
      "https://127.1/private",
      "https://0177.0.0.1/private",
      "https://0x7f000001/private",
      "https://2130706433/private",
      "https://127%2e1/private",
      "https://%31%32%37.0.0.1/private",
      "https://１２７。０。０。１/private",
      "HTTPS://LOCALHOST/private",
      "HTTPS://192.168.1.1/private",
      "https://[::ffff:127.0.0.1]/private",
      "HTTPS://[FC00::1]/private",
      "https://[0:0:0:0:0:ffff:7f00:1]/private",
      "https://ＬＯＣＡＬＨＯＳＴ/private",
    ])
      rejectsBoth(collection([link(url)]), /localhost|private network/);
    for (const url of ["HTTPS://user:secret@EXAMPLE.COM/", "HTTPS://@EXAMPLE.COM/"]) rejectsBoth(collection([link(url)]), /credentials/);
    for (const url of ["HTTPS://EXAMPLE.COM/path", "https://[2606:4700:4700::1111]/", "https://[::ffff:8.8.8.8]/", "https://例え.jp/記事"]) {
      const value = collection([link(url)]);
      assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), value);
    }
  } finally {
    globalThis.URL = browserURL;
  }
});

test("malformed literal hosts, ports, hostname escapes, and ignored Unicode are rejected portably", () => {
  for (const host of [
    "[1:2:3]",
    "[1:2:3:4:5:6:7:8:9]",
    "[1::2::3]",
    "[2606:4700::gggg]",
    "[::ffff:127.000.0.1]",
    "[::ffff:999.1.1.1]",
    "[fe80::1%25en0]",
    "127.0.0.999",
    "0x100000000",
    "0177.0.0.08",
    "example.com:65536",
    "example.com:invalid",
    "example.com:",
    "example..com",
    "example.com..",
    "%zz.example.com",
    "%23.example.com",
    "%00.example.com",
    "local\u200bhost",
    "local\u034fhost",
    "local\u00adhost",
    "xn--.com",
    "xn--a.com",
  ])
    rejectsBoth(collection([link(`https://${host}/`)]), /HTTP\(S\)/);
});

test("public HTTP(S), public literal IPs, IDNs, ports, queries, and fragments remain intact", () => {
  for (const url of [
    "http://example.com/",
    "HTTPS://EXAMPLE.COM:8443/a?x=1&y=2#part",
    "https://example.com./",
    "https://localhost.example.com/",
    "https://例え.jp/記事",
    "https://8.8.8.8/",
    "http://172.15.255.255/",
    "http://172.32.0.1/",
    "https://100.63.255.255/",
    "https://100.128.0.1/",
    "https://192.0.8.1/",
    "https://[2606:4700:4700::1111]/",
    "https://[::ffff:8.8.8.8]/",
    "https://example.com/?redirect=http%3A%2F%2Flocalhost",
  ]) {
    const value = collection([link(url)]);
    assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), value);
  }
});

test("malformed tokens, truncation, invalid JSON, and trailing compressed garbage throw useful errors", () => {
  for (const token of ["", "#abc", "%20", "a b", "abc/", "abc_", "💥", "abc$", "abc\n", null, undefined, 42]) {
    assert.throws(() => decodeSharedCollection(token as string), /share token/);
  }
  const token = encodeSharedCollection(collection());
  for (const bad of ["A", "B", "D", "AAAA", token.slice(0, -3), `${token}AAAA`]) {
    assert.throws(() => decodeSharedCollection(bad), /compressed share token/);
  }
  assert.throws(() => decodeSharedCollection(LZString.compressToEncodedURIComponent("not JSON")), /not valid JSON/);
  assert.throws(() => decodeSharedCollection(LZString.compressToEncodedURIComponent("")), /compressed share token/);
});

test("500 links are allowed and a 501st is rejected on import and export", () => {
  const value = collection(Array.from({ length: 500 }, () => link()));
  assert.equal(sharedLinkCount(decodeSharedCollection(encodeSharedCollection(value))), 500);
  rejectsBoth(collection([...value.children, link()]), /exceeds 500 links/);
});

test("empty folders also have a bounded total item count", () => {
  const value = collection(Array.from({ length: 1_000 }, () => ({ kind: "folder", title: "Empty", children: [] })));
  assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), value);
  rejectsBoth(collection([...value.children, { kind: "folder", title: "Extra", children: [] }]), /exceeds 1000 items/);
  const branch = { kind: "folder" as const, title: "Branch", children: value.children.slice(0, 600) };
  rejectsBoth(collection([branch, branch]), /exceeds 1000 items/);
});

test("descendant depth 12 is allowed, depth 13 and cyclic structures are rejected", () => {
  assert.deepEqual(decodeSharedCollection(encodeSharedCollection(nested(12))), nested(12));
  rejectsBoth(nested(13), /exceeds depth 12/);
  const cyclic = collection([]);
  cyclic.children.push({ kind: "folder", title: "Cycle", children: cyclic.children });
  assert.throws(() => encodeSharedCollection(cyclic), /exceeds depth 12/);
});

test("title and URL length boundaries apply to the root and nested items", () => {
  const value = collection([link(`https://example.com/${"x".repeat(8_192 - 20)}`, "x".repeat(1_024))]);
  value.title = "x".repeat(1_024);
  assert.equal((value.children[0] as SharedLink).url.length, 8_192);
  assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), value);
  rejectsBoth({ ...value, title: "x".repeat(1_025) }, /title exceeds 1024/);
  rejectsBoth(collection([link(undefined, "x".repeat(1_025))]), /title exceeds 1024/);
  rejectsBoth(collection([{ kind: "folder", title: "x".repeat(1_025), children: [] }]), /title exceeds 1024/);
  rejectsBoth(collection([link(`https://example.com/${"x".repeat(8_193 - 20)}`)]), /url exceeds 8192/);
});

test("the raw JSON boundary is 128000 characters, independently of compression ratio", () => {
  const value = rawSizedCollection(128_000);
  assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), value);
  rejectsBoth(rawSizedCollection(128_001), /(?:serialized|decompressed) data exceeds 128000/);
});

test("a compressed bomb is rejected before lz-string allocates the decompressed string", () => {
  const token = LZString.compressToEncodedURIComponent("x".repeat(2_000_000));
  assert.ok(token.length < 16_000);
  const decompress = LZString.decompressFromEncodedURIComponent;
  let called = false;
  LZString.decompressFromEncodedURIComponent = () => {
    called = true;
    throw new Error("unbounded decompression");
  };
  try {
    assert.throws(() => decodeSharedCollection(token), /decompressed data exceeds 128000/);
    assert.equal(called, false);
  } finally {
    LZString.decompressFromEncodedURIComponent = decompress;
  }
});

test("the token boundary is 16000 characters and incompressible collections cannot bypass it", () => {
  assert.throws(() => decodeSharedCollection("A".repeat(16_001)), /share token exceeds 16000/);
  assert.throws(() => decodeSharedCollection("A".repeat(16_000)), /compressed share token/);
  let state = 123456789;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return String.fromCharCode(33 + ((state >>> 0) % 90));
  };
  const value = collection(Array.from({ length: 30 }, () => link(undefined, Array.from({ length: 1_000 }, random).join(""))));
  assert.ok(JSON.stringify(value).length < 128_000);
  assert.ok(compress(value).length > 16_000);
  assert.throws(() => encodeSharedCollection(value), /share token exceeds 16000/);
});

test("web and app URL helpers preserve token bytes and use the official fragment routes", () => {
  const value = collection();
  const token = encodeSharedCollection(value);
  assert.equal(sharedCollectionUrl(value), `https://bay.krishkalaria.in/share/#${token}`);
  assert.equal(sharedCollectionAppUrl(token), `bay://share/#${token}`);
  for (const prefix of [
    "https://bay.krishkalaria.in/share#",
    "https://bay.krishkalaria.in/share/#",
    "bay://share/#",
    "HTTPS://BAY.KRISHKALARIA.IN/share/#",
    "BAY://SHARE/#",
  ]) {
    assert.equal(sharedCollectionToken(`${prefix}${token}`), token);
  }
  assert.equal(sharedCollectionToken("bay://share/#a+b-c"), "a+b-c");
  assert.throws(() => sharedCollectionAppUrl("junk"), /Invalid shared collection/);
  assert.throws(() => sharedCollectionAppUrl(compress(collection([link("http://localhost/")]))), /localhost/);
});

test("token extraction rejects lookalike origins, credentials, ports, query strings, and normalized path tricks", () => {
  const token = encodeSharedCollection(collection());
  for (const base of [
    "http://bay.krishkalaria.in/share/",
    "https://evil.example/share/",
    "https://bay.krishkalaria.in.evil.example/share/",
    "https://bay.krishkalaria.in./share/",
    "https://bay.krishkalaria.in:443/share/",
    "https://bay.krishkalaria.in:8443/share/",
    "https://user@bay.krishkalaria.in/share/",
    "https://@bay.krishkalaria.in/share/",
    "https://bay.krishkalaria.in@evil.example/share/",
    "https://bay.krishkalaria.in/Share/",
    "https://bay.krishkalaria.in/other/../share/",
    "https://bay.krishkalaria.in//share/",
    "https://bay.krishkalaria.in/%73hare/",
    "https://bay.krishkalaria.in/share/extra",
    "https://bay.krishkalaria.in/share/?query=1",
    "https://bay.krishkalaria.in/share/?",
    "https://bay.krishkalaria.in/share//",
    "bay://share",
    "bay:///share/",
    "bay://share.evil/",
    "bay://share:80/",
    "bay://user@share/",
    "bay://share/extra",
    "bay://share/?query=1",
    "bay://SHARE/../",
    " bay://share/",
    "bay://share/\n",
    "https://bay.krishkalaria.in\\share/",
  ])
    assert.equal(sharedCollectionToken(`${base}#${token}`), null, base);
  for (const url of [
    "bay://share/",
    "bay://share/#",
    `bay://share/#${token}#extra`,
    "bay://share/#a%2Bb",
    "bay://share/#a b",
    "bay://share/#abc_",
    "bay://share/#abc\n",
    `bay://share/#${"A".repeat(16_001)}`,
  ]) {
    assert.equal(sharedCollectionToken(url), null, url.slice(0, 80));
  }
  assert.equal(sharedCollectionToken(null as unknown as string), null);
  assert.equal(sharedCollectionToken(`bay://share/#${"A".repeat(16_000)}`)?.length, 16_000);
});

test("codec runs without URL, Buffer, base64 globals, or text encoding globals", () => {
  const names = ["URL", "Buffer", "btoa", "atob", "TextEncoder", "TextDecoder"];
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    const value = collection([link("https://example.com/世界", "Привет 🌻")]);
    assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), value);
  } finally {
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("dictionary length preflight accepts varied ASCII, Unicode, and escaped JSON payloads", () => {
  let state = 17;
  for (let i = 0; i < 100; i++) {
    let title = "";
    for (let j = 0; j < i * 10; j++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      title += String.fromCharCode(state % 65_536);
    }
    const value = collection([link(undefined, title)]);
    assert.deepEqual(decodeSharedCollection(encodeSharedCollection(value)), value);
  }
});
