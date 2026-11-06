import * as v from "valibot";

// Deep JSON validator for untrusted sync payloads: strings, numbers, booleans, null, arrays and string-keyed
// records of those, recursively.
// SAFETY: the schema is deliberately self-describing; every branch accepts only JSON-shaped values.
export const JsonValueSchema: v.GenericSchema<JsonValue> = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null_(),
  v.lazy(() => v.array(JsonValueSchema)),
  v.lazy(() => v.record(v.string(), JsonValueSchema)),
  // SAFETY: the union above is exactly JsonValue by construction; the cast only exposes that to inference.
]) as v.GenericSchema<JsonValue>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface SortedJsonObject {
  [key: string]: JsonValue;
}

const isJsonObject = (value: JsonValue): value is SortedJsonObject => v.is(v.object({}), value) && !Array.isArray(value);

export function canonical(value: JsonValue): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);

  if (isJsonObject(value)) {
    const out: SortedJsonObject = {};

    for (const key of Object.keys(value).sort()) {
      const entry = value[key];

      if (entry !== undefined) out[key] = sortKeys(entry);
    }

    return out;
  }

  return value;
}
