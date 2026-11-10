import { evaluate } from "./calculator.ts";
import type { FetchLike } from "./suggestFetcher.ts";
import { FIAT_ALIASES, FIAT_CURRENCIES, resolveFiat } from "./vendor/supercalculator/currencies.ts";
import * as v from "valibot";

export type CurrencyQuery = { expression: string; amount: number; from: string; to: string };

export type CurrencyAnswer = { expression: string; value: number; display: string; detail: string };

type Rate = { value: number; date: string; source: string };

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

// SAFETY: the lazy callback closes over this const and only runs at parse time; the union mirrors the JsonValue union exactly.
const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([v.string(), v.number(), v.boolean(), v.null_(), v.array(JsonValueSchema), v.record(v.string(), JsonValueSchema)]),
) as v.GenericSchema<JsonValue>;

const JsonObjectSchema = v.record(v.string(), JsonValueSchema);

/** Parses an untrusted rates payload; anything non-object yields {} so provider lookups miss and fall back. */
function asObject(value: JsonValue | undefined): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, value);

  return parsed.success ? parsed.output : {};
}

const aliases = [...Object.keys(FIAT_CURRENCIES), ...FIAT_ALIASES.keys()]
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
  .join("|");

const sourceCurrency = new RegExp(`^(.*?)\\s*(${aliases})$`, "i");

export function parseCurrency(raw: string): CurrencyQuery | null {
  const expression = raw.trim().replace(/^=\s*/, "");

  if (expression.length > 200) return null;
  const parts = /^(.*?)\s+(?:to|in|into|as|=|->|→)\s+(.+)$/i.exec(expression);

  if (!parts) return null;
  const source = sourceCurrency.exec(parts[1]!);
  const to = resolveFiat(parts[2]!.trim());
  const from = source && resolveFiat(source[2]!);

  if (!source || !from || !to) return null;
  const amount = source[1]!.trim() ? evaluate(source[1]!) : 1;

  return amount === null ? null : { expression, amount, from, to };
}

function rate(value: JsonValue | undefined, date: JsonValue | undefined, source: string): Rate {
  if (!v.is(v.number(), value) || !Number.isFinite(value) || value <= 0 || !v.is(v.string(), date) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid exchange rate");
  }

  const parsed = new Date(date);

  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Invalid rate date");

  return { value, date, source };
}

// Adapted from SuperCalculator's fiat providers. Cache only verified, dated rates;
// failed requests never fall back to the upstream hardcoded exchange rates.
export function createCurrencyConverter({ fetch, now = Date.now, ttl = 3_600_000 }: { fetch: FetchLike; now?: () => number; ttl?: number }) {
  const cache = new Map<string, { rate: Rate; expires: number }>();
  const pending = new Map<string, Promise<Rate>>();

  const json = async (url: string): Promise<JsonObject> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) throw new Error("Exchange rates unavailable");

      const parsed = v.safeParse(JsonObjectSchema, JSON.parse(await response.text()));

      if (!parsed.success) throw new Error("Exchange rates unavailable");

      return parsed.output;
    } finally {
      clearTimeout(timer);
    }
  };

  const load = async (from: string, to: string): Promise<Rate> => {
    const providers = [
      async () => {
        const data = await json(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`);

        return rate(asObject(data.rates)[to], data.date, "Frankfurter");
      },
      async () => {
        const data = await json(`https://open.er-api.com/v6/latest/${from}`);
        const timestamp = data.time_last_update_unix;
        const date = v.is(v.number(), timestamp) && Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString().slice(0, 10) : "";

        return rate(asObject(data.rates)[to], date, "ExchangeRate-API");
      },
      async () => {
        const base = from.toLowerCase();
        const data = await json(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.json`);

        return rate(asObject(data[base])[to.toLowerCase()], data.date, "Fawaz Ahmed");
      },
    ];

    for (const provider of providers) {
      try {
        return await provider();
      } catch {
        // Try the next live source.
      }
    }

    throw new Error("Exchange rates unavailable");
  };

  const getRate = (from: string, to: string): Promise<Rate> => {
    const key = `${from}/${to}`;
    const cached = cache.get(key);

    if (cached && cached.expires > now()) return Promise.resolve(cached.rate);
    const existing = pending.get(key);

    if (existing) return existing;

    const request = load(from, to)
      .then((result) => {
        cache.delete(key);
        cache.set(key, { rate: result, expires: now() + ttl });

        if (cache.size > 32) cache.delete(cache.keys().next().value!);

        return result;
      })
      .finally(() => pending.delete(key));

    pending.set(key, request);

    return request;
  };

  return async (raw: string): Promise<CurrencyAnswer | null> => {
    const query = parseCurrency(raw);

    if (!query) return null;

    try {
      const exchange = query.from === query.to ? null : await getRate(query.from, query.to);
      const value = query.amount * (exchange?.value ?? 1);

      if (!Number.isFinite(value)) return null;
      const display = new Intl.NumberFormat("en-US", { style: "currency", currency: query.to, maximumSignificantDigits: 10 }).format(value);

      return {
        expression: query.expression,
        value,
        display,
        detail: exchange ? `${query.from} → ${query.to} · ${exchange.source} · ${exchange.date}` : query.to,
      };
    } catch {
      return null;
    }
  };
}
