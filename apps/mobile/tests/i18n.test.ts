import assert from "node:assert/strict";
import test from "node:test";

import { LOCALE_IDS, matchLocale } from "../src/i18n/locales.ts";
import { CATALOG } from "../src/i18n/messages.ts";

const english = CATALOG.en;
const englishKeys = Object.keys(english).sort();

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

test("the catalog holds every shipped locale", () => {
  assert.deepEqual(Object.keys(CATALOG).sort(), [...LOCALE_IDS].sort());
});

for (const locale of LOCALE_IDS) {
  const strings = CATALOG[locale];

  test(`${locale} has exactly the English keys`, () => {
    assert.deepEqual(Object.keys(strings).sort(), englishKeys);
  });

  test(`${locale} keeps the English placeholders`, () => {
    for (const key of englishKeys) {
      assert.deepEqual(placeholders(strings[key] ?? ""), placeholders(english[key] ?? ""), `${locale}: ${key}`);
    }
  });

  test(`${locale} has no empty translation`, () => {
    for (const key of englishKeys) {
      assert.ok((strings[key] ?? "").trim().length > 0, `${locale}: ${key}`);
    }
  });
}

test("matchLocale maps device tags to shipped locales", () => {
  assert.equal(matchLocale("pt-PT"), "en");
  assert.equal(matchLocale("pt"), "pt-BR");
  assert.equal(matchLocale("pt-BR"), "pt-BR");
  assert.equal(matchLocale("pt_BR"), "pt-BR");
  assert.equal(matchLocale("fr-CA"), "fr");
  assert.equal(matchLocale("zh"), "en");
  assert.equal(matchLocale(undefined), "en");
});
