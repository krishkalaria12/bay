import { createSpace } from "../../runtime/spaceActions";
import type { BrowserProfile, BrowserSource, DiaAutomationStatus, DiaTabsResult, ImportKind, ImportProgress, SpaceSummary } from "@bay/import";
import { closeWindow, confirm } from "@bay/desktop";
import { platformOS } from "@bay/platform";
import * as Effect from "effect/Effect";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { runWindow } from "../../effect/windowRuntime";
import { APP_NAME } from "../../lib/constants";
import { useBrowserRead as useBrowser } from "../../store/read";
import type { SpaceColor } from "../../store/types";
import { IMPORT_WINDOW_ID, useImportRequest } from "../settings/windows";
import { emptyCounts, importDiaProfile, openInWebStore, profileColorFor, type ImportCounts, type ExtensionFailure } from "./apply";
import { DONE_DELAY_MS, ENCRYPTED, KINDS, kindsWithoutUnlock } from "./constants";
import { importModule } from "./module";
import { ImportFailure, ImportUnavailable, ImportWorkflow, type Workflow } from "./workflow";

// The workflow's answers come from the runtime, so the service stays the only way to the native module.
const ask = <A, E>(use: (w: Workflow) => Effect.Effect<A, E>): Promise<A> =>
  runWindow(
    Effect.gen(function* () {
      const w = yield* ImportWorkflow;

      return yield* use(w);
    }),
  );

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
  const abort = useRef<AbortController | null>(null);
  const requested = useImportRequest((s) => s.browserId);

  const recheckAccess = async () => {
    if (!api) return;

    if (step === "safari") {
      const access = await ask((w) => w.safariAccess());

      return setFullDiskAccess(access);
    }

    const list = await ask((w) => w.listBrowsers()).catch(() => null);

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

    if (b.family === "safari") void ask((w) => w.safariAccess()).then(setFullDiskAccess);
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
  // Linux's basic store needs no keyring: the encrypted data comes without one.
  const basicStore = platformOS === "linux" && source?.family === "chromium";

  const next = async () => {
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

    if (
      (step === "choose" || step === "profiles") &&
      ENCRYPTED.some((k) => kinds.has(k)) &&
      source.needsKeychain &&
      !(await ask((w) => w.unlocked(source.id)))
    ) {
      return setStep("unlock");
    }

    void run(kinds);
  };

  const unlock = async () => {
    if (!source) return;
    setUnlocking(true);

    try {
      await ask((w) => w.unlock(source.id));
      setUnlocking(false);
      void run(kinds);
    } catch {
      setUnlocking(false);
      setError(`macOS didn't allow access to ${source.name}'s keychain item. Try again, or skip the encrypted data.`);
    }
  };

  // Addresses need no key; cards, passwords and cookies do (the importer skips cards with a warning).
  const skipEncrypted = () => {
    const without = kindsWithoutUnlock(kinds, basicStore);
    setKinds(without);
    void run(without);
  };

  const destination = async (index: number, name: string, color?: string, emoji?: string, used?: Set<string>): Promise<string> => {
    if (index === 0) return target;
    const s = useBrowser.getState();
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
    // SAFETY: SpaceColor | undefined, icon assertion matches the runtime value validated at this call site.
    return createSpace({ name, color: profileColorFor(color) as SpaceColor | undefined, icon: emoji });
  };

  const finish = () => setTimeout(() => setStep("done"), DONE_DELAY_MS);

  const run = async (wanted: Set<ImportKind>) => {
    if (!source) return;
    const selected = source.profiles.filter((p) => sourceProfiles.includes(p.id) || (isArc && p.spaces?.some((s) => spaces.includes(s.id))));
    const requested: ImportKind[] = [...wanted];

    if (isArc && requested.includes("tabs")) requested.push("spaces", "pinnedTabs");

    if (isArc && requested.includes("extensions") && !requested.includes("spaces")) requested.push("spaces");
    const order = KINDS.map((k) => k.kind).filter((k) => requested.includes(k));
    setStatus(Object.fromEntries(order.map((k) => [k, "pending"])));
    setPreparing(isArc ? Math.max(1, spaces.length) : selected.length);
    setStep("progress");
    const controller = new AbortController();

    abort.current = controller;

    const onProgress = (p: ImportProgress) => {
      if (p.phase === "start") setStatus((st) => ({ ...st, [p.kind]: "active" }));

      if (p.phase === "end") setStatus((st) => (st[p.kind] === "failed" ? st : { ...st, [p.kind]: "done" }));
    };

    // The workflow's own scope gives the browser's keychain item back when the import ends.
    await ask((w) =>
      w.import({
        source,
        profileIds: sourceProfiles,
        spaceIds: spaces,
        kinds: wanted,
        target,
        signal: controller.signal,
        onProgress,
      }),
    ).then(
      (outcome) => {
        setExtensions(outcome.extensions);
        setNotes([
          ...outcome.notes,
          ...outcome.extensions.map((f) => `${f.extension.name} in ${useBrowser.getState().spaces[f.spaceId]?.name ?? "Space"}: ${f.message}.`),
        ]);
        // SAFETY: ImportKind) ? assertion matches the runtime value validated at this call site.
        setStatus((st) =>
          Object.fromEntries(Object.entries(st).map(([k, v]) => [k, outcome.failures.some((f) => f.kind === k) ? "failed" : v === "failed" ? v : "done"])),
        );
        setFailures(outcome.failures);
        setCounts(outcome.counts);
        finish();
      },
      (cause: unknown) => {
        // A cancelled import keeps what it brought; anything else is the native module's refusal.
        if (cause instanceof ImportFailure && cause.code === "cancelled") return;

        if (cause instanceof ImportFailure && cause.code === "unsupported") setError("Please select a folder or zip file.");
        else setError("Couldn't read that browser's data. Try again, or skip the encrypted data.");
      },
    );
  };

  const refreshDia = async () => {
    if (!api) return;
    const status = await ask((w) => w.diaStatus()).catch((): DiaAutomationStatus => "denied");
    setDiaStatus(status);

    if (status === "granted") await readDia();
  };

  const allowDia = async () => {
    if (!api) return;
    setAsking(true);
    const status = await ask((w) => w.requestDia()).catch((): DiaAutomationStatus => "denied");
    setAsking(false);
    setDiaStatus(status);

    if (status === "granted") await readDia();
  };

  const openDia = async () => {
    if (!api) return;

    await ask((w) => w.openDia()).catch(() => setError("Couldn't open Dia. Open it yourself, then click Check Again."));
    void refreshDia();
  };

  const readDia = async () => {
    if (!api) return;
    setError(null);
    setDiaStatus("reading");
    let result: DiaTabsResult;

    try {
      result = await ask((w) => w.readDiaTabs());
    } catch (e) {
      const code = errorCode(e);
      setDiaStatus(code === "notRunning" ? "notRunning" : code === "locked" ? "denied" : "granted");

      if (code !== "notRunning" && code !== "locked") {
        // SAFETY: errorCode only returns these two codes for Error instances that carry a message string.
        setError(`${(e as Error).message}. Try again.`);
      }

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
    const controller = new AbortController();

    abort.current = controller;

    await ask((w) => w.importSafari({ kind: "export", path, target, cookies: safariCookies, signal: controller.signal })).then(
      (outcome) => {
        setStatus({ bookmarks: "done", history: "done", passwords: "done", autofill: outcome.failures.some((f) => f.kind === "autofill") ? "failed" : "done" });
        setCounts(outcome.counts);
        setFailures(outcome.failures);
        finish();
      },
      (refusal: ImportFailure | ImportUnavailable) => {
        setStep("safari");
        setError(errorCode(refusal) === "unsupported" ? "Please select a folder or zip file." : "The selected file is invalid. Please try again.");
      },
    );
  };

  const importSafariDirect = async () => {
    if (!api) return;
    setError(null);
    setStatus({ bookmarks: "active", history: "active", tabs: "active", ...(safariCookies ? { cookies: "active" as const } : undefined) });
    setPreparing(1);
    setStep("progress");
    const controller = new AbortController();

    abort.current = controller;

    await ask((w) => w.importSafari({ kind: "direct", target, cookies: safariCookies, signal: controller.signal })).then(
      (outcome) => {
        setStatus({
          bookmarks: "done",
          history: "done",
          tabs: "done",
          ...(safariCookies ? { cookies: outcome.failures.some((f) => f.kind === "cookies") ? "failed" : ("done" as const) } : undefined),
        });
        setCounts(outcome.counts);
        setFailures(outcome.failures);
        finish();
      },
      (refusal: ImportFailure | ImportUnavailable) => {
        const code = errorCode(refusal);

        if (code === "cancelled") return;

        setStep("safari");
        setError(
          code === "locked"
            ? `${APP_NAME} still doesn't have Full Disk Access. Grant it above, or use the export file below.`
            : "Couldn't read Safari's data. Try the export file below.",
        );
        void ask((w) => w.safariAccess()).then(setFullDiskAccess);
      },
    );
  };

  // Onboarding's handoff: the chosen profiles or spaces and every kind, straight away. The keychain's prompt is
  // the one stop on the way; what else needs asking (Full Disk Access, Dia's permission) stays in the import window.
  const importNow = async () => {
    if (!api || !source) return;
    setError(null);

    if (source.family === "safari") return void importSafariDirect();

    if (ENCRYPTED.some((k) => kinds.has(k)) && source.needsKeychain && !(await ask((w) => w.unlocked(source.id)))) return void unlock();
    void run(kinds);
  };

  const chooseSafariExport = async () => (await ask((w) => w.chooseFile("safariExport"))) ?? null;

  const importHtml = async () => {
    if (!api) return;
    const path = await ask((w) => w.chooseFile("bookmarksHTML"));

    if (!path) return;

    await ask((w) => w.importHtml(path, target)).then(
      (imported) => {
        setCounts(imported);
        setFailures([]);
        setStatus({ bookmarks: "done" });
        setSource(null);
        setStep("done");
      },
      () => setError("The selected file is invalid. Please try again."),
    );
  };

  const openExtensions = () => {
    const bySpace = new Map<string, Set<string>>();

    for (const { spaceId, extension } of extensions) {
      if (!extension.webStoreUrl) continue;

      if (!bySpace.has(spaceId)) bySpace.set(spaceId, new Set());
      bySpace.get(spaceId)!.add(extension.webStoreUrl);
    }

    for (const [spaceId, urls] of bySpace) openInWebStore(spaceId, [...urls]);
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
    // Dia isn't running: the workflow waits for it, and stops waiting when the flow moves on or closes.
    const waiting = new AbortController();

    if (diaStatus === "notRunning") {
      void ask((w) => w.waitForDia(waiting.signal)).then(
        (status) => {
          if (!waiting.signal.aborted && status !== "notRunning") void refreshDia();
        },
        () => {},
      );
    }

    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && (diaStatus === "denied" || diaStatus === "notRunning")) void refreshDia();
    });

    return () => {
      waiting.abort();
      sub.remove();
    };
  }, [step, diaStatus, api]);

  // Opened again for another browser while it shows the list: switch to that one.
  useEffect(() => {
    const b = requested ? browsers.find((x) => x.id === requested) : undefined;

    if (b && step === "choose" && b.id !== source?.id) choose(b);
  }, [requested]);

  useEffect(() => {
    if (!api) return setStep("choose");
    void ask((w) => w.listBrowsers())
      .then((list) => {
        setBrowsers(list);

        const first =
          list.find((b) => b.id === useImportRequest.getState().browserId) ??
          list.find((b) => !b.needsFullDiskAccess && !b.requiresExport && b.family !== "automation") ??
          list[0];

        if (first) choose(first);
        setStep("choose");
      })
      .catch(() => setStep("choose"));

    return () => {
      abort.current?.abort();
      void ask((w) => w.forgetUnlockedKeys());
    };
  }, []);

  useEffect(() => {
    if (!__DEV__) return;
    // SAFETY: { nnImport? assertion matches the runtime value validated at this call site.
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
    basicStore,
    recheckAccess,
    refreshDia,
    allowDia,
    openDia,
    readDia,
    importSafari,
    importSafariDirect,
    importNow,
    chooseSafariExport,
    importHtml,
    openExtensions,
    openFullDiskAccessSettings: () => void api?.openFullDiskAccessSettings(),
    openAutomationSettings: () => void api?.openAutomationSettings(),
    close,
    cancel,
  };
}

// SAFETY: { code? assertion matches the runtime value validated at this call site.
const errorCode = (cause: unknown) => (cause as { code?: string }).code;

function defaultTarget(): string {
  const s = useBrowser.getState();
  const w = s.windows[s.ui.focusedWindowId ?? ""];

  return w && !w.incognito ? w.spaceId : s.settings.defaultSpaceId;
}
