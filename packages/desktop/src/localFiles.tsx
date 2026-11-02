import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import type { ViewProps } from "react-native";

export type LocalFileDescriptor = { path: string; name: string; kind: "file" | "folder" };
export type LocalFileStatus = "available" | "missing" | "inaccessible";
export type LocalFileAccess = {
  status: LocalFileStatus;
  path?: string;
  name?: string;
  kind?: "file" | "folder";
  url?: string;
  browserReadable?: boolean;
};
export type LocalFileEntry = LocalFileDescriptor & { relativePath: string };
export type LocalFileListing = { access: LocalFileAccess; entries: LocalFileEntry[] };

const Native = requireNativeModule<{
  inspect(rootPath: string, relativePath: string): Promise<LocalFileAccess>;
  list(rootPath: string, relativePath: string): Promise<LocalFileListing>;
  open(rootPath: string, relativePath: string): Promise<LocalFileAccess>;
  reconnect(rootPath: string, kind: "file" | "folder" | null): Promise<LocalFileDescriptor | null>;
  devDrop?(windowId: string, paths: string[]): Promise<Record<string, unknown>>;
  devUpload?(windowId: string, rootPath: string, relativePath: string, x: number, y: number): Promise<Record<string, unknown>>;
}>("BayLocalFiles");

/** Paths are metadata. Only a native Finder drop or file picker can grant access on this Mac. */
export const localFiles = {
  inspect: (rootPath: string, relativePath = "") => Native.inspect(rootPath, relativePath),
  list: (rootPath: string, relativePath = "") => Native.list(rootPath, relativePath),
  open: (rootPath: string, relativePath = "") => Native.open(rootPath, relativePath),
  reconnect: (rootPath: string, kind?: "file" | "folder") => Native.reconnect(rootPath, kind ?? null),
  /** Native acceptance hooks reject all work outside a BAY_BACKGROUND=1 instance. */
  devDrop: (windowId: string, paths: string[]) => Native.devDrop?.(windowId, paths) ?? Promise.resolve({ error: "native hook unavailable" }),
  devUpload: (windowId: string, rootPath: string, relativePath: string, x: number, y: number) =>
    Native.devUpload?.(windowId, rootPath, relativePath, x, y) ?? Promise.resolve({ error: "native hook unavailable" }),
};

export type LocalFilesAreaProps = ViewProps & {
  dropEnabled?: boolean;
  rootPath?: string;
  relativePath?: string;
  onFilesDropped?: (event: { nativeEvent: { files: LocalFileDescriptor[] } }) => void;
  onFilesDropError?: (event: { nativeEvent: { message: string } }) => void;
  onDropActive?: (event: { nativeEvent: { active: boolean } }) => void;
  /** A click that did not become a drag, or VoiceOver's press. */
  onActivate?: () => void;
  onContextMenu?: () => void;
};

/** Native NSURL pasteboard dragging works inside Chromium pages and in other apps. */
export const LocalFilesArea = requireNativeViewManager<LocalFilesAreaProps>("BayLocalFiles");
