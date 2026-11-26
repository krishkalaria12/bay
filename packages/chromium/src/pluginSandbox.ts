import { PluginsNative, type PluginSandboxEvent } from "./plugins";

// A plugin's sandbox on macOS: a WebKit page of its own (ios/PluginsModule.swift), out of process. Windows and Linux:
// pluginSandbox.web.ts.

export type PluginSandbox = { post(message: string): void; stop(): void };

export type PluginSandboxEvents = { message(text: string): void; exit(reason: string): void };

const running = new Map<string, PluginSandboxEvents>();
let subscriptions: { remove(): void }[] = [];

function listen() {
  if (subscriptions.length || !PluginsNative?.addListener) return;

  const route = (kind: "message" | "exit") => (event: PluginSandboxEvent) => {
    const events = running.get(event.id);

    if (kind === "message" && event.message !== undefined) events?.message(event.message);
    else if (kind === "exit") {
      running.delete(event.id);
      events?.exit(event.reason ?? "stopped");
    }
  };

  subscriptions = [PluginsNative.addListener("onMessage", route("message")), PluginsNative.addListener("onExit", route("exit"))];
}

/** Opens plugin `id`'s sandbox; null where this host can't run one. */
export function startPluginSandbox(id: string, events: PluginSandboxEvents): PluginSandbox | null {
  const native = PluginsNative;

  if (!native?.start || !native.post || !native.stop) return null;
  listen();
  running.set(id, events);
  void native.start(id).then(
    (started) => {
      if (!started && running.get(id) === events) {
        running.delete(id);
        events.exit("didn't start");
      }
    },
    () => {
      if (running.get(id) === events) running.delete(id);
      events.exit("didn't start");
    },
  );

  return {
    post: (message) => void native.post?.(id, message).catch(() => {}),
    stop: () => {
      if (running.get(id) === events) running.delete(id);
      void native.stop?.(id).catch(() => {});
    },
  };
}
