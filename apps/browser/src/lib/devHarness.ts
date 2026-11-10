import * as shell from "@bay/desktop";
import { readDocument, writeDocument } from "@bay/desktop";
import { requireOptionalNativeModule } from "@bay/platform/native";
import { getNativeHostInfo } from "@bay/platform/nativeBridge";
import { Platform } from "react-native";
import { omniboxDrivers } from "../components/commandBar/devDriver";
import { pagesDrivers } from "../components/pages/devDrivers";
import { usePages } from "../components/window/pageState";
import { openSettings } from "../components/settings/windows";
import { useSidebarUi } from "../components/sidebar/state";
import { useBrowser } from "../store/browserStore";
import { browserRead } from "../store/read";
import * as actions from "./actions";
import { runCommand } from "./appCommands";
import * as favicons from "./favicons";
import { probeStore } from "./perfProbe";
import { useLifecycle } from "./tabLifecycle";
import { webviews } from "./webviews";
import type { JsonInput, JsonValue } from "./json";

type DevEvalBody = { result: JsonValue | null } | { error: string };

type DevEvalError = JsonInput | Error;

// The desktop host's documents: one coordinator holds the store, and each window its own views.
type WebHost = { role: "coordinator" | "window"; windowId?: string };
function webHost(): WebHost | null {
  if (Platform.OS !== "web") return null;
  const { runtimeRole, windowId } = getNativeHostInfo().constants.BayShell ?? {};
  return { role: runtimeRole === "window" ? "window" : "coordinator", ...(typeof windowId === "string" ? { windowId } : {}) };
}
// What scripts call on macOS: the same modules, over the bridge.
function installWebModules() {
  const global = globalThis as { expo?: { modules?: object } };
  const expo = (global.expo ??= {});
  const existing = expo.modules ?? {};
  expo.modules = new Proxy(existing, {
    get: (target, name, receiver) => (typeof name === "string" ? requireOptionalNativeModule(name) : null) ?? Reflect.get(target, name, receiver),
  });
}

