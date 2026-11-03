import { requireNativeModule } from "@bay/platform/native";
import type { EaselDocument, EaselImage } from "./easel";
import { boundedScale, renderEasel } from "./easelDraw";
import { safeUrl } from "./easelEditor";

// Library's images on the desktop web hosts. Blink decodes and normalizes them here, in the page's renderer; the host
// only moves PNG bytes (library_files.cc).

const Native = () =>
  requireNativeModule<{
    readImage(path: string): Promise<string | null>;
    storeImage(base64: string, cache: boolean): Promise<string | null>;
    saveDownload(base64: string, name: string, extension: string): Promise<string | null>;
  }>("BayEasel");
// Not from ./index: the view table this file's canvas sits in loads before it.
const Shell = () => requireNativeModule<{ copyImage(base64: string): Promise<boolean> }>("BayShell");

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? "";
const folderName = (path: string) => path.split(/[\\/]/).slice(-2, -1)[0] ?? "";

/** The host serves Library's own images by name; a page can't load a file:// URL. */
export const libraryImageUri = (path: string) =>
  `chrome://bay/library-media/${folderName(path) === "cache" ? "cache/" : ""}${encodeURIComponent(fileName(path))}`;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const blobBase64 = async (blob: Blob) => toBase64(new Uint8Array(await blob.arrayBuffer()));
const textBase64 = (text: string) => toBase64(new TextEncoder().encode(text));

function fromBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}

async function decode(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

/** A decoded picture of any format Blink reads; null for a file that isn't one. */
async function decodeBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = await decode(url);
    return image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const readPicture = async (path: string) => {
  const base64 = await Native().readImage(path);
  return base64 === null ? null : fromBase64(base64);
};

async function storePng(canvas: OffscreenCanvas, cache: boolean): Promise<EaselImage | null> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const path = await Native().storeImage(await blobBase64(blob), cache);
  return path ? { path, width: canvas.width, height: canvas.height } : null;
}

/** As EaselFiles.retain: a PNG in Library Media, within what a canvas can hold. */
async function retainBlob(blob: Blob): Promise<EaselImage | null> {
  const image = await decodeBlob(blob);
  if (!image) return null;
  const scale = boundedScale(image.naturalWidth, image.naturalHeight);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.naturalWidth * scale)), Math.max(1, Math.round(image.naturalHeight * scale)));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return storePng(canvas, false);
}

const pngOf = async (path: string) => {
  const blob = await readPicture(path);
  if (!blob) return null;
  const image = await decodeBlob(blob);
  if (!image) return null;
  const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return blobBase64(await canvas.convertToBlob({ type: "image/png" }));
};

/** As CapturePortrait.render: the picture in a rounded frame with a soft shadow, on a gradient of `colors`. */
async function portrait(path: string, colors: string[], dark: boolean): Promise<EaselImage | null> {
  const blob = await readPicture(path);
  const image = blob && (await decodeBlob(blob));
  if (!image) return null;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  // In the picture's pixels: a margin of a tenth of its shorter side, corners and shadow to match.
  const margin = Math.round(Math.min(width, height) * 0.1);
  const radius = Math.round(Math.min(width, height) * 0.025);
  const canvas = new OffscreenCanvas(width + 2 * margin, height + 2 * margin);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const only = colors[0] ?? (dark ? "#2E2E2E" : "#EBEBEB");
  const stops = colors.length > 1 ? colors : [only, only];
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  stops.forEach((color, index) => gradient.addColorStop(index / (stops.length - 1), color));
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.shadowColor = dark ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.3)";
  context.shadowBlur = margin * 0.5;
  context.shadowOffsetY = margin * 0.12;
  context.beginPath();
  context.roundRect(margin, margin, width, height, radius);
  context.fillStyle = "#FFFFFF";
  context.fill();
  context.restore();
  context.save();
  context.beginPath();
  context.roundRect(margin, margin, width, height, radius);
  context.clip();
  context.drawImage(image, margin, margin);
  context.restore();
  context.strokeStyle = dark ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.45)";
  context.lineWidth = Math.max(1, radius * 0.08);
  context.beginPath();
  context.roundRect(margin, margin, width, height, radius);
  context.stroke();
  return storePng(canvas, true);
}

/** Every picture `paths` names, decoded, for a drawing that can't wait on one. */
async function loadImages(paths: Iterable<string>) {
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(
    [...new Set(paths)].map(async (path) => {
      try {
        images.set(path, await decode(libraryImageUri(path)));
      } catch {
        // Drawn as unavailable, as a missing file is on the canvas.
      }
    }),
  );
  return images;
}

async function renderDocument(document: EaselDocument) {
  const images = await loadImages(document.items.flatMap((item) => item.path ?? []));
  return renderEasel(document, (path) => images.get(path) ?? null);
}

const escaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** As EaselFiles.exportHTML: a standalone page in Downloads, its picture embedded. */
async function exportHTML(json: string) {
  const document = JSON.parse(json) as EaselDocument;
  const title = document.title || "Easel";
  let picture = "<p>Empty canvas</p>";
  if (document.items.length) {
    const canvas = await renderDocument(document);
    if (!canvas) return null;
    const png = await blobBase64(await canvas.convertToBlob({ type: "image/png" }));
    picture = `<img alt="${escaped(title)}" width="${canvas.width}" height="${canvas.height}" src="data:image/png;base64,${png}">`;
  }
  const links = document.items.flatMap((item) => {
    const url = safeUrl(item.source?.url ?? item.url ?? "");
    return url ? [`<li><a href="${escaped(url)}" rel="noreferrer noopener">${escaped(item.source?.title ?? item.text ?? url)}</a></li>`] : [];
  });
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escaped(title)}</title><style>body{margin:32px;font:16px system-ui,sans-serif;color:#202124;background:#fafafa}h1{font-size:24px}img{max-width:100%;height:auto;border:1px solid #ddd}a{color:#165dce}li{margin:8px 0}</style>
<h1>${escaped(title)}</h1>${picture}${links.length ? `<h2>Sources</h2><ul>${links.join("")}</ul>` : ""}</html>`;
  return Native().saveDownload(textBase64(html), title.slice(0, 120), "html");
}

async function exportPNG(document: EaselDocument) {
  const canvas = await renderDocument(document);
  return canvas ? storePng(canvas, true) : null;
}

export type WebImageFiles = typeof imageFiles;
export const imageFiles = {
  retain: async (path: string) => {
    const blob = await readPicture(path);
    return blob ? retainBlob(blob) : null;
  },
  retainBlob,
  copy: async (path: string) => {
    const png = await pngOf(path);
    return png ? Shell().copyImage(png) : false;
  },
  save: async (path: string, name: string) => {
    const png = await pngOf(path);
    return png ? Native().saveDownload(png, name, "png") : null;
  },
  portrait,
  exportHTML,
  exportPNG,
};
