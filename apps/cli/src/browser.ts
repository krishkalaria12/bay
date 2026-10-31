import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Cdp, CdpError } from "./cdp.ts";
import { EndpointError, NOT_REACHABLE, type Endpoint } from "./endpoint.ts";
import { clip, sleep, wildcardMatch } from "./util.ts";

const PAGE_SCHEMES = ["http:", "https:", "about:", "data:", "blob:"];
const CONNECT_TIMEOUT = 10_000;
const PROBE_TIMEOUT = 2000;
const NAVIGATION_TIMEOUT = 30_000;
const ELEMENT_POLL = 100;

export class NoPageTab extends Error {
  override name = "NoPageTab";
}

export class ElementNotFound extends Error {
  override name = "ElementNotFound";
}

export class WaitElementTimeout extends Error {
  override name = "WaitElementTimeout";
}

export class WaitTimeout extends Error {
  override name = "WaitTimeout";
}

export class PageLoadTimeout extends Error {
  override name = "PageLoadTimeout";
}

export class NavigationError extends Error {
  override name = "NavigationError";
}

export class ScriptEvaluationError extends Error {
  override name = "ScriptEvaluationError";
}

export type TargetInfo = { targetId: string; type: string; url: string; title: string; attached?: boolean };

export type QueryOptions = { timeout?: number; raiseExc?: boolean };
export type GotoOptions = { timeout?: number; waitUntil?: "load" | "none" };

export type FindOptions = {
  tagName?: string;
  id?: string;
  className?: string;
  name?: string;
  text?: string;
  timeout?: number;
  raiseExc?: boolean;
  [attribute: string]: string | number | boolean | undefined;
};

/** A page the bay command can reach: http(s) and the throwaway schemes, never Bay's own views or file://. */
export function isPage(target: TargetInfo): boolean {
  return target.type === "page" && PAGE_SCHEMES.some((scheme) => target.url.startsWith(scheme));
}

export class Session {
  readonly cdp: Cdp;
  private readonly tabs = new Map<string, Tab>();
  readonly opened: Tab[] = [];

  constructor(private readonly endpoint: Endpoint) {
    this.cdp = new Cdp(endpoint.ws);
  }

  async connect(): Promise<void> {
    try {
      await this.cdp.open(CONNECT_TIMEOUT);
      await this.cdp.send("Target.getTargets", {}, undefined, CONNECT_TIMEOUT);
    } catch (error) {
      await this.cdp.close();
      throw new EndpointError(this.unreachable(error));
    }
  }

  unreachable(error: unknown): string {
    if (!this.endpoint.explicit) return NOT_REACHABLE;
    return `can't connect to ${this.endpoint.source} (${messageOf(error)})`;
  }

  lost(): string {
    return this.endpoint.source;
  }

  async getTargets(): Promise<TargetInfo[]> {
    const reply = await this.cdp.send("Target.getTargets");
    const list = Array.isArray(reply.targetInfos) ? reply.targetInfos : [];
    return list.filter((item): item is TargetInfo => {
      if (typeof item !== "object" || item === null) return false;
      const target = item as Record<string, unknown>;
      return typeof target.targetId === "string" && typeof target.type === "string" && typeof target.url === "string";
    });
  }

  tabFor(targetId: string): Tab {
    let tab = this.tabs.get(targetId);
    if (!tab) {
      tab = new Tab(this, targetId);
      this.tabs.set(targetId, tab);
    }
    return tab;
  }

  /** Every web page tab, the user's included, with the blank ones only when one is the tab they're looking at. */
  async pageTabs(active: string | null | undefined): Promise<Tab[]> {
    const targets = (await this.getTargets()).filter(isPage);
    return targets
      .filter((target) => target.url !== "about:blank" || active === undefined || target.targetId === active)
      .map((target) => this.tabFor(target.targetId));
  }