export function startDevHarness() {
  const host = webHost();
  if (host) installWebModules();
  const consoleLog = host ? `dev-console-${host.windowId ?? host.role}.log` : "dev-console.log";
  probeStore("pages", usePages);
  probeStore("sidebarUi", useSidebarUi);
  probeStore("favicons", favicons.useFavicons);
  probeStore("lifecycle", useLifecycle);

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);

      try {
        const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" ")}\n`;
        writeDocument(consoleLog, (readDocument(consoleLog) ?? "").slice(-200_000) + line);
      } catch {}
    };
  }

  const nn = {
    host,
    // A window document reads the coordinator's projection: its own useBrowser is never written.
    store: host?.role === "window" ? browserRead : useBrowser,
    sidebarUi: useSidebarUi,
    get sidebarKeyboard(): typeof import("../components/sidebar/keyboard") & { model: typeof import("../components/sidebar/keyboardModel") } {
      return { ...require("../components/sidebar/keyboard"), model: require("../components/sidebar/keyboardModel") };
    },
    actions,
    runCommand,
    get keyBindings(): typeof import("./keyBindings") {
      return require("./keyBindings");
    },
    get externalLinks(): typeof import("../components/littleBay/actions") {
      return require("../components/littleBay/actions");
    },
    get linkRules(): typeof import("../components/settings/panes/LinkRules") {
      return require("../components/settings/panes/LinkRules");
    },
    webviews,
    shell,
    omnibox: omniboxDrivers,
    get bangs(): typeof import("../components/commandBar/bangs") {
      return require("../components/commandBar/bangs");
    },
    pages: pagesDrivers,
    pageState: usePages,
    openSettings,
    favicons,
    get checkIn(): typeof import("./defaultBrowserPrompt") {
      return require("./defaultBrowserPrompt");
    },
    get media(): typeof import("../components/media/state").useMedia {
      return require("../components/media/state").useMedia;
    },
    get permissions(): typeof import("../components/site/permissions") {
      return require("../components/site/permissions");
    },
    get translate(): typeof import("../components/site/translateState") {
      return require("../components/site/translateState");
    },
    get toasts(): typeof import("../components/split/splitActions").useToasts {
      return require("../components/split/splitActions").useToasts;
    },
    get extensions(): typeof import("../components/extensions/state") {
      return require("../components/extensions/state");
    },
    // The ⌃Tab switcher: a test ends it as the user does (Esc cancels, releasing ⌃ commits), which a hidden instance
    // can't send.
    get switcher(): typeof import("../components/sidebar/spaceSwitcher") {
      return require("../components/sidebar/spaceSwitcher");
    },
    // The sidebar's actions: menus a test can't click open what these do (the icon picker, renaming).
    get sidebar(): typeof import("../components/sidebar/actions") {
      return require("../components/sidebar/actions");
    },
    // Arc's previews: a test hands a site preview its data, as the signed-in site would.
    get previews(): typeof import("../components/previews/SitePreview") {
      return require("../components/previews/SitePreview");
    },
    // Onboarding's steps: a test goes to one without clicking through those before it.
    get onboarding(): typeof import("../components/onboarding/state") {
      return require("../components/onboarding/state");
    },
    // The sidebar's Clear (and its rows breaking up), which a test runs without the click.
    get clear(): typeof import("../components/sidebar/clearTabs") {
      return require("../components/sidebar/clearTabs");
    },
    // Split View's actions: the sidebar's + › Split View, its edge cases included.
    get splits(): typeof import("../components/split/splitActions") {
      return require("../components/split/splitActions");
    },
    // The sidebar's menus, which a test opens to see them (a hidden instance can't right-click).
    get menus(): typeof import("../components/sidebar/contextMenus") {
      return require("../components/sidebar/contextMenus");
    },
    // Nested-folder acceptance tests inspect the same tree and geometry the sidebar renders.
    get folders() {
      return {
        model: require("../store/folders"),
        entries: require("../components/sidebar/sidebarEntries"),
        geometry: require("../components/sidebar/rowGeometry"),
      };
    },
    // The update waiting for the user: a test shows the sidebar's Update row without a feed.
    get updates(): typeof import("./updates") {
      return require("./updates");
    },
    // New Space's panel: its steps, which a test goes through without clicks.
    get newSpace(): typeof import("../components/spaces/NewSpace") {
      return require("../components/spaces/NewSpace");
    },
    // A space's menu actions (renaming it in its dialog), which only a menu opens.
    get spaces(): typeof import("../components/spaces/SpaceSwitcher") {
      return require("../components/spaces/SpaceSwitcher");
    },
    // The space theme editor, which only a menu opens.
    get themeEditor(): typeof import("../components/spaces/ThemeEditor") {
      return require("../components/spaces/ThemeEditor");
    },
    get toolbarAutoHide(): typeof import("../components/toolbar/autoHide") {
      return require("../components/toolbar/autoHide");
    },
    // Developer Mode: a test serving its pages from a local server turns it off for that server, or its offer covers
    // the pages (and takes the keyboard).
    get developer(): typeof import("../components/developer/devMode") {
      return require("../components/developer/devMode");
    },
    // Boosts: the store, the editor and the model (scripts/boosts-test.mjs).
    get boosts() {
      return { state: require("../components/boosts/state"), editor: require("../components/boosts/editor"), model: require("./boosts") };
    },
    // Capture's sessions and actions (scripts/capture-test.mjs).
    get library() {
      return {
        state: require("../components/library/state"),
        actions: require("../components/library/actions"),
        canvases: require("../components/library/EaselPage").easelCanvases,
        canvasStates: require("../components/library/EaselPage").easelCanvasStates,
      };
    },
    get capture(): typeof import("../components/capture/state") {
      return require("../components/capture/state");
    },
    // Arc's small habits (scripts/interaction-habits-test.mjs): unread counts, Little Bay from any app and put away, ⌃⌘J.
    get arcGaps() {
      return {
        unread: require("./unreadBadges"),
        littleBayAccess: require("../components/littleBay/access"),
        putAway: require("../components/littleBay/putAway"),
        alerts: require("../activity/meetingAlerts"),
        calendar: require("../activity/calendar").useCalendar,
        menuState: require("./shellBridge").menuState,
      };
    },
    // Hovering moves nothing but a HoverSlot's contents (scripts/hover-shift-test.mjs).
    get hoverShift(): typeof import("./hoverShift") {
      return require("./hoverShift");
    },
    // Live folders without a service: a test makes a folder and hands it items.
    get live() {
      return { store: require("../activity/activityStore"), engine: require("../activity/activityEngine") };
    },
  };

  // SAFETY: nn is the dev harness's own surface, read only by dev scripts.
  (globalThis as { nn?: typeof nn }).nn = nn;
  // The launcher evaluates over DevTools: a host's document snapshot doesn't see files it didn't write.
  if (host) return;
  const scriptId = (source: string | null) => source?.match(/^\/\/ *(\S+)/)?.[1];
  let lastId = scriptId(readDocument("dev-eval.js")) ?? "";
  setInterval(
    function pollDevEval() {
      const source = readDocument("dev-eval.js");
      const id = scriptId(source);

      if (!source || !id || id === lastId) return;
      lastId = id;
      const done = (body: DevEvalBody) => writeDocument("dev-eval-result.json", JSON.stringify({ id, ...body }));

      try {
        // SAFETY: new Function builds the dev script, whose return is its JSON result for the harness file.
        const fn = new Function("nn", source) as (n: typeof nn) => JsonInput;
        Promise.resolve(fn(nn)).then(
          (result) => done({ result: result ?? null }),
          (error: DevEvalError) => done({ error: String(error) }),
        );
      } catch (error) {
        done({ error: String(error) });
      }
      // Test scripts wait on every answer (scripts/lib/instance.mjs); a Release build's perf probe keeps the slow poll.
    },
    __DEV__ ? 50 : 250,
  );
}
