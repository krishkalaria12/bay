// The import workflow: what the app imports from another browser, and what it takes to do it.
//
// The React hook is the UI's half: it holds the steps, the choices and the progress. This is the other half: the
// discovery of what can be imported, the permissions the user grants, the native job, and the order the data
// lands in. The native module keeps its own codes, so a failure here says what the native side said.
import type {
  BookmarkNode,
  BrowserSource,
  DiaAutomationStatus,
  DiaTabsResult,
  ImportKind,
  ImportOptions,
  ImportProgress,
  ImportResult,
  SafariExport,
  SpaceSuggestion,
} from "@bay/import";
import { confirm } from "@bay/desktop";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Predicate from "effect/Predicate";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { useBrowser } from "../../store/browserStore";
import type { SpaceColor } from "../../store/types";
import {
  applyArcProfile,
  applyResult,
  applySafari,
  emptyCounts,
  importBookmarks,
  importExtensions,
  profileColorFor,
  type ExtensionFailure,
  type ImportCounts,
} from "./apply";
import { DIA_LAUNCH_MS, DIA_POLL_MS, KINDS } from "./constants";
import { importModule } from "./module";

/** What the native import module refused, and why. */
export class ImportFailure extends TaggedError("ImportFailure")<{
  /** The native module's own code: "cancelled", "notFound", "unreadable", "unsupported", "locked", "notRunning". */
  readonly code: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** The native module is not in this build: nothing can be imported. */
export class ImportUnavailable extends TaggedError("ImportUnavailable")<{
  readonly operation: string;
}> {}

// The native bridge rejects with an Error or a {code, message} record; both carry the code the app shows.
const codeOf = (cause: unknown): string => {
  // SAFETY: the native bridge rejects with a record whose code is the string it failed with.
  const code = (cause as { code?: string }).code;

  return Predicate.isString(code) && code ? code : "unreadable";
};

/** What the native job is asked for. */
export type ImportJob = {
  readonly browserId: string;
  readonly profileId: string;
  readonly kinds: ImportKind[];
  readonly spaceIds?: string[];
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: ImportProgress) => void;
};

/** The options the native module takes: the job's signal, and its progress when the caller wants it. */
const jobOptions = (job: ImportJob): ImportOptions => {
  const options: ImportOptions = { signal: job.signal };

  if (job.spaceIds) options.spaceIds = job.spaceIds;

  if (job.onProgress) options.onProgress = job.onProgress;

  return options;
};

/** The native module, as the workflow reaches it. */
export class ImportEngine extends Context.Service<
  ImportEngine,
  {
    readonly listBrowsers: () => Effect.Effect<BrowserSource[], ImportFailure | ImportUnavailable>;
    readonly unlockBrowser: (browserId: string) => Effect.Effect<void, ImportFailure | ImportUnavailable>;
    readonly isBrowserUnlocked: (browserId: string) => boolean;
    readonly forgetUnlockedKeys: () => void;
    readonly importData: (job: ImportJob) => Effect.Effect<ImportResult, ImportFailure | ImportUnavailable>;
    /** Reads the native kinds again for another destination: writing a vault token consumes it. */
    readonly importNative: (job: ImportJob) => Promise<Pick<ImportResult, "vaultToken" | "failed">>;
    readonly discardImported: (token: string) => void;
    readonly importSafariExport: (path: string, signal: AbortSignal) => Effect.Effect<SafariExport, ImportFailure | ImportUnavailable>;
    readonly importSafariDirect: (signal: AbortSignal) => Effect.Effect<SafariExport, ImportFailure | ImportUnavailable>;
    readonly importBookmarksHTML: (path: string) => Effect.Effect<BookmarkNode, ImportFailure | ImportUnavailable>;
    readonly chooseImportFile: (kind: "safariExport" | "bookmarksHTML" | "passwordsCSV") => Effect.Effect<string | null, ImportFailure | ImportUnavailable>;
    readonly safariHasFullDiskAccess: () => boolean;
    readonly diaAutomationStatus: () => Effect.Effect<DiaAutomationStatus, ImportFailure | ImportUnavailable>;
    readonly requestDiaAutomation: () => Effect.Effect<DiaAutomationStatus, ImportFailure | ImportUnavailable>;
    readonly openDia: () => Effect.Effect<void, ImportFailure | ImportUnavailable>;
    readonly readDiaTabs: () => Effect.Effect<DiaTabsResult, ImportFailure | ImportUnavailable>;
  }
