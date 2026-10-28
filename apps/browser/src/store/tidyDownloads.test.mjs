import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");

const S = () => useBrowser.getState();
const download = (patch = {}) => ({
  id: "d1",
  url: "https://example.com/IMG_20261024_8812.pdf",
  filename: "IMG_20261024_8812.pdf",
  path: "/Downloads/IMG_20261024_8812.pdf",
  state: "finished",
  paused: false,
  received: 10,
  total: 10,
  speed: 0,
  mimeType: "application/pdf",
  profile: "",
  ...patch,
});
const find = () => S().downloads.find((d) => d.id === "d1");

test("a tidied download keeps its new name when the engine reports the old path again", () => {
  S().hydrate({});
  S().upsertDownload(download());
  S().updateDownloadFile("d1", { filename: "Q3 Report.pdf", path: "/Downloads/Q3 Report.pdf" });
  // The next launch lists Chromium's record, which still names the saved path.
  S().upsertDownload(download());
  assert.equal(find().filename, "Q3 Report.pdf");
  assert.equal(find().path, "/Downloads/Q3 Report.pdf");
});

test("undoing a tidy name goes back to the engine's record", () => {
  S().hydrate({});
  S().upsertDownload(download());
  S().updateDownloadFile("d1", { filename: "Q3 Report.pdf", path: "/Downloads/Q3 Report.pdf" });
  S().updateDownloadFile("d1", { filename: "IMG_20261024_8812.pdf", path: "/Downloads/IMG_20261024_8812.pdf" });
  assert.equal(find().renamedFrom, undefined);
  S().upsertDownload(download({ received: 11 }));
  assert.equal(find().received, 11);
  assert.equal(find().path, "/Downloads/IMG_20261024_8812.pdf");
});

test("a download the engine moved elsewhere follows the engine", () => {
  S().hydrate({});
  S().upsertDownload(download());
  S().updateDownloadFile("d1", { filename: "Q3 Report.pdf", path: "/Downloads/Q3 Report.pdf" });
  S().upsertDownload(download({ filename: "other.pdf", path: "/Elsewhere/other.pdf" }));
  assert.equal(find().path, "/Elsewhere/other.pdf");
});
