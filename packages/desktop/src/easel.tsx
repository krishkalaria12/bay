import { hasNativeModule } from "@bay/platform";
import { requireNativeModule, nativeSnapshot } from "@bay/platform/native";
import { requireNativeViewManager } from "./nativeViews";
import { imageFiles } from "./imageFiles";
import type { Ref } from "react";
import type { ViewProps } from "@bay/platform";

export type EaselSource = {
  url: string;
  title: string;
  clip?: number[];
  viewportWidth?: number;
  viewportHeight?: number;
  profileId?: string;
  [key: string]: unknown;
};

export type EaselItem = {
  id: string;
  kind: "image" | "text" | "link" | "pen" | "rect" | "ellipse" | "arrow";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  lineWidth?: number;
  fontSize?: number;
  text?: string;
  url?: string;
  path?: string;
  /** Pen and arrow points relative to the item's top-left, in world units. */
  points?: number[][];
  source?: EaselSource;
  live?: boolean;
  [key: string]: unknown;
};

export type EaselDocument = {
  id: string;
  title: string;
  background: string;
  items: EaselItem[];
  createdAt: number;
  updatedAt: number;
  spaceId: string;
  nativeEditId?: string;
  [key: string]: unknown;
};

export type EaselTool = "select" | "hand" | "pen" | "text" | "rect" | "ellipse" | "arrow";
export type EaselImage = { path: string; width: number; height: number };
export type EaselState = {
  document: string;
  canUndo: boolean;
  canRedo: boolean;
  selection: string[];
  zoom: number;
  tool?: EaselTool;
  /** Screen coordinates are (world - viewport.x/y) * viewport.zoom. */
  viewport: { x: number; y: number; zoom: number };
};

export type EaselCanvasHandle = {
  undo(): Promise<void>;
  redo(): Promise<void>;
  selectAll(): Promise<void>;
  deleteSelection(): Promise<void>;
  duplicateSelection(): Promise<void>;
  bringToFront(): Promise<void>;
  sendToBack(): Promise<void>;
  zoomIn(): Promise<void>;
  zoomOut(): Promise<void>;
  fit(): Promise<void>;
  export(): Promise<EaselImage | null>;
  prepareShare(title: string): Promise<string>;
  addText(text: string): Promise<void>;
  addLink(url: string, title: string): Promise<void>;
  addImages(paths: string[]): Promise<void>;
  focus(): Promise<void>;
};

export type EaselCanvasProps = ViewProps & {
  ref?: Ref<EaselCanvasHandle>;
  document: string;
  tool: EaselTool;
  color: string;
  lineWidth: number;
  dark: boolean;
  onChange?: (state: EaselState) => void;
  onOpenLink?: (url: string) => void;
};

type NativeEaselProps = Omit<EaselCanvasProps, "onChange" | "onOpenLink"> & {
  onEaselChange?: (event: { nativeEvent: EaselState }) => void;
  onEaselOpenLink?: (event: { nativeEvent: { url: string } }) => void;
};
const NativeEasel = requireNativeViewManager<NativeEaselProps>("BayEasel");

export function EaselCanvas({ onChange, onOpenLink, ...props }: EaselCanvasProps) {
  return (
    <NativeEasel
      {...props}
      onEaselChange={onChange && ((event) => onChange(event.nativeEvent))}
      onEaselOpenLink={onOpenLink && ((event) => onOpenLink(event.nativeEvent.url))}
    />
  );
}

const Capture = () =>
  requireNativeModule<{
    isEaselWebSharingEnabled(): boolean;
    retainLibraryImage(path: string): Promise<EaselImage | null>;
    removeLibraryImage(path: string): Promise<boolean>;
    libraryImageExists(path: string): Promise<boolean>;
    exportEaselHTML(document: string): Promise<string | null>;
    createEaselShareIdentity(): Promise<{ id: string; key: string }>;
    readEaselShareRecords(): string | null;
    /** The desktop web hosts' file moves (imageFiles.web.ts). macOS has none. */
    readImage?(path: string): Promise<string | null>;
    storeImage?(base64: string, cache: boolean): Promise<string | null>;
    saveDownload?(base64: string, name: string, extension: string): Promise<string | null>;
  }>("BayEasel");

/** Opt-in launch flag; unset and false both keep web sharing disabled. */
export const isEaselWebSharingEnabled = () =>
  hasNativeModule("BayEasel") && nativeSnapshot("BayEasel", "isEaselWebSharingEnabled", [], () => Capture().isEaselWebSharingEnabled());

/** Copies and normalizes a local image into the app's durable Library Media folder. */
export const retainLibraryImage = async (path: string) => (imageFiles ? imageFiles.retain(path) : Capture().retainLibraryImage(path));
/** Deletes only files inside the app's Library Media folder. */
export const removeLibraryImage = async (path: string) => Capture().removeLibraryImage(path);
export const libraryImageExists = async (path: string) => Capture().libraryImageExists(path);
/** Saves a standalone HTML canvas with embedded PNG media in Downloads. */
export const exportEaselHTML = async (document: string) => (imageFiles ? imageFiles.exportHTML(document) : Capture().exportEaselHTML(document));
/** Generates independent, cryptographically random public and management capabilities. */
export const createEaselShareIdentity = async () => Capture().createEaselShareIdentity();
/** Returns null only for a missing registry; throws on read or decoding failures. */
export const readEaselShareRecords = () => nativeSnapshot("BayEasel", "readEaselShareRecords", [], () => Capture().readEaselShareRecords());
export { libraryImageUri } from "./imageFiles";
