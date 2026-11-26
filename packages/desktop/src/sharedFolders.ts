import { requireOptionalNativeModule, type EventSubscription } from "@bay/platform/native";

// Folders that stay shared (apps/browser lib/sharedFolders.ts): a real folder of link files, reachable once the
// person picked it. macOS: ios/SharedFoldersModule.swift; Windows and Linux: engine webui/shared_folders.cc.

export type SharedFolderPick = { path: string; name: string };

export type SharedFolderEntry = { name: string; text: string; modified: number };

export type SharedFolderRead = { status: "available"; entries: SharedFolderEntry[] } | { status: "missing" | "inaccessible" };

type SharedFoldersNative = {
  pick(): Promise<SharedFolderPick | null>;
  read(path: string): Promise<SharedFolderRead>;
  write(path: string, name: string, text: string): Promise<boolean>;
  remove(path: string, name: string): Promise<boolean>;
  watch(path: string, on: boolean): Promise<void>;
  forget(path: string): Promise<void>;
  reveal(path: string): Promise<boolean>;
  // macOS: the share sheet, with iCloud Drive's Collaborate.
  share?(path: string): Promise<boolean>;
  addListener(name: "onChange", listener: (e: { path: string }) => void): EventSubscription;
};

const Native = requireOptionalNativeModule<SharedFoldersNative>("BaySharedFolders");

export const sharedFoldersAvailable = () => Native !== null;
export const canShareFolderSheet = () => Native?.share !== undefined;
export const pickSharedFolder = () => Native?.pick() ?? Promise.resolve(null);
export const readSharedFolder = (path: string): Promise<SharedFolderRead> => Native?.read(path) ?? Promise.resolve({ status: "inaccessible" });
export const writeSharedLink = (path: string, name: string, text: string) => Native?.write(path, name, text) ?? Promise.resolve(false);
export const removeSharedLink = (path: string, name: string) => Native?.remove(path, name) ?? Promise.resolve(false);
export const watchSharedFolder = (path: string, on: boolean) => Native?.watch(path, on) ?? Promise.resolve();
export const forgetSharedFolder = (path: string) => Native?.forget(path) ?? Promise.resolve();
export const revealSharedFolder = (path: string) => Native?.reveal(path) ?? Promise.resolve(false);
export const shareSharedFolder = (path: string) => Native?.share?.(path) ?? Promise.resolve(false);
export const onSharedFolderChange = (listener: (e: { path: string }) => void) => Native?.addListener("onChange", listener) ?? { remove() {} };
