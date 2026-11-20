import { requireOptionalNativeModule } from "expo-modules-core";
import type { NamedTransport } from "./relay/mirror.ts";
import type { Listing } from "./scope.ts";

export type FolderInfo = {
  path: string;
  defaultPath: string;
  iCloudAvailable: boolean;
  inICloud: boolean;
  exists: boolean;
  writable: boolean;
  hasSyncData: boolean;
};

export type PhraseResult =
  | { ok: true }
  | { error: "wordCount"; count: number }
  | { error: "unknownWord"; word: string }
  | { error: "checksum" }
  | { error: "noData" }
  | { error: "mismatch" }
  | { error: "keychain" };

export type SavedLogin = { origin: string; url: string; username: string; password: string; created: number };

type SyncNative = {
  folderInfo(path: string | null): Promise<FolderInfo>;
  chooseFolder(current: string | null): Promise<string | null>;
  newDeviceId(): string;
  deviceName(): string;
  createPhrase(account: string): Promise<boolean>;
  enterPhrase(account: string, text: string, folder: string): Promise<PhraseResult>;
  unlock(account: string): Promise<boolean>;
  forget(account: string): Promise<void>;
  chainStatus(folder: string): Promise<"ok" | "missing" | "unavailable">;
  createChain(folder: string): Promise<void>;
  write(folder: string, scope: string, payload: string): Promise<string>;
  /** A file under a name it already has (relay/mirror.ts). */
  writeAs(folder: string, scope: string, id: string, payload: string): Promise<void>;
  /** The chain's key, base64, while it's unlocked: the relay's transport seals with it. */
  relayKey(): Promise<string | null>;
  /** Random bytes from the system, base64. */
  randomBytes(count: number): string;
  read(folder: string, scope: string, known: string[]): Promise<Listing>;
  remove(folder: string, scope: string, ids: string[]): Promise<void>;
  deleteChain(folder: string): Promise<void>;
  sealLocal(text: string): Promise<string>;
  openLocal(sealed: string): Promise<string | null>;
  recoveryWords(): Promise<string[]>;
  qrCode(): Promise<string | null>;
  recoveryKitPreview(width: number): Promise<string | null>;
  saveRecoveryKit(format: "pdf" | "text"): Promise<string | null>;
  copyRecoveryKit(): Promise<void>;
  shareRecoveryKit(): Promise<void>;
  copyRecoveryPhrase(): Promise<void>;
  revealFolder(path: string): Promise<void>;
  readPasswords(engineProfile: string): Promise<SavedLogin[] | null>;
};

export const SyncNative = requireOptionalNativeModule<SyncNative>("BaySync");

export const folderTransport = (native: SyncNative, folder: string): NamedTransport => ({
  write: (scope, payload) => native.write(folder, scope, payload),
  writeAs: (scope, id, payload) => native.writeAs(folder, scope, id, payload),
  read: (scope, known) => native.read(folder, scope, known),
  remove: (scope, ids) => native.remove(folder, scope, ids),
});
