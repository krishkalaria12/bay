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

// GitHub's pull request lists are a React app: the page embeds its data as JSON (fetched from github.com in Oct 2026).
const page = (results) =>
  `<html><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
    payload: { repoPullsDashboardContentRoute: { results, totalCount: results.length } },
    title: "Pull requests",
  })}</script></html>`;
const PR = {
  author: { displayLogin: "someone" },
  createdAt: "2026-10-10T02:52:48Z",
  updatedAt: "2026-10-10T02:53:19Z",
  number: 37806,
  permalink: "https://github.com/react/react/pull/37806",
  repoNameWithOwner: "react/react",
  state: "REPO_PULL_REQUEST_STATE_OPEN",
  title: "[Fast Refresh] Don't retain roots that unmount before their first commit",
};

test("a GitHub pull request page gives each pull request, and its review state when the page says it", () => {
  const pulls = sites.parseGithubPulls(page([PR, { ...PR, number: 2, permalink: "https://github.com/a/b/pull/2", reviewDecision: "APPROVED" }]));
  assert.deepEqual(pulls[0], {
    title: PR.title,
    repo: "react/react",
    number: 37806,
    url: PR.permalink,
    at: Date.parse(PR.updatedAt),
    review: null,
  });
  assert.equal(pulls[1].review, "approved");
  assert.equal(sites.parseGithubPulls(page([{ ...PR, reviewState: "CHANGES_REQUESTED" }]))[0].review, "changes");
  assert.deepEqual(sites.parseGithubPulls(page([])), [], "none open: an empty list, not an unreadable page");
  assert.equal(sites.parseGithubPulls(page([{ id: 1 }]).replace('"results"', '"other"')), null, "data, but no pull request list");
  assert.equal(sites.parseGithubPulls("<html>Sign in to GitHub</html>"), null);
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
