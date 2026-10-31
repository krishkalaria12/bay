import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

export class ArgumentError extends Error {}

export function parseArguments<const T extends ParseArgsOptionsConfig>(args: string[], options: T, maxPositionals = 0) {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    if (parsed.positionals.length > maxPositionals) {
      throw new ArgumentError(`unexpected argument: ${parsed.positionals[maxPositionals]}`);
    }
    return parsed;
  } catch (error) {
    throw new ArgumentError(error instanceof Error ? error.message : String(error));
  }
}

export function numericOption(value: string | undefined, flag: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number) || number < 0 || (flag === "--port" && (!Number.isInteger(number) || number < 1 || number > 65535))) {
    throw new ArgumentError(`${flag} must be ${flag === "--port" ? "an integer between 1 and 65535" : "a finite, nonnegative number"}`);
  }
  return number;
}
