// bay on EVENT -- COMMAND: run an ordinary program when something happens in the running Bay. The events come from
// the bay command's own DevTools connection, so they need what bay exec needs (Settings › Advanced) and see only what
// it sees: web page tabs, never Bay's own views.
//
// The hook gets the event in its environment (BAY_EVENT, BAY_TAB_ID, BAY_URL, BAY_TITLE) and as one line of JSON
// on stdin. Hooks only watch: the engine gives the bay command no way to hold a navigation, so one that rewrites or
// stops a page, or picks its space, waits for that (docs/engine-choice-and-gaps-plan.html, G6).
import * as v from "valibot";
import { isPage, type Session, type TargetInfo } from "./browser.ts";
import type { Cdp, CdpObject } from "./cdp.ts";
import { matches, parse, split, type MatchPattern } from "./urlmatch.ts";

export const HOOK_EVENTS = ["tab-opened", "tab-navigated", "page-loaded", "tab-closed"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type Fired = { event: HookEvent; tabId: string; url: string; title: string };

const TargetSchema = v.object({ targetId: v.string(), type: v.string(), url: v.string(), title: v.fallback(v.string(), "") });

const target = (params: CdpObject): TargetInfo | null => {
  const parsed = v.safeParse(TargetSchema, params.targetInfo);

  return parsed.success ? parsed.output : null;
};

const text = (value: CdpObject[string] | undefined): string | null => (v.is(v.string(), value) ? value : null);

/**
 * The browser's DevTools events as hook events. It knows the web page tabs (seeded with the ones open when it
 * starts, which fire nothing) and which attached session is which tab's.
 */
export class HookTracker {
  private readonly pages = new Map<string, { url: string; title: string }>();
  private readonly sessions = new Map<string, string>();

  seed(targets: TargetInfo[]): void {
    for (const t of targets) if (isPage(t)) this.pages.set(t.targetId, { url: t.url, title: t.title });
  }

  /** The tabs it knows, to attach to for page loads. */
  tabIds(): string[] {
    return [...this.pages.keys()];
  }

  attached(sessionId: string, tabId: string): void {
    this.sessions.set(sessionId, tabId);
  }

  feed(method: string, params: CdpObject, sessionId?: string): Fired[] {
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      const info = target(params);

      if (!info) return [];
      const known = this.pages.get(info.targetId);

      // A tab that leaves the web (for Bay's own pages) is out of sight, as if closed; it comes back as opened.
      if (!isPage(info)) {
        this.pages.delete(info.targetId);

        return [];
      }

      this.pages.set(info.targetId, { url: info.url, title: info.title });
      const fired = { tabId: info.targetId, url: info.url, title: info.title };

      if (!known) return [{ event: "tab-opened", ...fired }];

      return known.url !== info.url ? [{ event: "tab-navigated", ...fired }] : [];
    }

    if (method === "Target.targetDestroyed") {
      const tabId = text(params.targetId);
      const known = tabId ? this.pages.get(tabId) : undefined;

      if (!tabId || !known) return [];
      this.pages.delete(tabId);

      return [{ event: "tab-closed", tabId, ...known }];
    }

    if (method === "Target.detachedFromTarget") {
      const id = text(params.sessionId);

      if (id) this.sessions.delete(id);

      return [];
    }

    if (method === "Page.loadEventFired" && sessionId) {
      const tabId = this.sessions.get(sessionId);
      const known = tabId ? this.pages.get(tabId) : undefined;

      return tabId && known ? [{ event: "page-loaded", tabId, ...known }] : [];
    }

    return [];
  }
}

/** --match: a Chrome match pattern ("https://*.example.com/*"), or every page without one. */
export function hookFilter(pattern: string | null): (url: string) => boolean {
  if (!pattern) return () => true;
  const spec: MatchPattern = parse(pattern);

  return (url) => matches(spec, split(url));
}

/** What a hook is told: its environment, added to the bay command's own, and its stdin. */
export type HookInput = { env: Record<string, string>; stdin: string };

export function hookInput(fired: Fired): HookInput {
  return {
    env: { BAY_EVENT: fired.event, BAY_TAB_ID: fired.tabId, BAY_URL: fired.url, BAY_TITLE: fired.title },
    stdin: `${JSON.stringify(fired)}\n`,
  };
}

export type HookOptions = {
  event: HookEvent;
  match: (url: string) => boolean;
  command: string[];
  /** End after the first hook, with its status. */
  once: boolean;
  /** How many hooks may run at once; more wait their turn, and past `MAX_WAITING` an event is dropped. */
  parallel: number;
  spawn?: (command: string[], input: HookInput) => Promise<number>;
  warn?: (message: string) => void;
};

export const MAX_WAITING = 100;

const spawnHook = async (command: string[], input: HookInput): Promise<number> => {
  const child = Bun.spawn(command, { env: { ...process.env, ...input.env }, stdin: new Blob([input.stdin]), stdout: "inherit", stderr: "inherit" });

  return child.exited;
};

/** What the hooks need of a session: its tabs, and its connection's commands and events. */
export type HookSession = Pick<Session, "getTargets"> & { cdp: Pick<Cdp, "send" | "addListener" | "whenClosed"> };

/** Runs hooks for the session's events until the connection ends (null) or, with --once, the first hook does (its status). */
export async function watchHooks(session: HookSession, options: HookOptions): Promise<number | null> {
  const { cdp } = session;
  const tracker = new HookTracker();
  const spawn = options.spawn ?? spawnHook;
  const warn = options.warn ?? ((message) => void process.stderr.write(`bay on: ${message}\n`));
  const waiting: Fired[] = [];
  let running = 0;
  let finish: (status: number) => void = () => {};
  const finished = new Promise<number>((resolve) => (finish = resolve));

  const next = () => {
    while (running < options.parallel && waiting.length) {
      const fired = waiting.shift()!;
      running++;
      void spawn(options.command, hookInput(fired))
        .catch((error: Error) => {
          warn(`couldn't run ${options.command[0]}: ${error.message}`);

          return 127;
        })
        .then((status) => {
          running--;

          if (options.once) finish(status);
          else next();
        });

      if (options.once) return;
    }
  };

  const attach = async (tabId: string) => {
    const reply = await cdp.send("Target.attachToTarget", { targetId: tabId, flatten: true }).catch(() => null);
    const sessionId = reply ? text(reply.sessionId) : null;

    if (!sessionId) return;
    tracker.attached(sessionId, tabId);
    await cdp.send("Page.enable", {}, sessionId).catch(() => null);
  };

  const remove = cdp.addListener((method, params, sessionId) => {
    for (const fired of tracker.feed(method, params, sessionId)) {
      if (options.event === "page-loaded" && fired.event === "tab-opened") void attach(fired.tabId);

      if (fired.event !== options.event || !options.match(fired.url)) continue;

      if (waiting.length >= MAX_WAITING) {
        warn(`${MAX_WAITING} hooks are waiting; skipped ${fired.event} for ${fired.url}`);
        continue;
      }

      waiting.push(fired);
      next();
    }
  });

  try {
    tracker.seed(await session.getTargets());
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    if (options.event === "page-loaded") await Promise.all(tracker.tabIds().map(attach));

    const closed = cdp.whenClosed().then(() => null);

    return await Promise.race([closed, finished]);
  } finally {
    remove();
  }
}
