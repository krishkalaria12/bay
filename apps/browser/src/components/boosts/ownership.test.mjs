import assert from "node:assert/strict";
import { test } from "node:test";
import { docs } from "@bay/shell";
import { installServiceClient } from "../../runtime/serviceClient.ts";
import { addBoost, boostsAvailable, createBoost, ensureBoostsLoaded, setBoostsOn, startBoosts, useBoosts } from "./state.ts";
import { libraryAvailable } from "../library/availability.ts";
import { createEasel, startLibrary, useLibrary } from "../library/state.ts";
import { newBoost } from "../../lib/boosts.ts";

test("remote windows cannot start feature persistence, style timers or unsupported mutations", () => {
  const stopClient = installServiceClient(async () => null);
  const before = useBoosts.getState();
  const disk = [...docs];
  const timeout = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = () => {
    timers++;
    throw new Error("a remote feature started a timer");
  };
  try {
    assert.equal(boostsAvailable(), false);
    assert.equal(libraryAvailable(), false);
    ensureBoostsLoaded();
    startBoosts();
    assert.equal(createBoost("example.com"), null);
    addBoost(newBoost("remote", "example.com", 1));
    setBoostsOn(false);
    assert.equal(useBoosts.getState(), before);
    startLibrary();
    assert.equal(createEasel("default"), null);
    assert.match(useLibrary.getState().error, /not available/);
    assert.deepEqual([...docs], disk);
    assert.equal(timers, 0);
  } finally {
    globalThis.setTimeout = timeout;
    stopClient();
  }
});
