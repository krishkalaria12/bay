import { engineCall } from "./engineInfo";
import { Cef } from "./native";

export type FaviconImage = { uri: string; width: number; height: number };

/** What the Chrome-hosted desktop answers for an SVG icon: its engine has nothing to decode one with. */
export type FaviconSvg = { svg: string };

// Twice the sidebar's 32-point icon, as the host scales other icons.
const SVG_ICON_SIDE = 64;

/** An SVG icon as the PNG every other icon is. As an image an SVG runs no script and loads nothing. */
export async function rasterizedSvg(base64: string): Promise<FaviconImage | null> {
  try {
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${base64}`;
    await image.decode();
    const scale = SVG_ICON_SIDE / Math.max(image.naturalWidth || SVG_ICON_SIDE, image.naturalHeight || SVG_ICON_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((image.naturalWidth || SVG_ICON_SIDE) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || SVG_ICON_SIDE) * scale));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);

    return { uri: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  } catch {
    return null;
  }
}

// Chrome's FaviconService keeps icons: Chrome saves a page's icon when the page shows it and drops it with the
// page's history. `uri`s are data URIs.

/** Icons for pages (with Chrome's fallback to the host's) and for icon URLs, at about `size` pixels. */
export async function faviconsFor(profile: string, pages: string[], icons: string[] = [], size = 32) {
  const result = await engineCall<{ pages: Record<string, { png: string; icon: string }>; icons: Record<string, { png: string }> }>(
    "nn_favicons_get",
    profile,
    { pages, icons, size },
  );

  const uri = (png: string) => `data:image/png;base64,${png}`;

  return {
    pages: new Map(Object.entries(result.pages).map(([page, r]) => [page, { uri: uri(r.png), icon: r.icon }])),
    icons: new Map(Object.entries(result.icons).map(([icon, r]) => [icon, uri(r.png)])),
  };
}

/** Fetches an icon (no cookies) and, for a page Chrome has no icon for (a bookmark never visited), keeps it there. */
export async function fetchFavicon(url: string, profile: string, page?: string): Promise<FaviconImage | null> {
  const fetched = await Cef.fetchFavicon(url, profile);
  const image = fetched && "svg" in fetched ? await rasterizedSvg(fetched.svg) : fetched;
  const png = image?.uri.startsWith("data:image/png;base64,") ? image.uri.slice(22) : null;

  if (page && png) await engineCall("nn_favicons_set", profile, { page, icon: url, png }).catch(() => null);

  return image;
}

/** Deletes the PNG folder the app kept icons in before Chrome's store did. */
export const removeLegacyFavicons = (profile: string) => Cef.removeLegacyFavicons(profile);
