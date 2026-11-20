// A computer that syncs through a folder (iCloud Drive, Dropbox) and has a phone too: every file goes to both, and
// what one has that the other hasn't is copied across under the same name, so devices on the folder and devices on
// the relay read one chain. A file once on both and then gone from one was removed there (a device compacted it):
// it's removed from the other too, never copied back.
import type { Listing, Transport } from "../scope.ts";
import type { RelayTransport } from "./transport.ts";

/** The folder, able to write a file under a name it already has. */
export interface NamedTransport extends Transport {
  writeAs(scope: string, id: string, payload: string): Promise<void>;
}

/** Each scope's files seen on both sides, so one gone from a side reads as removed rather than new. */
export type MirrorState = Record<string, string[]>;

export function mirrorTransport(folder: NamedTransport, relay: RelayTransport, state: MirrorState): Transport {
  return {
    write: async (scope, payload) => {
      const id = await folder.write(scope, payload);

      await relay.writeAs(scope, id, payload);
      state[scope] = [...(state[scope] ?? []), id];

      return id;
    },
    read: async (scope, known) => {
      const both = new Set(state[scope] ?? []);
      let [onFolder, onRelay] = await Promise.all([folder.read(scope, known), relay.read(scope, known)]);
      const inFolder = new Set(onFolder.present);
      const inRelay = new Set(onRelay.present);
      const onlyFolder = onFolder.present.filter((id) => !inRelay.has(id));
      const onlyRelay = onRelay.present.filter((id) => !inFolder.has(id));
      // Gone from one side after both had it: removed there.
      const removeFromFolder = onlyFolder.filter((id) => both.has(id));
      const removeFromRelay = onlyRelay.filter((id) => both.has(id));
      const copyToRelay = onlyFolder.filter((id) => !both.has(id));
      const copyToFolder = onlyRelay.filter((id) => !both.has(id));
      const skip = new Set(known);

      // A file to copy that this device read before (it's in `known`) came back without its payload: read it again.
      if (copyToRelay.some((id) => skip.has(id))) onFolder = await folder.read(scope, without(known, copyToRelay));

      if (copyToFolder.some((id) => skip.has(id))) onRelay = await relay.read(scope, without(known, copyToFolder));

      const payloads = new Map([...onFolder.files, ...onRelay.files].map((file) => [file.id, file.payload]));

      for (const id of copyToRelay) {
        const payload = payloads.get(id);

        if (payload !== undefined) await relay.writeAs(scope, id, payload);
      }

      for (const id of copyToFolder) {
        const payload = payloads.get(id);

        if (payload !== undefined) await folder.writeAs(scope, id, payload);
      }

      if (removeFromFolder.length) await folder.remove(scope, removeFromFolder);

      if (removeFromRelay.length) await relay.remove(scope, removeFromRelay);

      const removed = new Set([...removeFromFolder, ...removeFromRelay]);
      const present = [...new Set([...onFolder.present, ...onRelay.present])].filter((id) => !removed.has(id));

      state[scope] = present.filter((id) => (inFolder.has(id) || copyToFolder.includes(id)) && (inRelay.has(id) || copyToRelay.includes(id)));

      const seen = new Set<string>();

      const listing: Listing = {
        files: [...onFolder.files, ...onRelay.files].filter((file) => !skip.has(file.id) && !removed.has(file.id) && !seen.has(file.id) && seen.add(file.id)),
        pending: onFolder.pending.filter((id) => !removed.has(id)),
        damaged: [...onFolder.damaged, ...onRelay.damaged].filter((file) => !removed.has(file.id) && !payloads.has(file.id)),
        present,
      };

      return listing;
    },
    remove: async (scope, ids) => {
      await Promise.all([folder.remove(scope, ids), relay.remove(scope, ids)]);

      const gone = new Set(ids);

      state[scope] = (state[scope] ?? []).filter((id) => !gone.has(id));
    },
  };
}

function without(known: string[], ids: string[]): string[] {
  const drop = new Set(ids);

  return known.filter((id) => !drop.has(id));
}
