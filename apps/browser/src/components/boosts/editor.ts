import { confirm, openTextFile, prompt, saveTextFile } from "@bay/shell";
import { create } from "zustand";
import { boostChanges, boostHost, cleanSelector, exportBoost, importBoost, newBoost, shuffledBoost, type Boost } from "../../lib/boosts";
import { webviews } from "../../lib/webviews";
import { useBrowserRead as useBrowser } from "../../store/read";
import { newId } from "../../store/model";
import { setPopover } from "../layout/pageState";
import { showToast } from "../layout/splitActions";
import { countScript, pickerScript, previewScript, type PickerMode } from "./pickerScript";
import { addBoost, addSelector, boostsAvailable, boostsForHost, createBoost, deleteBoost, setBoostScript, startBoosts, updateBoost, useBoosts } from "./state";

// The Boost editor over a tab's page (BoostEditor.tsx), as Arc's and Zen's: one Boost of the page's site at a time,
// changed as you go, the page the preview. Zap, Focus and the selector picker run in the page (pickerScript.ts).

export type EditorView = "look" | "code";
export type EditorSession = {
  boostId: string;
  host: string;
  view: EditorView;
  // The picker running in the page, if any.
  picking: PickerMode | null;
  pickerId: string | null;
  // How many elements each zap hides on the page now.
  counts: Record<string, number>;
};

export const useBoostEditor = create<{ sessions: Record<string, EditorSession> }>(() => ({ sessions: {} }));

export const useEditorSession = (tabId: string) => useBoostEditor((e) => e.sessions[tabId] ?? null);
const sessionOf = (tabId: string) => useBoostEditor.getState().sessions[tabId] ?? null;
const countRequests = new Map<string, symbol>();

function patchSession(tabId: string, patch: Partial<EditorSession> | null) {
  if (patch === null || patch.boostId !== undefined) countRequests.delete(tabId);
  useBoostEditor.setState((e) => {
    const sessions = { ...e.sessions };
    if (patch === null) delete sessions[tabId];
    else if (sessions[tabId]) sessions[tabId] = { ...sessions[tabId]!, ...patch };
    else return e;
    return { sessions };
  });
}

/** The tab's page can have a Boost: a website. */
export const canBoost = (tabId: string) => boostsAvailable() && !!boostHost(useBrowser.getState().tabs[tabId]?.url);

/**
 * Opens the editor over a tab with one of its site's Boosts: `boostId`, else the first one, else a new one (Arc's
 * "New Boost" makes a new one even when there are others: `fresh`).
 */
export function openBoostEditor(tabId: string, options: { boostId?: string; fresh?: boolean } = {}) {
  if (!boostsAvailable()) {
    const tab = useBrowser.getState().tabs[tabId];
    if (tab) showToast(tab.windowId, "Boosts Are Unavailable", "Boost editing is not supported in this window yet.");
    return;
  }
  startBoosts();
  startBoostEditor();
  const tab = useBrowser.getState().tabs[tabId];
  const host = boostHost(tab?.url);
  if (!tab || !host) return;
  const existing = boostsForHost(useBoosts.getState(), host);
  let boost = options.boostId ? useBoosts.getState().boosts[options.boostId] : options.fresh ? undefined : (existing.find((b) => b.enabled) ?? existing[0]);
  if (options.boostId && (!boost || boost.host !== host)) return;
  if (!boost) boost = createBoost(host) ?? undefined;
  if (!boost) {
    showToast(tab.windowId, "Couldn't Make a Boost", useBoosts.getState().error ?? undefined, { icon: "exclamationmark.triangle" });
    return;
  }
  // The Boost being edited shows: it's turned on.
  if (!boost.enabled) updateBoost(boost.id, { enabled: true });
  if (!useBoosts.getState().on) useBoosts.setState({ on: true });
  setPopover(tabId, null);
  stopPicking(tabId);
  useBoostEditor.setState((e) => ({
    sessions: { ...e.sessions, [tabId]: { boostId: boost.id, host, view: "look", picking: null, pickerId: null, counts: {} } },
  }));
  void refreshCounts(tabId);
}

