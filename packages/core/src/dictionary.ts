/**
 * Read `key` from a dictionary, treating a missing key as `undefined`. `Object.hasOwn` keeps a lookup such as
 * `table["toString"]` from falling through to `Object.prototype`.
 */
export function lookup<Value>(table: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
