import { WindowContext } from "@bay/platform";
import { useEffect, useState } from "react";
import { AppRegistry } from "react-native";
import { WindowRoot } from "./App";
import { DevErrorBoundary } from "./DevErrorBoundary";
import { perfMark } from "./lib/perfProbe";

type WindowApplicationOptions = { onFirstMount?: () => void };

// Register the window UI separately from the application's global services.
// Native macOS startup supplies its existing first-window telemetry callback;
// a web window can mount without starting those services again.
export function registerWindowApplication({ onFirstMount }: WindowApplicationOptions = {}) {
  function Root({ windowId }: { windowId: string }) {
    return (
      <WindowContext.Provider value={windowId}>
        <RootContents windowId={windowId} onFirstMount={onFirstMount} />
      </WindowContext.Provider>
    );
  }

  AppRegistry.registerComponent("main", () => Root);
}

// Development: `globalThis.nnDevMountDelayMs` holds a window's content back that long after its root starts, as a
// window opened under load mounts late (acceptance move-tab-slow-mount).
const devMountDelay = () => (__DEV__ ? ((globalThis as { nnDevMountDelayMs?: number }).nnDevMountDelayMs ?? 0) : 0);

function RootContents({ windowId, onFirstMount }: { windowId: string; onFirstMount?: () => void }) {
  const [delay] = useState(devMountDelay);
  const [held, setHeld] = useState(delay > 0);
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), delay);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    perfMark("firstWindow");
    onFirstMount?.();
  }, []);
  if (held) return null;
  return __DEV__ ? (
    <DevErrorBoundary>
      <WindowRoot windowId={windowId} />
    </DevErrorBoundary>
  ) : (
    <WindowRoot windowId={windowId} />
  );
}
