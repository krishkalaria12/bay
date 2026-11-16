/** The locales Bay ships. English is first: it is what every other locale falls back to. */
export const LOCALE_IDS = ["en", "es", "fr", "de", "pt-BR", "ja", "hi"] as const;

export type Locale = (typeof LOCALE_IDS)[number];

/** The locale a missing translation falls back to. */
export const DEFAULT_LOCALE: Locale = "en";

/** Each language in its own name, so a reader finds their own in the list. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  "pt-BR": "Português (Brasil)",
  ja: "日本語",
  hi: "हिन्दी",
};

/** Languages that ship one variant: a region on the device doesn't change them. */
const LANGUAGE_LOCALES: readonly Locale[] = ["en", "es", "fr", "de", "ja", "hi"];

/** Portuguese ships one variant, so its region is what decides. */
const PORTUGUESE = "pt";
const BRAZIL = "br";

/**
 * The shipped locale a device tag names. An unknown language stays English, and Portuguese is told apart by its
 * region, so pt-PT doesn't slip into pt-BR.
 */
export function matchLocale(tag: string | undefined | null): Locale {
  const normalized = (tag ?? "").trim().replace(/_/g, "-").toLowerCase();

  if (!normalized) return DEFAULT_LOCALE;

  const exact = LOCALE_IDS.find((locale) => locale.toLowerCase() === normalized);

  if (exact) return exact;

  const [language = "", ...rest] = normalized.split("-");
  const region = rest.find((part) => part.length === 2 || /^\d{3}$/.test(part));

  if (language === PORTUGUESE) return !region || region === BRAZIL ? "pt-BR" : DEFAULT_LOCALE;

  return LANGUAGE_LOCALES.find((locale) => locale === language) ?? DEFAULT_LOCALE;
}
