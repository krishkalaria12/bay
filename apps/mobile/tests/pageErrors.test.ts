import assert from "node:assert/strict";
import test from "node:test";

import { describePageError } from "../src/browser/pageErrors.ts";

test("names common load failures on both engines", () => {
  assert.equal(describePageError("net::ERR_INTERNET_DISCONNECTED").kind, "offline");
  assert.equal(describePageError("The Internet connection appears to be offline.").kind, "offline");
  assert.equal(describePageError("net::ERR_NAME_NOT_RESOLVED").title, "Can't find this site");
  assert.equal(describePageError("A server with the specified hostname could not be found.").title, "Can't find this site");
  assert.equal(describePageError("net::ERR_CONNECTION_TIMED_OUT").title, "This site took too long");
  assert.deepEqual(describePageError("Something odd"), { kind: "error", title: "Can't open this page", detail: "Something odd" });
});
