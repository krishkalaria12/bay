import { File, Paths } from "expo-file-system";

import { localeDocument, parseLocaleDocument } from "./document.ts";
import type { Locale } from "./locales.ts";

const FILE = "locale.json";

/** The saved language, or null when there is none or it can't be read. */
export async function readLocaleFile(): Promise<Locale | null> {
  const file = new File(Paths.document, FILE);

  if (!file.exists) return null;

  return parseLocaleDocument(await file.text());
}

/** Written to a temporary file first and moved over the old one, so a crash never leaves half a file. */
export async function writeLocaleFile(locale: Locale): Promise<void> {
  const draft = new File(Paths.document, `${FILE}.tmp`);

  await draft.write(localeDocument(locale));
  await draft.move(new File(Paths.document, FILE), { overwrite: true });
}

/** Forgets the saved language, so Bay follows the device's again. */
export function deleteLocaleFile(): void {
  const file = new File(Paths.document, FILE);

  if (file.exists) file.delete();
}
