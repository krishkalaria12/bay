import * as v from "valibot";

/** A value read back from JSON: the only shapes `JSON.parse` can produce. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** A field read from an object that may not have it: the shapes `JSON.parse` can produce, plus absence. */
export type JsonInput = JsonValue | undefined;

// SAFETY: the union mirrors JsonValue exactly; the cast only teaches inference the recursive shape.
export const JsonValueSchema: v.GenericSchema<JsonValue> = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null_(),
  v.lazy(() => v.array(JsonValueSchema)),
  v.lazy(() => v.record(v.string(), JsonValueSchema)),
]) as v.GenericSchema<JsonValue>;

/** A value read back from JSON, or null when the document isn't JSON at all. */
export function parseJson(text: string): JsonValue | null {
  let value: JsonValue;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = v.safeParse(JsonValueSchema, value);

  return parsed.success ? parsed.output : null;
}

export function isJsonObject(value: JsonInput): value is JsonObject {
  return v.is(v.object({}), value) && !Array.isArray(value);
}
