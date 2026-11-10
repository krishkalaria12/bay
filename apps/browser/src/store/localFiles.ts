import * as v from "valibot";
import type { StateCreator } from "zustand";
import { isJsonObject, type JsonInput } from "../lib/json";
import type { BrowserState } from "./browserStore";
import { isIncognitoSpace, newId } from "./model";
import type { LocalFilePin, Space } from "./types";

type FileDescriptor = Pick<LocalFilePin, "path" | "name" | "kind">;

type FileState = { localFiles: Record<string, LocalFilePin> };

const safeId = (id: JsonInput): id is string => v.is(v.string(), id) && !!id && !["__proto__", "constructor", "prototype"].includes(id);

export function localFilePath(path: JsonInput): string | null {
  if (!v.is(v.string(), path) || !path.startsWith("/") || path.includes("\0")) return null;
  const parts = path.split("/").filter(Boolean);

  if (parts.some((part) => part === "." || part === "..")) return null;

  return `/${parts.join("/")}`;
}

export interface LocalFilesById {
  [id: string]: LocalFilePin;
}

/** Whitelist metadata at disk and sync boundaries. Never copy an input record wholesale. */
export function normalizeLocalFiles(input: JsonInput, spaces?: Record<string, Space>): LocalFilesById {
  const result: LocalFilesById = {};

  if (!isJsonObject(input)) return result;

  for (const value of Object.values(input)) {
    if (!isJsonObject(value)) continue;
    const candidate = value;
    const path = localFilePath(candidate.path);

    if (
      !safeId(candidate.id) ||
      !safeId(candidate.spaceId) ||
      isIncognitoSpace(candidate.spaceId) ||
      (spaces && !Object.hasOwn(spaces, candidate.spaceId)) ||
      !path
    )
      continue;

    if (!v.is(v.string(), candidate.name) || !candidate.name.trim()) continue;

    if (candidate.kind !== "file" && candidate.kind !== "folder") continue;

    result[candidate.id] = {
      id: candidate.id,
      spaceId: candidate.spaceId,
      path,
      name: candidate.name.trim(),
      kind: candidate.kind,
      createdAt: v.is(v.number(), candidate.createdAt) && Number.isFinite(candidate.createdAt) ? candidate.createdAt : 0,
      order: v.is(v.number(), candidate.order) && Number.isFinite(candidate.order) ? candidate.order : 0,
      expanded: candidate.kind === "folder" && candidate.expanded === true,
    };
  }

  return result;
}

export function localFilePins(s: FileState, spaceId: string): LocalFilePin[] {
  return Object.values(s.localFiles)
    .filter((pin) => pin.spaceId === spaceId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export type LocalFilesSlice = FileState & {
  pinLocalFiles(windowId: string, files: FileDescriptor[], spaceId?: string): string[];
  removeLocalFile(id: string): void;
  renameLocalFile(id: string, name: string): void;
  moveLocalFile(id: string, beforeId: string | null): void;
  setLocalFileExpanded(id: string, expanded: boolean): void;
  /** Restore a space's metadata for the general undo stack; native grants are unaffected. */
  restoreLocalFiles(spaceId: string, pins: Record<string, LocalFilePin>): void;
};

export const createLocalFilesSlice: StateCreator<BrowserState, [], [], LocalFilesSlice> = (set, get) => ({
  localFiles: {},
  pinLocalFiles(windowId, files, requestedSpace) {
    const s = get();
    const w = s.windows[windowId];
    const spaceId = requestedSpace ?? w?.spaceId ?? "";

    if (!w || w.incognito || w.kind === "small" || !s.spaces[spaceId]) return [];
    const localFiles = { ...s.localFiles };
    let order = Math.max(-1, ...localFilePins(s, spaceId).map((p) => p.order)) + 1;
    const ids: string[] = [];

    for (const file of files) {
      const id = newId("file");
      const pin = normalizeLocalFiles({ [id]: { ...file, id, spaceId, createdAt: Date.now(), order, expanded: false } }, s.spaces)[id];

      if (!pin) continue;
      const existing = Object.values(localFiles).find((p) => p.spaceId === spaceId && p.path === pin.path);

      if (existing) {
        ids.push(existing.id);
        continue;
      }

      localFiles[id] = pin;
      order++;
      ids.push(id);
    }

    if (Object.keys(localFiles).length !== Object.keys(s.localFiles).length) set({ localFiles });

    return ids;
  },
  removeLocalFile(id) {
    if (!Object.hasOwn(get().localFiles, id)) return;
    const localFiles = { ...get().localFiles };
    delete localFiles[id];
    set({ localFiles });
  },
  renameLocalFile(id, name) {
    const pin = get().localFiles[id];

    if (pin && name.trim() && name.trim() !== pin.name) set({ localFiles: { ...get().localFiles, [id]: { ...pin, name: name.trim() } } });
  },
  moveLocalFile(id, beforeId) {
    const s = get();
    const pin = s.localFiles[id];

    if (!pin || id === beforeId || (beforeId && s.localFiles[beforeId]?.spaceId !== pin.spaceId)) return;
    const pins = localFilePins(s, pin.spaceId).filter((p) => p.id !== id);
    pins.splice(beforeId ? pins.findIndex((p) => p.id === beforeId) : pins.length, 0, pin);
    const localFiles = { ...s.localFiles };
    pins.forEach((p, order) => {
      localFiles[p.id] = p.order === order ? p : { ...p, order };
    });

    if (pins.some((p) => localFiles[p.id] !== s.localFiles[p.id])) set({ localFiles });
  },
  setLocalFileExpanded(id, expanded) {
    const pin = get().localFiles[id];

    if (pin?.kind === "folder" && pin.expanded !== expanded) set({ localFiles: { ...get().localFiles, [id]: { ...pin, expanded } } });
  },
  restoreLocalFiles(spaceId, pins) {
    const s = get();

    if (!s.spaces[spaceId]) return;
    const kept = Object.fromEntries(Object.entries(s.localFiles).filter(([, pin]) => pin.spaceId !== spaceId));
    const restored = Object.fromEntries(Object.entries(normalizeLocalFiles(pins, s.spaces)).filter(([, pin]) => pin.spaceId === spaceId));
    set({ localFiles: { ...kept, ...restored } });
  },
});
