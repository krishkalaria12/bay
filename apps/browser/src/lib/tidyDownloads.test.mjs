import assert from "node:assert/strict";
import { test } from "node:test";
import { tidyNameAnswers, renameCalls } from "@bay/desktop";
const { useBrowser } = await import("../store/browserStore.ts");
const { useToasts } = await import("../components/ui/toasts.ts");
const { resolveTidySuggestion, tidyFinishedDownload } = await import("./tidyDownloads.ts");

const S = () => useBrowser.getState();
let seq = 0;

function setup(patch = {}, { enabled = true, answer = null } = {}) {
  S().hydrate({});
  S().updateSettings({ tidyDownloads: enabled });
  tidyNameAnswers.answer = answer;
  tidyNameAnswers.asked = 0;
  renameCalls.length = 0;
  const w = S().createWindow({ url: "https://acme.com/reports" });
  const id = `d${++seq}`;
  const d = {
    id,
    url: "https://cdn.acme.com/IMG_20261024_8812.pdf",
    filename: "IMG_20261024_8812.pdf",
    path: "/Downloads/IMG_20261024_8812.pdf",
    state: "finished",
    paused: false,
    received: 10,
    total: 10,
    speed: 0,
    mimeType: "application/pdf",
    profile: "",
    tabUrl: "https://acme.com/reports",
    ...patch,
  };
  S().updateTab(S().windows[w].activeTabIds[S().windows[w].spaceId], { title: "Q3 2026 Report | Acme" });
  S().upsertDownload(d);
  return { w, d, find: () => S().downloads.find((x) => x.id === id) };
}

test("a finished download is renamed with the model's name and says so", async () => {
  const { w, d, find } = setup({}, { answer: "Acme Q3 Report" });
  await tidyFinishedDownload(d);
  assert.equal(find().filename, "Acme Q3 Report.pdf");
  assert.equal(find().path, "/Downloads/Acme Q3 Report.pdf");
  const toast = useToasts.getState().toasts[w];
  assert.equal(toast.title, "Renamed to “Acme Q3 Report.pdf”");
  assert.equal(toast.message, "Was “IMG_20261024_8812.pdf”");
});

test("without the model the local cleaner's name is used", async () => {
  const { d, find } = setup();
  await tidyFinishedDownload(d);
  assert.equal(find().filename, "Q3 2026 Report.pdf");
});

test("a model's answer about the page, not the file, gives way to the local cleaner", async () => {
  const { d, find } = setup({ filename: "Cra-0.1.30.dmg", path: "/Downloads/Cra-0.1.30.dmg" }, { answer: "Acme Q3 2026 Report" });
  await tidyFinishedDownload(d);
  assert.equal(find().filename, "Cra 0.1.30.dmg");
});

test("undo takes the old name back, and it isn't renamed again", async () => {
  const { w, d, find } = setup();
  await tidyFinishedDownload(d);
  useToasts.getState().toasts[w].action.run();
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(find().filename, "IMG_20261024_8812.pdf");
  await tidyFinishedDownload(find());
  assert.equal(find().filename, "IMG_20261024_8812.pdf");
});

test("nothing happens with the setting off, or for a name someone chose or a readable one", async () => {
  for (const [patch, options] of [
    [{}, { enabled: false }],
    [{ suggestedFilename: "invoice.pdf" }, {}],
    [{ filename: "Q4 Roadmap.pdf", path: "/Downloads/Q4 Roadmap.pdf" }, {}],
  ]) {
    const { d, find } = setup(patch, options);
    await tidyFinishedDownload(d);
    assert.equal(find().filename, d.filename, JSON.stringify(patch));
    assert.equal(renameCalls.length, 0);
  }
});

test("a file renamed while the model thinks keeps the person's name", async () => {
  const { d, find } = setup();
  tidyNameAnswers.answer = () => {
    S().updateDownloadFile(d.id, { filename: "Mine.pdf", path: "/Downloads/Mine.pdf" });
    return "Acme Report";
  };
  await tidyFinishedDownload(d);
  assert.equal(find().filename, "Mine.pdf");
  assert.equal(renameCalls.length, 0);
});

test("a file that can't take the name stays quiet", async () => {
  const { w, d, find } = setup({ path: "/gone/IMG_20261024_8812.pdf" });
  useToasts.setState({ toasts: {} });
  await tidyFinishedDownload(d);
  assert.equal(find().filename, "IMG_20261024_8812.pdf");
  assert.equal(useToasts.getState().toasts[w] ?? null, null);
});

test("rows ask the local cleaner, not the model", async () => {
  const { d } = setup({}, { answer: "Never Used" });
  const suggestion = await resolveTidySuggestion(d);
  assert.equal(suggestion.filename, "Q3 2026 Report.pdf");
  assert.equal(tidyNameAnswers.asked, 0);
});
