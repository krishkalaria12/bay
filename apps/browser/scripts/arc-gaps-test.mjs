// Arc's small habits (docs/feature-gaps-plan.html, Phase 1), in a hidden instance: unread counts on favorites, Little
// Bay from any app and put away, the mouse's side buttons over the sidebar, Option showing the hidden sidebar, the
// marker for the tab scrolled out of view, ⇧↩ to the top result, ⌃⌘J, Capture in Portrait and the JSON viewer.
//
//   node apps/browser/scripts/arc-gaps-test.mjs <Debug Bay.app> [cdpPort]
//
// One line per check; the details and window snapshots go to the scratch folder it prints. Portrait captures land in
// ~/Downloads and are deleted after.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg, port] = process.argv.slice(2);
if (!appArg) {
  console.error("usage: node arc-gaps-test.mjs <Debug Bay.app> [cdpPort]");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "nn-arc-gaps-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "arc-gaps-test.log"), { name: "arc-gaps-test" });
console.log(`scratch: ${scratch}`);

const JSON_BODY = JSON.stringify({
  name: "bay",
  items: [
    { id: 1, tags: ["a", "b"] },
    { id: 2, tags: [] },
  ],
  nested: { deep: { deeper: { deepest: true } } },
});
const handler = (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/data.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON_BODY);
  }
  res.writeHead(200, { "content-type": "text/html" });
  const title = path.slice(1) || "page";
  res.end(`<!doctype html><title>${title}</title><body style="margin:0;background:#ff0000;height:2000px"><h1>${title}</h1></body>`);
};
const server = createServer(handler);
const devServer = createServer(handler);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await new Promise((r) => devServer.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const devBase = `http://127.0.0.1:${devServer.address().port}`;

// MARK: PNG

function readPNG(path) {
  const buf = readFileSync(path);
  let width = 0,
    height = 0,
    colorType = 0;
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
    } else if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const channels = { 2: 3, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? out[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { width, height, pixel: (x, y) => [...out.subarray(y * stride + x * channels, y * stride + x * channels + 3)] };
}

const listTabs = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, url: `${base}/tab${i}`, title: `tab${i}` }));
let app;
const downloads = [];
try {
  app = await launch(resolve(appArg), {
    data,
    port,
    session: session({
      spaces: ["Personal", "Work"],
      settings: { launchTab: "lastTab" },
      tabs: [
        { id: "mail", url: `${base}/mail`, title: "mail", pinned: true, pinnedUrl: `${base}/mail` },
        ...listTabs,
        { id: "work1", url: `${base}/work`, title: "work", spaceId: "work" },
      ],
      windows: [{ id: "w1", activeTabIds: { default: "t0", work: "work1" } }],
    }),
  });
  const nn = (body) => app.eval(body, { timeout: 60000 });
  const native = (call) => nn(`return globalThis.expo.modules.BayApp.${call};`);
  const until = async (label, body, timeout = 10000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      if ((last = await nn(body))) return last;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
  };
  const shot = (name) => nn(`return nn.shell.devSnapshotWindow("w1", ${JSON.stringify(join(scratch, `${name}.png`))});`);
  await until("the session", `return nn.store.getState().tabs.t0?.title === "tab0";`, 60000);
  // Its pages are served from this machine: no Developer Mode offer over them (the JSON check turns it on for one).
  await nn(`nn.developer.setDeveloperMode(${JSON.stringify(base)}, false); nn.developer.setDeveloperMode(${JSON.stringify(devBase)}, false); return true;`);

  // MARK: 1 · Unread counts

  await rep.check("a favorite's unread count comes from its page's title and clears with it", async () => {
    await nn(`nn.store.getState().activate("mail"); return true;`);
    const page = await app.page(`${base.replace(/^http:\/\//, "")}/mail`);
    // Loaded first, or its load's title replaces the one set here.
    await until("the tile's page", `const s = nn.store.getState(); return s.tabs.mail.title === "mail" && s.live.mail && !s.live.mail.isLoading;`);
    await page.eval(`document.title = "(3) Inbox"`);
    await sleep(1500);
    const seen = await nn(
      `const t = nn.store.getState().tabs.mail; return { title: t.title, url: t.url, unread: nn.arcGaps.unread.unreadFromTitle(t.url, t.title) };`,
    );
    if (seen.unread?.count !== 3) throw new Error(`saw ${JSON.stringify(seen)}`);
    await sleep(300);
    await shot("unread-3");
    await page.eval(`document.title = "Inbox"`);
    await until(
      "no count",
      `const t = nn.store.getState().tabs.mail; return t.title === "Inbox" && nn.arcGaps.unread.unreadFromTitle(t.url, t.title) === null;`,
    );
    await nn(`nn.store.getState().activate("t0"); return true;`);
    return "(3) Inbox → 3, Inbox → none (unread-3.png)";
  });

  // MARK: 4 · Side buttons

  await rep.check("the mouse's side buttons switch spaces over the sidebar, and leave them alone over the page", async () => {
    const space = () => nn(`return nn.store.getState().windows.w1.spaceId;`);
    if ((await space()) !== "default") throw new Error(`starts in ${await space()}`);
    const hit = await native(`devOtherMouse("w1", 60, 420, 4)`);
    await until("Work", `return nn.store.getState().windows.w1.spaceId === "work";`);
    await native(`devOtherMouse("w1", 60, 420, 3)`);
    await until("Personal", `return nn.store.getState().windows.w1.spaceId === "default";`);
    await native(`devOtherMouse("w1", 900, 420, 4)`);
    await sleep(800);
    if ((await space()) !== "default") throw new Error("the page's side button switched space");
    return `forward → Work, back → Personal over ${hit}; the page's stayed`;
  });

  // MARK: 5 · Option

  await rep.check("holding Option alone shows the hidden sidebar, and letting go hides it", async () => {
    await nn(`nn.store.getState().toggleSidebar("w1"); return true;`);
    await until("the sidebar hidden", `return nn.store.getState().windows.w1.sidebarOpen === false;`);
    await sleep(1200);
    const out = () => nn(`return globalThis.nnPeekOut("w1");`);
    await native(`devPostFlags("w1", ["option"])`);
    await until("the peek out", `return globalThis.nnPeekOut("w1");`, 3000);
    await native(`devPostFlags("w1", [])`);
    await until("the peek in", `return !globalThis.nnPeekOut("w1");`, 3000);
    // ⌥ on the way to ⌥⌘: nothing shows.
    await native(`devPostFlags("w1", ["option"])`);
    await sleep(60);
    await native(`devPostFlags("w1", ["option", "command"])`);
    await sleep(500);
    const withCommand = await out();
    await native(`devPostFlags("w1", [])`);
    if (withCommand) throw new Error("⌥⌘ showed the sidebar");
    await nn(`nn.store.getState().updateSettings({ showSidebarOnOption: false }); return true;`);
    await native(`devPostFlags("w1", ["option"])`);
    await sleep(600);
    const off = await out();
    await native(`devPostFlags("w1", [])`);
    await nn(`nn.store.getState().updateSettings({ showSidebarOnOption: true }); nn.store.getState().toggleSidebar("w1"); return true;`);
    if (off) throw new Error("it showed with the setting off");
    await until("the sidebar back", `return nn.store.getState().windows.w1.sidebarOpen === true;`);
    return "out with ⌥, in on release; not with ⌥⌘ nor with the setting off";
  });

  // MARK: 6 · Out of view

  await rep.check("the tab scrolled out of view gets a marker at its edge, and clicking it brings the tab back", async () => {
    await nn(`nn.store.getState().activate("t0"); return true;`);
    await sleep(800);
    await nn(`globalThis.nnSidebar("w1").scrollTo(5000); return true;`);
    await until("a marker above", `return globalThis.nnSidebar("w1")?.side === "above";`, 3000);
    await shot("offscreen-above");
    await nn(`globalThis.nnSidebar("w1").reveal(); return true;`);
    await until("no marker", `return globalThis.nnSidebar("w1")?.side === null;`, 3000);
    await nn(`nn.store.getState().activate("t39"); return true;`);
    await sleep(800);
    await nn(`globalThis.nnSidebar("w1").scrollTo(0); return true;`);
    await until("a marker below", `return globalThis.nnSidebar("w1")?.side === "below";`, 3000);
    await shot("offscreen-below");
    await nn(`nn.store.getState().updateSettings({ density: "compact" }); return true;`);
    await sleep(500);
    const compact = await nn(`globalThis.nnSidebar("w1").scrollTo(0); return true;`)
      .then(() => sleep(400))
      .then(() => nn(`return globalThis.nnSidebar("w1")?.side;`));
    await nn(`nn.store.getState().updateSettings({ density: "comfortable" }); nn.store.getState().activate("t0"); return true;`);
    if (compact !== "below") throw new Error(`compact: ${compact}`);
    return "above, gone once revealed, below; compact too (offscreen-*.png)";
  });

  // MARK: 7 · ⇧↩

  await rep.check("⇧↩ on a search goes to its first result through DuckDuckGo, in the same tab", async () => {
    await nn(`nn.runCommand({ command: "focusCommandBar", arg: null, windowId: "w1" }); return true;`);
    await until("the command bar", `return !!nn.omnibox.get("w1:palette");`);
    await nn(`const d = nn.omnibox.get("w1:palette"); d.clear(); d.type("bay browser github"); return true;`);
    await sleep(400);
    const row = await nn(`return nn.omnibox.get("w1:palette").state().items[0]?.kind;`);
    await nn(`nn.omnibox.get("w1:palette").key("Enter", { shiftKey: true }); return true;`);
    const url = await until(
      "the jump",
      `const t = nn.store.getState().tabs.t0; const u = t.navigation?.url ?? t.url; return u.startsWith("https://duckduckgo.com/") && u;`,
    );
    if (url !== "https://duckduckgo.com/?q=%5Cbay%20browser%20github") throw new Error(url);
    const windows = await nn(`return nn.store.getState().windowOrder.length;`);
    if (windows !== 1) throw new Error(`${windows} windows`);
    return `${row} row → ${url}`;
  });
  await nn(`nn.store.getState().navigate("t0", ${JSON.stringify(`${base}/tab0`)}); return true;`);

  // MARK: 8 · ⌃⌘J

  await rep.check("⌃⌘J joins the meeting about to start, and is off when there's none", async () => {
    const menu = () =>
      nn(`const m = nn.arcGaps.menuState(nn.store.getState()); return { off: m.disabled.includes("joinMeeting"), title: m.titles.joinMeeting ?? null };`);
    const before = await menu();
    if (!before.off) throw new Error("on with no meeting");
    const meet = "https://meet.google.com/abc-defg-hij";
    await nn(
      `const now = Date.now(); nn.arcGaps.calendar.setState({ events: [{ id: "e1", occurrence: "e1", calendarId: "c", color: "#000", title: "Standup", start: now + 2 * 60000, end: now + 30 * 60000, allDay: false, location: "", notes: "", url: ${JSON.stringify(meet)}, cancelled: false, declined: false, organizer: null, attendees: [] }] }); return true;`,
    );
    const on = await menu();
    if (on.off || on.title !== "Join “Standup”") throw new Error(JSON.stringify(on));
    const tabs = await nn(`return Object.keys(nn.store.getState().tabs).length;`);
    const pressed = await native(`devPostKey("w1", "menu:j", 38, ["control", "command"])`);
    await until(
      "the call's tab",
      `return Object.values(nn.store.getState().tabs).some((t) => (t.navigation?.url ?? t.url).startsWith(${JSON.stringify(meet)}));`,
    );
    const after = await nn(`return Object.keys(nn.store.getState().tabs).length;`);
    await nn(`nn.arcGaps.calendar.setState({ events: [] }); return true;`);
    return `menu "${on.title}", key ${pressed ? "taken" : "posted"}, ${after - tabs} tab opened`;
  });

  // MARK: 2 · Little Bay from any app

  await rep.check("Little Bay's shortcut and menu bar button come and go with their settings, and the button opens one", async () => {
    const state = () => native(`devLittleBay(null)`);
    if ((await state()).hotKey || (await state()).menuBarItem) throw new Error("on before chosen");
    await nn(
      `nn.store.getState().updateSettings({ littleBayShortcut: nn.arcGaps.littleBayAccess.DEFAULT_LITTLE_BAY_SHORTCUT, littleBayMenuBarItem: true }); return true;`,
    );
    const status = await until("registered", `const s = nn.arcGaps.littleBayAccess.useLittleBayAccess.getState().status; return s !== "off" && s;`);
    const on = await state();
    if (!on.menuBarItem) throw new Error("no menu bar button");
    if (status === "ok" && !on.hotKey) throw new Error("ok without a hot key");
    const before = await nn(`return nn.store.getState().windowOrder.length;`);
    await native(`devLittleBay("click")`);
    const small = await until(
      "a Little Bay ready to type",
      `const s = nn.store.getState(); const id = s.windowOrder.find((w) => s.windows[w].kind === "small"); return id && s.windowUi[id]?.panel.open && id;`,
    );
    await nn(
      `nn.store.getState().closeWindow(${JSON.stringify(small)}); nn.store.getState().updateSettings({ littleBayShortcut: null, littleBayMenuBarItem: false }); return true;`,
    );
    await until("off", `return nn.arcGaps.littleBayAccess.useLittleBayAccess.getState().status === "off";`);
    const off = await state();
    if (off.hotKey || off.menuBarItem) throw new Error(`still ${JSON.stringify(off)}`);
    return `⌥⌘N ${status}; button opened ${small} (${before} windows before); both gone when off`;
  });

  // MARK: 3 · Put away

  await rep.check("the Dock menu hides and shows every Little Bay, and one left alone is put away into the archive", async () => {
    const small = await nn(`return nn.externalLinks.openLittleBay(${JSON.stringify(`${base}/little`)});`);
    await sleep(1500);
    const shown = await native(`devLittleBay(null)`);
    if (!shown.dock.includes("Hide All Little Bay Windows")) throw new Error(`dock: ${shown.dock}`);
    await native(`devLittleBay("dock")`);
    const hidden = await native(`devLittleBay(null)`);
    if (hidden.visible !== 0 || !hidden.dock.includes("Show All Little Bay Windows")) throw new Error(JSON.stringify(hidden));
    await native(`devLittleBay("dock")`);
    const back = await native(`devLittleBay(null)`);
    if (back.visible !== 1) throw new Error(JSON.stringify(back));
    // Bay goes to the background, and six hours pass.
    await nn(`nn.store.getState().setFocusedWindow("w1"); return true;`);
    const early = await nn(`return nn.arcGaps.putAway.putAwayIdleLittleBays(Date.now() + 5 * 3600000);`);
    if (early.length) throw new Error("put away before six hours");
    const closed = await nn(`return nn.arcGaps.putAway.putAwayIdleLittleBays(Date.now() + 6.1 * 3600000);`);
    if (!closed.includes(small)) throw new Error(`closed ${closed}`);
    const entry = await nn(`const c = nn.store.getState().closedTabs.at(-1); return c && { small: c.small, url: c.tab.url };`);
    if (!entry?.small || entry.url !== `${base}/little`) throw new Error(JSON.stringify(entry));
    const dock = await native(`devLittleBay(null)`);
    if (dock.dock.some((t) => t.includes("Little Bay Windows"))) throw new Error("the Dock item stayed");
    return `hide/show from the Dock; put away after 6 h, archived as Little Bay`;
  });

  // MARK: 9 · Portrait

  await rep.check("Capture in Portrait saves the page framed on the space's colours to Downloads and the Library", async () => {
    await nn(`nn.store.getState().activate("t0"); return true;`);
    await sleep(800);
    const media = await nn(`return Object.keys(nn.library.state.useLibrary.getState().media).length;`);
    const started = Date.now();
    await nn(`return nn.capture.capturePortrait("t0");`);
    const dir = join(process.env.HOME, "Downloads");
    const file = readdirSync(dir)
      .filter((f) => f.includes("(Portrait)") && f.endsWith(".png"))
      .map((f) => join(dir, f))
      .find((f) => statSync(f).mtimeMs >= started - 1000);
    if (!file || !existsSync(file)) throw new Error("no portrait capture in Downloads");
    downloads.push(file);
    const png = readPNG(file);
    const viewport = await (await app.page(`${base.replace(/^http:\/\//, "")}/tab0`)).eval("[innerWidth, innerHeight]");
    if (png.width < viewport[0] * 2 || png.height < viewport[1] * 2) throw new Error(`${png.width}×${png.height} for a ${viewport} viewport`);
    const centre = png.pixel(png.width >> 1, png.height >> 1);
    const corner = png.pixel(4, 4);
    if (!(centre[0] > 200 && centre[1] < 60 && centre[2] < 60)) throw new Error(`centre ${centre}, want the page's red`);
    if (corner[0] > 200 && corner[1] < 60) throw new Error(`corner ${corner}: no frame`);
    await until("in the Library", `return Object.keys(nn.library.state.useLibrary.getState().media).length > ${media};`);
    return `${png.width}×${png.height} (viewport ${viewport}), centre ${centre}, backdrop ${corner}`;
  });

  // MARK: LegendList

  await rep.check("the Library's media grid lays out its cards (LegendList)", async () => {
    await nn(`nn.runCommand({ command: "openLibrary", arg: null, windowId: "w1" }); return true;`);
    await sleep(2500);
    await shot("library-media");
    return "library-media.png";
  });

  // MARK: 10 · JSON

  await rep.check("JSON on a Developer Mode site shows as a tree, and elsewhere stays as it was", async () => {
    await nn(
      `nn.developer.setDeveloperMode(${JSON.stringify(`${devBase}/`)}, true); nn.store.getState().newTab("w1", { url: ${JSON.stringify(`${devBase}/data.json`)} }); return true;`,
    );
    const dev = await app.page(`${devBase.replace(/^http:\/\//, "")}/data.json`);
    let viewer = false;
    for (let i = 0; i < 50 && !viewer; i++) {
      viewer = await dev.eval(`!!document.querySelector("bay-json")`);
      if (!viewer) await sleep(200);
    }
    if (!viewer) throw new Error("no viewer on the dev site");
    const rawHidden = await dev.eval(`getComputedStyle(document.querySelector("body > pre")).display === "none"`);
    if (!rawHidden) throw new Error("the raw text still shows");
    const drawn = await dev.eval(
      `(() => { const r = document.querySelector("bay-json").getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height), body: document.body.innerHTML.slice(0, 300) }; })()`,
    );
    if (drawn.height < 100) throw new Error(`the tree has no room: ${JSON.stringify(drawn)}`);
    await sleep(300);
    const picture = await dev.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(scratch, "json-viewer.png"), Buffer.from(picture.data, "base64"));
    await nn(`nn.store.getState().newTab("w1", { url: ${JSON.stringify(`${base}/data.json`)} }); return true;`);
    const plain = await app.page(`${base.replace(/^http:\/\//, "")}/data.json`);
    await sleep(2000);
    if (await plain.eval(`!!document.querySelector("bay-json")`)) throw new Error("the viewer showed on a non-dev site");
    return `tree ${drawn.width}×${drawn.height} on the dev site (json-viewer.png), raw elsewhere`;
  });
} catch (error) {
  rep.record("setup", { error });
} finally {
  for (const file of downloads) rmSync(file, { force: true });
  await app?.quit();
  server.close();
  devServer.close();
}
process.exit(rep.summary() ? 0 : 1);
