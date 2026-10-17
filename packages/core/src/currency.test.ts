import assert from "node:assert/strict";
import { test } from "node:test";
import { createCurrencyConverter, parseCurrency } from "./currency.ts";
import { buildSuggestions } from "./suggest.ts";

const response = (data: unknown, ok = true) => ({ ok, text: async () => JSON.stringify(data) });
const source = { tabs: [], history: [] };

test("currency syntax accepts codes, aliases, expressions, omitted amounts and conversion separators", () => {
  for (const text of ["100 usd in inr", "100 USD to INR", "(50 + 50) dollars → rupees", "100usd into ₹"]) {
    const query = parseCurrency(text)!;
    assert.equal(query.amount, 100, text);
    assert.equal(query.from, "USD");
    assert.equal(query.to, "INR");
  }
  assert.equal(parseCurrency("eur to usd")?.amount, 1);
  for (const text of ["5 kg in lb", "350 f to c", "100 usdx in inr", "100 usd in constructor", "1.2.3 usd in inr", "1/0 usd in inr", "?100 usd in inr"]) {
    assert.equal(parseCurrency(text), null, text);
  }
});

test("dated currency answers lead the suggestions, while stale query answers and scoped/forced searches are excluded", async () => {
  const convert = createCurrencyConverter({ fetch: async () => response({ rates: { INR: 83 }, date: "2026-10-15" }) });
  const currency = await convert("100 usd in inr");
  assert.equal(currency?.value, 8300);
  assert.match(currency!.detail, /Frankfurter.*2026-10-15/);
  const result = buildSuggestions("100 usd in inr", source, { currency });
  assert.equal(result.items[0]?.kind, "calc");
  assert.equal(result.completion, "");
  if (result.items[0]?.kind === "calc") assert.equal(result.items[0].value, currency!.display);
  for (const query of ["200 usd in inr", "?100 usd in inr", "example.com"]) {
    assert.ok(!buildSuggestions(query, source, { currency }).items.some((item) => item.kind === "calc"));
  }
  const scope = { kind: "history" as const, name: "History", host: "", prefix: "history", url: "" };
  assert.ok(!buildSuggestions("100 usd in inr", source, { currency, scope }).items.some((item) => item.kind === "calc"));
});

test("currency rates are deduplicated per pair, reused for new amounts, and refreshed after expiry", async () => {
  let calls = 0;
  let time = 0;
  const convert = createCurrencyConverter({
    now: () => time,
    ttl: 100,
    fetch: async () => {
      calls++;
      return response({ rates: { INR: 80 }, date: "2026-10-15" });
    },
  });
  const [a, b] = await Promise.all([convert("100 usd in inr"), convert("200 usd in inr")]);
  assert.equal(calls, 1);
  assert.equal(a?.value, 8000);
  assert.equal(b?.value, 16000);
  assert.equal((await convert("1 usd in inr"))?.value, 80);
  assert.equal(calls, 1);
  time = 101;
  await convert("1 usd in inr");
  assert.equal(calls, 2);
});

test("providers fall back on invalid responses and failures never produce static or expired rates", async () => {
  const urls: string[] = [];
  let offline = false;
  const convert = createCurrencyConverter({
    ttl: 0,
    fetch: async (url) => {
      urls.push(url);
      if (offline) throw new Error("offline");
      if (url.includes("frankfurter")) return response({ rates: { INR: -80 }, date: "2026-10-15" });
      if (url.includes("er-api")) return response({ rates: { INR: 0 }, time_last_update_unix: 1792022400 });
      return response({ usd: { inr: 80 }, date: "2026-10-15" });
    },
  });
  const answer = await convert("100 usd in inr");
  assert.equal(answer?.value, 8000);
  assert.match(answer!.detail, /Fawaz Ahmed/);
  assert.equal(urls.length, 3);
  offline = true;
  assert.equal(await convert("100 usd in inr"), null);
  assert.equal(urls.length, 6);
});

test("same currency needs no network, and malformed or non-finite results are rejected", async () => {
  let calls = 0;
  const convert = createCurrencyConverter({
    fetch: async () => {
      calls++;
      throw new Error("offline");
    },
  });
  assert.equal((await convert("100 eur in eur"))?.value, 100);
  assert.equal(await convert("ordinary web search"), null);
  assert.equal(calls, 0);
  const overflow = createCurrencyConverter({ fetch: async () => response({ rates: { INR: 1e100 }, date: "2026-10-15" }) });
  assert.equal(await overflow("1e300 usd in inr"), null);
  for (const data of [null, [], { rates: { INR: 90 } }, { rates: { INR: 90 }, date: "2026-99-99" }, { rates: { INR: "90" }, date: "2026-10-15" }]) {
    const invalid = createCurrencyConverter({ fetch: async () => response(data) });
    assert.equal(await invalid("100 usd in inr"), null);
  }
});

test("emoji and unit answers are top rows and forced search stays a search", () => {
  const emoji = buildSuggestions("emoji heart", source);
  assert.deepEqual(emoji.items[0], { kind: "emoji", value: "❤️", name: "red heart" });
  for (const query of ["5 km in mi", "350 f to c", "2 + 2"]) {
    assert.equal(buildSuggestions(query, source).items[0]?.kind, "calc");
    assert.equal(buildSuggestions(`?${query}`, source).items[0]?.kind, "search");
  }
  assert.equal(buildSuggestions("?emoji heart", source).items[0]?.kind, "search");
});

test("disabling calculator hides arithmetic, units and currency while emoji search stays available", () => {
  const currency = { expression: "100 usd in inr", value: 8300, display: "₹8,300", detail: "USD → INR · Frankfurter · 2026-10-15" };
  for (const query of ["2 + 2", "5 km in mi", "100 usd in inr"]) {
    const result = buildSuggestions(query, source, { calculatorEnabled: false, currency });
    assert.ok(!result.items.some((item) => item.kind === "calc"), query);
    assert.equal(result.items[0]?.kind, "search");
  }
  assert.equal(buildSuggestions("emoji heart", source, { calculatorEnabled: false }).items[0]?.kind, "emoji");
  assert.equal(buildSuggestions("2 + 2", source, { calculatorEnabled: true }).items[0]?.kind, "calc");
});
