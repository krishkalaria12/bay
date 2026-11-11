// The settings' multi-step work: the passwords behind Touch ID, their CSV import and export, clearing a profile's
// browsing data, and recording a shortcut.
//
// Each is a command with its own outcome. Touch ID, the Keychain and the user's own choices are never asked twice on
// their own: a refusal or a cancellation is the answer. A password export runs once per profile at a time; a clear
// that the engine could not finish says what it did clear; and a shortcut recording always stops — when it is
// answered, when another starts, when the pane that started it closes, or when the app's scope does. The simple
// one-shot settings (a toggle, a saved address) stay plain where they are.
import {
  clearBrowsingData,
  exportPasswords,
  getNeverSavePasswordOrigins,
  listPasswords,
  savePassword,
  unlockPasswords,
  type BrowsingDataType,
  type PasswordExportStatus,
  type SavedPassword,
} from "@bay/chromium";
import { cancelShortcutRecording, recordShortcut, type RecordedShortcut } from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { create } from "zustand";
import type { Operation } from "../../effect/errors";
import { Diagnostics } from "../../effect/ports/diagnostics";
import { pruneProfileFavicons } from "../../lib/favicons";
import { useBrowser } from "../../store/browserStore";
import { engineProfile, isIncognitoSpace } from "../../store/model";
import { importModule } from "../import/module";
import { PASSWORDS_UNLOCK_MS } from "./constants";

// MARK: The state the panes show

/** Until when each profile's passwords are unlocked. */
export const usePasswordUnlocks = create<Record<string, number | undefined>>()(() => ({}));

const unlockedNow = (profile: string) => Date.now() < (usePasswordUnlocks.getState()[profile] ?? 0);

/** Whether the profile's passwords are unlocked, for a pane to show. */
export const usePasswordsUnlocked = (profile: string) => usePasswordUnlocks((u) => Date.now() < (u[profile] ?? 0));

// MARK: The port

/** The engine or the Mac could not do what was asked. */
export class SettingsFailure extends TaggedError("SettingsFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** A password as a CSV file has it. */
export type ImportedCredential = { url: string; username: string; password: string };

/** The engine and the Mac, as the settings reach them. */
export class SettingsEngine extends Context.Service<
  SettingsEngine,
  {
    /** Asks for Touch ID or the login password, and says whether the user gave it. */
    readonly unlockPasswords: (profile: string) => Effect.Effect<boolean, SettingsFailure>;
    /** The profile's saved passwords. */
    readonly listPasswords: (profile: string) => Effect.Effect<SavedPassword[], SettingsFailure>;
    /** The sites the profile never saves a password for. */
    readonly neverSaveOrigins: (profile: string) => Effect.Effect<string[], SettingsFailure>;
    /** Saves one password, and says whether it was saved. */
    readonly savePassword: (profile: string, origin: string, username: string, password: string) => Effect.Effect<boolean, SettingsFailure>;
    /** Asks the user for a CSV of passwords: its path, or nothing when they cancelled. Nothing too when importing isn't built in. */
    readonly chooseCsv: () => Effect.Effect<string | null | undefined, SettingsFailure>;
    /** Reads a CSV of passwords. */
    readonly readCsv: (path: string) => Effect.Effect<ImportedCredential[], SettingsFailure>;
    /** Exports the profile's passwords, asking for Touch ID first. */
    readonly exportPasswords: (profile: string) => Effect.Effect<{ status: PasswordExportStatus; path?: string }, SettingsFailure>;
    /** Clears the engine's data for a profile. */
    readonly clearEngineData: (profile: string, types: BrowsingDataType[], since?: number) => Effect.Effect<void, SettingsFailure>;
    /** Clears the app's own history for a profile, and the icons only it kept. */
    readonly clearAppHistory: (spaceId: string, since?: number) => Effect.Effect<void>;
    /** Records the next shortcut the user types: nothing when they cancelled, or it was stopped. */
    readonly recordShortcut: () => Effect.Effect<RecordedShortcut | null, SettingsFailure>;
    /** Stops the recording that is running. */
    readonly stopRecording: () => Effect.Effect<void>;
  }
>()("bay/SettingsEngine") {
  static readonly layer = Layer.succeed(SettingsEngine)({
    unlockPasswords: (profile) => nativeCall("passwords.unlock", () => unlockPasswords(profile)),
    listPasswords: (profile) => nativeCall("passwords.list", () => listPasswords(profile)),
    neverSaveOrigins: (profile) => nativeCall("passwords.never", () => getNeverSavePasswordOrigins(profile)),
    savePassword: (profile, origin, username, password) => nativeCall("passwords.save", () => savePassword(profile, origin, username, password)),
    chooseCsv: () => nativeCall("passwords.choose", () => importModule()?.chooseImportFile("passwordsCSV")),
    readCsv: (path) => nativeCall("passwords.read", async () => (await importModule()?.importPasswordsCSV(path)) ?? []),
    exportPasswords: (profile) => nativeCall("passwords.export", () => exportPasswords(profile)),
    clearEngineData: (profile, types, since) => nativeCall("data.clear", () => clearBrowsingData(profile, types, since)),
    clearAppHistory: (spaceId, since) =>
      Effect.sync(() => {
        useBrowser.getState().clearHistory(spaceId, since);
        pruneProfileFavicons(spaceId);
      }),
    recordShortcut: () => nativeCall("shortcut.record", () => recordShortcut()),
    stopRecording: () =>
      Effect.sync(() => {
        void cancelShortcutRecording().catch(() => {});
      }),
  });
}

function nativeCall<A>(name: string, run: () => A | Promise<A>): Effect.Effect<A, SettingsFailure> {
  return Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new SettingsFailure({ operation: { name }, cause }),
  });
}

