import { createServer } from "node:http";
import { session } from "../../../../scripts/lib/instance.mjs";

const html = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function externalLinkRulesFixture(baseURL) {
  const host = new URL(baseURL).host;
  const rule = (id, path, destination, sourceApp) => ({ id, pattern: `${host}${path}`, ...(sourceApp ? { sourceApp } : {}), destination });
  const intro = `<!doctype html><meta charset="utf-8"><title>External link rules playground</title>
    <body style="font:19px system-ui;max-width:760px;padding:52px;background:#f6f3ed;color:#282b32">
    <h1>External link rules playground</h1><p>This disposable profile contains fake Personal and Work spaces. Every test page is served locally.</p>
    <p>Open Settings → Links to edit the ordered rules. The terminal running the demo prints commands to send these URLs through macOS:</p>
    <ul><li><code>${html(baseURL)}/work/demo</code> → Work</li><li><code>${html(baseURL)}/quick/demo</code> → Little Bay</li>
    <li><code>${html(baseURL)}/window/demo</code> → new window</li><li><code>${html(baseURL)}/unmatched/demo</code> → default choice</li></ul>
    <p>Rules apply to links received from another app. Clicking a normal page link keeps normal navigation behavior.</p>
    <p>The automated test also sends fake Slack source metadata and checks priority, fallback, and persistence.</p></body>`;
  return session({
    spaces: [{ id: "default", name: "Personal", color: "blue" }, { id: "work", name: "Work", color: "green" }],
    windows: [{ id: "w1", frame: [80, 80, 1280, 850], activeTabIds: { default: "intro" } }],
    tabs: [{ id: "intro", title: "External link rules playground", url: `data:text/html,${encodeURIComponent(intro)}` }],
    settings: {
      launchTab: "lastTab",
      defaultSpaceId: "default",
      warnBeforeQuitting: false,
      warnBeforeClosingWindow: false,
      warnBeforeClosingLastTab: false,
      openLinksInLittleBay: false,
      externalLinkRules: [
        rule("slack-work", "/source/*", { kind: "space", spaceId: "work" }, "com.tinyspeck.slackmacgap"),
        rule("source-default", "/source/*", { kind: "littleBay" }),
        rule("work", "/work/*", { kind: "space", spaceId: "work" }),
        rule("quick", "/quick/*", { kind: "littleBay" }),
        rule("window", "/window/*", { kind: "newWindow" }),
      ],
    },
  });
}

/** All rule URLs stay on the machine; no accounts or network access are needed. */
export async function serveExternalLinkPages() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Fake link ${html(path)}</title><body style="font:22px system-ui;padding:56px;background:#f6f3ed;color:#282b32"><h1>Fake external link</h1><p>${html(path)}</p><p>This page is served locally for the rules playground.</p></body>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
