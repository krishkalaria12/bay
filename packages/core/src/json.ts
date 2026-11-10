import * as v from "valibot";

/** A value read back from JSON: the only shapes `JSON.parse` can produce. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** Plain objects only: arrays and the other object kinds are not JSON objects. */
export function isJsonObject(value: unknown): value is JsonObject {
  return v.is(v.object({}), value) && !Array.isArray(value);
}