  async newTab(url = "about:blank", background = true): Promise<Tab> {
    const reply = await this.cdp.send("Target.createTarget", { url: "about:blank", background });
    const targetId = reply.targetId;
    if (typeof targetId !== "string") throw new CdpError("Target.createTarget returned no targetId");
    const tab = this.tabFor(targetId);
    this.opened.push(tab);
    if (url && url !== "about:blank") await tab.goto(url);
    return tab;
  }

  /** The tab the user is looking at, when Bay says which one it is; otherwise the one that is visible and focused. */
  async currentTab(tabs: Tab[], active: string | null | undefined): Promise<Tab | null> {
    if (active !== undefined) return tabs.find((tab) => tab.targetId === active) ?? null;
    const probes = await Promise.all(tabs.map(async (tab) => ({ tab, ...(await tab.probe()) })));
    const focused = probes.find((probe) => probe.visible && probe.focused);
    if (focused) return focused.tab;
    return probes.find((probe) => probe.visible)?.tab ?? null;
  }

  /** Which page is in front, from Bay's own control endpoint; undefined when Bay doesn't say. */
  async activeTarget(): Promise<string | null | undefined> {
    const url = this.endpoint.active;
    if (!url) return undefined;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return undefined;
      const answer: unknown = await response.json();
      if (typeof answer !== "object" || answer === null) return undefined;
      const targetId = (answer as { targetId?: unknown }).targetId;
      if (targetId === null) return null;
      return typeof targetId === "string" ? targetId : undefined;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.cdp.close();
  }
}

export class Tab {
  private sessionId: string | null = null;
  private loaded = false;
  private inputReady: Promise<void> | null = null;

  constructor(
    private readonly session: Session,
    readonly targetId: string,
  ) {}

  get cdp(): Cdp {
    return this.session.cdp;
  }

  async attach(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const reply = await this.cdp.send("Target.attachToTarget", { targetId: this.targetId, flatten: true });
    const sessionId = reply.sessionId;
    if (typeof sessionId !== "string") throw new CdpError("Target.attachToTarget returned no sessionId");
    this.sessionId = sessionId;
    return sessionId;
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const session = await this.attach();
    if (method.startsWith("Input.")) await this.prepareInput(session);
    return this.cdp.send(method, params, session, timeoutMs);
  }

