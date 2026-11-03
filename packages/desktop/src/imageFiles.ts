import type { WebImageFiles } from "./imageFiles.web";

/** Image work the host's native modules do on macOS; the desktop web hosts do it here (imageFiles.web.ts). */
export const imageFiles: WebImageFiles | null = null;

export const libraryImageUri = (path: string) => `file://${path.split("/").map(encodeURIComponent).join("/")}`;
