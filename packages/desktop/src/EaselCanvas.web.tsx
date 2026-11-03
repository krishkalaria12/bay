import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type ForwardedRef } from "react";
import { View, type ViewProps } from "@bay/platform";
import { requireNativeModule } from "@bay/platform/native";
import type { EaselCanvasHandle, EaselItem, EaselState, EaselTool } from "./easel";
import { drawItem } from "./easelDraw";
import { EaselEditor, itemRect, type EaselModifiers, type Point, type RetainedImage } from "./easelEditor";
import { imageFiles, libraryImageUri } from "./imageFiles.web";

// The Easel canvas on the desktop web hosts: a <canvas> over EaselEditor, as EaselCanvasView is on macOS.

// Not from ./index: this file sits in the view table, which loads before it.
const showMenu = (items: { id: string; title: string; enabled: boolean }[]) =>
  requireNativeModule<{ showMenu(items: unknown[]): Promise<string | null> }>("BayShell").showMenu(items);

const CLIPBOARD_TYPE = "web application/x-bay-easel";
const ACCENT = "#0A84FF";

type Props = ViewProps & {
  document: string;
  tool: EaselTool;
  color: string;
  lineWidth: number;
  dark: boolean;
  onEaselChange?: (event: { nativeEvent: EaselState }) => void;
  onEaselOpenLink?: (event: { nativeEvent: { url: string } }) => void;
};

const modifiers = (event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): EaselModifiers => ({
  shift: event.shiftKey,
  option: event.altKey,
  command: event.ctrlKey || event.metaKey,
});

const editorStyle = (dark: boolean): CSSProperties => ({
  position: "absolute",
  margin: 0,
  padding: 2,
  resize: "none",
  outline: "none",
  overflow: "hidden",
  boxSizing: "border-box",
  border: `1px solid ${ACCENT}`,
  fontFamily: "inherit",
  lineHeight: 1.25,
  background: dark ? "#1E1E1E" : "#FFFFFF",
});