  /**
   * A tab behind the user's drops real input (and never answers a mouse move): focus emulation renders it as shown
   * while this connection lasts. Not before then, so the user's own tab keeps its real focus for `tab`'s lookup.
   */
  private prepareInput(session: string): Promise<void> {
    this.inputReady ??= (async () => {
      try {
        await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, session);
      } catch {
        return; // A Bay without it: input still goes to the tabs in front.
      }
      // The page hears it's shown a moment later; input before then is dropped.
      for (const deadline = Date.now() + 2000; Date.now() < deadline; await sleep(25)) {
        const reply = await this.cdp.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, session).catch(() => null);
        const result = reply?.result as { value?: unknown } | undefined;
        if (!reply || result?.value === "visible") return;
      }
    })();
    return this.inputReady;
  }

  async info(): Promise<TargetInfo | null> {
    try {
      const reply = await this.cdp.send("Target.getTargetInfo", { targetId: this.targetId });
      const info = reply.targetInfo;
      return info && typeof info === "object" ? (info as TargetInfo) : null;
    } catch {
      return null;
    }
  }

  async url(): Promise<string> {
    const info = await this.info();
    if (info?.url) return info.url;
    return String(await this.evaluate("location.href"));
  }

  async title(): Promise<string> {
    return String(await this.evaluate("document.title"));
  }

  async pageSource(): Promise<string> {
    return String(await this.evaluate("document.documentElement ? document.documentElement.outerHTML : ''"));
  }

  /** Evaluates JavaScript in the page and returns its value, awaiting a promise the expression returns. */
  async evaluate<T = unknown>(expression: string, options: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const reply = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: options.returnByValue ?? true,
        awaitPromise: options.awaitPromise ?? true,
        userGesture: false,
      },
      options.timeoutMs ?? 15_000,
    );
    const details = reply.exceptionDetails;
    if (details && typeof details === "object") {
      const exception = (details as { exception?: { description?: unknown; value?: unknown } }).exception;
      const text =
        (exception && typeof exception.description === "string" && exception.description) ||
        (exception && typeof exception.value === "string" && exception.value) ||
        (typeof (details as { text?: unknown }).text === "string" ? String((details as { text?: unknown }).text) : "the script threw");
      throw new ScriptEvaluationError(`JavaScript error: ${clip(text)}`);
    }
    const remote = reply.result;
    if (!remote || typeof remote !== "object") return undefined as T;
    return (remote as { value?: unknown }).value as T;
  }

  async probe(): Promise<{ visible: boolean; focused: boolean }> {
    try {
      const value = await this.evaluate<[boolean, boolean]>("[document.visibilityState === 'visible', document.hasFocus()]", { timeoutMs: PROBE_TIMEOUT });
      return { visible: Boolean(value?.[0]), focused: Boolean(value?.[1]) };
    } catch {
      return { visible: false, focused: false };
    }
  }

  async goto(url: string, options: GotoOptions = {}): Promise<void> {
    const timeout = options.timeout ?? NAVIGATION_TIMEOUT;
    const waitUntil = options.waitUntil ?? "load";
    this.loaded = false;
    await this.send("Page.enable", {});
    const sessionId = await this.attach();
    const remove = this.cdp.addListener((method, _params, session) => {
      if (session !== sessionId) return;
      if (method === "Page.loadEventFired") this.loaded = true;
    });
    try {
      const reply = await this.send("Page.navigate", { url }, Math.max(timeout, 15_000));
      const errorText = reply.errorText;
      if (typeof errorText === "string" && errorText) throw new NavigationError(`couldn't open ${url}: ${errorText}`);
      if (waitUntil === "none") return;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (this.loaded || (await this.evaluate<string>("document.readyState", { timeoutMs: 3000 })) === "complete") return;
        await sleep(100);
      }
      throw new PageLoadTimeout(`${url} didn't finish loading in ${timeout / 1000}s`);
    } finally {
      remove();
    }
  }

  async reload(options: { timeout?: number } = {}): Promise<void> {
    const url = await this.url();
    await this.goto(url, options);
  }

  async activate(): Promise<void> {
    await this.cdp.send("Target.activateTarget", { targetId: this.targetId });
  }

  async close(): Promise<void> {
    try {
      await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
    } catch {}
  }

  /** Runs `action`, then waits for the page it navigates to finish loading. */
  async expectNavigation(action: () => Promise<unknown>, timeout = NAVIGATION_TIMEOUT): Promise<void> {
    await this.send("Page.enable", {});
    let started = false;
    let loaded = false;
    const sessionId = await this.attach();
    const remove = this.cdp.addListener((method, _params, session) => {
      if (session !== sessionId) return;
      if (method === "Page.frameStartedLoading" || method === "Page.frameNavigated") started = true;
      if (method === "Page.loadEventFired") loaded = true;
    });
    try {
      await action();
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (loaded && started) return;
        if (loaded) return;
        await sleep(100);
      }
      throw new WaitTimeout(`the page didn't finish navigating in ${timeout / 1000}s`);
    } finally {
      remove();
    }
  }

  async waitForUrl(pattern: string, timeout = NAVIGATION_TIMEOUT): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const url = await this.url();
      if (wildcardMatch(pattern, url)) return url;
      await sleep(100);
    }
    throw new WaitTimeout(`the page's URL didn't become ${pattern} in ${timeout / 1000}s`);
  }

  async waitForScript(expression: string, timeout = 10_000): Promise<unknown> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression);
      if (value) return value;
      await sleep(100);
    }
    throw new WaitTimeout(`${expression} didn't become truthy in ${timeout / 1000}s`);
  }

  async waitForNetworkIdle(options: { timeout?: number; idle?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? 15_000;
    const idleFor = options.idle ?? 500;
    await this.send("Network.enable", {});
    let inFlight = 0;
    let lastActivity = Date.now();
    const sessionId = await this.attach();
    const requests = new Set<string>();
    const remove = this.cdp.addListener((method, params, session) => {
      if (session !== sessionId || typeof params.requestId !== "string") return;
      if (method === "Network.requestWillBeSent") {
        requests.add(params.requestId);
        inFlight = requests.size;
        lastActivity = Date.now();
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        requests.delete(params.requestId);
        inFlight = requests.size;
        lastActivity = Date.now();
      }
    });
    try {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (inFlight === 0 && Date.now() - lastActivity >= idleFor) return;
        await sleep(100);
      }
      throw new WaitTimeout(`the page wasn't quiet for ${idleFor}ms within ${timeout / 1000}s`);
    } finally {
      remove();
    }
  }

  async query(selector: string, options: QueryOptions = {}): Promise<Element> {
    const timeout = options.timeout ?? 0;
    const raise = options.raiseExc ?? true;
    const deadline = Date.now() + timeout;
    while (true) {
      if (await exists(this, selector, 0)) return new Element(this, selector, 0);
      if (Date.now() >= deadline) break;
      await sleep(ELEMENT_POLL);
    }
    if (!raise) return null as unknown as Element;
    if (timeout > 0) throw new WaitElementTimeout(`no element matched ${selector} in ${timeout / 1000}s`);
    throw new ElementNotFound(`no element matched ${selector}`);
  }

  async queryAll(selector: string, options: QueryOptions = {}): Promise<Element[]> {
    const timeout = options.timeout ?? 0;
    const deadline = Date.now() + timeout;
    while (true) {
      const count = await countOf(this, selector);
      if (count > 0) return Array.from({ length: count }, (_, index) => new Element(this, selector, index));
      if (Date.now() >= deadline) break;
      await sleep(ELEMENT_POLL);
    }
    if (options.raiseExc === false) return [];
    if (timeout > 0) throw new WaitElementTimeout(`no element matched ${selector} in ${timeout / 1000}s`);
    throw new ElementNotFound(`no element matched ${selector}`);
  }

  async find(options: FindOptions = {}): Promise<Element> {
    return this.query(selectorFor(options), options);
  }

  async findAll(options: FindOptions = {}): Promise<Element[]> {
    return this.queryAll(selectorFor(options), options);
  }

  async click(selector: string, options: QueryOptions = {}): Promise<void> {
    await (await this.query(selector, options)).click();
  }

  async type(selector: string, text: string, options: QueryOptions = {}): Promise<void> {
    await (await this.query(selector, options)).typeText(text);
  }

  /** Sends one key, by name (`Enter`, `Tab`, `ArrowDown`) or a single character. */
  async pressKey(key: string): Promise<void> {
    const named = KEYS[key.toLowerCase()];
    if (!named) {
      if (key.length !== 1) throw new Error(`unknown key: ${key}`);
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: key, key, unmodifiedText: key });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, unmodifiedText: key });
      return;
    }
    const base = { key: named.code, code: named.code, windowsVirtualKeyCode: named.keyCode, nativeVirtualKeyCode: named.keyCode };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (named.text) await this.send("Input.dispatchKeyEvent", { type: "char", text: named.text, ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async screenshot(path: string, options: { fullPage?: boolean } = {}): Promise<string> {
    const target = expandPath(path);
    mkdirSync(dirname(target), { recursive: true });
    const params: Record<string, unknown> = { format: "png" };
    if (options.fullPage) {
      const metrics = await this.send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize as { width?: number; height?: number; x?: number; y?: number } | undefined;
      if (size?.width && size.height) {
        params.clip = { x: size.x ?? 0, y: size.y ?? 0, width: size.width, height: size.height, scale: 1 };
        params.captureBeyondViewport = true;
      }
    }
    const reply = await this.send("Page.captureScreenshot", params, 30_000);
    const data = reply.data;
    if (typeof data !== "string") throw new CdpError("Page.captureScreenshot returned no image");
    writeFileSync(target, Buffer.from(data, "base64"));
    return target;
  }

  async pdf(path: string): Promise<string> {
    const target = expandPath(path);
    mkdirSync(dirname(target), { recursive: true });
    const reply = await this.send("Page.printToPDF", { printBackground: true }, 60_000);
    const data = reply.data;
    if (typeof data !== "string") throw new CdpError("Page.printToPDF returned no document");
    writeFileSync(target, Buffer.from(data, "base64"));
    return target;
  }
}

export class Element {
  constructor(
    private readonly tab: Tab,
    private readonly selector: string,
    private readonly index = 0,
  ) {}

  private get ref(): string {
    return `(${matcher(this.selector)})[${this.index}]`;
  }

  async exists(): Promise<boolean> {
    return exists(this.tab, this.selector, this.index);
  }

  async click(): Promise<void> {
    const box = await this.tab.evaluate<{ x: number; y: number; width: number; height: number } | null>(`(() => {
      const el = ${this.ref};
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
    })()`);
    if (!box) throw new ElementNotFound(`no element matched ${this.selector}`);
    const x = Math.round(box.x);
    const y = Math.round(box.y);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.tab.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
  }

  async text(): Promise<string> {
    return String((await this.tab.evaluate(`(() => { const el = ${this.ref}; return el ? (el.innerText ?? el.textContent ?? "") : null; })()`)) ?? "");
  }

  async getAttribute(name: string): Promise<string | null> {
    return await this.tab.evaluate<string | null>(`(() => { const el = ${this.ref}; return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`);
  }

  async isVisible(): Promise<boolean> {
    return Boolean(
      await this.tab.evaluate(`(() => {
        const el = ${this.ref};
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
      })()`),
    );
  }

  async waitUntil(options: { visible?: boolean; timeout?: number } = {}): Promise<void> {
    const want = options.visible ?? true;
    const timeout = options.timeout ?? 10_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await this.isVisible()) === want) return;
      await sleep(ELEMENT_POLL);
    }
    throw new WaitTimeout(`${this.selector} wasn't ${want ? "visible" : "hidden"} in ${timeout / 1000}s`);
  }

  async focus(): Promise<void> {
    await this.tab.evaluate(`(() => { const el = ${this.ref}; if (el) el.focus(); })()`);
  }

  /** Real text input through the browser: fires the events a typing user fires, without per-key delay. */
  async typeText(text: string): Promise<void> {
    const { body, submit } = splitEnter(text);
    await this.focus();
    if (body) await this.tab.send("Input.insertText", { text: body });
    if (submit) await this.tab.pressKey("Enter");
  }

  async pressKey(key: string): Promise<void> {
    await this.focus();
    await this.tab.pressKey(key);
  }

  async screenshot(path: string): Promise<string> {
    const target = expandPath(path);
    mkdirSync(dirname(target), { recursive: true });
    const box = await this.tab.evaluate<{ x: number; y: number; width: number; height: number } | null>(`(() => {
      const el = ${this.ref};
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
    if (!box) throw new ElementNotFound(`no element matched ${this.selector}`);
    const reply = await this.tab.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } }, 30_000);
    const data = reply.data;
    if (typeof data !== "string") throw new CdpError("Page.captureScreenshot returned no image");
    writeFileSync(target, Buffer.from(data, "base64"));
    return target;
  }
}

/** The keys `pressKey` knows by name; anything longer than one character is matched case-insensitively. */
export const Key = {
  ENTER: "Enter",
  TAB: "Tab",
  ESCAPE: "Escape",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  ARROW_LEFT: "ArrowLeft",
  ARROW_UP: "ArrowUp",
  ARROW_RIGHT: "ArrowRight",
  ARROW_DOWN: "ArrowDown",
  HOME: "Home",
  END: "End",
  PAGE_UP: "PageUp",
  PAGE_DOWN: "PageDown",
  SPACE: "Space",
} as const;

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  enter: { code: "Enter", keyCode: 13, text: "\r" },
  tab: { code: "Tab", keyCode: 9 },
  escape: { code: "Escape", keyCode: 27 },
  backspace: { code: "Backspace", keyCode: 8 },
  delete: { code: "Delete", keyCode: 46 },
  arrowleft: { code: "ArrowLeft", keyCode: 37 },
  arrowup: { code: "ArrowUp", keyCode: 38 },
  arrowright: { code: "ArrowRight", keyCode: 39 },
  arrowdown: { code: "ArrowDown", keyCode: 40 },
  home: { code: "Home", keyCode: 36 },
  end: { code: "End", keyCode: 35 },
  pageup: { code: "PageUp", keyCode: 33 },
  pagedown: { code: "PageDown", keyCode: 34 },
  space: { code: "Space", keyCode: 32, text: " " },
};

async function exists(tab: Tab, selector: string, index: number): Promise<boolean> {
  return Boolean(await tab.evaluate(`(() => { const el = (${matcher(selector)})[${index}]; return !!el; })()`));
}

async function countOf(tab: Tab, selector: string): Promise<number> {
  return Number(await tab.evaluate(`(${matcher(selector)}).length`)) || 0;
}

function matcher(selector: string): string {
  const text = JSON.stringify(selector);
  if (selector.startsWith("/") || selector.startsWith("(")) {
    return `(() => { const found = document.evaluate(${text}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return Array.from({ length: found.snapshotLength }, (_, i) => found.snapshotItem(i)); })()`;
  }
  return `document.querySelectorAll(${text})`;
}

function selectorFor(options: FindOptions): string {
  const { tagName, id, className, name, text: label, timeout: _t, raiseExc: _r, ...attributes } = options;
  if (id) return `#${cssEscape(id)}`;
  const tag = tagName || "*";
  if (label) {
    return `//${tag === "*" ? "*" : tag}[contains(normalize-space(.), ${xpathLiteral(label)})]`;
  }
  let selector = tag;
  if (className) selector += `.${cssEscape(className)}`;
  if (name) selector += `[name=${JSON.stringify(name)}]`;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || key === "timeout" || key === "raiseExc") continue;
    // dataTestid and data_testid are data-testid, as an HTML attribute is written.
    const attribute = key.replace(/_/g, "-").replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
    selector += `[${attribute}=${JSON.stringify(String(value))}]`;
  }
  return selector;
}

