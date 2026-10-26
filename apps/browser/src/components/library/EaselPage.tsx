import { Pressable, TextInput, View } from "@bay/platform";
import { WebView, type WebViewHandle } from "@bay/nncore";
import {
  EaselCanvas,
  isEaselWebSharingEnabled,
  pickFiles,
  prompt,
  showMenu,
  Symbol,
  type EaselCanvasHandle,
  type EaselState,
  type EaselTool,
} from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useTheme } from "../../lib/theme";
import { reportBrowserCommand } from "../../runtime/commands";
import { newTab } from "../../runtime/tabActions";
import { useBrowserRead as useBrowser } from "../../store/read";
import { engineProfile } from "../../store/model";
import { engineIdOf } from "../../store/spaces";
import { showToast } from "../layout/splitActions";
import { IconButton } from "../primitives";
import { Button } from "../settings/controls";
import { openLibrary, renameEasel, removeEasel } from "./actions";
import { writeEaselHTML, writeEaselPNG } from "./export";
import { applyEaselDocument, startLibrary, updateEasel, useLibrary } from "./state";
import { liveClipTransform } from "./liveClip";
import { webLink, type EaselItem } from "./model";
import { EaselShareButton } from "./EaselShareButton";

export const easelCanvases = new Map<string, EaselCanvasHandle>();
export const easelCanvasStates = new Map<string, EaselState>();
const TOOLS: { tool: EaselTool; icon: string; title: string }[] = [
  { tool: "select", icon: "cursorarrow", title: "Select (V)" },
  { tool: "hand", icon: "hand.draw", title: "Pan (H or hold Space)" },
  { tool: "pen", icon: "pencil.tip", title: "Draw (P)" },
  { tool: "text", icon: "textformat", title: "Text (T)" },
  { tool: "rect", icon: "rectangle", title: "Rectangle (R)" },
  { tool: "ellipse", icon: "circle", title: "Ellipse (O)" },
  { tool: "arrow", icon: "arrow.up.right", title: "Arrow (A)" },
];
const COLORS = ["#242424", "#E5484D", "#E98C2B", "#EBCB43", "#42A372", "#3684D6", "#9163CB", "#FFFFFF"];
const INITIAL_CANVAS: EaselState = { canUndo: false, canRedo: false, selection: [], zoom: 1, viewport: { x: 0, y: 0, zoom: 1 }, document: "" };

