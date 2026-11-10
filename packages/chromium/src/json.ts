/** A value read back from JSON: the only shapes `JSON.parse` can produce. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}