>()("bay/ImportEngine") {
  static readonly layer = Layer.effect(
    ImportEngine,
    Effect.sync(() => {
      const native = importModule();

      const failure = (operation: string, cause: unknown) => new ImportFailure({ code: codeOf(cause), operation, cause });

      const guarded = <A>(operation: string, run: (api: NonNullable<typeof native>) => Promise<A>): Effect.Effect<A, ImportFailure | ImportUnavailable> =>
        Effect.suspend((): Effect.Effect<A, ImportFailure | ImportUnavailable> => {
          if (!native) return Effect.fail(new ImportUnavailable({ operation }));

          return Effect.tryPromise({
            try: () => run(native),
            catch: (cause: unknown) => failure(operation, cause),
          });
        });

      return ImportEngine.of({
        listBrowsers: () => guarded("import.browsers", (api) => api.listBrowsers()),
        unlockBrowser: (browserId) => guarded("import.unlock", (api) => api.unlockBrowser(browserId)),
        isBrowserUnlocked: (browserId) => !!native?.isBrowserUnlocked(browserId),
        forgetUnlockedKeys: () => native?.forgetUnlockedKeys(),
        importData: (job) => guarded("import.data", (api) => api.importData(job.browserId, job.profileId, job.kinds, jobOptions(job))),
        importNative: (job) => native!.importData(job.browserId, job.profileId, job.kinds, jobOptions(job)),
        discardImported: (token) => native?.discardImported(token),
        importSafariExport: (path, signal) => guarded("import.safariExport", (api) => api.importSafariExport(path, { signal })),
        importSafariDirect: (signal) => guarded("import.safariDirect", (api) => api.importSafariDirect({ signal })),
        importBookmarksHTML: (path) => guarded("import.bookmarksHTML", (api) => api.importBookmarksHTML(path)),
        chooseImportFile: (kind) => guarded("import.chooseFile", (api) => api.chooseImportFile(kind)),
        safariHasFullDiskAccess: () => !!native?.safariHasFullDiskAccess(),
        diaAutomationStatus: () => guarded("import.diaStatus", (api) => api.diaAutomationStatus()),
        requestDiaAutomation: () => guarded("import.diaRequest", (api) => api.requestDiaAutomation()),
        openDia: () => guarded("import.diaOpen", (api) => api.openDia()),
        readDiaTabs: () => guarded("import.diaRead", (api) => api.readDiaTabs()),
      });
    }),
  );
}

/** What an import brought, and what it could not. */
export type ImportOutcome = {
  readonly counts: ImportCounts;
  readonly failures: { kind: ImportKind; profiles: string[] }[];
  readonly notes: string[];
  readonly extensions: ExtensionFailure[];
};

/** What the user asked to import. */
export type ImportRequest = {
  readonly source: BrowserSource;
  readonly profileIds: string[];
  readonly spaceIds: string[];
  readonly kinds: Set<ImportKind>;
  readonly target: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: ImportProgress) => void;
};

/** What Safari's import needs. */
export type SafariRequest = {
  readonly kind: "export" | "direct";
  readonly path?: string;
  readonly target: string;
  readonly cookies: boolean;
  readonly signal: AbortSignal;
};

