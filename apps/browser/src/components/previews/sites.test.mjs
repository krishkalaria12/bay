// Arc's Previews: which tabs get one, and reading Gmail's unread feed and GitHub's pull request pages.
import assert from "node:assert/strict";
import { test } from "node:test";
const sites = await import("./sites.ts");

test("only a pinned or favorite tab on a known site has a preview, by the page it's pinned to", () => {
  const pinned = { pinned: false, pinnedRow: true, url: "", pinnedUrl: "" };
  assert.equal(sites.previewSiteOf({ ...pinned, url: "https://mail.google.com/mail/u/0/#inbox" }), "gmail");
  assert.equal(sites.previewSiteOf({ ...pinned, pinned: true, pinnedRow: false, url: "https://github.com/pulls" }), "github");
  assert.equal(sites.previewSiteOf({ ...pinned, url: "https://news.ycombinator.com/", pinnedUrl: "https://github.com/" }), "github", "away from its pin");
  assert.equal(sites.previewSiteOf({ ...pinned, pinnedRow: false, url: "https://mail.google.com/" }), null, "a plain tab");
  assert.equal(sites.previewSiteOf({ ...pinned, url: "https://example.com/" }), null);
  assert.equal(sites.gmailAccount("https://mail.google.com/mail/u/2/#inbox"), 2);
  assert.equal(sites.gmailAccount("https://mail.google.com/mail/"), 0);
});

const FEED = `<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#">
<title>Gmail - Inbox for me@example.com</title><tagline>New messages in your Gmail Inbox</tagline><fullcount>12</fullcount>
<link rel="alternate" href="https://mail.google.com/mail" type="text/html" /><modified>2026-10-10T08:00:00Z</modified>
<entry><title>Lunch &amp; plans</title><summary>Are we still on for Friday? I&#39;ll book</summary>
<link rel="alternate" href="https://mail.google.com/mail?account_id=me@example.com&amp;message_id=18f&amp;view=conv&amp;extsrc=atom" type="text/html" />
<modified>2026-10-10T07:30:00Z</modified><issued>2026-10-10T07:30:00Z</issued><id>tag:gmail.google.com,2004:1</id>
<author><name>Ana Ruiz</name><email>ana@example.com</email></author></entry>
<entry><title></title><summary></summary><link rel="alternate" href="https://mail.google.com/mail?message_id=19a" type="text/html" />
<issued>2026-10-09T22:00:00Z</issued><author><email>noreply@example.com</email></author></entry>
</feed>`;

test("Gmail's feed gives how many are unread, and each mail's sender, subject, snippet, link and time", () => {
  const data = sites.parseGmailFeed(FEED);
  assert.equal(data.unread, 12, "the inbox's count, not just the entries the feed holds");
  assert.equal(data.mails.length, 2);
  assert.deepEqual(data.mails[0], {
    subject: "Lunch & plans",
    from: "Ana Ruiz",
    snippet: "Are we still on for Friday? I'll book",
    url: "https://mail.google.com/mail?account_id=me@example.com&message_id=18f&view=conv&extsrc=atom",
    at: Date.parse("2026-10-10T07:30:00Z"),
  });
  assert.equal(data.mails[1].from, "noreply@example.com", "no name: the address");
  assert.equal(sites.parseGmailFeed("<!doctype html><title>Sign in</title>"), null, "a sign-in page isn't a feed");
});

// GitHub's pull request search, as JSON (its shape from github.com/search?type=pullrequests in Oct 2026). github.com/pulls
// became a dashboard that loads its lists after the page: its HTML only held an empty review section.
const search = (results, loggedIn = true) =>
  JSON.stringify({ payload: { blackbirdSearchRoute: { results, result_count: results.length, logged_in: loggedIn, type: "pullrequests" } }, title: "Search" });
const PR = {
  author_name: "someone",
  created: "2026-10-08T23:52:17.000+05:30",
  hl_title: "docs: add <em>windows</em> port &amp; plan",
  number: 1,
  repo: { repository: { id: 1, name: "bay", owner_id: 2, owner_login: "someone" } },
  reviewable_state: "ready",
  state: "open",
};

test("a GitHub pull request search gives each pull request, newest first, and its review state when it says it", () => {
  const older = {
    ...PR,
    number: 7,
    created: "2026-09-25T15:45:13.000Z",
    repo: { repository: { name: "ferret", owner_login: "someone" } },
    review_decision: "APPROVED",
  };
  const pulls = sites.parseGithubPulls(search([older, PR]));
  assert.deepEqual(pulls[0], {
    title: "docs: add windows port & plan",
    repo: "someone/bay",
    number: 1,
    url: "https://github.com/someone/bay/pull/1",
    at: Date.parse(PR.created),
    review: null,
  });
  assert.equal(pulls[1].url, "https://github.com/someone/ferret/pull/7");
  assert.equal(pulls[1].review, "approved");
  assert.deepEqual(sites.parseGithubPulls(search([])), [], "none open: an empty list, not an unreadable page");
  assert.equal(sites.parseGithubPulls(JSON.stringify({ payload: { pullsDashboardSurfaceLayoutRoute: {} } })), null, "the dashboard isn't a search");
  assert.equal(sites.parseGithubPulls("<html>Sign in to GitHub</html>"), null);
  const answer = (body) => ({ status: 200, url: "https://github.com/search?type=pullrequests", body });
  assert.equal(sites.signedOut(answer(search([], false))), true, "a signed-out search answers instead of redirecting");
  assert.equal(sites.signedOut(answer(search([PR]))), false);
  assert.match(sites.fetchScript(sites.githubPullsUrls, sites.githubPullsHeaders), /"Accept":"application\/json"/);
});

test("a request the site sent to its sign-in page means the tab is signed out", () => {
  assert.equal(sites.signedOut({ status: 200, url: "https://github.com/login?return_to=%2Fpulls", body: "" }), true);
  assert.equal(sites.signedOut({ status: 200, url: "https://accounts.google.com/v3/signin/identifier", body: "" }), true);
  assert.equal(sites.signedOut({ status: 401, url: "https://mail.google.com/mail/u/0/feed/atom", body: "" }), true);
  assert.equal(sites.signedOut({ status: 200, url: "https://mail.google.com/mail/u/0/feed/atom", body: FEED }), false);
  assert.equal(sites.signedOut({ error: "TypeError: Failed to fetch" }), false);
});

test("a tab asks its site only from the site itself: a sign-in page is signed out, anywhere else can't ask", () => {
  assert.equal(sites.tabPlace("gmail", "https://mail.google.com/mail/u/0/#inbox"), "site");
  assert.equal(sites.tabPlace("gmail", "https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com/mail/u/0/"), "signIn");
  assert.equal(sites.tabPlace("gmail", "https://workspace.google.com/gmail/"), "elsewhere");
  assert.equal(sites.tabPlace("github", "https://github.com/"), "site");
  assert.equal(sites.tabPlace("github", "https://github.com/login?return_to=%2Fpulls"), "signIn");
  assert.equal(sites.tabPlace("github", "https://news.ycombinator.com/"), "elsewhere");
});
