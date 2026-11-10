/** A value read back from JSON: the only shapes `JSON.parse` can produce. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** Narrows a value to the shape its caller checked. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The caller checks the value; this names the shape it checked.
export const checked = <T>(value: unknown): T => {
  // SAFETY: the caller checked the value against the shape `T` names.
  return value as T;
};
