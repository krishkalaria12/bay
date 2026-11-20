import * as v from "valibot";

/** A value read back from JSON: the only shapes `JSON.parse` can produce. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** A field read from an object that may not have it: the shapes JSON can produce, plus absence. */
export type JsonInput = JsonValue | undefined;

/** Narrows a value to the shape its caller checked. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The caller checks the value; this names the shape it checked.
export const checked = <T>(value: unknown): T => {
  // SAFETY: the caller checked the value against the shape `T` names.
  return value as T;
};

/** Whether a value is a string. */
export const isString = (value: JsonInput): value is string => v.is(v.string(), value);

/** Whether a value is a number. */
export const isNumber = (value: JsonInput): value is number => v.is(v.number(), value);

/** Whether a value is a boolean. */
export const isBoolean = (value: JsonInput): value is boolean => v.is(v.boolean(), value);

/** Whether a value is a plain object: JSON's own object shape, not an array. */
export const isJsonObject = (value: JsonInput): value is JsonObject => v.is(v.object({}), value) && !Array.isArray(value);

/** What a JSON value is: a "leaf" (null, a boolean, a finite number, a string), a "node" (an array or a plain object),
 *  or null when JSON can't hold it. It tells them apart without valibot, whose every failed check builds an issue: a
 *  runtime commit visits hundreds of thousands of values. */
export function jsonKind(value: JsonInput): "leaf" | "node" | null {
  if (value === null || value === true || value === false || Number.isFinite(value)) return "leaf";

  // A primitive: only a string is left that JSON can hold.
  if (Object(value) !== value) return String(value) === value ? "leaf" : null;

  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ? "node" : null;
}
