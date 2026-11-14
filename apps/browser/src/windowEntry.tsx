import { Pressable, View, WindowContext } from "@bay/platform";
import { useEffect, useState } from "react";
import { AppRegistry, Platform, Text } from "react-native";
import { WindowRoot } from "./App";
import { DevErrorBoundary } from "./DevErrorBoundary";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
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
// SAFETY: the checks above established this shape.
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
    <ErrorBoundary fallback={<WindowFailed />}>
      <WindowRoot windowId={windowId} />
    </ErrorBoundary>
  );
}

// A window whose interface threw says so instead of going blank. The web interface can load itself again.
function WindowFailed() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: "#1b1b1b" }}>
      <Text style={{ color: "#ebebeb", fontSize: 14 }}>This window ran into a problem.</Text>
      {Platform.OS === "web" && (
        <Pressable
          accessibilityRole="button"
          onPress={() => location.reload()}
          style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: "#ffffff1f" }}
        >
          <Text style={{ color: "#ebebeb", fontSize: 13 }}>Reload Window</Text>
        </Pressable>
      )}
    </View>
  );
}
