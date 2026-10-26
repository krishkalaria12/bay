import { createEaselShareIdentity, isEaselWebSharingEnabled, keychainDelete, keychainGet, keychainSet, readEaselShareRecords, saveDocument } from "@bay/shell";
import { create } from "zustand";

const ORIGIN = "https://bay.krishkalaria.in";
const FILE = "easel-shares.json";
const account = (id: string) => `easel-share:${id}`;
type Publication = { id: string; publishedAt: number | null; revision: number };
type ShareState = { loaded: boolean; error: string | null; records: Record<string, Publication>; busy: Record<string, boolean> };
export const useEaselShares = create<ShareState>()(() => ({ loaded: false, error: null, records: {}, busy: {} }));
let saves = Promise.resolve();

export const easelShareURL = (id: string) => `${ORIGIN}/easel/${id}/`;

export function startEaselShares() {
  if (useEaselShares.getState().loaded) return;
  try {
    const text = readEaselShareRecords();
    const data = text === null ? { version: 1, records: {} } : JSON.parse(text);
    if (data?.version !== 1 || !data.records || typeof data.records !== "object" || Array.isArray(data.records)) throw new Error("Invalid sharing records");
    for (const value of Object.values(data.records) as Publication[]) {
      if (
        !value ||
        !/^[a-f0-9]{32}$/.test(value.id) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1 ||
        (value.publishedAt !== null && !Number.isFinite(value.publishedAt))
      ) {
        throw new Error("Invalid sharing record");
      }
    }
    useEaselShares.setState({ loaded: true, records: data.records, error: null });
  } catch {
    useEaselShares.setState({ loaded: true, error: "Couldn't read Easel sharing records. Restore easel-shares.json before changing shared pages." });
  }
}

// Save before sending anything: even an interrupted upload must retain the ability to stop sharing.
function saveRecord(easelId: string, value: Publication | null) {
  const next = saves.then(async () => {
    const records = { ...useEaselShares.getState().records };
    if (value) records[easelId] = value;
    else delete records[easelId];
    await saveDocument(FILE, JSON.stringify({ version: 1, records }));
    useEaselShares.setState({ records });
  });
  saves = next.catch(() => {});
  return next;
}

async function exclusive<T>(easelId: string, run: () => Promise<T>): Promise<T> {
  startEaselShares();
  const state = useEaselShares.getState();
  if (state.error) throw new Error(state.error);
  if (state.busy[easelId]) throw new Error("This Easel is already being shared. Wait for it to finish.");
  useEaselShares.setState({ busy: { ...state.busy, [easelId]: true } });
  try {
    return await run();
  } finally {
    const busy = { ...useEaselShares.getState().busy };
    delete busy[easelId];
    useEaselShares.setState({ busy });
  }
}

async function managementKey(id: string) {
  const key = await keychainGet(account(id));
  if (!key || !/^[a-f0-9]{64}$/.test(key))
    throw new Error("The sharing key is unavailable in Keychain. Restore access to it before changing this shared page.");
  return key;
}

async function request(publication: Publication, method: "PUT" | "DELETE", body?: string) {
  const key = await managementKey(publication.id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${ORIGIN}/api/easels/${publication.id}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: "This Easel couldn't be shared. Check its source links or export it as HTML.",
        401: "The sharing key wasn't accepted. Restore Keychain access before trying again.",
        403: "This Mac couldn't authorize a change to the shared page. Check its sharing key in Keychain.",
        404: "Web sharing isn't available on Bay's website yet. Export this Easel as HTML instead.",
        409: "A newer snapshot reached the shared page first. Publish again to share your current Easel.",
        410: "This link has been stopped. Stop sharing here, then publish a new link.",
        413: "This Easel is too large to share. Export it as HTML instead.",
        429: "Too many sharing requests. Wait a minute and try again.",
      };
      const message = messages[response.status] ?? `Sharing failed (${response.status}). Try again.`;
      throw new Error(message);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Sharing timed out. Retry or stop sharing to check the link's status.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function publishEasel(easelId: string, snapshot: () => Promise<string>) {
  if (!isEaselWebSharingEnabled()) throw new Error("Easel web sharing is disabled.");
  return exclusive(easelId, async () => {
    const body = JSON.parse(await snapshot());
    let publication = useEaselShares.getState().records[easelId];
    if (!publication) {
      const identity = await createEaselShareIdentity();
      if (!/^[a-f0-9]{32}$/.test(identity.id) || !/^[a-f0-9]{64}$/.test(identity.key)) throw new Error("Couldn't create a secure sharing link.");
      if (!(await keychainSet(account(identity.id), identity.key))) throw new Error("Couldn't save the sharing key in Keychain. Nothing was published.");
      publication = { id: identity.id, publishedAt: null, revision: 0 };
    }
    if (publication.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Stop sharing and publish a new link before updating this page.");
    publication = { ...publication, revision: publication.revision + 1 };
    await saveRecord(easelId, publication);
    await request(publication, "PUT", JSON.stringify({ ...body, revision: publication.revision }));
    await saveRecord(easelId, { ...publication, publishedAt: Date.now() });
    return easelShareURL(publication.id);
  });
}

export function stopSharingEasel(easelId: string) {
  return exclusive(easelId, async () => {
    const publication = useEaselShares.getState().records[easelId];
    if (!publication) return;
    if (!isEaselWebSharingEnabled()) throw new Error("Easel web sharing is disabled. Enable it before stopping sharing or deleting a shared Easel.");
    await request(publication, "DELETE");
    await saveRecord(easelId, null);
    await keychainDelete(account(publication.id));
  });
}
