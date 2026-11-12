import * as v from "valibot";

import { LOCALE_IDS, type Locale } from "./locales.ts";

/**
 * The saved language, in a document of its own: the browsing model has no field for it, so the i18n module keeps its
 * own small file, in the same shape as the browsing state (one versioned JSON document).
 */
export interface LocaleDocument {
  version: 1;
  locale: Locale;
}

const DOCUMENT = v.object({ version: v.literal(1), locale: v.picklist(LOCALE_IDS) });

/** The locale a saved document names, or null when it names none Bay ships. */
export function parseLocaleDocument(text: string): Locale | null {
  let saved: unknown;

  try {
    saved = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = v.safeParse(DOCUMENT, saved);

  return parsed.success ? parsed.output.locale : null;
}

/** The document as it is written to disk. */
export function localeDocument(locale: Locale): string {
  const document: LocaleDocument = { version: 1, locale };

  return JSON.stringify(document);
}
