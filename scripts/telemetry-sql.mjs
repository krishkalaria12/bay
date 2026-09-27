#!/usr/bin/env node
// Runs one read-only ClickHouse query against Bay's telemetry and prints the rows as TSV.
// usage: node scripts/telemetry-sql.mjs "SELECT event, count() FROM telemetry.events GROUP BY event"
// Tables and example queries, with the read-only user's access.
import { clickhouse } from "./telemetry-env.mjs";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('usage: node scripts/telemetry-sql.mjs "<query>"');
  process.exit(2);
}
for (const row of await clickhouse(query)) {
  console.log(row.map((v) => (typeof v === "object" ? JSON.stringify(v) : v)).join("\t"));
}
