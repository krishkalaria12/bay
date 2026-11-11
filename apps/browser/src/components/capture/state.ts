// Capture, as Arc's (⇧⌘2, the command bar, Site Controls, or ⌘⇧ and a drag on the page): pick a block of the page or
// drag over an area (captureScript.ts, in the page), then copy, save, share or mark up the picture over the page
// (CaptureLayer.tsx). Capture Full Page saves the whole page to Downloads at once.
//
// The work is the capture service's (service.ts): each capture is a job that belongs to its tab and its document.
// This is where the app reaches it, and where the overlay's own state changes at once.
import type { CapturedImage } from "@bay/chromium";
import * as Effect from "effect/Effect";
import { runDesktop } from "../../effect/runtime";
import type { JsonInput } from "../../lib/json";
import { CaptureService, readyOf, sessionOf, setSession, useCaptures, type Capture } from "./service";

export { useCaptures, type CaptureArea, type CaptureSession } from "./service";

export const useCapture = (tabId: string) => useCaptures((c) => c.sessions[tabId] ?? null);

/** Runs something with the capture service, on the runtime the app shares. */
const withCapture = <A>(program: (capture: Capture) => Effect.Effect<A>): Promise<A> =>
  runDesktop(
    Effect.gen(function* () {
      const capture = yield* CaptureService;

      return yield* program(capture);
    }),
  );

/** Capture on a tab's page: its selection, or with one up, takes it away (⇧⌘2 again). `start` begins with a drag. */
export function startCapture(tabId: string, start?: { x: number; y: number }) {
  return withCapture((capture) => capture.begin(tabId, start));
}

export function cancelCapture(tabId: string) {
  void withCapture((capture) => capture.cancel(tabId));
}

/** Puts the capture away (and the page's selection, if it's up), the page taking the keyboard back. */
export function closeCapture(tabId: string) {
  void withCapture((capture) => capture.close(tabId));
}

/** Esc in the page: puts away the capture over it. */
export function closeCaptureOnEscape(tabId: string) {
  const session = sessionOf(tabId);

  if (!session || session.phase === "selecting") return false;
  closeCapture(tabId);

  return true;
}

export function retakeCapture(tabId: string) {
  void withCapture((capture) => capture.retake(tabId));
}

/** What the selection in a page sends (captureScript's send): untrusted, as everything from a page. */
export function onCaptureMessage(tabId: string, data: JsonInput) {
  void withCapture((capture) => capture.message(tabId, data));
}

/** ⌘⇧ pressed on the page (page_script.js › Capture): Capture, with a drag from there. */
export function onCaptureGesture(tabId: string, data: JsonInput) {
  void withCapture((capture) => capture.gesture(tabId, data));
}

export function copyCapture(tabId: string) {
  return withCapture((capture) => capture.copy(tabId));
}

/** Explicit saves retain a copy outside Chromium's temporary capture cache. */
export function captureToLibrary(tabId: string, toEasel = false) {
  return withCapture((capture) => capture.toLibrary(tabId, toEasel));
}

export function saveCapture(tabId: string) {
  return withCapture((capture) => capture.save(tabId));
}

/** The share menu for the picture, under `anchor` (its button, in the window from its top-left). */
export function shareCapture(tabId: string, anchor?: [number, number, number, number]) {
  void withCapture((capture) => capture.share(tabId, anchor));
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

/** The whole page, top to bottom, saved to Downloads at once (as Arc's Capture Full Page). */
export function captureFullPage(tabId: string) {
  return withCapture((capture) => capture.fullPage(tabId));
}

/**
 * Capture in Portrait, as Arc's Portrait Mode: the page as it's shown, at 2×, framed on its space's colours. It's
 * copied, and saved to Downloads and the Library.
 */
export function capturePortrait(tabId: string) {
  return withCapture((capture) => capture.portrait(tabId));
}

/** The page as it's shown, on the clipboard: a PNG at the screen's scale (the developer's screenshot). */
export function copyScreenshot(tabId: string) {
  return withCapture((capture) => capture.screenshot(tabId));
}

let started = false;

/** Puts a capture away when its page goes: its tab closed, or another document loaded in it. */
export function startCaptures() {
  if (started) return;
  started = true;
  void withCapture((capture) => capture.start);
}