export function closeBoostEditor(tabId: string) {
  const session = sessionOf(tabId);
  if (!session) return;
  stopPicking(tabId);
  void webviews.get(tabId)?.evaluate(previewScript(null));
  patchSession(tabId, null);
  // A Boost that was made and left as it was isn't kept (Zen keeps only Boosts with a change).
  const boost = useBoosts.getState().boosts[session.boostId];
  const script = useBoosts.getState().scripts[session.boostId];
  if (boost && !boostChanges(boost) && !script?.code.trim() && Date.now() - boost.createdAt < 30 * 60_000) deleteBoost(boost.id);
}

/** Esc in the page: the picker stops first, then the editor closes; true if either was open. */
export function closeBoostEditorOnEscape(tabId: string): boolean {
  const session = sessionOf(tabId);
  if (!session) return false;
  if (session.picking) stopPicking(tabId);
  else closeBoostEditor(tabId);
  return true;
}

export const setEditorView = (tabId: string, view: EditorView) => patchSession(tabId, { view });

export function switchEditorBoost(tabId: string, boostId: string) {
  if (useBoosts.getState().boosts[boostId]?.host !== sessionOf(tabId)?.host) return;
  stopPicking(tabId);
  patchSession(tabId, { boostId, counts: {} });
  if (!useBoosts.getState().boosts[boostId]?.enabled) updateBoost(boostId, { enabled: true });
  void refreshCounts(tabId);
}

// MARK: The page's picker

export function startPicking(tabId: string, mode: PickerMode) {
  const session = sessionOf(tabId);
  if (!session) return;
  if (session.picking === mode) return stopPicking(tabId);
  stopPicking(tabId);
  const pickerId = newId("picker");
  patchSession(tabId, { picking: mode, pickerId });
  void webviews.get(tabId)?.evaluate(pickerScript(mode, pickerId));
  void webviews.get(tabId)?.focus();
}

export function stopPicking(tabId: string) {
  if (!sessionOf(tabId)?.picking) return;
  patchSession(tabId, { picking: null, pickerId: null });
  void webviews.get(tabId)?.evaluate(pickerScript(null));
}

/** What the picker in a page sends (pickerScript's send): untrusted, as everything from a page. */
export function onBoostMessage(tabId: string, data: unknown) {
  const message = data && typeof data === "object" ? (data as { type?: unknown; mode?: unknown; selector?: unknown; pickerId?: unknown }) : null;
  const session = sessionOf(tabId);
  if (!message || !session || !session.picking || message.mode !== session.picking || message.pickerId !== session.pickerId) return;
  if (message.type === "done") return stopPicking(tabId);
  if (message.type !== "select") return;
  // The page could send anything: only a selector that can't end its rule early.
  const selector = cleanSelector(message.selector);
  if (!selector) return;
  if (session.picking === "zap") {
    addSelector(session.boostId, "zaps", selector);
    setTimeout(() => void refreshCounts(tabId), 250);
  } else if (session.picking === "focus") {
    addSelector(session.boostId, "focus", selector);
    stopPicking(tabId);
  } else {
    // The code editor's picker: a rule for it at the end of the CSS, to fill in.
    updateBoost(session.boostId, (b) => ({ css: `${b.css.replace(/\s*$/, "")}${b.css.trim() ? "\n\n" : ""}${selector} {\n  \n}\n` }));
    stopPicking(tabId);
    patchSession(tabId, { view: "code" });
  }
}

export async function refreshCounts(tabId: string) {
  const session = sessionOf(tabId);
  const boost = session ? useBoosts.getState().boosts[session.boostId] : undefined;
  if (!session || !boost) return;
  const request = Symbol();
  countRequests.set(tabId, request);
  const counts: Record<string, number> = {};
  if (boost.zaps.length) {
    const result = await webviews.get(tabId)?.evaluate<number[]>(countScript(boost.zaps));
    if (Array.isArray(result)) boost.zaps.forEach((s, i) => (counts[s] = Number(result[i]) || 0));
  }
  if (countRequests.get(tabId) !== request) return;
  countRequests.delete(tabId);
  patchSession(tabId, { counts });
}

