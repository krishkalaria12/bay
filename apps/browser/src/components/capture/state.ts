import type { CapturedImage } from "@bay/nncore";
import { copyCaptureImage, portraitCaptureImage, revealFile, saveCaptureImage, shareCaptureImage } from "@bay/shell";
import { PixelRatio } from "react-native";
import { create } from "zustand";
import { webviews } from "../../lib/webviews";
import { useBrowserRead as useBrowser } from "../../store/read";
import { showToast } from "../layout/splitActions";
import { isInternalTab } from "../pages";
import { saveLibraryMedia } from "../library/state";
import { chooseEasel, libraryWindow } from "../library/actions";
import { fileNameOf, webLink } from "../library/model";
import { revealTitle } from "../library/words";
import { engineProfile } from "../../store/model";
import { themeFor, themeKey } from "../../lib/theme";
import { captureScript } from "./captureScript";
import { captureName } from "./geometry";

// Capture, as Arc's (⇧⌘2, the command bar, Site Controls, or ⌘⇧ and a drag on the page): pick a block of the page or
// drag over an area (captureScript.ts, in the page), then copy, save, share or mark up the picture over the page
// (CaptureLayer.tsx). Capture Full Page saves the whole page to Downloads at once.

/** What was taken, in the page's CSS px from the viewport's top-left, with the viewport's size then. */
export type CaptureArea = { x?: number; y?: number; left: number; top: number; width: number; height: number; viewportWidth: number; viewportHeight: number };

export type CaptureSession =
  | { phase: "selecting" | "shooting"; url: string }
  | { phase: "ready" | "markup"; url: string; image: CapturedImage; area: CaptureArea | null; name: string };

export const useCaptures = create<{ sessions: Record<string, CaptureSession> }>()(() => ({ sessions: {} }));
export const useCapture = (tabId: string) => useCaptures((c) => c.sessions[tabId] ?? null);

const sessionOf = (tabId: string) => useCaptures.getState().sessions[tabId] ?? null;
function setSession(tabId: string, session: CaptureSession | null) {
  useCaptures.setState((c) => {
    const sessions = { ...c.sessions };
    if (session) sessions[tabId] = session;
    else delete sessions[tabId];
    return { sessions };
  });
}

// A page Chrome shows: not an app page (bay:), which isn't a web page to capture.
function capturableTab(tabId: string) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab?.url) return null;
  if (isInternalTab(tab)) {
    showToast(tab.windowId, "Can’t Capture This Page", "Capture works on web pages.", { icon: "camera.viewfinder" });
    return null;
  }
  return tab;
}

// The page's pixels per CSS px: the screen's scale times the tab's zoom.
const pixelRatioOf = (tabId: string) => PixelRatio.get() * (useBrowser.getState().tabs[tabId]?.zoom ?? 1);

/** Capture on a tab's page: its selection, or with one up, takes it away (⇧⌘2 again). `start` begins with a drag. */
export async function startCapture(tabId: string, start?: { x: number; y: number }) {
  const current = sessionOf(tabId);
  if (current?.phase === "selecting" && !start) return cancelCapture(tabId);
  if (current?.phase === "shooting") return;
  const tab = capturableTab(tabId);
  const web = webviews.get(tabId);
  if (!tab || !web) return;
  setSession(tabId, { phase: "selecting", url: tab.url });
  const installed = await web.evaluate<boolean>(captureScript(true, start));
  if (sessionOf(tabId)?.phase !== "selecting") return;
  // A page scripts can't run in (Chrome's own pages, a PDF): what it shows.
  if (installed !== true) return void shoot(tabId, {}, null);
  void web.focus();
}

export function cancelCapture(tabId: string) {
  if (sessionOf(tabId)?.phase === "selecting") void webviews.get(tabId)?.evaluate(captureScript(false));
  setSession(tabId, null);
}

/** Puts the capture away (and the page's selection, if it's up), the page taking the keyboard back. */
export function closeCapture(tabId: string) {
  if (!sessionOf(tabId)) return;
  cancelCapture(tabId);
  void webviews.get(tabId)?.focus();
}

/** Esc in the page: puts away the capture over it. */
export function closeCaptureOnEscape(tabId: string) {
  const session = sessionOf(tabId);
  if (!session || session.phase === "selecting") return false;
  closeCapture(tabId);
  return true;
}

