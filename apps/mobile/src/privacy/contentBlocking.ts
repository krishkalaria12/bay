import { TRACKING_PARAMS } from "@bay/core/src/cleanUrl.ts";
import { setBlockingPausedHosts, setContentBlocking, setTrackingParameters } from "@bay/engine";
import { Directory, File, Paths } from "expo-file-system";
import { useEffect } from "react";
import { create } from "zustand";

import { ENGINE_RULES, FILTER_LISTS, isStale, listUnchanged, listVersion, looksLikeFilterList, type ListValidators } from "./filterLists";

// List text never passes through JavaScript: lists download straight to files, their versions come from native MD5
// digests, and the engines read the files themselves. (7 MB of text on the JS thread made typing drop keystrokes.)
const directory = new Directory(Paths.document, "filter-lists");
const metaFile = new File(directory, "lists.json");

type Meta = Record<string, { fetchedAt: number } & ListValidators>;

const listFile = (id: string): File => new File(directory, `${id}.txt`);

export type BlockerStatus = { state: "off" } | { state: "loading" } | { state: "ready"; lists: number } | { state: "failed" };

/** What the engines are blocking with, for Settings. */
export const useBlockerStatus = create<{ status: BlockerStatus }>(() => ({ status: { state: "loading" } }));
const setStatus = (status: BlockerStatus): void => useBlockerStatus.setState({ status });

async function readMeta(): Promise<Meta> {
  try {
    // SAFETY: the meta file is only ever written by refreshLists as JSON Meta (or null), so its text parses to Meta.
    return metaFile.exists ? ((JSON.parse(await metaFile.text()) as Meta) ?? {}) : {};
  } catch {
    return {};
  }
}

/** The first bytes of a download, to tell a filter list from an error page without reading the whole file. */
async function looksLikeList(file: File): Promise<boolean> {
  const handle = file.open();

  try {
    const head = await handle.readBytes(512);

    return looksLikeFilterList(String.fromCharCode(...head), file.size ?? 0);
  } finally {
    handle.close();
  }
}

/** A list's ETag and Last-Modified from a HEAD request (headers only, no list text), or null if the server didn't answer. */
async function headValidators(url: string): Promise<ListValidators | null> {
  try {
    const response = await fetch(url, { method: "HEAD" });

    if (!response.ok) return null;
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");

    return { ...(etag ? { etag } : undefined), ...(lastModified ? { lastModified } : undefined) };
  } catch {
    return null;
  }
}

/** Downloads stale lists into place; returns true if any changed. A list that fails keeps its cached copy. */
async function refreshLists(now: number): Promise<boolean> {
  if (!directory.exists) directory.create({ intermediates: true });
  const meta = await readMeta();
  let changed = false;
  await Promise.all(
    FILTER_LISTS.map(async (list) => {
      // A missing file is stale whatever the metadata says.
      const saved = meta[list.id];

      if (!isStale(saved?.fetchedAt, now) && listFile(list.id).exists) return;
      // The lists are 7 MB together: skip the download when the server says the saved copy is current.
      const validators = await headValidators(list.url);

      if (saved && validators && listFile(list.id).exists && listUnchanged(saved, validators)) {
        meta[list.id] = { ...saved, fetchedAt: now };

        return;
      }

      const download = new File(directory, `${list.id}.download`);

      try {
        if (download.exists) download.delete();
        await File.downloadFileAsync(list.url, download, { idempotent: true });

        if (!(await looksLikeList(download))) return;
        const target = listFile(list.id);
        const same = target.exists && (await target.digest("MD5")) === (await download.digest("MD5"));

        if (!same) {
          await download.move(target, { overwrite: true });
          changed = true;
        }

        meta[list.id] = { fetchedAt: now, ...validators };
      } catch (error) {
        console.warn(`Couldn't update the ${list.title} filter list.`, error);
      } finally {
        // `move` repoints `download` at the list itself, so check the temporary path afresh.
        const leftover = new File(directory, `${list.id}.download`);

        if (leftover.exists) leftover.delete();
      }
    }),
  );
  await metaFile.write(JSON.stringify(meta));

  return changed;
}

async function applyCached(): Promise<void> {
  const files = FILTER_LISTS.map((list) => listFile(list.id)).filter((file) => file.exists);

  if (!files.length) return setStatus({ state: "loading" });
  const digests = await Promise.all(files.map((file) => file.digest("MD5")));
  await setContentBlocking(
    files.map((file) => file.uri),
    listVersion([ENGINE_RULES, ...digests].join(":")),
  );
  setStatus({ state: "ready", lists: files.length });
}

let tracking = false;

/** Keeps both engines' blocker in step with the preferences, and the filter lists fresh. */
export function useContentBlocking(ready: boolean, enabled: boolean, pausedHosts: readonly string[]): void {
  useEffect(() => {
    if (!tracking) tracking = setTrackingParameters(TRACKING_PARAMS);
  }, []);

  useEffect(() => {
    setBlockingPausedHosts(pausedHosts);
  }, [pausedHosts]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!enabled) {
          await setContentBlocking(null, "");
          setStatus({ state: "off" });

          return;
        }

        await applyCached();

        if ((await refreshLists(Date.now())) && !cancelled) await applyCached();
      } catch (error) {
        console.warn("Couldn't start the content blocker.", error);
        setStatus({ state: "failed" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, enabled]);
}
