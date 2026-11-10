// Image long-press (B13): a bare image's menu. WebKit exposes link elements in its context-menu hook but nothing
// for images, so on iOS the page reports long presses itself; Android's hit test covers images natively and ignores
// the report. State lives under Symbol.for("bay.images").
import * as v from "valibot";

/** One image press, as the page reported it. Structurally a `LinkPress` with `image: true`. */
export type ImagePress = { url: string; title: string; x: null; y: null; image: true };

/**
 * Starts reporting long presses on images (outside links); running it again on the same document does nothing.
 * Posts `{ type: "image", ready: true }` once armed, so the engine can tell WebKit to keep its own image menu down
 * while this one is watching, then one `{ type: "image", src, title }` per long press.
 */
export const WATCH_IMAGES_SCRIPT = `
const state = (window[Symbol.for("bay.images")] ??= {});
if (state.watching) return true;
state.watching = true;
post({ type: "image", ready: true });
let timer = null;
let target = null;
const imageIn = (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  // Shadow DOM hosts an image just as strongly; composedPath covers it, and plain elements climb by hand.
  const path = typeof target.composedPath === "function" ? target.composedPath() : [target];
  const image = path.some((node) => node instanceof HTMLImageElement && node.isConnected)
    ? path.find((node) => node instanceof HTMLImageElement)
    : null;
  if (!image) return null;
  // Images a link already covers are links: WebKit reports their menu natively.
  return image.closest("a") ? null : image;
};
document.addEventListener("touchstart", (event) => {
  timer !== null && clearTimeout(timer);
  target = null;
  const image = imageIn(event);
  if (!image || event.touches.length !== 1) return;
  target = image;
  // Beats WebKit's own long-press menu, which shows at about 0.5s.
  timer = setTimeout(() => {
    const image = target;
    target = null;
    if (!image || !image.isConnected) return;
    const src = image.currentSrc || image.src || "";
    try {
      const address = new URL(src, location.href).toString();
      if (address.startsWith("http")) {
        post({ type: "image", src: address, title: (image.alt || "").slice(0, 200) });
      }
    } catch {}
  }, 400);
}, true);
const leave = (event) => {
  if (target && event.touches && event.touches.length === 0) {
    timer !== null && clearTimeout(timer);
    timer = null;
    target = null;
  }
};
document.addEventListener("touchend", leave, true);
document.addEventListener("touchmove", () => {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  target = null;
}, true);
return true;
`;

const imageMessageSchema = v.object({
  type: v.literal("image"),
  src: v.string(),
  title: v.string(),
});

/** Parses a page message as an image press; null for anything else (including the arming ping). Messages come from the page, so check them. */
export function parseImagePress(message: string): ImagePress | null {
  let value: unknown;

  try {
    value = JSON.parse(message);
  } catch {
    // Not JSON: not an image press.
    return null;
  }

  const parsed = v.safeParse(imageMessageSchema, value);

  if (!parsed.success) return null;

  const src = parsed.output.src;

  try {
    const address = new URL(src);

    if (!["http:", "https:"].includes(address.protocol) || !address.hostname) return null;

    return { url: address.toString(), title: parsed.output.title.trim() || address.toString(), x: null, y: null, image: true };
  } catch {
    return null;
  }
}
