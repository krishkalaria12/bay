// What importing from another browser needs from the phone: the system's file picker, the native module that unpacks
// an export (modules/bay-import), the files it unpacked, and which other browsers are installed. The native modules
// are loaded inside the calls, so this file stays importable where Expo is not.
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ExportListing, InstalledBrowser } from "@bay/mobile-import";
import type { Operation } from "../errors.ts";

export type { ExportListing, InstalledBrowser };

/** A file the user chose: where its copy in the cache is, and what it was called. */
export type PickedFile = {
  readonly path: string;
  readonly name: string;
};

/** A file that could not be chosen, unpacked or read. */
export class ImportFilesError extends TaggedError("ImportFilesError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

const attempt = <A>(operation: Operation, use: () => Promise<A>) =>
  Effect.tryPromise({ try: use, catch: (cause) => new ImportFilesError({ operation, cause }) });

/** A file path as the URI expo-file-system opens it by. */
const fileUri = (path: string) => (path.startsWith("file://") ? path : `file://${encodeURI(path)}`);

export class ImportFiles extends Context.Service<
  ImportFiles,
  {
    /** Shows the system's file picker. Null when it was dismissed. */
    readonly pick: () => Effect.Effect<PickedFile | null, ImportFilesError>;
    /** Unpacks a chosen file: an archive's bookmark pages and history files, or the file itself. */
    readonly unpack: (path: string) => Effect.Effect<ExportListing, ImportFilesError>;
    /** Reads an unpacked file. */
    readonly readText: (path: string) => Effect.Effect<string, ImportFilesError>;
    /** Deletes what was unpacked and the picker's copy of the chosen file. Never fails. */
    readonly discard: (picked: PickedFile | null) => Effect.Effect<void>;
    /** The browsers installed on an Android phone. Empty on iOS. */
    readonly androidBrowsers: () => Effect.Effect<readonly InstalledBrowser[], ImportFilesError>;
    /** Whether an app answers a URL scheme (iOS; only the schemes app.json lists can be asked). */
    readonly canOpen: (url: string) => Effect.Effect<boolean>;
  }
>()("bay/ImportFiles") {
  static readonly layer = Layer.succeed(ImportFiles)({
    pick: () =>
      attempt({ name: "import.pick" }, async () => {
        const { getDocumentAsync } = await import("expo-document-picker");
        const picked = await getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false });
        const asset = picked.canceled ? undefined : picked.assets[0];

        return asset ? { path: decodeURI(asset.uri.replace(/^file:\/\//, "")), name: asset.name } : null;
      }),
    unpack: (path) =>
      attempt({ name: "import.unpack", resource: path }, async () => {
        const { readExport } = await import("@bay/mobile-import");

        return readExport(path);
      }),
    readText: (path) =>
      attempt({ name: "import.read", resource: path }, async () => {
        const { File } = await import("expo-file-system");

        return new File(fileUri(path)).text();
      }),
    discard: (picked) =>
      Effect.promise(async () => {
        try {
          const [{ discardExport }, { File }] = await Promise.all([import("@bay/mobile-import"), import("expo-file-system")]);
          await discardExport();
          const copy = picked ? new File(fileUri(picked.path)) : null;

          if (copy?.exists) copy.delete();
        } catch {
          // What's left is in the cache, which the system clears.
        }
      }),
    androidBrowsers: () =>
      attempt({ name: "import.browsers" }, async () => {
        // Required rather than imported: an `import()` copies every export of React Native, and reading the
        // deprecated ones (PushNotificationIOS) throws.
        // SAFETY: Metro resolves "react-native" to the same module its types describe; `require` is untyped, nothing more.
        const { Platform } = require("react-native") as typeof import("react-native");

        if (Platform.OS !== "android") return [];
        const { installedBrowsers } = await import("@bay/mobile-import");

        return installedBrowsers();
      }),
    canOpen: (url) =>
      Effect.promise(async () => {
        try {
          const { canOpenURL } = await import("expo-linking");

          return await canOpenURL(url);
        } catch {
          return false;
        }
      }),
  });
}
