import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { easelShareSnapshot } from "../../../../../packages/desktop/src/easelShare.ts";
import { imageFiles } from "../../../../../packages/desktop/src/imageFiles.web.ts";

const document = {
  id: "private-document-id",
  title: "Private title",
  background: "#123456",
  spaceId: "private-profile",
  createdAt: 1,
  updatedAt: 2,
  items: [],
};

const image = { data: "data:image/png;base64,cG5n", width: 100, height: 50 };
const originalImage = globalThis.Image;
const originalCanvas = globalThis.OffscreenCanvas;
const originalNative = globalThis.nnTestNativeModules;

afterEach(() => {
  globalThis.Image = originalImage;
  globalThis.OffscreenCanvas = originalCanvas;
  globalThis.nnTestNativeModules = originalNative;
});

test("a shared snapshot includes only the picture and unique safe source links", () => {
  const items = [
    { kind: "image", path: "/private/library/image.png", live: true, source: { url: "https://example.test", title: "Source", profileId: "secret" } },
    { kind: "link", url: "https://example.test/", text: "Duplicate" },
    { kind: "link", url: "javascript:alert(1)" },
    { kind: "image", source: { url: "file:///private/local.png" } },
  ];

  const text = easelShareSnapshot({ ...document, items }, "Public title", image);
  assert.deepEqual(JSON.parse(text), {
    version: 1,
    title: "Public title",
    background: "#123456",
    image,
    links: [{ url: "https://example.test/", title: "Source" }],
  });

  for (const privateField of ["private", "live", "path", "profileId", "createdAt", "updatedAt"]) assert.equal(text.includes(privateField), false);
});

test("empty canvases share without an image, populated ones must render", () => {
  assert.equal(JSON.parse(easelShareSnapshot(document, "", null)).image, null);
  assert.equal(JSON.parse(easelShareSnapshot(document, "", null)).title, "Untitled Easel");
  assert.throws(() => easelShareSnapshot({ ...document, items: [{ kind: "rect" }] }, "", null), /render/);
});

test("encoded sharing payloads enforce the server's byte limit", () => {
  assert.throws(() => easelShareSnapshot(document, "é".repeat(9 * 1024 * 1024), null), /too large/);
});

test("a missing image refuses sharing instead of publishing a placeholder", async () => {
  globalThis.Image = class {
    async decode() {
      throw new Error("missing");
    }
  };
  await assert.rejects(imageFiles.prepareShare({ ...document, items: [{ kind: "image", path: "/gone.png" }] }, "Test"), /image is unavailable/);
  await assert.rejects(imageFiles.prepareShare({ ...document, items: [{ kind: "image" }] }, "Test"), /image is unavailable/);
});

test("empty sharing does not decode images or allocate a canvas", async () => {
  globalThis.OffscreenCanvas = class {
    constructor() {
      assert.fail("empty canvas must not render");
    }
  };
  assert.equal(JSON.parse(await imageFiles.prepareShare(document, "Empty")).image, null);
});

test("sharing enforces the PNG byte limit before encoding the snapshot", async () => {
  globalThis.OffscreenCanvas = class {
    getContext() {
      return { scale() {}, translate() {}, fillRect() {}, save() {}, restore() {}, strokeRect() {} };
    }
    async convertToBlob() {
      return new Blob([new Uint8Array(12_000_001)]);
    }
  };
  await assert.rejects(imageFiles.prepareShare({ ...document, items: [{ kind: "rect", x: 0, y: 0, width: 10, height: 10 }] }, "Test"), /too large/);
});

test("HTML export embeds the canvas, escapes labels and never exports local paths", async () => {
  globalThis.OffscreenCanvas = class {
    width = 10;
    height = 20;
    getContext() {
      return { scale() {}, translate() {}, fillRect() {}, save() {}, restore() {}, strokeRect() {} };
    }
    async convertToBlob() {
      return new Blob(["png"], { type: "image/png" });
    }
  };
  let saved;
  globalThis.nnTestNativeModules = {
    BayEasel: {
      saveDownload: async (...args) => {
        saved = args;

        return "/Downloads/Test.html";
      },
    },
  };

  const path = await imageFiles.exportHTML(
    JSON.stringify({
      ...document,
      title: "<Test>",
      items: [
        { kind: "rect", x: 0, y: 0, width: 10, height: 10, source: { url: "https://example.test/?a=1&b=2", title: '<Source "label">', profileId: "private" } },
        { kind: "rect", x: 0, y: 0, width: 10, height: 10, source: { url: "file:///private/secret" } },
      ],
    }),
  );

  assert.equal(path, "/Downloads/Test.html");
  const html = Buffer.from(saved[0], "base64").toString("utf8");
  assert.match(html, /data:image\/png;base64,cG5n/);
  assert.match(html, /&lt;Test&gt;/);
  assert.match(html, /&lt;Source &quot;label&quot;&gt;/);
  assert.match(html, /a=1&amp;b=2/);
  assert.match(html, /Content-Security-Policy/);
  assert.equal(html.includes("/private/"), false);
  assert.equal(html.includes("profileId"), false);
  assert.equal(saved[2], "html");
});

test("retaining an imported image decodes in the renderer and stores normalized PNG bytes", async () => {
  globalThis.Image = class {
    naturalWidth = 640;
    naturalHeight = 480;
    async decode() {}
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return { drawImage() {} };
    }
    async convertToBlob(options) {
      assert.equal(options.type, "image/png");

      return new Blob(["normalized png"]);
    }
  };
  let stored;
  globalThis.nnTestNativeModules = {
    BayEasel: {
      readImage: async (path) => {
        assert.equal(path, "/import/photo.jpg");

        return Buffer.from("source picture").toString("base64");
      },
      storeImage: async (...args) => {
        stored = args;

        return "/Library Media/retained.png";
      },
    },
  };
  assert.deepEqual(await imageFiles.retain("/import/photo.jpg"), { path: "/Library Media/retained.png", width: 640, height: 480 });
  assert.equal(Buffer.from(stored[0], "base64").toString("utf8"), "normalized png");
  assert.equal(stored[1], false);
});