function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(`, "'", `)})`;
}

function splitEnter(text: string): { body: string; submit: boolean } {
  const submit = text.endsWith("\r") || text.endsWith("\n");
  return { body: submit ? text.slice(0, -1) : text, submit };
}

function expandPath(path: string): string {
  if (path === "~") return process.env.HOME || path;
  if (path.startsWith("~/")) return `${process.env.HOME || ""}/${path.slice(2)}`;
  return path;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

Object.assign(Tab.prototype, {
  current_url(this: Tab) {
    return this.url();
  },
  page_source(this: Tab) {
    return this.pageSource();
  },
  take_screenshot(this: Tab, path: string, options?: { fullPage?: boolean; beyond_viewport?: boolean }) {
    return this.screenshot(path, { fullPage: options?.fullPage ?? options?.beyond_viewport });
  },
  print_to_pdf(this: Tab, path: string) {
    return this.pdf(path);
  },
  go_to(this: Tab, url: string, options?: GotoOptions) {
    return this.goto(url, options);
  },
  wait_for_url(this: Tab, pattern: string, timeout?: number) {
    return this.waitForUrl(pattern, timeout);
  },
  wait_for_script(this: Tab, expr: string, timeout?: number) {
    return this.waitForScript(expr, timeout);
  },
  wait_for_network_idle(this: Tab, options?: { timeout?: number; idle?: number }) {
    return this.waitForNetworkIdle(options);
  },
});

Object.assign(Element.prototype, {
  type_text(this: Element, text: string) {
    return this.typeText(text);
  },
  get_attribute(this: Element, name: string) {
    return this.getAttribute(name);
  },
  is_visible(this: Element) {
    return this.isVisible();
  },
  wait_until(this: Element, options?: { is_visible?: boolean; visible?: boolean; timeout?: number }) {
    return this.waitUntil({ visible: options?.visible ?? options?.is_visible, timeout: options?.timeout });
  },
  take_screenshot(this: Element, path: string) {
    return this.screenshot(path);
  },
});