export function EaselPage({ tabId, easelId }: { tabId: string; easelId: string | null }) {
  const theme = useTheme();
  const windowId = useBrowser((s) => s.tabs[tabId]?.windowId ?? "");
  const isPrivate = useBrowser((s) => !!s.windows[windowId]?.incognito);
  const doc = useLibrary((s) => (easelId ? s.easels[easelId] : undefined));
  const error = useLibrary((s) => s.error);
  const canvas = useRef<EaselCanvasHandle>(null);
  const [tool, setTool] = useState<EaselTool>("select");
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(3);
  const [state, setState] = useState(INITIAL_CANVAS);
  const [busy, setBusy] = useState(false);
  const [activeLive, setActiveLive] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(startLibrary, []);
  useEffect(() => {
    if (canvas.current) easelCanvases.set(tabId, canvas.current);
    return () => {
      easelCanvases.delete(tabId);
      easelCanvasStates.delete(tabId);
    };
  }, [tabId, !!doc, isPrivate]);

  if (isPrivate || !doc || error)
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 28 }}>
        <Symbol name="scribble.variable" size={32} color={theme.textTertiary} style={{ width: 40, height: 40 }} />
        <Text style={{ color: theme.textPrimary, fontSize: 18, fontWeight: "600" }}>
          {isPrivate ? "Easels live in regular windows" : error ? "Couldn't Open Easel" : "This Easel is no longer in Library"}
        </Text>
        {error ? <Text style={{ color: theme.textSecondary }}>{error}</Text> : null}
        {!isPrivate ? <Button title="Open Library" onPress={() => openLibrary(windowId, "easels")} /> : null}
      </View>
    );

  const selected = doc.items.find((i) => state.selection.length === 1 && i.id === state.selection[0]);
  const change = (next: EaselState) => {
    easelCanvasStates.set(tabId, next);
    setState(next);
    if (next.tool && next.tool !== tool) setTool(next.tool);
    if (next.document && next.document !== state.document) applyEaselDocument(doc.id, next.document);
  };
  const fail = (message: string) => showToast(windowId, "Couldn't Export Easel", message, { icon: "scribble.variable" });
  const finishExport = () => setBusy(false);
  const failedExport = (error: unknown) => {
    setBusy(false);
    fail(String(error));
  };
  const exportPNG = (share = false) => {
    setBusy(true);
    return writeEaselPNG(canvas.current, doc, windowId, share).then(finishExport, failedExport);
  };
  const exportHTML = () => {
    setBusy(true);
    return writeEaselHTML(doc, windowId).then(finishExport, failedExport);
  };
  const addLink = async () => {
    const url = await prompt({ title: "Add Link", message: "Paste the address of a webpage.", placeholder: "https://", confirmTitle: "Add", windowId });
    if (!url) return;
    if (!webLink(url)) return showToast(windowId, "Enter a Web Address", "Links must start with https:// or http://.");
    await canvas.current?.addLink(url, url);
  };
  const more = async () => {
    const choice = await showMenu([
      { id: "rename", title: "Rename Easel…" },
      {
        id: "background",
        title: "Canvas Color",
        children: [
          { id: "bg:#FFFFFF", title: "White", checked: doc.background === "#FFFFFF" },
          { id: "bg:#F2F0EB", title: "Paper", checked: doc.background === "#F2F0EB" },
          { id: "bg:#EAF1F7", title: "Blue", checked: doc.background === "#EAF1F7" },
          { id: "bg:#252628", title: "Charcoal", checked: doc.background === "#252628" },
        ],
      },
      { separator: true },
      { id: "selectAll", title: "Select All" },
      { id: "duplicate", title: "Duplicate Selection", enabled: !!state.selection.length },
      { id: "front", title: "Bring to Front", enabled: !!state.selection.length },
      { id: "back", title: "Send to Back", enabled: !!state.selection.length },
      { id: "deleteSelection", title: "Delete Selection", enabled: !!state.selection.length },
      { separator: true },
      { id: "html", title: "Export as HTML…" },
      { id: "share", title: "Share PNG…" },
      { separator: true },
      { id: "delete", title: "Delete Easel…" },
    ]);
    if (choice === "rename") void renameEasel(doc.id);
    if (choice?.startsWith("bg:")) updateEasel(doc.id, { background: choice.slice(3) });
    if (choice === "selectAll") void canvas.current?.selectAll();
    if (choice === "duplicate") void canvas.current?.duplicateSelection();
    if (choice === "front") void canvas.current?.bringToFront();
    if (choice === "back") void canvas.current?.sendToBack();
    if (choice === "deleteSelection") void canvas.current?.deleteSelection();
    if (choice === "html") void exportHTML();
    if (choice === "share") void exportPNG(true);
    if (choice === "delete") void removeEasel(doc.id);
  };
  const toggleLive = () => {
    if (!selected?.source) return;
    const live = !selected.live;
    updateEasel(doc.id, { items: doc.items.map((i) => (i.id === selected.id ? { ...i, live } : i)) });
    setActiveLive(live ? selected.id : null);
  };
  const liveItems = doc.items.filter((i) => i.live && i.source?.clip && webLink(i.source.url));

  return (
    <View style={{ flex: 1, backgroundColor: theme.panel }}>
      <View
        style={{
          minHeight: 58,
          paddingHorizontal: 16,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: theme.panelBorder,
        }}
      >
        <IconButton icon="books.vertical" size={17} box={30} radius={8} tooltip="Library" onPress={() => openLibrary(windowId, "easels")} />
        <TextInput
          value={doc.title}
          onChangeText={(title) => updateEasel(doc.id, { title })}
          onBlur={() => {
            if (!doc.title.trim()) updateEasel(doc.id, { title: "Untitled Easel" });
          }}
          placeholder="Untitled Easel"
          selectTextOnFocus
          style={{ flex: 1, minWidth: 60, fontSize: 19, fontWeight: "600", color: theme.textPrimary, padding: 4 }}
        />
        <Text style={{ fontSize: 11, color: theme.textTertiary }}>Saved on this Mac</Text>
        {isEaselWebSharingEnabled() ? <EaselShareButton doc={doc} canvas={canvas} windowId={windowId} /> : null}
        <Button title={busy ? "Exporting…" : "Export PNG"} disabled={busy} onPress={() => void exportPNG()} />
        <IconButton icon="ellipsis" size={16} box={30} radius={8} tooltip="Easel actions" onPress={() => void more()} />
      </View>
      <View
        style={{
          minHeight: 46,
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          paddingHorizontal: 12,
          gap: 3,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: theme.panelBorder,
        }}
      >
        {TOOLS.map((t) => (
          <IconButton
            key={t.tool}
            icon={t.icon}
            size={15}
            box={30}
            radius={7}
            style={{ backgroundColor: tool === t.tool ? theme.toolbarHover : undefined }}
            tooltip={t.title}
            onPress={() => {
              setTool(t.tool);
              setActiveLive(null);
              void canvas.current?.focus();
            }}
          />
        ))}
        <View style={{ width: 1, height: 20, marginHorizontal: 6, backgroundColor: theme.panelBorder }} />
        <IconButton
          icon="photo"
          size={15}
          box={30}
          radius={7}
          tooltip="Add Images"
          onPress={() => void pickFiles().then((paths) => canvas.current?.addImages(paths))}
        />
        <IconButton icon="link" size={15} box={30} radius={7} tooltip="Add Link" onPress={() => void addLink()} />
        <View style={{ width: 1, height: 20, marginHorizontal: 6, backgroundColor: theme.panelBorder }} />
        {COLORS.map((c) => (
          <Pressable
            key={c}
            accessibilityRole="button"
            accessibilityLabel={`Use ${c}`}
            tooltip={c}
            onPress={() => setColor(c)}
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              padding: 3,
              borderWidth: color === c ? 1.5 : 0.5,
              borderColor: color === c ? theme.accent : theme.panelBorder,
            }}
          >
            <View style={{ flex: 1, borderRadius: 8, backgroundColor: c }} />
          </Pressable>
        ))}
        <IconButton
          icon={width === 3 ? "line.3.horizontal" : "line.3.horizontal.decrease"}
          size={14}
          box={30}
          radius={7}
          tooltip={`Line Width: ${width}`}
          onPress={() => setWidth(width === 3 ? 6 : width === 6 ? 10 : 3)}
        />
        <View style={{ flex: 1 }} />
        <IconButton
          icon="arrow.uturn.backward"
          size={14}
          box={30}
          radius={7}
          tooltip="Undo (⌘Z)"
          disabled={!state.canUndo}
          onPress={() => void canvas.current?.undo()}
        />
        <IconButton
          icon="arrow.uturn.forward"
          size={14}
          box={30}
          radius={7}
          tooltip="Redo (⇧⌘Z)"
          disabled={!state.canRedo}
          onPress={() => void canvas.current?.redo()}
        />
      </View>
      <View style={{ flex: 1, overflow: "hidden" }} onLayout={(e) => setSize(e.nativeEvent.layout)}>
        <EaselCanvas
          ref={canvas}
          document={JSON.stringify(doc)}
          tool={tool}
          color={color}
          lineWidth={width}
          dark={theme.dark}
          onChange={change}
          onOpenLink={(url) => {
            if (webLink(url)) reportBrowserCommand(newTab(windowId, { url }));
          }}
          style={StyleSheet.absoluteFill}
        />
        {liveItems.map((item) => (
          <LiveClip
            key={item.id}
            item={item}
            viewport={state.viewport}
            pane={size}
            active={activeLive === item.id}
            onActivate={() => setActiveLive(item.id)}
            onPause={() => {
              setActiveLive(null);
              updateEasel(doc.id, { items: doc.items.map((i) => (i.id === item.id ? { ...i, live: false } : i)) });
            }}
            windowId={windowId}
          />
        ))}
        {!doc.items.length ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", gap: 10, paddingBottom: 80 }]}>
            <Symbol name="scribble.variable" size={40} color={theme.textTertiary} style={{ width: 48, height: 48 }} />
            <Text style={{ fontSize: 21, fontWeight: "600", color: theme.textSecondary }}>A place for your ideas</Text>
            <Text style={{ fontSize: 13, color: theme.textTertiary }}>Drop images or links, add text, or draw. Capture any page to add it here.</Text>
          </View>
        ) : null}
        <View
          style={{
            position: "absolute",
            bottom: 14,
            left: 14,
            flexDirection: "row",
            alignItems: "center",
            padding: 3,
            gap: 3,
            borderRadius: 10,
            backgroundColor: theme.panel,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.panelBorder,
          }}
        >
          <IconButton icon="minus" size={12} box={28} radius={6} tooltip="Zoom Out" onPress={() => void canvas.current?.zoomOut()} />
          <Text style={{ fontSize: 11, color: theme.textSecondary, minWidth: 36, textAlign: "center" }}>{Math.round(state.zoom * 100)}%</Text>
          <IconButton icon="plus" size={12} box={28} radius={6} tooltip="Zoom In" onPress={() => void canvas.current?.zoomIn()} />
          <IconButton icon="arrow.up.left.and.arrow.down.right" size={12} box={28} radius={6} tooltip="Fit Canvas" onPress={() => void canvas.current?.fit()} />
        </View>
        {selected?.source ? (
          <View
            style={{
              position: "absolute",
              bottom: 14,
              right: 14,
              flexDirection: "row",
              gap: 6,
              padding: 5,
              borderRadius: 10,
              backgroundColor: theme.panel,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.panelBorder,
            }}
          >
            <Button title="Open Source" onPress={() => reportBrowserCommand(newTab(windowId, { url: selected.source!.url }))} />
            {selected.source.clip ? <Button title={selected.live ? "Pause Live Clip" : "Make Live"} onPress={toggleLive} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A real Chromium page in the source profile, cropped to the captured document rectangle. */
function LiveClip({
  item,
  viewport,
  pane,
  active,
  onActivate,
  onPause,
  windowId,
}: {
  item: EaselItem;
  viewport: { x: number; y: number; zoom: number };
  pane: { width: number; height: number };
  active: boolean;
  onActivate: () => void;
  onPause: () => void;
  windowId: string;
}) {
  const theme = useTheme();
  const web = useRef<WebViewHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const source = item.source!;
  const [scrollY, setScrollY] = useState(source.clip![1] ?? 0);
  const [cx, cy, cw, ch] = source.clip!;
  const z = viewport.zoom;
  const left = (item.x - viewport.x) * z;
  const top = (item.y - viewport.y) * z;
  const width = item.width * z;
  const height = item.height * z;
  const sourceProfile = useBrowser((s) => {
    const fallback = engineProfile(s.windows[windowId]?.spaceId ?? "default");
    return source.profileId !== undefined ? (Object.values(s.spaces).some((p) => engineIdOf(p) === source.profileId) ? source.profileId : null) : fallback;
  });
  if (sourceProfile === null || left > pane.width || top > pane.height || left + width < 0 || top + height < 0) return null;
  const crop = liveClipTransform(source.clip!, { width, height }, scrollY);
  const viewportWidth = Math.max(source.viewportWidth ?? cw!, cx! + cw!);
  const viewportHeight = Math.max(source.viewportHeight ?? ch!, ch!);
  const position = () =>
    void web.current?.evaluate<number>(`window.scrollTo(0, ${Math.max(0, cy!)}); window.scrollY`).then((y) => {
      if (typeof y === "number") setScrollY(y);
    });
  return (
    <View style={{ position: "absolute", left, top, width, height, overflow: "hidden", borderRadius: 3 }}>
      <View
        style={{
          width: viewportWidth,
          height: viewportHeight,
          position: "absolute",
          left: crop.left,
          top: crop.top,
          transform: [{ scaleX: crop.scaleX }, { scaleY: crop.scaleY }],
          transformOrigin: "top left",
        }}
      >
        <WebView
          ref={web}
          url={source.url}
          profile={sourceProfile}
          standalone
          visible
          onReady={position}
          onNavigationChange={(n) => {
            if (!n.isLoading) position();
          }}
          onLoadError={(e) => setError(e.text)}
          onCrashed={() => setError("The page stopped responding.")}
          onOpenWindow={(r) => {
            if (webLink(r.url)) reportBrowserCommand(newTab(windowId, { url: r.url }));
          }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      {!active ? <Pressable onPress={onActivate} accessibilityLabel="Interact with live clip" style={StyleSheet.absoluteFill} /> : null}
      <View style={{ position: "absolute", top: 4, right: 4, flexDirection: "row", borderRadius: 8, backgroundColor: theme.panel }}>
        <IconButton
          icon="arrow.clockwise"
          size={11}
          box={24}
          radius={6}
          tooltip="Refresh Live Clip"
          onPress={() => {
            setError(null);
            void web.current?.reload();
          }}
        />
        <IconButton icon="pause.fill" size={10} box={24} radius={6} tooltip="Pause Live Clip" onPress={onPause} />
      </View>
      {error ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.panel, alignItems: "center", justifyContent: "center", padding: 12, gap: 8 }]}>
          <Text style={{ fontSize: 12, color: theme.textSecondary }}>{error}</Text>
          <Button
            title="Retry"
            onPress={() => {
              setError(null);
              void web.current?.reload();
            }}
          />
          <Button title="Use Saved Capture" onPress={onPause} />
        </View>
      ) : null}
    </View>
  );
}