export function retakeCapture(tabId: string) {
  setSession(tabId, null);
  void startCapture(tabId);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** What the selection in a page sends (captureScript's send): untrusted, as everything from a page. */
export function onCaptureMessage(tabId: string, data: unknown) {
  const m = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!m || sessionOf(tabId)?.phase !== "selecting") return;
  if (m.type === "cancel") return setSession(tabId, null);
  if (m.type === "fullPage") {
    setSession(tabId, null);
    return void (m.portrait === true ? capturePortrait(tabId) : captureFullPage(tabId));
  }
  if (m.type !== "capture") return;
  const { x, y, width, height, left, top, viewportWidth, viewportHeight } = m;
  if (![x, y, width, height, left, top, viewportWidth, viewportHeight].every(finite)) return setSession(tabId, null);
  if ((width as number) < 1 || (height as number) < 1 || (viewportWidth as number) < 1) return setSession(tabId, null);
  const area = { x, y, left, top, width, height, viewportWidth, viewportHeight } as CaptureArea;
  void shoot(tabId, { clip: [x as number, y as number, width as number, height as number], beyond: m.beyond === true }, area);
}

/** ⌘⇧ pressed on the page (page_script.js › Capture): Capture, with a drag from there. */
export function onCaptureGesture(tabId: string, data: unknown) {
  const m = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!m || !finite(m.x) || !finite(m.y) || sessionOf(tabId)?.phase === "shooting") return;
  void startCapture(tabId, { x: m.x, y: m.y });
}

async function shoot(tabId: string, options: { clip?: [number, number, number, number]; beyond?: boolean }, area: CaptureArea | null) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab) return setSession(tabId, null);
  setSession(tabId, { phase: "shooting", url: tab.url });
  const image = await webviews.get(tabId)?.captureImage({ ...options, pixelRatio: pixelRatioOf(tabId) });
  // Put away (or the page left) while it was taken.
  if (sessionOf(tabId)?.phase !== "shooting") return;
  if (!image) {
    setSession(tabId, null);
    return showToast(tab.windowId, "Couldn’t Capture the Page", "The page didn’t paint in time.", { icon: "camera.viewfinder" });
  }
  const now = useBrowser.getState().tabs[tabId] ?? tab;
  setSession(tabId, { phase: "ready", url: tab.url, image, area, name: captureName(now.customTitle || now.title, now.url, new Date()) });
}

// MARK: The picture

const readyOf = (tabId: string) => {
  const session = sessionOf(tabId);
  return session && (session.phase === "ready" || session.phase === "markup") ? session : null;
};
const windowOf = (tabId: string) => useBrowser.getState().tabs[tabId]?.windowId ?? null;

export async function copyCapture(tabId: string) {
  const session = readyOf(tabId);
  const windowId = windowOf(tabId);
  if (!session || !windowId) return;
  const copied = await copyCaptureImage(session.image.path);
  closeCapture(tabId);
  if (copied) showToast(windowId, "Copied Capture", undefined, { icon: "doc.on.doc" });
  else showToast(windowId, "Couldn’t Copy the Capture", undefined, { icon: "camera.viewfinder" });
}

/** Explicit saves retain a copy outside Chromium's temporary capture cache. */
export async function captureToLibrary(tabId: string, toEasel = false) {
  const session = readyOf(tabId);
  const tab = useBrowser.getState().tabs[tabId];
  if (!session || !tab || !libraryWindow(tab.windowId)) return;
  const area = session.area;
  const source = webLink(session.url)
    ? {
        url: session.url,
        title: tab.customTitle || tab.title,
        profileId: engineProfile(tab.spaceId),
        ...(area
          ? { clip: [area.x ?? area.left, area.y ?? area.top, area.width, area.height], viewportWidth: area.viewportWidth, viewportHeight: area.viewportHeight }
          : {}),
      }
    : undefined;
  const media = await saveLibraryMedia(session.image, session.name, source);
  if (!media) return showToast(tab.windowId, "Couldn't Save Capture", "Bay couldn't save the image to Library.", { icon: "camera.viewfinder" });
  if (toEasel) {
    if (await chooseEasel(media, tab.windowId)) closeCapture(tabId);
  } else {
    closeCapture(tabId);
    showToast(tab.windowId, "Saved to Library", undefined, { icon: "books.vertical" });
  }
}

export async function saveCapture(tabId: string) {
  const session = readyOf(tabId);
  const windowId = windowOf(tabId);
  if (!session || !windowId) return;
  const saved = await saveCaptureImage(session.image.path, session.name);
  closeCapture(tabId);
  savedToast(windowId, saved, "Saved Capture");
}

