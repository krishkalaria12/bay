import { startAccountRequests } from "../activity/sources";
import { stopServiceCommands } from "./serviceExecutor";
import type { DeepReadonly } from "./projection";
import { useTelemetry } from "../telemetry/client";
import type { BrowserStore } from "../store/browserStore";
import { useLive, type LiveState } from "../activity/activityStore";
import { useCalendar, type CalendarData } from "../activity/calendar";
import { useMeetingAlert } from "../activity/meetingAlerts";
import { useSync, type SyncUi } from "../sync/engine";
import { bindLiveBrowser } from "../activity/activityEngine";
import { bindGoogleBrowser } from "../activity/googleAuth";
import { useOnboardingRequest, type OnboardingRequest } from "./onboardingRequest";
import { useCli } from "../components/cli/driverControl";
import type { ActiveSwitch, CliAgents, CliControlStatus } from "@bay/chromium";
import { useKillSwitches } from "../lib/killSwitches";
import { useCliAgents } from "../components/cli/agentApprovals";
import { useSharedFolders, type SharedFolderStatus } from "../lib/sharedFolderService";
import { usePlugins, type PluginsState } from "../lib/plugins/pluginStore";

/** UI state only. OAuth tokens and the sync document never enter this value. */
export type ServiceState = {
  live: LiveState;
  calendar: CalendarData;
  alerts: ReturnType<typeof useMeetingAlert.getState>;
  sync: SyncUi;
  telemetry: ReturnType<typeof useTelemetry.getState>;
  onboarding: OnboardingRequest;
  cli: CliControlStatus | null;
  // Remote kill switches, coding agents' access, and folders kept in shared folders: the coordinator's, which a
  // window's settings and menus read.
  switches: { active: ActiveSwitch[]; checkedAt: number | null };
  agents: CliAgents;
  sharedFolders: { folders: Record<string, SharedFolderStatus> };
  // Plugins: what they are, whether they run, and what their buttons and views show (never a secret's value).
  plugins: PluginsState;
};

// What a window's settings pane shows of terminal control. The engine's status also names its control file, which
// stays with the coordinator: the native runtime accepts only these fields from a service.
const WINDOW_CLI_FIELDS = new Set(["state", "connections", "generation", "port", "reason"]);

function windowCliStatus(server: CliControlStatus | null): CliControlStatus | null {
  if (!server) return null;

  // SAFETY: the checks above established this shape.
  return Object.fromEntries(Object.entries(server).filter(([key]) => WINDOW_CLI_FIELDS.has(key))) as CliControlStatus;
}

const installed = new Map<string, object>();

// SAFETY: the checks above established this shape.
const detach = <T>(value: DeepReadonly<T>): T => JSON.parse(JSON.stringify(value)) as T;

export function installServiceState(state: DeepReadonly<Partial<ServiceState>>) {
  const install = <K extends keyof ServiceState>(key: K, apply: (value: ServiceState[K]) => void) => {
    const value = state[key];

    if (!value || installed.get(key) === value) return;
    installed.set(key, value);
    apply(detach<ServiceState[K]>(value));
  };

  install("live", (value) => useLive.setState(value, true));
  install("calendar", (value) => useCalendar.setState(value, true));
  install("alerts", (value) => useMeetingAlert.setState(value, true));
  install("sync", (value) => useSync.setState(value, true));
  install("telemetry", (value) => useTelemetry.setState(value, true));
  install("onboarding", (value) => useOnboardingRequest.setState(value, true));
  install("cli", (server) => useCli.setState({ server }));
  install("switches", (value) => useKillSwitches.setState(value, true));
  install("agents", (value) => useCliAgents.setState(value, true));
  install("sharedFolders", (value) => useSharedFolders.setState(value, true));
  install("plugins", (value) => usePlugins.setState(value, true));
}

export function startServiceStateOwner(store: BrowserStore, { restore = true } = {}): () => void {
  if (restore) installServiceState(store.getState().services);
  const stops = [bindLiveBrowser(store), bindGoogleBrowser(store), startAccountRequests(), stopServiceCommands];

  const publish = () => {
    const services: ServiceState = {
      live: useLive.getState(),
      calendar: useCalendar.getState(),
      alerts: useMeetingAlert.getState(),
      sync: useSync.getState(),
      telemetry: useTelemetry.getState(),
      onboarding: useOnboardingRequest.getState(),
      cli: windowCliStatus(useCli.getState().server),
      switches: { active: [...useKillSwitches.getState().active], checkedAt: useKillSwitches.getState().checkedAt },
      agents: useCliAgents.getState(),
      sharedFolders: { folders: { ...useSharedFolders.getState().folders } },
      plugins: usePlugins.getState(),
    };

    store.setState({ services });
  };

  stops.push(
    useLive.subscribe(publish),
    useCalendar.subscribe(publish),
    useMeetingAlert.subscribe(publish),
    useSync.subscribe(publish),
    useTelemetry.subscribe(publish),
    useOnboardingRequest.subscribe(publish),
    useCli.subscribe(publish),
    useKillSwitches.subscribe(publish),
    useCliAgents.subscribe(publish),
    useSharedFolders.subscribe(publish),
    usePlugins.subscribe(publish),
  );
  publish();

  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