/** Shows a zap's elements for a moment (its row hovered); null hides them again. */
export const previewZap = (tabId: string, selector: string | null) => void webviews.get(tabId)?.evaluate(previewScript(selector));

// MARK: The Boost's menu

/** Consent applies to the site shown when the user clicked, including while a warning is open. */
export async function toggleBoostScript(tabId: string, id: string, host: string, on: boolean): Promise<boolean> {
  const matchesHost = () => !!host && useBoosts.getState().boosts[id]?.host === host && boostHost(useBrowser.getState().tabs[tabId]?.url) === host;
  if (!matchesHost()) return false;
  if (on && !useBoosts.getState().scriptsAcknowledged) {
    const { confirmed } = await confirm({
      title: "Run JavaScript on this site?",
      message: `A JavaScript Boost runs on every page of ${host} you open on this Mac, and can read and change what's on them. Run only code you wrote or trust. It stays on this Mac: JavaScript Boosts never sync, and don't run in private windows unless you allow it.`,
      confirmTitle: "Turn On",
      windowId: useBrowser.getState().tabs[tabId]?.windowId,
    });
    if (!confirmed || !matchesHost()) return false;
    useBoosts.setState({ scriptsAcknowledged: true });
  }
  if (!matchesHost()) return false;
  setBoostScript(id, { enabled: on });
  return true;
}

export async function renameBoost(tabId: string, id: string) {
  const boost = useBoosts.getState().boosts[id];
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;
  if (!boost) return;
  const name = await prompt({ title: "Rename Boost", value: boost.name, confirmTitle: "Rename", windowId });
  if (name?.trim()) updateBoost(id, { name: name.trim() });
}

export const shuffleBoost = (id: string) => updateBoost(id, (b) => shuffledBoost(b));

export async function resetBoost(tabId: string, id: string) {
  const boost = useBoosts.getState().boosts[id];
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;
  if (!boost) return;
  const { confirmed } = await confirm({
    title: `Reset all edits to “${boost.name}”?`,
    message: "Its colours, font, size, case, zaps and CSS go back to the site's own.",
    confirmTitle: "Reset",
    destructive: true,
    windowId,
  });
  if (!confirmed) return;
  const fresh = newBoost(id, boost.host, boost.createdAt, boost.name);
  updateBoost(id, { ...fresh, enabled: true });
  void refreshCounts(tabId);
}

export async function removeBoost(tabId: string | null, id: string) {
  const boost = useBoosts.getState().boosts[id];
  if (!boost) return;
  const windowId = tabId ? useBrowser.getState().tabs[tabId]?.windowId : undefined;
  const { confirmed } = await confirm({
    title: `Delete “${boost.name}”?`,
    message: `${boost.host} goes back to how it looks without it, on your other Macs too.`,
    confirmTitle: "Delete",
    destructive: true,
    windowId,
  });
  if (!confirmed) return;
  if (tabId && sessionOf(tabId)?.boostId === id) {
    stopPicking(tabId);
    patchSession(tabId, null);
  }
  deleteBoost(id);
}

export async function exportBoostFile(id: string) {
  const s = useBoosts.getState();
  const boost = s.boosts[id];
  if (!boost) return;
  const script = s.scripts[id];
  let withScript = false;
  if (script?.code.trim()) {
    const answer = await confirm({
      title: "Include its JavaScript?",
      message: "Anyone who imports the file can choose to run it on the site. Share scripts only with people you trust.",
      confirmTitle: "Include",
      cancelTitle: "Leave Out",
    });
    withScript = answer.confirmed;
  }
  const name =
    [...boost.name]
      .filter((c) => c >= " " && !'/\\?<>:*|"'.includes(c))
      .join("")
      .trim() || "Boost";
  await saveTextFile(`${name}.json`, exportBoost(boost, withScript ? script : undefined));
}