/** The share menu for the picture, under `anchor` (its button, in the window from its top-left). */
export function shareCapture(tabId: string, anchor?: [number, number, number, number]) {
  const session = readyOf(tabId);
  if (session) void shareCaptureImage(session.image.path, session.name, windowOf(tabId), anchor);
}

export function setMarkingUp(tabId: string, on: boolean) {
  const session = readyOf(tabId);
  if (session) setSession(tabId, { ...session, phase: on ? "markup" : "ready" });
}

/** Mark Up's Done: the marked-up picture in place of the capture. */
export function applyMarkup(tabId: string, image: CapturedImage) {
  const session = readyOf(tabId);
  if (session) setSession(tabId, { ...session, phase: "ready", image });
}

function savedToast(windowId: string, path: string | null, title: string) {
  if (!path) return showToast(windowId, "Couldn’t Save the Capture", "Bay couldn’t write to Downloads.", { icon: "camera.viewfinder" });
  const file = fileNameOf(path) || path;
  showToast(windowId, title, `In Downloads as ${file}`, {
    icon: "arrow.down.circle",
    key: "capture",
    action: { title: revealTitle, run: () => void revealFile(path) },
  });
}

/** The whole page, top to bottom, saved to Downloads at once (as Arc's Capture Full Page). */
export async function captureFullPage(tabId: string) {
  const tab = capturableTab(tabId);
  const web = webviews.get(tabId);
  if (!tab || !web) return;
  showToast(tab.windowId, "Capturing Full Page…", undefined, { icon: "camera.viewfinder", key: "capture", sticky: true });
  const image = await web.captureImage({ fullPage: true, pixelRatio: pixelRatioOf(tabId) });
  if (!image) return showToast(tab.windowId, "Couldn’t Capture the Page", "The page didn’t paint in time.", { icon: "camera.viewfinder", key: "capture" });
  const now = useBrowser.getState().tabs[tabId] ?? tab;
  const saved = await saveCaptureImage(image.path, captureName(now.customTitle || now.title, now.url, new Date(), true));
  savedToast(tab.windowId, saved, "Saved Full Page Capture");
}

/**
 * Capture in Portrait, as Arc's Portrait Mode: the page as it's shown, at 2×, framed on its space's colours. It's
 * copied, and saved to Downloads and the Library.
 */
export async function capturePortrait(tabId: string) {
  const tab = capturableTab(tabId);
  const web = webviews.get(tabId);
  if (!tab || !web) return;
  showToast(tab.windowId, "Capturing in Portrait…", undefined, { icon: "camera.viewfinder", key: "capture", sticky: true });
  const failed = () => showToast(tab.windowId, "Couldn’t Capture the Page", "The page didn’t paint in time.", { icon: "camera.viewfinder", key: "capture" });
  const shot = await web.captureImage({ pixelRatio: 2 * (tab.zoom ?? 1) });
  if (!shot) return failed();
  const s = useBrowser.getState();
  const theme = themeFor(themeKey(s, tab.windowId, tab.spaceId));
  const own = s.spaces[tab.spaceId]?.theme?.colors ?? [];
  const framed = await portraitCaptureImage(shot.path, own.length ? [...own] : [theme.accent, theme.windowTint[1]], theme.dark);
  if (!framed) return failed();
  const now = useBrowser.getState().tabs[tabId] ?? tab;
  const name = captureName(now.customTitle || now.title, now.url, new Date(), "portrait");
  await copyCaptureImage(framed.path);
  const source = webLink(now.url) ? { url: now.url, title: now.customTitle || now.title, profileId: engineProfile(now.spaceId) } : undefined;
  if (libraryWindow(tab.windowId)) void saveLibraryMedia(framed, name, source);
  const saved = await saveCaptureImage(framed.path, name);
  savedToast(tab.windowId, saved, "Copied Portrait Capture");
}

let started = false;

/** Puts a capture away when its page goes: its tab closed, or another document loaded in it. */
export function startCaptures() {
  if (started) return;
  started = true;
  const page = (url: string) => url.replace(/#.*$/, "");
  useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    for (const [tabId, session] of Object.entries(useCaptures.getState().sessions)) {
      const url = s.tabs[tabId]?.url;
      if (url === undefined) setSession(tabId, null);
      else if (page(url) !== page(session.url)) cancelCapture(tabId);
    }
  });
}
