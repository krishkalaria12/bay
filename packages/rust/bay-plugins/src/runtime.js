// Bay's plugin runtime (packages/rust/bay-plugins): the `bay` object a plugin's script uses inside its sandbox, which
// loads this before the script. It only carries messages: Bay checks every call against the plugin's manifest
// (apps/browser/src/lib/plugins), so nothing here is a safeguard.
//
// To Bay: {t:"call",n,m,a} (a method and its arguments), {t:"done",n,ok,v|e} (a run's answer), {t:"ready"} and
// {t:"log",level,text}. From Bay: {t:"reply",n,ok,v|e}, {t:"run",n,k,id,a} (run a handler) and {t:"event",name,data}.
(() => {
  "use strict";

  const webkit = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bay;

  const send = (message) => {
    const text = JSON.stringify(message);

    if (webkit) webkit.postMessage(text);
    else window.parent.postMessage(text, "chrome://bay");
  };

  const handlers = { command: new Map(), source: new Map(), item: new Map(), links: null };
  const listeners = { settings: [] };
  const pending = new Map();
  let next = 0;

  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const n = ++next;
      pending.set(n, { resolve, reject });
      send({ t: "call", n, m: method, a: args });
    });

  const errorText = (error) => String((error && error.message) || error || "Error").slice(0, 2000);

  async function run({ n, k, id, a }) {
    const handler = k === "links" ? handlers.links : handlers[k] && handlers[k].get(id);

    try {
      if (!(handler instanceof Function)) throw new Error(`The plugin doesn't handle ${k} "${id}"`);
      const value = await handler(a);
      send({ t: "done", n, ok: true, v: value === undefined ? null : value });
    } catch (error) {
      send({ t: "done", n, ok: false, e: errorText(error) });
    }
  }

  function deliver(text) {
    let message;

    try {
      message = JSON.parse(String(text));
    } catch {
      return;
    }

    if (!(message instanceof Object)) return;

    if (message.t === "reply") {
      const waiting = pending.get(message.n);

      if (!waiting) return;
      pending.delete(message.n);

      if (message.ok) waiting.resolve(message.v);
      else waiting.reject(new Error(message.e || "Bay refused the call"));
    } else if (message.t === "run") void run(message);
    else if (message.t === "event" && message.name === "settings") {
      for (const listener of listeners.settings) {
        try {
          listener(message.data);
        } catch (error) {
          send({ t: "log", level: "error", text: errorText(error) });
        }
      }
    }
  }

  if (webkit) Object.defineProperty(window, "__bayDeliver", { value: deliver });
  else
    window.addEventListener("message", (event) => {
      if (event.source === window.parent && event.origin === "chrome://bay") deliver(event.data);
    });

  const on = (map) => (id, handler) => {
    if (!(handler instanceof Function)) throw new TypeError("A handler is a function");
    map.set(String(id), handler);
  };

  // Bay answers with the body as text; this gives it the shape of fetch's Response.
  async function bayFetch(url, init = {}) {
    const headers = {};

    for (const [key, value] of Object.entries(init.headers || {})) headers[String(key)] = String(value);
    const body = init.body === undefined || init.body === null ? null : String(init.body);
    const answer = await call("fetch", String(url), { method: String(init.method || "GET").toUpperCase(), headers, body });
    const lower = Object.fromEntries(Object.entries(answer.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

    return Object.freeze({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      url: answer.url,
      headers: Object.freeze({ get: (name) => lower[String(name).toLowerCase()] ?? null }),
      text: async () => answer.body,
      json: async () => JSON.parse(answer.body),
    });
  }

  const bay = Object.freeze({
    commands: Object.freeze({ on: on(handlers.command) }),
    liveSources: Object.freeze({ on: on(handlers.source), refresh: (id) => call("live.refresh", String(id)) }),
    views: Object.freeze({ set: (id, items) => call("view.set", String(id), items), onSelect: on(handlers.item) }),
    toolbar: Object.freeze({ set: (id, state) => call("toolbar.set", String(id), state || {}) }),
    links: Object.freeze({
      decide(handler) {
        if (!(handler instanceof Function)) throw new TypeError("A handler is a function");
        handlers.links = handler;
      },
    }),
    tabs: Object.freeze({ open: (url, options) => call("tabs.open", String(url), options || {}), active: () => call("tabs.active") }),
    settings: Object.freeze({
      get: () => call("settings.get"),
      onChange(listener) {
        if (!(listener instanceof Function)) throw new TypeError("A listener is a function");
        listeners.settings.push(listener);
      },
    }),
    storage: Object.freeze({
      get: (key) => call("storage.get", String(key)),
      set: (key, value) => call("storage.set", String(key), value === undefined ? null : value),
    }),
    notify: (message) => call("notify", String(message)),
    fetch: bayFetch,
  });

  Object.defineProperty(window, "bay", { value: bay, enumerable: true });
  window.addEventListener("error", (event) => send({ t: "log", level: "error", text: errorText(event.error || event.message) }));
  window.addEventListener("unhandledrejection", (event) => send({ t: "log", level: "error", text: errorText(event.reason) }));
  window.addEventListener("load", () => send({ t: "ready" }));
})();
