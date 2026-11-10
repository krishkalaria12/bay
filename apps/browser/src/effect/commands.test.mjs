// The command boundary (effect/commands.ts): how a native callback or a UI handler reads the answer to the work it
// handed to the runtime.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { readCommandExit, runCommandResult } = await import("./commands.ts");
const { fakeDiagnostics } = await import("./testing.ts");

const operation = { name: "test.command" };

test("a command that worked hands back its value", async () => {
  const diagnostics = fakeDiagnostics();
  const runtime = ManagedRuntime.make(diagnostics.layer);

  const result = await runtime.runPromise(readCommandExit(operation, Exit.succeed(42)));

  assert.equal(result._tag, "Done");
  assert.equal(result.value, 42);
  assert.equal(diagnostics.reports.length, 0);
});

test("a command that failed is reported once, with the operation that failed", async () => {
  const diagnostics = fakeDiagnostics();
  const runtime = ManagedRuntime.make(diagnostics.layer);

  const result = await runtime.runPromise(readCommandExit(operation, Exit.fail(new Error("boom"))));

  assert.equal(result._tag, "Failed");
  assert.equal(result.error.message, "boom");
  assert.equal(diagnostics.reports.length, 1);
  assert.equal(diagnostics.reports[0].operation.name, "test.command");
  assert.equal(diagnostics.reports[0].message, "boom");
});

test("a command that was cancelled is not a failure, and nothing is reported", async () => {
  const diagnostics = fakeDiagnostics();
  const runtime = ManagedRuntime.make(diagnostics.layer);

  const exit = await Effect.runPromiseExit(Effect.interrupt);
  const result = await runtime.runPromise(readCommandExit(operation, exit));

  assert.equal(result._tag, "Cancelled");
  assert.equal(diagnostics.reports.length, 0);
});

test("the app's runtime answers a command that worked", async () => {
  const result = await runCommandResult(operation, Effect.succeed("done"));

  assert.equal(result._tag, "Done");
  assert.equal(result.value, "done");
});

test("the app's runtime answers a command that failed", async () => {
  const result = await runCommandResult(operation, Effect.fail(new Error("nope")));

  assert.equal(result._tag, "Failed");
  assert.equal(result.error.message, "nope");
});
