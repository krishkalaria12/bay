import * as v from "valibot";
import { isJsonObject, type JsonValue } from "../../lib/json";
import { cliControlStatus, onCliControlChanged, setCliActiveTab, setCliControl, type CliControlStatus } from "@bay/chromium";
import { installedCliVersion, installCli, onCliInstallLine, readDocument, writeDocument, type CliInstallResult } from "@bay/desktop";
import { create } from "zustand";
import { useBrowserRead as useBrowser } from "../../store/read";
import type { BrowserProjection } from "../../runtime/projection";
import { reportBrowserCommand } from "../../runtime/commands";
import { updateSettings } from "../../runtime/settingsActions";
import { tabEngine } from "../../store/engines";
import { activeTabId } from "../../store/model";
import { shownPeek } from "../../store/peeks";
import { usePages } from "../window/pageState";

const INSTALL_DOC = "bay-cli.json";

type SavedInstall = { binPath?: string; error?: string };

function savedInstall(): SavedInstall {
  try {
    const saved: JsonValue = JSON.parse(readDocument(INSTALL_DOC) ?? "{}");

    if (!isJsonObject(saved)) return {};

    return { binPath: v.is(v.string(), saved.binPath) ? saved.binPath : undefined, error: v.is(v.string(), saved.error) ? saved.error : undefined };
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
    .catch((cause: unknown): CliInstallResult => ({ ok: false, appVersion: "", error: message(cause), lines: [] }))
    .then((result) => {
      lines.remove();
      installation = null;
      const error = result.ok ? null : (result.error ?? "The installer stopped.");
      const binPath = result.binPath ?? useCli.getState().binPath;
      const installedVersion = result.installedVersion === undefined ? installedCliVersion() : result.installedVersion;
      useCli.setState({ installing: false, step: null, installedVersion, binPath, error });
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
export function shownCliTab(s: BrowserProjection): number | null {
  const windowId = s.ui.focusedWindowId;
  if (!windowId || !s.windows[windowId]) return null;
  const id = shownPeek(s, windowId)?.tabId ?? activeTabId(s, windowId);
  const tab = id ? s.tabs[id] : undefined;
  if (!id || !tab || !/^(https?|about|data|blob):/i.test(tab.url) || !(tab.navigation || tab.adoptId) || tabEngine(s, id) !== "chromium" || tab.newTabHistory)
    return null;
  return usePages.getState().chromeTabs[id] ?? null;
}

// Tells the engine the tab commands act on by default, while `owns` says this document knows it.
function activeTabPush(owns: () => boolean) {
  let sent: number | null | undefined;
  const forget = () => {
    sent = undefined;
  };
  const push = () => {
    const server = useCli.getState().server;
    if (!owns() || (server?.state !== "on" && server?.state !== "starting")) return forget();
    const active = shownCliTab(useBrowser.getState());
    if (active === sent) return;
    sent = active;
    void setCliActiveTab(active).catch(forget);
  };
  return { push, forget };
}

let started = false;
/**
 * Keeps the engine's control server on the setting. Linux's and Windows' coordinator document does this with
 * `activeTab: false`: it has no pages, and engine events reach only it, so windows get the status from its service state.
 */
export function startCliControl({ activeTab = true } = {}) {
  if (started) return;
  started = true;
  let request = 0;
  let inFlight = 0;
  let generation = 0;
  let applied: boolean | null = null;
  const { push: pushActive, forget: forgetActive } = activeTabPush(() => activeTab);

  const apply = (server: CliControlStatus, reconcile: boolean) => {
    if ((server.generation ?? generation) < generation) return;
    if ((server.generation ?? generation) > generation) forgetActive();
    generation = Math.max(generation, server.generation ?? 0);
    useCli.setState({ server });
    if (reconcile && server.state === "off" && server.reason && useBrowser.getState().settings.cliControl === true) {
      reportBrowserCommand(updateSettings({ cliControl: false }));
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

    void (first && !on ? cliControlStatus() : setCliControl(on)).then(settle, (cause: unknown) => settle({ state: "off", reason: message(cause) }));
  };

  useBrowser.subscribe(() => {
    sync();
    pushActive();
  });
  usePages.subscribe(pushActive);
  sync();
}

/** A window document on Linux and Windows: it holds its own pages, so the focused one says which tab is shown. */
export function startCliActiveTab(windowId: string) {
  const { push } = activeTabPush(() => useBrowser.getState().ui.focusedWindowId === windowId);
  useCli.subscribe(push);
  useBrowser.subscribe(push);
  usePages.subscribe(push);
  push();
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