function EaselCanvasView({ document, tool, color, lineWidth, dark, onEaselChange, onEaselOpenLink, ...props }: Props, ref: ForwardedRef<EaselCanvasHandle>) {
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const latest = useRef({ onEaselChange, onEaselOpenLink, dark });
  latest.current = { onEaselChange, onEaselOpenLink, dark };
  const images = useRef(new Map<string, HTMLImageElement | null>());
  const frame = useRef(0);

  const editor = useRef<EaselEditor | null>(null);
  editor.current ??= new EaselEditor({
    size: () => ({ width: box.current?.clientWidth ?? 0, height: box.current?.clientHeight ?? 0 }),
    changed: () => paint(),
    emit: (state) => latest.current.onEaselChange?.({ nativeEvent: state }),
    openLink: (url) => latest.current.onEaselOpenLink?.({ nativeEvent: { url } }),
    openEditor,
    editorText: () => field.current?.value ?? null,
    closeEditor,
  });
  const easel = editor.current;

  function paint() {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      draw();
    });
  }

  function imageFor(path: string) {
    const known = images.current.get(path);
    if (known !== undefined) return known;
    const image = new Image();
    images.current.set(path, null);
    image.onload = () => {
      images.current.set(path, image);
      paint();
    };
    image.src = libraryImageUri(path);
    return null;
  }

  function draw() {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const { width, height } = element.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    if (element.width !== Math.round(width * scale) || element.height !== Math.round(height * scale)) {
      element.width = Math.round(width * scale);
      element.height = Math.round(height * scale);
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = easel.document.background || (latest.current.dark ? "#1A1A1A" : "#FFFFFF");
    context.fillRect(0, 0, width, height);
    context.save();
    context.scale(easel.zoom, easel.zoom);
    context.translate(-easel.viewport.x, -easel.viewport.y);
    for (const item of easel.items) drawItem(context, item, imageFor);
    if (easel.draft) drawItem(context, easel.draft, imageFor);
    context.restore();
    context.strokeStyle = ACCENT;
    context.lineWidth = 1;
    const selected = easel.selectedBounds;
    if (selected) {
      const origin = easel.screen(selected);
      const w = selected.width * easel.zoom;
      const h = selected.height * easel.zoom;
      context.strokeRect(origin.x, origin.y, w, h);
      context.fillStyle = "#FFFFFF";
      for (const [x, y] of [
        [origin.x, origin.y],
        [origin.x + w, origin.y],
        [origin.x + w, origin.y + h],
        [origin.x, origin.y + h],
      ] as const) {
        context.fillRect(x - 4, y - 4, 8, 8);
        context.strokeRect(x - 4, y - 4, 8, 8);
      }
    }
    if (easel.marquee) {
      const { x, y, width: w, height: h } = easel.marquee;
      context.fillStyle = "rgba(10, 132, 255, 0.08)";
      context.fillRect(x, y, w, h);
      context.strokeRect(x, y, w, h);
    }
    element.style.cursor = easel.cursor;
  }

  function openEditor(item: EaselItem, key: "text" | "url") {
    closeEditor();
    const host = box.current;
    if (!host) return;
    const rect = itemRect(item);
    const at = easel.screen(rect);
    const input = window.document.createElement("textarea");
    Object.assign(input.style, editorStyle(latest.current.dark), {
      left: `${at.x}px`,
      top: `${at.y}px`,
      width: `${Math.max(100, rect.width * easel.zoom)}px`,
      height: `${Math.max(32, rect.height * easel.zoom)}px`,
      fontSize: `${Math.max(10, (item.fontSize ?? 24) * easel.zoom)}px`,
      color: item.color ?? easel.ink,
    });
    input.value = String(item[key] ?? "");
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        easel.cancelEditor();
        host.focus();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        easel.commitText();
        host.focus();
      }
    });
    input.addEventListener("blur", () => easel.commitText());
    host.append(input);
    field.current = input;
    input.focus();
    input.select();
  }

  function closeEditor() {
    const input = field.current;
    field.current = null;
    input?.remove();
  }

  const pointAt = (event: { clientX: number; clientY: number }): Point => {
    const rect = box.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  async function paste(data: DataTransfer | null, at?: Point) {
    if (!data) return false;
    const items = data.getData(CLIPBOARD_TYPE);
    if (items && easel.pasteItems(items, at)) return true;
    const files = [...data.files].filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      const retained = await Promise.all(files.map((file) => imageFiles.retainBlob(file)));
      easel.insertImages(
        retained.filter((image): image is RetainedImage => !!image),
        at,
      );
      return true;
    }
    return easel.pasteText(data.getData("text/uri-list").split("\n")[0] || data.getData("text/plain"), at);
  }

  // The context menu has no paste event to read, only the async clipboard.
  async function pasteFromMenu(at: Point) {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          const image = await imageFiles.retainBlob(await item.getType(type));
          if (image) easel.insertImages([image], at);
          return;
        }
      }
      easel.pasteText(await navigator.clipboard.readText(), at);
    } catch (error) {
      console.error("Couldn't read the clipboard", error);
    }
  }

  function copy(data: DataTransfer | null) {
    const copied = easel.copySelection();
    if (!copied || !data) return false;
    data.setData(CLIPBOARD_TYPE, copied.items);
    if (copied.plain) data.setData("text/plain", copied.plain);
    return true;
  }

  async function copyFromMenu() {
    const copied = easel.copySelection();
    if (!copied) return;
    await navigator.clipboard.write([
      new ClipboardItem({
        [CLIPBOARD_TYPE]: new Blob([copied.items], { type: "application/x-bay-easel" }),
        ...(copied.plain ? { "text/plain": new Blob([copied.plain], { type: "text/plain" }) } : {}),
      }),
    ]);
  }

  async function contextMenu(point: Point) {
    easel.menuAt(point);
    const choice = await showMenu(easel.menu);
    if (choice === "copy") await copyFromMenu();
    else if (choice === "cut") {
      await copyFromMenu();
      easel.deleteSelection();
    } else if (choice === "paste") await pasteFromMenu(easel.world(point));
    else if (choice) easel.runMenu(choice);
  }

  useEffect(() => {
    const host = box.current;
    const element = canvas.current;
    if (!host || !element) return;
    let pressed = false;
    const down = (event: PointerEvent) => {
      if (event.button === 2) return;
      event.preventDefault();
      host.focus();
      pressed = true;
      element.setPointerCapture(event.pointerId);
      easel.pointerDown(pointAt(event), { ...modifiers(event), button: event.button, clickCount: event.detail });
    };
    const move = (event: PointerEvent) => {
      if (pressed) easel.pointerMove(pointAt(event), modifiers(event));
    };
    const up = () => {
      if (!pressed) return;
      pressed = false;
      easel.pointerUp();
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.altKey) easel.zoomBy(Math.exp(-event.deltaY * 0.01), pointAt(event));
      else {
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
        easel.scroll({ x: event.deltaX * unit, y: event.deltaY * unit });
      }
    };
    const key = (event: KeyboardEvent) => {
      if (field.current) return;
      if (easel.keyDown({ key: event.key, ...modifiers(event) })) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const keyUp = (event: KeyboardEvent) => easel.keyUp(event.key);
    const blur = () => easel.blur();
    const onCopy = (event: ClipboardEvent) => {
      if (!field.current && copy(event.clipboardData)) event.preventDefault();
    };
    const onCut = (event: ClipboardEvent) => {
      if (field.current || !copy(event.clipboardData)) return;
      event.preventDefault();
      easel.deleteSelection();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (field.current) return;
      event.preventDefault();
      void paste(event.clipboardData);
    };
    const over = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      void paste(event.dataTransfer, easel.world(pointAt(event)));
    };
    const menu = (event: MouseEvent) => {
      event.preventDefault();
      host.focus();
      void contextMenu(pointAt(event));
    };
    const resized = new ResizeObserver(() => {
      easel.commitText();
      easel.emit();
    });
    resized.observe(host);
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("wheel", wheel, { passive: false });
    host.addEventListener("keydown", key);
    host.addEventListener("keyup", keyUp);
    host.addEventListener("blur", blur);
    host.addEventListener("copy", onCopy);
    host.addEventListener("cut", onCut);
    host.addEventListener("paste", onPaste);
    host.addEventListener("dragover", over);
    host.addEventListener("drop", drop);
    host.addEventListener("contextmenu", menu);
    return () => {
      resized.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("wheel", wheel);
      host.removeEventListener("keydown", key);
      host.removeEventListener("keyup", keyUp);
      host.removeEventListener("blur", blur);
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("cut", onCut);
      host.removeEventListener("paste", onPaste);
      host.removeEventListener("dragover", over);
      host.removeEventListener("drop", drop);
      host.removeEventListener("contextmenu", menu);
    };
  }, []);

  useEffect(() => easel.load(document), [document]);
  useEffect(() => easel.setTool(tool), [tool]);
  useEffect(() => {
    easel.ink = color;
    easel.strokeWidth = lineWidth;
  }, [color, lineWidth]);
  useEffect(paint, [dark]);

  useImperativeHandle(
    ref,
    () => ({
      undo: async () => easel.undo(),
      redo: async () => easel.redo(),
      selectAll: async () => easel.selectAll(),
      deleteSelection: async () => easel.deleteSelection(),
      duplicateSelection: async () => easel.duplicateSelection(),
      bringToFront: async () => easel.reorder(true),
      sendToBack: async () => easel.reorder(false),
      zoomIn: async () => easel.zoomBy(1.2),
      zoomOut: async () => easel.zoomBy(1 / 1.2),
      fit: async () => easel.fit(),
      export: async () => {
        easel.commitText();
        return imageFiles.exportPNG(easel.document);
      },
      // Web sharing stays off on these hosts (isEaselWebSharingEnabled).
      prepareShare: async () => {
        throw new Error("Easel web sharing isn't available on this platform.");
      },
      addText: async (text) => easel.addText(text),
      addLink: async (url, title) => easel.addLink(url, title),
      addImages: async (paths) => {
        const retained = await Promise.all(paths.map((path) => imageFiles.retain(path)));
        easel.insertImages(retained.filter((image): image is RetainedImage => !!image));
      },
      focus: async () => box.current?.focus(),
    }),
    [],
  );

  return (
    <View {...props}>
      <div ref={box} tabIndex={0} style={{ position: "absolute", inset: 0, outline: "none", overflow: "hidden", userSelect: "none" }}>
        <canvas ref={canvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none" }} />
      </div>
    </View>
  );
}

export const EaselCanvasWeb = forwardRef(EaselCanvasView);
