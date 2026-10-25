import { assignPositions, type Adapter } from "@bay/sync";
import { useBrowser } from "../store/browser";
import { normalizeLocalFiles } from "../store/localFiles";
import { isIncognitoSpace } from "../store/model";
import type { LocalFilePin } from "../store/types";

// Paths describe a pin; they grant no access on another Mac. Native bookmarks never enter this record.
type FileValue = { p: string; n: string; k: LocalFilePin["kind"]; a: number; pos: string };

function validPosition(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Za-z]+$/.test(value) && !value.endsWith("0");
}

export function localFilesAdapter(spaceId: string): Adapter {
  return {
    prefix: "file:",
    extract: (base) => {
      const s = useBrowser.getState();
      if (!s.spaces[spaceId] || isIncognitoSpace(spaceId)) return null;
      const pins = Object.values(normalizeLocalFiles(s.localFiles, s.spaces))
        .filter((pin) => pin.spaceId === spaceId)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const positions = assignPositions(
        pins.map((pin) => {
          const pos = (base(`file:${pin.id}`) as { pos?: unknown } | undefined)?.pos;
          return validPosition(pos) ? pos : undefined;
        }),
      );
      return {
        values: new Map(
          pins.map((pin, index) => [`file:${pin.id}`, { p: pin.path, n: pin.name, k: pin.kind, a: pin.createdAt, pos: positions[index]! } satisfies FileValue]),
        ),
      };
    },
    apply: (visible, changed) => {
      const s = useBrowser.getState();
      if (!s.spaces[spaceId] || isIncognitoSpace(spaceId)) return false;
      const localFiles = { ...s.localFiles };
      const incoming: { pin: LocalFilePin; pos: string }[] = [];
      for (const [key, value] of visible) {
        if (!key.startsWith("file:") || !value || typeof value !== "object") continue;
        const record = value as FileValue;
        if (!validPosition(record.pos)) continue;
        const id = key.slice(5);
        if (!id || (localFiles[id] && localFiles[id]!.spaceId !== spaceId)) continue;
        const old = localFiles[id];
        const pin = normalizeLocalFiles(
          {
            [id]: { id, spaceId, path: record.p, name: record.n, kind: record.k, createdAt: record.a, order: 0, expanded: old?.expanded ?? false },
          },
          s.spaces,
        )[id];
        if (pin) incoming.push({ pin, pos: record.pos });
      }
      incoming.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.pin.id.localeCompare(b.pin.id)));
      // A malformed record does not erase a valid pin. Only a sync tombstone removes one.
      for (const key of changed) {
        if (!key.startsWith("file:") || visible.has(key)) continue;
        const id = key.slice(5);
        if (localFiles[id]?.spaceId === spaceId) delete localFiles[id];
      }
      incoming.forEach(({ pin }, order) => {
        localFiles[pin.id] = { ...pin, order };
      });
      useBrowser.setState({ localFiles });
    },
  };
}
