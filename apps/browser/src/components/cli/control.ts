import { cliControlStatus, onCliControlChanged, setCliActiveTab, setCliControl, type CliControlStatus } from "@bay/nncore";
import { installedCliVersion, installCli, onCliInstallLine, readDocument, writeDocument, type CliInstallResult } from "@bay/shell";
import { create } from "zustand";
import { useBrowser, type BrowserState } from "../../store/browser";
import { tabEngine } from "../../store/engines";
import { activeTabId } from "../../store/model";
import { shownPeek } from "../../store/peeks";
import { pageOf, usePages } from "../layout/pageState";

const INSTALL_DOC = "bay-cli.json";

type SavedInstall = { binPath?: string; error?: string };
function savedInstall(): SavedInstall {
  try {
    const saved: unknown = JSON.parse(readDocument(INSTALL_DOC) ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    const record = saved as Record<string, unknown>;
    return { binPath: typeof record.binPath === "string" ? record.binPath : undefined, error: typeof record.error === "string" ? record.error : undefined };
  } catch {
    return {};
  }
}

const saved = savedInstall();
export const useCli = create<{
  server: CliControlStatus | null;
  installing: boolean;
  step: string | null;
  installedVersion: string | null;
  binPath: string | null;
  error: string | null;
}>()(() => ({
  server: null,
  installing: false,
  step: null,
  installedVersion: installedCliVersion(),
  binPath: saved.binPath ?? null,
  error: saved.error ?? null,
}));

let installation: Promise<CliInstallResult> | null = null;
export function installCliInBackground(): Promise<CliInstallResult> {
  if (installation) return installation;
  useCli.setState({ installing: true, step: null, error: null });
  const lines = onCliInstallLine((line) => {
    const step = /^step (\S+)/.exec(line)?.[1];
    if (step) useCli.setState({ step });
  });
  installation = installCli()
    .catch((error: unknown): CliInstallResult => ({ ok: false, appVersion: "", error: message(error), lines: [] }))
    .then((result) => {
      lines.remove();
      installation = null;
      const error = result.ok ? null : (result.error ?? "The installer stopped.");
      const binPath = result.binPath ?? useCli.getState().binPath;
      useCli.setState({ installing: false, step: null, installedVersion: installedCliVersion(), binPath, error });
      try {
        writeDocument(INSTALL_DOC, JSON.stringify({ version: 1, binPath, error }));
      } catch (error) {
        console.warn("[cli] couldn't save the install status", error);
      }
      return result;
    });
  return installation;
}

export function describeCliInstall(state: ReturnType<typeof useCli.getState>): string {
  if (state.installing) return state.step ? `Installing (${state.step})…` : "Installing…";
  if (state.error) return state.error;
  if (state.installedVersion) return state.binPath ? `Installed at ${state.binPath}` : `Version ${state.installedVersion} is installed.`;
  return "Run Bay from your terminal with TypeScript or JavaScript.";
}

export function describeCliControl(server: CliControlStatus | null): string {
  if (server?.reason) return server.reason;
  if (server?.state === "starting") return "Starting terminal control…";
  if (server?.state === "external") return "This development instance uses an explicit debugging port.";
  if (server?.state === "on" && server.connections) return `${server.connections} ${server.connections === 1 ? "command is" : "commands are"} connected.`;
  return "Commands can read and interact with open Chromium pages and install userscripts. Turning this off disconnects them.";
}

/** The current pane, including a Peek over it, once its Chromium page exists. */
export function shownCliTab(s: BrowserState): number | null {
  const windowId = s.ui.focusedWindowId;
  if (!windowId || !s.windows[windowId]) return null;
  const id = shownPeek(s, windowId)?.tabId ?? activeTabId(s, windowId);
  const tab = id ? s.tabs[id] : undefined;
  if (
    !id ||
    !tab ||
    !/^(https?|about|data|blob):/i.test(tab.url) ||
    !(tab.navigation || tab.adoptId) ||
    tabEngine(s, id) !== "chromium" ||
    pageOf(id).newTabShown
  )
    return null;
  return usePages.getState().chromeTabs[id] ?? null;
}

let started = false;
export function startCliControl() {
  if (started) return;
  started = true;
  let request = 0;
  let inFlight = 0;
  let generation = 0;
  let applied: boolean | null = null;
  let sentActive: number | null | undefined;

  const pushActive = () => {
    const server = useCli.getState().server;
    if (server?.state !== "on" && server?.state !== "starting") {
      sentActive = undefined;
      return;
    }
    const active = shownCliTab(useBrowser.getState());
    if (active === sentActive) return;
    sentActive = active;
    void setCliActiveTab(active).catch(() => {
      sentActive = undefined;
    });
  };

  const apply = (server: CliControlStatus, reconcile: boolean) => {
    if ((server.generation ?? generation) < generation) return;
    if ((server.generation ?? generation) > generation) sentActive = undefined;
    generation = Math.max(generation, server.generation ?? 0);
    useCli.setState({ server });
    if (reconcile && server.state === "off" && server.reason && useBrowser.getState().settings.cliControl === true) {
      useBrowser.getState().updateSettings({ cliControl: false });
    }
    pushActive();
  };
  onCliControlChanged((server) => apply(server, inFlight === 0));

  const sync = () => {
    const on = useBrowser.getState().settings.cliControl === true;
    if (on === applied) return;
    const first = applied === null;
    applied = on;
    const mine = ++request;
    inFlight++;
    const settle = (server: CliControlStatus) => {
      inFlight--;
      if (mine === request) apply(server, true);
    };
    void (first && !on ? cliControlStatus() : setCliControl(on)).then(settle, (error: unknown) => settle({ state: "off", reason: message(error) }));
  };
  useBrowser.subscribe(() => {
    sync();
    pushActive();
  });
  usePages.subscribe(pushActive);
  sync();
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
