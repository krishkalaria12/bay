// Boosts, in a hidden instance: a zap hidden from the document's first paint, turned off without a reload, CSS and the
// space's palette, font, case and size, the colour tint and Invert read back from the page's pixels, JavaScript in its
// own world (and only where allowed), Focus picked with a real click, and Boosts kept across a relaunch. Pages are
// checked over DevTools in their main world.
//
//   node apps/browser/scripts/boosts-test.mjs <Debug Bay.app> [cdpPort]
//
// One line per check; the details go to boosts-test.log beside the instance's data.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg, port] = process.argv.slice(2);
if (!appArg) {
  console.error("usage: node boosts-test.mjs <Debug Bay.app> [cdpPort]");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "bay-boosts-"));
const data = join(scratch, "data");
const rep = reporter(join(scratch, "boosts-test.log"), { name: "boosts-test" });

// A white page with an ad, a sidebar, an article and a red picture. The inline script after the ad records whether it
// was ever shown before the page's scripts ran: a zap applied at document start leaves it hidden from the start.
const page = (title) => `<!doctype html><title>${title}</title>
<style>body{margin:0;background:#fff;color:#000;font:16px Helvetica} #ad{height:120px;background:#0a0} #side{width:200px;height:300px;background:#00f;float:left}
article{margin-left:220px;height:300px} img{display:block;width:120px;height:120px}</style>
<div id=ad>Buy now</div><script>
window.adShownAtStart = getComputedStyle(document.getElementById("ad")).display !== "none";
const root = getComputedStyle(document.documentElement);
window.boostAtStart = { accent: root.getPropertyValue("--bay-palette-accent").trim(), marker: root.getPropertyValue("--boost-host-match").trim(), filter: root.filter };
window.loads = (window.loads||0)+1;
window.addEventListener("pageshow", (event) => {
  window.restoredFromCache = event.persisted;
  window.paletteAtPageShow = getComputedStyle(document.documentElement).getPropertyValue("--bay-palette-accent").trim();
});
</script>
<aside id=side>Sidebar</aside><article id=keep><p id=text>Hello boosts</p><img id=pic src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10' fill='%23b05a3c'/%3E%3C/svg%3E"></article>`;
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page(req.url === "/private" ? "Private fixture" : "Boost fixture"));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const host = "127.0.0.1";
const url = `http://${host}:${server.address().port}/`;

function readPNG(base64) {
  const buf = Buffer.from(base64, "base64");
  let width = 0,
    height = 0,
    channels = 0;
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[body[9]];
    } else if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
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
      out[y * stride + x] = (v + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]) & 0xff;
    }
  }
  return (x, y) => [...out.subarray(y * stride + x * channels, y * stride + x * channels + 3)];
}

