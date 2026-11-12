import { useSyncExternalStore } from "react";
import * as v from "valibot";

import { CATALOG, type MessageKey } from "./messages.ts";
import { DEFAULT_LOCALE, matchLocale, type Locale } from "./locales.ts";

export { DEFAULT_LOCALE, LOCALE_IDS, LOCALE_NAMES, matchLocale, type Locale } from "./locales.ts";

export { type MessageKey } from "./messages.ts";

/** The values a message's placeholders are filled from: `{name}` in the text, `name` here. */
export type MessageParams = Record<string, string | number>;

/** A message in one language, with English behind it; what `useT` hands a component. */
export type Translate = (key: MessageKey, params?: MessageParams) => string;

// The chosen language, until the saved document says otherwise. The device's own language is the first guess.
let chosen: Locale = matchLocale(intlTag());

// The language the user picked in Settings, or null while Bay follows the device.
let saved: Locale | null = null;

// Set once the user picks a language, so a slow read of the saved one can't undo the pick.
let picked = false;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function choose(locale: Locale): void {
  if (locale === chosen) return;

  chosen = locale;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** The language Bay is showing now. */
export function currentLocale(): Locale {
  return chosen;
}

/** The language the user picked, or null while Bay follows the device. */
export function savedLocale(): Locale | null {
  return saved;
}

/**
 * Shows the app in another language and keeps that choice for the next launch. Null follows the device's language
 * again and forgets the saved one.
 */
export function setLocale(locale: Locale | null): void {
  picked = true;

  if (saved !== locale) {
    saved = locale;
    notify();
  }

  choose(locale ?? matchLocale(intlTag()));
  persist(locale);
}

/** Reads the saved language, or the device's own when there is none. Call it once, when the app starts. */
export async function loadLocale(): Promise<void> {
  const stored = await readLocale();

  if (picked) return;

  if (stored) {
    saved = stored;
    notify();
  }

  choose(stored ?? (await detectLocale()));
}

/** Follows a change of the device's language while Bay runs; a language picked in Settings stays. */
export function refreshDeviceLocale(): void {
  if (saved === null) choose(matchLocale(intlTag()));
}

/** The device's own language, matched onto one Bay ships. */
export async function detectLocale(): Promise<Locale> {
  return matchLocale(await deviceTag());
}

/** The language Bay is showing; the component renders again when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, currentLocale, currentLocale);
}

/** The language the user picked, or null while Bay follows the device. */
export function useSavedLocale(): Locale | null {
  return useSyncExternalStore(subscribe, savedLocale, savedLocale);
}

const translators = new Map<Locale, Translate>();

/**
 * `t` for a component: it renders again when the language changes, and the function itself changes with the
 * language, so memoised work that depends on it runs again too.
 */
export function useT(): Translate {
  const locale = useLocale();
  let translate = translators.get(locale);

  if (!translate) {
    translate = (key, params) => lookup(locale, key, params);
    translators.set(locale, translate);
  }

  return translate;
}

/**
 * A message in the current language, with English behind it when the translation is missing. `{name}` in the text is
 * replaced by the value `params` carries under that name.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  return lookup(chosen, key, params);
}

function lookup(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const value = CATALOG[locale][key] ?? CATALOG[DEFAULT_LOCALE][key] ?? key;

  return params ? interpolate(value, params) : value;
}

/**
 * The locale numbers and dates are written in: the device's own tag when it speaks the language Bay shows, so a
 * British phone in English keeps its 24-hour clock, and the shown language otherwise.
 */
function formattingLocale(): string {
  const device = intlTag();

  return device && matchLocale(device) === chosen ? device : chosen;
}

/** A number in the current language's way of writing it. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(formattingLocale(), options).format(value);
}

/** A date in the current language's way of writing it. */
export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);

  return new Intl.DateTimeFormat(formattingLocale(), options).format(date);
}

const PLACEHOLDER = /\{(\w+)\}/g;

function interpolate(value: string, params: MessageParams): string {
  return value.replace(PLACEHOLDER, (match: string, name: string) => {
    const found = params[name];

    return found === undefined ? match : String(found);
  });
}

/** The device's language tag as Intl reports it, or an empty string when Intl can't say. */
function intlTag(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "";
  }
}

/** The device's language tag: Intl knows it, and the platform's own modules are the fallback. */
async function deviceTag(): Promise<string> {
  const fromIntl = intlTag();

  if (fromIntl) return fromIntl;

  try {
    const { NativeModules } = await import("react-native");
    const native = v.safeParse(NATIVE_LOCALE, NativeModules);

    if (!native.success) return "";

    return native.output.I18nManager?.localeIdentifier ?? native.output.SettingsManager?.settings?.AppleLocale ?? "";
  } catch {
    return "";
  }
}

const NATIVE_LOCALE = v.object({
  I18nManager: v.optional(v.object({ localeIdentifier: v.string() })),
  SettingsManager: v.optional(v.object({ settings: v.optional(v.object({ AppleLocale: v.string() })) })),
});

async function readLocale(): Promise<Locale | null> {
  try {
    const files = await import("./files.ts");

    return await files.readLocaleFile();
  } catch (cause) {
    console.warn("Couldn't read the saved language.", cause);

    return null;
  }
}

// One write at a time, in the order they were asked for: two writing the same temporary file at once lose one.
let writing: Promise<void> = Promise.resolve();

function persist(locale: Locale | null): void {
  writing = writing
    .then(async () => {
      const files = await import("./files.ts");

      if (locale) await files.writeLocaleFile(locale);
      else files.deleteLocaleFile();
    })
    .catch((cause: unknown) => console.warn("Couldn't save the chosen language.", cause));
}