/** What the app asks of the import workflow. */
export type Workflow = {
  /** The browsers this Mac can import from. */
  readonly listBrowsers: () => Effect.Effect<BrowserSource[], ImportFailure | ImportUnavailable>;
  /** Asks macOS for the browser's keychain item, and waits for the user. */
  readonly unlock: (browserId: string) => Effect.Effect<void, ImportFailure | ImportUnavailable>;
  /** Whether the browser's keychain item is already open. */
  readonly unlocked: (browserId: string) => Effect.Effect<boolean>;
  /** Imports the chosen data, in the order the app keeps it. */
  readonly import: (request: ImportRequest) => Effect.Effect<ImportOutcome, ImportFailure | ImportUnavailable>;
  /** Reads Dia's open and pinned web pages. */
  readonly readDiaTabs: () => Effect.Effect<DiaTabsResult, ImportFailure | ImportUnavailable>;
  /** Whether Dia may be asked for its tabs. */
  readonly diaStatus: () => Effect.Effect<DiaAutomationStatus, ImportFailure | ImportUnavailable>;
  /** Asks for Dia's permission, and waits for the user. */
  readonly requestDia: () => Effect.Effect<DiaAutomationStatus, ImportFailure | ImportUnavailable>;
  /** Opens Dia. */
  readonly openDia: () => Effect.Effect<void, ImportFailure | ImportUnavailable>;
  /** Waits for Dia to be running, asking again every little while, and says what it found. Stops when the flow closes. */
  readonly waitForDia: (signal: AbortSignal) => Effect.Effect<DiaAutomationStatus, ImportFailure | ImportUnavailable>;
  /** Whether this Mac may read Safari's data. */
  readonly safariAccess: () => Effect.Effect<boolean>;
  /** Imports Safari's data, from the export file or from Safari itself. */
  readonly importSafari: (request: SafariRequest) => Effect.Effect<ImportOutcome, ImportFailure | ImportUnavailable>;
  /** Imports a bookmarks file into a space. */
  readonly importHtml: (path: string, target: string) => Effect.Effect<ImportCounts, ImportFailure | ImportUnavailable>;
  /** Picks the file to import. */
  readonly chooseFile: (kind: "safariExport" | "bookmarksHTML" | "passwordsCSV") => Effect.Effect<string | null, ImportFailure | ImportUnavailable>;
  /** Gives the browser's keychain item back. */
  readonly forgetUnlockedKeys: () => Effect.Effect<void>;
};

// The profiles the import covers: the ones the user chose, and an Arc profile's chosen spaces.
const selectedProfiles = (request: ImportRequest, isArc: boolean) =>
  request.source.profiles.filter((p) => request.profileIds.includes(p.id) || (isArc && p.spaces?.some((s) => request.spaceIds.includes(s.id))));

