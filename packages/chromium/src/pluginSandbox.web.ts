// A plugin's sandbox on Windows and Linux: a hidden frame of the coordinator's document at
// chrome-untrusted://bay-plugin/<id>/, which the engine serves from the plugin's folder (webui/plugins.cc). Its
// policy sandboxes it into a unique origin with no network, and the engine runs it in a renderer process apart from
// Bay's. The two talk by postMessage; a frame's messages are known by the window they come from.

export type PluginSandbox = { post(message: string): void; stop(): void };

export type PluginSandboxEvents = { message(text: string): void; exit(reason: string): void };

const frames = new Map<string, { frame: HTMLIFrameElement; events: PluginSandboxEvents }>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event) => {
    for (const { frame, events } of frames.values()) if (event.source === frame.contentWindow) return events.message(String(event.data));
  });
}

/** Opens plugin `id`'s sandbox; null outside a document. */
export function startPluginSandbox(id: string, events: PluginSandboxEvents): PluginSandbox | null {
  if (!("document" in globalThis) || !document.body) return null;
  listen();
  frames.get(id)?.frame.remove();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.display = "none";
  frame.src = `chrome-untrusted://bay-plugin/${encodeURIComponent(id)}/__bay/host.html`;
  frame.addEventListener("error", () => events.exit("didn't start"));
  frames.set(id, { frame, events });
  document.body.appendChild(frame);

  return {
    // The frame's origin is opaque, so there's no origin to name; the message goes to its window only.
    post: (message) => frame.contentWindow?.postMessage(message, "*"),
    stop: () => {
      if (frames.get(id)?.frame === frame) frames.delete(id);
      frame.remove();
    },
  };
}
