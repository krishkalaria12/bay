import { capabilities, isMac } from "@bay/platform";
import type { BrowserProfile, BrowserSource, DiaAutomationStatus, DiaTabsResult, ImportKind, ImportResult, SpaceSummary } from "@bay/import";
import { closeWindow, confirm } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { APP_NAME } from "../../lib/constants";
import { browserRead } from "../../store/read";
import { createSpace } from "../../runtime/spaceActions";
import type { SpaceColor } from "../../store/types";
import { IMPORT_WINDOW_ID } from "../settings/windows";
import {
  applyResult,
  applyArcProfile,
  applySafari,
  emptyCounts,
  importBookmarks,
  importDiaProfile,
  importExtensions,
  openInWebStore,
  profileColorFor,
  type ImportCounts,
  type ExtensionFailure,
} from "./apply";
import { DIA_LAUNCH_MS, DIA_POLL_MS, DONE_DELAY_MS, ENCRYPTED, KINDS } from "./constants";
import { importModule } from "./module";

// Dia's tabs come over AppleScript, which only macOS has.
const importable = (list: BrowserSource[]) => list.filter((browser) => browser.family !== "automation" || capabilities.appleScript);

export type Step = "loading" | "choose" | "profiles" | "safari" | "access" | "unlock" | "dia" | "progress" | "done";
export type Status = "pending" | "active" | "done" | "failed";
export type ImportFlow = ReturnType<typeof useImportFlow>;

