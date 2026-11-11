#!/usr/bin/env bun
// The bay command. Bun's runtime runs it: Ctrl-C (or SIGTERM) interrupts the command, its resources close — the
// connection to Bay, a test tab, the scripts store's lock, the lease on this installed version — and it exits 130.
import { BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import { program, statusOf } from "../src/cli.ts";
import { leased } from "../src/lease.ts";

const command = Effect.scoped(Effect.andThen(leased, program(process.argv.slice(2))));

BunRuntime.runMain(command, {
  disableErrorReporting: true,
  teardown: (exit, onExit) => onExit(statusOf(exit)),
});
