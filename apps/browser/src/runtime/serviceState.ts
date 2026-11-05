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
import type { CliControlStatus } from "@bay/chromium";

/** UI state only. OAuth tokens and the sync document never enter this value. */
export type ServiceState = {
  live: LiveState;
  calendar: CalendarData;
  alerts: ReturnType<typeof useMeetingAlert.getState>;
  sync: SyncUi;
  telemetry: ReturnType<typeof useTelemetry.getState>;
  onboarding: OnboardingRequest;
  cli: CliControlStatus | null;
};
const installed = new Map<string, object>();
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
      cli: useCli.getState().server,
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
  );
  publish();
  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
