// What opens by itself when it finishes downloading (src/browser/downloads.ts).
import assert from "node:assert/strict";
import test from "node:test";

import { opensWhenFinished } from "../src/browser/downloads.ts";

test("a Wallet pass and a calendar invitation open as soon as they arrive", () => {
  assert.ok(opensWhenFinished("boarding.pkpass"));
  assert.ok(opensWhenFinished("Tickets.PKPASSES"));
  assert.ok(opensWhenFinished("meeting.ics"));
  assert.ok(!opensWhenFinished("report.pdf"));
  assert.ok(!opensWhenFinished("ics"));
});
