import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import type { Ref } from "react";
import type { ViewProps } from "react-native";

// Capture's files (a PNG the engine wrote, NNCoreWebView captureImage) and its Mark Up canvas (ios/Capture.swift).

const Capture = requireNativeModule<{
  copyImage(path: string): Promise<boolean>;
  saveImage(path: string, name: string): Promise<string | null>;
  shareImage(path: string, name: string, windowId: string | null, anchor: number[] | null): Promise<void>;
  portraitImage(path: string, colors: string[], dark: boolean): Promise<{ path: string; width: number; height: number } | null>;
  copyQuote(text: string, title: string, url: string, colors: string[], dark: boolean): Promise<boolean>;
  shareQuote(text: string, title: string, url: string, colors: string[], dark: boolean, windowId: string): Promise<boolean>;
}>("BayCapture");

export type QuoteCard = { text: string; title: string; url: string; colors: string[]; dark: boolean };
/** A locally rendered quote card and its text-fragment link in one clipboard item. */
export const copyQuoteCard = ({ text, title, url, colors, dark }: QuoteCard) => Capture.copyQuote(text, title, url, colors, dark);
/** Share the card image together with the link to its source passage. */
export const shareQuoteCard = ({ text, title, url, colors, dark }: QuoteCard, windowId: string) => Capture.shareQuote(text, title, url, colors, dark, windowId);

/** Capture in Portrait: the picture framed, with a shadow, on a gradient of `colors` (hex), as a new PNG. */
export const portraitCaptureImage = (path: string, colors: string[], dark: boolean) => Capture.portraitImage(path, colors, dark);

/** The picture on the clipboard. */
export const copyCaptureImage = (path: string) => Capture.copyImage(path);
/** A copy in Downloads named `name` (numbered when taken): its path. */
export const saveCaptureImage = (path: string, name: string) => Capture.saveImage(path, name);
/** The share menu for the picture, under `anchor` (x, y, width, height in the window's content from its top-left). */
export const shareCaptureImage = (path: string, name: string, windowId: string | null, anchor?: [number, number, number, number]) =>
  Capture.shareImage(path, name, windowId, anchor ?? null);

export type MarkupTool = "pen" | "highlighter" | "arrow" | "rect" | "oval" | "text";
export type MarkupState = { canUndo: boolean; canRedo: boolean; marks: number };

export type MarkupCanvasHandle = {
  undo(): Promise<void>;
  redo(): Promise<void>;
  clear(): Promise<void>;
  /** The picture with its marks, as a new PNG. */
  export(): Promise<{ path: string; width: number; height: number } | null>;
};

export type MarkupCanvasProps = ViewProps & {
  ref?: Ref<MarkupCanvasHandle>;
  path: string;
  tool: MarkupTool;
  color: string;
  /** The pen's width in points. */
  lineWidth: number;
  onChange?: (state: MarkupState) => void;
};

// Not onChange: React Native has its own (bubbling) change event, and one name can't be both.
type NativeMarkupProps = Omit<MarkupCanvasProps, "onChange"> & { onMarkupChange?: (e: { nativeEvent: MarkupState }) => void };

const NativeMarkup = requireNativeViewManager<NativeMarkupProps>("BayCapture");

export function MarkupCanvas({ onChange, ...props }: MarkupCanvasProps) {
  return <NativeMarkup {...props} onMarkupChange={onChange && ((e) => onChange(e.nativeEvent))} />;
}
