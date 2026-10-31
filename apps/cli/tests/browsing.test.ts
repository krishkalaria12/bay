import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { history, type HistoryDomain } from "../src/browsing.ts";

it("reports the newest visit when aggregating domain history", () => {
  const root = mkdtempSync(join(tmpdir(), "bay-history-test-"));
  try {
    mkdirSync(join(root, "Chromium", "Default"), { recursive: true });
    writeFileSync(
      join(root, "Chromium", "BayControl.json"),
      JSON.stringify({ port: 12345, browser: "/devtools/browser/test", token: "history-test-secret", pid: process.pid }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, "session.json"),
      JSON.stringify({ version: 2, spaces: { default: { id: "default", name: "Personal" } }, spaceOrder: ["default"] }),
    );
    const db = new Database(join(root, "Chromium", "Default", "History"));
    const now = Math.floor(Date.now() / 1000) * 1000;
    const chromeTime = (now + 11_644_473_600_000) * 1000;
    try {
      db.exec(
        "CREATE TABLE urls(id INTEGER, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER); CREATE TABLE visits(id INTEGER, url INTEGER, visit_time INTEGER, transition INTEGER)",
      );
      db.query("INSERT INTO urls VALUES (1, 'https://example.com/new', 'New', 1, 0), (2, 'https://example.com/old', 'Old', 1, 0)").run();
      db.query("INSERT INTO visits VALUES (1, 1, ?, 0), (2, 2, ?, 0)").run(chromeTime, chromeTime - 3_600_000_000);
    } finally {
      db.close();
    }
    const [domain] = history(root, { domains: true, space: "Personal" }) as HistoryDomain[];
    expect(domain?.top_title).toBe("New");
    expect(domain?.visits).toBe(2);
    expect(Date.parse(domain!.last_visit)).toBe(now);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
