// Arc's Previews: a pinned or favorite tab on a site Bay knows shows what's new there on hover. The data comes from
// the site itself, asked from inside its own signed-in tab (no tokens): Gmail's unread feed, GitHub's pull requests.
import type { Tab } from "../../store/types";
import { pinnedPage } from "../../store/model";

export type PreviewSite = "gmail" | "github";

export type Mail = { subject: string; from: string; snippet: string; url: string; at: number };
export type GmailData = { unread: number; mails: Mail[] };

export type Review = "approved" | "changes" | "required";
export type Pull = { title: string; repo: string; number: number; url: string; at: number; review: Review | null };
export type GithubData = { authored: Pull[]; requested: Pull[] };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** The site a pinned or favorite tab previews, by the page it's pinned to: none for other tabs. */
export function previewSiteOf(tab: Pick<Tab, "pinned" | "pinnedRow" | "pinnedUrl" | "url"> | undefined): PreviewSite | null {
  if (!tab || !pinnedPage(tab)) return null;
  const host = hostOf(tab.pinnedUrl || tab.url);
  if (host === "mail.google.com") return "gmail";
  if (host === "github.com") return "github";
  return null;
}

const SITE_HOST: Record<PreviewSite, string> = { gmail: "mail.google.com", github: "github.com" };

/**
 * Where a tab is, for asking its site: on the site, on a sign-in page (Google's accounts, a /login), or elsewhere.
 * Only a tab on the site can ask it: a sign-in page's own policy may never run the request at all.
 */
export function tabPlace(site: PreviewSite, url: string): "site" | "signIn" | "elsewhere" {
  const host = hostOf(url);
  if (host === SITE_HOST[site]) return /^https:\/\/github\.com\/(login|session)/.test(url) ? "signIn" : "site";
  if (host === "accounts.google.com" || /\/(login|signin)\b/.test(url)) return "signIn";
  return "elsewhere";
}

/** The Gmail account a tab shows: /mail/u/1/ is the second signed-in account. */
export function gmailAccount(url: string): number {
  return Number(/\/mail\/u\/(\d+)/.exec(url)?.[1] ?? 0);
}

// A page answer: what a fetch from inside the tab returned.
export type Fetched = { status: number; url: string; body: string } | { error: string };

// Runs in the tab: fetches each path from the site with the tab's own sign-in, and posts every answer back.
export function fetchScript(urls: string[], headers: Record<string, string> = {}): string {
  return `
const one = (u) => fetch(u, { credentials: "include", headers: ${JSON.stringify(headers)} }).then(
  async (r) => ({ status: r.status, url: r.url, body: r.ok ? await r.text() : "" }),
  (e) => ({ error: String(e) }),
);
Promise.all(${JSON.stringify(urls)}.map(one)).then((all) => post("result", JSON.stringify(all)));`;
}

export const gmailFeedUrl = (account: number) => `https://mail.google.com/mail/u/${account}/feed/atom`;

// GitHub's search, as JSON (what its own page asks for): github.com/pulls became a dashboard that ignores its query
// and loads its lists after the page, so its HTML had none (an empty review section read as "0 open", Oct 2026).
const GITHUB_SEARCH = "https://github.com/search?type=pullrequests&q=";
export const githubPullsUrls = [
  `${GITHUB_SEARCH}${encodeURIComponent("is:open is:pr author:@me archived:false")}`,
  `${GITHUB_SEARCH}${encodeURIComponent("is:open is:pr review-requested:@me archived:false")}`,
];
export const githubPullsHeaders = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };

/** A sign-in page in place of the data: the site sent the tab's request to its login, or (GitHub's search) answered a
 *  signed-out visitor. */
export function signedOut(f: Fetched): boolean {
  if ("error" in f) return false;
  if (f.status === 401 || f.status === 403 || /\/(login|signin|ServiceLogin)\b|accounts\.google\.com/.test(f.url)) return true;
  return searchRoute(f.body)?.logged_in === false;
}

// MARK: Gmail

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? all;
  });
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]!.trim()) : "";
};

/** Gmail's unread feed (Atom 0.3): how many are unread, and the newest ones. Null when it isn't that feed. */
export function parseGmailFeed(xml: string): GmailData | null {
  if (!/<feed[\s>]/.test(xml) || !/<fullcount>/.test(xml)) return null;
  const mails: Mail[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const author = tag(entry!, "author");
    const href = /<link[^>]*href="([^"]+)"/.exec(entry!)?.[1];
    mails.push({
      subject: tag(entry!, "title"),
      from: tag(author, "name") || tag(author, "email"),
      snippet: tag(entry!, "summary"),
      url: href ? decode(href) : "",
      at: Date.parse(tag(entry!, "issued") || tag(entry!, "modified")) || 0,
    });
  }
  return { unread: Number(tag(xml, "fullcount")) || mails.length, mails };
}

// MARK: GitHub

const REVIEWS: [RegExp, Review][] = [
  [/APPROVED/i, "approved"],
  [/CHANGES_REQUESTED/i, "changes"],
  [/REVIEW_REQUIRED/i, "required"],
];

// GitHub names the review state differently across its pages (reviewDecision, reviewState…): any of them will do.
function reviewOf(item: Record<string, unknown>): Review | null {
  for (const [key, value] of Object.entries(item)) {
    if (!/review/i.test(key) || typeof value !== "string") continue;
    for (const [pattern, review] of REVIEWS) if (pattern.test(value)) return review;
  }
  return null;
}

type SearchResult = {
  number?: unknown;
  hl_title?: unknown;
  title?: unknown;
  created?: unknown;
  repo?: { repository?: { owner_login?: unknown; name?: unknown } };
};

// GitHub's search JSON: its route, or null when the body isn't that.
function searchRoute(body: string): { logged_in?: unknown; results?: unknown } | null {
  try {
    const route = (JSON.parse(body) as { payload?: { blackbirdSearchRoute?: unknown } })?.payload?.blackbirdSearchRoute;
    return route && typeof route === "object" ? (route as { logged_in?: unknown; results?: unknown }) : null;
  } catch {
    return null;
  }
}

/** GitHub's pull request search (JSON): its pull requests, newest first ([] for none). Null when it isn't that. */
export function parseGithubPulls(body: string): Pull[] | null {
  const route = searchRoute(body);
  if (!route || !Array.isArray(route.results)) return null;
  const pulls: Pull[] = [];
  for (const item of route.results as SearchResult[]) {
    const owner = item.repo?.repository?.owner_login;
    const name = item.repo?.repository?.name;
    if (typeof item.number !== "number" || typeof owner !== "string" || typeof name !== "string") continue;
    const repo = `${owner}/${name}`;
    // The title comes highlighted (<em> around what matched).
    const title = decode(String(item.hl_title ?? item.title ?? "").replace(/<[^>]*>/g, ""));
    pulls.push({
      title,
      repo,
      number: item.number,
      url: `https://github.com/${repo}/pull/${item.number}`,
      at: Date.parse(String(item.created ?? "")) || 0,
      review: reviewOf(item as Record<string, unknown>),
    });
  }
  return pulls.sort((a, b) => b.at - a.at);
}
