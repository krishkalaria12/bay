import { describe, expect, it } from "bun:test";
import { Session, Tab, PageLoadTimeout, WaitTimeout } from "../src/browser.ts";
import { EndpointError } from "../src/endpoint.ts";
import type { CdpListener } from "../src/cdp.ts";

function fixture() {
  const session = new Session({ ws: "ws://127.0.0.1:1/devtools/browser/test", source: "test", explicit: true, active: null });
  const tab = new Tab(session, "target");
  const listeners = new Set<CdpListener>();
  session.cdp.addListener = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  session.cdp.send = async (method, params) => {
    if (method === "Target.attachToTarget") return { sessionId: "target-session" };
    if (method === "Page.navigate") emit("Page.loadEventFired", "unrelated-session");
    if (method === "Runtime.evaluate") return { result: { value: params?.expression === "document.visibilityState" ? "visible" : "loading" } };
    return {};
  };
  function emit(method: string, id = "target-session", params = {}) {
    for (const listener of listeners) listener(method, params, id);
  }
  return { session, tab, emit };
}

describe("browser sessions", () => {
  it("ignores other tabs' load events in goto", async () => {
    const { tab } = fixture();
    await expect(tab.goto("https://example.com", { timeout: 1 })).rejects.toBeInstanceOf(PageLoadTimeout);
  });
  it("ignores other tabs' navigation events", async () => {
    const { tab, emit } = fixture();
    await expect(tab.expectNavigation(async () => emit("Page.loadEventFired", "other"), 1)).rejects.toBeInstanceOf(WaitTimeout);
  });
  it("accepts the target tab's navigation events", async () => {
    const { tab, emit } = fixture();
    await tab.expectNavigation(async () => emit("Page.loadEventFired"), 1);
  });
  it("counts a redirect as one pending network request", async () => {
    const { tab, emit } = fixture();
    const idle = tab.waitForNetworkIdle({ timeout: 200, idle: 20 });
    await Bun.sleep(5);
    emit("Network.requestWillBeSent", "target-session", { requestId: "redirect" });
    emit("Network.requestWillBeSent", "target-session", { requestId: "redirect" });
    emit("Network.loadingFinished", "target-session", { requestId: "redirect" });
    await idle;
  });
  it("renders a tab as shown once, before its first real input", async () => {
    const { session, tab } = fixture();
    const sent: string[] = [];
    const send = session.cdp.send;
    session.cdp.send = async (method, ...rest) => {
      sent.push(method);
      if (method === "Emulation.setFocusEmulationEnabled") throw new Error("refused by an older Bay");
      return send.call(session.cdp, method, ...rest);
    };
    await tab.send("Runtime.evaluate", { expression: "1" });
    expect(sent).not.toContain("Emulation.setFocusEmulationEnabled");
    await tab.pressKey("a");
    await tab.pressKey("Enter");
    expect(sent.filter((method) => method === "Emulation.setFocusEmulationEnabled")).toHaveLength(1);
    expect(sent.indexOf("Emulation.setFocusEmulationEnabled")).toBeLessThan(sent.indexOf("Input.dispatchKeyEvent"));
  });
  it("reports connection failure as an endpoint error", async () => {
    const { session } = fixture();
    session.cdp.open = async () => {
      throw new Error("connection refused");
    };
    await expect(session.connect()).rejects.toBeInstanceOf(EndpointError);
  });
  it("escapes both quote kinds in a text selector", async () => {
    const { tab } = fixture();
    let expression = "";
    tab.evaluate = async <T>(source: string) => {
      expression = source;
      return true as T;
    };
    await tab.find({ text: `both "double" and 'single' quotes` });
    const literal = `concat('both "double" and ', "'", 'single', "'", ' quotes')`;
    expect(expression).toContain(JSON.stringify(literal).slice(1, -1));
  });
  it("writes attribute names as HTML does", async () => {
    const { tab } = fixture();
    const expressions: string[] = [];
    tab.evaluate = async <T>(source: string) => {
      expressions.push(source);
      return true as T;
    };
    await tab.find({ tagName: "button", dataTestid: "save", aria_label: "Save" });
    expect(expressions.join("\n")).toContain(JSON.stringify(`button[data-testid="save"][aria-label="Save"]`));
  });
});
