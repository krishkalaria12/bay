// The website's screenshots are of Bay itself: a Release build on a throwaway data folder, staged from a saved session
// (scenes.mjs) and captured window by window, so they can be retaken whenever the UI changes.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { launch, session, sleep } from "../../../../scripts/lib/instance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");

export const buildApp = join(repo, "apps/browser/build-dev/Build/Products/Release/Bay.app");

// Favicons by site, so that a tab that hasn't loaded still shows its real icon.
export const site = {
  bay: ["https://bay.krishkalaria.in/", "Bay: a beautiful, fast browser for Mac", "https://bay.krishkalaria.in/favicon.ico"],
  github: ["https://github.com/krishkalaria12/bay", "krishkalaria12/bay", "https://github.githubassets.com/favicons/favicon.png"],
  figma: ["https://www.figma.com/", "Figma", "https://static.figma.com/app/icon/1/favicon.png"],
  linear: ["https://linear.app/", "Linear", "https://linear.app/favicon.ico"],
  notion: ["https://www.notion.so/", "Notion", "https://www.notion.so/images/favicon.ico"],
  spotify: ["https://open.spotify.com/", "Spotify", "https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png"],
  youtube: ["https://www.youtube.com/", "YouTube", "https://www.youtube.com/favicon.ico"],
  wikipedia: ["https://en.wikipedia.org/", "Wikipedia", "https://en.wikipedia.org/static/favicon/wikipedia.ico"],
  apple: ["https://www.apple.com/", "Apple", "https://www.apple.com/favicon.ico"],
  hn: ["https://news.ycombinator.com/", "Hacker News", "https://news.ycombinator.com/favicon.ico"],
  gmail: ["https://mail.google.com/", "Gmail", "https://mail.google.com/favicon.ico"],
  calendar: ["https://calendar.google.com/", "Google Calendar", "https://calendar.google.com/googlecalendar/images/favicons_2020q4/calendar_31.ico"],
  slack: ["https://slack.com/", "Slack", "https://slack.com/favicon.ico"],
  stripe: ["https://stripe.com/", "Stripe", "https://stripe.com/favicon.ico"],
  vercel: ["https://vercel.com/", "Vercel", "https://vercel.com/favicon.ico"],
  airbnb: ["https://www.airbnb.com/", "Airbnb", "https://www.airbnb.com/favicon.ico"],
  nytimes: ["https://www.nytimes.com/", "The New York Times", "https://www.nytimes.com/favicon.ico"],
  arena: ["https://www.are.na/", "Are.na", "https://www.are.na/favicon.ico"],
  reddit: ["https://www.reddit.com/", "Reddit", "https://www.reddit.com/favicon.ico"],
};

let nextTab = 0;

/** A tab of a known site: `tab("github", { title: "…", url: "…", pinned: true })`. */
export function tab(key, extra = {}) {
  const [url, title, favicon] = site[key];
  return { id: `t${++nextTab}`, url, favicon, pinnedUrl: extra.pinned || extra.pinnedRow ? url : null, ...extra, title: extra.title ?? title };
}

export async function open(scene, data) {
  return launch(buildApp, {
    data,
    fresh: true,
    probe: true,
    onboarded: true,
    js: "none",
    // Visible, unlike a test instance; `open -g` still keeps it from taking focus.
    env: { BAY_BACKGROUND: null },
    files: { "telemetry.json": { version: 1, sharing: false, decidedAt: 1, askDoneAt: 1 } },
    session: session({ ...scene, settings: { launchTab: "lastTab", ...scene.settings } }),
  });
}

/** Bay's windows as CoreGraphics sees them, for `screencapture -l`. */
export function windowsOf(pid) {
  const script = `
import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == ${pid} && (w[kCGWindowLayer as String] as? Int) == 0 {
  let b = w[kCGWindowBounds as String] as! [String: Double]
  if b["Width"]! > 200 && b["Height"]! > 200 { print(w[kCGWindowNumber as String] as! Int, Int(b["X"]!), Int(b["Y"]!), Int(b["Width"]!), Int(b["Height"]!)) }
}`;
  return execFileSync("swift", ["-e", script], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, x, y, width, height] = line.split(" ").map(Number);
      return { id, x, y, width, height };
    });
}

/**
 * The window alone at Retina resolution, its rounded corners transparent, without the system's shadow. The app comes
 * forward because an inactive window's traffic lights are grey, and the pointer goes to the menu bar so that nothing
 * shows as hovered; focus and pointer then go back.
 */
export async function photograph(pid, window, file, crop) {
  const events = (line) => execFileSync("osascript", ["-e", `tell application "System Events" to ${line}`], { encoding: "utf8" }).trim();
  const raw = `${file}.raw.png`;
  const previous = events("unix id of first process whose frontmost is true");
  const pointer = execFileSync("cliclick", ["p:."], { encoding: "utf8" }).trim();
  events(`set frontmost of (first process whose unix id is ${pid}) to true`);
  execFileSync("cliclick", [`m:${window.x + 200},4`]);
  try {
    await sleep(900);
    execFileSync("screencapture", ["-x", "-o", "-l", String(window.id), "-t", "png", raw]);
  } finally {
    execFileSync("cliclick", [`m:${pointer}`]);
    events(`set frontmost of (first process whose unix id is ${previous}) to true`);
  }
  let image = sharp(raw);
  if (crop) image = image.extract(crop);
  await image.webp({ quality: 92, alphaQuality: 100, effort: 6 }).toFile(file);
  rmSync(raw);
}

/** A copy at an address that never changes, for the schema and the image sitemap, on the site's paper colour. */
export async function publish(file, jpeg) {
  mkdirSync(dirname(jpeg), { recursive: true });
  await sharp(file).flatten({ background: "#edeef1" }).resize({ width: 1920 }).jpeg({ quality: 88, mozjpeg: true }).toFile(jpeg);
}