// MARK: The outcomes

/** The passwords a profile has, once it is unlocked. */
export type PasswordList = { readonly passwords: SavedPassword[]; readonly never: string[] };

/** What came of importing a CSV of passwords. */
export type ImportOutcome =
  | { readonly kind: "imported"; readonly saved: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly reason: string };

/** What came of exporting the passwords. */
export type ExportOutcome = { readonly status: PasswordExportStatus; readonly path?: string };

/** What a clear asked for. */
export type ClearRequest = { readonly since?: number; readonly history: boolean; readonly siteData: boolean };

/** What a clear did: the app's own history goes at once, the engine's data may not. */
export type ClearOutcome = {
  /** The app's history was cleared. */
  readonly history: boolean;
  /** The engine's data was cleared: nothing was asked of it, it cleared, or it could not. */
  readonly engine: "none" | "cleared" | "failed";
};

// The site a password belongs to, as the engine keeps it.
function originOf(url: string) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(url);

  return m ? m[1]! : url;
}

// MARK: The service

export class SettingsWorkflows extends Context.Service<
  SettingsWorkflows,
  {
    /** Whether the profile's passwords are unlocked now. */
    readonly isUnlocked: (profile: string) => boolean;
    /** Asks for Touch ID once, and keeps the passwords unlocked for a while when the user gives it. */
    readonly unlock: (profile: string) => Effect.Effect<boolean>;
    /** The profile's passwords: nothing until it is unlocked. */
    readonly passwords: (profile: string) => Effect.Effect<PasswordList | null>;
    /** Imports a CSV of passwords into the profile. */
    readonly importCsv: (profile: string) => Effect.Effect<ImportOutcome>;
    /** Exports the profile's passwords to a CSV. One export at a time: a second one is told so. */
    readonly exportCsv: (profile: string) => Effect.Effect<ExportOutcome>;
    /** Clears a profile's browsing data, and says what it cleared. */
    readonly clearData: (spaceId: string, request: ClearRequest) => Effect.Effect<ClearOutcome>;
    /** Records the next shortcut for `owner`. A recording that was running for another owner stops first. */
    readonly record: (owner: string) => Effect.Effect<RecordedShortcut | null>;
    /** Stops `owner`'s recording, if it is the one running. */
    readonly stopRecording: (owner: string) => Effect.Effect<void>;
  }
