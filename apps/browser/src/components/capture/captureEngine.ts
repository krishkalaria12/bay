// The live side of capture: the tab's page and the Mac's capture calls. React Native and the Library's menus are
// required when a capture first needs them: the runtime that loads this file also runs under the app's Node tests,
// and the Library's menus reach the runtime themselves.
import { copyCaptureImage, copyImage, portraitCaptureImage, revealFile, saveCaptureImage, shareCaptureImage } from "@bay/desktop";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { webviews } from "../../lib/webviews";
import { CaptureEngine, CaptureFailure } from "./service";

type LibraryActions = typeof import("../library/actions");

type ReactNative = typeof import("react-native");

const libraryActions = (): LibraryActions => require("../library/actions");

const reactNative = (): ReactNative => require("react-native");

/** A native call, with its failure named. */
function nativeCall<A>(name: string, resource: string | undefined, run: () => A | Promise<A>): Effect.Effect<A, CaptureFailure> {
  return Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new CaptureFailure({ operation: { name, resource }, cause }),
  });
}

/** The page and the Mac, as a capture reaches them. */
export const captureEngineLayer = Layer.succeed(CaptureEngine)({
  hasPage: (tabId) => !!webviews.get(tabId),
  evaluate: (tabId, script) => nativeCall("capture.evaluate", tabId, () => webviews.get(tabId)?.evaluate<unknown>(script) ?? null),
  focus: (tabId) =>
    Effect.sync(() => {
      void webviews.get(tabId)?.focus();
    }),
  screenScale: () => reactNative().PixelRatio.get(),
  shoot: (tabId, options) => nativeCall("capture.shoot", tabId, async () => (await webviews.get(tabId)?.captureImage(options)) ?? null),
  screenshot: (tabId) => nativeCall("capture.screenshot", tabId, async () => (await webviews.get(tabId)?.captureScreenshot()) ?? null),
  copyPng: (png) => nativeCall("capture.copyPng", undefined, () => copyImage(png)),
  copy: (path) => nativeCall("capture.copy", undefined, () => copyCaptureImage(path)),
  save: (path, name) => nativeCall("capture.save", undefined, () => saveCaptureImage(path, name)),
  share: (path, name, windowId, anchor) => nativeCall("capture.share", undefined, () => shareCaptureImage(path, name, windowId, anchor)).pipe(Effect.asVoid),
  portrait: (path, colors, dark) => nativeCall("capture.portrait", undefined, () => portraitCaptureImage(path, colors, dark)),
  reveal: (path) => void revealFile(path),
  libraryWindow: (windowId) => libraryActions().libraryWindow(windowId),
  chooseEasel: (media, windowId) => nativeCall("capture.easel", undefined, () => libraryActions().chooseEasel(media, windowId)),
});