export class ImportWorkflow extends Context.Service<ImportWorkflow, Workflow>()("bay/ImportWorkflow") {
  static readonly layer = Layer.effect(
    ImportWorkflow,
    Effect.gen(function* () {
      const engine = yield* ImportEngine;
      const clock = yield* Clock.Clock;

      // When Dia was opened from here: its read is retried until it has a window.
      let diaLaunchedAt = 0;

      // The destination a profile's data goes to. A name that clashes with another Space asks the user first.
      const destination = (
        request: ImportRequest,
        index: number,
        name: string,
        color?: string,
        emoji?: string,
        used?: Set<string>,
      ): Effect.Effect<string, never> =>
        Effect.gen(function* () {
          if (index === 0) return yield* Effect.succeed(request.target);

          const s = useBrowser.getState();
          const clash = s.spaceOrder.find((id) => !used?.has(id) && s.spaces[id]!.name.trim().toLowerCase() === name.trim().toLowerCase());

          if (clash) {
            const { confirmed } = yield* Effect.promise(() =>
              confirm({
                title: "Import as new Space?",
                message:
                  "Import this data as a new Space to avoid data loss. If you replace a Space, your passwords, cookies, and payment info will be replaced, while your bookmarks and history will be combined.",
                confirmTitle: "Import as new Space",
                cancelTitle: "Replace this Space",
              }),
            );

            if (!confirmed) return yield* Effect.succeed(clash);
          }

          // Without an emoji of its own (Chrome's profiles, an Arc space with a symbol) the space gets a free one (createSpace).
          // SAFETY: SpaceColor | undefined, icon assertion matches the runtime value validated at this call site.
          return yield* Effect.succeed(s.createSpace({ name, color: profileColorFor(color) as SpaceColor | undefined, icon: emoji }));
        });

      const importData = (request: ImportRequest): Effect.Effect<ImportOutcome, ImportFailure | ImportUnavailable> =>
        // The import's own scope: the browser's keychain item is given back when it closes, however it ends.
        Effect.scoped(
          Effect.gen(function* () {
            yield* Scope.addFinalizer(
              yield* Scope.Scope,
              Effect.sync(() => engine.forgetUnlockedKeys()),
            );

            const isArc = request.source.family === "arc";
            const selected = selectedProfiles(request, isArc);
            const requested: ImportKind[] = [...request.kinds];

            if (isArc && requested.includes("tabs")) requested.push("spaces", "pinnedTabs");

            if (isArc && requested.includes("extensions") && !requested.includes("spaces")) requested.push("spaces");

            const order = KINDS.map((k) => k.kind).filter((k) => requested.includes(k));
            const total = emptyCounts();
            const failed = new Map<ImportKind, string[]>();
            // SAFETY: (keyof ImportCounts)[]).forEach((k) assertion matches the runtime value validated at this call site.
            const add = (c: ImportCounts) => (Object.keys(total) as (keyof ImportCounts)[]).forEach((k) => (total[k] += c[k]));
            let destinationIndex = 0;
            const usedDestinations = new Set<string>();
            const extensionFailures: ExtensionFailure[] = [];
            const left: string[] = [];

            // Firefox keeps no keychain key: without a primary password its logins open as they are.
            if (request.source.family === "firefox" && requested.includes("passwords") && !engine.isBrowserUnlocked(request.source.id)) {
              yield* Effect.exit(engine.unlockBrowser(request.source.id));
            }

            for (const profile of selected) {
              const imported = yield* Effect.exit(
                engine.importData({
                  browserId: request.source.id,
                  profileId: profile.id,
                  kinds: order,
                  spaceIds: isArc ? request.spaceIds : undefined,
                  signal: request.signal,
                  onProgress: request.onProgress,
                }),
              );

              if (Exit.isFailure(imported)) {
                const refusal = Cause.squash(imported.cause);

                // A cancelled import stops the whole run; anything else fails this profile alone.
                if (refusal instanceof ImportFailure && refusal.code === "cancelled") {
                  return yield* Effect.fail(refusal);
                }

                for (const k of order) failed.set(k, [...(failed.get(k) ?? []), profile.name]);
                continue;
              }

              const result = imported.value;

              for (const k of result.failed) failed.set(k, [...(failed.get(k) ?? []), profile.name]);

              for (const w of result.warnings) {
                if (["undecryptable", "skipped", "locked"].includes(w.code) && !result.failed.includes(w.kind!)) left.push(`${w.message}.`);
              }

              const refused = (k: ImportKind) => {
                const names = failed.get(k) ?? [];

                if (!names.includes(profile.name)) failed.set(k, [...names, profile.name]);
              };

              // Arc's spaces can share source data; each destination keeps an independent copy.
              let extensionDestinations: string[];

              if (isArc && result.spaces.length) {
                const destinations: { spaceId: string; space: SpaceSuggestion }[] = [];

                for (const space of result.spaces) {
                  const name = space.name || "Space";
                  const spaceDest = yield* destination(request, destinationIndex++, name, space.color, space.emoji, usedDestinations);

                  usedDestinations.add(spaceDest);
                  destinations.push({ spaceId: spaceDest, space });
                }

                extensionDestinations = destinations.map((d) => d.spaceId);
                const nativeKinds = order.filter((kind) => kind === "cookies" || kind === "autofill");

                const applied = yield* Effect.exit(
                  Effect.promise(() =>
                    applyArcProfile(
                      destinations,
                      result,
                      request.source.name,
                      () =>
                        engine.importNative({
                          browserId: request.source.id,
                          profileId: profile.id,
                          kinds: nativeKinds,
                          spaceIds: request.spaceIds,
                          signal: request.signal,
                        }),
                      refused,
                    ),
                  ),
                );

                if (Exit.isFailure(applied)) {
                  return yield* Effect.fail(new ImportFailure({ code: "unreadable", operation: "import.apply", cause: Cause.squash(applied.cause) }));
                }

                add(applied.value);
              } else {
                // When all of a profile's Arc spaces were deselected, it has no destination to receive extensions.
                if (isArc && profile.spaces?.length && !profile.spaces.some((s) => request.spaceIds.includes(s.id))) {
                  if (result.vaultToken) engine.discardImported(result.vaultToken);
                  continue;
                }

                const dest = yield* destination(
                  request,
                  destinationIndex++,
                  result.profile?.name ?? profile.name,
                  result.profile?.color ?? profile.color,
                  undefined,
                  usedDestinations,
                );

                extensionDestinations = [dest];
                usedDestinations.add(dest);

                const applied = yield* Effect.exit(Effect.promise(() => applyResult(dest, result, request.source.name, refused)));

                if (Exit.isFailure(applied)) {
                  return yield* Effect.fail(new ImportFailure({ code: "unreadable", operation: "import.apply", cause: Cause.squash(applied.cause) }));
                }

                add(applied.value);
              }

              if (request.kinds.has("extensions")) {
                request.onProgress({ kind: "extensions", phase: "start", processed: 0 });

                const written = yield* Effect.exit(Effect.promise(() => importExtensions(extensionDestinations, result, request.signal)));

                if (Exit.isFailure(written)) {
                  return yield* Effect.fail(new ImportFailure({ code: "unreadable", operation: "import.extensions", cause: Cause.squash(written.cause) }));
                }

                total.extensions += written.value.imported;
                total.extensionSettings += written.value.storageImported;
                left.push(...written.value.notes);
                extensionFailures.push(...written.value.failed);

                if (written.value.failed.length) refused("extensions");
              }
            }

            return {
              counts: total,
              failures: [...failed].map(([kind, names]) => ({ kind, profiles: selected.length > 1 ? names : [] })),
              notes: left,
              extensions: extensionFailures,
            } satisfies ImportOutcome;
          }),
        );

      const readDiaTabs = (): Effect.Effect<DiaTabsResult, ImportFailure | ImportUnavailable> =>
        Effect.gen(function* () {
          let result = yield* engine.readDiaTabs();

          // Dia just launched from here may not have a window yet: its read is retried a few times before an empty
          // one counts.
          for (let i = 0; !result.windowCount && clock.currentTimeMillisUnsafe() - diaLaunchedAt < DIA_LAUNCH_MS && i < 8; i++) {
            yield* Effect.sleep(Duration.millis(DIA_POLL_MS));
            result = yield* engine.readDiaTabs();
          }

          return result;
        });

      const openDia = (): Effect.Effect<void, ImportFailure | ImportUnavailable> =>
        Effect.gen(function* () {
          diaLaunchedAt = clock.currentTimeMillisUnsafe();

          yield* engine.openDia();
        });

      // Dia is not running: it is asked again until it is, or until the flow that waits for it closes. A flow that
      // closed asks nothing more.
      const waitForDia = (signal: AbortSignal): Effect.Effect<DiaAutomationStatus, ImportFailure | ImportUnavailable> =>
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(Duration.millis(DIA_POLL_MS));

            if (signal.aborted) return "notRunning" as const;

            const status = yield* engine.diaAutomationStatus();

            if (status !== "notRunning" || signal.aborted) return status;
          }
        });