>()("bay/SettingsWorkflows") {
  static readonly layer = Layer.effect(
    SettingsWorkflows,
    Effect.gen(function* () {
      const engine = yield* SettingsEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // The words are ours: an engine's answer about passwords is never what goes into a report.
      const report = (failure: SettingsFailure): Effect.Effect<void> =>
        diagnostics.report({ operation: failure.operation, message: `${failure.operation.name} failed`, cause: new Error(`${failure.operation.name} failed`) });

      // MARK: Passwords

      const isUnlocked = unlockedNow;

      const unlock = (profile: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (isUnlocked(profile)) return true;

          // Asked once: a refusal is the user's answer, and is not asked again on its own.
          const unlocked = yield* engine.unlockPasswords(profile).pipe(Effect.catch((failure) => report(failure).pipe(Effect.as(false))));

          if (unlocked) usePasswordUnlocks.setState({ [profile]: Date.now() + PASSWORDS_UNLOCK_MS });

          return unlocked;
        });

      const passwords = (profile: string): Effect.Effect<PasswordList | null> =>
        Effect.gen(function* () {
          // The list is behind Touch ID: a profile that is not unlocked shows nothing.
          if (!isUnlocked(profile)) return null;

          const [list, never] = yield* Effect.all(
            [
              engine.listPasswords(profile).pipe(Effect.catch(() => Effect.succeed<SavedPassword[]>([]))),
              engine.neverSaveOrigins(profile).pipe(Effect.catch(() => Effect.succeed<string[]>([]))),
            ],
            { concurrency: 2 },
          );

          return { passwords: list, never };
        });

      const importCsv = (profile: string): Effect.Effect<ImportOutcome> =>
        Effect.gen(function* () {
          const path = yield* engine.chooseCsv().pipe(Effect.result);

          if (path._tag === "Failure") return { kind: "failed", reason: "the file couldn't be chosen" } as const;

          if (path.success === undefined) return { kind: "unavailable" } as const;

          if (path.success === null) return { kind: "cancelled" } as const;

          const read = yield* engine.readCsv(path.success).pipe(Effect.result);

          if (read._tag === "Failure") {
            const cause = read.failure.cause;

            return { kind: "failed", reason: cause instanceof Error ? cause.message : "it isn't a passwords CSV" } as const;
          }

          // One at a time, and never again: a password write is not one to repeat on its own. A write that failed
          // ends the import there, as it did before, and says why.
          let saved = 0;

          for (const c of read.success) {
            if (!c.url || !c.password) continue;

            const ok = yield* engine.savePassword(profile, originOf(c.url), c.username, c.password).pipe(Effect.result);

            if (ok._tag === "Failure") {
              const cause = ok.failure.cause;

              return { kind: "failed", reason: cause instanceof Error ? cause.message : "a password couldn't be saved" } as const;
            }

            if (ok.success) saved++;
          }

          return { kind: "imported", saved } as const;
        });

      // The profiles exporting now: a second export is told one is running, as the engine would.
      const exporting = new Set<string>();

      const exportCsv = (profile: string): Effect.Effect<ExportOutcome> =>
        Effect.gen(function* () {
          if (exporting.has(profile)) return { status: "inProgress" } as const;

          exporting.add(profile);

          return yield* engine.exportPasswords(profile).pipe(
            Effect.catch((failure) => report(failure).pipe(Effect.as<ExportOutcome>({ status: "writeFailed" }))),
            Effect.ensuring(Effect.sync(() => exporting.delete(profile))),
          );
        });

      // MARK: Clearing data

      const clearData = (spaceId: string, request: ClearRequest): Effect.Effect<ClearOutcome> =>
        Effect.gen(function* () {
          if (request.history) yield* engine.clearAppHistory(spaceId, request.since);

          const types: BrowsingDataType[] = [
            ...(request.history ? ["history" as const] : []),
            ...(request.siteData ? ["siteData" as const, "cache" as const] : []),
          ];

          // A private window's data is the engine's own, and goes with the window.
          if (!types.length || isIncognitoSpace(spaceId)) return { history: request.history, engine: "none" } as const;

          // Never again on its own: clearing is destructive, and what it did clear stays cleared.
          const cleared = yield* engine.clearEngineData(engineProfile(spaceId), types, request.since).pipe(
            Effect.as(true),
            Effect.catch((failure) => report(failure).pipe(Effect.as(false))),
          );

          return { history: request.history, engine: cleared ? "cleared" : "failed" } as const;
        });

      // MARK: Recording a shortcut

      // The recording that is running, and who asked for it.
      let recording: { readonly owner: string; readonly token: number } | null = null;
      let tokens = 0;

      const stopRecording = (owner: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (recording?.owner !== owner) return;

          recording = null;

          yield* engine.stopRecording();
        });

      const record = (owner: string): Effect.Effect<RecordedShortcut | null> =>
        Effect.gen(function* () {
          // Another pane's recording stops: there is one keyboard to record.
          if (recording) yield* stopRecording(recording.owner);

          const token = ++tokens;

          recording = { owner, token };

          const combo = yield* engine.recordShortcut().pipe(Effect.catch((failure) => report(failure).pipe(Effect.as(null))));

          // The recording was stopped, or replaced, while it waited: its answer is nobody's.
          if (recording?.token !== token) return null;

          recording = null;

          return combo;
        });

      // A recording the app's scope ends stops with it.
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => (recording ? stopRecording(recording.owner) : Effect.void)),
      );

      return SettingsWorkflows.of({ isUnlocked, unlock, passwords, importCsv, exportCsv, clearData, record, stopRecording });
    }),
  );
}

/** What the settings' workflows can do. */
export type Workflows = SettingsWorkflows["Service"];
