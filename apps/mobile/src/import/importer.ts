/**
 * Choosing and reading another browser's export. The picked file is unpacked natively (only bookmark pages and
 * history files come out), read here, and deleted again however the read ends, so nothing an export held is kept
 * outside what the user imports.
 */
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import { ImportFiles, type ImportFilesError } from "../effect/ports/importFiles.ts";
import { exportNotes, type ExportNotes } from "./apply.ts";
import { androidBrowsers, IOS_BROWSERS, iosBrowsers, type PhoneBrowser } from "./browsers.ts";
import { readExport, type ExportContents } from "./exports.ts";

/** A file Bay can't import: nothing in it is bookmarks or history, or what did was too large to read. */
export class NothingToImport extends TaggedError("NothingToImport")<{
  readonly name: string;
  readonly tooLarge: boolean;
}> {}

/** A chosen export, read and ready to review. */
export interface ChosenExport {
  /** The chosen file's name. */
  name: string;
  contents: ExportContents;
  notes: ExportNotes;
}

/** Lets the user choose an export and reads it. Null when the picker was dismissed. */
export const chooseExport: Effect.Effect<ChosenExport | null, ImportFilesError | NothingToImport, ImportFiles> = Effect.gen(function* () {
  const files = yield* ImportFiles;
  const picked = yield* files.pick();

  if (!picked) return null;

  return yield* Effect.gen(function* () {
    const listing = yield* files.unpack(picked.path);
    const notes = exportNotes(listing);
    // One file at a time: a Takeout archive's history alone can be tens of megabytes.
    const texts = yield* Effect.forEach(listing.files, (file) => Effect.map(files.readText(file.path), (text) => ({ name: file.name, text })));

    // readExport throws only when not one file held bookmarks or history.
    const contents = yield* Effect.try({
      try: () => readExport(texts),
      catch: () => new NothingToImport({ name: picked.name, tooLarge: notes.tooLarge.length > 0 }),
    });

    return { name: picked.name, contents, notes };
  }).pipe(Effect.ensuring(files.discard(picked)));
});

/** The browsers on this phone. A failed look lists none, and the sheet still offers every way in. */
export const phoneBrowsers = (os: "ios" | "android"): Effect.Effect<PhoneBrowser[], never, ImportFiles> =>
  Effect.gen(function* () {
    const files = yield* ImportFiles;

    if (os === "android") return androidBrowsers(yield* files.androidBrowsers().pipe(Effect.orElseSucceed(() => [])));
    const answered = yield* Effect.forEach(IOS_BROWSERS, (browser) => files.canOpen(browser.url), { concurrency: "unbounded" });

    return iosBrowsers(answered);
  });
