// The native calls alone. webNativeViews uses them while nativeViews is still loading, so nothing here may need a view.
import type { JsonObject } from "./json.ts";
import { requireNativeModule } from "@bay/platform/native";

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

const Native = () =>
  requireNativeModule<{
    inspect(rootPath: string, relativePath: string): Promise<LocalFileAccess>;
    list(rootPath: string, relativePath: string): Promise<LocalFileListing>;
    open(rootPath: string, relativePath: string): Promise<LocalFileAccess>;
    reconnect(rootPath: string, kind: "file" | "folder" | null): Promise<LocalFileDescriptor | null>;
    // The Chrome-hosted desktop: grants what the desktop just dropped on this window (never paths the page names).
    acceptDrop?(): Promise<{ files: LocalFileDescriptor[]; errors: string[] }>;
    // The Chrome-hosted desktop: `relative` names a granted pin's file, null a download's own path.
    startDrag?(path: string, relative: string | null): Promise<{ started: boolean; operation: "none" | "copy" | "link"; error?: string }>;
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- The table is a lookup by name, so its open shape is the point.
    devDrop?(windowId: string, paths: string[]): Promise<JsonObject>;
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- The table is a lookup by name, so its open shape is the point.
    devUpload?(windowId: string, rootPath: string, relativePath: string, x: number, y: number): Promise<JsonObject>;
  }>("BayLocalFiles");

/** Paths are metadata. Only a native Finder drop or file picker can grant access on this Mac. */
export const localFiles = {
  inspect: async (rootPath: string, relativePath = "") => Native().inspect(rootPath, relativePath),
  list: async (rootPath: string, relativePath = "") => Native().list(rootPath, relativePath),
  open: async (rootPath: string, relativePath = "") => Native().open(rootPath, relativePath),
  reconnect: async (rootPath: string, kind?: "file" | "folder") => Native().reconnect(rootPath, kind ?? null),
  acceptDrop: async () => (await Native().acceptDrop?.()) ?? { files: [], errors: ["Dropping files is unavailable in this Bay host."] },
  startDrag: async (path: string, relative: string | null) =>
    (await Native().startDrag?.(path, relative)) ?? { started: false, operation: "none" as const, error: "File dragging is unavailable in this Bay host." },
  /** Native acceptance hooks reject all work outside a BAY_BACKGROUND=1 instance. */
  devDrop: async (windowId: string, paths: string[]) => Native().devDrop?.(windowId, paths) ?? Promise.resolve({ error: "native hook unavailable" }),
  devUpload: async (windowId: string, rootPath: string, relativePath: string, x: number, y: number) =>
    Native().devUpload?.(windowId, rootPath, relativePath, x, y) ?? Promise.resolve({ error: "native hook unavailable" }),
};
