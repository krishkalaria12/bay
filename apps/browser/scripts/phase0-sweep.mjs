// Release-compatible local regressions for the feature-gaps Phase 0 sweep.
// node apps/browser/scripts/phase0-sweep.mjs <Bay.app> <scratch dir> [--debug]
// Uses only an isolated profile. The remaining real-site checks are in docs/release-checklist.md.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { launch, reporter, session, sleep } from "../../../scripts/lib/instance.mjs";

const [appArg, scratchArg, mode] = process.argv.slice(2);
if (!appArg || !scratchArg) {
  console.error("usage: phase0-sweep.mjs <Bay.app> <scratch dir> [--debug]");
  process.exit(64);
}
const scratch = resolve(scratchArg);
const data = join(scratch, "data");
mkdirSync(data, { recursive: true });
const rep = reporter(join(scratch, "phase0-sweep.log"), { name: "phase0-sweep" });
const icon = readFileSync(new URL("../assets/site-icons/gmail.png", import.meta.url));
const requests = new Map();
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  if (path === "/icon.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(icon);
  }
  if (path === "/favicon.ico") {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(`<!doctype html><title>${path.slice(1)}</title>
    <body style="margin:0;height:10000px"><h1>Phase 0 fixture</h1><input value="unchanged">
    <script>window.instanceToken = Math.random().toString(36);
    if (location.pathname === '/delayed-icon') setTimeout(() => {
      const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = '/icon.png'; document.head.append(icon);
    }, 1500);</script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
let app;
const options = { data, js: mode === "--debug" ? "pinned" : "none", probe: true, onboarded: true };
const until = async (description, fn) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`timed out: ${description}`);
};
const check = async (name, fn) => {
  const start = Date.now();
  try {
    const evidence = await fn();
    rep.record(name, { ms: Date.now() - start, evidence });
  } catch (error) {
    rep.record(name, { ms: Date.now() - start, error });
  }
};
const onPage = async (path, expression) => {
  const page = await app.page(path);
  try {
    return await page.eval(expression);
  } finally {
    page.close();
  }
};
const loaded = (id) =>
  until(`loaded ${id}`, () => app.eval(`return !!nn.webviews.get(${JSON.stringify(id)}) && !nn.store.getState().live[${JSON.stringify(id)}]?.isLoading`));

try {
  app = await launch(resolve(appArg), {
    ...options,
    session: session({
      windows: [{ id: "w1", activeTabIds: { default: "scroll" } }],
      tabs: [
        { id: "scroll", url: `${base}/scroll`, title: "scroll" },
        { id: "spare", url: `${base}/spare`, title: "spare" },
      ],
      settings: { warnBeforeClosingLastTab: false, launchTab: "lastTab" },
    }),
  });
  await app.eval(`nn.developer.setDeveloperMode(${JSON.stringify(base)}, false); return true`);
  await loaded("scroll");

  await check("12: sleeping tab restores scroll", async () => {
    await onPage("/scroll", "scrollTo(0, 2300); true");
    await sleep(500);
    const before = await onPage("/scroll", "scrollY");
    assert.equal(before, 2300);
    await app.eval('nn.store.getState().activate("spare", "w1"); return true');
    await loaded("spare");
    await sleep(500);
    assert.equal(await app.eval('return nn.webviews.get("scroll").discard()'), "discarded");
    await app.eval('nn.store.getState().activate("scroll", "w1"); return true');
    const after = await until("restored scroll", async () => {
      try {
        return (await onPage("/scroll", "scrollY")) === before ? before : null;
      } catch {
        return null;
      }
    });
    return { before, after };
  });

  await check("13: icon arriving after challenge replaces fallback", async () => {
    await app.eval(`nn.store.getState().newTab("w1", {url:${JSON.stringify(`${base}/delayed-icon`)}}); return true`);
    // newTab generates its own id. Find it by URL rather than relying on fixture ids.
    const id = await until("delayed icon tab", () =>
      app.eval(`return Object.values(nn.store.getState().tabs).find(t => t.url === ${JSON.stringify(`${base}/delayed-icon`)})?.id`),
    );
    await loaded(id);
    const favicon = await until("late favicon", () => app.eval(`return nn.store.getState().tabs[${JSON.stringify(id)}]?.favicon?.includes("/icon.png")`));
    const cached = await until("decoded late favicon", () =>
      app.eval(
        `return Object.values(nn.favicons.useFavicons.getState().profiles).some(p => p.pages[${JSON.stringify(`${base}/delayed-icon`)}]?.startsWith("data:image/"))`,
      ),
    );
    return { favicon, cached };
  });

  await check("14: moving tab to new window preserves live document", async () => {
    await app.eval('nn.store.getState().activate("scroll", "w1"); return true');
    await loaded("scroll");
    const before = await onPage("/scroll", "({token:instanceToken, y:scrollY})");
    const loads = requests.get("/scroll");
    await app.eval('nn.actions.moveTabToWindow("scroll", "new"); return true');
    await until("new window owns tab", () => app.eval('return nn.store.getState().tabs.scroll.windowId !== "w1"'));
    await loaded("scroll");
    await sleep(750);
    const after = await onPage("/scroll", "({token:instanceToken, y:scrollY})");
    assert.deepEqual(after, before);
    assert.equal(requests.get("/scroll"), loads);
    return { before, after, loads };
  });

  await check("7: session cookie survives quit and forced termination", async () => {
    const storedCookie = () => {
      const db = new DatabaseSync(join(data, "Chromium/Default/Cookies"), { readOnly: true });
      try {
        return db.prepare("SELECT name, is_persistent FROM cookies WHERE name = 'phase0session'").all();
      } finally {
        db.close();
      }
    };
    const second = await app.eval(`const s = nn.store.getState();
      const spaceId = s.createSpace({name:"Cookie isolation"});
      const windowId = s.createWindow({spaceId, url:${JSON.stringify(`${base}/other-profile`)}});
      const w = nn.store.getState().windows[windowId]; return w.activeTabIds[spaceId];`);
    await loaded(second);
    await until("second profile document", async () => {
      try {
        return (await onPage("/other-profile", "document.readyState")) === "complete";
      } catch {
        return false;
      }
    });
    assert.match(await onPage("/other-profile", 'document.cookie="phase0session=other; path=/"; document.cookie'), /phase0session=other/);
    await onPage("/scroll", `addEventListener("beforeunload", () => { document.cookie="phase0unload=written; path=/"; }); true`);
    const written = await onPage("/scroll", 'document.cookie="phase0session=retained; path=/"; document.cookie');
    assert.match(written, /phase0session=retained/);
    rep.log({ stage: "cookie written", cookie: written });
    const expectCookie = () => onPage("/scroll", "document.cookie");
    await sleep(1500);
    rep.log({ stage: "before quit disk", cookies: storedCookie() });
    rep.log({ stage: "quit", result: await app.quit() });
    assert.doesNotMatch(
      readFileSync(join(data, "Chromium/chrome_debug.log"), "utf8"),
      /FATAL:/,
      "a process crash must not count as a successful graceful quit",
    );
    rep.log({ stage: "after quit disk", cookies: storedCookie() });
    for (const entry of readdirSync(join(data, "Chromium"))) {
      if (!entry.startsWith("Profile ")) continue;
      const db = new DatabaseSync(join(data, "Chromium", entry, "Cookies"), { readOnly: true });
      try {
        rep.log({
          stage: "other profile after quit disk",
          profile: entry,
          cookies: db.prepare("SELECT name,is_persistent FROM cookies WHERE name LIKE 'phase0%'").all(),
        });
      } finally {
        db.close();
      }
    }
    assert.equal(storedCookie().length, 1, "quick quit flushes the session cookie to disk before exit");
    app = await launch(resolve(appArg), options);
    await loaded("scroll");
    await until("restored scroll document", async () => {
      try {
        return (await onPage("/scroll", "document.readyState")) === "complete";
      } catch {
        return false;
      }
    });
    const afterQuit = await expectCookie();
    rep.log({ stage: "cookie after quit", cookie: afterQuit });
    assert.match(afterQuit, /phase0session=retained/);
    assert.match(afterQuit, /phase0unload=written/, "cookies written by beforeunload are flushed too");
    const otherCookie = await until("second profile cookie restored", async () => {
      try {
        return (await onPage("/other-profile", "document.cookie")) || null;
      } catch {
        return null;
      }
    });
    assert.match(otherCookie, /phase0session=other/);
    assert.doesNotMatch(otherCookie, /phase0session=retained|phase0unload=/);
    await sleep(1500);
    // Kill only the owned instance; this is the same unclean shutdown as Force Quit.
    assert.ok(app.stillOwned());
    process.kill(app.pid, "SIGKILL");
    await until("owned process exited", () => !app.stillOwned());
    app = await launch(resolve(appArg), options);
    await loaded("scroll");
    const cookie = await expectCookie();
    assert.match(cookie, /phase0session=retained/);
    return { quit: true, duringBeforeUnload: true, multipleProfiles: true, forcedTermination: true, cookie };
  });
} catch (error) {
  rep.record("suite setup", { error });
} finally {
  await app?.quit();
  server.close();
  writeFileSync(join(scratch, "results.json"), JSON.stringify(rep.results, null, 2));
}
process.exit(rep.results.some((r) => r.status === "FAIL") ? 1 : 0);
