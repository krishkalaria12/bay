import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceOf, DNS_PROVIDERS, validTemplate } from "./secureDns.ts";

test("a saved setting reads back as the choice that made it", () => {
  assert.equal(choiceOf({ mode: "automatic", templates: "" }), "automatic");
  assert.equal(choiceOf({ mode: "off", templates: "" }), "off");

  for (const p of DNS_PROVIDERS) assert.equal(choiceOf({ mode: "secure", templates: p.template }), p.id);
  assert.equal(choiceOf({ mode: "secure", templates: "https://dns.nextdns.io/abc123" }), "nextdns");
  assert.equal(choiceOf({ mode: "secure", templates: "https://doh.example/dns-query{?dns}" }), "custom");
});

test("a custom provider is an https template, with {?dns} if it has a variable", () => {
  assert.equal(validTemplate("https://doh.example/dns-query"), true);
  assert.equal(validTemplate("https://doh.example/dns-query{?dns}"), true);
  assert.equal(validTemplate("http://doh.example/dns-query"), false);
  assert.equal(validTemplate("https://doh.example/{query}"), false);
  assert.equal(validTemplate("doh.example"), false);
});