/** A Boost from a file (Bay's or Zen's) for the tab's site, opened in the editor. Its script stays off. */
export async function importBoostFile(tabId: string) {
  if (!boostsAvailable()) return;
  const tab = useBrowser.getState().tabs[tabId];
  const host = boostHost(tab?.url);
  if (!tab || !host) return;
  const json = await openTextFile(["json"]);
  if (!json) return;
  const currentTab = useBrowser.getState().tabs[tabId];
  const currentHost = boostHost(currentTab?.url);
  const result = importBoost(json, newId("boost"), host, Date.now());
  if (!result) return showToast(tab.windowId, "Couldn't Import the Boost", "The file isn't a Boost from Bay or Zen.", { icon: "exclamationmark.triangle" });
  addBoost(result.boost, result.script);
  if (!currentTab || result.boost.host !== currentHost) {
    return showToast(tab.windowId, "Boost Imported", `It's for ${result.boost.host}. Find it in Library › Boosts.`, { icon: "paintbrush" });
  }
  openBoostEditor(tabId, { boostId: result.boost.id });
  if (result.script) showToast(tab.windowId, "Boost Imported", "Its JavaScript is off until you turn it on in Code.", { icon: "paintbrush" });
}

// MARK: Following the page

let started = false;

/** Closes a tab's editor when its page leaves the site, or the tab or its Boost goes. */
function startBoostEditor() {
  if (started) return;
  started = true;
  const check = () => {
    const tabs = useBrowser.getState().tabs;
    const boosts = useBoosts.getState().boosts;
    for (const [tabId, session] of Object.entries(useBoostEditor.getState().sessions)) {
      const tab = tabs[tabId];
      if (!tab || boostHost(tab.url) !== session.host || boosts[session.boostId]?.host !== session.host) {
        patchSession(tabId, null);
        if (tab) void webviews.get(tabId)?.evaluate(pickerScript(null));
      }
    }
  };
  useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    for (const tabId of Object.keys(useBoostEditor.getState().sessions)) {
      if (s.tabs[tabId]?.url !== prev.tabs[tabId]?.url || s.tabs[tabId]?.navigation !== prev.tabs[tabId]?.navigation) countRequests.delete(tabId);
    }
    check();
  });
  useBoosts.subscribe((s, prev) => s.boosts !== prev.boosts && check());
  // A page that loads again (a zap's elements come back with it) gets its counts again.
  useBrowser.subscribe((s, prev) => {
    if (s.live === prev.live) return;
    for (const tabId of Object.keys(useBoostEditor.getState().sessions)) {
      if (!prev.live[tabId]?.isLoading && s.live[tabId]?.isLoading) countRequests.delete(tabId);
      if (prev.live[tabId]?.isLoading && !s.live[tabId]?.isLoading) {
        stopPicking(tabId);
        void refreshCounts(tabId);
      }
    }
  });
}

/** The Boosts of a tab's site, for menus: none when its page isn't a website. */
export function siteBoosts(tabId: string): Boost[] {
  const host = boostHost(useBrowser.getState().tabs[tabId]?.url);
  return host ? boostsForHost(useBoosts.getState(), host) : [];
}

/** The site's Boosts all off, or (if none is on) back on: the command bar's switch. */
export function toggleSiteBoosts(tabId: string) {
  if (!boostsAvailable()) return;
  const tab = useBrowser.getState().tabs[tabId];
  const boosts = siteBoosts(tabId);
  if (!tab || !boosts.length) return;
  const s = useBoosts.getState();
  const on = s.on && boosts.some((b) => b.enabled);
  if (!on && !s.on) useBoosts.setState({ on: true });
  for (const b of boosts) updateBoost(b.id, { enabled: !on });
  showToast(tab.windowId, on ? "Boosts Off" : "Boosts On", boostHost(tab.url), { icon: "paintbrush.pointed" });
}
