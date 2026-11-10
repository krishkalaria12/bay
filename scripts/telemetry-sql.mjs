#!/usr/bin/env node
// Runs one read-only ClickHouse query against Bay's telemetry and prints the rows as TSV.
// usage: node scripts/telemetry-sql.mjs "SELECT event, count() FROM telemetry.events GROUP BY event"
// Tables and example queries, with the read-only user's access.
import * as v from "valibot";
import { clickhouse } from "./telemetry-env.mjs";

// Row values arrive as parsed JSON: objects and arrays print as JSON, scalars (null included) as they are.
const isStructure = (value) => v.is(v.union([v.instance(Object), v.null_()]), value);

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error('usage: node scripts/telemetry-sql.mjs "<query>"');
  process.exit(2);
}

for (const row of await clickhouse(query)) {
  console.log(row.map((cell) => (isStructure(cell) ? JSON.stringify(cell) : cell)).join("\t"));
}