      const importSafari = (request: SafariRequest): Effect.Effect<ImportOutcome, ImportFailure | ImportUnavailable> =>
        Effect.gen(function* () {
          const failed: ImportKind[] = [];

          const data =
            request.kind === "export" ? yield* engine.importSafariExport(request.path ?? "", request.signal) : yield* engine.importSafariDirect(request.signal);

          const counts = yield* Effect.promise(() => applySafari(request.target, data, request.cookies, (k) => failed.push(k)));

          return {
            counts,
            failures: failed.map((kind) => ({ kind, profiles: [] })),
            notes: [],
            extensions: [],
          } satisfies ImportOutcome;
        });

      const importHtml = (path: string, target: string): Effect.Effect<ImportCounts, ImportFailure | ImportUnavailable> =>
        Effect.gen(function* () {
          const root = yield* engine.importBookmarksHTML(path);
          const count = importBookmarks(target, root, "HTML File");

          return { ...emptyCounts(), bookmarks: count };
        });

      return ImportWorkflow.of({
        listBrowsers: () => engine.listBrowsers(),
        unlock: (browserId) => engine.unlockBrowser(browserId),
        unlocked: (browserId) => Effect.sync(() => engine.isBrowserUnlocked(browserId)),
        import: importData,
        readDiaTabs,
        waitForDia,
        diaStatus: () => engine.diaAutomationStatus(),
        requestDia: () => engine.requestDiaAutomation(),
        openDia,
        safariAccess: () => Effect.sync(() => engine.safariHasFullDiskAccess()),
        importSafari,
        importHtml,
        chooseFile: (kind) => engine.chooseImportFile(kind),
        forgetUnlockedKeys: () => Effect.sync(() => engine.forgetUnlockedKeys()),
      });
    }),
  );
}
