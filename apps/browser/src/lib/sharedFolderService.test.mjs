import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../store/browserStore.ts");
const { sharedFolderFiles } = await import("../test-native-stub.mjs");
const { FORMAT, bindSharedFolder, startSharedFolders, syncSharedFolder, useSharedFolders } = await import("./sharedFolderService.ts");
const { linkText } = await import("./sharedFolders.ts");

const S = () => useBrowser.getState();
const DIR = "/shared/Team";

function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.test" });
  const tab = S().newTab(w, { url: "https://docs.test/", background: true });
  S().pinRows([tab], true);
  S().updateTab(tab, { customTitle: "Docs" });
  const folder = S().newPinnedFolder(w, { name: "Team", tabIds: [tab] });
  sharedFolderFiles.set(DIR, new Map());

  return { w, tab, folder };
}

const folderTabs = (folder) => Object.values(S().tabs).filter((t) => t.folderId === folder);

test("a folder kept in a shared folder writes its links there, and takes the ones others add", async () => {
  const { folder } = setup();
  const stop = startSharedFolders(useBrowser);

  try {
    await bindSharedFolder(folder, DIR, "Team");
    const files = sharedFolderFiles.get(DIR);

    assert.deepEqual([...files.keys()], [`Docs.${FORMAT}`]);
    assert.equal(useSharedFolders.getState().folders[folder].status, "synced");

    // Someone else adds a link: it comes in as a pinned row that doesn't load.
    files.set(`Wiki.${FORMAT}`, linkText({ url: "https://wiki.test/", title: "Wiki" }, FORMAT));
    await syncSharedFolder(folder);
    const wiki = folderTabs(folder).find((t) => t.pinnedUrl === "https://wiki.test/");

    assert.ok(wiki);
    assert.equal(wiki.unloaded, true);
    assert.equal(wiki.customTitle, "Wiki");

    // They remove Docs: its tab goes.
    files.delete(`Docs.${FORMAT}`);
    await syncSharedFolder(folder);
    assert.deepEqual(
      folderTabs(folder).map((t) => t.pinnedUrl),
      ["https://wiki.test/"],
    );
  } finally {
    stop();
  }
});

test("deleting the folder stops keeping it, and leaves the files", async () => {
  const { folder } = setup();
  const stop = startSharedFolders(useBrowser);

  try {
    await bindSharedFolder(folder, DIR, "Team");
    S().deletePinnedFolder(folder);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(useSharedFolders.getState().folders[folder], undefined);
    assert.equal(sharedFolderFiles.get(DIR).size, 1);
  } finally {
    stop();
  }
});
