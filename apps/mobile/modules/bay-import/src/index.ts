import { requireNativeModule } from "expo";

/** A file Bay can read, unpacked from an archive into the cache (or the chosen file itself). */
export interface ExportEntry {
  name: string;
  /** A file path, without a scheme. */
  path: string;
}

/** What a chosen file held. */
export interface ExportListing {
  files: ExportEntry[];
  /** Files left in the archive: passwords, cards, settings, anything that isn't bookmarks or history. */
  skipped: string[];
  /** Files Bay would read that are too large to. */
  tooLarge: string[];
}

/** Another browser on the phone (Android): its package, name and icon (a PNG data URL). */
export interface InstalledBrowser {
  id: string;
  name: string;
  icon: string;
}

interface BayImportModule {
  readExport(path: string): Promise<ExportListing>;
  discardExport(): Promise<void>;
  installedBrowsers(): Promise<InstalledBrowser[]>;
}

const native = requireNativeModule<BayImportModule>("BayImport");

/** Unpacks a chosen file: an archive's bookmark pages and history files, or the file itself when it isn't one. */
export const readExport = (path: string): Promise<ExportListing> => native.readExport(path);

/** Deletes what the last `readExport` unpacked. */
export const discardExport = (): Promise<void> => native.discardExport();

/** The browsers installed on an Android phone. Empty on iOS, where the app finds them by URL scheme. */
export const installedBrowsers = (): Promise<InstalledBrowser[]> => native.installedBrowsers();