let app;
try {
  app = await launch(resolve(appArg), {
    data,
    port,
    session: session({
      settings: { launchTab: "lastTab" },
      tabs: [{ id: "t1", url, title: "Boost fixture" }],
      windows: [{ id: "w1", tabIds: ["t1"], activeTabIds: { default: "t1" } }],
    }),
  });
  const nn = (body) => app.eval(body, { timeout: 60000 });
  const until = async (label, test, timeout = 10000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await test();
      if (last) return last;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
  };
  const tab = await app.page(url);
  const reload = async (p = tab) => {
    await p.eval("window.loadsBefore = 1");
    await p.send("Page.reload");
    await until("reload", () => p.eval("document.readyState === 'complete' && window.loadsBefore === undefined"));
  };
  const navigate = async (destination) => {
    await tab.send("Page.navigate", { url: destination });
    await until("navigation", async () => {
      try {
        return await tab.eval(`location.href === ${JSON.stringify(destination)} && document.readyState === 'complete'`);
      } catch {
        // The old execution context disappears during a process swap.
        return false;
      }
    });
  };
  // A point in CSS px, read from a screenshot in device px.
  const pixel = async (p, x, y) => {
    const dpr = await p.eval("devicePixelRatio");
    return readPNG((await p.send("Page.captureScreenshot", { format: "png" })).data)(Math.round(x * dpr), Math.round(y * dpr));
  };
  // The article's empty right side: the page's white background.
  const BG = [700, 250];
  await until("page", () => tab.eval("document.readyState === 'complete'"));
  let id;

  await rep.check("A zap hides its element from the document's start, and on reload", async () => {
    id = await nn(`return nn.boosts.state.createBoost(${JSON.stringify(host)}).id;`);
    await nn(`nn.boosts.state.addSelector(${JSON.stringify(id)}, "zaps", "#ad"); return true;`);
    await until("zap on the open page", () => tab.eval("getComputedStyle(document.getElementById('ad')).display === 'none'"));
    await reload();
    assert.equal(await tab.eval("window.adShownAtStart"), false, "the ad showed before the page's own script");
    assert.equal(await tab.eval("getComputedStyle(document.getElementById('ad')).display"), "none");
    // Nothing of Boosts' is in the page's DOM.
    assert.equal(await tab.eval("document.querySelectorAll('style, link[rel=stylesheet]').length"), 1);
    return "hidden at start";
  });

  await rep.check("Turning a Boost off restores the page without a reload", async () => {
    await tab.eval("window.marker = 'same document'");
    await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { enabled: false }); return true;`);
    await until("ad back", () => tab.eval("getComputedStyle(document.getElementById('ad')).display === 'block'"));
    assert.equal(await tab.eval("window.marker"), "same document");
    await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { enabled: true }); return true;`);
    await until("ad hidden again", () => tab.eval("getComputedStyle(document.getElementById('ad')).display === 'none'"));
    await nn(`nn.boosts.state.setBoostsOn(false); return true;`);
    await until("all off", () => tab.eval("getComputedStyle(document.getElementById('ad')).display === 'block'"));
    await nn(`nn.boosts.state.setBoostsOn(true); return true;`);
    await until("all on", () => tab.eval("getComputedStyle(document.getElementById('ad')).display === 'none'"));
    return "live";
  });

  await rep.check("CSS, font, case and size apply, with the space's palette as variables", async () => {
    await nn(
      `nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "article { border-top: 7px solid var(--bay-palette-accent); }", font: "Georgia", textCase: "uppercase", size: 1.25 }); return true;`,
    );
    await until("CSS", () => tab.eval("getComputedStyle(document.getElementById('keep')).borderTopStyle === 'solid'"));
    const style = await tab.eval(
      "(() => { const p = getComputedStyle(document.getElementById('text')); const root = getComputedStyle(document.documentElement); return { font: p.fontFamily, case: p.textTransform, zoom: root.zoom, palette: root.getPropertyValue('--bay-palette-background').trim(), arc: root.getPropertyValue('--arc-palette-background').trim(), accent: getComputedStyle(document.getElementById('keep')).borderTopColor }; })()",
    );
    assert.match(style.font, /Georgia/);
    assert.equal(style.case, "uppercase");
    assert.equal(style.zoom, "1.25");
    assert.match(style.palette, /^#[0-9A-F]{6,8}$/);
    assert.equal(style.arc, "");
    assert.notEqual(style.accent, "rgb(0, 0, 0)");
    await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "", font: "", textCase: "none", size: 1 }); return true;`);
    return style;
  });

  await rep.check("Custom CSS follows page, dynamic and adopted author sheets without promoting importance", async () => {
    await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "#text { color: rgb(1, 128, 3); }" }); return true;`);
    const color = () => tab.eval("getComputedStyle(document.getElementById('text')).color");
    try {
      await until("custom colour", async () => (await color()) === "rgb(1, 128, 3)");
      await tab.eval(`(() => {
        const style = document.createElement("style");
        style.id = "late-page-style";
        style.textContent = "#text { color: rgb(200, 2, 3); }";
        document.head.append(style);
        window.adoptedBoostTest = new CSSStyleSheet();
        window.adoptedBoostTest.replaceSync("#text { color: rgb(4, 5, 200); }");
        document.adoptedStyleSheets = [window.adoptedBoostTest];
      })()`);
      assert.equal(await color(), "rgb(1, 128, 3)", "a later page or adopted sheet beat equal-specificity custom CSS");
      await tab.eval("window.adoptedBoostTest.replaceSync('#text { color: rgb(9, 10, 220); }')");
      assert.equal(await color(), "rgb(1, 128, 3)", "changing an adopted sheet reordered the custom sheet");
      await tab.eval("document.getElementById('text').style.setProperty('color', 'rgb(40, 50, 60)', 'important')");
      assert.equal(await color(), "rgb(40, 50, 60)", "normal custom CSS was promoted over a page important rule");
      await tab.eval("document.getElementById('text').style.removeProperty('color')");
      await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "" }); return true;`);
      await until("custom sheet removed", async () => (await color()) === "rgb(9, 10, 220)");
      return "equal specificity wins; importance preserved; live removal restores adopted sheet";
    } finally {
      await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "" }); return true;`);
      await tab.eval(
        "document.getElementById('late-page-style')?.remove(); document.adoptedStyleSheets = []; document.getElementById('text').style.removeProperty('color'); delete window.adoptedBoostTest",
      );
    }
  });

  await rep.check("Unfinished custom CSS stays within its own Boost, and every keyed sheet is removed", async () => {
    const second = await nn(`return nn.boosts.state.createBoost(${JSON.stringify(host)}).id;`);
    const color = () => tab.eval("getComputedStyle(document.getElementById('text')).color");
    try {
      await nn(
        `nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "/* unfinished comment" }); nn.boosts.state.updateBoost(${JSON.stringify(second)}, { css: "#text { color: rgb(11, 22, 33); }" }); return true;`,
      );
      await until("sheet after unclosed comment", async () => (await color()) === "rgb(11, 22, 33)");
      await nn(
        `nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "@media not all {" }); nn.boosts.state.updateBoost(${JSON.stringify(second)}, { css: "#text { color: rgb(44, 55, 66); }" }); return true;`,
      );
      await until("sheet after unclosed block", async () => (await color()) === "rgb(44, 55, 66)");
      await reload();
      assert.equal(await color(), "rgb(44, 55, 66)", "document-start sheets were concatenated");
      await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "#text { color: rgb(77, 88, 99); }" }); return true;`);
      await sleep(200);
      assert.equal(await color(), "rgb(44, 55, 66)", "an older Boost overtook the newer sheet on live update");
      await nn(`nn.boosts.state.deleteBoost(${JSON.stringify(second)}); return true;`);
      await until("newer sheet removed", async () => (await color()) === "rgb(77, 88, 99)");
      await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "" }); return true;`);
      await until("all custom sheets removed", async () => (await color()) === "rgb(0, 0, 0)");
      return "independent parsing, stable order and complete removal";
    } finally {
      await nn(`nn.boosts.state.deleteBoost(${JSON.stringify(second)}); nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "" }); return true;`);
    }
  });

  await rep.check("An unboosted source tab supplies destination palette and host tint at document start", async () => {
    const unboosted = url.replace("127.0.0.1", "localhost") + "unboosted";
    const startFilter = () => tab.eval("window.boostAtStart.filter");
    try {
      await navigate(unboosted);
      assert.equal(await tab.eval("getComputedStyle(document.documentElement).filter"), "none");
      await nn(
        `nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: ":root { --boost-host-match: destination; }", color: { ...nn.boosts.model.DEFAULT_BOOST_COLOR, theme: true } }); return true;`,
      );
      await sleep(250);
      await navigate(url + "from-unboosted");
      const first = await tab.eval("window.boostAtStart");
      assert.match(first.accent, /^#[0-9A-F]{6,8}$/i, "palette arrived after document start");
      assert.equal(first.marker, "destination");
      assert.notEqual(first.filter, "none", "destination theme tint arrived after document start");
      assert.equal(await startFilter(), await tab.eval("getComputedStyle(document.documentElement).filter"));
      return first;
    } finally {
      await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { css: "", color: null }); return true;`);
      await navigate(url);
    }
  });

  await rep.check("Each committed host selects its own tint, including trailing-dot URLs and cached pages", async () => {
    const other = await nn('return nn.boosts.state.createBoost("localhost").id;');
    const otherUrl = url.replace("127.0.0.1", "localhost.") + "trailing-dot";
    const originalTheme = await nn("return nn.store.getState().spaces.default.theme ?? null;");
    try {
      await nn(
        `nn.boosts.state.updateBoost(${JSON.stringify(id)}, { color: { ...nn.boosts.model.DEFAULT_BOOST_COLOR, accent: "#E03030", theme: false } }); nn.boosts.state.updateBoost(${JSON.stringify(other)}, { css: ":root { --boost-host-match: trailing-dot; }", color: { ...nn.boosts.model.DEFAULT_BOOST_COLOR, accent: "#3060E0", theme: true }, invert: true }); return true;`,
      );
      await until("first host tint", () => tab.eval("getComputedStyle(document.documentElement).filter !== 'none'"));
      const firstFilter = await tab.eval("getComputedStyle(document.documentElement).filter");
      await navigate(otherUrl);
      const otherStart = await tab.eval("window.boostAtStart");
      assert.equal(otherStart.marker, "trailing-dot", "trailing-dot host did not match its custom CSS");
      assert.notEqual(otherStart.filter, "none");
      assert.notEqual(otherStart.filter, firstFilter, "the previous host's tint leaked into the new document");
      assert.equal(otherStart.filter, await tab.eval("getComputedStyle(document.documentElement).filter"), "host tint changed after document start");
      const dark = await until(
        "trailing-dot native inversion",
        async () => {
          const p = await pixel(tab, ...BG);
          return p.every((v) => v < 130) && p;
        },
        8000,
      );
      // Only the active page gets the new per-tab descriptor immediately. The cached
      // page must get this changed palette before its pageshow, without a JS timer.
      const expectedAccent = await nn(
        `const s = nn.store.getState(); s.updateSpace("default", { theme: { colors: ["#22BBAA", "#CC33AA"], intensity: 0.5, grain: 0 } }); return nn.boosts.state.spacePalette(nn.store.getState(), "default").accent;`,
      );
      await sleep(250);
      // Going back can restore BFCache or reload; either must select the destination's
      // current sheets. The marker identifies a real cache restoration when available.
      await tab.send("Page.getNavigationHistory").then(async ({ entries, currentIndex }) => {
        await tab.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
      });
      await until("back to first host", async () => {
        try {
          return await tab.eval(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
        } catch {
          return false;
        }
      });
      assert.equal(await tab.eval("getComputedStyle(document.documentElement).filter"), firstFilter);
      assert.equal(
        await tab.eval("getComputedStyle(document.documentElement).getPropertyValue('--boost-host-match').trim()"),
        "",
        "old host custom sheet survived navigation",
      );
      await until("palette ready at restored pageshow", () => tab.eval(`window.paletteAtPageShow === ${JSON.stringify(expectedAccent)}`));
      return { dark, restoredFromCache: await tab.eval("window.restoredFromCache") };
    } finally {
      await nn(
        `nn.boosts.state.deleteBoost(${JSON.stringify(other)}); nn.boosts.state.updateBoost(${JSON.stringify(id)}, { color: null }); nn.store.getState().updateSpace("default", { theme: ${JSON.stringify(originalTheme)} }); return true;`,
      );
      await navigate(url);
    }
  });

  await rep.check("A newer space tint wins an older fixed tint, and disabling it restores the fixed tint", async () => {
    const themed = await nn(`return nn.boosts.state.createBoost(${JSON.stringify(host)}).id;`);
    const expectedFilter = async () => {
      const css = await nn(
        `const s = nn.store.getState(); const b = nn.boosts.state.useBoosts.getState(); return nn.boosts.model.tabBoostStyle(nn.boosts.state.spacePalette(s, "default"), Object.values(b.boosts), b.on).sites[${JSON.stringify(host)}];`,
      );
      return tab.eval(`(() => { const sheet = new CSSStyleSheet(); sheet.replaceSync(${JSON.stringify(css)}); return sheet.cssRules[0].style.filter; })()`);
    };
    const currentFilter = () => tab.eval("getComputedStyle(document.documentElement).filter");
    try {
      await nn(
        `nn.boosts.state.updateBoost(${JSON.stringify(id)}, { color: { ...nn.boosts.model.DEFAULT_BOOST_COLOR, accent: "#E03030", theme: false } }); nn.boosts.state.updateBoost(${JSON.stringify(themed)}, { color: { ...nn.boosts.model.DEFAULT_BOOST_COLOR, theme: true } }); return true;`,
      );
      const themedFilter = await expectedFilter();
      await until("newer theme wins", async () => (await currentFilter()) === themedFilter);
      await nn(`nn.boosts.state.updateBoost(${JSON.stringify(themed)}, { enabled: false }); return true;`);
      const fixedFilter = await expectedFilter();
      assert.notEqual(fixedFilter, themedFilter);
      await until("fixed tint restored", async () => (await currentFilter()) === fixedFilter);
      return "one winning filter across fixed and space tints";
    } finally {
      await nn(`nn.boosts.state.deleteBoost(${JSON.stringify(themed)}); nn.boosts.state.updateBoost(${JSON.stringify(id)}, { color: null }); return true;`);
    }
  });

  await rep.check("The colour tint recolours the page and gives pictures their own colours back", async () => {
    await tab.send("Page.bringToFront");
    const before = await pixel(tab, ...BG);
    try {
      await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { color: { ...nn.boosts.model.DEFAULT_BOOST_COLOR, contrast: 0.5 } }); return true;`);
      await until("filter", () => tab.eval("getComputedStyle(document.documentElement).filter.includes('url(')"));
      await sleep(400);
      const tinted = await pixel(tab, ...BG);
      const pic = await tab.eval(
        "(() => { const r = document.getElementById('pic').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()",
      );
      const picture = await pixel(tab, pic[0], pic[1]);
      assert.ok(
        before.every((v) => v > 240),
        `background was ${before}`,
      );
      assert.ok(
        tinted.some((v) => v < 235),
        `background stayed ${tinted}`,
      );
      // The picture's own colour (#B05A3C), within what the inverse can give back (very saturated colours lose a little).
      const want = [0xb0, 0x5a, 0x3c];
      assert.ok(
        picture.every((v, i) => Math.abs(v - want[i]) <= 24),
        `picture became ${picture}`,
      );
      return { before, tinted, picture };
    } finally {
      await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { color: null }); return true;`);
    }
  });

  await rep.check("Invert darkens the page through Chrome's forced dark mode, and back without a reload", async () => {
    await until("light first", async () => (await pixel(tab, ...BG)).every((v) => v > 230), 8000);
    await tab.eval("window.marker = 'before invert'");
    await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { invert: true }); return true;`);
    const dark = await until(
      "dark page",
      async () => {
        const p = await pixel(tab, ...BG);
        return p.every((v) => v < 90) && p;
      },
      8000,
    );
    await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { invert: false }); return true;`);
    await until("light again", async () => (await pixel(tab, ...BG)).every((v) => v > 230), 8000);
    assert.equal(await tab.eval("window.marker"), "before invert");
    return dark;
  });

  await rep.check("JavaScript runs only when turned on, in its own world", async () => {
    const code = "document.body.dataset.boosted = 'yes'; window.boostSecret = 42;";
    await nn(`nn.boosts.state.setBoostScript(${JSON.stringify(id)}, { code: ${JSON.stringify(code)}, enabled: false }); return true;`);
    await sleep(200);
    await reload();
    assert.equal(await tab.eval("document.body.dataset.boosted ?? null"), null, "ran while off");
    await nn(`nn.boosts.state.setBoostScript(${JSON.stringify(id)}, { enabled: true }); return true;`);
    await sleep(200);
    await reload();
    await until("script ran", () => tab.eval("document.body.dataset.boosted === 'yes'"));
    assert.equal(await tab.eval("typeof window.boostSecret"), "undefined", "the script's globals leaked into the page");
    return "isolated";
  });

  await rep.check("Private windows get a Boost's CSS but its JavaScript only when allowed", async () => {
    const privateWindow = await nn("return nn.actions.openWindow({ incognito: true });");
    await nn(`return nn.store.getState().newTab(${JSON.stringify(privateWindow)}, { url: ${JSON.stringify(url + "private")} });`);
    const priv = await app.page(url + "private");
    await until("private page", () => priv.eval("document.readyState === 'complete'"));
    assert.equal(await priv.eval("getComputedStyle(document.getElementById('ad')).display"), "none");
    assert.equal(await priv.eval("document.body.dataset.boosted ?? null"), null, "ran in a private window");
    await nn(`nn.boosts.state.setBoostScript(${JSON.stringify(id)}, { privateWindows: true }); return true;`);
    await sleep(200);
    await reload(priv);
    await until("allowed in private", () => priv.eval("document.body.dataset.boosted === 'yes'"));
    await nn(`nn.store.getState().closeWindow(${JSON.stringify(privateWindow)}); return true;`);
    return "allowed only when asked";
  });

  await rep.check("Focus keeps the clicked element alone", async () => {
    await nn(`nn.boosts.editor.openBoostEditor("t1", { boostId: ${JSON.stringify(id)} }); nn.boosts.editor.startPicking("t1", "focus"); return true;`);
    await until("picker", () => tab.eval("!!document.querySelector('bay-boost-picker')"));
    const [x, y] = await tab.eval("(() => { const r = document.getElementById('keep').getBoundingClientRect(); return [r.left + 40, r.top + 150]; })()");
    await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    const focus = await until("focus selector", () =>
      nn(`return nn.boosts.state.useBoosts.getState().boosts[${JSON.stringify(id)}].focus;`).then((f) => f.length && f),
    );
    await until("only the article", () =>
      tab.eval("getComputedStyle(document.getElementById('side')).display === 'none' && getComputedStyle(document.getElementById('keep')).display !== 'none'"),
    );
    assert.equal(await tab.eval("!!document.querySelector('bay-boost-picker')"), false);
    await nn(`nn.boosts.state.updateBoost(${JSON.stringify(id)}, { focus: [] }); nn.boosts.editor.closeBoostEditor("t1"); return true;`);
    return focus;
  });

  await rep.check("Boosts and this Mac's scripts come back after a relaunch", async () => {
    await sleep(300);
    await app.quit();
    app = await launch(resolve(appArg), { data, port });
    const again = await app.page(url);
    await until(
      "zap after relaunch",
      () => again.eval("document.readyState === 'complete' && getComputedStyle(document.getElementById('ad')).display === 'none'"),
      15000,
    );
    await until("script after relaunch", () => again.eval("document.body.dataset.boosted === 'yes'"));
    return "kept";
  });
} catch (error) {
  rep.record("setup", { error });
} finally {
  await app?.quit();
  server.close();
}
console.log(`Test data: ${scratch}`);
process.exit(rep.summary() ? 0 : 1);
