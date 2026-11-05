import assert from "node:assert/strict";
import { test } from "node:test";
import { followOnboardingRequests, requestOnboarding, useOnboardingRequest } from "./onboardingRequest.ts";

const reset = () => useOnboardingRequest.setState({ windowId: null, step: "intro", picked: {}, session: 0 });

test("a window starts onboarding once, for a request naming it", () => {
  reset();
  const started = [];
  const stop = followOnboardingRequests("w1", ({ step }) => started.push(step));
  requestOnboarding("w2", "intro", {});
  assert.deepEqual(started, []);
  requestOnboarding("w1", "search", {});
  assert.deepEqual(started, ["search"]);
  // The coordinator republishes its service state, which installs the same request again.
  useOnboardingRequest.setState({ ...useOnboardingRequest.getState() }, true);
  assert.deepEqual(started, ["search"]);
  stop();
});

test("a window that loads after the request still starts", () => {
  reset();
  requestOnboarding("w1", "intro", {});
  const started = [];
  const stop = followOnboardingRequests("w1", ({ step }) => started.push(step));
  assert.deepEqual(started, ["intro"]);
  stop();
});