/** The import window's state and what it does: which browser and data, each step's progress, and the result. */
export function useImportFlow() {
  const api = importModule();
  const [step, setStep] = useState<Step>("loading");
  const [browsers, setBrowsers] = useState<BrowserSource[]>([]);
  const [source, setSource] = useState<BrowserSource | null>(null);
  const [sourceProfiles, setSourceProfiles] = useState<string[]>([]);
  const [spaces, setSpaces] = useState<string[]>([]);
  const [kinds, setKinds] = useState<Set<ImportKind>>(new Set());
  const [target, setTarget] = useState(() => defaultTarget());
  const [status, setStatus] = useState<Partial<Record<ImportKind, Status>>>({});
  const [failures, setFailures] = useState<{ kind: ImportKind; profiles: string[] }[]>([]);
  const [counts, setCounts] = useState<ImportCounts>(emptyCounts());
  const [preparing, setPreparing] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [fullDiskAccess, setFullDiskAccess] = useState(false);
  const [safariCookies, setSafariCookies] = useState(true);
  // What was left behind (cookies or cards that didn't decrypt, isolated Firefox cookies), shown at the end.
  const [notes, setNotes] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<ExtensionFailure[]>([]);
  const [diaStatus, setDiaStatus] = useState<DiaAutomationStatus | "checking" | "reading">("checking");
  const [dia, setDia] = useState<DiaTabsResult | null>(null);
  const [asking, setAsking] = useState(false);
  const diaLaunched = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const choice = useRef(0);
  const checkingUnlock = useRef(false);

  const recheckAccess = async () => {
    if (!api) return;
    if (step === "safari") return setFullDiskAccess(await api.safariHasFullDiskAccess());
    const list = await api.listBrowsers().catch(() => null);
    if (!list) return;
    setBrowsers(importable(list));
    const updated = list.find((b) => b.id === source?.id);
    if (updated && !updated.needsFullDiskAccess) {
      choose(updated);
      setStep("choose");
    }
  };

  const choose = (b: BrowserSource) => {
    const selected = ++choice.current;
    setSource(b);
    const defaults = b.profiles.filter((p) => p.isDefault);
    setSourceProfiles((defaults.length ? defaults : b.profiles.slice(0, 1)).map((p) => p.id));
    setSpaces(b.profiles.flatMap((p) => p.spaces ?? []).map((s) => s.id));
    const available: ImportKind[] = b.requiresExport
      ? ["bookmarks", "history", "passwords"]
      : b.family === "automation"
        ? ["tabs", "pinnedTabs"]
        : [...new Set(b.profiles.flatMap((p) => p.available))];
    setKinds(new Set(available));
    if (b.family === "safari" && api)
      void api.safariHasFullDiskAccess().then(
        (value) => {
          if (choice.current === selected) setFullDiskAccess(value);
        },
        () => {
          if (choice.current === selected) setFullDiskAccess(false);
        },
      );
    setDia(null);
    setExtensions([]);
    setNotes([]);
    setError(null);
  };

  const toggleKind = (kind: ImportKind, on: boolean) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });

  const allSpaces: (SpaceSummary & { spaceId: string })[] = (source?.profiles ?? []).flatMap((p) => (p.spaces ?? []).map((s) => ({ ...s, spaceId: p.id })));
  const isArc = source?.family === "arc";
  const isDiaTabs = source?.family === "automation";

  const next = async () => {
    if (!source || checkingUnlock.current) return;
    const selected = choice.current;
    return checkUnlock(
      checkingUnlock,
      async () => {
        setError(null);
        if (step === "choose" && isDiaTabs) {
          setDiaStatus("checking");
          setStep("dia");
          return void refreshDia();
        }
        if (step === "profiles" && isDiaTabs && dia) return void runDia(dia, sourceProfiles, kinds);
        if (step === "choose") {
          if (source.needsFullDiskAccess) return setStep("access");
          if (source.requiresExport) return setStep("safari");
          if (source.profiles.length > 1 || (isArc && allSpaces.length > 1)) return setStep("profiles");
        }
        if ((step === "choose" || step === "profiles") && ENCRYPTED.some((k) => kinds.has(k)) && source.needsKeychain && api) {
          const unlocked = await api.isBrowserUnlocked(source.id);
          if (choice.current !== selected) return;
          if (!unlocked) return setStep("unlock");
        }
        void run(kinds);
      },
      () => {
        if (choice.current === selected) setError(`Couldn't check access to ${source.name}. Try again.`);
      },
    );
  };

  const unlock = async () => {
    if (!api || !source) return;
    setUnlocking(true);
    try {
      await api.unlockBrowser(source.id);
      setUnlocking(false);
      void run(kinds);
    } catch {
      setUnlocking(false);
      setError(
        isMac
          ? `macOS didn't allow access to ${source.name}'s keychain item. Try again, or skip the encrypted data.`
          : `Couldn't decrypt ${source.name}'s data. Try again, or skip the encrypted data.`,
      );
    }
  };

  // Addresses need no key; cards, passwords and cookies do (the importer skips cards with a warning).
  const skipEncrypted = () => {
    const without = new Set(kinds);
    without.delete("passwords");
    without.delete("cookies");
    setKinds(without);
    void run(without);
  };

  const destination = async (index: number, name: string, color?: string, emoji?: string, used?: Set<string>): Promise<string> => {
    if (index === 0) return target;
    const s = browserRead.getState();
    const clash = s.spaceOrder.find((id) => !used?.has(id) && s.spaces[id]!.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (clash) {
      const { confirmed } = await confirm({
        title: "Import as new Space?",
        message:
          "Import this data as a new Space to avoid data loss. If you replace a Space, your passwords, cookies, and payment info will be replaced, while your bookmarks and history will be combined.",
        confirmTitle: "Import as new Space",
        cancelTitle: "Replace this Space",
      });
      if (!confirmed) return clash;
    }
    // Without an emoji of its own (Chrome's profiles, an Arc space with a symbol) the space gets a free one (createSpace).
    return createSpace({ name, color: profileColorFor(color) as SpaceColor | undefined, icon: emoji });
  };

  const finish = () => setTimeout(() => setStep("done"), DONE_DELAY_MS);

  const run = async (wanted: Set<ImportKind>) => {
    if (!api || !source) return;
    const selected = source.profiles.filter((p) => sourceProfiles.includes(p.id) || (isArc && p.spaces?.some((s) => spaces.includes(s.id))));
    const requested: ImportKind[] = [...wanted];
    if (isArc && requested.includes("tabs")) requested.push("spaces", "pinnedTabs");
    if (isArc && requested.includes("extensions") && !requested.includes("spaces")) requested.push("spaces");
    const order = KINDS.map((k) => k.kind).filter((k) => requested.includes(k));
    setStatus(Object.fromEntries(order.map((k) => [k, "pending"])));
    setPreparing(isArc ? Math.max(1, spaces.length) : selected.length);
    setStep("progress");
    abort.current = new AbortController();
    const total = emptyCounts();
    const failed = new Map<ImportKind, string[]>();
    const add = (c: ImportCounts) => (Object.keys(total) as (keyof ImportCounts)[]).forEach((k) => (total[k] += c[k]));
    let destinationIndex = 0;
    const usedDestinations = new Set<string>();
    const extensionFailures: ExtensionFailure[] = [];
    const left: string[] = [];
    // Firefox keeps no keychain key: without a primary password its logins open as they are.
    if (source.family === "firefox" && requested.includes("passwords") && !(await api.isBrowserUnlocked(source.id))) {
      await api.unlockBrowser(source.id).catch(() => {});
    }

    const options: ImportOptions = {
      spaceIds: isArc ? spaces : undefined,
      signal: abort.current.signal,
      onProgress: (p) => {
        if (p.phase === "start") setStatus((st) => ({ ...st, [p.kind]: "active" }));
        if (p.phase === "end") setStatus((st) => (st[p.kind] === "failed" ? st : { ...st, [p.kind]: "done" }));
      },
    };
    for (const profile of selected) {
      let result: ImportResult;
      try {
        result = await api.importData(source.id, profile.id, order, options);
      } catch (e) {
        if (errorCode(e) === "cancelled") return;
        for (const k of order) failed.set(k, [...(failed.get(k) ?? []), profile.name]);
        continue;
      }
      for (const k of result.failed) failed.set(k, [...(failed.get(k) ?? []), profile.name]);
      for (const w of result.warnings) {
        if (["undecryptable", "skipped", "locked"].includes(w.code) && !result.failed.includes(w.kind!)) left.push(`${w.message}.`);
      }
      const refused = (k: ImportKind) => {
        const names = failed.get(k) ?? [];
        if (!names.includes(profile.name)) failed.set(k, [...names, profile.name]);
      };

      // Arc's spaces can share source data; each destination keeps an independent copy.
      let dest: string;
      let extensionDestinations: string[];
      if (isArc && result.spaces.length) {
        const destinations = [];
        for (const space of result.spaces) {
          const name = space.name || "Space";
          const spaceDest = await destination(destinationIndex++, name, space.color, space.emoji, usedDestinations);
          usedDestinations.add(spaceDest);
          destinations.push({ spaceId: spaceDest, space });
        }
        dest = destinations[0]!.spaceId;
        extensionDestinations = destinations.map((d) => d.spaceId);
        const nativeKinds = order.filter((kind) => kind === "cookies" || kind === "autofill");
        try {
          add(await applyArcProfile(destinations, result, source.name, () => api.importData(source.id, profile.id, nativeKinds, options), refused));
        } catch (error) {
          if (errorCode(error) === "cancelled") return;
          throw error;
        }
      } else {
        // When all of a profile's Arc spaces were deselected, it has no destination to receive extensions.
        if (isArc && profile.spaces?.length && !profile.spaces.some((s) => spaces.includes(s.id))) {
          if (result.vaultToken) api.discardImported(result.vaultToken);
          continue;
        }
        dest = await destination(destinationIndex++, result.profile?.name ?? profile.name, result.profile?.color ?? profile.color, undefined, usedDestinations);
        extensionDestinations = [dest];
        usedDestinations.add(dest);
        add(await applyResult(dest, result, source.name, refused));
      }
      if (wanted.has("extensions")) {
        setStatus((st) => ({ ...st, extensions: "active" }));
        try {
          const written = await importExtensions(extensionDestinations, result, abort.current.signal);
          total.extensions += written.imported;
          total.extensionSettings += written.storageImported;
          left.push(...written.notes);
          extensionFailures.push(...written.failed);
          if (written.failed.length) refused("extensions");
        } catch (error) {
          if (errorCode(error) === "cancelled") return;
          throw error;
        }
      }
    }
    setExtensions(extensionFailures);
    left.push(...extensionFailures.map((f) => `${f.extension.name} in ${browserRead.getState().spaces[f.spaceId]?.name ?? "Space"}: ${f.message}.`));
    setNotes(left);
    setStatus((st) => Object.fromEntries(Object.entries(st).map(([k, v]) => [k, failed.has(k as ImportKind) ? "failed" : v === "failed" ? v : "done"])));
    setFailures([...failed].map(([kind, names]) => ({ kind, profiles: selected.length > 1 ? names : [] })));
    setCounts(total);
    api.forgetUnlockedKeys();
    finish();
  };

  const refreshDia = async () => {
    if (!api) return;
    const status = await api.diaAutomationStatus().catch((): DiaAutomationStatus => "denied");
    setDiaStatus(status);
    if (status === "granted") await readDia();
  };

  const allowDia = async () => {
    if (!api) return;
    setAsking(true);
    const status = await api.requestDiaAutomation().catch((): DiaAutomationStatus => "denied");
    setAsking(false);
    setDiaStatus(status);
    if (status === "granted") await readDia();
  };

  const openDia = async () => {
    if (!api) return;
    diaLaunched.current = Date.now();
    await api.openDia().catch(() => setError("Couldn't open Dia. Open it yourself, then click Check Again."));
    void refreshDia();
  };

  const readDia = async () => {
    if (!api) return;
    setError(null);
    setDiaStatus("reading");
    let result: DiaTabsResult;
    try {
      result = await readDiaTabs(api, diaLaunched.current);
    } catch (e) {
      const code = errorCode(e);
      setDiaStatus(code === "notRunning" ? "notRunning" : code === "locked" ? "denied" : "granted");
      if (code !== "notRunning" && code !== "locked") setError(`${(e as Error).message}. Try again.`);
      return;
    }
    setDiaStatus("granted");
    takeDiaResult(result);
  };

  const takeDiaResult = (result: DiaTabsResult) => {
    setDia(result);
    if (!result.profiles.length) {
      return setError(result.windowCount ? "Dia has no open or pinned web pages to import." : "Dia has no open windows. Open one, then try again.");
    }
    const profiles: BrowserProfile[] = result.profiles.map((p, i) => ({
      id: p.id,
      name: p.name,
      path: "",
      isDefault: i === 0,
      available: ["tabs", "pinnedTabs"],
    }));
    setSource((s) => (s ? { ...s, profiles } : s));
    const first = [profiles[0]!.id];
    setSourceProfiles(first);
    if (profiles.length > 1) setStep("profiles");
    else void runDia(result, first, kinds);
  };

  const runDia = async (result: DiaTabsResult, ids: string[], wanted: Set<ImportKind>) => {
    const selected = result.profiles.filter((p) => ids.includes(p.id));
    const order = KINDS.map((k) => k.kind).filter((k) => (k === "tabs" || k === "pinnedTabs") && wanted.has(k));
    setStatus(Object.fromEntries(order.map((k) => [k, "active"])));
    setPreparing(selected.length);
    setStep("progress");
    const total = emptyCounts();
    for (const [i, p] of selected.entries()) {
      const dest = await destination(i, p.name);
      total.tabs += await importDiaProfile(dest, p, { pinned: wanted.has("pinnedTabs"), open: wanted.has("tabs") });
    }
    setStatus(Object.fromEntries(order.map((k) => [k, "done"])));
    setFailures([]);
    setCounts(total);
    finish();
  };

  const importSafari = async (path: string) => {
    if (!api) return;
    setError(null);
    setStatus({ bookmarks: "active", history: "active", passwords: "active", autofill: "active" });
    setPreparing(1);
    setStep("progress");
    const failed: ImportKind[] = [];
    let counts: ImportCounts;
    try {
      counts = await applySafari(target, await api.importSafariExport(path), false, (k) => failed.push(k));
    } catch (e) {
      setStep("safari");
      setError(errorCode(e) === "unsupported" ? "Please select a folder or zip file." : "The selected file is invalid. Please try again.");
      return;
    }
    setStatus({ bookmarks: "done", history: "done", passwords: "done", autofill: failed.includes("autofill") ? "failed" : "done" });
    setCounts(counts);
    setFailures(failed.map((kind) => ({ kind, profiles: [] })));
    finish();
  };

  const importSafariDirect = async () => {
    if (!api) return;
    setError(null);
    setStatus({ bookmarks: "active", history: "active", tabs: "active", ...(safariCookies ? { cookies: "active" as const } : {}) });
    setPreparing(1);
    setStep("progress");
    abort.current = new AbortController();
    const signal = abort.current.signal;
    const failed: ImportKind[] = [];
    let counts: ImportCounts;
    try {
      counts = await applySafari(target, await api.importSafariDirect({ signal }), safariCookies, (k) => failed.push(k));
    } catch (e) {
      const code = errorCode(e);
      if (code === "cancelled") return;
      setStep("safari");
      setError(
        code === "locked"
          ? `${APP_NAME} still doesn't have Full Disk Access. Grant it above, or use the export file below.`
          : "Couldn't read Safari's data. Try the export file below.",
      );
      setFullDiskAccess(await api.safariHasFullDiskAccess());
      return;
    }
    setStatus({
      bookmarks: "done",
      history: "done",
      tabs: "done",
      ...(safariCookies ? { cookies: failed.includes("cookies") ? "failed" : ("done" as const) } : {}),
    });
    setCounts(counts);
    setFailures(failed.map((kind) => ({ kind, profiles: [] })));
    finish();
  };

  const chooseSafariExport = async () => (await api?.chooseImportFile("safariExport")) ?? null;

  const importHtml = async () => {
    if (!api) return;
    const path = await api.chooseImportFile("bookmarksHTML");
    if (!path) return;
    try {
      const root = await api.importBookmarksHTML(path);
      const n = await importBookmarks(target, root, "HTML File");
      setCounts({ ...emptyCounts(), bookmarks: n });
      setFailures([]);
      setStatus({ bookmarks: "done" });
      setSource(null);
      setStep("done");
    } catch {
      setError("The selected file is invalid. Please try again.");
    }
  };

  const openExtensions = async () => {
    const bySpace = new Map<string, Set<string>>();
    for (const { spaceId, extension } of extensions) {
      if (!extension.webStoreUrl) continue;
      if (!bySpace.has(spaceId)) bySpace.set(spaceId, new Set());
      bySpace.get(spaceId)!.add(extension.webStoreUrl);
    }
    for (const [spaceId, urls] of bySpace) await openInWebStore(spaceId, [...urls]);
    setExtensions([]);
  };

  const close = () => void closeWindow(IMPORT_WINDOW_ID);
  const cancel = () => {
    abort.current?.abort();
    close();
  };

  // Below the actions they call: the compiler needs each declared before a closure uses it.
  useEffect(() => {
    if (!api || !((step === "safari" && !fullDiskAccess) || step === "access")) return;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void recheckAccess();
    });
    return () => sub.remove();
  }, [step, fullDiskAccess, api, source?.id]);

  useEffect(() => {
    if (!api || step !== "dia") return;
    const timer = diaStatus === "notRunning" ? setInterval(() => void refreshDia(), DIA_POLL_MS) : null;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && (diaStatus === "denied" || diaStatus === "notRunning")) void refreshDia();
    });
    return () => {
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [step, diaStatus, api]);

  useEffect(() => {
    if (!api) return setStep("choose");
    void api
      .listBrowsers()
      .then((list) => {
        const shown = importable(list);
        setBrowsers(shown);
        const first = shown.find((b) => !b.needsFullDiskAccess && !b.requiresExport && b.family !== "automation") ?? shown[0];
        if (first) choose(first);
        setStep("choose");
      })
      .catch(() => setStep("choose"));
    return () => {
      abort.current?.abort();
      api.forgetUnlockedKeys();
    };
  }, []);

  useEffect(() => {
    if (!__DEV__) return;
    const g = globalThis as { nnImport?: object };
    g.nnImport = {
      select: (id: string) => {
        const b = browsers.find((x) => x.id === id);
        if (b) choose(b);
        return !!b;
      },
      next,
      back: () => setStep("choose"),
      unlock,
      kinds: [...kinds],
      setKinds: (list: ImportKind[]) => setKinds(new Set(list)),
      counts,
      failures,
      extensions,
      notes,
      step,
      diaStatus,
      dia,
      setDiaStatus,
      takeDiaResult,
      setSourceProfiles,
    };
    return () => void delete g.nnImport;
  });

  return {
    available: !!api,
    step,
    setStep,
    browsers,
    source,
    isArc,
    isDiaTabs,
    allSpaces,
    sourceProfiles,
    setSourceProfiles,
    spaces,
    setSpaces,
    kinds,
    toggleKind,
    target,
    setTarget,
    status,
    failures,
    counts,
    preparing,
    error,
    unlocking,
    fullDiskAccess,
    safariCookies,
    setSafariCookies,
    notes,
    extensions: extensions.filter((f) => f.extension.webStoreUrl),
    diaStatus,
    dia,
    asking,
    choose,
    next,
    unlock,
    skipEncrypted,
    recheckAccess,
    refreshDia,
    allowDia,
    openDia,
    readDia,
    importSafari,
    importSafariDirect,
    chooseSafariExport,
    importHtml,
    openExtensions,
    openFullDiskAccessSettings: () => void api?.openFullDiskAccessSettings(),
    openAutomationSettings: () => void api?.openAutomationSettings(),
    close,
    cancel,
  };
}

const errorCode = (e: unknown) => (e as { code?: string }).code;

async function checkUnlock(checking: { current: boolean }, action: () => Promise<void>, onError: () => void): Promise<void> {
  checking.current = true;
  try {
    await action();
  } catch {
    onError();
  } finally {
    checking.current = false;
  }
}

type ImportApi = NonNullable<ReturnType<typeof importModule>>;
type ImportOptions = Parameters<ImportApi["importData"]>[3];

// Dia just launched from here may not have a window yet: its read is retried a few times before an empty one counts.
async function readDiaTabs(api: ImportApi, launchedAt: number): Promise<DiaTabsResult> {
  let result = await api.readDiaTabs();
  for (let i = 0; !result.windowCount && Date.now() - launchedAt < DIA_LAUNCH_MS && i < 8; i++) {
    await new Promise((r) => setTimeout(r, DIA_POLL_MS));
    result = await api.readDiaTabs();
  }
  return result;
}

function defaultTarget(): string {
  const s = browserRead.getState();
  const w = s.windows[s.ui.focusedWindowId ?? ""];
  return w && !w.incognito ? w.spaceId : s.settings.defaultSpaceId;
}
