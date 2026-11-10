import * as v from "valibot";
import { isSharing, queueLog } from "./client";
import { MAX_DISTINCT_LOGS } from "./config";
import { errorType, scrubText } from "./sanitize";

const seen = new Set<string>();

export function recordLog(level: "warn" | "error", args: unknown[]) {
  if (!isSharing()) return;
  const first = args[0];

  if (!v.is(v.string(), first)) return;
  const message = scrubText(first, 160);

  if (!message || seen.has(message) || seen.size >= MAX_DISTINCT_LOGS) return;
  seen.add(message);
  const error = args.slice(1).find((a) => a instanceof Error);
  queueLog(level, message, { error_type: error ? errorType(error) : "none" });
}
