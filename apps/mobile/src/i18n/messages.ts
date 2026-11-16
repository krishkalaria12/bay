import type { Locale } from "./locales.ts";

import { browser } from "./strings/browser.ts";
import { chrome } from "./strings/chrome.ts";
import { panels } from "./strings/panels.ts";
import { store } from "./strings/store.ts";

import { browserDe } from "./strings/browser.de.ts";
import { chromeDe } from "./strings/chrome.de.ts";
import { panelsDe } from "./strings/panels.de.ts";
import { storeDe } from "./strings/store.de.ts";

import { browserEs } from "./strings/browser.es.ts";
import { chromeEs } from "./strings/chrome.es.ts";
import { panelsEs } from "./strings/panels.es.ts";
import { storeEs } from "./strings/store.es.ts";

import { browserFr } from "./strings/browser.fr.ts";
import { chromeFr } from "./strings/chrome.fr.ts";
import { panelsFr } from "./strings/panels.fr.ts";
import { storeFr } from "./strings/store.fr.ts";

import { browserHi } from "./strings/browser.hi.ts";
import { chromeHi } from "./strings/chrome.hi.ts";
import { panelsHi } from "./strings/panels.hi.ts";
import { storeHi } from "./strings/store.hi.ts";

import { browserJa } from "./strings/browser.ja.ts";
import { chromeJa } from "./strings/chrome.ja.ts";
import { panelsJa } from "./strings/panels.ja.ts";
import { storeJa } from "./strings/store.ja.ts";

import { browserPtBR } from "./strings/browser.pt-BR.ts";
import { chromePtBR } from "./strings/chrome.pt-BR.ts";
import { panelsPtBR } from "./strings/panels.pt-BR.ts";
import { storePtBR } from "./strings/store.pt-BR.ts";

/**
 * Every locale's strings, flat and merged: the four slices in one record, so a lookup is a single map read. The
 * English entry is the one every other locale falls back to.
 */
export const CATALOG: Record<Locale, Record<string, string>> = {
  en: { ...browser, ...chrome, ...panels, ...store },
  es: { ...browserEs, ...chromeEs, ...panelsEs, ...storeEs },
  fr: { ...browserFr, ...chromeFr, ...panelsFr, ...storeFr },
  de: { ...browserDe, ...chromeDe, ...panelsDe, ...storeDe },
  "pt-BR": { ...browserPtBR, ...chromePtBR, ...panelsPtBR, ...storePtBR },
  ja: { ...browserJa, ...chromeJa, ...panelsJa, ...storeJa },
  hi: { ...browserHi, ...chromeHi, ...panelsHi, ...storeHi },
};

/** A message's key: every key of the English slices, which every other locale carries too. */
export type MessageKey = keyof typeof browser | keyof typeof chrome | keyof typeof panels | keyof typeof store;
