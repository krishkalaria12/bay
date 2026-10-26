import assert from "node:assert/strict";
import { test } from "node:test";
import { unreadFromTitle, unreadLabel } from "./unreadBadges.ts";

test("Gmail's inbox count comes from its title and clears at zero", () => {
  const url = "https://mail.google.com/mail/u/0/#inbox";
  assert.deepEqual(unreadFromTitle(url, "Inbox (3) - me@gmail.com - Gmail"), { count: 3 });
  assert.deepEqual(unreadFromTitle(url, "Inbox (1,234) - me@gmail.com - Gmail"), { count: 1234 });
  assert.equal(unreadFromTitle(url, "Inbox - me@gmail.com - Gmail"), null);
  assert.equal(unreadFromTitle(url, "Inbox (0) - me@gmail.com - Gmail"), null);
  // Reading a message: its subject, whose own brackets aren't a count.
  assert.equal(unreadFromTitle(url, "Lunch on Friday - me@gmail.com - Gmail"), null);
  assert.equal(unreadFromTitle(url, "Re: the plan - (2) more notes - me@gmail.com - Gmail"), null);
  assert.deepEqual(unreadFromTitle(url, "Posteingang (4) - me@gmail.com - Gmail"), { count: 4 });
});

test("chat sites give a count, or a dot when they only mark new messages", () => {
  assert.deepEqual(unreadFromTitle("https://app.slack.com/client/T1/C1", "(2) Slack | general | Acme"), { count: 2 });
  assert.deepEqual(unreadFromTitle("https://app.slack.com/client/T1/C1", "* Slack | general | Acme"), { dot: true });
  assert.deepEqual(unreadFromTitle("https://app.slack.com/client/T1/C1", "! Slack | general | Acme"), { dot: true });
  assert.equal(unreadFromTitle("https://app.slack.com/client/T1/C1", "Slack | general | Acme"), null);
  assert.deepEqual(unreadFromTitle("https://discord.com/channels/@me", "• Discord | Friends"), { dot: true });
  assert.deepEqual(unreadFromTitle("https://discord.com/channels/@me", "(12) Discord | Friends"), { count: 12 });
});

test("most sites put the count first in brackets", () => {
  assert.deepEqual(unreadFromTitle("https://x.com/home", "(5) Home / X"), { count: 5 });
  assert.deepEqual(unreadFromTitle("https://www.linkedin.com/feed/", "(9+) Feed | LinkedIn"), { count: 9 });
  assert.deepEqual(unreadFromTitle("https://web.whatsapp.com/", "(1) WhatsApp"), { count: 1 });
  // A dot needs a site that's known to use one: anywhere else a "*" is just the title.
  assert.equal(unreadFromTitle("https://example.com/", "* Example"), null);
  assert.equal(unreadFromTitle("https://example.com/", "Release notes (2026)"), null);
});

test("pages that aren't web pages have no count", () => {
  assert.equal(unreadFromTitle("bay://settings", "(3) Settings"), null);
  assert.equal(unreadFromTitle("", "(3) Nothing"), null);
  assert.equal(unreadFromTitle("https://x.com/home", ""), null);
});

test("the label caps at 999+", () => {
  assert.equal(unreadLabel(7), "7");
  assert.equal(unreadLabel(999), "999");
  assert.equal(unreadLabel(1000), "999+");
});
