#!/usr/bin/env bun
import { takeLease } from "../src/lease.ts";
import { main } from "../src/cli.ts";

const lease = takeLease();
const status = await main(process.argv.slice(2));
await lease.release();
process.exit(status);
