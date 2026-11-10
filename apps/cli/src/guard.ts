// `bay exec` never quits, crashes or reloads the browser: it is the user's own Bay.
import * as v from "valibot";
import { isString, type JsonValue } from "./util.ts";

const FORBIDDEN_METHODS = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]);

export class ForbiddenCommand extends Error {
  override name = "ForbiddenCommand";
}

// SAFETY: the lazy callback closes over this const and only runs at parse time; the union mirrors the JsonValue union exactly.
export const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([v.string(), v.number(), v.boolean(), v.null_(), v.array(JsonValueSchema), v.record(v.string(), JsonValueSchema)]),
) as v.GenericSchema<JsonValue>;

const JsonObjectSchema = v.record(v.string(), JsonValueSchema);

export function checkMethod(method: JsonValue): void {
  if (isString(method) && FORBIDDEN_METHODS.has(method)) {
    throw new ForbiddenCommand(`bay exec never sends ${method}: it's the user's browser`);
  }
}

export function checkCommand(command: JsonValue): void {
  const parsed = v.safeParse(JsonObjectSchema, command);

  if (parsed.success) checkMethod(parsed.output.method ?? null);
}

/** Every message the client sends is whole JSON, and none of its commands may stop Bay. */
export function checkMessage(message: string | Uint8Array): void {
  let text: string;

  if (message instanceof Uint8Array) text = new TextDecoder().decode(message);
  else text = message;
  let payload: JsonValue;

  try {
    // JSON.parse output is assignable directly: any JSON text is a JsonValue by construction.
    payload = JSON.parse(text);
  } catch {
    throw new ForbiddenCommand("bay exec only sends JSON commands");
  }

  if (Array.isArray(payload)) for (const command of payload) checkCommand(command);
  else checkCommand(payload);
}
