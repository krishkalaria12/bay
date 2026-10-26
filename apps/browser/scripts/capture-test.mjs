// Capture, in a hidden instance: ⇧⌘2's selection in the page, a click on a block, a drag over an area (scrolled
// past the window too), ⌘⇧ with a drag, Esc, Capture Full Page and Save. The pictures are read back pixel by pixel:
// the page's own colours, without the selection's shade. Mouse and keys go through DevTools (trusted events in the
// renderer). Saved captures land in ~/Downloads and are deleted after.
//
//   node apps/browser/scripts/capture-test.mjs <Debug Bay.app> [cdpPort]
//
// One line per check; the details go to capture-test.log beside the instance's data.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg, port] = process.argv.slice(2);
if (!appArg) {
  console.error("usage: node capture-test.mjs <Debug Bay.app> [cdpPort]");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "nn-capture-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "capture-test.log"), { name: "capture-test" });

// A red block, a link, a block taller than the window and a green band at the very bottom of a 3000 px page.
const page = `<!doctype html><title>Capture fixture</title>
<style>body{margin:0;font:16px system-ui;background:#fff;height:3000px;position:relative}
#red{position:absolute;left:100px;top:120px;width:300px;height:200px;background:#ff0000}
#link{position:absolute;left:500px;top:120px;display:block;width:200px;height:60px;background:#0000ff;color:#fff}
#tall{position:absolute;left:100px;top:400px;width:200px;height:1800px;background:#00ffff}
#foot{position:absolute;left:0;right:0;bottom:0;height:100px;background:#00ff00}</style>
<div id=red></div><a id=link href="/elsewhere">elsewhere</a><div id=tall></div><div id=foot></div>
<script>window.clicks = 0; addEventListener("click", () => clicks++); addEventListener("mousedown", () => clicks++);</script>`;
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url === "/" ? page : "<title>elsewhere</title>elsewhere");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

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
      if (body[8] !== 8 || body[12] !== 0) throw new Error("only 8-bit, non-interlaced PNGs");
    } else if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const channels = { 2: 3, 6: 4 }[colorType];
  if (!channels) throw new Error(`colour type ${colorType}`);
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
// The page's sRGB colour, as it is or through Display P3 (Chrome captures in the display's profile, and tags it).
const toP3 = (rgb) => {
  const lin = rgb.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const m = [
    [0.8225, 0.1774, 0],
    [0.0332, 0.9669, 0],
    [0.0171, 0.0724, 0.9108],
  ];
  return m.map((row) => {
    const v = Math.min(1, Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
    return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  });
};
const near = (rgb, want) => [want, toP3(want)].some((w) => rgb.every((v, i) => Math.abs(v - w[i]) <= 8));

let app;
const saved = [];
try {
  app = await launch(resolve(appArg), {
    data,
    port,
    session: session({
      settings: { launchTab: "lastTab" },
      tabs: [{ id: "t1", url, title: "Capture fixture" }],
      windows: [{ id: "w1", tabIds: ["t1"], activeTabIds: { default: "t1" } }],
    }),
  });
  const nn = (body) => app.eval(body, { timeout: 60000 });
  for (let i = 0; i < 60 && !(await nn(`return nn.store.getState().tabs.t1?.title === "Capture fixture";`)); i++) await sleep(500);
  const tab = await app.page(url.replace(/^http:\/\//, ""));
  await sleep(1000);
  const scale = await tab.eval("devicePixelRatio");

  const until = async (label, body, timeout = 10000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      if ((last = await nn(body))) return last;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
  };
  const current = () =>
    nn(`const s = nn.capture.useCaptures.getState().sessions.t1; return s ? { phase: s.phase, image: s.image ?? null, area: s.area ?? null } : null;`);
  const overlay = () => tab.eval("!!document.querySelector('bay-capture')");
  const mouse = (type, x, y, modifiers = 0, buttons = type === "mouseReleased" ? 0 : 1) =>
    tab.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons, clickCount: 1, modifiers });
  const move = async (from, to, modifiers = 0, steps = 8) => {
    for (let i = 1; i <= steps; i++)
      await mouse("mouseMoved", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, modifiers, 1);
  };
  const select = async () => {
    await nn(`nn.capture.closeCapture("t1"); return nn.capture.startCapture("t1");`);
    await until("the selection in the page", `return nn.capture.useCaptures.getState().sessions.t1?.phase === "selecting";`);
    for (let i = 0; i < 30 && !(await overlay()); i++) await sleep(100);
    if (!(await overlay())) throw new Error("no selection in the page");
  };
  const ready = () => until("the capture", `return nn.capture.useCaptures.getState().sessions.t1?.phase === "ready";`, 20000).then(current);

  await rep.check("the capture command puts the selection in the page", async () => {
    await nn(`nn.runCommand({ command: "capture", arg: null, windowId: null }); return true;`);
    await until("selecting", `return nn.capture.useCaptures.getState().sessions.t1?.phase === "selecting";`);
    for (let i = 0; i < 30 && !(await overlay()); i++) await sleep(100);
    if (!(await overlay())) throw new Error("no <bay-capture> in the page");
    return "selecting, overlay in the page";
  });

  await rep.check("Esc in the page puts the selection away", async () => {
    await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await until("no session", `return !nn.capture.useCaptures.getState().sessions.t1;`);
    if (await overlay()) throw new Error("the overlay stayed");
    return "gone";
  });

  await rep.check("a click takes the block under it, in the page's own colours, and the page gets no click", async () => {
    await tab.eval("scrollTo(0, 0); clicks = 0");
    await select();
    await move([10, 10], [250, 220], 0, 6);
    await mouse("mouseMoved", 250, 220, 0, 0);
    await mouse("mousePressed", 250, 220);
    await mouse("mouseReleased", 250, 220);
    const s = await ready();
    const png = readPNG(s.image.path);
    const want = [Math.round(300 * scale), Math.round(200 * scale)];
    if (Math.abs(png.width - want[0]) > 2 || Math.abs(png.height - want[1]) > 2) throw new Error(`size ${png.width}×${png.height}, want ${want}`);
    const centre = png.pixel(png.width >> 1, png.height >> 1);
    if (!near(centre, [255, 0, 0])) throw new Error(`centre ${centre}: shaded or not the block`);
    const clicks = await tab.eval("clicks");
    if (clicks) throw new Error(`the page got ${clicks} presses`);
    if (Math.round(s.area.left) !== 100 || Math.round(s.area.top) !== 120) throw new Error(`area ${JSON.stringify(s.area)}`);
    return `${png.width}×${png.height}, centre ${centre}`;
  });

  await rep.check("a drag takes the area dragged over", async () => {
    await select();
    await mouse("mousePressed", 50, 100);
    await move([50, 100], [250, 200]);
    await mouse("mouseReleased", 250, 200);
    const s = await ready();
    const png = readPNG(s.image.path);
    const want = [Math.round(200 * scale), Math.round(100 * scale)];
    if (Math.abs(png.width - want[0]) > 2 || Math.abs(png.height - want[1]) > 2) throw new Error(`size ${png.width}×${png.height}, want ${want}`);
    // Its top-left is white page, its bottom-right the red block's.
    const tl = png.pixel(4, 4),
      br = png.pixel(png.width - 4, png.height - 4);
    if (!near(tl, [255, 255, 255]) || !near(br, [255, 0, 0])) throw new Error(`corners ${tl} / ${br}`);
    return `${png.width}×${png.height}, corners ${tl} / ${br}`;
  });

  await rep.check("a block taller than the window comes whole", async () => {
    await tab.eval("scrollTo(0, 300)");
    await sleep(300);
    await select();
    await move([10, 10], [200, 300], 0, 4);
    await mouse("mousePressed", 200, 300);
    await mouse("mouseReleased", 200, 300);
    const s = await ready();
    const png = readPNG(s.image.path);
    const ratio = png.height / png.width;
    if (Math.abs(ratio - 1800 / 200) > 0.05) throw new Error(`${png.width}×${png.height}, want 1:9`);
    const bottom = png.pixel(png.width >> 1, png.height - 4);
    if (!near(bottom, [0, 255, 255])) throw new Error(`bottom ${bottom}`);
    return `${png.width}×${png.height}`;
  });

  await rep.check("⌘⇧ and a drag on the page captures the area, and a link under it doesn't open", async () => {
    await nn(`nn.capture.closeCapture("t1"); return true;`);
    await tab.eval("scrollTo(0, 0); clicks = 0");
    await sleep(300);
    const tabs = await nn(`return Object.keys(nn.store.getState().tabs).length;`);
    const mods = 4 | 8;
    await mouse("mouseMoved", 520, 130, mods, 0);
    await mouse("mousePressed", 520, 130, mods);
    await sleep(400);
    await move([520, 130], [680, 170], mods);
    await mouse("mouseReleased", 680, 170, mods);
    const s = await ready();
    const png = readPNG(s.image.path);
    const centre = png.pixel(png.width >> 1, png.height >> 1);
    if (!near(centre, [0, 0, 255])) throw new Error(`centre ${centre}, want the link's blue`);
    const after = await nn(`return Object.keys(nn.store.getState().tabs).length;`);
    if (after !== tabs) throw new Error(`${after - tabs} tabs opened`);
    if ((await tab.eval("location.pathname")) !== "/") throw new Error("the link was followed");
    return `${png.width}×${png.height}, centre ${centre}`;
  });

  await rep.check("Save puts the capture in Downloads under the page's title", async () => {
    const before = await nn(`return nn.capture.useCaptures.getState().sessions.t1?.name ?? null;`);
    await nn(`return nn.capture.saveCapture("t1");`);
    await until("closed", `return !nn.capture.useCaptures.getState().sessions.t1;`);
    const file = join(process.env.HOME, "Downloads", `${before}.png`);
    if (!existsSync(file)) throw new Error(`no ${file}`);
    saved.push(file);
    readPNG(file);
    return file;
  });

  await rep.check("Capture Full Page saves the whole page, its bottom band included", async () => {
    await tab.eval("scrollTo(0, 0)");
    const name = await nn(`const started = Date.now(); return nn.capture.captureFullPage("t1").then(() => started);`);
    const { readdirSync, statSync } = await import("node:fs");
    const dir = join(process.env.HOME, "Downloads");
    const file = readdirSync(dir)
      .filter((f) => f.startsWith("Capture fixture (Full Page)") && f.endsWith(".png"))
      .map((f) => join(dir, f))
      .filter((f) => statSync(f).mtimeMs >= name - 1000)[0];
    if (!file) throw new Error("no full-page capture in Downloads");
    saved.push(file);
    const png = readPNG(file);
    const ratio = png.height / png.width;
    const viewport = await tab.eval("innerWidth");
    if (Math.abs(png.height / scale - 3000) > 4 && Math.abs(ratio - 3000 / viewport) > 0.02) throw new Error(`${png.width}×${png.height}`);
    const bottom = png.pixel(png.width >> 1, png.height - 10);
    if (!near(bottom, [0, 255, 0])) throw new Error(`bottom ${bottom}, want the green band`);
    return `${png.width}×${png.height}`;
  });
} catch (error) {
  rep.record("setup", { error });
} finally {
  for (const file of saved) rmSync(file, { force: true });
  await app?.quit();
  server.close();
  rmSync(data, { recursive: true, force: true });
}
process.exit(rep.summary() ? 0 : 1);
