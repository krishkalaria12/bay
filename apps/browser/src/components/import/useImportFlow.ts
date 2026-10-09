import type { BrowserProfile, BrowserSource, DiaAutomationStatus, DiaTabsResult, ImportedExtension, ImportKind, ImportResult, SpaceSummary } from "@bay/import";
import { closeWindow, confirm } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { APP_NAME } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import type { ProfileColor } from "../../store/types";
import { IMPORT_WINDOW_ID } from "../settings/windows";
import { applyResult, applySafari, emptyCounts, importArcSpace, importBookmarks, importDiaProfile, openInWebStore, profileColorFor, type ImportCounts } from "./apply";
import { DIA_LAUNCH_MS, DIA_POLL_MS, DONE_DELAY_MS, ENCRYPTED, KINDS } from "./constants";
import { importModule } from "./module";

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
  const [extensions, setExtensions] = useState<{ profileId: string; list: ImportedExtension[] }>({ profileId: "", list: [] });
  const [diaStatus, setDiaStatus] = useState<DiaAutomationStatus | "checking" | "reading">("checking");
  const [dia, setDia] = useState<DiaTabsResult | null>(null);
  const [asking, setAsking] = useState(false);
  const diaLaunched = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const recheckAccess = async () => {
    if (!api) return;
    if (step === "safari") return setFullDiskAccess(api.safariHasFullDiskAccess());
    const list = await api.listBrowsers().catch(() => null);
    if (!list) return;
    setBrowsers(list);
    const updated = list.find((b) => b.id === source?.id);
    if (updated && !updated.needsFullDiskAccess) {
      choose(updated);
      setStep("choose");
    }
  };

  const choose = (b: BrowserSource) => {
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
    if (b.family === "safari" && api) setFullDiskAccess(api.safariHasFullDiskAccess());
    setDia(null);
    setExtensions({ profileId: "", list: [] });
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

  const allSpaces: (SpaceSummary & { profileId: string })[] = (source?.profiles ?? []).flatMap((p) => (p.spaces ?? []).map((s) => ({ ...s, profileId: p.id })));
  const isArc = source?.family === "arc";
  const isDiaTabs = source?.family === "automation";

  const next = () => {
    if (!source) return;
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
    if ((step === "choose" || step === "profiles") && ENCRYPTED.some((k) => kinds.has(k)) && source.needsKeychain && api && !api.isBrowserUnlocked(source.id)) {
      return setStep("unlock");
    }
    void run(kinds);
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
      setError(`macOS didn't allow access to ${source.name}'s keychain item. Try again, or skip the encrypted data.`);
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

  const destination = async (index: number, name: string, color?: string, emoji?: string): Promise<string> => {
    if (index === 0) return target;
    const s = useBrowser.getState();
    const clash = s.profileOrder.find((id) => s.profiles[id]!.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (clash) {
      const { confirmed } = await confirm({
        title: "Import as new profile?",
        message:
          "Import this data as a new profile to avoid data loss. If you replace a profile, your passwords, cookies, and payment info will be replaced, while your bookmarks and history will be combined.",
        confirmTitle: "Import as new profile",
        cancelTitle: "Replace this profile",
      });
      if (!confirmed) return clash;
    }
    return s.createProfile({ name, color: profileColorFor(color) as ProfileColor | undefined, icon: emoji ?? null });
  };

  const finish = () => setTimeout(() => setStep("done"), DONE_DELAY_MS);

  const run = async (wanted: Set<ImportKind>) => {
    if (!api || !source) return;
    const selected = source.profiles.filter((p) => sourceProfiles.includes(p.id) || (isArc && p.spaces?.some((s) => spaces.includes(s.id))));
    const requested: ImportKind[] = [...wanted];
    if (isArc && requested.includes("tabs")) requested.push("spaces", "pinnedTabs");
    const order = KINDS.map((k) => k.kind).filter((k) => requested.includes(k));
    setStatus(Object.fromEntries(order.map((k) => [k, "pending"])));
    setPreparing(isArc ? Math.max(1, spaces.length) : selected.length);
    setStep("progress");
    abort.current = new AbortController();
    const total = emptyCounts();
    const failed = new Map<ImportKind, string[]>();
    const add = (c: ImportCounts) => (Object.keys(total) as (keyof ImportCounts)[]).forEach((k) => (total[k] += c[k]));
    let destinationIndex = 0;
    const found = new Map<string, ImportedExtension>();
    const left: string[] = [];
    let extensionsProfile = "";
    // Firefox keeps no keychain key: without a primary password its logins open as they are.
    if (source.family === "firefox" && requested.includes("passwords") && !api.isBrowserUnlocked(source.id)) {
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

      // Arc: each space goes to its own profile, the first holding the rest of the profile's data.
      let dest: string;
      if (isArc) {
        let first: string | null = null;
        for (const space of result.spaces) {
          const name = space.name || "Space";
          const spaceDest = await destination(destinationIndex++, name, space.color, space.emoji);
          if (first === null) first = spaceDest;
          add({ ...emptyCounts(), tabs: importArcSpace(spaceDest, space) });
        }
        dest = first ?? (await destination(destinationIndex++, result.profile?.name ?? profile.name, result.profile?.color));
      } else {
        dest = await destination(destinationIndex++, result.profile?.name ?? profile.name, result.profile?.color ?? profile.color);
      }
      add(await applyResult(dest, result, source.name, refused));
      if (!extensionsProfile) extensionsProfile = dest;
      if (source.family === "chromium" || source.family === "arc") {
        for (const e of await api.listExtensions(source.id, profile.id).catch(() => [])) found.set(e.id, e);
      }
    }
    setExtensions({ profileId: extensionsProfile, list: [...found.values()] });
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
      total.tabs += importDiaProfile(dest, p, { pinned: wanted.has("pinnedTabs"), open: wanted.has("tabs") });
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
      setError(code === "locked" ? `${APP_NAME} still doesn't have Full Disk Access. Grant it above, or use the export file below.` : "Couldn't read Safari's data. Try the export file below.");
      setFullDiskAccess(api.safariHasFullDiskAccess());
      return;
    }
    setStatus({ bookmarks: "done", history: "done", tabs: "done", ...(safariCookies ? { cookies: failed.includes("cookies") ? "failed" : ("done" as const) } : {}) });
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
      const n = importBookmarks(target, root, "HTML File");
      setCounts({ ...emptyCounts(), bookmarks: n });
      setFailures([]);
      setStatus({ bookmarks: "done" });
      setSource(null);
      setStep("done");
    } catch {
      setError("The selected file is invalid. Please try again.");
    }
  };

  const openExtensions = () => {
    openInWebStore(extensions.profileId || target, extensions.list.map((e) => e.webStoreUrl));
    setExtensions({ profileId: "", list: [] });
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
        setBrowsers(list);
        const first = list.find((b) => !b.needsFullDiskAccess && !b.requiresExport && b.family !== "automation") ?? list[0];
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
    extensions: extensions.list,
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
  const s = useBrowser.getState();
  const w = s.windows[s.ui.focusedWindowId ?? ""];
  return w && !w.incognito ? w.profileId : s.settings.defaultProfileId;
}
